import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { WorkerClient } from 'seyfert';

import { formatMs } from '../output.js';
import { parseDuration } from '../options.js';
import { currentWorkerId, isWorkerClient, totalWorkers } from '../workers.js';
import type { ByakuModeDefinition, ModeContext, ModeOutput } from './index.js';
import { seyfertVersion } from './system.js';

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

/** @internal How long the WorkerManager has to answer a reload request; changed by tests. */
export const reloadTimings = { managerAnswerMs: 15_000 };

let containerCache: boolean | undefined;

/** Whether this process runs in a container (Docker, containerd, Kubernetes); checked once. */
function detectContainer(): boolean {
  if (containerCache !== undefined) return containerCache;
  let found = existsSync('/.dockerenv');
  if (!found) {
    try {
      found = /docker|containerd|kubepods/.test(readFileSync('/proc/1/cgroup', 'utf8'));
    } catch {
      // Not Linux, or /proc is not readable
    }
  }
  return (containerCache = found);
}

/** @internal Where the bot runs; tests replace `inContainer`. */
export const reloadEnvironment = { inContainer: detectContainer };

const CONTAINER_NOTE =
  "Hot reload loads the code already in this container's image. To deploy new code, rebuild the image and " +
  'recreate the container (`docker compose up -d --build`).';

/** Whether the installed Seyfert has WorkerManager.hotReload (added after 5.2.1). */
function seyfertHasHotReload(): boolean {
  return typeof (WorkerClient.prototype as Partial<HotReloadClient>).requestHotReload === 'function';
}

/** The install command for the package manager whose lockfile is nearest to the bot's folder. */
export function updateCommand(cwd = process.cwd()): string {
  const managers: [string, string][] = [
    ['pnpm-lock.yaml', 'pnpm add seyfert@dev'],
    ['yarn.lock', 'yarn add seyfert@dev'],
    ['bun.lock', 'bun add seyfert@dev'],
    ['bun.lockb', 'bun add seyfert@dev'],
    ['package-lock.json', 'npm install seyfert@dev'],
  ];
  for (let dir = cwd; ; dir = dirname(dir)) {
    const found = managers.find(([lockfile]) => existsSync(join(dir, lockfile)));
    if (found) return found[1];
    if (dirname(dir) === dir) return 'npm install seyfert@dev';
  }
}

/** Why a full reload can't run here and what to do about it, or `undefined` when it can. */
function hotReloadBlocker(ctx: ModeContext): string | undefined {
  const hasHotReload = seyfertHasHotReload();
  const onWorkers = isWorkerClient(ctx.client);
  if (hasHotReload && onWorkers) return undefined;
  const lines: string[] = ['A full reload is not available on this bot.', ''];
  if (!hasHotReload) {
    lines.push(
      `✖ Seyfert ${seyfertVersion()} is too old: hot reload needs WorkerManager.hotReload, added after 5.2.1.`,
      "  Update Seyfert in your bot's folder:",
      '',
      `    ${updateCommand()}`,
      '',
      '  (seyfert@latest works too once a release newer than 5.2.1 is out.)',
      reloadEnvironment.inContainer()
        ? '  Then rebuild the image with the new Seyfert and recreate the container (`docker compose up -d --build`).'
        : '  Then restart the bot once, so the WorkerManager process also runs the new version.',
    );
  }
  if (!onWorkers) {
    if (!hasHotReload) lines.push('');
    lines.push(
      '✖ The bot runs on a single Client. Hot reload replaces workers, so the bot has to start through',
      "  Seyfert's WorkerManager (mode 'clusters' or 'threads').",
    );
  }
  lines.push('', 'To load only the command, component, event and lang files again: reload files');
  return lines.join('\n');
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

function managerSilent(): string {
  return (
    'The WorkerManager did not answer the reload request. Its process probably still runs an older Seyfert: ' +
    (reloadEnvironment.inContainer()
      ? 'recreate the container so the WorkerManager process runs the new Seyfert, then try again.'
      : 'restart the bot once after updating Seyfert, then try again.')
  );
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
  let answered = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const noAnswer = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (!answered) reject(new Error(managerSilent()));
    }, reloadTimings.managerAnswerMs);
  });
  const request = client.requestHotReload({
    workerIds: ids,
    ...(readyTimeout !== undefined ? { readyTimeout } : {}),
    ...(drainTimeout !== undefined ? { drainTimeout } : {}),
    ...(ctx.flags.continue ? { continueOnError: true } : {}),
    onProgress: (event) => {
      answered = true;
      stages.set(event.workerId, event.stage);
      if (event.error) errors.set(event.workerId, event.error);
      live.update();
    },
  });
  let result: Result;
  try {
    result = await Promise.race([request, noAnswer]);
  } finally {
    answered = true;
    clearTimeout(timer);
  }

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
    reloadEnvironment.inContainer() ? CONTAINER_NOTE : '',
  ].filter(Boolean);

  return {
    output: [render(), ...(notes.length ? ['', ...notes] : [])].join('\n'),
    ok: failed === 0 && skipped === 0,
    status: [`${result.workers.length - failed}/${ids.length} reloaded`],
  };
}

/** Without the WorkerManager only Seyfert's file handlers can be loaded again. */
async function reloadFiles(ctx: ModeContext): Promise<ModeOutput> {
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
      const blocker = hotReloadBlocker(ctx);
      if (blocker) return { output: blocker, ok: false };
      return hotReload(ctx, ctx.client as unknown as HotReloadClient);
    },
  },
];
