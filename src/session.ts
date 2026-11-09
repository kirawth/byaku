import { randomBytes } from 'node:crypto';

import type { PathStep } from './inspect.js';
import type { Flags } from './parse.js';

type Awaitable<T> = T | Promise<T>;

export type LiveKind = 'shell' | 'watch' | 'top' | 'events' | 'rest' | 'tail' | 'bench';

/**
 * One console run: input, output, view state and the messages it belongs to. Plain JSON data, so a
 * {@link SessionStore} can keep it anywhere.
 */
export interface Session {
  id: string;
  ownerId: string;
  mode: string;
  /** Code or arguments, outer fence removed. */
  input: string;
  flags: Flags;
  channelId: string;
  guildId?: string;
  /** The owner's message (prefix trigger). */
  triggerId?: string;
  replyId?: string;
  /** Latest interaction token; ephemeral replies can only be edited through it. */
  interactionToken?: string;
  ephemeral?: boolean;
  createdAt: number;
  expiresAt: number;
  pinned: boolean;
  output: string;
  /** Output before the last re-run, for the Diff button. */
  previousOutput?: string;
  ok: boolean;
  ms: number;
  pages: string[];
  page: number;
  lang: string;
  view: { depth: number; hidden: boolean; getters: boolean; path: PathStep[]; keyPage: number };
  live?: { kind: LiveKind; paused: boolean; startedAt: number };
  /** Free-form data for modes. */
  data: Record<string, unknown>;
}

/** Where sessions are kept. The default keeps them in memory; implement this to keep them in Redis or similar. */
export interface SessionStore {
  get(id: string): Awaitable<Session | undefined>;
  set(session: Session): Awaitable<void>;
  delete(id: string): Awaitable<void>;
  findByTrigger(messageId: string): Awaitable<Session | undefined>;
  list(): Awaitable<Session[]>;
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly byTrigger = new Map<string, string>();

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  set(session: Session): void {
    const old = this.sessions.get(session.id);
    if (old?.triggerId && old.triggerId !== session.triggerId) this.byTrigger.delete(old.triggerId);
    this.sessions.set(session.id, session);
    if (session.triggerId) this.byTrigger.set(session.triggerId, session.id);
  }

  delete(id: string): void {
    const old = this.sessions.get(id);
    if (old?.triggerId && this.byTrigger.get(old.triggerId) === id) this.byTrigger.delete(old.triggerId);
    this.sessions.delete(id);
  }

  findByTrigger(messageId: string): Session | undefined {
    const id = this.byTrigger.get(messageId);
    return id ? this.sessions.get(id) : undefined;
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }
}

/** What can't be stored: the kept JS value and the abort controller of running work. */
interface LiveState {
  abort: AbortController;
  value?: unknown;
  hasValue: boolean;
}

export function newSessionId(): string {
  return BigInt(`0x${randomBytes(8).toString('hex')}`)
    .toString(36)
    .padStart(10, '0')
    .slice(-10);
}

