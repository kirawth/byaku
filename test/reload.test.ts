import { WorkerClient } from 'seyfert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Byaku } from '../src/byaku.js';
import { reloadEnvironment, reloadTimings, updateCommand } from '../src/modes/reload.js';
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

// Byaku checks Seyfert's WorkerClient for hot reload support; the tests switch it on and off
const proto = WorkerClient.prototype as unknown as Record<string, unknown>;
const original = Object.getOwnPropertyDescriptor(proto, 'requestHotReload');
function seyfertSupportsHotReload(on: boolean) {
  if (on) proto.requestHotReload = original?.value ?? (() => Promise.resolve({ workers: [] }));
  else delete proto.requestHotReload;
}
const detectContainer = reloadEnvironment.inContainer;
// The tests run in Docker on Linux too, so each one starts outside a container
beforeEach(() => {
  reloadEnvironment.inContainer = () => false;
});
afterEach(() => {
  if (original) Object.defineProperty(proto, 'requestHotReload', original);
  else delete proto.requestHotReload;
  reloadTimings.managerAnswerMs = 15_000;
  reloadEnvironment.inContainer = detectContainer;
});

async function reload(bot: FakeBot, byaku: Byaku, text: string): Promise<string> {
  await byaku.run({ ownerId: OWNER_ID, channelId: CHANNEL_ID, text, delivery: { kind: 'reply' } });
  return [...bot.messages.values()].at(-1)?.content ?? '';
}

describe('reload', () => {
  beforeEach(() => seyfertSupportsHotReload(true));

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

  it('tells the owner to update Seyfert when it has no hot reload, with the command for their package manager', async () => {
    seyfertSupportsHotReload(false);
    const reloadFn = vi.fn(async () => []);
    const { bot, byaku } = await setup({ id: 0, total: 2, reload: reloadFn });

    const content = await reload(bot, byaku, 'reload');
    expect(content).toMatch(/✖ Seyfert \S+ is too old: hot reload needs WorkerManager\.hotReload/);
    expect(content).toContain(updateCommand());
    expect(content).toContain('restart the bot once');
    expect(content).toContain('reload files');
    expect(content).toContain('❌');
    expect(reloadFn).not.toHaveBeenCalled();
  });

  it('on a single Client it explains that hot reload needs the WorkerManager', async () => {
    const { bot, byaku } = await setup();
    const content = await reload(bot, byaku, 'reload');
    expect(content).toContain('The bot runs on a single Client');
    expect(content).not.toContain('too old');

    seyfertSupportsHotReload(false);
    const both = await reload(bot, byaku, 'reload');
    expect(both).toContain('too old');
    expect(both).toContain('single Client');
  });

  it('fails with a clear message when the WorkerManager never answers (still on an old Seyfert)', async () => {
    reloadTimings.managerAnswerMs = 50;
    const { bot, byaku } = await setup({ id: 0, total: 2, reload: () => new Promise(() => undefined) });
    const content = await reload(bot, byaku, 'reload');
    expect(content).toContain('The WorkerManager did not answer the reload request');
    expect(content).toContain('restart the bot once after updating Seyfert');
  });

  it('"reload files" loads the Seyfert file handlers again on any client and reports each one', async () => {
    seyfertSupportsHotReload(false);
    const { bot, byaku } = await setup();
    const commands = vi.spyOn(bot.client.commands, 'reloadAll').mockResolvedValue();
    const events = vi.spyOn(bot.client.events!, 'reloadAll').mockRejectedValue(new Error('bad event file'));

    const content = await reload(bot, byaku, 'reload files');
    expect(commands).toHaveBeenCalledWith(false);
    expect(content).toContain('Reloaded the files Seyfert loads');
    expect(content).toContain('✅ commands');
    expect(events).toHaveBeenCalled();
    expect(content).toContain('❌ events: bad event file');
  });

  it('picks the update command from the nearest lockfile', () => {
    const root = mkdtempSync(join(tmpdir(), 'byaku-lock-'));
    try {
      const app = join(root, 'apps', 'bot');
      mkdirSync(app, { recursive: true });
      expect(updateCommand(app)).toBe('npm install seyfert@dev');
      writeFileSync(join(root, 'pnpm-lock.yaml'), '');
      expect(updateCommand(app)).toBe('pnpm add seyfert@dev');
      writeFileSync(join(app, 'yarn.lock'), '');
      expect(updateCommand(app)).toBe('yarn add seyfert@dev');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

describe('reload inside a container', () => {
  beforeEach(() => seyfertSupportsHotReload(true));

  const allDone = async (request: Request) =>
    (request.workerIds ?? []).map((workerId) => ({ workerId, ok: true, ms: 10 }));

  it('adds the image note to a hot reload only in a container', async () => {
    for (const inContainer of [true, false]) {
      reloadEnvironment.inContainer = () => inContainer;
      const { bot, byaku } = await setup({ id: 0, total: 2, reload: allDone });
      const content = await reload(bot, byaku, 'reload');
      expect(content.includes("loads the code already in this container's image")).toBe(inContainer);
      expect(content.includes('docker compose up -d --build')).toBe(inContainer);
    }
  });

  it('tells the owner to rebuild the image instead of restarting when Seyfert is too old', async () => {
    seyfertSupportsHotReload(false);
    for (const inContainer of [true, false]) {
      reloadEnvironment.inContainer = () => inContainer;
      const { bot, byaku } = await setup({ id: 0, total: 2, reload: allDone });
      const content = await reload(bot, byaku, 'reload');
      expect(content.includes('rebuild the image with the new Seyfert and recreate the container')).toBe(inContainer);
      expect(content.includes('Then restart the bot once')).toBe(!inContainer);
    }
  });

  it('tells the owner to recreate the container when the manager never answers', async () => {
    reloadTimings.managerAnswerMs = 50;
    for (const inContainer of [true, false]) {
      reloadEnvironment.inContainer = () => inContainer;
      const { bot, byaku } = await setup({ id: 0, total: 2, reload: () => new Promise(() => undefined) });
      const content = await reload(bot, byaku, 'reload');
      expect(content.includes('recreate the container so the WorkerManager process runs the new Seyfert')).toBe(
        inContainer,
      );
      expect(content.includes('restart the bot once after updating Seyfert')).toBe(!inContainer);
    }
  });
});
