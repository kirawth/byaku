import { type Command, createPlugin, type SeyfertPlugin, type UsingClient } from 'seyfert';

import { Byaku } from './byaku.js';
import { createSlashCommand, type ByakuHandlerClasses } from './handlers.js';
import { errorMessage } from './inspect.js';
import type { ByakuOptions } from './options.js';

interface RestRecord {
  at: number;
  method: string;
  route: string;
  status?: number;
  ms?: number;
  ratelimited?: boolean;
}

interface CommandEvent {
  at: number;
  kind: 'beforeMiddlewares' | 'middlewaresError' | 'runError' | 'afterRun';
  command?: string;
  messageId?: string;
  error?: string;
  middleware?: string;
  scope?: string;
}

interface Dispatch {
  t: string;
  d: unknown;
  shardId: number;
}

/** @internal What the plugin collects from Seyfert's hooks, for modes such as `debug`, `rest` and `events`. */
export class ByakuPluginBridge {
  /** The last 200 REST calls, newest last. */
  readonly rest: RestRecord[] = [];
  private readonly commandListeners = new Set<(event: CommandEvent) => void>();
  private readonly dispatchListeners = new Set<(packet: Dispatch) => void>();

  get listensToDispatches(): boolean {
    return this.dispatchListeners.size > 0;
  }

  recordRest(record: RestRecord): void {
    this.rest.push(record);
    if (this.rest.length > 200) this.rest.shift();
  }

  emitCommand(event: CommandEvent): void {
    for (const listener of this.commandListeners) listener(event);
  }

  onCommand(listener: (event: CommandEvent) => void): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }

  emitDispatch(packet: Dispatch): void {
    for (const listener of this.dispatchListeners) listener(packet);
  }

  onDispatch(listener: (packet: Dispatch) => void): () => void {
    this.dispatchListeners.add(listener);
    return () => this.dispatchListeners.delete(listener);
  }
}

function commandIds(ctx: unknown) {
  const { fullCommandName, message } = ctx as { fullCommandName?: string; message?: { id?: string } };
  return {
    ...(fullCommandName ? { command: fullCommandName } : {}),
    ...(message?.id ? { messageId: message.id } : {}),
  };
}

/**
 * Byaku as a Seyfert plugin: adds `client.byaku`, installs it when the client starts, and feeds the modes
 * that need Seyfert's command, REST and gateway hooks.
 *
 * @example
 * const plugins = definePlugins(byakuPlugin({ owners: ['123456789012345678'] }));
 * declare module 'seyfert' {
 *   interface SeyfertRegistry { plugins: typeof plugins }
 * }
 * const client = new Client({ plugins });
 */
/**
 * The plugin's type is written out: inferring it would loop through `SeyfertRegistry`, which bots point back at
 * their own plugin list.
 */
export type ByakuPlugin = Omit<SeyfertPlugin<{ byaku: Byaku }>, 'meta'> & { readonly name: 'byaku' };

export function byakuPlugin(options: ByakuOptions = {}): ByakuPlugin {
  const bridge = new ByakuPluginBridge();
  const instances = new WeakMap<object, Byaku>();
  const byakuFor = (client: object) => {
    let byaku = instances.get(client);
    if (!byaku) {
      byaku = new Byaku(client as UsingClient, options);
      byaku.plugin = bridge;
      instances.set(client, byaku);
    }
    return byaku;
  };

  return createPlugin({
    name: 'byaku',
    client: { byaku: (client): Byaku => byakuFor(client) },
    register(api) {
      const started = new WeakMap<object, number>();
      const elapsed = (request: object) => {
        const at = started.get(request);
        return at === undefined ? {} : { ms: Date.now() - at };
      };
      api.rest.observe({
        onRequest: (p) => void started.set(p.request, Date.now()),
        onSuccess: (p) =>
          bridge.recordRest({
            at: Date.now(),
            method: p.method,
            route: p.url,
            status: p.response.status,
            ...elapsed(p.request),
          }),
        onFail: (p) =>
          bridge.recordRest({
            at: Date.now(),
            method: p.method,
            route: p.url,
            ...(p.statusCode ? { status: p.statusCode } : {}),
            ...elapsed(p.request),
          }),
        onRatelimit: (p) =>
          bridge.recordRest({ at: Date.now(), method: p.method, route: p.url, status: 429, ratelimited: true }),
      });

      api.commands.observe({
        onBeforeMiddlewares: (ctx) =>
          bridge.emitCommand({ at: Date.now(), kind: 'beforeMiddlewares', ...commandIds(ctx) }),
        onMiddlewaresError: (ctx, error, meta) =>
          bridge.emitCommand({
            at: Date.now(),
            kind: 'middlewaresError',
            error,
            middleware: meta.middleware,
            scope: meta.scope,
            ...commandIds(ctx),
          }),
        onRunError: (ctx, error) =>
          bridge.emitCommand({ at: Date.now(), kind: 'runError', error: errorMessage(error), ...commandIds(ctx) }),
        onAfterRun: (ctx, error) =>
          bridge.emitCommand({
            at: Date.now(),
            kind: 'afterRun',
            ...(error ? { error: errorMessage(error) } : {}),
            ...commandIds(ctx),
          }),
      });

      api.gateway.onDispatch((packet, next, meta) => {
        if (bridge.listensToDispatches) bridge.emitDispatch({ t: packet.t, d: packet.d, shardId: meta.shardId });
        return next();
      });
    },
    setup: async (client, api) => {
      const byaku = byakuFor(client);
      if (byaku.options.slash) {
        api?.commands.add(createSlashCommand(byaku), { guilds: byaku.options.slash.guilds ?? [] });
      }
      await byaku.install();
    },
    teardown: async (client) => instances.get(client)?.uninstall(),
  });
}

/**
 * Seyfert classes for bots that load components and commands from files. `install()` notices them and
 * doesn't add its own.
 *
 * @example
 * // src/components/byaku.ts
 * export default createByakuClasses(byaku).ByakuComponents;
 */
export function createByakuClasses(byaku: Byaku): ByakuHandlerClasses & { ByakuCommand: new () => Command } {
  return { ...byaku.handlerClasses, ByakuCommand: createSlashCommand(byaku) };
}
