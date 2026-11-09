import {
  AttachmentBuilder,
  type AutocompleteInteraction,
  Command,
  type CommandContext,
  ComponentCommand,
  type ComponentContext,
  createBooleanOption,
  createStringOption,
  InteractionContextType,
  type MessageStructure,
  ModalCommand,
  type ModalContext,
} from 'seyfert';

import type { Byaku } from './byaku.js';
import { MAX_DEPTH } from './inspect.js';
import type { AuditEntry } from './options.js';
import { codeBlock, diffLines, escapeFences, truncate } from './output.js';
import type { Session } from './session.js';
import { codeModal, editModal, gotoModal, ID_PATTERN, INPUT, parseCustomId, plainBody, stdinModal } from './view.js';

type ButtonOrSelect = ComponentContext<'Button'> | ComponentContext<'StringSelect'>;

/** Marks Byaku's handler instances; Seyfert runs every matching component command, so they must not be added twice. */
const BYAKU_HANDLER = Symbol.for('byaku.handler');

export function isByakuHandler(value: unknown): boolean {
  return typeof value === 'object' && value !== null && BYAKU_HANDLER in value;
}

function deny(ctx: ButtonOrSelect | ModalContext, content: string): Promise<unknown> {
  return ctx.write({ content, flags: 64, allowed_mentions: { parse: [] } } as never).catch(() => undefined);
}

function whereOf(ctx: ButtonOrSelect | ModalContext) {
  return { channelId: ctx.channelId, ...(ctx.guildId ? { guildId: ctx.guildId } : {}) };
}

/** Owner check shared by buttons and modals: Byaku on, an owner, and the owner of this session. */
async function allowed(
  byaku: Byaku,
  ctx: ButtonOrSelect | ModalContext,
  session: Session | undefined,
  sid: string,
): Promise<boolean> {
  const userId = ctx.author.id;
  if (byaku.enabled && (await byaku.isOwner(userId)) && (!session || session.ownerId === userId)) return true;
  byaku.audit({ action: 'denied', userId, outcome: 'denied', sessionId: sid, ...whereOf(ctx) });
  return false;
}

