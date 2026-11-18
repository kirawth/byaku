# byaku

## 2.2.0

### Minor Changes

- 85e1687: Improve `reload`:

  - Inside a container, the hot reload result notes that it loads the code already in the image, and the setup hints ask to rebuild the image and recreate the container instead of restarting the bot.
  - `reload files` lists every file it could not load again, with the error, and keeps those files' previous version. On Seyferts older than 5.2.2-dev-44386046816.0, whose reload ignores a custom `onFile`, it skips such handlers unless `--force` is given and reports files the reload dropped. The per-file report needs Seyfert 5.2.2-dev-44386046816.0 or newer.
  - Modes can return `details`, which Byaku copies into the run's audit entry. `reload` uses it to record what it did (`kind`, workers or files reloaded, failed and skipped).
  - With a shared session store, the worker that replaces the one running `reload` finishes the reload message if the old worker could not.

## 2.1.0

### Minor Changes

- fbded8b: Add the `reload` mode. On Seyfert's WorkerManager with hot reload support it replaces workers one at a time, so all bot code loads again without the bot going offline; a worker that fails to start keeps the old code. It checks the setup first: with a Seyfert version that has no hot reload it shows the installed version and the update command for the bot's package manager, on a single Client it explains that the WorkerManager is needed, and it stops with a clear message when the manager process doesn't answer. `reload files` reloads Seyfert's command, component, event and lang files on any setup.

## 2.0.0

### Major Changes

- 61d9f75: Leave the bot's prefix function and command handler untouched. Add shouldSkipMessageCommand(raw) for explicit native routing before argument parsing. Bots with colliding commands or a loaded ByakuCommand must add this hook to retain automatic trigger isolation; advanced.prefixGuard continues to control that decision.

### Patch Changes

- f61e6c5: Use Seyfert's public plugin contributions and collector stop callbacks to manage Byaku's handlers. Uninstalling one instance no longer removes another instance's controls; manual handlers are deactivated and reused on reinstall.
- 374b370: Acknowledge code modal submissions before downloading uploads or evaluating code, preserving the selected reply visibility and updating the deferred reply for results and live output.
- a14568d: Correct file-loader setup examples to export ByakuButtons, ByakuSelects and ByakuModal from separate files, with an optional ByakuCommand file. Keep the ByakuComponents and ByakuModals constructor arrays for direct registration.
- 84954c4: Keep the plugin's `/byaku` slash command registered when the bot loads its own commands from files during startup.
- 7cec7ea: Redact secrets in explorer menus, breadcrumbs, confirmation prompts, status text, autocomplete, and modal displays as well as message output. Keep raw inputs and navigation keys for execution; editing secret-bearing input requires new code, while Re-run retains the original.

## 1.0.0

### Major Changes

- Initial release.
  - Message triggers (`<bot prefix>byaku`, `<bot prefix>by`, mentions, custom prefixes) read from the raw message
    text, a prefix guard so the bot's own commands don't also run, and an owner-only `/byaku` command with a code
    modal and file upload.
  - Modes: summary, `js`/`ts`/`jsi` eval with per-owner variables, `_` and `$1…$10`, `retain`, `reset`, live
    `sh`/`git`, `shards`, `shard` and `all` across workers, and `help`. Custom modes with `defineMode`.
  - Result controls: pages, re-run, edit and run, diff against the last run, send as file, raw text, keep, remove
    and delete; edit-to-re-run and delete-with-trigger.
  - Object explorer for eval results, with a depth menu and hidden keys / getters.
  - Live shell with Kill (the whole process tree), input, and a timeout; PowerShell on Windows.
  - Safety: owners only (plus the application owner or team), redaction of secrets in every encoding, a confirm
    step for risky input, and an audit callback.
  - `byakuPlugin()` for Seyfert's plugin system and `createByakuClasses()` for file loaders.
