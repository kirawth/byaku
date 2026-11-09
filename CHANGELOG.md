# byaku

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