async function handleComponent(byaku: Byaku, ctx: ButtonOrSelect): Promise<unknown> {
  const id = parseCustomId(ctx.customId);
  if (!id) return;
  const userId = ctx.author.id;
  const session = id.sid === 'new' ? undefined : await byaku.sessions.get(id.sid);
  if (!(await allowed(byaku, ctx, session, id.sid))) return deny(ctx, 'These controls belong to someone else.');
  if (id.version !== 1) return deny(ctx, 'These controls are from an older Byaku version. Run the command again.');

  const audit = (action: string, extra: Partial<AuditEntry> = {}) =>
    byaku.audit({ action, mode: session?.mode, userId, sessionId: id.sid, outcome: 'ok', ...whereOf(ctx), ...extra });

  // Delete and Remove still work on old messages whose session has ended
  if (!session) {
    if (id.action === 'd') {
      await ctx.deferUpdate();
      await ctx.interaction.message?.delete().catch(() => undefined);
      return audit('delete');
    }
    if (id.action === 'x') {
      await ctx.update({ components: [] } as never);
      return audit('remove-controls');
    }
    return deny(ctx, 'This session has ended. Run the command again.');
  }

  session.interactionToken = ctx.interaction.token;
  session.data.tokenAt = Date.now();
  await byaku.sessions.touch(session);
  const update = async () => {
    await byaku.sessions.save(session);
    await ctx.update(byaku.render(session) as never);
  };
  const reply = (body: object) => ctx.write({ flags: 64, allowed_mentions: { parse: [] }, ...body } as never);
  const value = (ctx.interaction as { values?: string[] }).values?.[0] ?? '';

  switch (id.action) {
    case 'f':
    case 'p':
    case 'n':
    case 'l': {
      const last = session.pages.length - 1;
      const step = { f: -Infinity, p: -1, n: 1, l: Infinity }[id.action];
      session.page = Math.max(0, Math.min(last, session.page + step));
      audit('page', { details: { page: session.page + 1 } });
      return update();
    }
    case 'g':
      return ctx.modal(gotoModal(session));
    case 'e':
      return ctx.modal(editModal(session));
    case 'in':
      return ctx.modal(stdinModal(session));
    case 'r':
      await ctx.deferUpdate();
      return byaku.rerun(session, userId, String(session.data.raw), 'rerun');
    case 'fi': {
      audit('file');
      const ext = ['js', 'ts', 'json'].includes(session.lang) ? session.lang : 'txt';
      const file = new AttachmentBuilder()
        .setName(`byaku-${session.mode}.${ext}`)
        .setFile('buffer', Buffer.from(session.output));
      return reply({
        content: `-# ${session.mode} · ${session.output.length.toLocaleString('en-US')} characters`,
        files: [file],
      });
    }
    case 'raw': {
      audit('raw');
      const page = session.data.text === true ? session.output : (session.pages[session.page] ?? '').replace(/‍/g, '');
      if (page.length <= 1990) return reply({ content: page || ' ' });
      return reply({
        files: [new AttachmentBuilder().setName('byaku-page.txt').setFile('buffer', Buffer.from(page))],
      });
    }
    case 'df': {
      audit('diff');
      const diff = diffLines(session.previousOutput ?? '', session.output);
      return reply({
        content: `${codeBlock(truncate(escapeFences(diff.text), 1900), 'diff')}\n-# +${diff.added} −${diff.removed}`,
      });
    }
    case 'x':
      audit('remove-controls');
      await byaku.endSession(session, 'controls removed');
      return ctx.update({ components: [] } as never);
    case 'd':
      audit('delete');
      await ctx.deferUpdate();
      await byaku.endSession(session, 'deleted');
      await ctx.interaction.message
        ?.delete()
        .catch(() =>
          session.replyId
            ? byaku.client.messages.delete(session.replyId, session.channelId).catch(() => undefined)
            : undefined,
        );
      if (session.triggerId)
        await byaku.client.messages.delete(session.triggerId, session.channelId).catch(() => undefined);
      return;
    case 'pin':
      await byaku.sessions.pin(session, !session.pinned);
      audit(session.pinned ? 'pin' : 'unpin');
      return update();
    case 'k':
    case 'st':
      audit(id.action === 'k' ? 'kill' : 'stop');
      session.data.killed = id.action === 'k';
      byaku.sessions.live(session.id).abort.abort(new Error('killed'));
      return ctx.deferUpdate();
    case 'ps':
    case 'rs': {
      if (session.live) session.live.paused = id.action === 'ps';
      audit(id.action === 'ps' ? 'pause' : 'resume');
      const live = byaku.lives.get(session.id);
      if (id.action === 'rs' && live) session.output = byaku.redact(live.options.render());
      return update();
    }
    case 'ok':
      audit('confirm');
      await ctx.deferUpdate();
      return byaku.rerun(session, userId, String(session.data.raw), 'confirm', true);
    case 'no':
      audit('cancel', { outcome: 'cancelled' });
      await byaku.endSession(session, 'cancelled');
      return ctx.update(plainBody(`-# ✖️ Cancelled: ${session.mode}`, [], session.ephemeral) as never);
    case 'dp':
      if (value === 'h') {
        const on = !(session.view.hidden || session.view.getters);
        Object.assign(session.view, { hidden: on, getters: on });
        audit('hidden', { details: { on } });
      } else if (/^d\d$/.test(value)) {
        session.view.depth = Math.min(MAX_DEPTH, Number(value.slice(1)));
        audit('depth', { details: { depth: session.view.depth } });
      }
      session.page = 0;
      byaku.refreshValue(session);
      return update();
    case 'xk': {
      const entries = byaku.refreshValue(session);
      if (value === 'kp' || value === 'kn') {
        session.view.keyPage = Math.max(0, session.view.keyPage + (value === 'kn' ? 1 : -1));
        return update();
      }
      const entry = entries[Number(value.slice(1))];
      if (!entry) return deny(ctx, 'That key is no longer there.');
      if (entry.getter && !session.view.getters) {
        return deny(
          ctx,
          `"${entry.label}" is a getter. Turn on "Show hidden keys and getters" in the depth menu to open it.`,
        );
      }
      Object.assign(session.view, { path: [...session.view.path, entry.step], keyPage: 0 });
      session.page = 0;
      byaku.refreshValue(session);
      audit('explore', { details: { depth: session.view.path.length } });
      return update();
    }
    case 'xb':
    case 'xr':
      Object.assign(session.view, { path: id.action === 'xr' ? [] : session.view.path.slice(0, -1), keyPage: 0 });
      session.page = 0;
      byaku.refreshValue(session);
      audit('explore', { details: { depth: session.view.path.length } });
      return update();
    default:
      return deny(ctx, 'Unknown control.');
  }
}

