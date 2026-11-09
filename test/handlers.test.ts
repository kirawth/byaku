import { describe, expect, it } from 'vitest';

import { Byaku } from '../src/byaku.js';
import type { AuditEntry } from '../src/options.js';
import { CHANNEL_ID, FakeBot, type FakeMessage, OWNER_ID, STRANGER_ID } from './helpers.js';

async function setup(
  options: ConstructorParameters<typeof Byaku>[1] = {},
  botOptions: Parameters<typeof FakeBot.create>[0] = {},
) {
  const audit: AuditEntry[] = [];
  const bot = await FakeBot.create(botOptions);
  const byaku = new Byaku(bot.client, {
    prefixes: ['?by'],
    audit: (e) => void audit.push(e),
    ...options,
  });
  await byaku.install();
  return { bot, byaku, audit };
}

async function run(
  bot: FakeBot,
  text: string,
  author = OWNER_ID,
): Promise<{ trigger: { id: string }; reply: FakeMessage }> {
  const trigger = await bot.send(text, { author });
  const reply = await bot.waitFor(() => bot.reply(trigger.id));
  return { trigger, reply };
}

const current = (bot: FakeBot, m: FakeMessage) => bot.messages.get(m.id)!;
const isWindows = process.platform === 'win32';

describe('pager (buttons found by emoji)', () => {
  it('turns pages with ⏮️ ◀️ ▶️ ⏭️ and the counter opens "Go to page"', async () => {
    const { bot } = await setup();
    const { reply } = await run(bot, `?by Array.from({ length: 1200 }, (_, i) => 'line ' + i).join('\\n')`);
    expect(reply.content).toContain('page 1/');
    const total = Number(/page 1\/(\d+)/.exec(reply.content)![1]);
    expect(total).toBeGreaterThan(2);

    let token = await bot.click(current(bot, reply), { emoji: '▶️' });
    expect(bot.callbacks(token)[0]).toMatchObject({ type: 7 });
    expect(current(bot, reply).content).toContain(`page 2/${total}`);

    await bot.click(current(bot, reply), { emoji: '⏭️' });
    expect(current(bot, reply).content).toContain(`page ${total}/${total}`);
    await bot.click(current(bot, reply), { emoji: '⏮️' });
    expect(current(bot, reply).content).toContain(`page 1/${total}`);

    // Counter → modal (callback type 9) → submit → deferUpdate (6) + edit @original
    token = await bot.click(current(bot, reply), { label: `1 / ${total}` });
    const modal = bot.callbacks(token)[0];
    expect(modal.type).toBe(9);
    const submit = await bot.submitModal(modal.data.custom_id, { page: '3' }, { message: current(bot, reply) });
    expect(bot.callbacks(submit)[0]).toMatchObject({ type: 6 });
    expect(bot.calls.some((c) => c.method === 'PATCH' && c.url.includes(`/${submit}/messages/@original`))).toBe(true);
    expect(current(bot, reply).content).toContain(`page 3/${total}`);
  });

  it('a non-owner pressing a button gets a private refusal and nothing changes', async () => {
    const { bot, audit } = await setup();
    const { reply } = await run(bot, `?by Array.from({ length: 1200 }, (_, i) => 'line ' + i).join('\\n')`);
    const before = current(bot, reply).content;
    const token = await bot.click(current(bot, reply), { emoji: '▶️' }, STRANGER_ID);
    expect(bot.callbacks(token)[0]).toMatchObject({
      type: 4,
      data: { flags: 64, content: 'These controls belong to someone else.' },
    });
    expect(current(bot, reply).content).toBe(before);
    expect(audit).toContainEqual(expect.objectContaining({ action: 'denied', userId: STRANGER_ID }));
  });
});

