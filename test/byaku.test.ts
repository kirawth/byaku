import { Command, type CommandContext, InteractionContextType, SubCommand, type MessageStructure } from 'seyfert';
import { describe, expect, it, vi } from 'vitest';
import { Shortcut, Yuna } from 'yunaforseyfert';

import { Byaku, guardPrefix, syntheticMessage, unguardPrefix } from '../src/byaku.js';
import { createByakuClasses } from '../src/plugin.js';
import { BOT_ID, CHANNEL_ID, FakeBot, OWNER_ID } from './helpers.js';

// Commands made without @Declare have no contexts; Seyfert then never runs them from messages
const BOTH = [InteractionContextType.Guild, InteractionContextType.BotDM];
const msg = (content: string) => ({ content, guildId: '1' }) as unknown as MessageStructure;
const posts = (bot: FakeBot) =>
  bot.calls.filter((c) => c.method === 'POST' && /\/channels\/\d+\/messages$/.test(c.url));

/** A bot command named like a Byaku trigger. */
function commandNamed(name: string, ran: string[]) {
  return class extends Command {
    constructor() {
      super();
      this.name = name;
      this.description = `bot command ${name}`;
      this.contexts = BOTH;
    }
    override async run(ctx: CommandContext) {
      ran.push(`${name}:${(ctx as unknown as { message?: { content: string } }).message?.content ?? ''}`);
    }
  };
}

describe('guardPrefix (unit)', () => {
  const isByaku = (m: MessageStructure, prefixes: readonly string[]) =>
    prefixes.some((p) => (m as unknown as { content: string }).content.startsWith(`${p}by `));

  it('returns the very same array for other messages (sync stays sync)', () => {
    const list = ['!', '?'];
    const guarded = guardPrefix(() => list, isByaku);
    const out = guarded(msg('?ping'));
    expect(out).toBe(list);
  });

  it('returns [] for Byaku messages', () => {
    const guarded = guardPrefix(() => ['?'], isByaku);
    expect(guarded(msg('?by js 1'))).toEqual([]);
  });

  it('async prefix functions stay async and keep their result', async () => {
    const list = ['?', `<@${BOT_ID}> `];
    const guarded = guardPrefix(async () => list, isByaku);
    const out = guarded(msg(`<@${BOT_ID}> ping`));
    expect(out).toBeInstanceOf(Promise);
    expect(await out).toBe(list);
    expect(await guarded(msg('?by x'))).toEqual([]);
  });

  it('never wraps twice and can be undone; a failing check returns the original result', () => {
    const original = () => ['?'];
    const once = guardPrefix(original, isByaku);
    const twice = guardPrefix(once, isByaku);
    expect(unguardPrefix(twice)).toBe(original);
    const broken = guardPrefix(original, () => {
      throw new Error('boom');
    });
    expect(broken(msg('?by 1'))).toEqual(['?']);
  });
});

describe('prefix guard with a real client', () => {
  it('a bot command named "by" does not also run on "?by …"; other commands still work', async () => {
    const ran: string[] = [];
    const bot = await FakeBot.create({
      setup: (client) => void client.commands.set([commandNamed('by', ran), commandNamed('ping', ran)] as never),
    });
    const byaku = new Byaku(bot.client, { prefixes: ['?by'] });
    await byaku.install();

    const trigger = await bot.send('?by 1 + 1');
    await bot.waitFor(() => bot.reply(trigger.id));
    await bot.send('?ping');
    expect(ran).toEqual(['ping:?ping']);
  });

  it('mention prefixes from the bot pass through untouched', async () => {
    const ran: string[] = [];
    const bot = await FakeBot.create({
      prefix: async () => ['?', `<@${BOT_ID}> `],
      setup: (client) => void client.commands.set([commandNamed('ping', ran)] as never),
    });
    await new Byaku(bot.client).install();
    await bot.send(`<@${BOT_ID}> ping`);
    expect(ran).toEqual([`ping:<@${BOT_ID}> ping`]);
    // "<bot prefix>byaku" is a Byaku trigger and is guarded
    const trigger = await bot.send('?byaku 2 + 2');
    await bot.waitFor(() => bot.reply(trigger.id));
    expect(ran).toHaveLength(1);
  });

  it('prefixGuard: false leaves the prefix function alone (both run)', async () => {
    const ran: string[] = [];
    const prefix = vi.fn(() => ['?']);
    const bot = await FakeBot.create({
      prefix,
      setup: (client) => void client.commands.set([commandNamed('by', ran)] as never),
    });
    await new Byaku(bot.client, { prefixes: ['?by'], advanced: { prefixGuard: false } }).install();
    expect((bot.client.options.commands as { prefix: unknown }).prefix).toBe(prefix);
    const trigger = await bot.send('?by 1');
    await bot.waitFor(() => bot.reply(trigger.id));
    expect(ran).toEqual(['by:?by 1']);
  });

  it('when Byaku is disabled the bot command runs as normal', async () => {
    const ran: string[] = [];
    const bot = await FakeBot.create({
      setup: (client) => void client.commands.set([commandNamed('by', ran)] as never),
    });
    await new Byaku(bot.client, { prefixes: ['?by'], advanced: { enabled: false } }).install();
    await bot.send('?by 1');
    expect(ran).toEqual(['by:?by 1']);
  });
});

