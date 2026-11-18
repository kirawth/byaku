---
'byaku': minor
---

Add the `reload` mode. On Seyfert's WorkerManager with hot reload support it replaces workers one at a time, so all bot code loads again without the bot going offline; a worker that fails to start keeps the old code. It checks the setup first: with a Seyfert version that has no hot reload it shows the installed version and the update command for the bot's package manager, on a single Client it explains that the WorkerManager is needed, and it stops with a clear message when the manager process doesn't answer. `reload files` reloads Seyfert's command, component, event and lang files on any setup.
