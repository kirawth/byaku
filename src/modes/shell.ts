import { formatDuration, StreamRedactor } from '../output.js';
import { exitNote, runShell, shellFor } from '../runners.js';
import type { ByakuModeDefinition, ModeContext, ModeOutput } from './index.js';

async function runLiveShell(ctx: ModeContext, command: string): Promise<ModeOutput> {
  const { byaku } = ctx;
  // Registers the bot token with the redactor before any output streams
  byaku.redact('');
  const stream = new StreamRedactor(byaku.redactor);
  const header = `$ ${command}\n`;
  const { shell, shellTimeoutMs } = byaku.options;
  const live = await ctx.live({
    kind: 'shell',
    lang: 'ansi',
    render: () => header + stream.text(true),
    onInput: (text) => void handle.write(text),
  });

  const handle = runShell(
    command,
    (chunk) => {
      stream.push(chunk);
      live.update();
    },
    {
      shell: shellFor(shell.command),
      ...(shell.cwd ? { cwd: shell.cwd } : {}),
      ...(shell.env ? { env: shell.env } : {}),
      timeoutMs: shellTimeoutMs,
      signal: live.signal,
    },
  );
  const exit = await handle.done;
  if (exit.timedOut) ctx.session.data.timedOut = true;
  else if (exit.killed) ctx.session.data.killed = true;

  const body = stream.text();
  return {
    output: `${header}${body}${body && !body.endsWith('\n') ? '\n' : ''}${exitNote(exit, formatDuration(shellTimeoutMs))}`,
    lang: 'ansi',
    ok: exit.code === 0 && !exit.killed && !exit.error,
    ms: exit.ms,
  };
}

export const shellModes: ByakuModeDefinition[] = [
  {
    name: 'sh',
    aliases: ['exec', 'bash', 'shell', '$'],
    description: 'Run a shell command with live output, Kill and input (PowerShell on Windows)',
    usage: 'sh <command>',
    examples: ['$ npm ls --depth=0', 'sh git status'],
    run: (ctx) => runLiveShell(ctx, ctx.input),
  },
  {
    name: 'git',
    description: 'Shortcut for `sh git <args>`',
    usage: 'git <args>',
    examples: ['git log --oneline -5'],
    run: (ctx) => runLiveShell(ctx, `git ${ctx.input}`.trim()),
  },
];
