import { createRequire } from 'node:module';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import { VERSION } from '../options.js';
import { discordTimestamp, formatBytes, formatMs, table } from '../output.js';
import { splitFirst } from '../parse.js';
import { currentWorkerId, isWorkerClient, totalWorkers, type WorkerResult } from '../workers.js';
import type { ByakuModeDefinition, ModeOutput } from './index.js';

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

// Seyfert's cache and gateway members differ between Client and WorkerClient, and `UsingClient` has neither
interface ClientInternals {
  cache: Record<string, { count?: (guild?: string) => unknown } | undefined>;
  workerData?: { shards?: number[]; totalShards?: number };
  gateway?: Map<number, { latency: number; isOpen: boolean }> & { totalShards?: number };
  latency?: number;
}

function seyfertVersion(): string {
  try {
    return (createRequire(join(process.cwd(), 'index.js'))('seyfert/package.json') as { version: string }).version;
  } catch {
    return '?';
  }
}

async function count(read: () => unknown): Promise<string> {
  try {
    const n = await read();
    return typeof n === 'number' ? n.toLocaleString('en-US') : '-';
  } catch {
    return '-';
  }
}

function mergeResults(results: WorkerResult[]): ModeOutput {
  return {
    output: results.map((r) => `[worker ${r.workerId}] ${r.ok ? '✅' : '❌'} ${r.ms} ms\n${r.text}`).join('\n\n'),
    ok: results.every((r) => r.ok),
    lang: 'js',
  };
}

function jsArgument(input: string): string | undefined {
  const [word, rest] = splitFirst(input);
  return /^(js|eval|e)$/i.test(word) ? rest : undefined;
}

const shards: ByakuModeDefinition = {
  name: 'shards',
  description: 'Workers and shards: status, ping, memory',
  usage: 'shards',
  async run(ctx) {
    if (!isWorkerClient(ctx.client)) {
      const { gateway } = ctx.client as unknown as ClientInternals;
      const rows = [...(gateway?.entries() ?? [])].map(([id, shard]) => [
        id,
        shard.isOpen ? 'open' : 'closed',
        formatMs(shard.latency),
      ]);
      return { output: rows.length ? table(['shard', 'status', 'ping'], rows) : 'No shards (HTTP-only client?)' };
    }
    const results = await ctx.byaku.askWorkers({ op: 'info' });
    const rows = results.map((r) => {
      if (!r.ok) return [r.workerId, '-', '-', '-', r.text];
      const info = JSON.parse(r.text) as { pid: number; rss: number; latency: number };
      return [r.workerId, info.pid, formatBytes(info.rss), formatMs(info.latency), 'ok'];
    });
    return { output: table(['worker', 'pid', 'rss', 'ping', 'status'], rows), ok: results.every((r) => r.ok) };
  },
};

export const systemModes: ByakuModeDefinition[] = [
  {
    name: 'summary',
    description: 'Versions, process, memory, shards and cache at a glance',
    rerunnable: false,
    async run(ctx) {
      const client = ctx.client as unknown as ClientInternals;
      const mem = process.memoryUsage();
      const started = Date.now() - process.uptime() * 1000;
      const [guilds, users, channels] = await Promise.all([
        count(() => client.cache.guilds?.count?.()),
        count(() => client.cache.users?.count?.()),
        count(() => client.cache.channels?.count?.('*')),
      ]);
      const where = isWorkerClient(ctx.client)
        ? `worker ${currentWorkerId(ctx.client)} of ${totalWorkers(ctx.client)} · shards ${client.workerData?.shards?.join(', ') ?? '-'} of ${client.workerData?.totalShards ?? '-'}`
        : `shards ${client.gateway?.size ?? '-'} of ${client.gateway?.totalShards ?? '-'}`;
      const lag =
        loopDelay.count > 0
          ? `${(loopDelay.mean / 1e6).toFixed(1)} ms avg, ${(loopDelay.percentile(99) / 1e6).toFixed(1)} ms p99`
          : '-';

      return {
        text: [
          `**Byaku** \`v${VERSION}\` · Seyfert \`v${seyfertVersion()}\` · Node.js \`${process.version}\` on \`${process.platform} ${process.arch}\``,
          `Process started ${discordTimestamp(started, 'R')} (${discordTimestamp(started, 'f')}) · PID \`${process.pid}\``,
          `Memory: **${formatBytes(mem.rss)}** RSS · heap ${formatBytes(mem.heapUsed)} / ${formatBytes(mem.heapTotal)}`,
          `Running ${where} · gateway ping ${formatMs(client.latency)}`,
          `Cache: ${guilds} guilds · ${users} users · ${channels} channels`,
          `Event-loop lag: ${lag}`,
          '',
          '-# `help` lists every mode.',
        ].join('\n'),
      };
    },
  },
  shards,
  {
    name: 'shard',
    description: 'Run JavaScript on one worker',
    usage: 'shard <workerId> js <code>',
    examples: ['shard 1 js client.cache.guilds.count()'],
    async run(ctx) {
      const [id, rest] = splitFirst(ctx.input);
      if (!id) return shards.run(ctx);
      const code = jsArgument(rest);
      if (!Number.isInteger(Number(id)) || code === undefined)
        return { output: 'Usage: shard <workerId> js <code>', ok: false };
      return mergeResults(
        await ctx.byaku.askWorkers(
          { op: 'eval', code, ownerId: ctx.author.id, depth: ctx.session.view.depth },
          Number(id),
        ),
      );
    },
  },
  {
    name: 'all',
    description: 'Run JavaScript on every worker and merge the results (each waits at most 10 s)',
    usage: 'all js <code>',
    examples: ['all js process.memoryUsage().rss'],
    async run(ctx) {
      const code = jsArgument(ctx.input);
      if (code === undefined) return { output: 'Usage: all js <code>', ok: false };
      return mergeResults(
        await ctx.byaku.askWorkers({ op: 'eval', code, ownerId: ctx.author.id, depth: ctx.session.view.depth }),
      );
    },
  },
];
