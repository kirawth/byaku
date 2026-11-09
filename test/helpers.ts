/**
 * A real Seyfert `Client` with stubbed REST and a fake gateway: tests inject raw dispatch packets and
 * read the REST calls the bot made. Nothing touches the network.
 */
import { ApiHandler, Client, type ClientOptions } from 'seyfert';

// A fake bot token, joined at runtime so secret scanners don't flag it
export const TOKEN = ['MTAwMDAwMDAwMDAwMDAwMDAx', 'GfakeT', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join('.');
export const BOT_ID = '100000000000000001';
export const OWNER_ID = '200000000000000002';
export const STRANGER_ID = '300000000000000003';
const GUILD_ID = '400000000000000004';
export const CHANNEL_ID = '500000000000000005';
export const DM_CHANNEL_ID = '600000000000000006';

/* eslint-disable @typescript-eslint/no-explicit-any -- raw Discord payloads in a test double */
export type Json = any;

export interface RestCall {
  method: string;
  url: string;
  body?: Json;
  files?: unknown[];
}

export interface FakeMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  components: Json[];
  flags?: number;
  embeds?: Json[];
  author: { id: string; username: string; discriminator: string; bot?: boolean };
  ephemeral?: boolean;
}

let snowflake = 800000000000000000n;
const nextId = () => String(++snowflake);

const user = (id: string) => ({
  id,
  username: id === OWNER_ID ? 'owner' : id === BOT_ID ? 'bot' : 'stranger',
  discriminator: '0',
  global_name: null,
  avatar: null,
  ...(id === BOT_ID ? { bot: true } : {}),
});

const member = (id: string) => ({
  user: user(id),
  roles: [],
  joined_at: new Date(0).toISOString(),
  deaf: false,
  mute: false,
  flags: 0,
  permissions: '0',
});

export interface FakeBotOptions {
  prefix?: (message: never) => string[] | Promise<string[]>;
  clientOptions?: Partial<ClientOptions>;
  /** Runs before `client.start()` (load commands, components, events). */
  setup?: (client: Client) => void | Promise<void>;
  app?: Json;
}

export class FakeBot {
  readonly calls: RestCall[] = [];
  /** Every message the bot sent or edited, by id. Interaction responses are keyed by token too. */
  readonly messages = new Map<string, FakeMessage>();
  private readonly tokenMessage = new Map<string, string>();
  private readonly interactionMessage = new Map<string, FakeMessage>();
  /** trigger message id → reply id */
  private readonly repliesTo = new Map<string, string>();
  app: Json;

  constructor(readonly client: Client) {
    this.app = { id: BOT_ID, name: 'Test', owner: user(OWNER_ID), team: null };
  }

  static async create(options: FakeBotOptions = {}): Promise<FakeBot> {
    const client = new Client({
      getRC: () => ({ token: TOKEN, intents: 0, debug: false, locations: { base: '.' } }) as never,
      commands: { prefix: (options.prefix ?? (() => ['?'])) as never },
      ...(options.clientOptions as object),
    } as never) as Client;
    client.setServices({ rest: new ApiHandler({ token: TOKEN }) });
    const bot = new FakeBot(client);
    if (options.app) bot.app = options.app;
    client.rest.request = ((method: string, url: string, req: Json = {}) => bot.handleRest(method, url, req)) as never;
    client.logger.level = 4 as never; // quiet
    await options.setup?.(client);
    await client.start({}, false);
    client.botId = BOT_ID;
    client.applicationId = BOT_ID;
    return bot;
  }

  // ───────── REST ─────────

  private toMessage(channelId: string, body: Json, id = nextId(), extra: Partial<FakeMessage> = {}): FakeMessage {
    return {
      id,
      channel_id: channelId,
      content: body?.content ?? '',
      components: body?.components ?? [],
      flags: body?.flags,
      embeds: body?.embeds ?? [],
      author: user(BOT_ID),
      ...extra,
    };
  }

