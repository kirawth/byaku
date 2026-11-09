import { describe, expect, it } from 'vitest';

import {
  breadcrumb,
  constructorName,
  describeValue,
  formatError,
  formatValue,
  inspectValue,
  listEntries,
  preview,
  prototypeChain,
  resolvePath,
  resolveStep,
  sizeOf,
  typeName,
  type PathStep,
} from '../src/inspect.js';
import { ByakuError } from '../src/options.js';

class Base {
  baseField = 1;
  get computed(): number {
    return this.baseField * 2;
  }
}
class Child extends Base {
  childField = 'c';
}

describe('inspect', () => {
  it('formatValue shows strings as-is and inspects the rest', () => {
    expect(formatValue('hello')).toBe('hello');
    expect(formatValue({ a: { b: { c: 1 } } })).toBe('{ a: { b: [Object] } }');
    expect(formatValue({ a: { b: { c: 1 } } }, { depth: 2 })).toBe('{ a: { b: { c: 1 } } }');
  });

  it('shows function source with a header', () => {
    function add(a: number, b: number) {
      return a + b;
    }
    const out = formatValue(add);
    expect(out.startsWith('// function add · 2 parameter(s)')).toBe(true);
    expect(out).toContain('return a + b');
  });

  it('depth is clamped to 0–6', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } };
    expect(inspectValue(deep, { depth: 99 })).toContain('[Object]');
  });

  it('hidden shows non-enumerable keys; getters runs getters', () => {
    const o = Object.defineProperty({ v: 1 }, 'secret', { value: 2, enumerable: false });
    expect(inspectValue(o)).not.toContain('secret');
    expect(inspectValue(o, { hidden: true })).toContain('secret');
    const g = {
      get x() {
        return 42;
      },
    };
    expect(inspectValue(g)).toContain('[Getter]');
    expect(inspectValue(g, { getters: true })).toContain('42');
  });

  it('never throws on hostile objects', () => {
    const evil = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
        ownKeys() {
          throw new Error('boom');
        },
        getPrototypeOf() {
          throw new Error('boom');
        },
      },
    );
    expect(() => inspectValue(evil)).not.toThrow();
    expect(() => describeValue(evil)).not.toThrow();
    expect(typeof sizeOf(evil)).toBe('string');
  });

  it('typeName, constructorName, sizeOf', () => {
    expect(typeName(null)).toBe('null');
    expect(typeName([1])).toBe('array');
    expect(typeName(new Map())).toBe('Map');
    expect(typeName(Child)).toBe('class');
    expect(typeName(() => 1)).toBe('function');
    expect(typeName(1n)).toBe('bigint');
    expect(constructorName(Object.create(null))).toBe('null-prototype');
    expect(sizeOf(new Set([1, 2]))).toBe('size 2');
    expect(sizeOf(Buffer.alloc(3))).toBe('3 bytes');
    expect(sizeOf({ a: 1, b: 2 })).toBe('2 keys');
  });

  it('prototypeChain and describeValue (jsi)', () => {
    expect(prototypeChain(new Child())).toEqual(['Child', 'Base', 'Object']);
    const text = describeValue(new Child());
    expect(text).toContain('Type:        Child');
    expect(text).toContain('Prototype:   Child → Base → Object');
    expect(text).toContain('Own keys:    baseField, childField');
    expect(text).toContain('Inherited:   computed');
    expect(describeValue(5)).toContain('Type:        number');
  });

  it('formatError includes causes', () => {
    const err = new Error('outer', { cause: new Error('inner') });
    const text = formatError(err);
    expect(text).toContain('Error: outer');
    expect(text).toContain('Caused by: Error: inner');
    expect(formatError('plain')).toBe("Uncaught 'plain'");
  });
});

