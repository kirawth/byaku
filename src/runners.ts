import { type ChildProcess, spawn } from 'node:child_process';
import { open, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { ByakuError } from './options.js';

type AsyncFn = (...args: unknown[]) => Promise<unknown>;
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => AsyncFn;

const SCOPE = '__byaku_scope__';

export interface JsResult {
  ok: boolean;
  value?: unknown;
  error?: unknown;
  ms: number;
  kind: 'expression' | 'statements';
}

interface OwnerState {
  retain: boolean;
  vars: Record<string, unknown>;
  /** Newest first: `$1` is the last result. */
  history: unknown[];
  last: unknown;
  hasLast: boolean;
  touchedAt: number;
}

/**
 * Runs JavaScript per owner. Code runs as an expression first (`1 + 1`, `await x`) and otherwise as an
 * async function body. Each owner keeps their own variables, `_` (last result) and `$1…$n`.
 */
export class JsRunner {
  private readonly owners = new Map<string, OwnerState>();
  private readonly historySize: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { historySize?: number; ttlMs?: number; now?: () => number } = {}) {
    this.historySize = options.historySize ?? 10;
    this.ttlMs = options.ttlMs ?? 15 * 60_000;
    this.now = options.now ?? Date.now;
  }

  retain(ownerId: string, on?: boolean): boolean {
    const state = this.state(ownerId);
    if (on !== undefined) {
      state.retain = on;
      if (!on) state.vars = Object.create(null) as Record<string, unknown>;
    }
    return state.retain;
  }

  reset(ownerId: string): void {
    this.owners.set(ownerId, this.fresh(this.owners.get(ownerId)?.retain ?? true));
  }

  variables(ownerId: string): string[] {
    return Object.keys(this.owners.get(ownerId)?.vars ?? {});
  }

  async run(code: string, ownerId: string, scope: Record<string, unknown> = {}): Promise<JsResult> {
    const state = this.state(ownerId);
    if (!state.retain) state.vars = Object.create(null) as Record<string, unknown>;

    const builtins: Record<string, unknown> = { ...scope };
    if (state.hasLast) builtins._ = state.last;
    state.history.forEach((value, i) => (builtins[`$${i + 1}`] = value));
    const started = performance.now();

    let fn: AsyncFn;
    let kind: JsResult['kind'] = 'expression';
    try {
      // `function f() {}` also parses as an expression, but the owner means to define `f`
      if (/^\s*(const|let|var|class|function|async\s+function)\b/.test(code)) throw new SyntaxError('declaration');
      fn = new AsyncFunction(SCOPE, `with (${SCOPE}) { return (\n${code}\n); }`);
    } catch {
      kind = 'statements';
      try {
        fn = new AsyncFunction(SCOPE, `with (${SCOPE}) {\n${hoistDeclarations(code)}\n}`);
      } catch (error) {
        return { ok: false, error, ms: performance.now() - started, kind };
      }
    }

    try {
      const value = await fn(scopeProxy(builtins, state.vars));
      state.last = value;
      state.hasLast = true;
      state.history = [value, ...state.history].slice(0, this.historySize);
      return { ok: true, value, ms: performance.now() - started, kind };
    } catch (error) {
      return { ok: false, error, ms: performance.now() - started, kind };
    }
  }

  private state(ownerId: string): OwnerState {
    let state = this.owners.get(ownerId);
    // Kept values expire with the session lifetime; the retain setting survives
    if (!state || this.now() - state.touchedAt > this.ttlMs) {
      state = this.fresh(state?.retain ?? true);
      this.owners.set(ownerId, state);
    }
    state.touchedAt = this.now();
    return state;
  }

  private fresh(retain: boolean): OwnerState {
    const vars = Object.create(null) as Record<string, unknown>;
    return { retain, vars, history: [], last: undefined, hasLast: false, touchedAt: this.now() };
  }
}

/**
 * The object behind `with`: reads come from the scope, then kept variables, then globals. Writes to
 * non-global names land in the kept variables instead of creating globals, and unknown names still throw
 * a normal ReferenceError.
 */
function scopeProxy(builtins: Record<string, unknown>, vars: Record<string, unknown>): object {
  return new Proxy(Object.create(null) as object, {
    has: (_, key) =>
      typeof key === 'string' && key !== SCOPE && (key in builtins || key in vars || !(key in globalThis)),
    get(_, key) {
      if (typeof key !== 'string') return undefined;
      if (key in builtins) return builtins[key];
      if (key in vars) return vars[key];
      throw new ReferenceError(`${key} is not defined`);
    },
    set(_, key, value) {
      if (typeof key !== 'string') return false;
      if (key in builtins) builtins[key] = value;
      else vars[key] = value;
      return true;
    },
    deleteProperty: (_, key) => typeof key !== 'string' || Reflect.deleteProperty(vars, key),
  });
}

