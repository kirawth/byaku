import { describe, expect, it } from 'vitest';

import { Byaku } from '../src/byaku.js';
import { defineMode } from '../src/modes/index.js';
import { FakeBot, type FakeMessage } from './helpers.js';

async function setup(options: ConstructorParameters<typeof Byaku>[1] = {}) {
  const bot = await FakeBot.create();
  const byaku = new Byaku(bot.client, { prefixes: ['?by'], ...options });
  await byaku.install();
  return { bot, byaku };
}

async function run(bot: FakeBot, text: string): Promise<{ trigger: { id: string }; reply: FakeMessage }> {
  const trigger = await bot.send(text);
  const reply = await bot.waitFor(() => bot.reply(trigger.id));
  return { trigger, reply };
}

describe('summary and help', () => {
  it('summary is plain text with versions and a Discord timestamp', async () => {
    const { bot } = await setup();
    const { reply } = await run(bot, '?by');
    expect(reply.content).toMatch(/\*\*Byaku\*\* `v\d/);
    expect(reply.content).toMatch(/<t:\d+:R>/);
    expect(reply.content).not.toContain('```');
  });

  it('help lists modes; help <mode> shows details', async () => {
    const { bot } = await setup();
    const { reply } = await run(bot, '?by help');
    expect(reply.content).toContain('`js`');
    const one = await run(bot, '?by help sh');
    expect(one.reply.content).toContain('Usage: `sh <command>`');
  });

  it('retain and reset manage the eval scope per owner', async () => {
    const { bot } = await setup();
    await run(bot, '?by const kept = 5');
    expect((await run(bot, '?by kept * 2')).reply.content).toContain('10');
    expect((await run(bot, '?by reset')).reply.content).toContain('Cleared 1 variable');
    expect((await run(bot, '?by typeof kept')).reply.content).toContain('ReferenceError');
  });
});

describe('workers on a plain Client', () => {
  it('`all js` and `shard 0 js` run locally; other workers do not exist', async () => {
    const bot = await FakeBot.create();
    const byaku = new Byaku(bot.client, { prefixes: ['?by'] });
    await byaku.install();
    let trigger = await bot.send('?by all js 20 + 22');
    let reply = await bot.waitFor(() => bot.reply(trigger.id));
    expect(reply.content).toMatch(/\[worker 0\] ✅ \d+ ms\n42/);

    trigger = await bot.send('?by shard 3 js 1');
    reply = await bot.waitFor(() => bot.reply(trigger.id));
    expect(reply.content).toContain('There is no worker 3');

    trigger = await bot.send('?by shards');
    reply = await bot.waitFor(() => bot.reply(trigger.id));
    expect(reply.content).toContain('shard');
  });
});

describe('custom modes', () => {
  it('defineMode validates names and fills defaults', () => {
    const mode = defineMode({ name: 'Uptime', aliases: ['UP'], description: 'd', run: () => 'x' });
    expect(mode).toMatchObject({ name: 'uptime', aliases: ['up'], usage: 'uptime', rerunnable: true, examples: [] });
    expect(() => defineMode({ name: 'bad name', description: '', run: () => '' })).toThrow(
      expect.objectContaining({ code: 'INVALID_MODE' }),
    );
  });

  it('a custom mode runs through a trigger and replaces a built-in with the same name', async () => {
    const shout = defineMode({
      name: 'shout',
      aliases: ['yell'],
      description: 'Upper-case',
      run: (ctx) => ctx.input.toUpperCase(),
    });
    const { bot, byaku } = await setup({ modes: [shout] });
    expect((await run(bot, '?by yell hello')).reply.content).toContain('HELLO');
    byaku.register(defineMode({ name: 'shout', description: 'Quiet now', run: (ctx) => ctx.input.toLowerCase() }));
    expect((await run(bot, '?by shout HeLLo')).reply.content).toContain('hello');
  });
});

describe('eval modes through a trigger', () => {
  it('ts runs TypeScript; --emit shows the JavaScript', async () => {
    const { bot } = await setup();
    expect((await run(bot, '?by ts const n: number = 21; return n * 2')).reply.content).toContain('42');
    const emitted = (await run(bot, '?by ts --emit (x as number)')).reply.content;
    expect(emitted).toContain('x');
    expect(emitted).not.toContain(' as number');
    expect((await run(bot, '?by ts const a: = ;')).reply.content).toContain('❌');
  });

  it('jsi describes the value; errors show the stack', async () => {
    const { bot } = await setup();
    expect((await run(bot, '?by jsi new Map([[1, 2]])')).reply.content).toContain('Type:        Map');
    expect((await run(bot, '?by jsi missingName')).reply.content).toContain('ReferenceError');
  });

  it('retain on/off and a bad argument', async () => {
    const { bot } = await setup();
    expect((await run(bot, '?by retain')).reply.content).toContain('**on**');
    expect((await run(bot, '?by retain off')).reply.content).toContain('Each run starts fresh');
    expect((await run(bot, '?by retain maybe')).reply.content).toContain('Use `retain on`');
  });
});
