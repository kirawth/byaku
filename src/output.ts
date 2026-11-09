/** Characters per page: a 2,000-character message minus the fences and the status line. */
export const PAGE_SIZE = 1_850;

export const REDACTED = '[redacted]';

// Shorter values would match ordinary text
const MIN_SECRET_LENGTH = 6;

export function codeBlock(text: string, lang = ''): string {
  // Discord drops an empty code block
  return `\`\`\`${lang}\n${text || ' '}\n\`\`\``;
}

/** Breaks up runs of three or more backticks so output can't close Byaku's code block. */
export function escapeFences(text: string): string {
  return text.replace(/`{3,}/g, (run) => run.split('').join('‍'));
}

export function statusLine(state: boolean | 'running' | 'paused', parts: (string | false | undefined)[]): string {
  const icon = state === 'running' ? '⏳' : state === 'paused' ? '⏸️' : state ? '✅' : '❌';
  return `-# ${icon} ${parts.filter(Boolean).join(' · ')}`.trimEnd();
}

/** Seyfert reports Infinity, NaN or a negative latency before the first heartbeat. */
export function formatMs(ms: number | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? `${Math.round(ms)} ms` : '-';
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1_000);
  const h = Math.floor(seconds / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}h ${pad(m)}m` : `${m}m ${pad(seconds % 60)}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  for (; value >= 1024 && unit < units.length - 1; unit++) value /= 1024;
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function discordTimestamp(ms: number, style: 'f' | 'R' = 'R'): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/** Cuts to `max` characters with `…`, never splitting a surrogate pair. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  if (/[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
  return `${text.slice(0, end)}…`;
}

export function table(headers: string[], rows: (string | number)[][]): string {
  const cells = [headers, ...rows.map((row) => row.map(String))];
  const widths = headers.map((_, col) => Math.max(...cells.map((row) => (row[col] ?? '').length)));
  const line = (row: string[]) =>
    row
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(headers), widths.map((w) => '─'.repeat(w)).join('  '), ...cells.slice(1).map(line)].join('\n');
}

/** Splits text into pages on line breaks; longer lines are cut, never inside an emoji or an ANSI colour code. */
export function paginate(text: string, size = PAGE_SIZE): string[] {
  const pages: string[] = [];
  let page = '';

  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const joined = page ? `${page}\n${line}` : line;
    if (joined.length <= size) {
      page = joined;
      continue;
    }
    if (page) pages.push(page);
    page = line;
    if (line.length > size) {
      const pieces = cutLongLine(line, size);
      pages.push(...pieces.slice(0, -1));
      page = pieces.at(-1) ?? '';
    }
  }

  if (page || !pages.length) pages.push(page);
  return pages;
}

export function cutLongLine(line: string, size: number): string[] {
  const pieces: string[] = [];
  let rest = line;

  while (rest.length > size) {
    const space = rest.lastIndexOf(' ', size);
    let end = space > size * 0.85 ? space + 1 : size;
    if (/[\uD800-\uDBFF]/.test(rest.charAt(end - 1))) end--;
    // eslint-disable-next-line no-control-regex -- an unfinished ANSI escape sequence at the cut
    const ansi = /\u001b(?:\[[0-9;?]*)?$/.exec(rest.slice(Math.max(0, end - 16), end));
    if (ansi && end > ansi[0].length) end -= ansi[0].length;
    pieces.push(rest.slice(0, end));
    rest = rest.slice(end);
  }

  if (rest) pieces.push(rest);
  return pieces;
}

/** The end of a growing text, starting on a whole line when that loses little. */
export function lastPage(text: string, size = PAGE_SIZE): string {
  if (text.length <= size) return text;
  const tail = text.slice(text.length - size + 1);
  const newline = tail.indexOf('\n');
  return `…${newline >= 0 && newline < size * 0.25 ? tail.slice(newline + 1) : tail}`;
}

type DiffOp = { op: ' ' | '+' | '-'; line: string };

/** A line diff for the Diff button. Long unchanged runs are folded to `@@ n unchanged lines @@`. */
export function diffLines(
  before: string,
  after: string,
  context = 3,
): { text: string; added: number; removed: number } {
  if (before === after) return { text: '  (no changes)', added: 0, removed: 0 };

  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  // The LCS table is n × m; very large changes are shown as all removed / all added
  const middle: DiffOp[] =
    middleA.length * middleB.length <= 4_000_000
      ? lcsDiff(middleA, middleB)
      : [...middleA.map((line): DiffOp => ({ op: '-', line })), ...middleB.map((line): DiffOp => ({ op: '+', line }))];
  const ops: DiffOp[] = [
    ...a.slice(0, start).map((line): DiffOp => ({ op: ' ', line })),
    ...middle,
    ...a.slice(endA).map((line): DiffOp => ({ op: ' ', line })),
  ];

  return {
    text: foldUnchanged(ops, context),
    added: ops.filter((o) => o.op === '+').length,
    removed: ops.filter((o) => o.op === '-').length,
  };
}

function lcsDiff(a: string[], b: string[]): DiffOp[] {
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ op: ' ', line: a[i++] ?? '' });
      j++;
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
      ops.push({ op: '-', line: a[i++] ?? '' });
    } else {
      ops.push({ op: '+', line: b[j++] ?? '' });
    }
  }
  while (i < a.length) ops.push({ op: '-', line: a[i++] ?? '' });
  while (j < b.length) ops.push({ op: '+', line: b[j++] ?? '' });
  return ops;
}

