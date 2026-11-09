import { describe, expect, it } from 'vitest';

import {
  boolFlag,
  buildTriggers,
  DEFAULT_CONFIRM_RULES,
  findRiskyRule,
  matchTrigger,
  numberFlag,
  parseFlags,
  parseInput,
  splitFirst,
  stripFences,
  tokenize,
} from '../src/parse.js';

const MODES: Record<string, string> = {
  js: 'js',
  e: 'js',
  eval: 'js',
  sh: 'sh',
  $: 'sh',
  git: 'git',
  su: 'su',
  curl: 'curl',
};
const resolve = (w: string) => MODES[w];

describe('triggers', () => {
  const triggers = buildTriggers({
    prefixes: ['?byaku', '?by'],
    botPrefixes: ['!', '?'],
    names: ['byaku', 'jsk'],
    botId: '111111111111111111',
  });

  it('sorts longest first and combines bot prefixes with names', () => {
    expect(triggers).toContain('!jsk');
    expect(triggers).toContain('?byaku');
    expect(triggers).toContain('<@111111111111111111> byaku');
    for (let i = 1; i < triggers.length; i++)
      expect(triggers[i - 1]!.length).toBeGreaterThanOrEqual(triggers[i]!.length);
  });

  it('matches only whole triggers, ignoring case', () => {
    expect(matchTrigger('?by js 1', triggers)).toBe('js 1');
    expect(matchTrigger('?BYAKU', triggers)).toBe('');
    expect(matchTrigger('?fnord', triggers)).toBeUndefined();
    expect(matchTrigger('hello ?by', triggers)).toBeUndefined();
    expect(matchTrigger('<@111111111111111111> byaku sh ls', triggers)).toBe('sh ls');
  });

  it('keeps newlines and code fences in the rest', () => {
    expect(matchTrigger('?by\n```js\n1\n```', triggers)).toBe('```js\n1\n```');
  });
});

describe('stripFences', () => {
  it('removes a block fence and returns the language', () => {
    expect(stripFences('```ts\nconst a: number = 1\n```')).toEqual({ code: 'const a: number = 1', lang: 'ts' });
    expect(stripFences('```javascript\nx\n```')).toEqual({ code: 'x', lang: 'js' });
  });

  it('handles one-line and inline code', () => {
    expect(stripFences('```1 + 1```')).toEqual({ code: '1 + 1' });
    expect(stripFences('`a`')).toEqual({ code: 'a' });
  });

  it('leaves plain code alone (including inner backticks)', () => {
    expect(stripFences('const s = `x`;  ')).toEqual({ code: 'const s = `x`;' });
  });
});

describe('flags', () => {
  it('reads flags before the code only', () => {
    const r = parseFlags('--depth=3 --unsafe return a --b');
    expect(r.flags).toEqual({ depth: '3', unsafe: true });
    expect(r.rest).toBe('return a --b');
  });

  it('stops at --', () => {
    expect(parseFlags('--yes -- --not-a-flag').rest).toBe('--not-a-flag');
  });

  it('does not treat code that starts with -- as a flag', () => {
    expect(parseFlags('--i').flags).toEqual({ i: true });
    expect(parseFlags('--x;').rest).toBe('--x;');
  });

  it('numberFlag and boolFlag', () => {
    expect(numberFlag({ depth: '9' }, 'depth', 1, 0, 6)).toBe(6);
    expect(numberFlag({ depth: 'x' }, 'depth', 1)).toBe(1);
    expect(boolFlag({ yes: true }, 'yes')).toBe(true);
    expect(boolFlag({ yes: 'false' }, 'yes')).toBe(false);
    expect(boolFlag({}, 'yes')).toBe(false);
  });
});