describe('actions', () => {
  it('🔁 re-runs into the same message and 🔀 Diff shows what changed', async () => {
    const { bot } = await setup();
    const { reply } = await run(bot, '?by globalThis.__byakuCounter = (globalThis.__byakuCounter ?? 0) + 1');
    expect(reply.content).toContain('```js\n1\n```');
    const token = await bot.click(current(bot, reply), { emoji: '🔁' });
    expect(bot.callbacks(token)[0]).toMatchObject({ type: 6 });
    await bot.waitFor(() => current(bot, reply).content.includes('```js\n2\n```'));
    const diff = await bot.click(current(bot, reply), { label: 'Diff' });
    const answer = bot.callbacks(diff)[0];
    expect(answer.data.flags).toBe(64);
    expect(answer.data.content).toContain('- 1\n+ 2');
  });

  it('✏️ Edit & run opens a pre-filled modal and runs the new code in place', async () => {
    const { bot } = await setup();
    const { reply } = await run(bot, '?by 6 * 7');
    const token = await bot.click(current(bot, reply), { emoji: '✏️' });
    const modal = bot.callbacks(token)[0];
    expect(modal.type).toBe(9);
    expect(JSON.stringify(modal.data)).toContain('6 * 7');
    await bot.submitModal(modal.data.custom_id, { code: '6 * 8' }, { message: current(bot, reply) });
    await bot.waitFor(() => current(bot, reply).content.includes('48'));
  });

  it('📄 sends a file, 📋 raw text, 📌 keeps, ⏹️ removes controls', async () => {
    const { bot, byaku } = await setup();
    const { reply } = await run(bot, '?by "hello ```world```"');
    expect(reply.content).not.toContain('hello ```world');

    const file = await bot.click(current(bot, reply), { emoji: '📄' });
    const fileCall = bot.calls.find((c) => c.url.includes(`/${file}/callback`))!;
    expect(fileCall.files?.length).toBe(1);

    const raw = await bot.click(current(bot, reply), { emoji: '📋' });
    expect(bot.callbacks(raw)[0].data.content).toBe('hello ```world```');

    await bot.click(current(bot, reply), { emoji: '📌' });
    const session = (await byaku.sessions.store.list())[0]!;
    expect(session.pinned).toBe(true);
    expect(current(bot, reply).content).toContain('📌 kept');

    await bot.click(current(bot, reply), { emoji: '⏹️' });
    expect(current(bot, reply).components).toEqual([]);
    expect(await byaku.sessions.store.list()).toHaveLength(0);
  });

  it('🗑️ deletes the reply and the trigger', async () => {
    const { bot } = await setup();
    const { trigger, reply } = await run(bot, '?by 1');
    await bot.click(current(bot, reply), { emoji: '🗑️' });
    await bot.waitFor(() => bot.calls.some((c) => c.method === 'DELETE' && c.url.endsWith(`/messages/${trigger.id}`)));
    expect(bot.calls.some((c) => c.method === 'DELETE' && c.url.endsWith(`/messages/${reply.id}`))).toBe(true);
  });

  it('expired sessions answer politely; Delete and Remove still work', async () => {
    const { bot, byaku } = await setup({ advanced: { timeouts: { session: 1 } } });
    const { reply } = await run(bot, '?by 1');
    await new Promise((r) => setTimeout(r, 20));
    await byaku.sessions.sweep();
    // The sweep removed the buttons; an old copy of the message still has them
    expect(current(bot, reply).components).toEqual([]);
    const token = await bot.click(reply, { emoji: '🔁' });
    expect(bot.callbacks(token)[0]).toMatchObject({
      type: 4,
      data: { flags: 64, content: 'This session has ended. Run the command again.' },
    });
    await bot.click(reply, { emoji: '🗑️' });
    expect(bot.calls.some((c) => c.method === 'DELETE' && c.url.endsWith(`/messages/${reply.id}`))).toBe(true);
  });
});

describe('object explorer', () => {
  it('opens keys from the select, shows a breadcrumb, and goes back without re-running', async () => {
    const { bot, audit } = await setup();
    globalThis.__byakuRuns = 0;
    const { reply } = await run(
      bot,
      '?by (globalThis.__byakuRuns++, { cache: { guilds: new Map([["111", { name: "Guild A" }]]) }, list: [1, 2] })',
    );
    const options = bot.findSelect(current(bot, reply), /:xk$/)!.options as { label: string; value: string }[];
    expect(options.map((o) => o.label)).toEqual(['cache', 'list']);

    await bot.select(current(bot, reply), /:xk$/, ['k0']);
    expect(current(bot, reply).content).toContain('result › cache');
    await bot.select(current(bot, reply), /:xk$/, ['k0']);
    expect(current(bot, reply).content).toContain('result › cache › guilds');
    expect(current(bot, reply).content).toContain("'111' =>");
    await bot.select(current(bot, reply), /:xk$/, ['k0']);
    expect(current(bot, reply).content).toContain("name: 'Guild A'");

    await bot.click(current(bot, reply), { emoji: '⬅️' });
    expect(current(bot, reply).content).toContain('result › cache › guilds');
    await bot.click(current(bot, reply), { emoji: '🏠' });
    expect(current(bot, reply).content).not.toContain('result ›');
    expect(globalThis.__byakuRuns).toBe(1);
    expect(audit.filter((e) => e.action === 'explore').length).toBe(5);
  });

  it('depth select and the hidden/getters toggle work on the kept value', async () => {
    const { bot } = await setup();
    const { reply } = await run(bot, '?by ({ a: { b: { c: { d: 1 } } }, get g() { return 42 } })');
    expect(current(bot, reply).content).toContain('[Object]');
    await bot.select(current(bot, reply), /:dp$/, ['d4']);
    expect(current(bot, reply).content).toContain('d: 1');
    expect(current(bot, reply).content).toContain('depth 4');
    expect(current(bot, reply).content).toContain('[Getter]');
    await bot.select(current(bot, reply), /:dp$/, ['h']);
    expect(current(bot, reply).content).toContain('42');
  });

  it('getters are listed but only open with getters on', async () => {
    const { bot } = await setup();
    const { reply } = await run(bot, '?by new (class A { get value() { return 7 } })()');
    const options = bot.findSelect(current(bot, reply), /:xk$/)!.options as { label: string; value: string }[];
    const getter = options.find((o) => o.label === 'value')!;
    const token = await bot.select(current(bot, reply), /:xk$/, [getter.value]);
    expect(bot.callbacks(token)[0].data.content).toContain('is a getter');
  });

  it('pages long key lists (23 keys + more)', async () => {
    const { bot } = await setup();
    const { reply } = await run(bot, '?by Object.fromEntries(Array.from({ length: 60 }, (_, i) => ["k" + i, i]))');
    let options = bot.findSelect(current(bot, reply), /:xk$/)!.options as { value: string }[];
    expect(options).toHaveLength(24);
    expect(options.at(-1)!.value).toBe('kn');
    await bot.select(current(bot, reply), /:xk$/, ['kn']);
    options = bot.findSelect(current(bot, reply), /:xk$/)!.options as { value: string }[];
    expect(options[0]!.value).toBe('kp');
    expect(options[1]!.value).toBe('k23');
  });
});

