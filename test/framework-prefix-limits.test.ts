import {
  Command,
  type CommandContext,
  createPlugin,
  createStringOption,
  createUserOption,
  createContextScope,
  InteractionContextType,
} from 'seyfert';
import { HandleCommand } from 'seyfert/lib/commands/handle.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeBot } from './helpers.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});
const ran = vi.fn();
const optionsError = vi.fn();
class Collision extends Command {
  constructor(required = false) {
    super();
    this.name = 'by';
    this.description = 'collision';
    this.contexts = [InteractionContextType.Guild, InteractionContextType.BotDM];
    if (required)
      this.options = [
        { ...createStringOption({ description: 'Required value', required: true }), name: 'input' },
      ] as never;
  }
  override async run(_ctx: CommandContext) {
    ran();
  }
  override async onOptionsError() {
    optionsError();
  }
}

describe('Seyfert 5.2.0 routing constraints', () => {
  it('does not use command observer return values to cancel commands', async () => {
    const observe = vi.fn(() => false);
    const plugin = createPlugin({
      name: 'probe',
      register(api) {
        api.commands.observe({ onBeforeOptions: observe, onBeforeMiddlewares: observe });
      },
    });
    const bot = await FakeBot.create({
      clientOptions: { plugins: [plugin] as never },
      setup(client) {
        client.commands.set([new Collision()] as never);
      },
    });
    cleanup.push(() => bot.client.close());
    ran.mockClear();
    await bot.send('?by "raw code" --depth=2');
    expect(observe).toHaveBeenCalledTimes(2);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('validates required arguments before middleware observers can route raw code', async () => {
    const observe = vi.fn();
    const plugin = createPlugin({
      name: 'probe',
      register(api) {
        api.commands.observe({ onBeforeMiddlewares: observe });
      },
    });
    const bot = await FakeBot.create({
      clientOptions: { plugins: [plugin] as never },
      setup(client) {
        client.commands.set([new Collision(true)] as never);
      },
    });
    cleanup.push(() => bot.client.close());
    optionsError.mockClear();
    await bot.send('?by "raw code" --depth=2');
    expect(optionsError).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls.length).toBe(0);
  });

  it('cannot cancel message routing by returning false from a manual raw collector', async () => {
    let stop: (() => void) | undefined;
    const collect = vi.fn();
    const bot = await FakeBot.create({
      setup(client) {
        client.commands.set([new Collision()] as never);
      },
    });
    bot.client.collectors.create({
      event: 'raw',
      filter: () => true,
      run(_packet, dispose) {
        stop = dispose;
        collect();
        return false;
      },
    });
    cleanup.push(async () => {
      stop?.();
      await bot.client.close();
    });
    ran.mockClear();
    await bot.send('?by 42');
    expect(collect).toHaveBeenCalledTimes(1);
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('gateway veto also removes raw events, message events and collectors, without entering the custom handler', async () => {
    const raw = vi.fn();
    const message = vi.fn();
    const collector = vi.fn();
    const custom = vi.fn();
    class CustomHandler extends HandleCommand {
      override async message(...args: Parameters<HandleCommand['message']>) {
        custom();
        return super.message(...args);
      }
    }
    const plugin = createPlugin({
      name: 'probe',
      register(api) {
        api.gateway.onDispatch((packet, next) =>
          packet.t === 'MESSAGE_CREATE' && packet.d.content.startsWith('?by') ? null : next(),
        );
        api.events.on('raw', raw);
        api.events.on('messageCreate', message);
      },
    });
    const bot = await FakeBot.create({
      clientOptions: { plugins: [plugin] as never },
      setup(client) {
        client.setServices({ handleCommand: CustomHandler });
        client.commands.set([new Collision()] as never);
      },
    });
    cleanup.push(() => bot.client.close());
    bot.client.collectors.create({ event: 'raw', filter: () => true, run: collector });
    const handler = bot.client.handleCommand;
    await bot.send('?by 42');
    expect(bot.client.handleCommand).toBe(handler);
    expect(raw).not.toHaveBeenCalled();
    expect(message).not.toHaveBeenCalled();
    expect(collector).not.toHaveBeenCalled();
    expect(custom).not.toHaveBeenCalled();
    await bot.send('?ping');
    expect(raw).toHaveBeenCalledTimes(1);
    expect(message).toHaveBeenCalledTimes(1);
    expect(collector).toHaveBeenCalledTimes(1);
    expect(custom).toHaveBeenCalledTimes(1);
  });

  it('context scopes can suppress execution, but user argument resolution has already made REST calls', async () => {
    const scope = vi.fn();
    const bot = await FakeBot.create({
      clientOptions: {
        contextScopes: [
          createContextScope(async () => {
            scope();
            return undefined as never;
          }),
        ],
      },
      setup(client) {
        const command = new Collision();
        command.options = [{ ...createUserOption({ description: 'Target', required: true }), name: 'target' }] as never;
        client.commands.set([command] as never);
      },
    });
    cleanup.push(() => bot.client.close());
    ran.mockClear();
    await bot.send('?by js 42; // -target 300000000000000003');
    expect(scope).toHaveBeenCalledTimes(1);
    expect(ran).not.toHaveBeenCalled();
    expect(bot.calls.filter((call) => call.url.startsWith('/users/300000000000000003'))).toHaveLength(1);
  });

  it('a custom argument parser can fail before context scopes are entered', async () => {
    const scope = vi.fn();
    const error = vi.fn();
    class CustomHandler extends HandleCommand {
      override argsParser(..._args: Parameters<HandleCommand['argsParser']>): Record<string, string> {
        throw new Error('custom parser rejects a Byaku expression');
      }
    }
    const bot = await FakeBot.create({
      clientOptions: {
        contextScopes: [
          createContextScope(async (_ctx, next) => {
            scope();
            return next();
          }),
        ],
      },
      setup(client) {
        client.setServices({ handleCommand: CustomHandler });
        const command = new Collision();
        command.onInternalError = error;
        client.commands.set([command] as never);
      },
    });
    cleanup.push(() => bot.client.close());
    const handler = bot.client.handleCommand;
    await bot.send('?by js "raw code" --depth=2');
    expect(bot.client.handleCommand).toBe(handler);
    expect(scope).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
  });
});
