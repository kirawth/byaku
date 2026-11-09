export type Flags = Record<string, string | true>;

export interface ParsedInput {
  /** Resolved mode name; `undefined` means the summary. */
  mode: string | undefined;
  flags: Flags;
  /** Code or arguments with the outer fence removed. */
  body: string;
  /** Text after the flags, exactly as typed. */
  raw: string;
  lang?: string;
}

export function buildTriggers(options: {
  prefixes: readonly string[];
  botPrefixes: readonly string[];
  names: readonly string[];
  botId: string | undefined;
}): string[] {
  const triggers = new Set(options.prefixes);
  for (const prefix of options.botPrefixes) for (const name of options.names) triggers.add(`${prefix}${name}`);
  if (options.botId) {
    for (const name of options.names) {
      triggers.add(`<@${options.botId}> ${name}`);
      triggers.add(`<@!${options.botId}> ${name}`);
    }
  }
  // Longest first, so `?byaku` wins over `?by`
  return [...triggers].sort((a, b) => b.length - a.length);
}

/** Returns the text after the trigger, or `undefined`. A trigger must end at whitespace, so `?fnord` is not `?by`. */
export function matchTrigger(content: string, triggers: readonly string[]): string | undefined {
  const text = content.trimStart();
  const lower = text.toLowerCase();
  for (const trigger of triggers) {
    if (!lower.startsWith(trigger.toLowerCase())) continue;
    const next = text.charAt(trigger.length);
    if (next !== '' && !/\s/.test(next)) continue;
    return text.slice(trigger.length).trimStart();
  }
  return undefined;
}

const LANG_ALIASES: Record<string, string> = {
  javascript: 'js',
  typescript: 'ts',
  shell: 'sh',
  bash: 'sh',
  zsh: 'sh',
  yml: 'yaml',
};

export function stripFences(text: string): { code: string; lang?: string } {
  const trimmed = text.trim();

  const block = /^```([\w+#.-]*)[ \t]*\n([\s\S]*?)\n?[ \t]*```$/.exec(trimmed);
  if (block) {
    const hint = block[1]?.toLowerCase();
    const lang = hint ? (LANG_ALIASES[hint] ?? hint) : undefined;
    return lang ? { code: block[2] ?? '', lang } : { code: block[2] ?? '' };
  }

  // On one line the first word is code, not a language
  const oneLine = /^```([\s\S]*?)```$/.exec(trimmed);
  if (oneLine) return { code: (oneLine[1] ?? '').trim() };

  const inline = /^`([^`]+)`$/.exec(trimmed);
  if (inline) return { code: inline[1] ?? '' };

  return { code: trimmed };
}

/** Reads `--flags` before the code only, stopping at the first other word or at `--`. */
export function parseFlags(text: string): { flags: Flags; rest: string } {
  const flags: Flags = {};
  let rest = text.trimStart();

  for (let m = /^(\S+)(\s+|$)/.exec(rest); m; m = /^(\S+)(\s+|$)/.exec(rest)) {
    if (m[1] === '--') {
      rest = rest.slice(m[0].length);
      break;
    }
    const flag = /^--([a-z][a-z0-9-]*)(?:=(\S*))?$/i.exec(m[1] ?? '');
    if (!flag) break;
    flags[(flag[1] ?? '').toLowerCase()] = flag[2] ?? true;
    rest = rest.slice(m[0].length);
  }

  return { flags, rest };
}

/** Splits the text after the trigger. An unknown first word is not a mode: the whole text runs as `defaultMode`. */
export function parseInput(
  text: string,
  resolveMode: (word: string) => string | undefined,
  defaultMode = 'js',
): ParsedInput {
  const input = text.trimStart();
  if (!input.trim()) return { mode: undefined, flags: {}, body: '', raw: '' };

  const word = /^[^\s`]+/.exec(input)?.[0] ?? '';
  const mode = word ? resolveMode(word.toLowerCase()) : undefined;
  const { flags, rest: raw } = parseFlags(mode ? input.slice(word.length) : input);
  const { code, lang } = stripFences(raw);

  return { mode: mode ?? defaultMode, flags, body: code, raw, ...(lang ? { lang } : {}) };
}

