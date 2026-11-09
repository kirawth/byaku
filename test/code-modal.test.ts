import { afterEach, describe, expect, it, vi } from 'vitest';

import { Byaku } from '../src/byaku.js';
import { defineMode } from '../src/modes/index.js';
import { CHANNEL_ID, FakeBot, OWNER_ID } from './helpers.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const installed: Byaku[] = [];
async function setup(options: ConstructorParameters<typeof Byaku>[1] = {}) {
  const bot = await FakeBot.create();
  const byaku = new Byaku(bot.client, { owners: [OWNER_ID], ...options });
  await byaku.install();
  installed.push(byaku);
  return { bot, byaku };
}

const upload = (filename = 'code.js', size = 42) => ({
  id: '900000000000000009',
  filename,
  size,
  url: 'https://uploads.invalid/code.js',
  proxy_url: 'https://uploads.invalid/code.js',
});

const resultEdits = (bot: FakeBot) => bot.calls.filter((c) => c.method === 'PATCH');

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(installed.splice(0).map((byaku) => byaku.uninstall()));
});

describe.each([
  ['e', true],
  ['p', false],
] as const)('code modal visibility %s', (visibility, ephemeral) => {
  it('defers before evaluation, edits the result and reruns into the same reply', async () => {
    const entered = gate();
    const finish = gate();
    let value = 41;
    const { bot, byaku } = await setup({
      scope: {
        pause: () => {
          entered.release();
          return finish.promise;
        },
        next: () => ++value,
      },
    });
    const submission = bot.submitModal(`by1:new:M:code:js:${visibility}`, { code: 'await pause(); return next()' });
    try {
      await entered.promise;
      expect(bot.callbacks()).toEqual([{ type: 5, data: { flags: ephemeral ? 64 : undefined } }]);
      expect(resultEdits(bot)).toHaveLength(0);
    } finally {
      finish.release();
      await submission;
    }

    const token = await submission;
    const reply = bot.lastMessage()!;
    expect(reply.ephemeral).toBe(ephemeral);
    expect(reply.content).toContain('```js\n42\n```');
    expect(resultEdits(bot)[0]?.url).toContain(`/${token}/messages/@original`);
    expect(resultEdits(bot)[0]?.body).not.toHaveProperty('flags');
    const session = (await byaku.sessions.store.list())[0]!;
    expect(session.interactionToken).toBe(token);
    expect(session.data.tokenAt).toEqual(expect.any(Number));
    expect(session.replyId).toBe(ephemeral ? undefined : reply.id);

    const rerun = await bot.click(reply, { emoji: '🔁' });
    expect(bot.callbacks(rerun)).toEqual([{ type: 6, data: {} }]);
    expect(bot.messages.size).toBe(1);
    expect(bot.messages.get(reply.id)?.content).toContain('```js\n43\n```');
    expect(session.interactionToken).toBe(rerun);
    expect(resultEdits(bot).at(-1)?.url).toBe(
      ephemeral
        ? `/webhooks/${bot.client.applicationId}/${rerun}/messages/@original`
        : `/channels/${CHANNEL_ID}/messages/${reply.id}`,
    );
  });

  it('defers before the upload request and body read, then evaluates the uploaded code', async () => {
    const requested = gate();
    const downloaded = gate();
    const reading = gate();
    const read = gate();
    const evaluated = vi.fn(() => 42);
    const { bot } = await setup({ scope: { evaluated } });
    const text = vi.fn(async () => {
      reading.release();
      await read.promise;
      return 'evaluated()';
    });
    const fetchFile = vi.fn(async () => {
      requested.release();
      await downloaded.promise;
      return { text };
    });
    vi.stubGlobal('fetch', fetchFile);

    const submission = bot.submitModal(`by1:new:M:code:js:${visibility}`, {}, { files: [upload()] });
    try {
      await requested.promise;
      expect(bot.callbacks()).toEqual([{ type: 5, data: { flags: ephemeral ? 64 : undefined } }]);
      expect(fetchFile).toHaveBeenCalledWith(upload().url, { signal: expect.any(AbortSignal) });
      expect(evaluated).not.toHaveBeenCalled();
      expect(text).not.toHaveBeenCalled();
      downloaded.release();
      await reading.promise;
      expect(resultEdits(bot)).toHaveLength(0);
      expect(evaluated).not.toHaveBeenCalled();
    } finally {
      downloaded.release();
      read.release();
      await submission;
    }
    expect(evaluated).toHaveBeenCalledOnce();
    expect(bot.lastMessage()?.content).toContain('```js\n42\n```');
    expect(bot.lastMessage()?.ephemeral).toBe(ephemeral);
    expect(bot.callbacks()).toHaveLength(1);
  });

  it('updates the deferred reply for live output and completion', async () => {
    const streaming = gate();
    const finish = gate();
    const { bot, byaku } = await setup({
      modes: [
        defineMode({
          name: 'stream',
          description: 'Controlled live output',
          async run(ctx) {
            let output = 'stream-start';
            const live = await ctx.live({ kind: 'shell', render: () => output });
            output = 'stream-update';
            live.update();
            streaming.release();
            await finish.promise;
            return 'stream-finished';
          },
        }),
      ],
    });
    const submission = bot.submitModal(`by1:new:M:code:stream:${visibility}`, { code: 'start' });
    let replyId: string;
    try {
      await streaming.promise;
      expect(bot.callbacks()).toEqual([{ type: 5, data: { flags: ephemeral ? 64 : undefined } }]);
      expect(resultEdits(bot)[0]?.body.content).toContain('stream-start');
      expect(bot.lastMessage()?.ephemeral).toBe(ephemeral);
      replyId = bot.lastMessage()!.id;
    } finally {
      finish.release();
      await submission;
    }
    expect(bot.messages.size).toBe(1);
    expect(bot.messages.get(replyId)?.content).toContain('stream-finished');
    expect(resultEdits(bot).some((c) => c.body.content.includes('stream-update'))).toBe(true);
    expect(byaku.lives.size).toBe(0);
    expect((await byaku.sessions.store.list())[0]?.live).toBeUndefined();
    expect(bot.callbacks()).toHaveLength(1);
  });

  it('renders evaluation errors by editing the deferred reply', async () => {
    const { bot } = await setup();
    const token = await bot.submitModal(`by1:new:M:code:js:${visibility}`, {
      code: 'throw new Error("modal-eval-failed")',
    });
    expect(bot.callbacks(token)).toEqual([{ type: 5, data: { flags: ephemeral ? 64 : undefined } }]);
    expect(bot.lastMessage()?.content).toContain('modal-eval-failed');
    expect(bot.lastMessage()?.ephemeral).toBe(ephemeral);
    expect(resultEdits(bot)).toHaveLength(1);
  });

  it.each(['empty', 'network', 'body-read', 'timeout'] as const)(
    'finishes the deferred reply after an %s upload',
    async (failure) => {
      const { bot, byaku } = await setup();
      const fetchFile = vi.fn();
      if (failure === 'empty') fetchFile.mockResolvedValue({ text: async () => '' });
      else if (failure === 'body-read')
        fetchFile.mockResolvedValue({ text: vi.fn().mockRejectedValue(new Error(failure)) });
      else
        fetchFile.mockRejectedValue(new DOMException(failure, failure === 'timeout' ? 'TimeoutError' : 'NetworkError'));
      vi.stubGlobal('fetch', fetchFile);
      const token = await bot.submitModal(`by1:new:M:code:js:${visibility}`, {}, { files: [upload()] });
      expect(bot.callbacks(token)).toEqual([{ type: 5, data: { flags: ephemeral ? 64 : undefined } }]);
      expect(bot.lastMessage()?.content).toBe(
        failure === 'empty' ? 'Type some code or upload a file.' : 'Could not read the uploaded file.',
      );
      expect(bot.lastMessage()?.ephemeral).toBe(ephemeral);
      expect(resultEdits(bot)).toHaveLength(1);
      expect(resultEdits(bot)[0]?.body.allowed_mentions).toEqual({ parse: [] });
      expect(await byaku.sessions.store.list()).toHaveLength(0);
    },
  );
});

