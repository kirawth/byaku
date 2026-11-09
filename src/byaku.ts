import { createRequire } from 'node:module';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  type Client,
  type CommandContext,
  type GatewayDispatchPayload,
  type GatewayMessageCreateDispatchData,
  type MessageData,
  type MessageFlags,
  type MessageStructure,
  type ModalContext,
  Transformers,
  type UsingClient,
} from 'seyfert';

import {
  createHandlerClasses,
  createSlashCommand,
  type ByakuHandlerClasses,
  handlerOwner,
  isByakuHandler,
} from './handlers.js';
import {
  errorMessage,
  formatError,
  formatValue,
  listEntries,
  MAX_DEPTH,
  resolvePath,
  type ExplorerEntry,
} from './inspect.js';
import {
  builtinModes,
  type ByakuMode,
  type LiveHandle,
  type LiveOptions,
  ModeRegistry,
  type ModeReturn,
} from './modes/index.js';
import { type AuditEntry, ByakuError, type ByakuOptions, type ResolvedOptions, resolveOptions } from './options.js';
import { escapeFences, paginate, Redactor, secretsFromEnv, truncate } from './output.js';
import {
  boolFlag,
  buildTriggers,
  DEFAULT_CONFIRM_RULES,
  findRiskyRule,
  matchTrigger,
  numberFlag,
  parseInput,
} from './parse.js';
import type { ByakuPluginBridge } from './plugin.js';
import { JsRunner } from './runners.js';
import { LiveEditor, newSessionId, type Session, SessionManager } from './session.js';
import { type ByakuBody, parseCustomId, renderSession } from './view.js';
import {
  askAllWorkers,
  askWorker,
  type BridgeHandler,
  type BridgeRequest,
  installBridge,
  uninstallBridge,
  type WorkerResult,
} from './workers.js';

/** The gateway message fields Byaku reads. */
export interface RawMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  content?: string;
  author?: { id: string; bot?: boolean };
  webhook_id?: string;
}

type PrefixFn = (message: MessageStructure) => string[] | Promise<string[]>;

// Client and WorkerClient members that `UsingClient` (a BaseClient) doesn't declare
type GatewayClient = UsingClient & {
  collectors: Client['collectors'];
  latency: number;
  options: { commands?: { prefix?: PrefixFn } };
};

/** @internal How the first reply of a run goes out. */
export type Delivery =
  | { kind: 'reply'; triggerId?: string }
  | { kind: 'context'; ctx: CommandContext }
  | { kind: 'modal'; ctx: ModalContext }
  | { kind: 'edit' };

/** @internal */
export interface RunRequest {
  ownerId: string;
  channelId: string;
  guildId?: string;
  triggerId?: string;
  text: string;
  delivery: Delivery;
  message?: MessageStructure;
  interaction?: CommandContext;
  existing?: Session;
  ephemeral?: boolean;
  interactionToken?: string;
  skipConfirm?: boolean;
  action?: 'run' | 'rerun' | 'edit-run' | 'confirm';
}

/** The client with `byaku` attached, for bots that use `install()` instead of the plugin. */
export type ByakuClient<C extends UsingClient = UsingClient> = C & { byaku: Byaku };

// Trigger names after the bot's own prefix
const NAMES = ['byaku', 'by'];
// Interaction tokens last 15 minutes
const TOKEN_TTL_MS = 14 * 60_000;
const APP_OWNERS_TTL_MS = 10 * 60_000;
const WORKER_TIMEOUT_MS = 10_000;

const SYNTHETIC = Symbol.for('byaku.synthetic');
const synthetic = new WeakSet<object>();
const installedInstances = new WeakMap<object, Set<Byaku>>();

/** @internal Copies raw message data with changed content, author or channel, marked so Byaku's own trigger ignores it. */
export function syntheticMessage<T extends object>(
  base: T,
  changes: { content: string; author?: unknown; channelId?: string },
): T {
  const copy: Record<string | symbol, unknown> = { ...base, content: changes.content };
  if (changes.author) copy.author = changes.author;
  if (changes.channelId) copy.channel_id = changes.channelId;
  Object.defineProperty(copy, SYNTHETIC, { value: true });
  synthetic.add(copy);
  return copy as T;
}

function isSynthetic(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (synthetic.has(value) || SYNTHETIC in value);
}

