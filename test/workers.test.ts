import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { WorkerManager } from 'seyfert';
import { afterAll, describe, expect, it } from 'vitest';

import { TOKEN } from './helpers.js';

const fixture = fileURLToPath(new URL('./workers-fixture.mjs', import.meta.url));
const built = existsSync(fileURLToPath(new URL('../dist/index.js', import.meta.url)));

interface Message {
  type: string;
  workerId?: number;
  results?: { workerId: number; ok: boolean; text: string; timedOut?: boolean; ms: number }[];
  ms?: number;
}

/**
 * Real worker threads under a real WorkerManager. The manager is never started (no gateway); workers are
 * created directly and talk through Seyfert's own EVAL_TO_WORKER / EVAL_RESPONSE messages.
 */
describe.skipIf(!built)('WorkerManager + tellWorker bridge (needs `npm run build` first)', () => {
  const messages: Message[] = [];
  const waiters: ((m: Message) => boolean)[] = [];
  const manager = new WorkerManager({
    mode: 'threads',
    path: fixture,
    token: TOKEN,
    intents: 0,
    totalShards: 3,
    shardsPerWorker: 1,
    workers: 3,
    info: {
      url: 'wss://gateway.discord.gg',
      shards: 3,
      session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
    },
    handleWorkerMessage: (message: Message) => {
      messages.push(message);
      for (const w of [...waiters]) if (w(message)) waiters.splice(waiters.indexOf(w), 1);
    },
  } as never);

  const waitFor = (check: (m: Message) => boolean, timeoutMs: number) =>
    new Promise<Message>((resolve, reject) => {
      const found = messages.find(check);
      if (found) return resolve(found);
      const timer = setTimeout(() => reject(new Error('timed out waiting for a worker message')), timeoutMs);
      waiters.push((m) => {
        if (!check(m)) return false;
        clearTimeout(timer);
        resolve(m);
        return true;
      });
    });

  afterAll(async () => {
    for (const worker of manager.values()) await (worker as unknown as { terminate(): Promise<number> }).terminate?.();
  });

  it('starts three workers with Byaku', async () => {
    for (let i = 0; i < 3; i++) {
      const worker = await manager.createWorker({
        path: fixture,
        token: TOKEN,
        shards: [i],
        intents: 0,
        workerId: i,
        totalShards: 3,
        totalWorkers: 3,
        mode: 'threads',
        resharding: false,
        debug: false,
        workerProxy: false,
        compress: false,
        info: {
          url: 'wss://gateway.discord.gg',
          shards: 3,
          session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
        },
      } as never);
      // prepareWorkers() would do this; the manager is a Map of workers
      manager.set(i, worker as never);
    }
    for (let i = 0; i < 3; i++) await waitFor((m) => m.type === 'BYAKU_TEST_READY' && m.workerId === i, 20_000);
  }, 30_000);

  it('`all js` returns every worker’s result', async () => {
    (manager.get(0) as unknown as { postMessage(m: unknown): void }).postMessage({
      type: 'BYAKU_TEST_ALL',
      code: 'require("node:worker_threads").threadId + 0 > 0 ? "worker:" + client.workerId : "main"',
      timeoutMs: 10_000,
    });
    const result = await waitFor((m) => m.type === 'BYAKU_TEST_RESULT', 15_000);
    messages.splice(messages.indexOf(result), 1);
    expect(result.results!.map((r) => [r.workerId, r.ok, r.text])).toEqual([
      [0, true, 'worker:0'],
      [1, true, 'worker:1'],
      [2, true, 'worker:2'],
    ]);
  }, 20_000);

  it('with one worker down, `all js` still answers within 10 s and marks it timed out', async () => {
    await (manager.get(2) as unknown as { terminate(): Promise<number> }).terminate();
    const started = Date.now();
    (manager.get(0) as unknown as { postMessage(m: unknown): void }).postMessage({
      type: 'BYAKU_TEST_ALL',
      code: '"alive:" + client.workerId',
      timeoutMs: 10_000,
    });
    const result = await waitFor((m) => m.type === 'BYAKU_TEST_RESULT', 15_000);
    const took = Date.now() - started;
    expect(took).toBeLessThan(11_000);
    const [w0, w1, w2] = result.results!;
    expect(w0).toMatchObject({ workerId: 0, ok: true, text: 'alive:0' });
    expect(w1).toMatchObject({ workerId: 1, ok: true, text: 'alive:1' });
    expect(w2).toMatchObject({ workerId: 2, ok: false, timedOut: true, text: 'timed out after 10 s' });
  }, 20_000);
});