/**
 * Rewrites top-level `const/let/var x =`, `function f`, `class A` into assignments so the names land in the
 * kept variables. Only depth-0 code is touched (not strings, comments, templates or regexes); destructuring
 * stays local to the run.
 */
export function hoistDeclarations(code: string): string {
  const top = topLevelMask(code);
  let out = '';

  for (let i = 0; i < code.length;) {
    const rest = top[i] && isStatementStart(code, i) ? code.slice(i) : '';
    const decl = rest && /^(const|let|var)(\s+)([A-Za-z_$][\w$]*)(\s*)(=|;|\n|$)/.exec(rest);
    const fn = rest && /^(async\s+)?function(\s*\*?\s*)([A-Za-z_$][\w$]*)\s*\(/.exec(rest);
    const cls = rest && /^class\s+([A-Za-z_$][\w$]*)\b/.exec(rest);

    if (decl) {
      const [match, , , name = '', space = '', after = ''] = decl;
      out += after === '=' ? `${name}${space}=` : `${name} = undefined${after}`;
      i += match.length;
    } else if (fn) {
      out += `${fn[3]} = ${fn[0]}`;
      i += fn[0].length;
    } else if (cls) {
      out += `${cls[1]} = ${cls[0]}`;
      i += cls[0].length;
    } else {
      out += code[i++];
    }
  }

  return out;
}

function isStatementStart(code: string, i: number): boolean {
  if (i > 0 && /[\w$]/.test(code[i - 1] ?? '')) return false;
  let j = i - 1;
  while (j >= 0 && /[ \t]/.test(code[j] ?? '')) j--;
  return j < 0 || /[;}\n\r]/.test(code[j] ?? '');
}

