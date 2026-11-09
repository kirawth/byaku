# Byaku example bot

A small Seyfert bot with Byaku: the one-line setup and one custom mode (`uptime`).

## Run it

1. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` (and `OWNER_ID` if you aren't the application owner).
   In the Developer Portal, turn on the **Message Content** intent.
2. `npm install`
3. `npm start`

## Try it in Discord

| Type             | You get                                       |
| ---------------- | --------------------------------------------- |
| `?by`            | A summary: versions, memory, shards, cache    |
| `?by js 1 + 1`   | `2`, with buttons to re-run, edit and explore |
| `?by sh echo hi` | Live shell output with a Kill button          |
| `?by uptime`     | The custom mode from `modes/uptime.ts`        |

Only the bot's owner gets a reply; everyone else is ignored.