function foldUnchanged(ops: DiffOp[], context: number): string {
  const lines: string[] = [];
  for (let i = 0; i < ops.length;) {
    if (ops[i]?.op !== ' ') {
      lines.push(`${ops[i]?.op} ${ops[i]?.line}`);
      i++;
      continue;
    }
    let j = i;
    while (j < ops.length && ops[j]?.op === ' ') j++;
    const run = ops.slice(i, j).map((o) => `  ${o.line}`);
    const head = i === 0 ? 0 : context;
    const tail = j === ops.length ? 0 : context;
    if (run.length > head + tail + 1) {
      lines.push(
        ...run.slice(0, head),
        `@@ ${run.length - head - tail} unchanged lines @@`,
        ...run.slice(run.length - tail),
      );
    } else {
      lines.push(...run);
    }
    i = j;
  }
  return lines.join('\n');
}

/** Every form a secret can take in output: raw, URL-encoded, base64(url), hex, JSON-escaped, token parts. */
export function secretVariants(secret: string): string[] {
  const buf = Buffer.from(secret, 'utf8');
  const base64 = buf.toString('base64');
  const variants = new Set([
    secret,
    encodeURIComponent(secret),
    encodeURI(secret),
    base64,
    base64.replace(/=+$/, ''),
    buf.toString('base64url'),
    buf.toString('hex'),
    buf.toString('hex').toUpperCase(),
    JSON.stringify(secret).slice(1, -1),
  ]);
  // A Discord token is <base64 id>.<timestamp>.<hmac>; each long part gives something away on its own
  const parts = secret.split('.');
  if (parts.length >= 3) for (const part of parts) if (part.length >= 8) variants.add(part);
  return [...variants].filter((v) => v.length >= MIN_SECRET_LENGTH);
}

export class Redactor {
  private readonly secrets = new Set<string>();
  private variants: string[] = [];
  private pattern: RegExp | undefined;

  constructor(secrets: Iterable<string | null | undefined> = []) {
    this.add(...secrets);
  }

  add(...secrets: (string | null | undefined)[]): void {
    const fresh = secrets.filter(
      (s): s is string => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH && !this.secrets.has(s),
    );
    if (!fresh.length) return;
    for (const s of fresh) this.secrets.add(s);
    // Longest first, so a secret is replaced whole before any of its parts
    this.variants = [...new Set([...this.secrets].flatMap(secretVariants))].sort((a, b) => b.length - a.length);
    this.pattern = new RegExp(this.variants.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  }

  /**
   * With `edges`, half a secret at the start and/or end is hidden too: text cut out of something longer
   * (a trimmed stream, a stream that is still open) can begin or end in the middle of one.
   */
  redact(text: string, edges: { start?: boolean; end?: boolean } = {}): string {
    if (!this.pattern || !text) return text;
    let out = text.replace(this.pattern, REDACTED);
    for (const v of this.variants) {
      if (edges.end) {
        for (let len = Math.min(v.length - 1, out.length); len >= MIN_SECRET_LENGTH; len--) {
          if (out.endsWith(v.slice(0, len))) {
            out = out.slice(0, out.length - len) + REDACTED;
            break;
          }
        }
      }
      if (edges.start) {
        for (let len = Math.min(v.length - 1, out.length); len >= MIN_SECRET_LENGTH; len--) {
          if (out.startsWith(v.slice(v.length - len))) {
            out = REDACTED + out.slice(len);
            break;
          }
        }
      }
    }
    return out;
  }
}

const SECRET_ENV_KEY =
  /(TOKEN|SECRET|PASSWORD|PASSWD|PASS|API_?KEY|PRIVATE|CREDENTIAL|AUTH|DSN|DATABASE_URL|REDIS_URL)/i;

export function secretsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([key, value]) => SECRET_ENV_KEY.test(key) && typeof value === 'string')
    .map(([, value]) => value as string);
}

/**
 * Keeps the raw text of a stream and redacts the whole of it on every read, so a secret split across two
 * chunks is still found. Only the last `maxLength` characters are kept.
 */
export class StreamRedactor {
  private raw = '';
  private trimmed = false;

  constructor(
    private readonly redactor: Redactor,
    private readonly maxLength = 1_000_000,
  ) {}

  get truncated(): boolean {
    return this.trimmed;
  }

  push(chunk: string): void {
    this.raw += chunk;
    if (this.raw.length > this.maxLength) {
      this.raw = this.raw.slice(this.raw.length - this.maxLength);
      this.trimmed = true;
    }
  }

  /** While the stream is open its end may hold half a secret. */
  text(open = false): string {
    return this.redactor.redact(this.raw, { start: this.trimmed, end: open });
  }
}
