import { inspect } from 'node:util';

import { ByakuError } from './options.js';
import { truncate } from './output.js';

export const MAX_DEPTH = 6;

export interface ViewOptions {
  depth?: number;
  /** Non-enumerable keys and symbols. */
  hidden?: boolean;
  /** Run getters. */
  getters?: boolean;
}

/**
 * A step from a value to one of its children. Plain data (Map keys and symbols are referred to by position),
 * so a path can be stored in a session and walked again later.
 */
export type PathStep =
  | { kind: 'prop'; key: string }
  | { kind: 'symbol'; index: number; label: string }
  | { kind: 'map'; index: number; label: string }
  | { kind: 'set'; index: number };

export interface ExplorerEntry {
  step: PathStep;
  label: string;
  description: string;
  /** A getter that was not run. */
  getter?: boolean;
}

const MAX_ENTRIES = 1_000;

// Eval results can be proxies or objects with throwing getters, so everything here must survive both

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Strings are shown as they are; functions with their source. */
export function formatValue(value: unknown, options: ViewOptions = {}): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'function') {
    const source = safely(() => Function.prototype.toString.call(value), '[function]');
    const kind = /^class\b/.test(source) ? 'class' : 'function';
    return `// ${kind} ${value.name || '(anonymous)'} · ${value.length} parameter(s)\n${source}`;
  }
  return inspectValue(value, options);
}

export function inspectValue(value: unknown, options: ViewOptions = {}): string {
  return safely(
    () =>
      inspect(value, {
        depth: Math.max(0, Math.min(MAX_DEPTH, options.depth ?? 1)),
        showHidden: options.hidden ?? false,
        getters: options.getters ?? false,
        maxArrayLength: 100,
        maxStringLength: 10_000,
        breakLength: 100,
      }),
    (err) => `[could not inspect value: ${errorMessage(err)}]`,
  );
}

export function formatError(err: unknown): string {
  if (!(err instanceof Error)) return `Uncaught ${inspectValue(err, { depth: 2 })}`;
  const lines = [err.stack ?? `${err.name}: ${err.message}`];
  let cause = err.cause;
  for (let i = 0; cause !== undefined && i < 5; i++) {
    lines.push(`Caused by: ${cause instanceof Error ? (cause.stack ?? cause.message) : inspectValue(cause)}`);
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return lines.join('\n');
}

export function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'function') {
    return /^class\b/.test(safely(() => Function.prototype.toString.call(value), '')) ? 'class' : 'function';
  }
  if (typeof value !== 'object') return typeof value;
  return constructorName(value) ?? 'object';
}

export function constructorName(value: object): string | undefined {
  return safely(() => {
    const proto = Object.getPrototypeOf(value) as { constructor?: { name?: unknown } } | null;
    if (proto === null) return 'null-prototype';
    const name = proto.constructor?.name;
    return typeof name === 'string' && name ? name : undefined;
  }, undefined);
}

export function sizeOf(value: unknown): string {
  return safely(() => {
    if (typeof value === 'string' || Array.isArray(value)) return `length ${value.length}`;
    if (value instanceof Map || value instanceof Set) return `size ${value.size}`;
    if (Buffer.isBuffer(value)) return `${value.length} bytes`;
    if (ArrayBuffer.isView(value)) return `${value.byteLength} bytes`;
    if (value && typeof value === 'object') return `${Object.keys(value).length} keys`;
    return '';
  }, '');
}

export function prototypeChain(value: unknown): string[] {
  const chain: string[] = [];
  if (value === null || value === undefined) return chain;
  safely(() => {
    for (
      let proto = Object.getPrototypeOf(Object(value));
      proto && chain.length < 12;
      proto = Object.getPrototypeOf(proto)
    ) {
      const name = (proto as { constructor?: { name?: unknown } }).constructor?.name;
      chain.push(typeof name === 'string' && name ? name : '(anonymous)');
    }
  }, undefined);
  return chain;
}