  private apiMessage(m: FakeMessage): Json {
    return {
      id: m.id,
      channel_id: m.channel_id,
      ...(m.guild_id ? { guild_id: m.guild_id } : {}),
      content: m.content,
      components: m.components,
      author: m.author,
      timestamp: new Date().toISOString(),
      edited_timestamp: null,
      tts: false,
      mention_everyone: false,
      mentions: [],
      mention_roles: [],
      attachments: [],
      embeds: m.embeds ?? [],
      pinned: false,
      type: 0,
      flags: m.flags ?? 0,
    };
  }

  private async handleRest(method: string, url: string, req: Json): Promise<unknown> {
    const body = req.body;
    this.calls.push({ method, url, body, ...(req.files ? { files: req.files } : {}) });
    let m: RegExpExecArray | null;

    if (url.includes('/gateway/bot')) {
      return {
        url: 'wss://gateway.discord.gg',
        shards: 1,
        session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
      };
    }
    if (method === 'GET' && /^\/applications\/@me$/.test(url)) return this.app;
    if (method === 'GET' && url === '/users/@me') return user(BOT_ID);

    if ((m = /^\/channels\/(\d+)\/messages$/.exec(url)) && method === 'POST') {
      const msg = this.toMessage(m[1]!, body);
      this.messages.set(msg.id, msg);
      const ref = body?.message_reference?.message_id;
      if (ref) this.repliesTo.set(ref, msg.id);
      return this.apiMessage(msg);
    }
    if ((m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(url))) {
      if (method === 'PATCH') {
        const old = this.messages.get(m[2]!) ?? this.toMessage(m[1]!, {}, m[2]!);
        const msg = { ...old, ...pick(body), id: m[2]! };
        this.messages.set(msg.id, msg);
        return this.apiMessage(msg);
      }
      if (method === 'DELETE') {
        this.messages.delete(m[2]!);
        return undefined;
      }
      if (method === 'GET') {
        const msg = this.messages.get(m[2]!);
        return msg ? this.apiMessage(msg) : undefined;
      }
    }
    if ((m = /^\/channels\/(\d+)\/messages\/(\d+)\/threads$/.exec(url)) && method === 'POST') {
      return { id: nextId(), type: 11, parent_id: m[1], name: body?.name, guild_id: GUILD_ID };
    }

    if ((m = /^\/interactions\/(\d+)\/([^/]+)\/callback/.exec(url))) {
      const token = m[2]!;
      const type = body?.type;
      const data = body?.data;
      const source = this.interactionMessage.get(token);
      if (type === 7 && source) {
        // UPDATE_MESSAGE: edits the message with the component
        const msg = { ...source, ...pick(data) };
        this.messages.set(msg.id, msg);
        this.interactionMessage.set(token, msg);
      } else if (type === 4 || type === 5) {
        // CHANNEL_MESSAGE_WITH_SOURCE or its deferred placeholder
        const msg = this.toMessage(CHANNEL_ID, data, nextId(), { ephemeral: ((data?.flags ?? 0) & 64) === 64 });
        this.messages.set(msg.id, msg);
        this.tokenMessage.set(token, msg.id);
      }
      return undefined;
    }

    if ((m = /^\/webhooks\/(\d+)\/([^/]+)\/messages\/@original$/.exec(url))) {
      const token = m[2]!;
      const id = this.tokenMessage.get(token) ?? this.interactionMessage.get(token)?.id;
      const old = id ? this.messages.get(id) : undefined;
      if (method === 'PATCH') {
        const msg = { ...(old ?? this.toMessage(CHANNEL_ID, {})), ...pick(body) };
        this.messages.set(msg.id, msg);
        this.tokenMessage.set(token, msg.id);
        return this.apiMessage(msg);
      }
      if (method === 'GET') return old ? this.apiMessage(old) : this.apiMessage(this.toMessage(CHANNEL_ID, {}));
      if (method === 'DELETE') {
        if (id) this.messages.delete(id);
        return undefined;
      }
    }
    if (/^\/webhooks\/(\d+)\/([^/]+)$/.test(url) && method === 'POST') {
      const msg = this.toMessage(CHANNEL_ID, body);
      this.messages.set(msg.id, msg);
      return this.apiMessage(msg);
    }
    return {};
  }