export class SessionManager {
  readonly store: SessionStore;
  private readonly states = new Map<string, LiveState>();
  private readonly ttlMs: number;
  private readonly onExpire: ((session: Session) => unknown) | undefined;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: {
    ttlMs: number;
    store?: SessionStore;
    onExpire?: (session: Session) => unknown;
    now?: () => number;
  }) {
    this.store = options.store ?? new MemorySessionStore();
    this.ttlMs = options.ttlMs;
    this.onExpire = options.onExpire;
    this.now = options.now ?? Date.now;
  }

  async create(init: Pick<Session, 'ownerId' | 'mode' | 'input' | 'channelId'> & Partial<Session>): Promise<Session> {
    const now = this.now();
    const session: Session = {
      flags: {},
      createdAt: now,
      pinned: false,
      output: '',
      ok: true,
      ms: 0,
      pages: [''],
      page: 0,
      lang: 'txt',
      data: {},
      ...init,
      view: { depth: 1, hidden: false, getters: false, path: [], keyPage: 0, ...init.view },
      id: newSessionId(),
      expiresAt: now + this.ttlMs,
    };
    await this.store.set(session);
    return session;
  }

  /** A running shell or bench has its own timeout; watch, top and the other live views end with the session. */
  isExpired(session: Session): boolean {
    if (session.pinned || session.live?.kind === 'shell' || session.live?.kind === 'bench') return false;
    return session.expiresAt <= this.now();
  }

  async get(id: string): Promise<Session | undefined> {
    return this.unlessExpired(await this.store.get(id));
  }

  async findByTrigger(messageId: string): Promise<Session | undefined> {
    return this.unlessExpired(await this.store.findByTrigger(messageId));
  }

  private async unlessExpired(session: Session | undefined): Promise<Session | undefined> {
    if (session && this.isExpired(session)) {
      await this.end(session.id);
      return undefined;
    }
    return session;
  }

  /** Saves and refreshes the expiry time. */
  async touch(session: Session): Promise<Session> {
    session.expiresAt = this.now() + this.ttlMs;
    await this.store.set(session);
    return session;
  }

  async save(session: Session): Promise<void> {
    await this.store.set(session);
  }

  async pin(session: Session, pinned: boolean): Promise<Session> {
    session.pinned = pinned;
    return this.touch(session);
  }

  async end(id: string, reason = 'session ended'): Promise<Session | undefined> {
    const session = await this.store.get(id);
    await this.store.delete(id);
    this.states.get(id)?.abort.abort(new Error(reason));
    this.states.delete(id);
    return session;
  }

  async sweep(): Promise<number> {
    let ended = 0;
    for (const session of await this.store.list()) {
      if (!this.isExpired(session)) continue;
      await this.end(session.id, 'session expired');
      ended++;
      // Best effort: the message may already be gone
      await Promise.resolve(this.onExpire?.(session)).catch(() => undefined);
    }
    return ended;
  }

  start(): void {
    this.timer ??= setInterval(() => void this.sweep().catch(() => undefined), 30_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const session of await this.store.list()) await this.end(session.id, 'Byaku stopped');
  }

  /** The live state of a session, created on first use. */
  live(id: string): LiveState {
    let state = this.states.get(id);
    if (!state) {
      state = { abort: new AbortController(), hasValue: false };
      this.states.set(id, state);
    }
    return state;
  }

  peekLive(id: string): LiveState | undefined {
    return this.states.get(id);
  }

  keepValue(id: string, value: unknown): void {
    Object.assign(this.live(id), { value, hasValue: true });
  }

  /** A fresh abort controller for a new run; the old run is aborted. */
  renewAbort(id: string): AbortController {
    const state = this.live(id);
    state.abort.abort(new Error('restarted'));
    state.abort = new AbortController();
    return state.abort;
  }
}

/** How long to wait after a Discord rate limit error, or `undefined` if it is not one. */
export function retryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  const response = e.response as Record<string, unknown> | undefined;
  const body = (e.body ?? e.rawError ?? e.data ?? response) as Record<string, unknown> | undefined;
  const retry = e.retry_after ?? e.retryAfter ?? body?.retry_after ?? body?.retryAfter;
  const status = e.status ?? e.code ?? response?.status;
  if (status !== 429 && retry === undefined && !/\b429\b|rate ?limit/i.test(String(e.message ?? ''))) return undefined;
  // Discord sends seconds with decimals
  const seconds = Number(retry);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 1_000;
}

/**
 * Turns frequent updates into few message edits: at most one per interval, never two at the same time,
 * always ending with the newest content, and waiting `retry_after` on a 429.
 */
export class LiveEditor<T> {
  edits = 0;
  private pending: { value: T } | undefined;
  private inFlight: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastEdit = -Infinity;
  private blockedUntil = 0;
  private closed = false;

  constructor(
    private readonly send: (value: T) => Promise<unknown>,
    private readonly options: { intervalMs?: number; onError?: (err: unknown) => void } = {},
  ) {}

  update(value: T): void {
    if (this.closed) return;
    this.pending = { value };
    this.schedule();
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (let i = 0; i < 5; i++) {
      await this.inFlight;
      if (!this.pending) return;
      const wait = this.blockedUntil - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      await this.run();
    }
  }

  close(): void {
    this.closed = true;
    this.pending = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.timer || this.inFlight || !this.pending) return;
    const now = Date.now();
    const wait = Math.max(0, this.lastEdit + (this.options.intervalMs ?? 1_200) - now, this.blockedUntil - now);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.run();
    }, wait);
    this.timer.unref();
  }

  private async run(): Promise<void> {
    if (this.inFlight || !this.pending) return;
    const { value } = this.pending;
    this.pending = undefined;
    this.lastEdit = Date.now();
    this.inFlight = this.send(value).then(
      () => void this.edits++,
      (err: unknown) => {
        const wait = retryAfterMs(err);
        if (wait === undefined) return this.options.onError?.(err);
        this.blockedUntil = Date.now() + wait;
        this.pending ??= { value };
      },
    );
    await this.inFlight;
    this.inFlight = undefined;
    this.schedule();
  }
}