/**
 * An owner-only developer console for a Seyfert bot.
 *
 * @example
 * const byaku = new Byaku(client, { owners: ['123456789012345678'] });
 * await byaku.install();
 */
export class Byaku {
  readonly client: UsingClient;
  /** @internal */
  readonly options: ResolvedOptions;
  /** @internal */
  readonly sessions: SessionManager;
  /** @internal */
  readonly js: JsRunner;
  /** @internal */
  readonly registry = new ModeRegistry();
  /** @internal */
  readonly redactor: Redactor;
  /** @internal Set by `byakuPlugin()`. */
  plugin: ByakuPluginBridge | undefined;
  /** @internal Running live views by session id. */
  readonly lives = new Map<string, { editor: LiveEditor<ByakuBody>; options: LiveOptions }>();

  private readonly sessionPrefix = `${newSessionId()}-`;
  private enabledFlag: boolean;
  private installed = false;
  private stopCollector: (() => void) | undefined;
  private collectorPending = false;
  private classes: ByakuHandlerClasses | undefined;
  private bridge: BridgeHandler | undefined;
  private appOwners = new Set<string>();
  private appOwnersAt = 0;
  private appOwnersRequest: Promise<void> | undefined;
  private requireFromBot: NodeJS.Require | undefined;

  constructor(client: UsingClient, options: ByakuOptions = {}) {
    this.client = client;
    this.options = resolveOptions(options);
    this.enabledFlag = this.options.enabled;
    this.redactor = new Redactor([...this.options.secrets, ...secretsFromEnv()]);
    this.sessions = new SessionManager({
      idPrefix: this.sessionPrefix,
      ttlMs: this.options.sessionTtlMs,
      ...(this.options.store ? { store: this.options.store } : {}),
      onExpire: (session) => this.onExpire(session),
    });
    this.js = new JsRunner({ ttlMs: this.options.sessionTtlMs });
    this.registry.register(...builtinModes, ...this.options.modes);
  }

