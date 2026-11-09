// @ts-check
import { config } from 'seyfert';

export default config.bot({
  token: process.env.DISCORD_TOKEN ?? '',
  // MessageContent lets the bot read `?by …` messages (turn it on in the Developer Portal too)
  intents: ['Guilds', 'GuildMessages', 'MessageContent', 'DirectMessages'],
  locations: { base: '.' },
});
