import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { WorkerClient } from 'seyfert';

import { errorMessage } from '../inspect.js';
import { formatMs } from '../output.js';
import { parseDuration } from '../options.js';
import { currentWorkerId, isWorkerClient, totalWorkers } from '../workers.js';
import type { Byaku } from '../byaku.js';
import type { Session } from '../session.js';
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
export const reloadTimings = { managerAnswerMs: 15_000, activePollMs: 500 };

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

/** Saved on the reload's session while a hot reload that replaces this worker runs. */
interface PendingReload {
  workerId: number;
  workerIds: number[];
  startedAt: number;
  expiresAt: number;
}

// Seyfert's default ready timeout is 60 s plus the connect queue; the drain default is 10 s
const DEFAULT_READY_MS = 90_000;
const DEFAULT_DRAIN_MS = 10_000;
const HAND_OFF_MARGIN_MS = 60_000;

function pendingReload(session: Session): PendingReload | undefined {
  const pending = session.data.pendingReload as PendingReload | undefined;
  return pending && typeof pending.workerId === 'number' && typeof pending.expiresAt === 'number' ? pending : undefined;
}

/** What Seyfert's WorkerClient (5.2.2-dev-44386046816.0 and newer) says about a hot reload. */
interface HotReloadStateClient {
  readonly isHotReloadReplacement?: boolean;
  readonly hotReloadState?: 'active' | 'standby' | 'stopped';
}

/**
 * @internal On a worker that replaced the one running `reload`, finishes that reload's message once this worker
 * takes over, when the old worker didn't live to do it. Needs a shared session store. Resolves to true when it
 * edited the message.
 */
export async function finishPendingReload(byaku: Byaku): Promise<boolean> {
  const client = byaku.client as unknown as HotReloadStateClient;
  if (!byaku.options.store || client.isHotReloadReplacement !== true) return false;
  const self = currentWorkerId(byaku.client);
  const find = async () =>
    (await byaku.sessions.store.list()).find((session) => {
      const pending = pendingReload(session);
      return pending?.workerId === self && pending.expiresAt > Date.now();
    });

  const first = await find();
  const pending = first && pendingReload(first);
  if (!pending) return false;
  // A replacement starts on standby and only builds its cache until the manager switches to it
  while (client.hotReloadState !== 'active') {
    if (client.hotReloadState === 'stopped' || Date.now() > pending.expiresAt) return false;
    await new Promise((resolve) => setTimeout(resolve, reloadTimings.activePollMs).unref?.());
  }

  // The old worker may have finished the message in the meantime
  const session = await find();
  if (!session) return false;
  delete session.data.pendingReload;
  delete session.live;
  session.output = `${session.output}\n\n✅ Reload finished · worker ${self} took over · ${formatMs(Date.now() - pending.startedAt)}`;
  session.pages = [session.output];
  session.page = 0;
  await byaku.sessions.save(session);
  if (session.replyId) await byaku.editSession(session);
  return true;
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
  // With a shared store, this worker's replacement can finish the message if this worker never sees the result
  const handOff = Boolean(ctx.byaku.options.store) && ids.includes(self);
  if (handOff) {
    const perWorker = (readyTimeout ?? DEFAULT_READY_MS) + (drainTimeout ?? DEFAULT_DRAIN_MS);
    const pending: PendingReload = {
      workerId: self,
      workerIds: ids,
      startedAt: started,
      expiresAt: started + perWorker * ids.length + HAND_OFF_MARGIN_MS,
    };
    ctx.session.data.pendingReload = pending;
    await ctx.byaku.sessions.save(ctx.session);
  }
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
    // This worker saw the result, so the replacement has nothing to finish; Byaku saves the session after the run
    delete ctx.session.data.pendingReload;
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
    details: {
      kind: 'hot',
      workers: ids.length,
      reloaded: result.workers.length - failed,
      failed,
      skipped,
      docker: reloadEnvironment.inContainer(),
    },
  };
}

/** Seyfert's HandlerReloadResult (5.2.2-dev-44386046816.0 and newer), kept local like the types above. */
interface HandlerReloadResult {
  reloaded: string[];
  failed: { path: string; error: unknown }[];
}

/** Seyfert's file handlers; `reloadFiles` exists from 5.2.2-dev-44386046816.0. */
interface FileHandler {
  reloadAll(stopIfFail?: boolean): Promise<void>;
  reloadFiles?(stopIfFail?: boolean): Promise<HandlerReloadResult>;
}

interface FilesReport {
  lines: string[];
  files: number;
  failed: number;
  skipped: number;
}

