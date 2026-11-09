import { describe, expect, it } from 'vitest';

import {
  codeBlock,
  cutLongLine,
  diffLines,
  discordTimestamp,
  escapeFences,
  formatBytes,
  formatDuration,
  formatMs,
  lastPage,
  PAGE_SIZE,
  paginate,
  REDACTED,
  Redactor,
  secretsFromEnv,
  secretVariants,
  StreamRedactor,
  statusLine,
  table,
  truncate,
} from '../src/output.js';

describe('format', () => {
  it('escapes ``` so output cannot close the block', () => {
    const out = escapeFences('a ``` b ````');
    expect(out).not.toContain('```');
    expect(out.replace(/\u200d/g, '')).toBe('a ``` b ````');
  });

  it('codeBlock never sends an empty block', () => {
    expect(codeBlock('', 'js')).toBe('```js\n \n```');
    expect(codeBlock('x')).toBe('```\nx\n```');
  });

  it('statusLine', () => {
    expect(statusLine(true, ['js', '12 ms', false, 'page 1/3', undefined, 'depth 1'])).toBe(
      '-# ✅ js · 12 ms · page 1/3 · depth 1',
    );
    expect(statusLine(false, ['sh'])).toBe('-# ❌ sh');
    expect(statusLine('running', ['sh', '3 s'])).toBe('-# ⏳ sh · 3 s');
  });

  it('formatMs shows - before the first heartbeat', () => {
    expect(formatMs(Infinity)).toBe('-');
    expect(formatMs(-1)).toBe('-');
    expect(formatMs(Number.NaN)).toBe('-');
    expect(formatMs(undefined)).toBe('-');
    expect(formatMs(41.6)).toBe('42 ms');
  });

  it('formatBytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('discordTimestamp', () => {
    expect(discordTimestamp(1_700_000_000_999)).toBe('<t:1700000000:R>');
    expect(discordTimestamp(0, 'f')).toBe('<t:0:f>');
  });

  it('truncate does not split surrogate pairs', () => {
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('abcdef', 4)).toBe('abc…');
    const t = truncate('a😀b', 3);
    expect(t).toBe('a…');
  });

  it('table aligns columns', () => {
    const t = table(
      ['id', 'ping'],
      [
        [0, '42 ms'],
        [10, '-'],
      ],
    );
    expect(t.split('\n')).toEqual(['id  ping', '──  ─────', '0   42 ms', '10  -']);
  });
});

describe('formatDuration', () => {
  it('formats', () => {
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(12_340)).toBe('12.3 s');
    expect(formatDuration(245_000)).toBe('4m 05s');
    expect(formatDuration(7_800_000)).toBe('2h 10m');
    expect(formatDuration(Infinity)).toBe('-');
  });
});

