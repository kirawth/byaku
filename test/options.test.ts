import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ByakuError, parseDuration, resolveOptions, VERSION } from '../src/options.js';

describe('resolveOptions', () => {
  it('has easy defaults', () => {
    const o = resolveOptions({ owners: ['1'] });
    expect(o).toMatchObject({
      enabled: true,
      includeAppOwners: true,
      prefixGuard: true,
      sessionTtlMs: 900_000,
      shellTimeoutMs: 300_000,
      editRerunMs: 300_000,
      prefixes: [],
      slash: undefined,
    });
    expect([...o.owners]).toEqual(['1']);
    expect(resolveOptions().owners.size).toBe(0);
  });

  it('reads grouped advanced options', () => {
    const o = resolveOptions({
      prefixes: [' ?by '],
      secrets: ['abcdefgh', undefined, null],
      slash: { guilds: ['9'] },
      advanced: { enabled: false, timeouts: { session: '1m', shell: 2000 }, limits: { pageSize: 500 } },
    });
    expect(o).toMatchObject({
      enabled: false,
      prefixes: ['?by'],
      secrets: ['abcdefgh'],
      slash: { guilds: ['9'] },
      sessionTtlMs: 60_000,
      shellTimeoutMs: 2000,
    });
    expect(o.limits.pageSize).toBe(500);
    expect(resolveOptions({ slash: true }).slash).toEqual({});
  });

  it.each([
    [{ prefix: ['?'] }, /Unknown option "prefix"/],
    [{ advanced: { enable: true } }, /Unknown option "advanced.enable"/],
    [{ advanced: { timeouts: { sesion: '1m' } } }, /Unknown option "advanced.timeouts.sesion"/],
    [{ owners: '123' }, /"owners" must be an array of non-empty strings/],
    [{ owners: [''] }, /"owners" must be an array/],
    [{ secrets: [1] }, /"secrets" must be an array of strings/],
    [{ audit: 'log' }, /"audit" must be a function/],
    [{ slash: { guild: ['1'] } }, /Unknown option "slash.guild"/],
    [{ advanced: { timeouts: { shell: 'soon' } } }, /"advanced.timeouts.shell" is not a duration/],
    [{ advanced: { limits: { pageSize: 50 } } }, /pageSize" must be between 100 and 1900/],
    [{ advanced: { limits: { catBytes: -1 } } }, /must be a positive number/],
    [{ advanced: 'yes' }, /advanced must be an object/],
  ])('rejects %j with one clear error', (options, message) => {
    let error: unknown;
    try {
      resolveOptions(options as never);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ByakuError);
    expect((error as ByakuError).code).toBe('INVALID_OPTION');
    expect((error as ByakuError).message).toMatch(message);
  });
});

describe('parseDuration', () => {
  it('parses text and numbers', () => {
    expect(parseDuration(1500)).toBe(1500);
    expect(parseDuration('250')).toBe(250);
    expect(parseDuration('2s')).toBe(2000);
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('1.5s')).toBe(1500);
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('2 min')).toBe(120_000);
  });

  it('rejects nonsense with INVALID_DURATION', () => {
    for (const bad of ['soon', '5x', -1]) {
      expect(() => parseDuration(bad)).toThrow(ByakuError);
    }
    expect(() => parseDuration('5x')).toThrow(expect.objectContaining({ code: 'INVALID_DURATION' }));
  });
});

it('VERSION matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  expect(VERSION).toBe(pkg.version);
});
