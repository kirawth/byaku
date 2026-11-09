import { ComponentCommand, type ComponentContext, Transformers } from 'seyfert';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Byaku } from '../src/byaku.js';
import { createByakuClasses, byakuPlugin } from '../src/plugin.js';
import { FakeBot, OWNER_ID } from './helpers.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

const options = {
  owners: [OWNER_ID],
  slash: false,
  advanced: { includeAppOwners: false, prefixGuard: false },
};

class OtherButton extends ComponentCommand {
  componentType = 'Button' as const;
  override customId = 'other';
  override run(ctx: ComponentContext<'Button'>) {
    return ctx.write({ content: 'other handler' });
  }
}

async function reply(bot: FakeBot, text: string) {
  const trigger = await bot.send(text);
  return bot.waitFor(() => bot.reply(trigger.id));
}

function manual(bot: FakeBot, prefixes: string[]) {
  const byaku = new Byaku(bot.client, { ...options, prefixes });
  cleanup.push(() => byaku.uninstall());
  return byaku;
}

describe('public Seyfert lifecycle', () => {
  it('applies plugin components once, removes them on close, and restores them on restart', async () => {
    const bot = await FakeBot.create({
      clientOptions: { plugins: [byakuPlugin({ ...options, prefixes: ['?plugin'] })] as never },
      setup: (client) => void client.components.set([OtherButton]),
    });
    cleanup.push(() => bot.client.close());
    const byaku = (bot.client as unknown as { byaku: Byaku }).byaku;
    const other = manual(bot, ['?manual']);
    await other.install();
    const otherHandlers = bot.client.components.commands.filter((handler) =>
      [other.handlerClasses.ByakuButtons, other.handlerClasses.ByakuSelects, other.handlerClasses.ByakuModal].some(
        (Handler) => handler instanceof Handler,
      ),
    );
    expect(otherHandlers).toHaveLength(3);
    expect(bot.client.collectors.values.get('raw')).toHaveLength(1);
    expect(bot.client.components.commands).toHaveLength(7);

    await byaku.install();
    await byaku.install();
    await bot.client.start({}, false);
    expect(bot.client.components.commands).toHaveLength(7);
    const output = await reply(bot, '?plugin ({ answer: 42 })');
    expect(bot.callbacks(await bot.click(output, { emoji: '✏️' }))).toHaveLength(1);

    await bot.client.close();
    expect(byaku.isInstalled).toBe(false);
    expect(bot.client.components.commands).toHaveLength(4);
    expect(bot.client.components.commands).toEqual(expect.arrayContaining(otherHandlers));
    const stopped = vi.spyOn(byaku, 'handleRaw');
    const remaining = await reply(bot, '?manual 6 * 7');
    expect(remaining.content).toContain('42');
    expect(stopped).not.toHaveBeenCalled();
    expect(bot.callbacks(await bot.click(remaining, { emoji: '✏️' }))).toHaveLength(1);
    expect(
      bot.callbacks(
        await bot.click(
          { ...remaining, components: [{ components: [{ type: 2, custom_id: 'other' }] }] },
          { customId: 'other' },
        ),
      ),
    ).toMatchObject([{ type: 4, data: { content: 'other handler' } }]);

    await bot.client.start({}, false);
    expect(bot.client.components.commands).toHaveLength(7);
    const resumed = await reply(bot, '?plugin 7 * 6');
    expect(resumed.content).toContain('42');
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(bot.callbacks(await bot.click(resumed, { emoji: '✏️' }))).toHaveLength(1);
  });

  it('scopes dispatch subscriptions to their client when a plugin definition is reused', async () => {
    const plugin = byakuPlugin({ ...options, prefixes: ['?plugin'] });
    const first = await FakeBot.create({ clientOptions: { plugins: [plugin] as never } });
    const second = await FakeBot.create({ clientOptions: { plugins: [plugin] as never } });
    cleanup.push(
      () => first.client.close(),
      () => second.client.close(),
    );
    const secondByaku = (second.client as unknown as { byaku: Byaku }).byaku;
    const handle = vi.spyOn(secondByaku, 'handleRaw');
    expect((await reply(first, '?plugin 6 * 7')).content).toContain('42');
    expect(handle).not.toHaveBeenCalled();
    expect(second.messages.size).toBe(0);
    await first.client.close();
    expect((await reply(second, '?plugin 21 * 2')).content).toContain('42');
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('routes message edits and deletes through the plugin dispatch listener', async () => {
    const bot = await FakeBot.create({
      clientOptions: { plugins: [byakuPlugin({ ...options, prefixes: ['?plugin'] })] as never },
    });
    cleanup.push(() => bot.client.close());
    const trigger = await bot.send('?plugin 21');
    const output = await bot.waitFor(() => bot.reply(trigger.id));
    await bot.edit(trigger, '?plugin 6 * 7');
    await bot.waitFor(() => bot.messages.get(output.id)?.content.includes('42'));
    await bot.remove(trigger);
    await bot.waitFor(() => !bot.messages.has(output.id));
  });

  it('uninstall and reinstall deactivate and reuse plugin contributions before client close', async () => {
    const bot = await FakeBot.create({
      clientOptions: { plugins: [byakuPlugin({ ...options, prefixes: ['?plugin'] })] as never },
    });
    cleanup.push(() => bot.client.close());
    const byaku = (bot.client as unknown as { byaku: Byaku }).byaku;
    const output = await reply(bot, '?plugin 42');
    await byaku.uninstall();
    await byaku.uninstall();
    expect(byaku.plugin!.listensToDispatches).toBe(false);
    expect(bot.callbacks(await bot.click(output, { emoji: '✏️' }))).toEqual([]);
    await byaku.install();
    await byaku.install();
    expect(byaku.plugin!.listensToDispatches).toBe(true);
    expect(bot.client.components.commands).toHaveLength(3);
    expect((await reply(bot, '?plugin 21 * 2')).content).toContain('42');
  });

  it('keeps manual instances and their buttons, selects and modals separate', async () => {
    const bot = await FakeBot.create();
    const first = manual(bot, ['?first']);
    const second = manual(bot, ['?second']);
    await first.install();
    await second.install();
    const firstOutput = await reply(bot, '?first ({ answer: 21 })');
    const secondOutput = await reply(bot, '?second ({ answer: 42 })');
    expect(bot.client.components.commands).toHaveLength(6);
    for (const output of [firstOutput, secondOutput]) {
      const selected = await bot.select(output, /:dp$/, ['d2']);
      expect(bot.callbacks(selected)).toMatchObject([{ type: 7 }]);
      const opened = await bot.click(bot.messages.get(output.id)!, { emoji: '✏️' });
      expect(bot.callbacks(opened)).toHaveLength(1);
      const modal = bot.callbacks(opened)[0];
      const submitted = await bot.submitModal(modal.data.custom_id, { code: '40 + 2' }, { message: output });
      expect(bot.callbacks(submitted)).toHaveLength(1);
    }
    await first.uninstall();
    expect(bot.callbacks(await bot.click(firstOutput, { emoji: '✏️' }))).toEqual([]);
    expect(bot.callbacks(await bot.click(secondOutput, { emoji: '✏️' }))).toHaveLength(1);
    await first.install();
    await first.install();
    expect(bot.client.components.commands).toHaveLength(6);
    expect((await reply(bot, '?first 6 * 7')).content).toContain('42');
  });

  it('leaves a manually registered slash command inactive and routes its modal to its own instance', async () => {
    const bot = await FakeBot.create();
    const first = manual(bot, ['?first']);
    const slash = new Byaku(bot.client, { ...options, slash: true, prefixes: ['?slash'] });
    cleanup.push(() => slash.uninstall());
    await first.install();
    await slash.install();
    const opened = await bot.slash('byaku');
    const submitted = await bot.submitModal(bot.callbacks(opened)[0].data.custom_id, { code: '6 * 7' });
    expect(bot.callbacks(submitted)).toHaveLength(1);
    expect(await first.sessions.store.list()).toHaveLength(0);
    expect(await slash.sessions.store.list()).toHaveLength(1);
    await slash.uninstall();
    expect(bot.callbacks(await bot.slash('byaku'))).toEqual([]);
    expect(bot.callbacks(await bot.submitModal(bot.callbacks(opened)[0].data.custom_id, { code: '42' }))).toEqual([]);
    await slash.install();
    expect(bot.client.commands.values.filter((command) => command.name === 'byaku')).toHaveLength(1);
    expect(bot.callbacks(await bot.slash('byaku'))).toHaveLength(1);
  });

  it('stops a never-run collector on its first packet and reuses it if reinstalled earlier', async () => {
    const bot = await FakeBot.create();
    const byaku = manual(bot, ['?manual']);
    await byaku.install();
    await byaku.uninstall();
    await byaku.install();
    expect(bot.client.collectors.values.get('raw')).toHaveLength(1);
    await byaku.uninstall();
    const handle = vi.spyOn(byaku, 'handleRaw');
    await bot.send('?manual 42');
    await bot.waitFor(() => bot.client.collectors.values.get('raw')?.length === 0);
    expect(handle).not.toHaveBeenCalled();
    await byaku.install();
    expect((await reply(bot, '?manual 42')).content).toContain('42');
    await byaku.uninstall();
    expect(bot.client.collectors.values.get('raw')).toHaveLength(0);
  });

  it('keeps unrelated raw collectors when stopping its own collector', async () => {
    const bot = await FakeBot.create();
    let seen = 0;
    let stopOther: (() => void) | undefined;
    bot.client.collectors.create({
      event: 'raw',
      filter: () => true,
      run: (_packet, stop) => {
        seen++;
        stopOther = stop;
      },
    });
    cleanup.push(async () => stopOther?.());
    const byaku = manual(bot, ['?manual']);
    await byaku.install();
    await reply(bot, '?manual 42');
    expect(bot.client.collectors.values.get('raw')).toHaveLength(2);
    await byaku.uninstall();
    expect(bot.client.collectors.values.get('raw')).toHaveLength(1);
    const before = seen;
    await bot.send('hello');
    await bot.waitFor(() => seen > before);
  });

  it('reuses file-registered classes and keeps handleMessage available to a manual router', async () => {
    const bot = await FakeBot.create();
    const byaku = manual(bot, ['?manual']);
    const { ByakuButtons, ByakuSelects, ByakuModal } = createByakuClasses(byaku);
    bot.client.components.set([ByakuButtons, ByakuSelects, ByakuModal]);
    await byaku.install();
    expect(bot.client.components.commands).toHaveLength(3);
    const raw = await bot.send('not a trigger');
    const message = Transformers.Message(bot.client, { ...raw, content: '?manual 42' });
    expect(await byaku.handleMessage(message)).toBe(true);
    const output = bot.reply(raw.id)!;
    expect(output.content).toContain('42');
    expect(await byaku.handleMessage(Transformers.Message(bot.client, raw))).toBe(false);
    expect(bot.callbacks(await bot.click(output, { emoji: '✏️' }))).toHaveLength(1);
    await byaku.uninstall();
    expect(bot.client.components.commands).toHaveLength(3);
    expect(bot.callbacks(await bot.click(output, { emoji: '✏️' }))).toEqual([]);
  });
});
