import type { UsingClient } from 'seyfert';

import { errorMessage } from './inspect.js';

/** Each worker's Byaku answers requests from other workers through this global. */
const BRIDGE_KEY = Symbol.for('byaku.bridge');

export type BridgeRequest = { op: 'eval'; code: string; ownerId: string; depth: number } | { op: 'info' };

/** Crosses `postMessage`, so plain data only. */
interface BridgeReply {
  ok: boolean;
  text: string;
}

export type BridgeHandler = (request: BridgeRequest) => Promise<BridgeReply>;

export interface WorkerResult extends BridgeReply {
  workerId: number;
  ms: number;
  timedOut?: boolean;
}

// WorkerClient's extra members aren't on `UsingClient`
interface WorkerClientLike {
  workerData?: { totalWorkers?: number; workerId?: number };
  tellWorker?: (
    workerId: number,
    func: (...args: never[]) => unknown,
    vars: Record<string, unknown>,
  ) => Promise<unknown>;
}

// `typeof globalThis` has no symbol index signature
const globals = globalThis as unknown as Record<symbol, BridgeHandler | undefined>;

export function installBridge(handler: BridgeHandler): void {
  globals[BRIDGE_KEY] = handler;
}

export function uninstallBridge(handler: BridgeHandler): void {
  if (globals[BRIDGE_KEY] === handler) globals[BRIDGE_KEY] = undefined;
}

/**
 * Seyfert sends `func.toString()` to the other worker and runs it with `eval`, so the function can't close
 * over anything. Building it from a string also keeps bundlers from adding helpers to it.
 */
const REMOTE = new Function(
  'client',
  'vars',
  `var handle = globalThis[Symbol.for('byaku.bridge')];
   return handle ? handle(vars) : { ok: false, text: 'Byaku is not installed on worker ' + client.workerId };`,
) as (...args: never[]) => unknown;

function asWorker(client: UsingClient): WorkerClientLike | undefined {
  const c = client as unknown as WorkerClientLike;
  return typeof c.tellWorker === 'function' && typeof c.workerData?.totalWorkers === 'number' ? c : undefined;
}

export function isWorkerClient(client: UsingClient): boolean {
  return asWorker(client) !== undefined;
}

export function currentWorkerId(client: UsingClient): number {
  return asWorker(client)?.workerData?.workerId ?? 0;
}

export function totalWorkers(client: UsingClient): number {
  return asWorker(client)?.workerData?.totalWorkers ?? 1;
}

/** Runs a request on one worker, waiting at most `timeoutMs`. This worker is asked directly. Never rejects. */
export async function askWorker(
  client: UsingClient,
  workerId: number,
  request: BridgeRequest,
  timeoutMs: number,
): Promise<WorkerResult> {
  const started = Date.now();
  const result = (reply: BridgeReply, timedOut = false): WorkerResult => ({
    workerId,
    ...reply,
    ms: Date.now() - started,
    ...(timedOut ? { timedOut } : {}),
  });

  let call: Promise<unknown>;
  const worker = asWorker(client);
  if (workerId === currentWorkerId(client)) {
    const handler = globals[BRIDGE_KEY];
    if (!handler) return result({ ok: false, text: 'Byaku is not installed on this worker' });
    call = handler(request);
  } else if (!worker?.tellWorker) {
    return result({ ok: false, text: `There is no worker ${workerId} (this bot runs a single Client)` });
  } else if (workerId < 0 || workerId >= totalWorkers(client)) {
    return result({ ok: false, text: `There is no worker ${workerId}` });
  } else {
    call = worker.tellWorker(workerId, REMOTE, request);
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs).unref();
  });
  try {
    const reply = await Promise.race([call, timeout]);
    if (reply === 'timeout')
      return result({ ok: false, text: `timed out after ${Math.round(timeoutMs / 1000)} s` }, true);
    // Seyfert passes an error thrown on the other worker back as the value
    if (reply instanceof Error) return result({ ok: false, text: reply.message });
    return result(reply as BridgeReply);
  } catch (err) {
    return result({ ok: false, text: errorMessage(err) });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks every worker at once. Not `client.tellWorkers`: its `Promise.all` waits forever on a dead worker,
 * while each request here has its own timeout.
 */
export function askAllWorkers(client: UsingClient, request: BridgeRequest, timeoutMs: number): Promise<WorkerResult[]> {
  return Promise.all(
    Array.from({ length: totalWorkers(client) }, (_, id) => askWorker(client, id, request, timeoutMs)),
  );
}