/** Whether the bot replaced the handler's `onFile`, on the instance or in a subclass. */
function hasCustomOnFile(handler: object): boolean {
  if (Object.hasOwn(handler, 'onFile')) return true;
  let nearest: unknown;
  let base: unknown;
  for (let proto = Object.getPrototypeOf(handler) as object | null; proto && proto !== Object.prototype;) {
    if (Object.hasOwn(proto, 'onFile')) {
      const onFile = (proto as { onFile: unknown }).onFile;
      nearest ??= onFile;
      base = onFile;
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return nearest !== base;
}

/** The files a handler's entries came from, by Seyfert's `__filePath`. */
function loadedFiles(entries: readonly unknown[]): Set<string> {
  const files = new Set<string>();
  for (const entry of entries) {
    const path = (entry as { __filePath?: unknown } | undefined)?.__filePath;
    if (typeof path === 'string') files.add(path);
  }
  return files;
}

function shortError(ctx: ModeContext, err: unknown): string {
  const first = errorMessage(err).split('\n')[0] ?? '';
  return ctx.redact(first.length > 160 ? `${first.slice(0, 159)}…` : first);
}

const shownPath = (path: string) => relative(process.cwd(), path) || path;

/** Reloads one handler and adds its lines and counts to the report. */
async function reloadHandler(
  ctx: ModeContext,
  name: 'commands' | 'components' | 'events' | 'langs',
  handler: FileHandler,
  report: FilesReport,
): Promise<boolean> {
  // This Seyfert reports every file
  if (typeof handler.reloadFiles === 'function') {
    const result = await handler.reloadFiles(false);
    report.files += result.reloaded.length;
    report.failed += result.failed.length;
    if (!result.failed.length) {
      report.lines.push(`✅ ${name} · ${result.reloaded.length} file${result.reloaded.length === 1 ? '' : 's'}`);
      return true;
    }
    report.lines.push(`❌ ${name} · ${result.reloaded.length} reloaded, ${result.failed.length} failed`);
    for (const { path, error } of result.failed) report.lines.push(`    ${shownPath(path)}: ${shortError(ctx, error)}`);
    return false;
  }

  if (name === 'events' || name === 'langs') {
    await handler.reloadAll(false);
    report.lines.push(`✅ ${name}`);
    return true;
  }

  // Older Seyferts reload without the handler's onFile: a file exporting several entries loses all but one
  if (hasCustomOnFile(handler) && !ctx.flags.force) {
    report.skipped++;
    report.lines.push(
      `⚠️ ${name} skipped: this Seyfert's reload ignores your onFile and would drop files.`,
      `    Update Seyfert (${updateCommand()}) or use \`reload\`. \`reload files --force\` runs it anyway.`,
    );
    return true;
  }
  const entries = () =>
    name === 'components' ? (ctx.client.components?.commands ?? []) : (ctx.client.commands?.values ?? []);
  const before = loadedFiles(entries());
  await handler.reloadAll(false);
  const after = loadedFiles(entries());
  const dropped = [...before].filter((path) => !after.has(path));
  report.files += before.size - dropped.length;
  report.failed += dropped.length;
  if (!dropped.length) {
    report.lines.push(`✅ ${name} · ${before.size} file${before.size === 1 ? '' : 's'}`);
    return true;
  }
  report.lines.push(`❌ ${name} · ${before.size - dropped.length} reloaded, ${dropped.length} dropped`);
  for (const path of dropped)
    report.lines.push(`    ${shownPath(path)}: dropped (its entries are gone until a restart)`);
  return false;
}

/** Loads the files Seyfert's handlers read again, in this worker only. */
async function reloadFiles(ctx: ModeContext): Promise<ModeOutput> {
  const handlers = ctx.client as unknown as Record<string, FileHandler | undefined>;
  const report: FilesReport = { lines: [], files: 0, failed: 0, skipped: 0 };
  let ok = true;
  for (const name of ['commands', 'components', 'events', 'langs'] as const) {
    const handler = handlers[name];
    if (typeof handler?.reloadAll !== 'function') continue;
    try {
      if (!(await reloadHandler(ctx, name, handler, report))) ok = false;
    } catch (err) {
      ok = false;
      report.lines.push(`❌ ${name}: ${shortError(ctx, err)}`);
    }
  }
  return {
    output: [
      'Reloaded the files Seyfert loads (this worker only):',
      ...report.lines,
      '',
      'Your main file, services and the helpers these files import keep their old code.',
    ].join('\n'),
    ok,
    details: { kind: 'files', files: report.files, failed: report.failed, skipped: report.skipped },
  };
}

export const reloadModes: ByakuModeDefinition[] = [
  {
    name: 'reload',
    aliases: ['rl'],
    description: 'Reload all bot code without going offline by replacing workers one by one',
    usage: 'reload [all | <worker ids> | files] [--timeout=60s] [--drain=10s] [--continue] [--force]',
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
