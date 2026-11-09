import { inspect } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { Byaku } from '../src/byaku.js';
import { defineMode } from '../src/modes/index.js';
import { secretVariants } from '../src/output.js';
import { BOT_ID, CHANNEL_ID, FakeBot, type FakeMessage, OWNER_ID } from './helpers.js';

const fixtureSecret = 'fixture-secret-for-output-12345';

async function setup(options: ConstructorParameters<typeof Byaku>[1] = {}) {
  const bot = await FakeBot.create();
  const byaku = new Byaku(bot.client, {
    owners: [OWNER_ID],
    secrets: [fixtureSecret],
    scope: { fixtureSecret },
    ...options,
  });
  await byaku.install();
  return { bot, byaku };
}

async function run(byaku: Byaku, bot: FakeBot, text: string): Promise<FakeMessage> {
  await byaku.run({ ownerId: OWNER_ID, channelId: CHANNEL_ID, text, delivery: { kind: 'reply' } });
  return bot.lastMessage()!;
}

function expectProtected(bot: FakeBot, secrets = [fixtureSecret]) {
  for (const call of bot.calls) {
    const payload = JSON.stringify({ body: call.body, files: call.files });
    for (const secret of secrets) for (const variant of secretVariants(secret)) expect(payload).not.toContain(variant);
  }
}

const current = (bot: FakeBot, message: FakeMessage) => bot.messages.get(message.id)!;

