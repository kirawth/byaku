import { describeValue, formatError } from '../inspect.js';
import { boolFlag } from '../parse.js';
import { transpileTs } from '../runners.js';
import type { ByakuModeDefinition, ModeContext, ModeOutput } from './index.js';

async function runJs(ctx: ModeContext, code: string): Promise<ModeOutput> {
  const result = await ctx.byaku.js.run(code, ctx.author.id, ctx.scope());
  return result.ok
    ? { value: result.value, hasValue: true, ms: result.ms, lang: 'js' }
    : { output: formatError(result.error), ok: false, ms: result.ms, lang: 'js' };
}

export const jsModes: ByakuModeDefinition[] = [
  {
    name: 'js',
    aliases: ['eval', 'e', 'javascript'],
    description: 'Run JavaScript (expression or statements, top-level await, `_` = last result)',
    usage: 'js [--depth=N] <code>',
    examples: ['js client.cache.guilds.count()', 'e const g = await client.guilds.fetch(id); return g.name'],
    run: (ctx) => runJs(ctx, ctx.input),
  },
  {
    name: 'ts',
    aliases: ['typescript'],
    description: 'Run TypeScript (types are stripped with sucrase)',
    usage: 'ts [--emit] <code>',
    examples: ['ts const n: number = 2; return n * 2'],
    async run(ctx) {
      let js: string;
      try {
        js = await transpileTs(ctx.input, ctx.byaku.options.transpile);
      } catch (err) {
        return { output: formatError(err), ok: false, lang: 'ts' };
      }
      return boolFlag(ctx.flags, 'emit') ? { output: js, lang: 'js' } : runJs(ctx, js);
    },
  },
  {
    name: 'jsi',
    description: 'Run JavaScript and describe the result: type, class, size, prototype chain, keys',
    usage: 'jsi <code>',
    examples: ['jsi client.gateway'],
    async run(ctx) {
      const result = await ctx.byaku.js.run(ctx.input, ctx.author.id, ctx.scope());
      return result.ok
        ? { output: describeValue(result.value), ms: result.ms, lang: 'yaml' }
        : { output: formatError(result.error), ok: false, ms: result.ms, lang: 'js' };
    },
  },
  {
    name: 'retain',
    description: 'Keep your eval variables between runs (on/off)',
    usage: 'retain [on|off]',
    rerunnable: false,
    run(ctx) {
      const arg = ctx.input.trim().toLowerCase();
      const on =
        arg === '' ? undefined : /^(on|true|yes|1)$/.test(arg) ? true : /^(off|false|no|0)$/.test(arg) ? false : null;
      if (on === null) return { text: 'Use `retain on` or `retain off`.', ok: false };
      const now = ctx.byaku.js.retain(ctx.author.id, on);
      return { text: `Variable retention is **${now ? 'on' : 'off'}**.${now ? '' : ' Each run starts fresh.'}` };
    },
  },
  {
    name: 'reset',
    description: 'Forget your eval variables, `_` and result history',
    usage: 'reset',
    rerunnable: false,
    run(ctx) {
      const count = ctx.byaku.js.variables(ctx.author.id).length;
      ctx.byaku.js.reset(ctx.author.id);
      return { text: `Cleared ${count} variable(s), \`_\` and the result history.` };
    },
  },
];