export function numberFlag(flags: Flags, name: string, fallback: number, min = -Infinity, max = Infinity): number {
  const n = Number(flags[name]);
  return typeof flags[name] === 'string' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function boolFlag(flags: Flags, name: string): boolean {
  const value = flags[name];
  return value === true || (typeof value === 'string' && !/^(false|0|no|off)$/i.test(value));
}

/**
 * Splits arguments like a shell: spaces separate words, quotes group them, `\` escapes the next character
 * (outside single quotes; inside double quotes only `\" \\ \$ \``).
 */
export function tokenize(input: string): string[] {
  const words: string[] = [];
  let word = '';
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string;

    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < input.length && (quote !== '"' || '"\\$`'.includes(input[i + 1] as string))) {
      word += input[++i];
      started = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += ch;
      started = true;
    }
  }

  if (started) words.push(word);
  return words;
}

export function splitFirst(input: string): [string, string] {
  const m = /^\s*(\S+)(?:\s+([\s\S]*))?$/.exec(input);
  return m ? [m[1] ?? '', m[2] ?? ''] : ['', ''];
}

/** Input that asks for Confirm / Cancel before it runs. */
export interface ConfirmRule {
  /** Modes it applies to (all when left out). */
  modes?: readonly string[];
  pattern: RegExp;
  /** Finishes the sentence "This input …". */
  reason: string;
}

const SHELL = ['sh', 'git', 'logs'];
const JS = ['js', 'ts', 'jsi', 'watch', 'bench', 'shard', 'all'];

export const DEFAULT_CONFIRM_RULES: readonly ConfirmRule[] = [
  { modes: SHELL, pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, reason: 'deletes files (rm -rf)' },
  { modes: SHELL, pattern: /\bRemove-Item\b[^\n]*-Recurse/i, reason: 'deletes files (Remove-Item -Recurse)' },
  { modes: SHELL, pattern: /\b(mkfs(\.\w+)?|fdisk|wipefs)\b/i, reason: 'formats a disk' },
  { modes: SHELL, pattern: /\bdd\s+[^\n]*\bof=/i, reason: 'writes raw data with dd' },
  { modes: SHELL, pattern: /\b(shutdown|reboot|poweroff|halt)\b/i, reason: 'shuts down the machine' },
  { modes: SHELL, pattern: /\b(kill|pkill|killall)\s+(-9\s+)?(-1|1)\b/, reason: 'kills every process' },
  {
    modes: SHELL,
    pattern: /\bgit\s+(push\s+[^\n]*(--force|-f)\b|reset\s+--hard|clean\s+-[a-z]*f)/i,
    reason: 'rewrites or deletes git work',
  },
  { modes: SHELL, pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'is a fork bomb' },
  { modes: JS, pattern: /\bprocess\s*\.\s*(exit|abort|kill|reallyExit)\s*\(/, reason: 'stops the bot process' },
  { modes: JS, pattern: /\bclient\s*\.\s*(close|destroy)\s*\(/, reason: 'disconnects the bot' },
  {
    modes: JS,
    pattern: /\b(rmSync|rmdirSync|unlinkSync)\s*\(|\bfs\s*\.\s*(promises\s*\.\s*)?(rm|rmdir|unlink)\s*\(/,
    reason: 'deletes files',
  },
  { modes: ['cache'], pattern: /^\s*clear\b/i, reason: 'clears cached data until the next gateway events' },
  { modes: ['cmd'], pattern: /^\s*sync\b/i, reason: 'uploads application commands to Discord' },
  { modes: ['sql'], pattern: /\b(drop|truncate)\s+(table|database|schema)\b/i, reason: 'drops or empties data' },
  { modes: ['sql'], pattern: /\bdelete\s+from\s+[^\s;]+\s*(;|$)/i, reason: 'runs DELETE without WHERE' },
  { modes: ['sql'], pattern: /\bupdate\s+[^\s;]+\s+set\b(?![\s\S]*\bwhere\b)/i, reason: 'runs UPDATE without WHERE' },
  { modes: ['redis'], pattern: /^\s*(flushall|flushdb)\b/i, reason: 'empties Redis' },
];

export function findRiskyRule(rules: readonly ConfirmRule[], mode: string, input: string): ConfirmRule | undefined {
  for (const rule of rules) {
    if (rule.modes && !rule.modes.includes(mode)) continue;
    // A user's pattern may have the `g` flag, which makes `test` stateful
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(input)) return rule;
  }
  return undefined;
}
