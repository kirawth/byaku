import { Command, type CommandContext, createPlugin, createUserOption, InteractionContextType } from 'seyfert';
import { HandleCommand } from 'seyfert/lib/commands/handle.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Byaku } from '../src/byaku.js';
import { defineMode } from '../src/modes/index.js';
import type { ByakuOptions } from '../src/options.js';
import { byakuPlugin, createByakuClasses } from '../src/plugin.js';
import { BOT_ID, FakeBot, OWNER_ID, STRANGER_ID } from './helpers.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});

async function fixture({
  plugin = false,
  router = true,
  prefix = () => ['?'],
  options = {},
  argument = false,
}: {
  plugin?: boolean;
  router?: boolean;
  prefix?: () => string[] | Promise<string[]>;
  options?: ByakuOptions;
  argument?: boolean;
} = {}) {
  const holder: { byaku?: Byaku } = {};
  const ran: string[] = [];
  const parsed: string[] = [];
  const trace: string[] = [];
  const rawEvents: string[] = [];
  const messageEvents: string[] = [];
  const collected: string[] = [];
  const onOptionsError = vi.fn();
  const onInternalError = vi.fn();
  const config: ByakuOptions = {
    ...options,
    owners: [OWNER_ID],
    slash: false,
    advanced: { ...options.advanced, includeAppOwners: false },
  };
  const observer = createPlugin({
    name: 'observer',
    register(api) {
      api.events.on('raw', (packet) => {
        if (packet.t === 'MESSAGE_CREATE') rawEvents.push(packet.d.content);
      });
      api.events.on('messageCreate', (message) => messageEvents.push(message.content));
    },
  });
  class BotHandler extends HandleCommand {
    override argsParser(...args: Parameters<HandleCommand['argsParser']>) {
      parsed.push(args[0]);
      return super.argsParser(...args);
    }
    override async message(raw: Parameters<HandleCommand['message']>[0], shardId: number) {
      trace.push(`before:${raw.content}`);
      try {
        const owner = holder.byaku ?? (this.client as unknown as { byaku?: Byaku }).byaku;
        if (router && (await owner?.shouldSkipMessageCommand(raw))) return;
        return await super.message(raw, shardId);
      } finally {
        trace.push(`after:${raw.content}`);
      }
    }
  }
  const bot = await FakeBot.create({
    prefix,
    clientOptions: { plugins: [observer, ...(plugin ? [byakuPlugin(config)] : [])] as never },
    setup(client) {
      client.setServices({ handleCommand: BotHandler });
      for (const name of ['by', 'byaku', 'dev', 'ping']) {
        class BotCommand extends Command {
          constructor() {
            super();
            this.name = name;
            this.description = name;
            this.contexts = [InteractionContextType.Guild, InteractionContextType.BotDM];
            if (argument && name !== 'ping')
              this.options = [
                { ...createUserOption({ description: 'Target', required: true }), name: 'target' },
              ] as never;
          }
          override async run(_ctx: CommandContext) {
            ran.push(name);
          }
          override onOptionsError = onOptionsError;
          override onInternalError = onInternalError;
        }
        client.commands.set([BotCommand]);
      }
    },
  });
  const byaku = plugin ? (bot.client as unknown as { byaku: Byaku }).byaku : new Byaku(bot.client, config);
  holder.byaku = byaku;
  const handler = bot.client.handleCommand;
  await byaku.install();
  let stopCollector: (() => void) | undefined;
  bot.client.collectors.create({
    event: 'raw',
    filter: () => true,
    run(packet, stop) {
      stopCollector = stop;
      if (packet.t === 'MESSAGE_CREATE') collected.push(packet.d.content);
    },
  });
  cleanup.push(async () => {
    stopCollector?.();
    await byaku?.uninstall();
    await bot.client.close();
  });
  return {
    bot,
    byaku,
    handler,
    ran,
    parsed,
    trace,
    rawEvents,
    messageEvents,
    collected,
    onOptionsError,
    onInternalError,
  };
}

