import { WorkerClient } from 'seyfert';
import { describe, expect, it, vi } from 'vitest';

import { Byaku } from '../src/byaku.js';
import { CHANNEL_ID, FakeBot, OWNER_ID } from './helpers.js';

interface Request {
  workerIds?: readonly number[];
  readyTimeout?: number;
  drainTimeout?: number;
  continueOnError?: boolean;
  onProgress?(event: { workerId: number; stage: string; error?: string }): void;
}

type Workers = { workerId: number; ok: boolean; error?: string; ms: number }[];

async function setup(worker?: { id: number; total: number; reload?: (request: Request) => Promise<Workers> }) {
  const bot = await FakeBot.create();
  if (worker) {
    Object.assign(bot.client, {
      workerData: { workerId: worker.id, totalWorkers: worker.total, shards: [0], totalShards: 1 },
      tellWorker: () => Promise.resolve(undefined),
      ...(worker.reload
        ? { requestHotReload: async (request: Request) => ({ workers: await worker.reload!(request) }) }
        : {}),
    });
  }
  const byaku = new Byaku(bot.client, { advanced: { includeAppOwners: false } });
  await byaku.install();
  return { bot, byaku };
}

async function reload(bot: FakeBot, byaku: Byaku, text: string): Promise<string> {
  await byaku.run({ ownerId: OWNER_ID, channelId: CHANNEL_ID, text, delivery: { kind: 'reply' } });
  return [...bot.messages.values()].at(-1)?.content ?? '';
}

describe('reload', () => {
  it('hot reloads every worker with this one last and reports each stage', async () => {
    const requests: Request[] = [];
    const { bot, byaku } = await setup({
      id: 0,
      total: 3,
      reload: async (request) => {
        requests.push(request);
        for (const workerId of request.workerIds ?? []) {
          for (const stage of ['spawning', 'connecting', 'ready', 'switching', 'draining', 'done']) {
            request.onProgress?.({ workerId, stage });
          }
        }
        return (request.workerIds ?? []).map((workerId) => ({ workerId, ok: true, ms: 1500 }));
      },
    });

    const content = await reload(bot, byaku, 'reload --timeout=2m --drain=30s --continue');
    expect(requests[0]).toMatchObject({
      workerIds: [1, 2, 0],
      readyTimeout: 120_000,
      drainTimeout: 30_000,
      continueOnError: true,
    });
    expect(content).toContain('Hot reload · 3 workers');
    expect(content).toMatch(/✅ worker 1 {2}done/);
    expect(content).toMatch(/✅ worker 0 {2}done .*\(this worker\)/);
    expect(content).toContain('This worker was replaced');
    expect(content).toContain('3/3 reloaded');
  });

  it('reloads only the workers asked for and keeps a failed one on the old code', async () => {
    const reloadFn = vi.fn(async (request: Request) => {
      request.onProgress?.({ workerId: 2, stage: 'failed', error: 'SyntaxError: Unexpected token' });
      return [{ workerId: 2, ok: false, error: 'SyntaxError: Unexpected token', ms: 900 }];
    });
    const { bot, byaku } = await setup({ id: 0, total: 3, reload: reloadFn });

    const content = await reload(bot, byaku, 'reload 2 1');
    expect(reloadFn.mock.calls[0]?.[0].workerIds).toEqual([2, 1]);
    expect(content).toMatch(/❌ worker 2 {2}failed/);
    expect(content).toContain('SyntaxError: Unexpected token');
    expect(content).toContain('1 failed and kept running the old code.');
    expect(content).toContain('1 not attempted after a failure');
    expect(content).toContain('❌');
  });

  it('rejects worker ids that do not exist and durations without a value', async () => {
    const reloadFn = vi.fn(async () => []);
    const { bot, byaku } = await setup({ id: 0, total: 2, reload: reloadFn });
    expect(await reload(bot, byaku, 'reload 5')).toContain('"5" is not a worker id (0 to 1)');
    expect(await reload(bot, byaku, 'reload --drain 1')).toContain('--drain needs a value');
    expect(reloadFn).not.toHaveBeenCalled();
  });

  it('without the WorkerManager it reloads Seyfert’s file handlers and says what it could not reload', async () => {
    const { bot, byaku } = await setup();
    const commands = vi.spyOn(bot.client.commands, 'reloadAll').mockResolvedValue();
    const events = vi.spyOn(bot.client.events!, 'reloadAll').mockRejectedValue(new Error('bad event file'));

    const content = await reload(bot, byaku, 'reload');
    expect(commands).toHaveBeenCalledWith(false);
    expect(events).toHaveBeenCalled();
    expect(content).toContain('✅ commands');
    expect(content).toContain('❌ events: bad event file');
    expect(content).toContain('needs the bot to run on Seyfert’s WorkerManager');
  });

  it('on a worker without hot reload support, or with "files", only the file handlers reload', async () => {
    const old = await setup({ id: 0, total: 2 });
    expect(await reload(old.bot, old.byaku, 'reload')).toContain(
      'needs a Seyfert version with WorkerManager.hotReload',
    );

    const reloadFn = vi.fn(async () => []);
    const { bot, byaku } = await setup({ id: 0, total: 2, reload: reloadFn });
    const content = await reload(bot, byaku, 'reload files');
    expect(content).toContain('Reloaded the files Seyfert loads');
    expect(reloadFn).not.toHaveBeenCalled();
  });
});

// Seyfert 5.2.1 and older have no hot reload; the seyfert@latest CI job runs without it
describe.skipIf(!('requestHotReload' in WorkerClient.prototype))('reload through a real Seyfert WorkerClient', () => {
  it('sends HOT_RELOAD_REQUEST and renders the progress and result the manager sends back', async () => {
    const bot = await FakeBot.create();
    const posted: { type: string; nonce?: string; options?: Request }[] = [];
    const worker = new WorkerClient({ postMessage: (body: unknown) => void posted.push(body as never) } as never);
    worker.setWorkerData({
      workerId: 1,
      totalWorkers: 2,
      shards: [1],
      totalShards: 2,
      mode: 'threads',
      hotReload: false,
    } as never);
    worker.setServices({ rest: bot.client.rest });
    const byaku = new Byaku(worker, { owners: [OWNER_ID], advanced: { includeAppOwners: false } });

    const run = byaku.run({ ownerId: OWNER_ID, channelId: CHANNEL_ID, text: 'reload', delivery: { kind: 'reply' } });
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'HOT_RELOAD_REQUEST')).toBe(true));
    const request = posted.find((m) => m.type === 'HOT_RELOAD_REQUEST')!;
    expect(request.options?.workerIds).toEqual([0, 1]);

    // What the WorkerManager sends back
    const send = (message: object) => worker.handleManagerMessages(message as never);
    await send({ type: 'HOT_RELOAD_PROGRESS', nonce: request.nonce, progress: { workerId: 0, stage: 'connecting' } });
    await send({ type: 'HOT_RELOAD_PROGRESS', nonce: request.nonce, progress: { workerId: 0, stage: 'done' } });
    await send({
      type: 'HOT_RELOAD_RESULT',
      nonce: request.nonce,
      result: {
        workers: [
          { workerId: 0, ok: true, ms: 4200 },
          { workerId: 1, ok: true, ms: 3900 },
        ],
      },
    });
    await run;

    const content = [...bot.messages.values()].at(-1)?.content ?? '';
    expect(content).toMatch(/✅ worker 0 {2}done/);
    expect(content).toMatch(/✅ worker 1 {2}done .*\(this worker\)/);
    expect(content).toContain('2/2 reloaded');
  });
});
