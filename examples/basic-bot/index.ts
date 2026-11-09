import { Byaku } from 'byaku';
import { Client } from 'seyfert';

import { uptime } from './modes/uptime.js';

// A normal Seyfert client; `?` is the prefix for message commands
const client = new Client({ commands: { prefix: () => ['?'] } });

// Byaku answers `?byaku …`, `?by …` and mentions, for the bot's owner only.
// The application owner is allowed automatically; OWNER_ID adds another account.
const byaku = new Byaku(client, {
  owners: process.env.OWNER_ID ? [process.env.OWNER_ID] : [],
  modes: [uptime],
});
await byaku.install();

// Connect to Discord with the token from seyfert.config.js
await client.start();