describe('explorer', () => {
  const root = {
    cache: { guilds: new Map([['111', { name: 'Guild A' }]]), users: new Set(['u1', 'u2']) },
    list: [10, 20, 30],
    [Symbol('tag')]: 'sym-value',
    child: new Child(),
  };

  it('lists own keys with type and preview', () => {
    const entries = listEntries(root);
    expect(entries.map((e) => e.label)).toEqual(['cache', 'list', 'child']);
    expect(entries[1]!.description).toContain('array (length 3)');
    for (const e of entries) {
      expect(e.label.length).toBeLessThanOrEqual(100);
      expect(e.description.length).toBeLessThanOrEqual(100);
    }
  });

  it('shows class getters but only opens them with getters on', () => {
    const entries = listEntries(root.child);
    const getter = entries.find((e) => e.label === 'computed');
    expect(getter?.getter).toBe(true);
    expect(() => resolveStep(root.child, getter!.step)).toThrow(ByakuError);
    expect(resolveStep(root.child, getter!.step, { getters: true })).toBe(2);
    const opened = listEntries(root.child, { getters: true }).find((e) => e.label === 'computed');
    expect(opened?.getter).toBeUndefined();
    expect(opened?.description).toContain('number');
  });

  it('hidden lists symbols and non-enumerable keys', () => {
    const labels = listEntries(root, { hidden: true }).map((e) => e.label);
    expect(labels).toContain('Symbol(tag)');
    const sym = listEntries(root, { hidden: true }).find((e) => e.step.kind === 'symbol')!;
    expect(resolveStep(root, sym.step)).toBe('sym-value');
    expect(listEntries([1, 2]).map((e) => e.label)).toEqual(['0', '1']);
    expect(listEntries([1, 2], { hidden: true }).map((e) => e.label)).toContain('length');
  });

  it('walks Maps and Sets by position', () => {
    const path: PathStep[] = [
      { kind: 'prop', key: 'cache' },
      { kind: 'prop', key: 'guilds' },
    ];
    const guilds = resolvePath(root, path);
    const [entry] = listEntries(guilds);
    expect(entry!.label).toBe('111');
    expect(resolvePath(root, [...path, entry!.step, { kind: 'prop', key: 'name' }])).toBe('Guild A');
    const users = listEntries(root.cache.users);
    expect(users.map((u) => u.label)).toEqual(['[0]', '[1]']);
    expect(resolveStep(root.cache.users, users[1]!.step)).toBe('u2');
  });

  it('reports steps that no longer exist', () => {
    expect(() => resolvePath(root, [{ kind: 'prop', key: 'gone' }])).toThrow(/no longer exists/);
    expect(() => resolveStep(5, { kind: 'prop', key: 'x' })).toThrow(/no keys/);
    expect(() => resolveStep(new Map(), { kind: 'map', index: 3, label: 'k' })).toThrow(ByakuError);
  });

  it('primitives have no entries; hostile objects throw a ByakuError', () => {
    expect(listEntries(42)).toEqual([]);
    const evil = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('no');
        },
      },
    );
    expect(() => listEntries(evil)).toThrow(ByakuError);
  });

  it('breadcrumb', () => {
    expect(
      breadcrumb('client', [
        { kind: 'prop', key: 'cache' },
        { kind: 'prop', key: 'guilds' },
      ]),
    ).toBe('client › cache › guilds');
    expect(
      breadcrumb('x', [
        { kind: 'prop', key: '0' },
        { kind: 'map', index: 0, label: 'k' },
        { kind: 'set', index: 2 },
      ]),
    ).toBe('x › [0] › {k} › <2>');
    const long = Array.from({ length: 30 }, (_, i): PathStep => ({ kind: 'prop', key: `segment${i}` }));
    const text = breadcrumb('client', long, 60);
    expect(text.length).toBeLessThanOrEqual(60);
    expect(text.startsWith('client › … › ')).toBe(true);
    expect(text.endsWith('segment29')).toBe(true);
  });

  it('lists at most 1,000 entries', () => {
    const big = Object.fromEntries(Array.from({ length: 1500 }, (_, i) => [`k${i}`, i]));
    expect(listEntries(big)).toHaveLength(1000);
    expect(listEntries(new Map(Array.from({ length: 1500 }, (_, i) => [i, i])))).toHaveLength(1000);
  });

  it('explorer errors carry the EXPLORER code', () => {
    expect(() => resolvePath({}, [{ kind: 'prop', key: 'x' }])).toThrow(expect.objectContaining({ code: 'EXPLORER' }));
  });

  it('preview is one short line', () => {
    expect(preview({ a: 1, b: [1, 2, 3] })).toBe('{ a: 1, b: [Array] }');
    expect(preview('x'.repeat(500)).length).toBeLessThanOrEqual(90);
  });
});
