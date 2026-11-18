import { formatMs } from '../output.js';
import { parseDuration } from '../options.js';
import { currentWorkerId, isWorkerClient, totalWorkers } from '../workers.js';
import type { ByakuModeDefinition, ModeContext, ModeOutput } from './index.js';

// Seyfert's hot reload types, kept local so Byaku still type-checks against versions without them
type Stage = 'spawning' | 'connecting' | 'ready' | 'switching' | 'draining' | 'done' | 'failed';

interface Progress {
  workerId: number;
  stage: Stage;
  error?: string;
}

interface Result {
  workers: { workerId: number; ok: boolean; error?: string; ms: number }[];
}

interface HotReloadClient {
  requestHotReload(options: {
    workerIds?: readonly number[];
    readyTimeout?: number;
    drainTimeout?: number;
    continueOnError?: boolean;
    onProgress?(event: Progress): void;
  }): Promise<Result>;
}

interface FileHandler {
  reloadAll(stopIfFail?: boolean): Promise<void>;
}

const ICON: Record<Stage | 'waiting', string> = {
  waiting: '·',
  spawning: '⏳',
  connecting: '⏳',
  ready: '⏳',
  switching: '🔀',
  draining: '🔀',
  done: '✅',
  failed: '❌',
};

function canHotReload(client: object): client is HotReloadClient {
  return isWorkerClient(client as never) && typeof (client as Partial<HotReloadClient>).requestHotReload === 'function';
}

/** Worker ids from the input, or every worker with this one last so it can report the others first. */
function workerIds(ctx: ModeContext): number[] {
  const total = totalWorkers(ctx.client);
  const self = currentWorkerId(ctx.client);
  const words = ctx.input.split(/[\s,]+/).filter(Boolean);
  if (!words.length || words[0] === 'all') {
    return [...Array.from({ length: total }, (_, i) => i).filter((id) => id !== self), self];
  }
  return words.map((word) => {
    const id = Number(word);
    if (!Number.isInteger(id) || id < 0 || id >= total) {
      throw new Error(`"${word}" is not a worker id (0 to ${total - 1})`);
    }
    return id;
  });
}

function durationFlag(ctx: ModeContext, name: string): number | undefined {
  const value = ctx.flags[name];
  if (value === undefined) return undefined;
  if (value === true) throw new Error(`--${name} needs a value, for example --${name}=30s`);
  return parseDuration(value);
}

async function hotReload(ctx: ModeContext, client: HotReloadClient): Promise<ModeOutput> {
  const ids = workerIds(ctx);
  const self = currentWorkerId(ctx.client);
  const readyTimeout = durationFlag(ctx, 'timeout');
  const drainTimeout = durationFlag(ctx, 'drain');
  const stages = new Map<number, Stage | 'waiting'>(ids.map((id) => [id, 'waiting']));
  const errors = new Map<number, string>();
  const times = new Map<number, number>();
  const started = Date.now();

  const render = () =>
    [
      `Hot reload · ${ids.length} worker${ids.length === 1 ? '' : 's'} · ${formatMs(Date.now() - started)}`,
      '',
      ...ids.map((id) => {
        const stage = stages.get(id) ?? 'waiting';
        const time = times.has(id) ? `  ${formatMs(times.get(id))}` : '';
        const note = id === self ? '  (this worker)' : '';
        const error = errors.has(id) ? `\n    ${errors.get(id)}` : '';
        return `${ICON[stage]} worker ${id}  ${stage}${time}${note}${error}`;
      }),
    ].join('\n');

  const live = await ctx.live({ kind: 'reload', render });
  const result = await client.requestHotReload({
    workerIds: ids,
    ...(readyTimeout !== undefined ? { readyTimeout } : {}),
    ...(drainTimeout !== undefined ? { drainTimeout } : {}),
    ...(ctx.flags.continue ? { continueOnError: true } : {}),
    onProgress: (event) => {
      stages.set(event.workerId, event.stage);
      if (event.error) errors.set(event.workerId, event.error);
      live.update();
    },
  });

  for (const worker of result.workers) {
    stages.set(worker.workerId, worker.ok ? 'done' : 'failed');
    times.set(worker.workerId, worker.ms);
    if (worker.error) errors.set(worker.workerId, worker.error);
  }
  const failed = result.workers.filter((w) => !w.ok).length;
  const skipped = ids.length - result.workers.length;
  const notes = [
    failed ? `${failed} failed and kept running the old code.` : '',
    skipped ? `${skipped} not attempted after a failure (use --continue to keep going).` : '',
    ids.includes(self) && result.workers.some((w) => w.workerId === self && w.ok)
      ? 'This worker was replaced; the buttons below stop working once it drains.'
      : '',
  ].filter(Boolean);

  return {
    output: [render(), ...(notes.length ? ['', ...notes] : [])].join('\n'),
    ok: failed === 0 && skipped === 0,
    status: [`${result.workers.length - failed}/${ids.length} reloaded`],
  };
}

/** Without the WorkerManager only Seyfert's file handlers can be loaded again. */
async function reloadFiles(ctx: ModeContext, reason?: string): Promise<ModeOutput> {
  const handlers = ctx.client as unknown as Record<string, FileHandler | undefined>;
  const lines: string[] = [];
  let ok = true;
  for (const name of ['commands', 'components', 'events', 'langs']) {
    const handler = handlers[name];
    if (typeof handler?.reloadAll !== 'function') continue;
    try {
      await handler.reloadAll(false);
      lines.push(`✅ ${name}`);
    } catch (err) {
      ok = false;
      lines.push(`❌ ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    output: [
      'Reloaded the files Seyfert loads (this worker only):',
      ...lines,
      '',
      'Your main file, services and the helpers these files import keep their old code.',
      ...(reason ? [reason] : []),
    ].join('\n'),
    ok,
  };
}

export const reloadModes: ByakuModeDefinition[] = [
  {
    name: 'reload',
    aliases: ['rl'],
    description: 'Reload all bot code without going offline by replacing workers one by one',
    usage: 'reload [all | <worker ids> | files] [--timeout=60s] [--drain=10s] [--continue]',
    examples: ['reload', 'reload 0 2', 'reload files'],
    rerunnable: false,
    run(ctx) {
      if (ctx.input.trim() === 'files') return reloadFiles(ctx);
      if (canHotReload(ctx.client)) return hotReload(ctx, ctx.client);
      return reloadFiles(
        ctx,
        isWorkerClient(ctx.client)
          ? 'A full reload needs a Seyfert version with WorkerManager.hotReload.'
          : 'A full reload needs the bot to run on Seyfert’s WorkerManager.',
      );
    },
  },
];
