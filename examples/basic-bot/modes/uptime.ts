import { defineMode } from 'byaku';

// `?by uptime`: how long the bot process has been running
export const uptime = defineMode({
  name: 'uptime',
  aliases: ['up'],
  description: 'How long the bot has been running',
  run() {
    const seconds = Math.floor(process.uptime());
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${seconds % 60}s`;
  },
});