function inputValue(ctx: ModalContext, name: string): string {
  const value = ctx.getInputValue(name);
  return Array.isArray(value) ? value.join('\n') : (value ?? '');
}

async function handleModal(byaku: Byaku, ctx: ModalContext): Promise<unknown> {
  const id = parseCustomId(ctx.customId);
  if (id?.action !== 'M') return;
  const kind = id.arg ?? '';
  const session = id.sid === 'new' ? undefined : await byaku.sessions.get(id.sid);
  if (!(await allowed(byaku, ctx, session, id.sid))) return deny(ctx, 'This belongs to someone else.');
  if (kind.startsWith('code:')) return runCodeModal(byaku, ctx, kind);
  if (!session) return deny(ctx, 'This session has ended. Run the command again.');

  session.interactionToken = ctx.interaction.token;
  session.data.tokenAt = Date.now();
  const audit = (action: string, extra: Partial<AuditEntry> = {}) =>
    byaku.audit({
      action,
      mode: session.mode,
      userId: ctx.author.id,
      sessionId: session.id,
      outcome: 'ok',
      ...whereOf(ctx),
      ...extra,
    });

  if (kind === 'g') {
    const page = Number.parseInt(inputValue(ctx, INPUT.page), 10);
    if (!Number.isFinite(page)) return deny(ctx, `Type a page number from 1 to ${session.pages.length}.`);
    session.page = Math.max(0, Math.min(session.pages.length - 1, page - 1));
    await byaku.sessions.touch(session);
    audit('page');
    // A modal opened from a button edits that button's message with deferUpdate + editResponse
    await ctx.deferUpdate();
    return ctx.editResponse(byaku.render(session) as never);
  }
  if (kind === 'e') {
    const code = inputValue(ctx, INPUT.code).trim();
    if (!code) return deny(ctx, 'Nothing to run.');
    await ctx.deferUpdate();
    return byaku.rerun(session, ctx.author.id, `${session.mode} ${code}`, 'edit-run');
  }
  if (kind === 'in') {
    const onInput = byaku.lives.get(session.id)?.options.onInput;
    if (!onInput) return deny(ctx, 'The command is no longer running.');
    const text = inputValue(ctx, INPUT.stdin);
    onInput(`${text}\n`);
    audit('stdin', { codeLength: text.length });
    return ctx.deferUpdate();
  }
  return deny(ctx, 'Unknown form.');
}

async function runCodeModal(byaku: Byaku, ctx: ModalContext, kind: string): Promise<unknown> {
  const [, mode = 'js', visibility = 'e'] = kind.split(':');
  let code = inputValue(ctx, INPUT.code).trim();
  const file = ctx.getFiles(INPUT.file)?.[0];
  if (!code && file) {
    if (!/\.(m?js|cjs|ts|mts|cts|txt|sh)$/i.test(file.filename)) return deny(ctx, 'Upload a .js or .ts file.');
    if (file.size > 1_048_576) return deny(ctx, 'The file is larger than 1 MB.');
    code = await fetch(file.url, { signal: AbortSignal.timeout(15_000) }).then((r) => r.text());
  }
  if (!code) return deny(ctx, 'Type some code or upload a file.');
  return byaku.run({
    ownerId: ctx.author.id,
    ...whereOf(ctx),
    text: `${mode} ${code}`,
    delivery: { kind: 'modal', ctx },
    ephemeral: visibility === 'e',
    interactionToken: ctx.interaction.token,
  });
}

