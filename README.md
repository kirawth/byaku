<div align="center">

# 👁️ Byaku

**An owner-only developer console for [Seyfert](https://seyfert.dev) Discord bots.**<br>
Run code, explore objects and stream a shell from Discord, in plain messages with buttons.

[![npm](https://img.shields.io/npm/v/byaku?color=cb3837&logo=npm)](https://www.npmjs.com/package/byaku)
[![CI](https://github.com/kirawth/byaku/actions/workflows/ci.yml/badge.svg)](https://github.com/kirawth/byaku/actions/workflows/ci.yml)
[![Node](https://img.shields.io/node/v/byaku?color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![Seyfert](https://img.shields.io/badge/seyfert-5.2%2B-5865f2)](https://seyfert.dev)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[Quick start](#quick-start) · [Modes](#modes) · [Buttons](#buttons) · [Options](#options) ·
[Custom modes](#custom-modes) · [Safety](#safety) · [FAQ](#faq)

</div>

> _Byaku_ (白) comes from the Byakugan (白眼) in _Naruto_, the eye that sees through walls and chakra in every
> direction, which is what a console into a running bot should do. It follows the idea of
> [jishaku](https://github.com/scarletcafe/jishaku) and [Dokdo](https://github.com/wonderlandpark/dokdo), written from
> scratch for Seyfert 5. It's a fan reference, not affiliated with the series.

## ✨ Why Byaku

|                           |                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| 🔎 **Object explorer**    | Pick a key from a menu to walk into any result (`client › cache › guilds`), then go back or home. |
| 🧠 **It remembers**       | Your `const`, functions and classes stay between runs, with `_` and `$1…$10` for earlier results. |
| 🖥️ **A real live shell**  | Output streams into the message. ⏹️ Kill stops the command and everything it started.             |
| 🎛️ **Buttons everywhere** | Pages, re-run, edit and run, diff with the last run, send as file, keep, delete.                  |
| 🛡️ **Safe by default**    | Owners only, secrets hidden in every encoding, a confirm step for risky input, an audit log hook. |
| 🧩 **Made for Seyfert**   | `Client` or `WorkerManager`, yunaforseyfert, the plugin system, or file loaders. Your choice.     |

<a id="quick-start"></a>

## 🚀 Quick start

**1. Install**

```bash
npm i byaku
```

**2. Add two lines to your bot**

```ts
import { Byaku } from 'byaku';

await new Byaku(client, { owners: ['YOUR_USER_ID'] }).install();
```

The application owner (or every member of the owning team) is allowed automatically; `owners` adds more accounts.

**3. Type in Discord** (with your bot's prefix, here `?`)

| You type                          | You get                                                       |
| --------------------------------- | ------------------------------------------------------------- |
| `?by`                             | 📊 A summary: versions, memory, shards, cache, event-loop lag |
| `?by 1 + 1`                       | `2`, with buttons to re-run, edit and explore                 |
| `?by client.cache.guilds.count()` | Any JavaScript, with top-level `await`                        |
| `?by sh git status`               | 🖥️ Live shell output with a Kill button                       |
| `?by help`                        | Every mode                                                    |

`?byaku` works too, and so does a mention: `@YourBot by 1 + 1`.

> [!TIP]
> A complete bot (about 20 lines) is in [`examples/basic-bot`](examples/basic-bot).

Requires Node.js 20+ and Seyfert 5.2+. For the `ts` mode, also install `sucrase`.

<a id="modes"></a>

## 📚 Modes

Type `<trigger> <mode> <code or arguments>`. Text without a known mode runs as JavaScript.

#### 🟨 Eval

| Mode                | What it does                                               | Example                               |
| ------------------- | ---------------------------------------------------------- | ------------------------------------- |
| `js` · `eval` · `e` | JavaScript: an expression or statements, `await`, `return` | `?by e await client.guilds.fetch(id)` |
| `ts`                | TypeScript (needs `sucrase`); `--emit` shows the output    | `?by ts const n: number = 2; n * 2`   |
| `jsi`               | Type, class, size, prototype chain and keys of a value     | `?by jsi client.gateway`              |
| `retain` · `reset`  | Keep your variables between runs (on/off), or forget them  | `?by retain off`                      |

Inside eval you have `client`, `ctx`, `message`, `cache`, `rest`, `byaku`, `require`, `_`, `$1…$10` and anything you
pass in `scope`.

#### 🖥️ Shell

| Mode                         | What it does                                           | Example                    |
| ---------------------------- | ------------------------------------------------------ | -------------------------- |
| `sh` · `exec` · `bash` · `$` | Live shell with Kill and input (PowerShell on Windows) | `?by $ npm ls --depth=0`   |
| `git`                        | Shortcut for `sh git …`                                | `?by git log --oneline -5` |

#### 🌐 Bot and workers

| Mode     | What it does                                               | Example                                      |
| -------- | ---------------------------------------------------------- | -------------------------------------------- |
| _(none)_ | Versions, uptime, memory, shards, cache, event-loop lag    | `?by`                                        |
| `shards` | Workers or shards with ping and memory                     | `?by shards`                                 |
| `shard`  | JavaScript on one worker                                   | `?by shard 1 js client.cache.guilds.count()` |
| `all`    | JavaScript on every worker, merged (10 s limit per worker) | `?by all js process.memoryUsage().rss`       |
| `help`   | Every mode, or one in detail                               | `?by help sh`                                |

#### 🚩 Flags

Flags go **before** the code, so flags inside your code are never touched.

| Flag        | Effect                                                                         |
| ----------- | ------------------------------------------------------------------------------ |
| `--depth=N` | Inspect depth 0–6 for the result (you can also change it with the menu)        |
| `--yes`     | Skip the confirm step for risky input                                          |
| `--unsafe`  | Show `client.token` or `process.env` instead of a placeholder (still redacted) |
| `--emit`    | `ts` only: show the compiled JavaScript instead of running it                  |

> [!NOTE]
> Coming next: `cat`, `curl`, `logs`, `cmd`, `cache`, `ping`, `su`, `in`, `sudo`, `debug`, `repeat`, `source`,
> `perms`, `tasks`, `watch`, `top`, `events`, `rest`, `heap`, `prof`, `bench`, `history`, `snippets`, `sql`,
> `redis`.

<a id="buttons"></a>

## 🎛️ Buttons and menus

Every result comes with controls. Only the owner who ran it can use them; anyone else gets a private "no".

| Control             | What it does                                                             |
| ------------------- | ------------------------------------------------------------------------ |
| ⏮️ ◀️ `2 / 9` ▶️ ⏭️ | Turn pages; the counter opens "Go to page"                               |
| 🔁                  | Run the same input again in the same message                             |
| ✏️                  | Edit the code in a form and run it                                       |
| 🔀 Diff             | What changed since the previous run                                      |
| 📄 · 📋             | Send the output as a file · as raw text you can copy                     |
| 📌                  | Keep the session (it won't expire after 15 minutes)                      |
| ⏹️ · 🗑️             | Remove the controls · delete the reply and your message                  |
| 🔎 menu             | Object explorer: open a key; ⬅️ goes back, 🏠 goes to the top            |
| Depth menu          | Depth 0–6, and 👁️ show hidden keys and getters                           |
| ⏹️ Kill · 📝        | Live shell: stop the command and its children · send a line to its input |
| ✅ · ✖️             | Confirm or cancel risky input                                            |

**Edit your message** within 5 minutes and Byaku re-runs it into the same reply. **Delete your message** and the
reply goes with it.

<a id="options"></a>

## ⚙️ Options

```ts
new Byaku(client, {
  owners: ['123456789012345678'],
  prefixes: ['?dev'],
  secrets: [process.env.DATABASE_URL],
  scope: { db, redis },
  audit: (entry) => logger.info(entry),
  modes: [uptime],
  slash: true,
});
```

| Option     | Type                               | Default | What it does                                                                   |
| ---------- | ---------------------------------- | ------- | ------------------------------------------------------------------------------ |
| `owners`   | `string[]`                         | `[]`    | User IDs allowed besides the application owner and team                        |
| `prefixes` | `string[]`                         | `[]`    | Extra triggers; `<bot prefix>byaku`, `<bot prefix>by` and mentions always work |
| `secrets`  | `(string \| undefined)[]`          | `[]`    | Values never shown; the bot token is always hidden                             |
| `scope`    | `Record<string, unknown>`          | `{}`    | Extra variables for eval                                                       |
| `audit`    | `(entry: AuditEntry) => unknown`   | —       | Called for every run, button press and refusal                                 |
| `modes`    | `ByakuMode[]`                      | `[]`    | Your own modes (see below)                                                     |
| `slash`    | `boolean \| { guilds?: string[] }` | `false` | Adds the owner-only `/byaku` command with a code form and file upload          |

<details>
<summary><b>Advanced options</b> (rarely needed)</summary>

<br>

```ts
new Byaku(client, {
  advanced: {
    enabled: process.env.BYAKU !== 'off', // default true
    includeAppOwners: true, // allow the application owner / team members
    prefixGuard: true, // make Seyfert ignore Byaku's triggers (see FAQ)
    timeouts: { session: '15m', shell: '5m', editRerun: '5m' },
    limits: { pageSize: 1850, catBytes: 1_048_576, curlBytes: 2_097_152 },
    shell: { command: 'pwsh', cwd: '/srv/bot', env: { NODE_ENV: 'production' } },
    store: mySessionStore, // keep sessions somewhere other than memory
    adapters: { sql, redis }, // for the sql and redis modes
    transpile: (code) => code, // replace sucrase for the ts mode
    confirm: [{ pattern: /deploy/, reason: 'deploys the bot' }], // more input that asks first
  },
});
```

A wrong or unknown option throws one `ByakuError` (`code: 'INVALID_OPTION'`) that names it, for example
`Unknown option "advanced.enable". Known options here: enabled, includeAppOwners, …`.

</details>

<details>
<summary><b>Other ways to set it up</b>: plugin, file loaders, your own message router</summary>

<br>

**As a Seyfert plugin**, with `client.byaku` typed:

```ts
import { Client, definePlugins } from 'seyfert';
import { byakuPlugin } from 'byaku/plugin';

const plugins = definePlugins(byakuPlugin({ owners: ['123456789012345678'] }));
declare module 'seyfert' {
  interface SeyfertRegistry {
    plugins: typeof plugins;
  }
}
const client = new Client({ plugins });
```

**With Seyfert's file loaders**, export Byaku's classes from your own files:

```ts
// src/components/byaku.ts
import { createByakuClasses } from 'byaku';
import { byaku } from '../byaku';

export default createByakuClasses(byaku).ByakuComponents;
```

**If you route messages yourself**, call `await byaku.handleMessage(message)`; it resolves to `true` when the
message was for Byaku.

</details>

<a id="custom-modes"></a>

## 🧩 Custom modes

```ts
import { defineMode } from 'byaku';

export const uptime = defineMode({
  name: 'uptime',
  aliases: ['up'],
  description: 'How long the bot has been running',
  run: () => `${process.uptime().toFixed(0)} s`,
});

new Byaku(client, { owners, modes: [uptime] }); // then: ?by uptime
```

`run(ctx)` gets the input, flags, client, session, an eval `scope()`, `redact()` and `live()` for streaming output.
Return a string or an object:

| Return             | Shown as                                     |
| ------------------ | -------------------------------------------- |
| `'text'`           | A code block, with pages and all the buttons |
| `{ output, lang }` | A code block in that language                |
| `{ text }`         | A plain message (like the summary)           |
| `{ value }`        | An inspected value with the object explorer  |
| `{ ok: false }`    | ❌ instead of ✅ in the status line          |

<a id="safety"></a>

## 🛡️ Safety

- 👤 **Owners only.** User IDs from `owners`, plus the application owner or team. Server roles and Administrator
  never count. Everyone else gets no reply at all, and a `denied` audit entry.
- 🙈 **Secrets never leave.** The bot token and your `secrets` are hidden in output, files, errors, live streams and
  audit entries, including URL-encoded, base64, hex and JSON-escaped forms, the parts of a Discord token, and a
  secret split across two chunks of shell output. Environment variables named like `TOKEN`, `SECRET` or `PASSWORD`
  are hidden too.
- ⚠️ **Risky input asks first:** `rm -rf`, `process.exit`, `client.close`, `DROP TABLE` and more show ✅ Confirm /
  ✖️ Cancel. `--yes` skips it.
- 📝 **Plain messages.** Every reply is sent with `flags: 0`, no embeds and no mentions, so helpers that turn a
  bot's replies into embeds or Components V2 leave Byaku alone.
- 🧯 **Never crashes the bot.** Errors are caught, redacted and shown in the reply.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

<a id="faq"></a>

## ❓ FAQ

<details>
<summary><b>The bot doesn't reply to <code>?by</code></b></summary>

<br>

- Turn on the **Message Content** intent in the Developer Portal and in your intents; without it the bot can't read
  the message. A mention (`@YourBot by 1 + 1`) and `/byaku` work without it.
- Check that you're an owner: your ID is in `owners`, or you own the application (or are on its team).
- Byaku stays silent for everyone else on purpose. Pass `audit` to see `denied` entries.

</details>

<details>
<summary><b>My bot has its own <code>by</code> command</b></summary>

<br>

The prefix guard (on by default) wraps your prefix function so Seyfert skips messages meant for Byaku and returns
your prefixes untouched for everything else. Your other commands, and yunaforseyfert's resolver, keep working.

</details>

<details>
<summary><b>The buttons don't respond</b></summary>

<br>

Seyfert runs a bot's global middlewares for every component, Byaku's included. If one of them stops the request (a
blacklist, a guild-only check), let custom ids that start with `by1:` through.

</details>

<details>
<summary><b>The <code>ts</code> mode says it needs sucrase</b></summary>

<br>

Install it next to Byaku: `npm i sucrase`. It is loaded only the first time you use `ts`.

</details>

<details>
<summary><b>TypeScript errors inside <code>node_modules/seyfert</code></b></summary>

<br>

Seyfert 5.2's own type declarations have a few errors on TypeScript 5.x. Set `"skipLibCheck": true`; Byaku's types
are fine with TypeScript 5.4 and later.

</details>

<details>
<summary><b>Does it work with <code>WorkerManager</code>?</b></summary>

<br>

Yes. Each worker runs its own Byaku, and a button press arrives on the same worker as the message that created it.
`shards`, `shard <id> js …` and `all js …` reach the other workers. Pass `advanced.store` to keep sessions outside
memory. Replies from `/byaku` are private and can be edited for 15 minutes, the lifetime of a Discord interaction.

</details>

## 🆚 jishaku and Dokdo

|                                     | jishaku | Dokdo |            Byaku             |
| ----------------------------------- | :-----: | :---: | :--------------------------: |
| Eval with an inspector              |   ✅    |  ✅   |              ✅              |
| Variables kept between runs         |   ✅    |  ➖   |         ✅ per owner         |
| Object explorer with a menu         |   ➖    |  ➖   |              ✅              |
| TypeScript eval                     |   ➖    |  ➖   |              ✅              |
| Live shell output                   |   ✅    |  ➖   |              ✅              |
| Kill stops child processes too      |   ➖    |  ➖   |              ✅              |
| Shell input from Discord            |   ➖    |  ➖   |              ✅              |
| Run code on every shard / worker    |   ➖    |  ✅   | ✅ with a timeout per worker |
| Re-run by editing your message      |   ✅    |  ➖   |        ✅ with a diff        |
| Secrets hidden in every encoding    |   ➖    |  ➖   |              ✅              |
| Confirm step for risky input        |   ➖    |  ➖   |              ✅              |
| Audit log hook                      |   ➖    |  ➖   |              ✅              |
| Slash command with a code form      |   ➖    |  ➖   |              ✅              |
| `cat`, `curl`, `debug`, `source`, … |   ✅    | some  |         coming next          |

## 🤝 Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the setup and the project
layout, and please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## 📄 License

[MIT](LICENSE) © Hasibur Rahman ([@kirawth](https://github.com/kirawth) · [h4sib.pro](https://h4sib.pro))
