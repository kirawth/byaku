import type { CommandContext, MessageStructure, UsingClient } from 'seyfert';

import type { Byaku } from '../byaku.js';
import { ByakuError } from '../options.js';
import type { Flags } from '../parse.js';
import type { LiveKind, Session } from '../session.js';
import { jsModes } from './eval.js';
import { shellModes } from './shell.js';
import { systemModes } from './system.js';
import { toolModes } from './tools.js';

/** What a mode returns. A plain string is shown in a code block. */
export interface ModeOutput {
  /** Code block text; Byaku redacts and pages it. */
  output?: string;
  /** Plain message text instead of a code block (cut to one message). */
  text?: string;
  /** Code block language. Default `txt`. */
  lang?: string;
  /** ✅ or ❌. Default true. */
  ok?: boolean;
  /** Measured by Byaku when left out. */
  ms?: number;
  /** A JavaScript value to keep for the object explorer and depth changes. */
  value?: unknown;
  hasValue?: boolean;
  /** Extra parts for the status line. */
  status?: string[];
}

// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- a mode may return nothing
export type ModeReturn = string | ModeOutput | void;

export interface LiveOptions {
  kind: LiveKind;
  /** The current text of the live view; Byaku redacts it. */
  render: () => string;
  lang?: string;
  /** Text the owner sent with 📝 Send input. */
  onInput?: (text: string) => void;
}

export interface LiveHandle {
  /** Re-render soon; edits are throttled. */
  update(): void;
  readonly paused: boolean;
  /** Aborted on Kill, Stop, timeout or session end. */
  readonly signal: AbortSignal;
}

export interface ModeContext {
  byaku: Byaku;
  client: UsingClient;
  /** Code or arguments, outer fence removed. */
  input: string;
  lang?: string;
  flags: Flags;
  author: { id: string };
  channelId: string;
  guildId?: string;
  message?: MessageStructure;
  interaction?: CommandContext;
  session: Session;
  signal: AbortSignal;
  redact(text: string): string;
  /** Eval variables: client, ctx, message, cache, rest, byaku, require and your `scope`. */
  scope(): Record<string, unknown>;
  /** Starts a live view whose message is edited as it changes. */
  live(options: LiveOptions): Promise<LiveHandle>;
}

export interface ByakuModeDefinition {
  name: string;
  aliases?: readonly string[];
  /** One line for `help`. */
  description: string;
  usage?: string;
  examples?: readonly string[];
  /** Show 🔁 Re-run and ✏️ Edit. Default true. */
  rerunnable?: boolean;
  run(ctx: ModeContext): ModeReturn | Promise<ModeReturn>;
}

export type ByakuMode = Required<ByakuModeDefinition>;

const NAME = /^[a-z0-9$][a-z0-9_.-]{0,31}$/;

/**
 * Defines a custom mode.
 *
 * @example
 * const uptime = defineMode({
 *   name: 'uptime',
 *   description: 'Process uptime',
 *   run: () => `${process.uptime().toFixed(0)} s`,
 * });
 * new Byaku(client, { modes: [uptime] });
 */
export function defineMode(definition: ByakuModeDefinition): ByakuMode {
  const name = definition.name.toLowerCase();
  const aliases = (definition.aliases ?? []).map((a) => a.toLowerCase());
  for (const word of [name, ...aliases]) {
    if (!NAME.test(word))
      throw new ByakuError('INVALID_MODE', `Invalid mode name or alias "${word}" (use a-z, 0-9, _ . -)`);
  }
  return {
    name,
    aliases,
    description: definition.description,
    usage: definition.usage ?? name,
    examples: definition.examples ?? [],
    rerunnable: definition.rerunnable ?? true,
    run: definition.run,
  };
}

/** Modes by name and alias; a later mode replaces an earlier one with the same name. */
export class ModeRegistry {
  private readonly modes = new Map<string, ByakuMode>();
  private readonly names = new Map<string, string>();

  register(...modes: ByakuMode[]): void {
    for (const mode of modes) {
      for (const alias of this.modes.get(mode.name)?.aliases ?? []) {
        if (this.names.get(alias) === mode.name) this.names.delete(alias);
      }
      this.modes.set(mode.name, mode);
      for (const word of [mode.name, ...mode.aliases]) this.names.set(word, mode.name);
    }
  }

  resolve(word: string): string | undefined {
    return this.names.get(word.toLowerCase());
  }

  get(nameOrAlias: string): ByakuMode | undefined {
    const name = this.resolve(nameOrAlias);
    return name ? this.modes.get(name) : undefined;
  }

  list(): ByakuMode[] {
    return [...this.modes.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

export const builtinModes: ByakuMode[] = [...systemModes, ...jsModes, ...shellModes, ...toolModes].map(defineMode);
