import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  exitNote,
  followFile,
  hoistDeclarations,
  JsRunner,
  lastLines,
  runShell,
  shellFor,
  topLevelMask,
  transpileTs,
} from '../src/runners.js';

const run = (r: JsRunner, code: string, scope: Record<string, unknown> = {}, ownerId = 'owner') =>
  r.run(code, ownerId, scope);

describe('JsRunner', () => {
  it('evaluates an expression', async () => {
    const r = await run(new JsRunner(), '1 + 1');
    expect(r).toMatchObject({ ok: true, value: 2, kind: 'expression' });
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it('evaluates an object literal as an expression', async () => {
    expect((await run(new JsRunner(), '{ a: 1 }')).value).toEqual({ a: 1 });
  });

  it('runs statements with return', async () => {
    const r = await run(new JsRunner(), 'const a = 2;\nconst b = 3;\nreturn a * b;');
    expect(r).toMatchObject({ ok: true, value: 6, kind: 'statements' });
  });

  it('supports top-level await (expression and statements)', async () => {
    const runner = new JsRunner();
    expect((await run(runner, 'await Promise.resolve(5)')).value).toBe(5);
    expect((await run(runner, 'const x = await Promise.resolve(2); return x + 1')).value).toBe(3);
  });

  it('awaits a returned promise', async () => {
    expect((await run(new JsRunner(), 'new Promise((r) => setTimeout(() => r("done"), 5))')).value).toBe('done');
  });

  it('exposes scope variables (client, ctx, …)', async () => {
    const client = { name: 'bot' };
    expect((await run(new JsRunner(), 'client.name', { client })).value).toBe('bot');
  });

  it('globals still work and are not shadowed by accident', async () => {
    const r = await run(new JsRunner(), 'typeof console.log + typeof Promise + Math.max(1, 2)');
    expect(r.value).toBe('functionfunction2');
  });

  it('_ is the last result and $1…$n are earlier results', async () => {
    const runner = new JsRunner();
    await run(runner, '10');
    await run(runner, '20');
    expect((await run(runner, '_ + 1')).value).toBe(21);
    expect((await run(runner, '[$1, $2, $3]')).value).toEqual([21, 20, 10]);
  });

  it('keeps variables per owner (retain)', async () => {
    const runner = new JsRunner();
    await run(runner, 'const kept = 41', {}, 'a');
    await run(runner, 'counter = 1', {}, 'a');
    await run(runner, 'function twice(n) { return n * 2 }', {}, 'a');
    await run(runner, 'class Box { constructor(v) { this.v = v } }', {}, 'a');
    expect((await run(runner, 'kept + counter', {}, 'a')).value).toBe(42);
    expect((await run(runner, 'twice(new Box(4).v)', {}, 'a')).value).toBe(8);
    expect(runner.variables('a').sort()).toEqual(['Box', 'counter', 'kept', 'twice']);
    // Another owner does not see them
    const other = await run(runner, 'kept', {}, 'b');
    expect(other.ok).toBe(false);
    expect(String(other.error)).toContain('kept is not defined');
  });

  it('assignments never leak to globals', async () => {
    const runner = new JsRunner();
    await run(runner, 'leakTest123 = 5');
    expect((globalThis as Record<string, unknown>).leakTest123).toBeUndefined();
  });

  it('retain off starts each run fresh; reset clears everything', async () => {
    const runner = new JsRunner();
    expect(runner.retain('o')).toBe(true);
    await run(runner, 'const a = 1', {}, 'o');
    runner.retain('o', false);
    expect((await run(runner, 'a', {}, 'o')).ok).toBe(false);
    runner.retain('o', true);
    await run(runner, 'const b = 2', {}, 'o');
    expect((await run(runner, 'b', {}, 'o')).value).toBe(2);
    runner.reset('o');
    expect((await run(runner, 'b', {}, 'o')).ok).toBe(false);
    expect((await run(runner, 'typeof _', {}, 'o')).ok).toBe(false);
  });

  it('kept variables expire after the TTL', async () => {
    let now = 0;
    const runner = new JsRunner({ ttlMs: 1000, now: () => now });
    await run(runner, 'const a = 1');
    now = 2000;
    expect((await run(runner, 'a')).ok).toBe(false);
  });

  it('scope names win over kept variables', async () => {
    const runner = new JsRunner();
    await run(runner, 'client = "kept"');
    expect((await run(runner, 'client', { client: 'real' })).value).toBe('real');
  });

  it('reports thrown errors and syntax errors without throwing', async () => {
    const runner = new JsRunner();
    const thrown = await run(runner, 'throw new TypeError("nope")');
    expect(thrown.ok).toBe(false);
    expect(thrown.error).toBeInstanceOf(TypeError);
    const syntax = await run(runner, 'const = ;');
    expect(syntax.ok).toBe(false);
    expect(syntax.error).toBeInstanceOf(SyntaxError);
    const rejected = await run(runner, 'await Promise.reject(new Error("async"))');
    expect((rejected.error as Error).message).toBe('async');
  });

  it('history keeps at most historySize results', async () => {
    const runner = new JsRunner({ historySize: 2 });
    await run(runner, '1');
    await run(runner, '2');
    await run(runner, '3');
    expect((await run(runner, 'typeof $3')).ok).toBe(false);
  });
});

describe('hoistDeclarations', () => {
  it('rewrites top-level declarations only', () => {
    expect(hoistDeclarations('const a = 1;\nlet b;\nvar c = 2, d = 3')).toBe('a = 1;\nb = undefined;\nc = 2, d = 3');
    expect(hoistDeclarations('if (x) { const inner = 1 }')).toBe('if (x) { const inner = 1 }');
    expect(hoistDeclarations('for (const i of a) {}')).toBe('for (const i of a) {}');
    expect(hoistDeclarations('async function f() {}')).toBe('f = async function f() {}');
    expect(hoistDeclarations('class A extends B {}')).toBe('A = class A extends B {}');
  });

  it('ignores declarations inside strings, comments, templates and regexes', () => {
    const code = [
      'const s = "const x = 1";',
      '// const y = 2',
      '/* let z = 3 */',
      'const t = `${ (() => { const q = 1; return q })() } const w = 1`;',
      'const r = /const v = 1/g;',
    ].join('\n');
    const out = hoistDeclarations(code);
    expect(out).toContain('s = "const x = 1"');
    expect(out).toContain('// const y = 2');
    expect(out).toContain('/* let z = 3 */');
    expect(out).toContain('const q = 1');
    expect(out).toContain(' const w = 1`');
    expect(out).toContain('r = /const v = 1/g');
  });

  it('does not touch identifiers that only contain a keyword', () => {
    expect(hoistDeclarations('constant = 1; letter = 2')).toBe('constant = 1; letter = 2');
  });

  it('leaves destructuring alone', () => {
    expect(hoistDeclarations('const { a } = obj')).toBe('const { a } = obj');
  });

  it('topLevelMask marks nested code as not top level', () => {
    const mask = topLevelMask('a{b}c');
    expect(mask).toEqual([true, false, false, false, true]);
  });
});

describe('ts runner', () => {
  it('strips types from an expression', async () => {
    const js = await transpileTs('(1 as number) + (2 satisfies number)');
    const r = await new JsRunner().run(js, 'o');
    expect(r.value).toBe(3);
  });

  it('handles statements with types, interfaces, await and return', async () => {
    const js = await transpileTs(
      'interface P { n: number }\nconst p: P = { n: await Promise.resolve(4) };\nreturn p.n * 2;',
    );
    expect(js).not.toContain('interface');
    const r = await new JsRunner().run(js, 'o');
    expect(r.value).toBe(8);
  });

  it('uses a custom transpiler when given', async () => {
    const js = await transpileTs('x', (code) => code.replace('x', '42'));
    expect(js).toBe('42');
  });

  it('reports TypeScript syntax errors', async () => {
    await expect(transpileTs('const a: = ;')).rejects.toThrow();
  });
});

const isWindows = process.platform === 'win32';

// Commands per platform. On Windows the default shell is PowerShell.
const cmd = {
  echoBoth: isWindows ? `Write-Output 'out'; [Console]::Error.WriteLine('err')` : `echo out; echo err 1>&2`,
  exit3: 'exit 3',
  // A shell whose child (the long sleep) would keep the pipes open if only the shell were killed
  longChild: isWindows ? 'ping -n 60 127.0.0.1 | Out-Null; Write-Output after' : 'sleep 60; echo after',
  readLine: isWindows ? '$l = [Console]::In.ReadLine(); Write-Output "got:$l"' : 'read l; echo "got:$l"',
  utf8: isWindows
    ? "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output 'héllo ✓'"
    : "printf 'h\\303\\251llo \\342\\234\\223\\n'",
};

function collect() {
  const chunks: { chunk: string; stream: string }[] = [];
  return {
    onData: (chunk: string, stream: string) => chunks.push({ chunk, stream }),
    text: () => chunks.map((c) => c.chunk).join(''),
    streams: () => new Set(chunks.map((c) => c.stream)),
  };
}

describe('runShell', () => {
  it('picks PowerShell on Windows, $SHELL/bash elsewhere, and the right arguments for a custom shell', () => {
    expect(shellFor(undefined, 'win32').command).toBe('powershell.exe');
    expect(shellFor(undefined, 'linux').args).toEqual(['-c']);
    expect(shellFor('C:\\Program Files\\PowerShell\\7\\pwsh.exe').args).toContain('-Command');
    expect(shellFor('cmd.exe').args).toEqual(['/d', '/s', '/c']);
    expect(shellFor('/bin/zsh').args).toEqual(['-c']);
  });

  it('streams stdout and stderr', async () => {
    const out = collect();
    const exit = await runShell(cmd.echoBoth, out.onData).done;
    expect(exit.code).toBe(0);
    expect(out.text()).toContain('out');
    expect(out.text()).toContain('err');
    expect(out.streams()).toEqual(new Set(['stdout', 'stderr']));
  });

  it('reports the exit code', async () => {
    const exit = await runShell(cmd.exit3, () => undefined).done;
    expect(exit).toMatchObject({ code: 3, killed: false, timedOut: false });
    expect(exitNote(exit)).toBe('exit 3');
  });

  it('keeps multi-byte characters whole', async () => {
    const out = collect();
    await runShell(cmd.utf8, out.onData).done;
    expect(out.text()).toContain('héllo ✓');
  });

  it('Kill stops the shell and its child in under 2.5 s', async () => {
    const out = collect();
    const handle = runShell(cmd.longChild, out.onData);
    expect(handle.running).toBe(true);
    // Let the child start
    await new Promise((r) => setTimeout(r, isWindows ? 1500 : 300));
    const killedAt = Date.now();
    handle.kill();
    const exit = await handle.done;
    const took = Date.now() - killedAt;
    expect(took).toBeLessThan(2500);
    expect(exit.killed).toBe(true);
    expect(out.text()).not.toContain('after');
    expect(exitNote(exit)).toMatch(/\[killed\]$/);
    expect(handle.running).toBe(false);
  });

  it('times out', async () => {
    const handle = runShell(cmd.longChild, () => undefined, { timeoutMs: isWindows ? 2000 : 300 });
    const exit = await handle.done;
    expect(exit).toMatchObject({ killed: true, timedOut: true });
    expect(exitNote(exit, '300 ms')).toBe('[timed out after 300 ms]');
  });

  it('an AbortSignal kills it', async () => {
    const ac = new AbortController();
    const handle = runShell(cmd.longChild, () => undefined, { signal: ac.signal });
    setTimeout(() => ac.abort(), isWindows ? 1000 : 200);
    const exit = await handle.done;
    expect(exit.killed).toBe(true);
  });

  it('sends input to stdin', async () => {
    const out = collect();
    const handle = runShell(cmd.readLine, out.onData);
    expect(handle.write('hello\n')).toBe(true);
    handle.end();
    await handle.done;
    expect(out.text()).toContain('got:hello');
    expect(handle.write('late')).toBe(false);
  });

  it('reports a shell that cannot start', async () => {
    const out = collect();
    const exit = await runShell('x', out.onData, { shell: { command: 'definitely-not-a-shell-xyz', args: [] } }).done;
    expect(exit.error).toBeInstanceOf(Error);
    expect(exitNote(exit)).toMatch(/^\[failed to start/);
  });
});

describe('followFile', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'byaku-tail-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lastLines returns the end of a file', async () => {
    const file = join(dir, 'last.log');
    await writeFile(file, Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') + '\n');
    const { text } = await lastLines(file, 3);
    expect(text).toBe('line 97\nline 98\nline 99\n');
  });

  it('follows appended text and stops on abort', async () => {
    const file = join(dir, 'follow.log');
    await writeFile(file, 'old 1\nold 2\n');
    const ac = new AbortController();
    const chunks: string[] = [];
    const done = followFile(file, (c) => chunks.push(c), { lines: 1, pollMs: 30, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 60));
    await appendFile(file, 'new 1\n');
    await new Promise((r) => setTimeout(r, 120));
    await appendFile(file, 'new 2\n');
    await new Promise((r) => setTimeout(r, 120));
    ac.abort();
    expect(await done).toEqual({ reason: 'aborted' });
    expect(chunks.join('')).toBe('old 2\nnew 1\nnew 2\n');
  });

  it('notices truncation', async () => {
    const file = join(dir, 'trunc.log');
    await writeFile(file, 'aaaaaaaaaa\n');
    const ac = new AbortController();
    const chunks: string[] = [];
    const done = followFile(file, (c) => chunks.push(c), { lines: 0, pollMs: 30, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 60));
    await writeFile(file, 'b\n');
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    await done;
    expect(chunks.join('')).toContain('[file was truncated or replaced]');
    expect(chunks.join('')).toContain('b\n');
  });

  it('rejects a missing file', async () => {
    await expect(followFile(join(dir, 'missing.log'), () => undefined)).rejects.toThrow();
  });
});