describe('yunaforseyfert', () => {
  class Tools extends Command {
    constructor() {
      super();
      this.name = 'tools';
      this.description = 'tools';
      this.contexts = BOTH;
      this.options = [new ShortcutEcho()] as never;
    }
  }
  const ran: string[] = [];
  class Echo extends SubCommand {
    constructor() {
      super();
      this.name = 'echo';
      this.description = 'echo';
      this.contexts = BOTH;
    }
    override async run(ctx: CommandContext) {
      ran.push(`echo:${ctx.author.id}`);
    }
  }
  // @Shortcut() as a plain call: it returns the decorated class
  const ShortcutEcho = Shortcut()(Echo as never) as unknown as typeof Echo;

  async function yunaBot() {
    ran.length = 0;
    const bot = await FakeBot.create({
      clientOptions: { plugins: [Yuna.plugin({ parser: true, resolver: true })] as never },
      setup: (client) => void client.commands.set([Tools, commandNamed('by', ran)] as never),
    });
    // Yuna indexes commands when Seyfert loads them from files; commands set by hand need this
    await Yuna.commands.prepare(bot.client as never);
    return bot;
  }

  it("Yuna's resolver and @Shortcut keep working, and the guard still stops `by`", async () => {
    const bot = await yunaBot();
    await new Byaku(bot.client, { prefixes: ['?by'] }).install();
    await bot.send('?tools echo');
    await bot.send('?echo');
    expect(ran).toEqual([`echo:${OWNER_ID}`, `echo:${OWNER_ID}`]);
    const trigger = await bot.send('?by 1 + 1');
    await bot.waitFor(() => bot.reply(trigger.id));
    expect(ran).toHaveLength(2);
  });

  it('a synthetic message goes through Yuna and the middlewares, and Byaku ignores it', async () => {
    const bot = await yunaBot();
    const byaku = new Byaku(bot.client, { prefixes: ['?by'] });
    await byaku.install();
    const base = await bot.send('?by 1');
    await bot.waitFor(() => bot.reply(base.id));
    const other = { id: '777000000000000001', username: 'other', discriminator: '0' };
    const fake = syntheticMessage(base, { content: '?echo', author: other as never });
    await bot.client.handleCommand.message(fake as never, 0);
    expect(ran).toEqual(['echo:777000000000000001']);
    // A synthetic Byaku trigger is ignored (no loop)
    expect(await byaku.handleRaw(syntheticMessage(base, { content: '?by 2' }) as never)).toBe(false);
    expect(posts(bot)).toHaveLength(1);
  });
});

describe('ByakuCommand as a prefix command', () => {
  it('editOrReply(body, true) gives the reply id, and later edits change that same message', async () => {
    const holder: { byaku?: Byaku } = {};
    const bot = await FakeBot.create({
      setup: (client) => {
        holder.byaku = new Byaku(client as never, { advanced: { prefixGuard: false } });
        const { ByakuCommand } = createByakuClasses(holder.byaku);
        client.commands.set([ByakuCommand] as never);
      },
    });
    const byaku = holder.byaku!;
    await byaku.install();
    expect(bot.client.commands.values.filter((c) => c.name === 'byaku')).toHaveLength(1);

    await bot.send('?byaku 20 + 1');
    const first = await bot.waitFor(() => posts(bot)[0]);
    expect(first.body.content).toContain('21');
    const session = (await byaku.sessions.store.list())[0]!;
    const replyId = session.replyId!;
    expect(bot.messages.get(replyId)?.content).toContain('21');

    await bot.click(bot.messages.get(replyId)!, { emoji: '🔁' });
    // The re-run edits the very message editOrReply returned
    await bot.waitFor(() =>
      bot.calls.some((c) => c.method === 'PATCH' && c.url === `/channels/${CHANNEL_ID}/messages/${replyId}`),
    );
    expect(posts(bot)).toHaveLength(1);
    expect(bot.messages.get(replyId)?.content).toContain('21');
  });
});

