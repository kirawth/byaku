import type { UsingClient, WorkerClient } from 'seyfert';

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

// The bridge owns only this symbol; do not give all globals a bridge-handler index signature.
const globals = globalThis as typeof globalThis & { [BRIDGE_KEY]?: BridgeHandler };

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
) as (client: WorkerClient, vars: BridgeRequest) => Promise<BridgeReply> | BridgeReply;

export function isWorkerClient(
  client: UsingClient,
): client is UsingClient & Pick<WorkerClient, 'tellWorker' | 'workerData'> {
  return (
    'tellWorker' in client &&
    typeof client.tellWorker === 'function' &&
    'workerData' in client &&
    typeof client.workerData === 'object' &&
    client.workerData !== null &&
    'totalWorkers' in client.workerData &&
    typeof client.workerData.totalWorkers === 'number'
  );
}

export function currentWorkerId(client: UsingClient): number {
  return isWorkerClient(client) ? (client.workerData.workerId ?? 0) : 0;
}

export function totalWorkers(client: UsingClient): number {
  return isWorkerClient(client) ? client.workerData.totalWorkers : 1;
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
  const worker = isWorkerClient(client) ? client : undefined;
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
