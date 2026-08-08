# @genie-os/cli — `genie`

The `genie` CLI for [GenieOS](https://genieos.pro). Log in, manage
keys and webhook subscriptions, send transactional emails, emit events,
and tail the audit log — straight from your terminal.

## Install

```bash
npm install -g @genie-os/cli
# or run ad-hoc
npx -y @genie-os/cli help
```

## Authenticate

```bash
genie login
# Open https://app.genieos.pro/settings/api-keys, create a key, paste it.
```

The token is written to `~/.genieos/credentials.json` with `0600`
permissions and is shared with the `@genie-os/mcp` stdio bridge.

`GENIEOS_API_KEY` env var always wins, so CI runs don't need to write
to disk. Keys look like `gos_live_…` (production) or `gos_test_…`
(sandbox).

## Common workflows

```bash
genie whoami
genie keys list
genie templates list
genie templates send welcome --to=aki@example.com --vars='{"firstName":"Aki"}'
genie events emit subscription.cancelled --email=aki@example.com --traits='{"reason":"price"}'
genie webhooks create --url=https://example.com/genieos/webhook --events=send.delivered,send.bounced
genie logs tail
```

`genie logs tail` polls `/v1/audit` every 5 s (configurable with
`--interval`) and prints new entries as they appear — handy when
verifying that an integration is wiring up to the right hooks.

## Connecting to a non-default API host

```bash
genie login --api-url=https://api.staging.genieos.pro
# or per-call
genie whoami --api-url=https://api.staging.genieos.pro
```

## License

MIT