describe('rendered secret redaction', () => {
  it('redacts the entire real outgoing object reply, including explorer previews and builder serialization', async () => {
    const { bot, byaku } = await setup();
    try {
      const reply = await run(byaku, bot, 'js ({ password: fixtureSecret })');
      expect(reply.content).toContain('[redacted]');
      const select = bot.findSelect(reply, /:xk$/)!;
      expect(select.options[0]).toMatchObject({ label: 'password', value: 'k0' });
      expect(select.options[0].description).toContain('[redacted]');
      const session = (await byaku.sessions.store.list())[0]!;
      const rendered = byaku.render(session);
      expect(JSON.stringify(rendered)).not.toContain(fixtureSecret);
      for (const row of rendered.components) expect(JSON.stringify(row.toJSON())).not.toContain(fixtureSecret);
      expectProtected(bot);
    } finally {
      await byaku.uninstall();
    }
  });

  it('keeps raw property navigation and rerun input while redacting labels, breadcrumbs, placeholders and edit forms', async () => {
    const { bot, byaku } = await setup();
    try {
      const input = `js ({ [${JSON.stringify(fixtureSecret)}]: { child: 42 } })`;
      const reply = await run(byaku, bot, input);
      expect(bot.findSelect(reply, /:xk$/)!.options[0]).toMatchObject({ label: '[redacted]', value: 'k0' });
      await bot.select(current(bot, reply), /:xk$/, ['k0']);
      const session = (await byaku.sessions.store.list())[0]!;
      expect(session.view.path).toEqual([{ kind: 'prop', key: fixtureSecret }]);
      expect(current(bot, reply).content).toContain('result › [redacted]');
      expect(bot.findSelect(current(bot, reply), /:xk$/)!.placeholder).toContain('result › [redacted]');
      await bot.select(current(bot, reply), /:xk$/, ['k0']);
      expect(current(bot, reply).content).toContain('42');
      const token = await bot.click(current(bot, reply), { emoji: '✏️' });
      const modal = bot.callbacks(token)[0].data;
      expect(modal.components[0].component.value).toBeUndefined();
      expect(modal.components[0].description).toContain('Enter new code');
      expect(session.input).toContain(fixtureSecret);
      expect(session.data.raw).toBe(input);
      await bot.click(current(bot, reply), { emoji: '🔁' });
      expect(current(bot, reply).content).toContain('child: 42');
      expect(bot.findSelect(current(bot, reply), /:xk$/)!.options[0].label).toBe('[redacted]');
      expectProtected(bot);
    } finally {
      await byaku.uninstall();
    }
  });

  it.each(['map', 'set', 'symbol'] as const)('redacts %s entries and still opens them', async (kind) => {
    const { bot, byaku } = await setup();
    try {
      const input = {
        map: 'js new Map([[fixtureSecret, { child: fixtureSecret }]])',
        set: 'js new Set([fixtureSecret])',
        symbol: 'js ({ [Symbol(fixtureSecret)]: { child: fixtureSecret } })',
      }[kind];
      const reply = await run(byaku, bot, input);
      if (kind === 'symbol') await bot.select(current(bot, reply), /:dp$/, ['h']);
      await bot.select(current(bot, reply), /:xk$/, ['k0']);
      expect(current(bot, reply).content).toContain('[redacted]');
      if (kind !== 'set') {
        expect(bot.findSelect(current(bot, reply), /:xk$/)!.options[0].label).toBe('child');
        const session = (await byaku.sessions.store.list())[0]!;
        expect(session.view.path[0]).toEqual({
          kind,
          index: 0,
          label: kind === 'map' ? fixtureSecret : `Symbol(${fixtureSecret})`,
        });
      }
      expectProtected(bot);
    } finally {
      await byaku.uninstall();
    }
  });

  it('redacts before preview, key, breadcrumb and confirmation truncation', async () => {
    const { bot, byaku } = await setup();
    try {
      const reply = await run(byaku, bot, `js ({ ['x'.repeat(85) + fixtureSecret]: 'x'.repeat(55) + fixtureSecret })`);
      const option = bot.findSelect(reply, /:xk$/)!.options[0];
      expect(option.label).not.toContain(fixtureSecret.slice(0, 8));
      expect(option.description).not.toContain(fixtureSecret.slice(0, 8));
      await bot.select(reply, /:xk$/, ['k0']);
      expect(current(bot, reply).content).not.toContain(fixtureSecret.slice(0, 8));
      const confirmation = await run(byaku, bot, `sh rm -rf ${'x'.repeat(1475)}${fixtureSecret}`);
      expect(confirmation.content).not.toContain(fixtureSecret.slice(0, 8));
      expectProtected(bot);
    } finally {
      await byaku.uninstall();
    }
  });

  it('redacts throwing inspection previews before their fallback labels are cut', async () => {
    const key = {
      [inspect.custom]() {
        throw new Error('x'.repeat(50) + fixtureSecret);
      },
    };
    const { bot, byaku } = await setup({ scope: { value: new Map([[key, 42]]) } });
    try {
      const reply = await run(byaku, bot, 'js value');
      const label = bot.findSelect(reply, /:xk$/)!.options[0].label;
      expect(label).not.toContain(fixtureSecret.slice(0, 8));
      await bot.select(reply, /:xk$/, ['k0']);
      expect(current(bot, reply).content).toContain('42');
      expectProtected(bot);
    } finally {
      await byaku.uninstall();
    }
  });

  it('redacts live status and language metadata on actual message updates', async () => {
    const { bot, byaku } = await setup({
      modes: [
        defineMode({
          name: 'livefixture',
          description: 'Fake live metadata',
          run: () => ({ output: 'body', status: [fixtureSecret], lang: fixtureSecret }),
        }),
      ],
    });
    try {
      const reply = await run(byaku, bot, 'livefixture');
      const session = (await byaku.sessions.store.list())[0]!;
      session.live = { kind: 'watch', paused: false, startedAt: Date.now() };
      await bot.click(reply, { emoji: '📌' });
      expect(current(bot, reply).content).toContain('⏳');
      expect(current(bot, reply).content).toContain('[redacted]');
      expectProtected(bot);
    } finally {
      await byaku.uninstall();
    }
  });

  it('redacts configured encoded variants in menus and getter denials without invoking the getter', async () => {
    const getter = vi.fn(() => 42);
    const value = Object.defineProperty({ variants: secretVariants(fixtureSecret) }, fixtureSecret, {
      get: getter,
      enumerable: true,
    });
    const { bot, byaku } = await setup({ scope: { value } });
    try {
      const reply = await run(byaku, bot, 'js value');
      const token = await bot.select(reply, /:xk$/, ['k1']);
      expect(bot.callbacks(token)[0].data.content).toContain('"[redacted]" is a getter');
      expect(getter).not.toHaveBeenCalled();
      await bot.select(current(bot, reply), /:xk$/, ['k0']);
      for (const option of bot.findSelect(current(bot, reply), /:xk$/)!.options)
        expect(option.description).toContain('[redacted]');
      expectProtected(bot);
    } finally {
      await byaku.uninstall();
    }
  });

  it('redacts confirmation input and reasons, then executes the original input only on confirmation', async () => {
    const execute = vi.fn(({ input }: { input: string }) => ({
      output: input,
      status: [fixtureSecret],
      lang: fixtureSecret,
    }));
    const { bot, byaku } = await setup({
      modes: [defineMode({ name: 'safe', description: 'Fake mode', run: execute })],
      advanced: { confirm: [{ modes: ['safe'], pattern: /check/, reason: `contains ${fixtureSecret}` }] },
    });
    try {
      const shell = byaku.registry.get('sh')!;
      const shellRun = vi.spyOn(shell, 'run');
      const shellReply = await run(byaku, bot, `sh rm -rf /tmp/${fixtureSecret}`);
      expect(shellRun).not.toHaveBeenCalled();
      await bot.click(shellReply, { label: 'Cancel' });
      shellRun.mockRestore();
      const input = `check ${fixtureSecret}`;
      const reply = await run(byaku, bot, `safe ${input}`);
      expect(execute).not.toHaveBeenCalled();
      expect(reply.content).toContain('contains [redacted]');
      await bot.click(reply, { label: 'Confirm' });
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]![0].input).toBe(input);
      expect(current(bot, reply).content).toContain('```[redacted]');
      expectProtected(bot);
    } finally {
      await byaku.uninstall();
    }
  });

  it('redacts autocomplete names before truncation, preserves safe mode values and avoids leaking secret mode names', async () => {
    const { bot, byaku } = await setup({
      slash: true,
      modes: [
        defineMode({ name: 'custom', description: 'x'.repeat(80) + fixtureSecret, run: () => 'ok' }),
        defineMode({ name: fixtureSecret, description: 'Private mode', run: () => 'ok' }),
      ],
    });
    try {
      const token = 'redaction-autocomplete';
      await bot.inject('INTERACTION_CREATE', {
        id: '900000000000000001',
        application_id: BOT_ID,
        type: 4,
        token,
        version: 1,
        channel_id: CHANNEL_ID,
        app_permissions: '0',
        user: { id: OWNER_ID, username: 'owner', discriminator: '0' },
        locale: 'en-US',
        entitlements: [],
        authorizing_integration_owners: {},
        context: 1,
        data: {
          id: '900000000000000002',
          name: 'byaku',
          type: 1,
          options: [{ name: 'mode', type: 3, value: '', focused: true }],
        },
      });
      const callback = bot.callbacks(token)[0];
      expect(callback.type).toBe(8);
      const custom = callback.data.choices.find((choice: { value: string }) => choice.value === 'custom');
      expect(custom).toBeDefined();
      expect(custom.name).not.toContain(fixtureSecret.slice(0, 8));
      expect(callback.data.choices.some((choice: { value: string }) => choice.value === fixtureSecret)).toBe(false);
      const opened = await bot.slash('byaku', [{ name: 'mode', type: 3, value: 'custom' }]);
      expect(bot.callbacks(opened)[0]).toMatchObject({
        type: 9,
        data: { title: 'Byaku · custom', custom_id: 'by1:new:M:code:custom:e' },
      });
      const refused = await bot.slash('byaku', [{ name: 'mode', type: 3, value: fixtureSecret }]);
      expect(bot.callbacks(refused)[0]).toMatchObject({
        type: 4,
        data: { flags: 64, content: expect.stringContaining('message trigger') },
      });
      expectProtected(bot);
    } finally {
      await byaku.uninstall();
    }
  });

  it('redacts rendered errors, raw replies, diffs and file contents', async () => {
    const { bot, byaku } = await setup();
    try {
      const reply = await run(byaku, bot, 'js (() => { throw new Error(fixtureSecret) })()');
      expect(reply.content).toContain('Error: [redacted]');
      await bot.click(reply, { emoji: '📋' });
      await bot.click(reply, { emoji: '📄' });
      const session = (await byaku.sessions.store.list())[0]!;
      await byaku.rerun(session, OWNER_ID, 'js fixtureSecret + " changed"', 'edit-run');
      await bot.click(current(bot, reply), { label: 'Diff' });
      const files = bot.calls.flatMap((call) => call.files ?? []) as { data: Buffer }[];
      expect(files).toHaveLength(1);
      for (const file of files) expect(file.data.toString()).not.toContain(fixtureSecret);
      expectProtected(bot);
    } finally {
      await byaku.uninstall();
    }
  });
});