/** What `jsi` shows: type, class, size, prototype chain, own and inherited keys, then a shallow view. */
export function describeValue(value: unknown): string {
  const type = typeName(value);
  const ctor =
    value !== null && (typeof value === 'object' || typeof value === 'function') ? constructorName(value) : undefined;
  const size = sizeOf(value);
  const chain = prototypeChain(value);
  const lines = [`Type:        ${type}${ctor && ctor.toLowerCase() !== type.toLowerCase() ? ` (${ctor})` : ''}`];
  if (size) lines.push(`Size:        ${size}`);
  if (chain.length) lines.push(`Prototype:   ${chain.join(' → ')}`);

  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    const own = safely(() => Reflect.ownKeys(value).map(String), []);
    const inherited = new Set<string>();
    safely(() => {
      for (
        let p = Object.getPrototypeOf(value);
        p && p !== Object.prototype && p !== Function.prototype;
        p = Object.getPrototypeOf(p)
      ) {
        for (const key of Object.getOwnPropertyNames(p)) if (key !== 'constructor') inherited.add(key);
      }
    }, undefined);
    lines.push(`Own keys:    ${own.length ? keyList(own) : '(none)'}`);
    if (inherited.size) lines.push(`Inherited:   ${keyList([...inherited])}`);
  }

  lines.push('', inspectValue(value, { depth: 0 }));
  return lines.join('\n');
}

function keyList(keys: string[]): string {
  const shown = keys.slice(0, 40).join(', ');
  return keys.length > 40 ? `${shown}, … (+${keys.length - 40})` : shown;
}

/** One line: `Map(3)`, `'hello'`, `[Function: run]`. Never runs getters. */
export function preview(value: unknown, max = 90): string {
  return truncate(
    safely(
      () =>
        inspect(value, { depth: 0, breakLength: Infinity, maxArrayLength: 5, maxStringLength: 80 }).replace(
          /\s+/g,
          ' ',
        ),
      (err) => `[${errorMessage(err)}]`,
    ),
    max,
  );
}

function describe(value: unknown): string {
  const size = sizeOf(value);
  return truncate(`${typeName(value)}${size ? ` (${size})` : ''} · ${preview(value, 70)}`, 100);
}

function findDescriptor(target: object, key: string): PropertyDescriptor | undefined {
  return safely(() => {
    for (let obj: object | null = target, depth = 0; obj && depth < 32; obj = Object.getPrototypeOf(obj), depth++) {
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (desc) return desc;
    }
    return undefined;
  }, undefined);
}

/** Class getters such as `client.latency` live on the prototype, so `Object.keys` doesn't list them. */
function inheritedGetters(target: object): string[] {
  const names: string[] = [];
  safely(() => {
    for (
      let p = Object.getPrototypeOf(target), d = 0;
      p && p !== Object.prototype && p !== Function.prototype && d < 32;
      p = Object.getPrototypeOf(p), d++
    ) {
      for (const key of Object.getOwnPropertyNames(p)) {
        if (key !== 'constructor' && !key.startsWith('__') && Object.getOwnPropertyDescriptor(p, key)?.get)
          names.push(key);
      }
    }
  }, undefined);
  return names;
}

function entryForKey(target: object, key: string, options: ViewOptions): ExplorerEntry {
  const label = truncate(key, 100);
  if (findDescriptor(target, key)?.get && !options.getters) {
    return { step: { kind: 'prop', key }, label, description: 'getter · turn on "getters" to open', getter: true };
  }
  const child = safely(
    () => Reflect.get(target, key),
    (err) => `[threw: ${errorMessage(err)}]`,
  );
  return { step: { kind: 'prop', key }, label, description: describe(child) };
}