  // ───────── gateway ─────────

  async inject(t: string, d: Json, shardId = 0): Promise<void> {
    await (this.client as unknown as { onPacket(shard: number, p: Json): Promise<unknown> }).onPacket(shardId, {
      op: 0,
      s: 1,
      t,
      d,
    });
  }

  /** A user sends a message (MESSAGE_CREATE). */
  async send(
    content: string,
    options: { author?: string; guildId?: string | null; channelId?: string } = {},
  ): Promise<Json> {
    const author = options.author ?? OWNER_ID;
    const guildId = options.guildId === undefined ? GUILD_ID : options.guildId;
    const raw: Json = {
      id: nextId(),
      channel_id: options.channelId ?? (guildId ? CHANNEL_ID : DM_CHANNEL_ID),
      content,
      author: user(author),
      timestamp: new Date().toISOString(),
      edited_timestamp: null,
      tts: false,
      mention_everyone: false,
      mentions: [],
      mention_roles: [],
      attachments: [],
      embeds: [],
      pinned: false,
      type: 0,
      ...(guildId ? { guild_id: guildId, member: member(author) } : {}),
    };
    await this.inject('MESSAGE_CREATE', raw);
    return raw;
  }

  /** The user edits a message (MESSAGE_UPDATE). */
  async edit(raw: Json, content: string): Promise<Json> {
    const next = { ...raw, content, edited_timestamp: new Date().toISOString() };
    await this.inject('MESSAGE_UPDATE', next);
    return next;
  }

  /** The user deletes a message (MESSAGE_DELETE). */
  async remove(raw: Json): Promise<void> {
    await this.inject('MESSAGE_DELETE', {
      id: raw.id,
      channel_id: raw.channel_id,
      ...(raw.guild_id ? { guild_id: raw.guild_id } : {}),
    });
  }

  private interactionBase(userId: string, guildId: string | null, channelId: string): Json {
    return {
      id: nextId(),
      application_id: BOT_ID,
      token: `tok-${nextId()}`,
      version: 1,
      channel_id: channelId,
      channel: { id: channelId, type: guildId ? 0 : 1 },
      app_permissions: '0',
      locale: 'en-US',
      entitlements: [],
      authorizing_integration_owners: {},
      context: guildId ? 0 : 1,
      ...(guildId ? { guild_id: guildId, guild_locale: 'en-US', member: member(userId) } : { user: user(userId) }),
    };
  }

  /** Finds a button in a message by custom id, label or emoji, so emoji-only buttons can be clicked too. */
  findButton(
    message: FakeMessage,
    match: { emoji?: string; label?: string; customId?: string | RegExp },
  ): Json | undefined {
    for (const row of message.components) {
      for (const c of row.components ?? []) {
        if (c.type !== 2) continue;
        if (
          match.customId &&
          (typeof match.customId === 'string' ? c.custom_id === match.customId : match.customId.test(c.custom_id))
        )
          return c;
        if (match.label && c.label === match.label) return c;
        if (match.emoji && c.emoji?.name === match.emoji) return c;
      }
    }
    return undefined;
  }

  findSelect(message: FakeMessage, customId: RegExp): Json | undefined {
    for (const row of message.components)
      for (const c of row.components ?? []) if (c.type === 3 && customId.test(c.custom_id)) return c;
    return undefined;
  }

