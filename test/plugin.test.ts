import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { Command, type CommandContext, InteractionContextType } from 'seyfert';
import { afterEach, describe, expect, it } from 'vitest';

import { Byaku } from '../src/byaku.js';
import { byakuPlugin } from '../src/plugin.js';
import { FakeBot, OWNER_ID, TOKEN } from './helpers.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function commandsDirectory() {
  const dir = await mkdtemp(join(tmpdir(), 'byaku-commands-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(
    join(dir, 'ping.js'),
    `import { Command, InteractionContextType } from ${JSON.stringify(import.meta.resolve('seyfert'))};
export default class Ping extends Command {
  constructor() {
    super();
    this.name = 'ping';
    this.description = 'Replies with pong';
    this.contexts = [InteractionContextType.Guild];
  }
  async run(ctx) { await ctx.write({ content: 'pong' }); }
}
`,
  );
  return dir;
}

function fileLoaderOptions(commands: string) {
  return {
    getRC: () =>
      ({
        token: TOKEN,
        intents: 0,
        debug: false,
        locations: { base: '.', commands: relative(process.cwd(), commands) },
      }) as never,
  };
}

class Fail extends Command {
  constructor() {
    super();
    this.name = 'fail';
    this.description = 'fails';
    this.contexts = [InteractionContextType.Guild, InteractionContextType.BotDM];
  }
  override async run(_ctx: CommandContext) {
    throw new Error('nope');
  }
}

describe('byakuPlugin()', () => {
  it.each([true, { guilds: ['400000000000000004'] }])(
    'keeps file-loaded commands and the slash contribution through startup (%j)',
    async (slash) => {
      const commands = await commandsDirectory();
      const bot = await FakeBot.create({
        clientOptions: {
          ...fileLoaderOptions(commands),
          plugins: [byakuPlugin({ slash, owners: [OWNER_ID], advanced: { includeAppOwners: false } })] as never,
        },
      });
      cleanup.push(() => bot.client.close());
      const byaku = (bot.client as unknown as { byaku: Byaku }).byaku;
      await byaku.install();
      await byaku.install();
      expect(bot.client.commands.values.map((c) => c.name).sort()).toEqual(['byaku', 'ping']);
      expect(bot.client.commands.values.find((c) => c.name === 'byaku')?.guildId).toEqual(
        typeof slash === 'object' ? slash.guilds : undefined,
      );

      const ping = await bot.slash('ping');
      expect(bot.callbacks(ping)).toMatchObject([{ type: 4, data: { content: 'pong' } }]);
      const token = await bot.slash('byaku');
      expect(bot.callbacks(token)).toMatchObject([{ type: 9, data: { custom_id: 'by1:new:M:code:js:e' } }]);

      await bot.client.start({}, false);
      expect(bot.client.commands.values.map((c) => c.name).sort()).toEqual(['byaku', 'ping']);

      await bot.client.close();
      expect(bot.client.commands.values.map((c) => c.name)).toEqual(['ping']);
      await bot.client.start({}, false);
      expect(bot.client.commands.values.map((c) => c.name).sort()).toEqual(['byaku', 'ping']);
    },
  );

  it('does not contribute a slash command when slash is false', async () => {
    const commands = await commandsDirectory();
    const bot = await FakeBot.create({
      clientOptions: {
        ...fileLoaderOptions(commands),
        plugins: [byakuPlugin({ slash: false, advanced: { includeAppOwners: false } })] as never,
      },
    });
    cleanup.push(() => bot.client.close());
    expect(bot.client.commands.values.map((c) => c.name)).toEqual(['ping']);
  });

  it('supports manual installation after file-loaded startup without duplicate slash commands', async () => {
    const commands = await commandsDirectory();
    const bot = await FakeBot.create({ clientOptions: fileLoaderOptions(commands) });
    const byaku = new Byaku(bot.client, {
      slash: { guilds: ['400000000000000004'] },
      owners: [OWNER_ID],
      advanced: { includeAppOwners: false },
    });
    cleanup.push(() => byaku.uninstall());
    await byaku.install();
    await byaku.install();
    expect(bot.client.commands.values.map((c) => c.name).sort()).toEqual(['byaku', 'ping']);
    expect(bot.client.commands.values.find((c) => c.name === 'byaku')?.guildId).toEqual(['400000000000000004']);
    const token = await bot.slash('byaku');
    expect(bot.callbacks(token)).toMatchObject([{ type: 9 }]);
  });

  it('adds client.byaku, installs on start, and feeds command and REST observers', async () => {
    const plugin = byakuPlugin({ prefixes: ['?by'] });
    const bot = await FakeBot.create({
      clientOptions: { plugins: [plugin] as never },
      setup: (client) => void client.commands.set([Fail] as never),
    });
    cleanup.push(() => bot.client.close());
    const byaku = (bot.client as unknown as { byaku: Byaku }).byaku;
    expect(byaku).toBeInstanceOf(Byaku);
    expect(byaku.plugin).toBeDefined();

    const events: string[] = [];
    byaku.plugin!.onCommand((e) => events.push(`${e.kind}${e.error ? `:${e.error}` : ''}`));
    await bot.send('?fail');
    expect(events).toEqual(['beforeMiddlewares', 'runError:nope', 'afterRun:nope']);

    // Installed by the plugin's setup: the trigger works
    const trigger = await bot.send('?by 2 * 21');
    const reply = await bot.waitFor(() => bot.reply(trigger.id));
    expect(reply.content).toContain('42');

    // Dispatches reach listeners only when someone listens
    const seen: string[] = [];
    const stop = byaku.plugin!.onDispatch((p) => seen.push(p.t));
    await bot.send('hello');
    stop();
    expect(seen).toContain('MESSAGE_CREATE');
  });
});
