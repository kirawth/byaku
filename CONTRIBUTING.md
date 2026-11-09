# Contributing to Byaku

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Setup

```bash
git clone https://github.com/kirawth/byaku.git
cd byaku
npm install
npm run check
```

You need Node.js 20 or later. The repository's `.npmrc` sets `legacy-peer-deps`, because a fresh `npm install` with
npm 10 crashes while resolving one of the test runner's optional peers; it only affects development.

## Scripts

| Script                  | What it does                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `npm run build`         | Builds ESM, CJS and type declarations into `dist/` with tsup                                     |
| `npm run dev`           | Rebuilds on change                                                                               |
| `npm run lint`          | ESLint (including import cycles), Prettier and knip (unused files and exports)                   |
| `npm run format`        | Formats everything with Prettier                                                                 |
| `npm run typecheck`     | Type-checks the source, tests, the consumer fixture and the example                              |
| `npm test`              | Runs the tests                                                                                   |
| `npm run test:coverage` | Tests with coverage; the core modules must stay above 90% of lines                               |
| `npm run test:package`  | Packs the package, installs it in a fresh project and type-checks it with TypeScript 5.4 and 5.9 |
| `npm run check`         | All of the above, as CI runs it                                                                  |

## Project layout

```
src/
  index.ts        public exports
  byaku.ts        the Byaku class: install, triggers, owners, prefix guard, running modes, sending replies
  options.ts      options, validation, defaults, ByakuError, durations
  parse.ts        triggers, flags, code fences, the tokenizer, confirm rules
  output.ts       code blocks, escaping, pagination, diff, redaction
  session.ts      sessions, the session store, expiry, the throttled message editor
  inspect.ts      util.inspect wrapper and the object explorer
  runners.ts      JavaScript/TypeScript eval, the live shell, following a file
  view.ts         custom ids, turning a session into a message, buttons, selects, modals
  handlers.ts     button, select, modal and slash handling and their Seyfert classes
  workers.ts      the bridge for running code on other workers
  plugin.ts       byakuPlugin() and createByakuClasses()
  modes/          mode types and registry (index.ts) and the built-in modes by topic
test/             one test file per module, plus integration and worker tests; fakes in helpers.ts
test/fixtures/    a consumer project type-checked against the packed package
examples/         a small bot that uses Byaku
scripts/          the package check
```

### How a run works

A `raw` gateway collector sees every new, edited and deleted message. Seyfert doesn't wait for collectors, so a long
run never blocks the bot. When a message starts with a trigger and comes from an owner, `Byaku.run()` parses it
(mode, flags, code), asks for confirmation if the input looks risky, runs the mode and sends or edits the reply.

Each run is a **session**: plain JSON data (input, output, pages, view settings) kept in a `SessionStore`, plus
what can't be stored (the JavaScript value for the explorer, the abort controller) kept in memory next to it.
Sessions expire after 15 minutes without use; a sweep removes their buttons.

### The worker bridge

Seyfert's `tellWorker` sends a function's source text to another worker and runs it there. Byaku sends a tiny
function that calls a handler each worker registers at `globalThis[Symbol.for('byaku.bridge')]`, so no closures
cross the boundary. Each worker is asked separately with its own 10-second timeout, so one dead worker can't hold
up `all js`.

### Known limits

- Seyfert runs a bot's global middlewares for Byaku's buttons too.
- Sessions are kept per worker in memory unless a store is passed.
- The tests use a real Seyfert `Client` with stubbed REST and a fake gateway (`test/helpers.ts`); nothing touches
  Discord.

## Adding a mode

1. Add a definition to the right file in `src/modes/` (`eval.ts`, `system.ts`, `shell.ts`, `tools.ts`):

   ```ts
   {
     name: 'uptime',
     description: 'Process uptime',
     usage: 'uptime',
     run: () => `${process.uptime().toFixed(0)} s`,
   }
   ```

2. Return a string (shown in a code block), `{ text }` for a plain message, or `{ value }` to get the object
   explorer. Use `ctx.live()` for output that streams.
3. Add a test that runs the mode through a trigger (see `test/modes.test.ts`) and a row to the README's mode table.

## Commits and changesets

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org): `feat: …`, `fix: …`,
  `docs: …`, `test: …`, `ci: …`, `chore: …`.
- If your change affects users, run `npx changeset` and describe it in one or two sentences. The release workflow
  turns changesets into a version bump, a CHANGELOG entry and an npm release.
- Keep pull requests focused, and make sure `npm run check` passes.
