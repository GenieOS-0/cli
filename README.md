# mailgenius-cli — `genius`

The `genius` CLI for [MailGenius](https://mailgenius.pro). Log in, manage
keys and webhook subscriptions, send transactional emails, emit events,
and tail the audit log — straight from your terminal.

## Install

```bash
npm install -g mailgenius-cli
# or run ad-hoc
npx -y mailgenius-cli help
```

## Authenticate

```bash
genius login
# Open https://app.mailgenius.pro/settings/api-keys, create a key, paste it.
```

The token is written to `~/.mailgenius/credentials.json` with `0600`
permissions and is shared with the `mailgenius-mcp` stdio bridge.

`MAILGENIUS_API_KEY` env var always wins, so CI runs don't need to write
to disk.

## Common workflows

```bash
genius whoami
genius keys list
genius templates list
genius templates send welcome --to=aki@example.com --vars='{"firstName":"Aki"}'
genius events emit subscription.cancelled --email=aki@example.com --traits='{"reason":"price"}'
genius webhooks create --url=https://example.com/mg --events=send.delivered,send.bounced
genius logs tail
```

`genius logs tail` polls `/v1/audit` every 5 s (configurable with
`--interval`) and prints new entries as they appear — handy when
verifying that an integration is wiring up to the right hooks.

## Connecting to a non-default API host

```bash
genius login --api-url=https://api.staging.mailgenius.pro
# or per-call
genius whoami --api-url=https://api.staging.mailgenius.pro
```

## License

MIT
