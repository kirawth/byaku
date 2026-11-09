import type { ByakuModeDefinition } from './index.js';

export const toolModes: ByakuModeDefinition[] = [
  {
    name: 'help',
    aliases: ['h'],
    description: 'Every mode, or details for one',
    usage: 'help [mode]',
    rerunnable: false,
    run(ctx) {
      const name = ctx.input.trim().split(/\s+/)[0];
      if (!name) {
        const lines = ctx.byaku.registry
          .list()
          .filter((m) => m.name !== 'summary')
          .map((m) => `\`${m.name}\`${m.aliases.length ? ` (${m.aliases.join(', ')})` : ''} — ${m.description}`);
        return {
          text: [
            '**Byaku modes**',
            ...lines,
            '',
            '-# Flags go before the code: `--depth=2` `--yes` `--unsafe`. `help <mode>` for details.',
          ].join('\n'),
        };
      }

      const mode = ctx.byaku.registry.get(name);
      if (!mode) return { text: `No mode called \`${name}\`. Try \`help\`.`, ok: false };
      const lines = [`**${mode.name}** — ${mode.description}`];
      if (mode.aliases.length) lines.push(`Aliases: ${mode.aliases.map((a) => `\`${a}\``).join(', ')}`);
      lines.push(`Usage: \`${mode.usage}\``);
      if (mode.examples.length) lines.push('Examples:', ...mode.examples.map((e) => `- \`${e}\``));
      return { text: lines.join('\n') };
    },
  },
];