describe('/byaku slash command', () => {
  it('opens the code modal; the result is ephemeral; non-owners are refused', async () => {
    const bot = await FakeBot.create();
    const byaku = new Byaku(bot.client, { slash: true });
    await byaku.install();
    expect(bot.client.commands.values.some((c) => c.name === 'byaku')).toBe(true);

    const token = await bot.slash('byaku', [{ name: 'mode', type: 3, value: 'js' }]);
    const modal = bot.callbacks(token)[0];
    expect(modal.type).toBe(9);
    expect(modal.data.custom_id).toBe('by1:new:M:code:js:e');
    expect(JSON.stringify(modal.data.components)).toContain('"type":19');

    const submit = await bot.submitModal(modal.data.custom_id, { code: '7 * 6' });
    const answer = await bot.waitFor(() => bot.callbacks(submit)[0]);
    expect(answer.type).toBe(5);
    expect(answer.data.flags).toBe(64);
    const result = bot.calls.find((c) => c.method === 'PATCH' && c.url.includes(`/${submit}/messages/@original`));
    expect(result?.body.content).toContain('42');

    const denied = await bot.slash('byaku', [], '300000000000000003');
    expect(bot.callbacks(denied)[0]).toMatchObject({ type: 4, data: { flags: 64 } });
  });
});

describe('setup', () => {
  it('one line: owners only; `<bot prefix>byaku`, `<bot prefix>by` and mentions work', async () => {
    const bot = await FakeBot.create();
    await new Byaku(bot.client, { owners: [OWNER_ID] }).install();
    for (const text of ['?byaku 1 + 1', '?by 2 + 2', `<@${BOT_ID}> byaku 3 + 3`]) {
      const trigger = await bot.send(text);
      await bot.waitFor(() => bot.reply(trigger.id));
    }
    expect(posts(bot)).toHaveLength(3);
  });

  it('bad options throw one ByakuError when Byaku is built', async () => {
    const bot = await FakeBot.create();
    expect(() => new Byaku(bot.client, { owner: ['1'] } as never)).toThrow(/Unknown option "owner"/);
    expect(() => new Byaku(bot.client, { advanced: { timeouts: { shell: 'later' } } })).toThrow(
      expect.objectContaining({ name: 'ByakuError', code: 'INVALID_OPTION' }),
    );
  });

  it('a throwing or rejecting audit callback never breaks a run', async () => {
    for (const audit of [
      () => {
        throw new Error('sync');
      },
      () => Promise.reject(new Error('async')),
    ]) {
      const bot = await FakeBot.create();
      await new Byaku(bot.client, { audit }).install();
      const trigger = await bot.send('?by 1 + 1');
      const reply = await bot.waitFor(() => bot.reply(trigger.id));
      expect(reply.content).toContain('2');
    }
  });

  it('with ByakuCommand loaded and the guard off, `<prefix>byaku` is answered once (by the command)', async () => {
    const holder: { byaku?: Byaku } = {};
    const bot = await FakeBot.create({
      setup: (client) => {
        holder.byaku = new Byaku(client as never, { advanced: { prefixGuard: false } });
        client.commands.set([createByakuClasses(holder.byaku).ByakuCommand] as never);
      },
    });
    await holder.byaku!.install();
    await bot.send('?byaku 5 * 5');
    await bot.waitFor(() => posts(bot)[0]);
    await new Promise((r) => setTimeout(r, 100));
    expect(posts(bot)).toHaveLength(1);
    // Fixed prefixes still reach the collector
    const trigger = await bot.send(`<@${BOT_ID}> byaku 6 * 6`);
    await bot.waitFor(() => bot.reply(trigger.id));
  });
});
