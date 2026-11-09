import {
  ActionRow,
  Button,
  ButtonStyle,
  FileUpload,
  Label,
  Modal,
  MessageFlags,
  StringSelectMenu,
  StringSelectOption,
  TextInput,
  TextInputStyle,
} from 'seyfert';

import { breadcrumb, type ExplorerEntry, MAX_DEPTH } from './inspect.js';
import { ByakuError } from './options.js';
import { codeBlock, escapeFences, formatDuration, lastPage, statusLine, truncate } from './output.js';
import type { Session } from './session.js';

/**
 * Custom ids are `by1:<session>:<action>[:<arg>]`. The version lets a future scheme answer old buttons
 * politely instead of misreading them.
 */
export const ID_PATTERN = /^by\d+:/;

type Action =
  | 'f'
  | 'p'
  | 'n'
  | 'l'
  | 'g' // pager, go to page
  | 'r'
  | 'e'
  | 'fi'
  | 'raw'
  | 'x'
  | 'd'
  | 'df'
  | 'pin' // actions
  | 'k'
  | 'in'
  | 'ps'
  | 'rs'
  | 'st' // live views
  | 'dp'
  | 'xk'
  | 'xb'
  | 'xr' // depth select, explorer
  | 'ok'
  | 'no' // confirm guard
  | 'M'; // modals

export function customId(sid: string, action: Action, arg?: string): string {
  const id = arg === undefined ? `by1:${sid}:${action}` : `by1:${sid}:${action}:${arg}`;
  if (id.length > 100)
    throw new ByakuError('CUSTOM_ID_TOO_LONG', `Custom id is ${id.length} characters (Discord allows 100)`);
  return id;
}

export function parseCustomId(id: string): { version: number; sid: string; action: string; arg?: string } | undefined {
  const m = /^by(\d+):([^:]+):([^:]+)(?::([\s\S]*))?$/.exec(id);
  if (!m) return undefined;
  return { version: Number(m[1]), sid: m[2] ?? '', action: m[3] ?? '', ...(m[4] === undefined ? {} : { arg: m[4] }) };
}

/** Always a plain message: no embeds and `flags: 0`, so bots that turn replies into embeds or Components V2 leave it alone. */
export interface ByakuBody {
  content: string;
  components: ActionRow<Button | StringSelectMenu>[];
  flags: MessageFlags;
  embeds: [];
  allowed_mentions: { parse: [] };
}

export function plainBody(content: string, components: ByakuBody['components'] = [], ephemeral = false): ByakuBody {
  return {
    content: truncate(content, 2000),
    components,
    // Seyfert's enum omits zero, which keeps plain replies free of inherited flags.
    flags: ephemeral ? MessageFlags.Ephemeral : (0 as MessageFlags),
    embeds: [],
    allowed_mentions: { parse: [] },
  };
}

/** Seyfert 5.2 throws INVALID_EMOJI for `{ name }` without an id, so emojis are always plain strings. */
export function button(
  sid: string,
  action: Action,
  emoji: string,
  options: { label?: string; style?: ButtonStyle; disabled?: boolean } = {},
): Button {
  const b = new Button()
    .setCustomId(customId(sid, action))
    .setEmoji(emoji)
    .setStyle(options.style ?? ButtonStyle.Secondary);
  if (options.label) b.setLabel(options.label);
  if (options.disabled) b.setDisabled(true);
  return b;
}

export interface ViewExtras {
  rerunnable: boolean;
  /** A JS value is kept, so the explorer and depth controls apply. */
  hasValue: boolean;
  entries: readonly ExplorerEntry[];
}

/** Explorer keys per select page; the other two option slots are "previous" and "more". */
const KEYS_PER_PAGE = 23;

function status(session: Session, hasValue: boolean, display: (text: string) => string): string {
  const extra = Array.isArray(session.data.status) ? (session.data.status as string[]) : [];
  if (session.live) {
    return statusLine(session.live.paused ? 'paused' : 'running', [
      display(session.mode),
      formatDuration(Date.now() - session.live.startedAt),
      ...extra.map(display),
    ]);
  }
  const total = session.pages.length;
  const { depth, hidden, getters, path } = session.view;
  return statusLine(session.ok, [
    display(session.mode),
    formatDuration(session.ms),
    total > 1 && `page ${session.page + 1}/${total}`,
    hasValue && `depth ${depth}`,
    hasValue && (hidden || getters) && 'hidden + getters',
    hasValue && path.length > 0 && breadcrumb('result', path, 70, display),
    ...extra.map(display),
    session.pinned && '📌 kept',
  ]);
}