describe('code modal validation', () => {
  it.each([
    ['missing code', undefined, 'Type some code or upload a file.'],
    ['invalid extension', upload('code.exe'), 'Upload a .js or .ts file.'],
    ['oversized file', upload('code.js', 1_048_577), 'The file is larger than 1 MB.'],
  ] as const)('rejects %s privately before deferring or fetching', async (_, file, content) => {
    const { bot, byaku } = await setup();
    const fetchFile = vi.fn();
    vi.stubGlobal('fetch', fetchFile);
    const token = await bot.submitModal('by1:new:M:code:js:p', { code: '  ' }, { files: file ? [file] : [] });
    expect(bot.callbacks(token)).toEqual([{ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } }]);
    expect(fetchFile).not.toHaveBeenCalled();
    expect(resultEdits(bot)).toHaveLength(0);
    expect(await byaku.sessions.store.list()).toHaveLength(0);
  });

  it('keeps typed code ahead of an uploaded file', async () => {
    const { bot } = await setup();
    const fetchFile = vi.fn();
    vi.stubGlobal('fetch', fetchFile);
    const token = await bot.submitModal('by1:new:M:code:js:e', { code: '42' }, { files: [upload('code.exe')] });
    expect(bot.callbacks(token)).toMatchObject([{ type: 5, data: { flags: 64 } }]);
    expect(fetchFile).not.toHaveBeenCalled();
    expect(bot.lastMessage()?.content).toContain('```js\n42\n```');
  });
});