/** For each character: is it code at nesting depth 0? Good enough for REPL input, not a full parser. */
export function topLevelMask(code: string): boolean[] {
  const mask = new Array<boolean>(code.length).fill(false);
  let depth = 0;
  let i = 0;
  // The last significant character, to tell a regex `/` from a division
  let prev = '';
  // Depth at which each open `${` of a template literal started
  const templates: number[] = [];

  const skipString = (quote: string) => {
    for (i++; i < code.length && code[i] !== quote && code[i] !== '\n'; i++) if (code[i] === '\\') i++;
    i++;
  };

  // Called just after a backtick, or after the `}` that closes a `${`
  const skipTemplate = () => {
    while (i < code.length) {
      if (code[i] === '\\') {
        i += 2;
      } else if (code[i] === '`') {
        i++;
        return;
      } else if (code[i] === '$' && code[i + 1] === '{') {
        templates.push(depth++);
        i += 2;
        return;
      } else {
        i++;
      }
    }
  };

  const skipRegex = () => {
    let inClass = false;
    for (i++; i < code.length && code[i] !== '\n'; i++) {
      const c = code[i];
      if (c === '\\') i++;
      else if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
    }
    i++;
    while (/[a-z]/i.test(code[i] ?? '')) i++;
  };

  while (i < code.length) {
    const ch = code[i] ?? '';
    const next = code[i + 1] ?? '';

    if (ch === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i++;
    } else if (ch === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end < 0 ? code.length : end + 2;
    } else if (
      ch === '"' ||
      ch === "'" ||
      ch === '`' ||
      (ch === '/' && (prev === '' || /[(,=:[!&|?{};+\-*%<>~^\n]/.test(prev)))
    ) {
      if (ch === '`') {
        i++;
        skipTemplate();
      } else if (ch === '/') {
        skipRegex();
      } else {
        skipString(ch);
      }
      prev = 'a';
    } else if (ch === '}' && templates.length && templates[templates.length - 1] === depth - 1) {
      templates.pop();
      depth--;
      i++;
      skipTemplate();
      prev = 'a';
    } else {
      if ('{(['.includes(ch)) depth++;
      else if ('})]'.includes(ch)) depth = Math.max(0, depth - 1);
      else if (depth === 0) mask[i] = true;
      if (!/\s/.test(ch) || ch === '\n') prev = ch;
      i++;
    }
  }

  return mask;
}

export type Transpiler = (code: string) => string | Promise<string>;

interface Sucrase {
  transform(code: string, options: { transforms: string[]; disableESTransforms?: boolean }): { code: string };
}

let sucrase: Promise<Sucrase | undefined> | undefined;

/** Sucrase is an optional peer dependency, loaded the first time `ts` runs. */
const sucraseTranspiler: Transpiler = async (code) => {
  sucrase ??= import('sucrase').then(
    (m: Sucrase & { default?: Sucrase }) => (typeof m.transform === 'function' ? m : m.default),
    () => undefined,
  );
  const mod = await sucrase;
  if (!mod)
    throw new ByakuError(
      'TRANSPILER_MISSING',
      'The ts mode needs sucrase: `npm i sucrase` (or pass advanced.transpile).',
    );
  return mod.transform(code, { transforms: ['typescript'], disableESTransforms: true }).code;
};

const START = '/*__byaku_start__*/';
const END = '/*__byaku_end__*/';

/**
 * Transpilers reject top-level `return` and `await`, so the code is wrapped in an async function for the
 * transpiler and unwrapped afterwards.
 */
export async function transpileTs(code: string, transpile: Transpiler = sucraseTranspiler): Promise<string> {
  const unwrap = (out: string) => out.slice(out.indexOf(START) + START.length, out.lastIndexOf(END)).trim();

  if (!/^\s*(const|let|var|class|function|async\s+function|interface|type|enum|namespace|declare)\b/.test(code)) {
    try {
      return unwrap(await transpile(`async function __byaku__() { return (${START}\n${code}\n${END}); }`));
    } catch (err) {
      if (err instanceof ByakuError) throw err;
    }
  }
  return unwrap(await transpile(`async function __byaku__() {${START}\n${code}\n${END}}`));
}

export interface ShellExit {
  /** `null` when ended by a signal. */
  code: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  timedOut: boolean;
  ms: number;
  /** The program could not start. */
  error?: Error;
}

export interface ShellHandle {
  write(text: string): boolean;
  end(): void;
  kill(reason?: 'killed' | 'timeout'): void;
  readonly running: boolean;
  done: Promise<ShellExit>;
}

/** The shell program and the arguments before the command, from `advanced.shell.command` or the platform. */
export function shellFor(
  command: string | undefined,
  platform = process.platform,
): { command: string; args: string[] } {
  const program = command ?? (platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash');
  if (/(^|[\\/])(powershell|pwsh)(\.exe)?$/i.test(program)) {
    return { command: program, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'] };
  }
  if (/(^|[\\/])cmd(\.exe)?$/i.test(program)) return { command: program, args: ['/d', '/s', '/c'] };
  return { command: program, args: ['-c'] };
}

/**
 * Runs a command and streams its output. On POSIX it runs in its own process group, so Kill stops the
 * command and everything it started (a shell's `sleep 60` child would otherwise hold the pipes for a
 * minute); on Windows `taskkill /T` does the same.
 */
export function runShell(
  command: string,
  onData: (chunk: string, stream: 'stdout' | 'stderr') => void,
  options: {
    shell?: { command: string; args: string[] };
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): ShellHandle {
  const isWindows = process.platform === 'win32';
  const shell = options.shell ?? shellFor(undefined);
  const started = performance.now();
  let killed = false;
  let timedOut = false;
  let exited = false;
  let finished = false;
  let resolveDone!: (exit: ShellExit) => void;
  const done = new Promise<ShellExit>((resolve) => (resolveDone = resolve));
  const timers: NodeJS.Timeout[] = [];
  const later = (ms: number, run: () => void) => timers.push(setTimeout(run, ms).unref());

  const child: ChildProcess = spawn(shell.command, [...shell.args, command], {
    cwd: options.cwd,
    env: { FORCE_COLOR: '1', ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: !isWindows,
    windowsHide: true,
  });
  child.stdout?.setEncoding('utf8').on('data', (c: string) => onData(c, 'stdout'));
  child.stderr?.setEncoding('utf8').on('data', (c: string) => onData(c, 'stderr'));
  child.stdin?.on('error', () => undefined);

  const finish = (exit: Pick<ShellExit, 'code' | 'signal' | 'error'>) => {
    if (finished) return;
    finished = true;
    for (const timer of timers) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    resolveDone({ ...exit, killed, timedOut, ms: performance.now() - started });
  };

  // Without this, `done` would wait for any grandchild that still holds the pipes
  const destroyPipes = () => {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.stdin?.destroy();
  };

  const signalTree = (sig: NodeJS.Signals) => {
    if (!child.pid) return;
    if (isWindows) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on(
        'error',
        () => undefined,
      );
      return;
    }
    try {
      process.kill(-child.pid, sig);
    } catch {
      // The group is already gone
    }
  };

  const kill = (reason: 'killed' | 'timeout' = 'killed') => {
    if (finished || killed) return;
    killed = true;
    timedOut = reason === 'timeout';
    signalTree('SIGTERM');
    later(1_500, () => {
      signalTree('SIGKILL');
      later(500, () => {
        destroyPipes();
        finish({ code: child.exitCode, signal: 'SIGKILL' });
      });
    });
  };

  if (options.timeoutMs) later(options.timeoutMs, () => kill('timeout'));
  const onAbort = () => kill();
  if (options.signal?.aborted) queueMicrotask(onAbort);
  else options.signal?.addEventListener('abort', onAbort, { once: true });

  child.on('error', (error) => {
    onData(`${error.message}\n`, 'stderr');
    destroyPipes();
    finish({ code: null, signal: null, error });
  });

  child.on('exit', (code, signal) => {
    exited = true;
    if (killed) {
      if (!isWindows) signalTree('SIGKILL');
      destroyPipes();
      finish({ code, signal });
      return;
    }
    // Background jobs can keep the pipes open after a normal exit
    later(2_000, () => {
      destroyPipes();
      finish({ code, signal });
    });
  });

  child.on('close', (code, signal) => finish({ code, signal }));

  return {
    write: (text) => {
      const stdin = child.stdin;
      return Boolean(stdin && !stdin.destroyed && !stdin.writableEnded && !finished && stdin.write(text));
    },
    end: () => child.stdin?.end(),
    kill,
    get running() {
      return !finished && !exited;
    },
    done,
  };
}

/** `exit 0`, `exit 1 · [killed]`, `[timed out after 5m 00s]`. */
export function exitNote(exit: ShellExit, timeoutText?: string): string {
  if (exit.error) return `[failed to start: ${exit.error.message}]`;
  if (exit.timedOut) return `[timed out${timeoutText ? ` after ${timeoutText}` : ''}]`;
  const code = exit.code === null ? (exit.signal ?? 'signal') : `exit ${exit.code}`;
  return exit.killed ? `${code} · [killed]` : code;
}

/** The last `count` lines of a file (reads at most its last 64 KB). */
export async function lastLines(path: string, count: number): Promise<{ text: string; size: number }> {
  const info = await stat(path);
  if (!info.isFile()) throw new ByakuError('NOT_A_FILE', `${path} is not a file`);
  if (count <= 0) return { text: '', size: info.size };
  const length = Math.min(info.size, 64 * 1024);
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, info.size - length);
    const lines = buf.toString('utf8').split('\n');
    if (length < info.size) lines.shift();
    if (lines.at(-1) === '') lines.pop();
    return { text: lines.slice(-count).join('\n') + (lines.length ? '\n' : ''), size: info.size };
  } finally {
    await handle.close();
  }
}

/**
 * Follows a file like `tail -f`: the last lines first, then text as it is appended. Polls (fs.watch is
 * unreliable across platforms) and handles truncation and log rotation. Resolves when `signal` aborts.
 */
export async function followFile(
  path: string,
  onData: (chunk: string) => void,
  options: { lines?: number; pollMs?: number; signal?: AbortSignal } = {},
): Promise<{ reason: 'aborted' | 'error'; error?: Error }> {
  const first = await lastLines(path, options.lines ?? 20);
  if (first.text) onData(first.text);
  let offset = first.size;
  let inode = (await stat(path)).ino;

  return new Promise((resolve) => {
    let busy = false;
    const stop = (result: { reason: 'aborted' | 'error'; error?: Error }) => {
      clearInterval(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const check = async () => {
      if (busy) return;
      busy = true;
      try {
        const info = await stat(path);
        if (info.ino !== inode || info.size < offset) {
          inode = info.ino;
          offset = 0;
          onData('\n[file was truncated or replaced]\n');
        }
        if (info.size > offset) {
          const length = Math.min(info.size - offset, 256 * 1024);
          const handle = await open(path, 'r');
          try {
            const { bytesRead, buffer } = await handle.read(Buffer.alloc(length), 0, length, offset);
            offset += bytesRead;
            if (bytesRead) onData(buffer.subarray(0, bytesRead).toString('utf8'));
          } finally {
            await handle.close();
          }
        }
      } catch (err) {
        stop({ reason: 'error', error: err as Error });
      } finally {
        busy = false;
      }
    };

    const timer = setInterval(() => void check(), options.pollMs ?? 500);
    const onAbort = () => stop({ reason: 'aborted' });
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}