/** The children of a value for the explorer's select menu. */
export function listEntries(value: unknown, options: ViewOptions = {}): ExplorerEntry[] {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return [];
  const entries: ExplorerEntry[] = [];

  try {
    if (value instanceof Map) {
      for (const [key, child] of value) {
        if (entries.length >= MAX_ENTRIES) break;
        const label = truncate(typeof key === 'string' ? key : preview(key, 60), 100);
        entries.push({ step: { kind: 'map', index: entries.length, label }, label, description: describe(child) });
      }
      return entries;
    }
    if (value instanceof Set) {
      for (const child of value) {
        if (entries.length >= MAX_ENTRIES) break;
        entries.push({
          step: { kind: 'set', index: entries.length },
          label: `[${entries.length}]`,
          description: describe(child),
        });
      }
      return entries;
    }

    const seen = new Set<string>();
    const keys = options.hidden ? Object.getOwnPropertyNames(value) : Object.keys(value);
    for (const key of [...keys, ...inheritedGetters(value)]) {
      if (entries.length >= MAX_ENTRIES) break;
      if (seen.has(key) || (Array.isArray(value) && key === 'length' && !options.hidden)) continue;
      seen.add(key);
      entries.push(entryForKey(value, key, options));
    }

    if (options.hidden) {
      Object.getOwnPropertySymbols(value).forEach((sym, index) => {
        const label = truncate(sym.toString(), 100);
        const child = safely(
          () => Reflect.get(value, sym),
          (err) => `[${errorMessage(err)}]`,
        );
        entries.push({ step: { kind: 'symbol', index, label }, label, description: describe(child) });
      });
    }
  } catch (err) {
    throw new ByakuError('EXPLORER', `Could not list keys: ${errorMessage(err)}`);
  }

  return entries.slice(0, MAX_ENTRIES);
}

function nth<T>(values: Iterable<T>, index: number): { found: boolean; value?: T } {
  let i = 0;
  for (const value of values) if (i++ === index) return { found: true, value };
  return { found: false };
}

export function resolveStep(value: unknown, step: PathStep, options: ViewOptions = {}): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    throw new ByakuError('EXPLORER', 'This value has no keys.');
  }
  const gone = (what: string) => new ByakuError('EXPLORER', `${what} no longer exists.`);
  try {
    switch (step.kind) {
      case 'prop': {
        const desc = findDescriptor(value, step.key);
        if (!desc) throw gone(`"${step.key}"`);
        if (desc.get && !options.getters)
          throw new ByakuError('EXPLORER', `"${step.key}" is a getter. Turn on getters to open it.`);
        return Reflect.get(value, step.key);
      }
      case 'symbol': {
        const sym = Object.getOwnPropertySymbols(value)[step.index];
        if (!sym) throw gone(step.label);
        return Reflect.get(value, sym);
      }
      case 'map':
      case 'set': {
        const collection =
          step.kind === 'map' ? value instanceof Map && value.values() : value instanceof Set && value.values();
        if (!collection)
          throw new ByakuError('EXPLORER', `This value is no longer a ${step.kind === 'map' ? 'Map' : 'Set'}.`);
        const entry = nth(collection, step.index);
        if (!entry.found) throw gone(step.kind === 'map' ? `Entry ${step.label}` : `Item ${step.index}`);
        return entry.value;
      }
    }
  } catch (err) {
    if (err instanceof ByakuError) throw err;
    throw new ByakuError('EXPLORER', `Could not open it: ${errorMessage(err)}`);
  }
}

export function resolvePath(root: unknown, path: readonly PathStep[], options: ViewOptions = {}): unknown {
  return path.reduce((value, step) => resolveStep(value, step, options), root);
}

function stepLabel(step: PathStep): string {
  switch (step.kind) {
    case 'prop':
      return /^\d+$/.test(step.key) ? `[${step.key}]` : step.key;
    case 'symbol':
      return `[${step.label}]`;
    case 'map':
      return `{${step.label}}`;
    case 'set':
      return `<${step.index}>`;
  }
}

/** `client › cache › guilds`; long paths keep the root and the last steps. */
export function breadcrumb(rootLabel: string, path: readonly PathStep[], max = 80): string {
  const parts = [rootLabel, ...path.map(stepLabel)];
  let text = parts.join(' › ');
  for (let keep = parts.length - 2; text.length > max && keep > 0; keep--) {
    text = [parts[0], '…', ...parts.slice(parts.length - keep)].join(' › ');
  }
  return truncate(text, max);
}

function safely<T>(run: () => T, fallback: T | ((err: unknown) => T)): T {
  try {
    return run();
  } catch (err) {
    return typeof fallback === 'function' ? (fallback as (err: unknown) => T)(err) : fallback;
  }
}
