import { type ActionRow, Button } from 'seyfert';
import { describe, expect, it } from 'vitest';

import { Byaku } from '../src/byaku.js';
import { button, customId, parseCustomId, renderSession } from '../src/view.js';
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

describe('custom ids', () => {
  it('round-trip and stay under 100 characters', () => {
    const id = customId('abc123defg', 'xk');
    expect(id).toBe('by1:abc123defg:xk');
    expect(parseCustomId(id)).toEqual({ version: 1, sid: 'abc123defg', action: 'xk' });
    expect(parseCustomId('by1:new:M:code:js:e')).toEqual({ version: 1, sid: 'new', action: 'M', arg: 'code:js:e' });
    expect(parseCustomId('other:thing')).toBeUndefined();
    expect(() => customId('x', 'raw', 'y'.repeat(100))).toThrow(
      expect.objectContaining({ code: 'CUSTOM_ID_TOO_LONG' }),
    );
  });
});

describe('emoji buttons', () => {
  it('a plain-string emoji works; an emoji object without an id throws INVALID_EMOJI in Seyfert 5.2', () => {
    expect(() => new Button().setEmoji({ name: '⏮️' } as never)).toThrow(/emoji/i);
    expect(button('s', 'f', '⏮️').toJSON()).toMatchObject({ emoji: { name: '⏮️' }, custom_id: 'by1:s:f' });
  });

  it('every row Byaku renders builds through Seyfert and keeps Discord limits', async () => {
    const { bot, byaku } = await setup();
    const { reply } = await run(
      bot,
      `?by ({ big: ${'"' + 'x'.repeat(9000) + '"'}, nested: { a: 1, b: [1, 2] }, map: new Map([['k', 1]]) })`,
    );
    const session = (await byaku.sessions.store.list())[0]!;
    session.previousOutput = 'old';
    session.pinned = true;
    session.view.path = [{ kind: 'prop', key: 'nested' }];
    const body = renderSession(session, { rerunnable: true, hasValue: true, entries: [] });
    const json = body.components.map((r) => (r as ActionRow).toJSON());
    expect(json.length).toBeLessThanOrEqual(5);
    for (const row of json) {
      expect(row.components.length).toBeLessThanOrEqual(5);
      for (const c of row.components as { custom_id?: string; emoji?: { name: string }; options?: unknown[] }[]) {
        expect((c.custom_id ?? '').length).toBeLessThanOrEqual(100);
        if (c.emoji) expect(typeof c.emoji.name).toBe('string');
        if (c.options) expect(c.options.length).toBeLessThanOrEqual(25);
      }
    }
    expect(body.content.length).toBeLessThanOrEqual(2000);
    expect(reply.content.length).toBeLessThanOrEqual(2000);
  });
});