/** As a slash command it opens the code modal; as a prefix command it runs the text like a trigger. */
async function handleCommand(byaku: Byaku, ctx: CommandContext): Promise<unknown> {
  // `ctx.message` is typed `never` unless the bot declares prefix commands in its Seyfert registry
  const message = (ctx as unknown as { message?: MessageStructure }).message;
  const userId = ctx.author.id;
  if (!byaku.enabled || !(await byaku.isOwner(userId))) {
    byaku.audit({ action: 'denied', userId, outcome: 'denied', channelId: ctx.channelId });
    return message
      ? undefined
      : ctx.write({ content: 'Byaku is owner-only.', flags: 64 } as never).catch(() => undefined);
  }

  if (message) {
    const raw = { id: message.id, channel_id: ctx.channelId, content: message.content };
    const text = (await byaku.triggerText(raw, message, true)) ?? message.content.replace(/^\S+\s*/, '');
    return byaku.run({
      ownerId: userId,
      channelId: ctx.channelId,
      ...(ctx.guildId ? { guildId: ctx.guildId } : {}),
      triggerId: message.id,
      text,
      message,
      interaction: ctx,
      delivery: { kind: 'context', ctx },
    });
  }

  const options = ctx.options as { mode?: string; ephemeral?: boolean };
  return ctx.modal(codeModal(byaku.registry.resolve(options.mode ?? 'js') ?? 'js', options.ephemeral ?? true) as never);
}

async function suggestModes(byaku: Byaku, interaction: AutocompleteInteraction): Promise<void> {
  if (!(await byaku.isOwner(interaction.user.id))) return interaction.respond([]);
  const typed = String(interaction.getInput() ?? '').toLowerCase();
  const choices = byaku.registry
    .list()
    .filter((m) => m.name !== 'summary' && (m.name.includes(typed) || m.description.toLowerCase().includes(typed)))
    .map((m) => ({ name: truncate(`${m.name} · ${m.description}`, 100), value: m.name }));
  return interaction.respond(choices.slice(0, 25));
}

export interface ByakuHandlerClasses {
  /** For a components file: `export default createByakuClasses(byaku).ByakuComponents`. */
  ByakuComponents: (new () => ComponentCommand)[];
  ByakuModals: (new () => ModalCommand)[];
  ByakuButtons: new () => ComponentCommand;
  ByakuSelects: new () => ComponentCommand;
  ByakuModal: new () => ModalCommand;
}

export function createHandlerClasses(byaku: Byaku): ByakuHandlerClasses {
  class ByakuButtons extends ComponentCommand {
    componentType = 'Button' as const;
    override customId = ID_PATTERN;
    readonly [BYAKU_HANDLER] = true;
    override run(ctx: ComponentContext<'Button'>) {
      return handleComponent(byaku, ctx);
    }
  }

  class ByakuSelects extends ComponentCommand {
    componentType = 'StringSelect' as const;
    override customId = ID_PATTERN;
    readonly [BYAKU_HANDLER] = true;
    override run(ctx: ComponentContext<'StringSelect'>) {
      return handleComponent(byaku, ctx);
    }
  }

  class ByakuModal extends ModalCommand {
    override customId = ID_PATTERN;
    readonly [BYAKU_HANDLER] = true;
    override run(ctx: ModalContext) {
      return handleModal(byaku, ctx);
    }
  }

  return {
    ByakuComponents: [ByakuButtons, ByakuSelects],
    ByakuModals: [ByakuModal],
    ByakuButtons,
    ByakuSelects,
    ByakuModal,
  };
}

export function createSlashCommand(byaku: Byaku): new () => Command {
  return class ByakuCommand extends Command {
    readonly [BYAKU_HANDLER] = true;

    constructor() {
      super();
      this.name = 'byaku';
      this.description = 'Owner-only developer console';
      // Without @Declare the contexts are empty, and Seyfert would never run the command
      this.contexts = [InteractionContextType.Guild, InteractionContextType.BotDM];
      this.options = [
        {
          ...createStringOption({
            description: 'Mode (default: js)',
            required: false,
            autocomplete: (interaction: AutocompleteInteraction) => suggestModes(byaku, interaction),
          }),
          name: 'mode',
        },
        {
          ...createBooleanOption({ description: 'Only you see the reply (default: yes)', required: false }),
          name: 'ephemeral',
        },
      ] as never;
    }

    override run(ctx: CommandContext) {
      return handleCommand(byaku, ctx);
    }
  };
}
