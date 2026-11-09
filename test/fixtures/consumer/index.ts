// Type-checks Byaku's published .d.ts files the way a bot uses them.
// scripts/check-package.mjs copies this file into a fresh project and type-checks it with TypeScript 5.4 and 5.9.
import { Client, definePlugins, type UsingClient } from 'seyfert';
import {
  type AuditEntry,
  createByakuClasses,
  defineMode,
  Byaku,
  type ByakuClient,
  ByakuError,
  type ByakuOptions,
  type ModeContext,
  type SessionStore,
} from 'byaku';
import { byakuPlugin } from 'byaku/plugin';

const uptime = defineMode({
  name: 'uptime',
  aliases: ['up'],
  description: 'Process uptime',
  run: (ctx: ModeContext) => `${process.uptime().toFixed(0)} s · ${ctx.author.id}`,
});

declare const redisStore: SessionStore;

const options: ByakuOptions = {
  owners: ['123'],
  prefixes: ['?by'],
  secrets: [process.env.TOKEN],
  scope: { answer: 42 },
  audit: (entry: AuditEntry) => console.log(entry.action, entry.outcome),
  modes: [uptime],
  slash: { guilds: ['456'] },
  advanced: {
    enabled: process.env.BYAKU !== 'false',
    timeouts: { session: '15m', shell: '5m', editRerun: '5m' },
    limits: { pageSize: 1800 },
    shell: { command: 'bash' },
    store: redisStore,
    transpile: (code) => code,
  },
};

export async function oneLine(client: Client): Promise<void> {
  const byaku = new Byaku(client, { owners: ['123'] });
  await byaku.install();
}

export async function withInstall(client: Client): Promise<void> {
  const byaku = new Byaku(client, options);
  await byaku.install();
  byaku.register(uptime);
  const handled: boolean = await byaku.handleMessage({} as never);
  const typed = Object.assign(client, { byaku }) as ByakuClient<typeof client>;
  typed.byaku.disable();
  void handled;

  const { ByakuComponents, ByakuModals, ByakuCommand } = createByakuClasses(byaku);
  void [ByakuComponents, ByakuModals, ByakuCommand];

  try {
    new Byaku(client, { advanced: { timeouts: { shell: 'later' } } });
  } catch (err) {
    if (err instanceof ByakuError && err.code === 'INVALID_OPTION') console.log(err.message);
  }
}

const plugins = definePlugins(byakuPlugin(options));
declare module 'seyfert' {
  interface SeyfertRegistry {
    plugins: typeof plugins;
  }
}

export function withPlugin(): void {
  const client = new Client({ plugins });
  // `byaku` comes from the plugin's client map
  const byaku: Byaku = client.byaku;
  const used: UsingClient = client;
  void byaku.enabled;
  void used;
}
