import type { ByakuMode } from './modes/index.js';
import type { ConfirmRule } from './parse.js';
import type { Transpiler } from './runners.js';
import type { SessionStore } from './session.js';

type Awaitable<T> = T | Promise<T>;

export type ByakuErrorCode =
  | 'INVALID_OPTION'
  | 'INVALID_DURATION'
  | 'INVALID_MODE'
  | 'EXPLORER'
  | 'TRANSPILER_MISSING'
  | 'NOT_A_FILE'
  | 'CUSTOM_ID_TOO_LONG';

/** The one error type Byaku throws. */
export class ByakuError extends Error {
  override name = 'ByakuError';

  constructor(
    readonly code: ByakuErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Milliseconds, or text such as `'500ms'`, `'2s'`, `'15m'`, `'1h30m'`. */
export type Duration = number | string;

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  sec: 1_000,
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDuration(input: Duration): number {
  if (typeof input === 'number') {
    if (Number.isFinite(input) && input >= 0) return input;
    throw new ByakuError('INVALID_DURATION', `Invalid duration: ${input}`);
  }
  const text = input.trim().toLowerCase();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (!/^(?:\d+(?:\.\d+)?\s*(?:ms|sec|min|s|m|h|d)\s*)+$/.test(text)) {
    throw new ByakuError('INVALID_DURATION', `Invalid duration: "${input}" (use e.g. "500ms", "2s", "15m")`);
  }
  let total = 0;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(ms|sec|min|s|m|h|d)/g))
    total += Number(m[1]) * (UNITS[m[2] ?? ''] ?? 0);
  return total;
}

/** One entry per action: runs, re-runs, button presses, kills, refusals. */
export interface AuditEntry {
  at: number;
  action: string;
  mode?: string;
  userId: string;
  guildId?: string;
  channelId?: string;
  sessionId?: string;
  codeLength?: number;
  outcome: 'ok' | 'error' | 'denied' | 'killed' | 'timeout' | 'cancelled';
  durationMs?: number;
  unsafe?: boolean;
  /** Redacted. */
  error?: string;
  details?: Record<string, string | number | boolean>;
}

export interface SqlAdapter {
  query(sql: string): Awaitable<unknown>;
}

export interface RedisAdapter {
  command(args: string[]): Awaitable<unknown>;
}

export interface ByakuOptions {
  /** User IDs allowed to use Byaku, besides the application owner and team. */
  owners?: string[];
  /** Extra triggers such as `'?by'`. `<bot prefix>byaku`, `<bot prefix>by` and mentions always work. */
  prefixes?: string[];
  /** Values never shown. The bot token is always hidden. */
  secrets?: (string | undefined | null)[];
  /** Extra variables for eval. */
  scope?: Record<string, unknown>;
  audit?: (entry: AuditEntry) => unknown;
  modes?: ByakuMode[];
  /** Adds the owner-only `/byaku` command. */
  slash?: boolean | { guilds?: string[] };
  /** Rarely needed. */
  advanced?: {
    /** Default true. */
    enabled?: boolean;
    /** Allow the application owner or team members. Default true. */
    includeAppOwners?: boolean;
    /** Reserve triggers through shouldSkipMessageCommand() in your command router. Default true. */
    prefixGuard?: boolean;
    timeouts?: { session?: Duration; shell?: Duration; editRerun?: Duration };
    limits?: { pageSize?: number; catBytes?: number; curlBytes?: number };
    shell?: { command?: string; cwd?: string; env?: Record<string, string> };
    store?: SessionStore;
    adapters?: { sql?: SqlAdapter; redis?: RedisAdapter };
    transpile?: Transpiler;
    /** Extra input that asks for Confirm first (added to the built-in rules). */
    confirm?: ConfirmRule[];
  };
}

export interface ResolvedOptions {
  enabled: boolean;
  owners: ReadonlySet<string>;
  includeAppOwners: boolean;
  prefixes: readonly string[];
  secrets: readonly string[];
  scope: Record<string, unknown>;
  audit: ((entry: AuditEntry) => unknown) | undefined;
  modes: readonly ByakuMode[];
  slash: { guilds?: string[] } | undefined;
  prefixGuard: boolean;
  sessionTtlMs: number;
  shellTimeoutMs: number;
  editRerunMs: number;
  limits: { pageSize: number; catBytes: number; curlBytes: number };
  shell: { command?: string; cwd?: string; env?: Record<string, string> };
  store: SessionStore | undefined;
  adapters: { sql?: SqlAdapter; redis?: RedisAdapter };
  transpile: Transpiler | undefined;
  confirm: readonly ConfirmRule[];
}

