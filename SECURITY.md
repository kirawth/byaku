# Security

Byaku runs code on your bot's machine **by design**: JavaScript in the bot process and commands in a shell. Treat
access to it like SSH access to the server.

## How access is limited

- Only the user IDs in `owners`, plus the application owner or the members of the team that owns the application,
  can use Byaku. Server roles and permissions (including Administrator) never grant access.
- Everyone else gets no reply at all; their attempts are reported to the `audit` callback.
- Buttons and forms check the owner again on every press.
- The bot token, the values in `secrets`, and environment variables named like `TOKEN`, `SECRET` or `PASSWORD`
  are hidden from all output, in every common encoding.
- Byaku can be turned off with `advanced: { enabled: false }`, for example in production.

## Reporting a vulnerability

Please report security problems privately through
[GitHub's private vulnerability reporting](https://github.com/kirawth/byaku/security/advisories/new), not in a
public issue. Include the Byaku and Seyfert versions and the steps to reproduce.

You'll get a reply within a week. Once a fix is released, the advisory is published with credit to you unless you
prefer otherwise.

## Supported versions

Security fixes go into the latest release.
