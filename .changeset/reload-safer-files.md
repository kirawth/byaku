---
'byaku': minor
---

Improve `reload`:

- Inside a container, the hot reload result notes that it loads the code already in the image, and the setup hints ask to rebuild the image and recreate the container instead of restarting the bot.
- `reload files` lists every file it could not load again, with the error, and keeps those files' previous version. On Seyferts older than 5.2.2-dev-44386046816.0, whose reload ignores a custom `onFile`, it skips such handlers unless `--force` is given and reports files the reload dropped. The per-file report needs Seyfert 5.2.2-dev-44386046816.0 or newer.
- Modes can return `details`, which Byaku copies into the run's audit entry. `reload` uses it to record what it did (`kind`, workers or files reloaded, failed and skipped).
- With a shared session store, the worker that replaces the one running `reload` finishes the reload message if the old worker could not.
