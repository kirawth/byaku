// A Seyfert worker thread for the WorkerManager test. It runs a real WorkerClient with Byaku (from dist/),
// but never connects to Discord: it only answers the manager's messages.
import { parentPort } from 'node:worker_threads';

import { ApiHandler, WorkerClient } from 'seyfert';

import { Byaku } from '../dist/index.js';

// Seyfert passes worker data to threads through SEYFERT_WORKER_* environment variables
const token = process.env.SEYFERT_WORKER_TOKEN;
const client = new WorkerClient({
  getRC: () => ({ token, intents: 0, debug: false, locations: { base: '.' } }),
  postMessage: (body) => parentPort.postMessage(body),
});
client.setServices({ rest: new ApiHandler({ token }) });
const workerData = client.workerData;

const byaku = new Byaku(client, { owners: ['1'], advanced: { includeAppOwners: false } });
await byaku.install();

parentPort.on('message', (message) => {
  if (message?.type === 'BYAKU_TEST_ALL') {
    const started = Date.now();
    // askWorkers is internal; the test drives it directly
    void byaku
      .askWorkers({ op: 'eval', code: message.code, ownerId: '1', depth: 1 }, undefined, message.timeoutMs)
      .then((results) => parentPort.postMessage({ type: 'BYAKU_TEST_RESULT', results, ms: Date.now() - started }));
    return;
  }
  void client.handleManagerMessages(message).catch(() => undefined);
});

parentPort.postMessage({ type: 'BYAKU_TEST_READY', workerId: workerData.workerId });