describe('paginate', () => {
  it('returns one empty page for empty text', () => {
    expect(paginate('')).toEqual(['']);
  });

  it('keeps short text on one page', () => {
    expect(paginate('a\nb\nc')).toEqual(['a\nb\nc']);
  });

  it('splits on line breaks and never exceeds the size', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(i % 40)}`);
    const pages = paginate(lines.join('\n'));
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) expect(p.length).toBeLessThanOrEqual(PAGE_SIZE);
    // Every line survives whole, in order
    expect(pages.join('\n')).toBe(lines.join('\n'));
  });

  it('cuts very long lines safely', () => {
    const long = 'y'.repeat(5000);
    const pages = paginate(`a\n${long}\nb`, 1000);
    for (const p of pages) expect(p.length).toBeLessThanOrEqual(1000);
    expect(pages.join('')).toContain(long.slice(0, 900));
    expect(pages.join('').replace(/\n/g, '')).toBe(`a${long}b`);
  });

  it('never splits a surrogate pair', () => {
    const text = '😀'.repeat(100); // 200 UTF-16 units
    for (const piece of cutLongLine(text, 33)) {
      expect(piece.length).toBeLessThanOrEqual(33);
      expect(/^[\uDC00-\uDFFF]/.test(piece)).toBe(false);
      expect(/[\uD800-\uDBFF]$/.test(piece)).toBe(false);
    }
  });

  it('never splits an ANSI escape sequence', () => {
    const esc = '\u001b[31m';
    const text = `${'a'.repeat(18)}${esc}${'b'.repeat(30)}`;
    const pieces = cutLongLine(text, 20);
    expect(pieces[0]).toBe('a'.repeat(18));
    expect(pieces[1]!.startsWith(esc)).toBe(true);
  });

  it('prefers to cut on a space near the end', () => {
    const text = `${'a'.repeat(90)} ${'b'.repeat(50)}`;
    expect(cutLongLine(text, 100)[0]).toBe(`${'a'.repeat(90)} `);
  });

  it('lastPage follows the end of a growing text', () => {
    const text = Array.from({ length: 1000 }, (_, i) => `row ${i}`).join('\n');
    const page = lastPage(text, 200);
    expect(page.length).toBeLessThanOrEqual(200);
    expect(page.startsWith('…')).toBe(true);
    expect(page.endsWith('row 999')).toBe(true);
    expect(lastPage('short', 200)).toBe('short');
  });
});

// A fake token with the shape of a Discord bot token, joined at runtime so secret scanners don't flag it
const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'abcdefghijklmnopqrstuvwxyz0123456789AB'].join('.');
const PASSWORD = 'p@ss w/rd+secret';

describe('Redactor', () => {
  const r = new Redactor([TOKEN, PASSWORD, undefined, null, 'short']);

  it('ignores empty and too-short secrets', () => {
    expect(r.redact('short')).toBe('short');
  });

  it('hides the raw secret', () => {
    expect(r.redact(`token is ${TOKEN}!`)).toBe(`token is ${REDACTED}!`);
  });

  it('hides URL-encoded, base64, base64url, hex and JSON-escaped forms', () => {
    const buf = Buffer.from(PASSWORD);
    const forms = [
      encodeURIComponent(PASSWORD),
      buf.toString('base64'),
      buf.toString('base64').replace(/=+$/, ''),
      buf.toString('base64url'),
      buf.toString('hex'),
      buf.toString('hex').toUpperCase(),
      encodeURI(PASSWORD),
    ];
    for (const form of forms) expect(r.redact(`x=${form};`), form).toBe(`x=${REDACTED};`);
  });

  it('hides each part of a Discord token', () => {
    const [id, , hmac] = TOKEN.split('.');
    expect(r.redact(`id ${id}`)).toBe(`id ${REDACTED}`);
    expect(r.redact(`sig ${hmac}`)).toBe(`sig ${REDACTED}`);
  });

  it('JSON-escaped secrets with quotes and backslashes', () => {
    const tricky = 'ab"cd\\ef';
    const rr = new Redactor([tricky]);
    expect(rr.redact(JSON.stringify({ k: tricky }))).toBe(`{"k":"${REDACTED}"}`);
  });

  it('edges: hides half a secret at the start or end of a cut text', () => {
    const cut = `log line ${TOKEN.slice(0, 20)}`;
    expect(r.redact(cut)).toBe(cut);
    expect(r.redact(cut, { end: true })).toBe(`log line ${REDACTED}`);
    const head = `${TOKEN.slice(-15)} rest`;
    expect(r.redact(head, { start: true })).toBe(`${REDACTED} rest`);
    // Only the requested edge
    expect(r.redact(head, { end: true })).toBe(head);
  });

  it('add() rebuilds and works with no secrets', () => {
    const empty = new Redactor();
    expect(empty.redact('abc')).toBe('abc');
    empty.add('another-secret');
    expect(empty.redact('another-secret')).toBe(REDACTED);
  });

  it('variants include the raw value and skip short parts', () => {
    const v = secretVariants('abcdef');
    expect(v).toContain('abcdef');
    expect(v.every((x) => x.length >= 6)).toBe(true);
  });
});

describe('secretsFromEnv', () => {
  it('picks values of secret-looking keys only', () => {
    expect(
      secretsFromEnv({
        DISCORD_TOKEN: 'x1',
        API_KEY: 'x2',
        DB_PASSWORD: 'x3',
        HOME: '/srv/app',
        NODE_ENV: 'prod',
      }).sort(),
    ).toEqual(['x1', 'x2', 'x3']);
  });
});

describe('StreamRedactor', () => {
  const r = new Redactor([TOKEN]);

  it('catches a secret split across chunks', () => {
    const s = new StreamRedactor(r);
    s.push(`a ${TOKEN.slice(0, 30)}`);
    // While open, the half secret at the end is hidden
    expect(s.text(true)).not.toContain(TOKEN.slice(0, 30));
    s.push(`${TOKEN.slice(30)} b`);
    expect(s.text()).toBe(`a ${REDACTED} b`);
  });

  it('hides a partial secret at the trimmed front', () => {
    const s = new StreamRedactor(r, 40);
    s.push(`${'x'.repeat(30)}${TOKEN} tail`);
    expect(s.truncated).toBe(true);
    expect(s.text()).toBe(`${REDACTED} tail`);
  });
});

describe('diffLines', () => {
  it('no changes', () => {
    expect(diffLines('a\nb', 'a\nb')).toMatchObject({ added: 0, removed: 0, text: '  (no changes)' });
  });

  it('marks added and removed lines', () => {
    const d = diffLines('a\nb\nc', 'a\nB\nc\nd');
    expect(d.text).toBe('  a\n- b\n+ B\n  c\n+ d');
    expect(d).toMatchObject({ added: 2, removed: 1 });
  });

  it('folds long unchanged runs', () => {
    const before = Array.from({ length: 50 }, (_, i) => `l${i}`);
    const after = [...before];
    after[25] = 'changed';
    const d = diffLines(before.join('\n'), after.join('\n'), 2);
    expect(d.text.startsWith('@@ 23 unchanged lines @@\n  l23\n  l24\n')).toBe(true);
    expect(d.text.endsWith('  l26\n  l27\n@@ 22 unchanged lines @@')).toBe(true);
    expect(d.text).toContain('- l25\n+ changed');
  });

  it('falls back for huge inputs without hanging', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
    const started = Date.now();
    const d = diffLines(a, b);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(d).toMatchObject({ added: 3000, removed: 3000 });
  });
});
