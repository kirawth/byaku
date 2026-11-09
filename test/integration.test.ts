import { ButtonStyle, ComponentCommand, type ComponentContext, createEvent } from 'seyfert';
import { describe, expect, it, vi } from 'vitest';

import { Byaku } from '../src/byaku.js';
import type { AuditEntry } from '../src/options.js';
import { CHANNEL_ID, DM_CHANNEL_ID, FakeBot, type FakeMessage, STRANGER_ID, TOKEN } from './helpers.js';

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

const messagePosts = (bot: FakeBot) =>
  bot.calls.filter((c) => c.method === 'POST' && /\/channels\/\d+\/messages$/.test(c.url));

describe('prefix trigger → reply', () => {
  it('runs JavaScript and replies with a plain code block (flags 0, no embeds)', async () => {
    const { bot } = await setup();
    const trigger = await bot.send('?by 1 + 1');
    const reply = await bot.waitFor(() => bot.reply(trigger.id));
    expect(reply.content).toMatch(/^```js\n2\n```\n-# ✅ js · \d+ ms · depth 1/);
    const post = messagePosts(bot)[0]!;
    expect(post.body.flags).toBe(0);
    expect(post.body.embeds).toEqual([]);
    expect(post.body.allowed_mentions).toEqual({ parse: [] });
    expect(post.body.message_reference).toMatchObject({ message_id: trigger.id });
    // No Components V2 (containers, text displays) anywhere
    expect(JSON.stringify(post.body.components)).not.toMatch(/"type":(17|10|9|12|14)\b/);
  });

  it('reads the raw text: quotes, colons and -flags inside code survive', async () => {
    const { bot } = await setup();
    const trigger = await bot.send(`?by js --depth=0 ({ "a b": 'x: -y', n: -1 })`);
    const reply = await bot.waitFor(() => bot.reply(trigger.id));
    expect(reply.content).toContain(`'a b': 'x: -y'`);
    expect(reply.content).toContain('depth 0');
  });

  it('is silent for non-owners and audits them as denied', async () => {
    const { bot, audit } = await setup();
    await bot.send('?by 1 + 1', { author: STRANGER_ID });
    await new Promise((r) => setTimeout(r, 100));
    expect(messagePosts(bot)).toHaveLength(0);
    expect(audit).toContainEqual(expect.objectContaining({ action: 'denied', userId: STRANGER_ID, outcome: 'denied' }));
  });

  it('does nothing when disabled', async () => {
    const { bot } = await setup({ advanced: { enabled: false } });
    await bot.send('?by 1 + 1');
    await new Promise((r) => setTimeout(r, 100));
    expect(messagePosts(bot)).toHaveLength(0);
  });

  it('never shows the bot token', async () => {
    const { bot } = await setup();
    const trigger = await bot.send('?by client.rest.options.token');
    const reply = await bot.waitFor(() => bot.reply(trigger.id));
    expect(reply.content).toContain('[redacted — use --unsafe]');
    const t2 = await bot.send('?by [client.rest.options.token, encodeURIComponent(client.rest.options.token)]');
    const r2 = await bot.waitFor(() => bot.reply(t2.id));
    expect(r2.content).not.toContain(TOKEN);
    expect(r2.content).not.toContain(encodeURIComponent(TOKEN));
    for (const call of bot.calls) expect(JSON.stringify(call.body ?? '')).not.toContain(TOKEN.split('.')[2]);
  });

  it('works in DMs, and editing the trigger re-runs it into the same reply', async () => {
    const { bot } = await setup();
    const trigger = await bot.send('?by 40 + 2', { guildId: null });
    const reply = await bot.waitFor(() => bot.reply(trigger.id));
    expect(reply.channel_id).toBe(DM_CHANNEL_ID);
    expect(reply.content).toContain('42');
    await bot.edit(trigger, '?by 40 + 3');
    await bot.waitFor(() => bot.messages.get(reply.id)?.content.includes('43'));
    const patches = bot.calls.filter(
      (c) => c.method === 'PATCH' && c.url === `/channels/${DM_CHANNEL_ID}/messages/${reply.id}`,
    );
    expect(patches.length).toBeGreaterThan(0);
    expect(patches.at(-1)!.body.flags).toBe(0);
    // Only one reply was ever posted
    expect(messagePosts(bot)).toHaveLength(1);
  });

  it('deleting the trigger deletes the reply', async () => {
    const { bot } = await setup();
    const trigger = await bot.send('?by 1');
    const reply = await bot.waitFor(() => bot.reply(trigger.id));
    await bot.remove(trigger);
    await bot.waitFor(() =>
      bot.calls.find((c) => c.method === 'DELETE' && c.url === `/channels/${CHANNEL_ID}/messages/${reply.id}`),
    );
  });
});

describe('the bot keeps working', () => {
  it("collectors don't replace the bot's messageCreate handler; components.set keeps the bot's components", async () => {
    const seen: string[] = [];
    const clicked: string[] = [];
    class BotButton extends ComponentCommand {
      componentType = 'Button' as const;
      override customId = 'bot:hello';
      override async run(ctx: ComponentContext<'Button'>) {
        clicked.push(ctx.customId);
        await ctx.deferUpdate();
      }
    }
    const { bot } = await setup(
      {},
      {
        setup: (client) => {
          client.events.set([
            createEvent({
              data: { name: 'messageCreate' },
              run: (message) => void seen.push(message.content),
            }) as never,
          ]);
          client.components.set([new BotButton()]);
        },
      },
    );
    expect(bot.client.components.commands.some((c) => c instanceof BotButton)).toBe(true);
    expect(bot.client.components.commands.length).toBe(4);

    const trigger = await bot.send('?by 1');
    await bot.waitFor(() => bot.reply(trigger.id));
    await bot.send('hello there');
    expect(seen).toEqual(['?by 1', 'hello there']);

    const own: FakeMessage = {
      id: '999',
      channel_id: CHANNEL_ID,
      content: 'bot message',
      author: { id: '1', username: 'b', discriminator: '0' },
      components: [
        { type: 1, components: [{ type: 2, custom_id: 'bot:hello', style: ButtonStyle.Primary, label: 'Hi' }] },
      ],
    };
    await bot.click(own, { label: 'Hi' });
    expect(clicked).toEqual(['bot:hello']);
  });

  it('install() twice does not register twice', async () => {
    const { bot, byaku } = await setup();
    await byaku.install();
    expect(bot.client.components.commands.length).toBe(3);
    const trigger = await bot.send('?by 1');
    await bot.waitFor(() => bot.reply(trigger.id));
    await new Promise((r) => setTimeout(r, 50));
    expect(messagePosts(bot)).toHaveLength(1);
  });

  it('uninstall() stops listening and leaves the prefix function unchanged', async () => {
    const prefix = vi.fn(() => ['?']);
    const { bot, byaku } = await setup({}, { prefix });
    const before = (bot.client.options.commands as { prefix: unknown }).prefix;
    expect(before).toBe(prefix);
    await byaku.uninstall();
    expect((bot.client.options.commands as { prefix: unknown }).prefix).toBe(prefix);
    await bot.send('?by 1');
    await new Promise((r) => setTimeout(r, 50));
    expect(messagePosts(bot)).toHaveLength(0);
    expect(bot.client.components.commands.length).toBe(0);
  });
});
