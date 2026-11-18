---
'byaku': minor
---

Add the `reload` mode. On Seyfert's WorkerManager with hot reload support it replaces workers one at a time, so all bot code loads again without the bot going offline; a worker that fails to start keeps the old code. `reload files` and bots without the WorkerManager reload Seyfert's command, component, event and lang files.