  /** @internal Whether lifecycle-managed handlers may run. */
  get isInstalled(): boolean {
    return this.installed;
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  enable(): void {
    this.enabledFlag = true;
  }

  disable(): void {
    this.enabledFlag = false;
  }

  /** Adds modes; a mode replaces a built-in one with the same name. */
  register(...modes: ByakuMode[]): this {
    this.registry.register(...modes);
    return this;
  }

  /**
   * Connects Byaku to the client: a raw gateway listener (your `messageCreate` keeps working), the buttons
   * and modals (next to yours), the worker bridge and `/byaku` if `slash` is set.
   * Use `shouldSkipMessageCommand()` in your command router to reserve Byaku triggers.
   * Without `byakuPlugin()`, call this after `client.start()` so file loading doesn't replace `/byaku`.
   */
  async install(): Promise<void> {
    if (this.installed) return;
    this.installed = true;
    const client = this.client as GatewayClient;

    const instances = installedInstances.get(client) ?? new Set<Byaku>();
    instances.add(this);
    installedInstances.set(client, instances);

    if (this.plugin) {
      this.stopCollector = this.plugin.onDispatch((packet) => {
        if (packet.client === this.client) this.handleDispatch(packet);
      });
    } else {
      // 5.2.0 only exposes a collector's stop callback when it runs. Reuse a pending collector on reinstall.
      if (!this.collectorPending) {
        this.collectorPending = true;
        client.collectors.create({
          event: 'raw',
          filter: () => true,
          run: (packet, stop) => {
            this.stopCollector = () => {
              stop();
              this.collectorPending = false;
              this.stopCollector = undefined;
            };
            if (!this.installed) this.stopCollector();
            else this.handleDispatch(packet);
          },
        });
      }
      const { ByakuButtons, ByakuSelects, ByakuModal } = this.handlerClasses;
      const missing = [ByakuButtons, ByakuSelects, ByakuModal].filter(
        (Handler) => !client.components.commands.some((handler) => handler instanceof Handler),
      );
      client.components.set(missing);
    }
    if (!this.plugin && this.options.slash && !client.commands.values.some(isByakuHandler)) {
      const command = new (createSlashCommand(this))();
      if (this.options.slash.guilds) command.guildId = [...this.options.slash.guilds];
      client.commands.set([command]);
    }

    this.bridge = (request) => this.answerBridge(request);
    installBridge(this.bridge);
    this.sessions.start();
    void this.refreshAppOwners();
  }

  /** Stops listening, kills running work and deactivates handlers. Plugin contributions are removed on client close. */
  async uninstall(): Promise<void> {
    if (!this.installed) return;
    this.installed = false;
    this.stopCollector?.();
    this.stopCollector = undefined;
    installedInstances.get(this.client)?.delete(this);
    if (this.bridge) uninstallBridge(this.bridge);
    for (const { editor } of this.lives.values()) editor.close();
    this.lives.clear();
    await this.sessions.stop();
  }

  /** @internal Routes a packet without awaiting long-running work in the gateway. */
  // Seyfert doesn't await raw dispatch listeners, so a long run never holds up the bot's own handling
  private handleDispatch(packet: GatewayDispatchPayload): void {
    if (!this.installed) return;
    let task: Promise<boolean>;
    switch (packet.t) {
      case 'MESSAGE_CREATE':
        task = this.handleRaw(packet.d);
        break;
      case 'MESSAGE_UPDATE':
        task = this.handleRawUpdate(packet.d);
        break;
      case 'MESSAGE_DELETE':
        task = this.handleRawDelete(packet.d);
        break;
      default:
        return;
    }
    void task.catch((err: unknown) => this.client.logger.error('[byaku]', err));
  }

  /** @internal Keep shared custom ids from being answered by another installed instance. */
  async acceptsInteraction(customId: string): Promise<boolean> {
    if (!this.installed) return false;
    const id = parseCustomId(customId);
    if (!id) return false;
    const instances = installedInstances.get(this.client);
    if (!instances) return false;
    if (id.sid === 'new') {
      const owner = this.client.commands.values.map(handlerOwner).find((owner) => owner !== undefined);
      if (owner) return owner === this;
    } else {
      for (const instance of instances) {
        if (id.sid.startsWith(instance.sessionPrefix)) return instance === this;
      }
      for (const instance of instances) {
        if (await instance.sessions.get(id.sid)) return instance === this;
      }
    }
    // Legacy controls have no instance prefix. Keep their single-instance fallback.
    return !id.sid.includes('-') && instances.values().next().value === this;
  }

  /**
   * Call before your command handler parses a gateway message. A true result reserves the message for
   * Byaku's installed listener; it does not execute code or suppress gateway events and collectors.
   * `advanced.prefixGuard: false`, disabled and uninstalled instances always return false.
   */
  async shouldSkipMessageCommand(raw: RawMessage): Promise<boolean> {
    return (
      this.installed &&
      this.enabledFlag &&
      this.options.prefixGuard &&
      (await this.triggerText(raw, undefined, true)) !== undefined
    );
  }

  /** For bots that route messages themselves. Resolves to true when the message was a Byaku trigger. */
  async handleMessage(message: MessageStructure): Promise<boolean> {
    const raw: RawMessage = {
      id: message.id,
      channel_id: message.channelId,
      content: message.content,
      author: message.author,
      ...(message.guildId ? { guild_id: message.guildId } : {}),
      ...(message.webhookId ? { webhook_id: message.webhookId } : {}),
    };
    return this.handleRaw(raw, message);
  }

  /** @internal */
  get handlerClasses(): ByakuHandlerClasses {
    this.classes ??= createHandlerClasses(this);
    return this.classes;
  }

  /** @internal Configured owners, plus the application owner or team (fetched every 10 minutes). */
  async isOwner(userId: string): Promise<boolean> {
    if (this.options.owners.has(userId)) return true;
    if (!this.options.includeAppOwners) return false;
    await this.refreshAppOwners();
    return this.appOwners.has(userId);
  }

  private async refreshAppOwners(): Promise<void> {
    if (!this.options.includeAppOwners || Date.now() - this.appOwnersAt < APP_OWNERS_TTL_MS) return;
    this.appOwnersRequest ??= this.client.proxy
      .applications('@me')
      .get()
      .then(
        (app) => {
          const team = app.team;
          this.appOwners = new Set(
            team ? [...team.members.map((m) => m.user.id), team.owner_user_id] : app.owner ? [app.owner.id] : [],
          );
          this.appOwnersAt = Date.now();
        },
        // Retry in a minute rather than on every message
        () => void (this.appOwnersAt = Date.now() - APP_OWNERS_TTL_MS + 60_000),
      )
      .finally(() => (this.appOwnersRequest = undefined));
    await this.appOwnersRequest;
  }

  private match(content: string, botPrefixes: readonly string[]): string | undefined {
    const triggers = buildTriggers({
      prefixes: this.options.prefixes,
      botPrefixes,
      names: NAMES,
      botId: this.client.botId || undefined,
    });
    return matchTrigger(content, triggers);
  }

  /** @internal The text after a Byaku trigger, or `undefined`. */
  async triggerText(raw: RawMessage, message?: MessageStructure, fromCommand = false): Promise<string | undefined> {
    const content = raw.content ?? '';
    if (!content) return undefined;
    const quick = this.match(content, []);
    const commandAnswers =
      !fromCommand && !this.options.prefixGuard && this.client.commands.values.some(isByakuHandler);
    // Fixed prefixes and mentions need no prefix lookup unless a loaded ByakuCommand might own this message.
    if (quick !== undefined && !commandAnswers) return quick;
    const prefix = (this.client as GatewayClient).options.commands?.prefix;
    if (!prefix) return quick;
    try {
      const prefixes = await prefix(message ?? Transformers.Message(this.client, raw as MessageData));
      if (commandAnswers) {
        const matched = [...prefixes].sort((a, b) => b.length - a.length).find((p) => content.startsWith(p));
        if (matched !== undefined) {
          const resolved = this.client.handleCommand.resolveCommandFromContent(
            content.slice(matched.length).trimStart(),
            matched,
            // RawMessage keeps the public partial-input contract; gateway dispatches supply the complete payload.
            raw as GatewayMessageCreateDispatchData,
          );
          if (resolved.command && isByakuHandler(resolved.command)) return undefined;
        }
      }
      return quick ?? this.match(content, prefixes);
    } catch {
      return quick;
    }
  }

  /** @internal A new gateway message. */
  async handleRaw(raw: RawMessage, message?: MessageStructure): Promise<boolean> {
    if (!this.enabledFlag || isSynthetic(raw) || !raw.author || raw.author.bot || raw.webhook_id) return false;
    const text = await this.triggerText(raw, message);
    if (text === undefined) return false;

    const where = { channelId: raw.channel_id, ...(raw.guild_id ? { guildId: raw.guild_id } : {}) };
    if (!(await this.isOwner(raw.author.id))) {
      // Non-owners get no reply: Byaku stays invisible
      this.audit({ action: 'denied', userId: raw.author.id, outcome: 'denied', ...where });
      return true;
    }

    await this.run({
      ownerId: raw.author.id,
      ...where,
      triggerId: raw.id,
      text,
      // Keep the public partial raw-message contract; the gateway provides Seyfert's full payload.
      message: message ?? Transformers.Message(this.client, raw as MessageData),
      delivery: { kind: 'reply', triggerId: raw.id },
    });
    return true;
  }

  /** @internal Editing a trigger within the window re-runs it into the same reply. */
  async handleRawUpdate(raw: Partial<RawMessage> & { id: string }): Promise<boolean> {
    if (!this.enabledFlag || typeof raw.content !== 'string' || isSynthetic(raw)) return false;
    const session = await this.sessions.findByTrigger(raw.id);
    if (!session || session.live || Date.now() - session.createdAt > this.options.editRerunMs) return false;
    if (raw.author && raw.author.id !== session.ownerId) return false;
    const text = await this.triggerText({ channel_id: session.channelId, ...raw }, undefined, true);
    if (text === undefined || text === session.data.raw || !(await this.isOwner(session.ownerId))) return false;
    await this.rerun(session, session.ownerId, text, 'edit-run');
    return true;
  }

  /** @internal Deleting a trigger deletes Byaku's reply. */
  async handleRawDelete(raw: { id: string }): Promise<boolean> {
    const session = await this.sessions.findByTrigger(raw.id);
    if (!session) return false;
    await this.endSession(session, 'trigger deleted');
    if (session.replyId) await this.client.messages.delete(session.replyId, session.channelId).catch(() => undefined);
    this.audit({
      action: 'delete',
      userId: session.ownerId,
      sessionId: session.id,
      mode: session.mode,
      outcome: 'ok',
      channelId: session.channelId,
    });
    return true;
  }

  /** @internal */
  redact(text: string): string {
    this.redactor.add(this.client.rest?.options.token);
    return this.redactor.redact(text);
  }

  /** @internal A failing audit callback must not break the console. */
  audit(entry: Omit<AuditEntry, 'at'>): void {
    if (!this.options.audit) return;
    const full: AuditEntry = { at: Date.now(), ...entry, ...(entry.error ? { error: this.redact(entry.error) } : {}) };
    try {
      void Promise.resolve(this.options.audit(full)).catch(() => undefined);
    } catch {
      // ignored on purpose
    }
  }

  /** @internal */
  async endSession(session: Session, reason: string): Promise<void> {
    await this.sessions.end(session.id, reason);
    this.lives.get(session.id)?.editor.close();
    this.lives.delete(session.id);
  }

  /** @internal */
  async rerun(
    session: Session,
    userId: string,
    text: string,
    action: 'rerun' | 'edit-run' | 'confirm',
    skipConfirm = false,
  ): Promise<void> {
    await this.run({
      ownerId: userId,
      channelId: session.channelId,
      ...(session.guildId ? { guildId: session.guildId } : {}),
      ...(session.triggerId ? { triggerId: session.triggerId } : {}),
      text,
      delivery: { kind: 'edit' },
      existing: session,
      action,
      skipConfirm,
    });
  }

  /** @internal Parses, asks for confirmation if needed, runs the mode and sends or edits the reply. */
  async run(req: RunRequest): Promise<void> {
    const parsed = parseInput(req.text, (word) => this.registry.resolve(word));
    const mode = this.registry.get(parsed.mode ?? 'summary');
    if (!mode) return;
    const session = await this.prepareSession(req, mode, parsed);

    const rule =
      req.skipConfirm || boolFlag(parsed.flags, 'yes')
        ? undefined
        : findRiskyRule([...DEFAULT_CONFIRM_RULES, ...this.options.confirm], mode.name, parsed.body);
    if (rule) {
      session.data.confirm = { reason: rule.reason };
      await this.sessions.save(session);
      await this.deliver(session, req.delivery);
      this.audit({
        action: 'confirm',
        mode: mode.name,
        userId: req.ownerId,
        sessionId: session.id,
        outcome: 'cancelled',
        codeLength: parsed.body.length,
        details: { asked: true },
      });
      return;
    }

    const signal = this.sessions.renewAbort(session.id).signal;
    const started = performance.now();
    let result: ModeReturn;
    try {
      result = await mode.run({
        byaku: this,
        client: this.client,
        input: parsed.body,
        ...(parsed.lang ? { lang: parsed.lang } : {}),
        flags: parsed.flags,
        author: { id: req.ownerId },
        channelId: session.channelId,
        ...(session.guildId ? { guildId: session.guildId } : {}),
        ...(req.message ? { message: req.message } : {}),
        ...(req.interaction ? { interaction: req.interaction } : {}),
        session,
        signal,
        redact: (text) => this.redact(text),
        scope: () => this.evalScope(session, req),
        live: (options) => this.startLive(session, req.delivery, options, signal),
      });
    } catch (err) {
      result = { output: formatError(err), ok: false };
    }
    const ms = performance.now() - started;

    const live = this.lives.get(session.id);
    if (live) {
      await live.editor.flush();
      live.editor.close();
      this.lives.delete(session.id);
    }
    delete session.live;
    this.applyResult(session, result, ms);
    await this.sessions.save(session);
    if (session.data.delivered === true) await this.editSession(session);
    else await this.deliver(session, req.delivery);

    this.audit({
      action: req.action ?? 'run',
      mode: mode.name,
      userId: req.ownerId,
      sessionId: session.id,
      channelId: session.channelId,
      ...(session.guildId ? { guildId: session.guildId } : {}),
      outcome: session.data.killed ? 'killed' : session.data.timedOut ? 'timeout' : session.ok ? 'ok' : 'error',
      durationMs: Math.round(ms),
      codeLength: parsed.body.length,
      ...(boolFlag(parsed.flags, 'unsafe') ? { unsafe: true } : {}),
    });
  }

  private async prepareSession(
    req: RunRequest,
    mode: ByakuMode,
    parsed: ReturnType<typeof parseInput>,
  ): Promise<Session> {
    let session = req.existing;
    if (session) {
      if (session.data.text !== true && session.output) session.previousOutput = session.output;
      Object.assign(session, { mode: mode.name, input: parsed.body, flags: parsed.flags, page: 0 });
      Object.assign(session.view, { path: [], keyPage: 0 });
      const stale = new Set(['confirm', 'status', 'text', 'killed', 'timedOut']);
      session.data = Object.fromEntries(Object.entries(session.data).filter(([key]) => !stale.has(key)));
      await this.sessions.touch(session);
    } else {
      session = await this.sessions.create({
        ownerId: req.ownerId,
        mode: mode.name,
        input: parsed.body,
        flags: parsed.flags,
        channelId: req.channelId,
        lang: parsed.lang ?? 'txt',
        ...(req.guildId ? { guildId: req.guildId } : {}),
        ...(req.triggerId ? { triggerId: req.triggerId } : {}),
        ...(req.ephemeral ? { ephemeral: true } : {}),
        ...(req.interactionToken ? { interactionToken: req.interactionToken, data: { tokenAt: Date.now() } } : {}),
      });
    }
    session.data.raw = req.text;
    session.view.depth = numberFlag(parsed.flags, 'depth', session.view.depth, 0, MAX_DEPTH);
    return session;
  }

  /** @internal The variables `js`, `ts` and `jsi` see. */
  evalScope(session: Session, req: Pick<RunRequest, 'message' | 'interaction'> = {}): Record<string, unknown> {
    this.requireFromBot ??= createRequire(join(process.cwd(), 'index.js'));
    return {
      client: this.client,
      ctx: req.interaction ?? req.message,
      message: req.message,
      cache: this.client.cache,
      rest: this.client.rest,
      byaku: this,
      session,
      channelId: session.channelId,
      guildId: session.guildId,
      require: this.requireFromBot,
      ...this.options.scope,
    };
  }

  private async startLive(
    session: Session,
    delivery: Delivery,
    options: LiveOptions,
    signal: AbortSignal,
  ): Promise<LiveHandle> {
    session.live = { kind: options.kind, paused: false, startedAt: Date.now() };
    if (options.lang) session.lang = options.lang;
    session.output = this.redact(options.render());
    await this.sessions.save(session);
    if (session.data.delivered === true) await this.editSession(session);
    else await this.deliver(session, delivery);

    const editor = new LiveEditor<ByakuBody>((body) => this.editMessage(session, body), {
      onError: (err) => this.client.logger.warn('[byaku] live edit failed:', errorMessage(err)),
    });
    this.lives.set(session.id, { editor, options });

    return {
      update: () => {
        if (!session.live || session.live.paused) return;
        session.output = this.redact(options.render());
        editor.update(this.render(session));
      },
      get paused() {
        return session.live?.paused === true;
      },
      signal,
    };
  }

  private applyResult(session: Session, result: ModeReturn, ms: number): void {
    const out = typeof result === 'string' ? { output: result } : (result ?? {});
    session.ok = out.ok ?? true;
    session.ms = out.ms ?? ms;
    if (out.status) session.data.status = out.status;
    if (out.lang) session.lang = out.lang;

    if (out.hasValue || 'value' in out) {
      this.sessions.keepValue(session.id, out.value);
      if (!out.lang) session.lang = 'js';
      this.refreshValue(session);
      return;
    }
    Object.assign(this.sessions.live(session.id), { hasValue: false, value: undefined });

    if (out.text !== undefined) {
      session.data.text = true;
      session.output = truncate(this.redact(out.text), 2000);
      session.pages = [session.output];
      return;
    }
    this.setOutput(session, this.redact(out.output ?? ''));
  }

  private setOutput(session: Session, output: string): void {
    session.output = output || '(no output)';
    session.pages = paginate(escapeFences(session.output), this.options.limits.pageSize);
    session.page = Math.min(session.page, session.pages.length - 1);
  }

  /** @internal Rebuilds the output of the kept JS value for the current depth, path and hidden settings. */
  refreshValue(session: Session): ExplorerEntry[] {
    const live = this.sessions.peekLive(session.id);
    if (!live?.hasValue) return [];
    const view = { hidden: session.view.hidden, getters: session.view.getters };
    let current: unknown;
    try {
      current = resolvePath(live.value, session.view.path, view);
    } catch (err) {
      session.view.path = [];
      current = live.value;
      session.data.status = [err instanceof ByakuError ? err.message : errorMessage(err)];
    }
    // The token and the environment only show with --unsafe (and are still redacted)
    const guarded =
      current === process.env || (typeof current === 'string' && current === this.client.rest?.options.token);
    const text =
      guarded && !boolFlag(session.flags, 'unsafe')
        ? '[redacted — use --unsafe]'
        : formatValue(current, { depth: session.view.depth, ...view });
    this.setOutput(session, this.redact(text));
    try {
      return listEntries(current, view, (text) => this.redact(text));
    } catch {
      return [];
    }
  }

  /** @internal */
  render(session: Session): ByakuBody {
    const live = this.sessions.peekLive(session.id);
    const hasValue = live?.hasValue === true && !session.live && session.data.text !== true;
    let entries: ExplorerEntry[] = [];
    if (hasValue) {
      try {
        entries = listEntries(resolvePath(live.value, session.view.path, session.view), session.view, (text) =>
          this.redact(text),
        );
      } catch {
        entries = [];
      }
    }
    return renderSession(
      session,
      {
        rerunnable: this.registry.get(session.mode)?.rerunnable ?? false,
        hasValue,
        entries,
      },
      (text) => this.redact(text),
    );
  }

  private async deliver(session: Session, delivery: Delivery): Promise<void> {
    const body = this.render(session);
    try {
      if (delivery.kind === 'reply') {
        const reference = delivery.triggerId
          ? { message_reference: { message_id: delivery.triggerId, fail_if_not_exists: false } }
          : {};
        session.replyId = (await this.client.messages.write(session.channelId, { ...body, ...reference })).id;
      } else if (delivery.kind === 'context') {
        // On a prefix context, editOrReply(body, true) returns the reply; later edits go to that same message
        const sent = await delivery.ctx.editOrReply(body, true);
        session.replyId = sent?.id;
      } else if (delivery.kind === 'modal') {
        const { flags: _flags, ...edit } = body;
        const sent = await delivery.ctx.editResponse(edit);
        Object.assign(session, { interactionToken: delivery.ctx.interaction.token });
        session.data.tokenAt = Date.now();
        if (!session.ephemeral) session.replyId = sent.id;
      } else {
        await this.editMessage(session, body);
      }
      session.data.delivered = true;
      await this.sessions.save(session);
    } catch (err) {
      this.client.logger.warn('[byaku] could not send the reply:', errorMessage(err));
    }
  }

  /** @internal */
  async editSession(session: Session): Promise<void> {
    await this.editMessage(session, this.render(session)).catch((err) =>
      this.client.logger.warn('[byaku] could not edit the reply:', errorMessage(err)),
    );
  }

  /** Ephemeral replies can only be edited through the interaction token, and only for 15 minutes. */
  private async editMessage(session: Session, body: ByakuBody): Promise<void> {
    const { flags: _flags, ...edit } = body;
    const token = session.interactionToken;
    if (
      token &&
      (session.ephemeral || !session.replyId) &&
      Date.now() - Number(session.data.tokenAt ?? 0) < TOKEN_TTL_MS
    ) {
      await this.client.interactions.editOriginal(token, edit);
    } else if (session.replyId) {
      // MessageFlags has no zero member, but Discord accepts zero to clear reply flags.
      await this.client.messages.edit(session.replyId, session.channelId, { ...edit, flags: 0 as MessageFlags });
    }
  }

  private async onExpire(session: Session): Promise<void> {
    this.lives.get(session.id)?.editor.close();
    this.lives.delete(session.id);
    if (session.data.text !== true) await this.editMessage(session, { ...this.render(session), components: [] });
  }

  /** @internal Runs a request on one worker, or on every worker when `workerId` is left out. */
  askWorkers(request: BridgeRequest, workerId?: number, timeoutMs = WORKER_TIMEOUT_MS): Promise<WorkerResult[]> {
    return workerId === undefined
      ? askAllWorkers(this.client, request, timeoutMs)
      : askWorker(this.client, workerId, request, timeoutMs).then((result) => [result]);
  }

  private async answerBridge(request: BridgeRequest): Promise<{ ok: boolean; text: string }> {
    if (request.op === 'info') {
      const { rss, heapUsed } = process.memoryUsage();
      return {
        ok: true,
        text: JSON.stringify({ pid: process.pid, rss, heapUsed, latency: (this.client as GatewayClient).latency }),
      };
    }
    const session = { id: 'bridge', channelId: '' } as Session;
    const result = await this.js.run(request.code, request.ownerId, this.evalScope(session));
    const text = result.ok ? formatValue(result.value, { depth: request.depth }) : formatError(result.error);
    return { ok: result.ok, text: this.redact(text) };
  }
}