describe('live shell', () => {
  it('streams output and ends with the exit code', async () => {
    const { bot } = await setup();
    const { reply } = await run(bot, '?by sh echo byaku-live');
    await bot.waitFor(() => /exit 0/.test(current(bot, reply).content), 15_000);
    expect(current(bot, reply).content).toMatch(/^```ansi\n\$ echo byaku-live\n[\s\S]*byaku-live/);
    // Finished: standard controls are back
    expect(bot.findButton(current(bot, reply), { emoji: '🔁' })).toBeDefined();
  });

  it('⏹️ Kill stops the command and its children', async () => {
    const { bot, audit } = await setup();
    const cmd = isWindows ? 'ping -n 60 127.0.0.1' : 'sleep 60';
    const { reply } = await run(bot, `?by sh ${cmd}`);
    expect(reply.content).toContain('⏳');
    const kill = bot.findButton(current(bot, reply), { label: 'Kill' });
    expect(kill?.emoji?.name).toBe('⏹️');
    await new Promise((r) => setTimeout(r, isWindows ? 1500 : 200));
    const started = Date.now();
    await bot.click(current(bot, reply), { label: 'Kill' });
    await bot.waitFor(() => current(bot, reply).content.includes('[killed]'), 5000);
    expect(Date.now() - started).toBeLessThan(2500 + 1300);
    expect(audit).toContainEqual(expect.objectContaining({ action: 'run', mode: 'sh', outcome: 'killed' }));
  });

  it('📝 sends input to stdin', async () => {
    const { bot } = await setup();
    const cmd = isWindows ? '$l = [Console]::In.ReadLine(); Write-Output "got:$l"' : 'read l; echo "got:$l"';
    const { reply } = await run(bot, `?by sh ${cmd}`);
    const token = await bot.click(current(bot, reply), { label: 'Send input' });
    const modal = bot.callbacks(token)[0];
    expect(modal.type).toBe(9);
    await bot.submitModal(modal.data.custom_id, { stdin: 'hello' }, { message: current(bot, reply) });
    await bot.waitFor(() => current(bot, reply).content.includes('got:hello'), 15_000);
  });
});

describe('confirm guard', () => {
  it('asks before risky input; Cancel stops, Confirm runs; --yes skips', async () => {
    const { bot } = await setup();
    const { reply } = await run(bot, '?by process.exit(0) && 1');
    expect(reply.content).toContain('stops the bot process');
    await bot.click(current(bot, reply), { label: 'Cancel' });
    expect(current(bot, reply).content).toContain('Cancelled');

    const second = await run(bot, '?by sh rm -rf ./definitely-not-here-byaku');
    await bot.click(current(bot, second.reply), { label: 'Confirm' });
    await bot.waitFor(() => /exit \d|\[failed/.test(current(bot, second.reply).content), 15_000);

    const third = await run(bot, '?by --yes "process.exit(0)" && 3');
    expect(third.reply.content).toContain('3');
  });
});

declare global {
  var __byakuRuns: number;
  var __byakuCounter: number | undefined;
}

void CHANNEL_ID;