  /** A user clicks a button. Returns the interaction token. */
  async click(
    message: FakeMessage,
    match: { emoji?: string; label?: string; customId?: string | RegExp },
    userId = OWNER_ID,
  ): Promise<string> {
    const button = this.findButton(message, match);
    if (!button) throw new Error(`No button ${JSON.stringify(match)} in ${JSON.stringify(message.components)}`);
    return this.component(message, button.custom_id, 2, undefined, userId);
  }

  /** A user picks values in a select menu. */
  async select(message: FakeMessage, customId: RegExp, values: string[], userId = OWNER_ID): Promise<string> {
    const select = this.findSelect(message, customId);
    if (!select) throw new Error(`No select ${customId} in message`);
    return this.component(message, select.custom_id, 3, values, userId);
  }

  private async component(
    message: FakeMessage,
    customId: string,
    componentType: number,
    values: string[] | undefined,
    userId: string,
  ) {
    const guildId = message.guild_id ?? (message.channel_id === DM_CHANNEL_ID ? null : GUILD_ID);
    const base = this.interactionBase(userId, guildId, message.channel_id);
    this.interactionMessage.set(base.token, message);
    await this.inject('INTERACTION_CREATE', {
      ...base,
      type: 3,
      data: { custom_id: customId, component_type: componentType, ...(values ? { values } : {}) },
      message: this.apiMessage(message),
    });
    return base.token as string;
  }

  /** A user submits a modal. `message` is the message whose button opened it. */
  async submitModal(
    customId: string,
    fields: Record<string, string>,
    options: { userId?: string; message?: FakeMessage; files?: Json[] } = {},
  ) {
    const userId = options.userId ?? OWNER_ID;
    const base = this.interactionBase(userId, GUILD_ID, options.message?.channel_id ?? CHANNEL_ID);
    if (options.message) this.interactionMessage.set(base.token, options.message);
    const components: Json[] = Object.entries(fields).map(([id, value]) => ({
      type: 18,
      id: 1,
      component: { type: 4, custom_id: id, value },
    }));
    const resolved: Json = {};
    if (options.files?.length) {
      components.push({
        type: 18,
        id: 2,
        component: { type: 19, custom_id: 'file', values: options.files.map((f) => f.id) },
      });
      resolved.attachments = Object.fromEntries(options.files.map((f) => [f.id, f]));
    }
    await this.inject('INTERACTION_CREATE', {
      ...base,
      type: 5,
      data: { custom_id: customId, components, ...(options.files?.length ? { resolved } : {}) },
      ...(options.message ? { message: this.apiMessage(options.message) } : {}),
    });
    return base.token as string;
  }

  /** A user runs a slash command. */
  async slash(name: string, options: Json[] = [], userId = OWNER_ID): Promise<string> {
    const base = this.interactionBase(userId, GUILD_ID, CHANNEL_ID);
    await this.inject('INTERACTION_CREATE', { ...base, type: 2, data: { id: nextId(), name, type: 1, options } });
    return base.token as string;
  }

  // ───────── reading ─────────

  /** Interaction callbacks for a token. */
  callbacks(token?: string): Json[] {
    return this.calls
      .filter((c) => c.url.includes('/callback') && (!token || c.url.includes(`/${token}/`)))
      .map((c) => c.body);
  }

  lastMessage(): FakeMessage | undefined {
    return [...this.messages.values()].at(-1);
  }

  /** The bot's reply to a trigger message (sent with a message_reference to it). */
  reply(triggerId: string): FakeMessage | undefined {
    const id = this.repliesTo.get(triggerId);
    return id ? this.messages.get(id) : undefined;
  }

  /** Waits until `check` returns a truthy value (collectors run without being awaited). */
  async waitFor<T>(check: () => T | undefined | false | null, timeoutMs = 4000): Promise<T> {
    const started = Date.now();
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

function pick(body: Json): Partial<FakeMessage> {
  const out: Json = {};
  if (!body) return out;
  for (const key of ['content', 'components', 'flags', 'embeds']) if (key in body) out[key] = body[key];
  return out;
}