async function reply(bot: FakeBot, content: string) {
  const raw = await bot.send(content);
  return bot.waitFor(() => bot.reply(raw.id));
}

const posts = (bot: FakeBot) =>
  bot.calls.filter((call) => call.method === 'POST' && /\/channels\/\d+\/messages$/.test(call.url));

for (const plugin of [false, true]) {
  describe(`${plugin ? 'plugin' : 'manual'} explicit routing`, () => {
    for (const kind of ['fixed', 'dynamic', 'mention'] as const) {
      it(`preserves raw quotes/flags with ${kind} prefixes and bypasses colliding argument parsers`, async () => {
        const prefix = vi.fn(kind === 'dynamic' ? async () => ['!', '?'] : () => ['?', `<@${BOT_ID}> `]);
        const f = await fixture({ plugin, prefix, argument: true, options: { prefixes: ['?dev'] } });
        const run = vi.spyOn(f.byaku, 'run');
        const trigger = kind === 'fixed' ? '?dev' : kind === 'dynamic' ? '!by' : `<@${BOT_ID}> byaku`;
        const code = 'js --depth=2 return "quoted --flag" + " value"; // -target 300000000000000003';
        const content = `${trigger} ${code}`;
        const output = await reply(f.bot, content);
        expect(output.content).toContain('quoted --flag value');
        expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0]?.[0].text).toBe(code);
        expect(f.parsed).toEqual([]);
        expect(f.ran).toEqual([]);
        expect(f.onOptionsError).not.toHaveBeenCalled();
        expect(f.onInternalError).not.toHaveBeenCalled();
        expect(f.bot.calls.some((call) => call.url.startsWith('/users/300000000000000003'))).toBe(false);
        expect(f.bot.client.handleCommand).toBe(f.handler);
        expect(f.bot.client.options.commands?.prefix).toBe(prefix);
        expect(f.rawEvents).toEqual([content]);
        expect(f.messageEvents).toEqual([content]);
        expect(f.collected).toEqual([content]);
        expect(f.trace).toEqual([`before:${content}`, `after:${content}`]);
        await f.bot.send(kind === 'dynamic' ? '!ping' : '?ping');
        expect(f.ran).toEqual(['ping']);
        expect(f.parsed).toHaveLength(1);
      });
    }

    it('reserves both by/byaku once, deactivates without touching the service, and reuses the hook on reinstall', async () => {
      const prefix = () => ['?'];
      const f = await fixture({ plugin, prefix });
      for (const name of ['by', 'byaku']) expect((await reply(f.bot, `?${name} 6 * 7`)).content).toContain('42');
      expect(f.ran).toEqual([]);
      f.byaku.disable();
      await f.bot.send('?by 1');
      expect(f.ran).toEqual(['by']);
      f.byaku.enable();
      await reply(f.bot, '?by 21 * 2');
      expect(f.ran).toEqual(['by']);
      await f.byaku.uninstall();
      await f.bot.send('?byaku 1');
      expect(f.ran).toEqual(['by', 'byaku']);
      await f.byaku.install();
      await f.byaku.install();
      await reply(f.bot, '?by 42');
      expect(f.ran).toEqual(['by', 'byaku']);
      expect(posts(f.bot)).toHaveLength(4);
      expect(f.bot.client.handleCommand).toBe(f.handler);
      expect(f.bot.client.options.commands?.prefix).toBe(prefix);
    });

    it('edits a trigger owned by a loaded ByakuCommand into the same reply with the guard disabled', async () => {
      const f = await fixture({ plugin, options: { advanced: { prefixGuard: false } } });
      f.bot.client.commands.values.find((command) => command.name === 'byaku')!.name = 'other';
      f.bot.client.commands.set([createByakuClasses(f.byaku).ByakuCommand]);
      const raw = await f.bot.send('?byaku 21');
      const session = (await f.byaku.sessions.store.list())[0]!;
      expect(f.bot.messages.get(session.replyId!)?.content).toContain('21');
      await f.bot.edit(raw, '?byaku 6 * 7');
      await f.bot.waitFor(() => f.bot.messages.get(session.replyId!)?.content.includes('42'));
      expect(posts(f.bot)).toHaveLength(1);
    });

    it('starts disabled without reserving commands, and keeps non-owner triggers invisible after enabling', async () => {
      const f = await fixture({ plugin, options: { advanced: { enabled: false } } });
      await f.bot.send('?by 42');
      expect(f.ran).toEqual(['by']);
      expect(posts(f.bot)).toHaveLength(0);
      f.byaku.enable();
      await f.bot.send('?by 42', { author: STRANGER_ID });
      expect(f.ran).toEqual(['by']);
      expect(posts(f.bot)).toHaveLength(0);
      expect(f.rawEvents).toHaveLength(2);
      expect(f.messageEvents).toHaveLength(2);
      expect(f.collected).toHaveLength(2);
    });

    it('prefixGuard false deliberately allows the bot command alongside one Byaku execution', async () => {
      const f = await fixture({ plugin, options: { advanced: { prefixGuard: false } } });
      await reply(f.bot, '?by 42');
      await reply(f.bot, '?byaku 21 * 2');
      expect(f.ran).toEqual(['by', 'byaku']);
      expect(posts(f.bot)).toHaveLength(2);
      expect(f.bot.client.handleCommand).toBe(f.handler);
    });

    it.each([true, false])(
      'a loaded ByakuCommand answers each actual route once with prefixGuard %s',
      async (prefixGuard) => {
        const f = await fixture({
          plugin,
          prefix: () => ['?', `<@${BOT_ID}> `],
          options: { advanced: { prefixGuard }, prefixes: ['?byaku'] },
        });
        const { ByakuCommand } = createByakuClasses(f.byaku);
        // Replace this test bot's own byaku command through the public set API.
        const own = f.bot.client.commands.values.find((command) => command.name === 'byaku')!;
        own.name = 'other';
        f.bot.client.commands.set([ByakuCommand]);
        for (const [index, content] of ['?byaku 42', `<@${BOT_ID}> byaku 6 * 7`, '?by 21 * 2'].entries()) {
          await f.bot.send(content);
          await f.bot.waitFor(() => posts(f.bot).length === index + 1);
        }
        expect(posts(f.bot)).toHaveLength(3);
        expect(await f.byaku.sessions.store.list()).toHaveLength(3);
        expect(f.ran).toEqual(prefixGuard ? [] : ['by']);
      },
    );
  });
}

describe('explicit setup boundary', () => {
  it('install alone preserves prefix and custom service identity, but cannot reserve a colliding command', async () => {
    const prefix = () => ['?'];
    const f = await fixture({ router: false, prefix });
    await reply(f.bot, '?by 42');
    expect(f.ran).toEqual(['by']);
    expect(f.bot.client.options.commands?.prefix).toBe(prefix);
    expect(f.bot.client.handleCommand).toBe(f.handler);
    const replacement = async () => ['!'];
    f.bot.client.options.commands!.prefix = replacement;
    await f.byaku.uninstall();
    expect(f.bot.client.options.commands?.prefix).toBe(replacement);
  });

  it('the hook does not await a long evaluation before letting the gateway finish', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<string>((resolve) => {
      release = () => resolve('finished');
    });
    const f = await fixture({
      options: { modes: [defineMode({ name: 'pending', description: 'pending', run: () => pending })] },
    });
    try {
      const raw = await f.bot.send('?by pending');
      expect(f.messageEvents).toEqual(['?by pending']);
      expect(f.ran).toEqual([]);
      release!();
      expect((await f.bot.waitFor(() => f.bot.reply(raw.id))).content).toContain('finished');
    } finally {
      release?.();
    }
  });
});