const SHAPE = {
  owners: 'string[]',
  prefixes: 'string[]',
  secrets: 'secrets',
  scope: 'object',
  audit: 'function',
  modes: 'array',
  slash: 'slash',
  advanced: {
    enabled: 'boolean',
    includeAppOwners: 'boolean',
    prefixGuard: 'boolean',
    timeouts: { session: 'duration', shell: 'duration', editRerun: 'duration' },
    limits: { pageSize: 'number', catBytes: 'number', curlBytes: 'number' },
    shell: { command: 'string', cwd: 'string', env: 'object' },
    store: 'object',
    adapters: { sql: 'object', redis: 'object' },
    transpile: 'function',
    confirm: 'array',
  },
} as const;

type Shape = { readonly [key: string]: string | Shape };

function check(value: unknown, shape: Shape, path: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ByakuError('INVALID_OPTION', `${path || 'options'} must be an object`);
  }
  for (const [key, child] of Object.entries(value)) {
    const where = path ? `${path}.${key}` : key;
    const expected = shape[key];
    if (expected === undefined) {
      const known = Object.keys(shape).join(', ');
      throw new ByakuError('INVALID_OPTION', `Unknown option "${where}". Known options here: ${known}`);
    }
    if (child === undefined) continue;
    if (typeof expected === 'object') {
      check(child, expected, where);
      continue;
    }
    const fail = (why: string) => new ByakuError('INVALID_OPTION', `Option "${where}" ${why}`);
    switch (expected) {
      case 'string[]':
        if (!Array.isArray(child) || child.some((s) => typeof s !== 'string' || !s.trim())) {
          throw fail('must be an array of non-empty strings');
        }
        break;
      case 'secrets':
        if (!Array.isArray(child) || child.some((s) => s != null && typeof s !== 'string')) {
          throw fail('must be an array of strings (undefined entries are ignored)');
        }
        break;
      case 'slash':
        if (typeof child !== 'boolean') check(child, { guilds: 'string[]' }, where);
        break;
      case 'duration':
        try {
          parseDuration(child as Duration);
        } catch (err) {
          throw fail(`is not a duration: ${(err as Error).message}`);
        }
        break;
      case 'array':
        if (!Array.isArray(child)) throw fail('must be an array');
        break;
      case 'object':
        if (typeof child !== 'object' || child === null) throw fail('must be an object');
        break;
      case 'number':
        if (typeof child !== 'number' || !Number.isFinite(child) || child <= 0) throw fail('must be a positive number');
        break;
      default:
        if (typeof child !== expected) throw fail(`must be a ${expected}`);
    }
  }
}

/** Validates options and fills in defaults. Throws a {@link ByakuError} naming the bad option. */
export function resolveOptions(options: ByakuOptions = {}): ResolvedOptions {
  check(options, SHAPE, '');
  const advanced = options.advanced ?? {};
  const pageSize = advanced.limits?.pageSize ?? 1_850;
  if (pageSize < 100 || pageSize > 1_900) {
    throw new ByakuError('INVALID_OPTION', 'Option "advanced.limits.pageSize" must be between 100 and 1900');
  }

  return {
    enabled: advanced.enabled ?? true,
    owners: new Set(options.owners),
    includeAppOwners: advanced.includeAppOwners ?? true,
    prefixes: (options.prefixes ?? []).map((p) => p.trim()),
    secrets: (options.secrets ?? []).filter((s): s is string => typeof s === 'string'),
    scope: options.scope ?? {},
    audit: options.audit,
    modes: options.modes ?? [],
    slash: options.slash ? (typeof options.slash === 'object' ? options.slash : {}) : undefined,
    prefixGuard: advanced.prefixGuard ?? true,
    sessionTtlMs: parseDuration(advanced.timeouts?.session ?? '15m'),
    shellTimeoutMs: parseDuration(advanced.timeouts?.shell ?? '5m'),
    editRerunMs: parseDuration(advanced.timeouts?.editRerun ?? '5m'),
    limits: {
      pageSize,
      catBytes: advanced.limits?.catBytes ?? 1_048_576,
      curlBytes: advanced.limits?.curlBytes ?? 2_097_152,
    },
    shell: advanced.shell ?? {},
    store: advanced.store,
    adapters: advanced.adapters ?? {},
    transpile: advanced.transpile,
    confirm: advanced.confirm ?? [],
  };
}

/** Kept equal to package.json by a test. */
export const VERSION = '1.0.0';
