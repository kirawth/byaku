import { Command, type CommandContext, InteractionContextType } from 'seyfert';
import { describe, expect, it } from 'vitest';

import { Byaku } from '../src/byaku.js';
import { byakuPlugin } from '../src/plugin.js';
import { FakeBot } from './helpers.js';

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
  it('adds client.byaku, installs on start, and feeds command and REST observers', async () => {
    const plugin = byakuPlugin({ prefixes: ['?by'] });
    const bot = await FakeBot.create({
      clientOptions: { plugins: [plugin] as never },
      setup: (client) => void client.commands.set([Fail] as never),
    });
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