describe('parseInput', () => {
  it('empty input is the summary', () => {
    expect(parseInput('  ', resolve).mode).toBeUndefined();
  });

  it('resolves aliases and keeps quotes, colons and flags inside code', () => {
    const r = parseInput(`e --depth=2 ({ a: "x y", 'b': -1 })`, resolve);
    expect(r.mode).toBe('js');
    expect(r.flags).toEqual({ depth: '2' });
    expect(r.body).toBe(`({ a: "x y", 'b': -1 })`);
  });

  it('unknown first word runs as JavaScript with the whole text', () => {
    const r = parseInput('client.ws.ping', resolve);
    expect(r.mode).toBe('js');
    expect(r.body).toBe('client.ws.ping');
  });

  it('a bare code block is JavaScript and its language is kept', () => {
    const r = parseInput('```ts\nlet a = 1\n```', resolve);
    expect(r.mode).toBe('js');
    expect(r.lang).toBe('ts');
    expect(r.body).toBe('let a = 1');
  });

  it('mode then fenced code', () => {
    const r = parseInput('sh\n```sh\necho "a b"\n```', resolve);
    expect(r.mode).toBe('sh');
    expect(r.body).toBe('echo "a b"');
  });

  it('the $ alias works', () => {
    expect(parseInput('$ ls -la', resolve)).toMatchObject({ mode: 'sh', body: 'ls -la' });
  });
});

describe('tokenize', () => {
  it('handles quotes and escapes like a shell', () => {
    expect(tokenize(`-H 'content-type: application/json' -d "{\\"a\\":1}" https://x.y`)).toEqual([
      '-H',
      'content-type: application/json',
      '-d',
      '{"a":1}',
      'https://x.y',
    ]);
  });

  it('keeps empty quoted strings and joins adjacent parts', () => {
    expect(tokenize(`a "" b'c'd`)).toEqual(['a', '', 'bcd']);
  });

  it('unclosed quotes run to the end', () => {
    expect(tokenize(`say "hello world`)).toEqual(['say', 'hello world']);
  });

  it('splitFirst keeps the rest untouched', () => {
    expect(splitFirst('  reload   ping  "x"')).toEqual(['reload', 'ping  "x"']);
    expect(splitFirst('')).toEqual(['', '']);
  });
});

describe('confirm rules', () => {
  const risky = (mode: string, input: string) => findRiskyRule(DEFAULT_CONFIRM_RULES, mode, input);

  it.each([
    ['sh', 'rm -rf ./dist'],
    ['sh', 'sudo rm -r /var/x'],
    ['sh', 'Remove-Item C:\\x -Recurse -Force'],
    ['git', 'git push origin main --force'],
    ['git', 'git reset --hard HEAD~3'],
    ['js', 'process.exit(1)'],
    ['js', 'await client.close()'],
    ['cache', 'clear users'],
    ['cmd', 'sync'],
    ['sql', 'DROP TABLE users'],
    ['sql', 'truncate table logs'],
    ['sql', 'delete from users;'],
    ['sql', 'UPDATE users SET a = 1'],
    ['redis', 'FLUSHALL'],
  ])('%s: %s asks first', (mode, input) => {
    expect(risky(mode, input)).toBeDefined();
  });

  it.each([
    ['sh', 'ls -la'],
    ['sh', 'rm file.txt'],
    ['js', 'client.cache.guilds.count()'],
    ['sql', 'delete from users where id = 1'],
    ['sql', 'update users set a = 1 where id = 2'],
    ['cache', 'get users 1'],
    ['cmd', 'list'],
    ['js', 'rm -rf /'],
  ])('%s: %s runs directly', (mode, input) => {
    expect(risky(mode, input)).toBeUndefined();
  });

  it('extra rules, including ones with the g flag, match every time', () => {
    const rules = [{ pattern: /deploy/g, reason: 'deploys' }];
    expect(findRiskyRule(rules, 'js', 'deploy()')?.reason).toBe('deploys');
    expect(findRiskyRule(rules, 'js', 'deploy()')?.reason).toBe('deploys');
  });
});
