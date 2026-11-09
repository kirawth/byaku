---
'byaku': major
---

Leave the bot's prefix function and command handler untouched. Add shouldSkipMessageCommand(raw) for explicit native routing before argument parsing. Bots with colliding commands or a loaded ByakuCommand must add this hook to retain automatic trigger isolation; advanced.prefixGuard continues to control that decision.
