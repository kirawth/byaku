# byaku

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
