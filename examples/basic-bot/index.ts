import { Byaku } from 'byaku';
import { Client } from 'seyfert';
import { HandleCommand } from 'seyfert/lib/commands/handle.js';

import { uptime } from './modes/uptime.js';

// A normal Seyfert client; `?` is the prefix for message commands
const client = new Client({ commands: { prefix: () => ['?'] } });

// Byaku answers `?byaku …`, `?by …` and mentions, for the bot's owner only.
// The application owner is allowed automatically; OWNER_ID adds another account.
const byaku = new Byaku(client, {
  owners: process.env.OWNER_ID ? [process.env.OWNER_ID] : [],
  modes: [uptime],
});
// Configure routing explicitly; existing custom handlers should add this conditional inside their own message().
class BotCommands extends HandleCommand {
  override async message(raw: Parameters<HandleCommand['message']>[0], shardId: number) {
    if (await byaku.shouldSkipMessageCommand(raw)) return;
    return super.message(raw, shardId);
  }
}
client.setServices({ handleCommand: BotCommands });

// Connect to Discord with the token from seyfert.config.js
await client.start();
await byaku.install();