export function renderSession(session: Session, extras: ViewExtras, display = (text: string) => text): ByakuBody {
  const sid = session.id;
  const ephemeral = session.ephemeral === true;

  const confirm = session.data.confirm as { reason: string } | undefined;
  if (confirm) {
    return plainBody(
      `⚠️ **This ${display(session.mode)} input ${display(confirm.reason)}.** Run it?\n${codeBlock(escapeFences(truncate(display(session.input), 1500)), display(session.lang))}`,
      [
        new ActionRow<Button>().setComponents([
          button(sid, 'ok', '✅', { label: 'Confirm', style: ButtonStyle.Danger }),
          button(sid, 'no', '✖️', { label: 'Cancel' }),
        ]),
      ],
      ephemeral,
    );
  }

  if (session.data.text === true) {
    const remove = button(sid, 'd', '🗑️', { style: ButtonStyle.Danger });
    return plainBody(display(session.output), [new ActionRow<Button>().setComponents([remove])], ephemeral);
  }

  if (session.live) {
    const content = `${codeBlock(escapeFences(lastPage(display(session.output))), display(session.lang))}\n${status(session, false, display)}`;
    const controls =
      session.live.kind === 'shell'
        ? [
            button(sid, 'k', '⏹️', { label: 'Kill', style: ButtonStyle.Danger }),
            button(sid, 'in', '📝', { label: 'Send input' }),
          ]
        : session.live.kind === 'bench'
          ? [button(sid, 'k', '⏹️', { label: 'Stop', style: ButtonStyle.Danger })]
          : [
              session.live.paused
                ? button(sid, 'rs', '▶️', { label: 'Resume', style: ButtonStyle.Primary })
                : button(sid, 'ps', '⏸️', { label: 'Pause' }),
              button(sid, 'st', '⏹️', { label: 'Stop', style: ButtonStyle.Danger }),
            ];
    return plainBody(content, [new ActionRow<Button>().setComponents(controls)], ephemeral);
  }

  const total = session.pages.length;
  const page = session.pages[Math.min(session.page, total - 1)] ?? '';
  const rows: ByakuBody['components'] = [];

  if (total > 1) {
    const first = session.page === 0;
    const last = session.page >= total - 1;
    const counter = new Button()
      .setCustomId(customId(sid, 'g'))
      .setLabel(`${session.page + 1} / ${total}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(total < 3);
    rows.push(
      new ActionRow<Button>().setComponents([
        button(sid, 'f', '⏮️', { disabled: first }),
        button(sid, 'p', '◀️', { disabled: first }),
        counter,
        button(sid, 'n', '▶️', { disabled: last }),
        button(sid, 'l', '⏭️', { disabled: last }),
      ]),
    );
  }

  const actions = extras.rerunnable
    ? [button(sid, 'r', '🔁', { style: ButtonStyle.Primary }), button(sid, 'e', '✏️')]
    : [];
  actions.push(
    button(sid, 'fi', '📄'),
    button(sid, 'raw', '📋'),
    button(sid, 'd', '🗑️', { style: ButtonStyle.Danger }),
  );
  rows.push(new ActionRow<Button>().setComponents(actions));

  const more = [
    button(sid, 'pin', '📌', { style: session.pinned ? ButtonStyle.Success : ButtonStyle.Secondary }),
    button(sid, 'x', '⏹️'),
  ];
  if (session.previousOutput !== undefined) more.push(button(sid, 'df', '🔀', { label: 'Diff' }));
  if (extras.hasValue && session.view.path.length) more.push(button(sid, 'xb', '⬅️'), button(sid, 'xr', '🏠'));
  rows.push(new ActionRow<Button>().setComponents(more));

  if (extras.hasValue) {
    if (extras.entries.length)
      rows.push(new ActionRow<StringSelectMenu>().setComponents([explorerSelect(session, extras.entries, display)]));
    rows.push(new ActionRow<StringSelectMenu>().setComponents([depthSelect(session)]));
  }

  return plainBody(
    `${codeBlock(escapeFences(display(page)), display(session.lang))}\n${status(session, extras.hasValue, display)}`,
    rows,
    ephemeral,
  );
}

function explorerSelect(
  session: Session,
  entries: readonly ExplorerEntry[],
  display: (text: string) => string,
): StringSelectMenu {
  const pages = Math.ceil(entries.length / KEYS_PER_PAGE);
  const keyPage = Math.min(Math.max(0, session.view.keyPage), pages - 1);
  const offset = keyPage * KEYS_PER_PAGE;
  const options = entries.slice(offset, offset + KEYS_PER_PAGE).map((entry, i) =>
    new StringSelectOption()
      .setLabel(truncate(display(entry.label) || '(empty)', 100))
      .setValue(`k${offset + i}`)
      .setDescription(truncate(display(entry.description), 100)),
  );
  if (keyPage > 0) options.unshift(new StringSelectOption().setLabel('Previous keys').setValue('kp').setEmoji('◀️'));
  if (keyPage < pages - 1) options.push(new StringSelectOption().setLabel('More keys').setValue('kn').setEmoji('▶️'));

  const where = session.view.path.length ? breadcrumb('result', session.view.path, 60, display) : 'result';
  const pageInfo = pages > 1 ? `, page ${keyPage + 1}/${pages}` : '';
  return new StringSelectMenu()
    .setCustomId(customId(session.id, 'xk'))
    .setPlaceholder(truncate(`🔎 Explore ${where} (${entries.length} keys${pageInfo})`, 150))
    .setOptions(options);
}

function depthSelect(session: Session): StringSelectMenu {
  const options = Array.from({ length: MAX_DEPTH + 1 }, (_, d) =>
    new StringSelectOption()
      .setLabel(`Depth ${d}`)
      .setValue(`d${d}`)
      .setDescription(d === 0 ? 'Top level only' : d === 1 ? 'Default' : `${d} levels of nested objects`)
      .setDefault(d === session.view.depth),
  );
  const on = session.view.hidden || session.view.getters;
  options.push(
    new StringSelectOption()
      .setLabel(on ? 'Hide hidden keys and getters' : 'Show hidden keys and getters')
      .setValue('h')
      .setDescription(on ? 'Back to enumerable keys only' : 'Non-enumerable keys, symbols, and run getters')
      .setEmoji('👁️'),
  );
  return new StringSelectMenu()
    .setCustomId(customId(session.id, 'dp'))
    .setPlaceholder(`Inspect depth: ${session.view.depth}`)
    .setOptions(options);
}

export const INPUT = { page: 'page', code: 'code', stdin: 'stdin', file: 'file' } as const;

function field(label: string, input: TextInput, description?: string): Label {
  const l = new Label().setLabel(label).setComponent(input);
  return description ? l.setDescription(description) : l;
}

export function gotoModal(session: Session): Modal {
  const input = new TextInput()
    .setCustomId(INPUT.page)
    .setStyle(TextInputStyle.Short)
    .setLength({ min: 1, max: 6 })
    .setValue(String(session.page + 1))
    .setRequired(true);
  return new Modal()
    .setCustomId(customId(session.id, 'M', 'g'))
    .setTitle('Go to page')
    .addComponents(field(`Page (1-${session.pages.length})`, input));
}

export function editModal(session: Session, display = (text: string) => text): Modal {
  const containsSecret = display(session.input) !== session.input;
  const input = new TextInput()
    .setCustomId(INPUT.code)
    .setStyle(TextInputStyle.Paragraph)
    .setLength({ min: 1, max: 4000 })
    .setRequired(true);
  if (!containsSecret) input.setValue(truncate(session.input, 4000));
  return new Modal()
    .setCustomId(customId(session.id, 'M', 'e'))
    .setTitle(truncate(`Edit and run (${display(session.mode)})`, 45))
    .addComponents(
      field(
        'Code',
        input,
        containsSecret ? 'Input contains secrets. Enter new code, or close and use Re-run.' : undefined,
      ),
    );
}

export function stdinModal(session: Session): Modal {
  const input = new TextInput()
    .setCustomId(INPUT.stdin)
    .setStyle(TextInputStyle.Paragraph)
    .setLength({ max: 4000 })
    .setRequired(false);
  return new Modal()
    .setCustomId(customId(session.id, 'M', 'in'))
    .setTitle('Send input')
    .addComponents(field('Input (a newline is added)', input));
}

/** The `/byaku` modal. The mode and visibility ride in the custom id, since a modal has no other state. */
export function codeModal(mode: string, ephemeral: boolean, display = (text: string) => text): Modal {
  const code = new TextInput()
    .setCustomId(INPUT.code)
    .setStyle(TextInputStyle.Paragraph)
    .setLength({ max: 4000 })
    .setRequired(false);
  const upload = new FileUpload().setCustomId(INPUT.file).setMinValues(0).setMaxValues(1).setRequired(false);
  return new Modal()
    .setCustomId(customId('new', 'M', `code:${mode}:${ephemeral ? 'e' : 'p'}`))
    .setTitle(truncate(`Byaku · ${display(mode)}`, 45))
    .addComponents(
      field(mode === 'sh' ? 'Command' : 'Code', code, 'Leave empty to run an uploaded file instead.'),
      new Label().setLabel('Or upload a file').setDescription('A .js or .ts file (up to 1 MB).').setComponent(upload),
    );
}
