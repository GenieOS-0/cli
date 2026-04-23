/**
 * `genius` CLI.
 *
 * Surface:
 *
 *   genius login                       interactive — paste an API key
 *   genius logout
 *   genius whoami                      print workspace + plan
 *   genius keys list|get
 *   genius webhooks list|create|delete
 *   genius templates list|get|render|send
 *   genius events emit
 *   genius logs tail                   poll /v1/audit until ^C
 *
 * Credentials live at ``~/.mailgenius/credentials.json`` and are
 * shared with ``mailgenius-mcp``. The MAILGENIUS_API_KEY env var
 * always wins.
 *
 * Dependency-light by design — no commander / yargs. Routing is a
 * hand-rolled dispatcher because the surface is small.
 */
import { MailGenius, MailGeniusError } from '@mailgenius/sdk';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import process from 'node:process';

const VERSION = '0.1.0';

// --------------------------------------------------------------------------- //
// Credential storage
// --------------------------------------------------------------------------- //

interface Credentials {
  apiKey?: string;
  apiUrl?: string;
  mcpUrl?: string;
}

function credentialsPath(): string {
  return join(homedir(), '.mailgenius', 'credentials.json');
}

function loadCredentials(): Credentials {
  try {
    return JSON.parse(readFileSync(credentialsPath(), 'utf-8')) as Credentials;
  } catch {
    return {};
  }
}

function saveCredentials(c: Credentials): void {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
}

function resolveApiKey(): string {
  const env = process.env.MAILGENIUS_API_KEY?.trim();
  if (env) return env;
  const file = loadCredentials();
  return file.apiKey?.trim() ?? '';
}

function resolveApiUrl(): string {
  return (
    process.env.MAILGENIUS_API_URL?.trim() ||
    loadCredentials().apiUrl?.trim() ||
    'https://api.mailgenius.pro'
  );
}

function makeClient(): MailGenius {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    fail(
      'Not logged in.\n' +
        '  Run `genius login`, or set MAILGENIUS_API_KEY in your shell.',
    );
  }
  return new MailGenius({ apiKey, baseUrl: resolveApiUrl() });
}

// --------------------------------------------------------------------------- //
// Tiny output helpers
// --------------------------------------------------------------------------- //

const isTTY = process.stdout.isTTY;
const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
} as const;
function paint(text: string, color: keyof typeof COLORS): string {
  if (!isTTY) return text;
  return `${COLORS[color]}${text}${COLORS.reset}`;
}
function fail(msg: string, code = 1): never {
  process.stderr.write(paint('error: ', 'red') + msg + '\n');
  process.exit(code);
}
function ok(msg: string): void {
  process.stdout.write(paint('✓ ', 'green') + msg + '\n');
}
function info(msg: string): void {
  process.stdout.write(msg + '\n');
}
function dim(msg: string): string {
  return paint(msg, 'dim');
}

function asJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

interface TableColumn<T> {
  header: string;
  get: (row: T) => string;
}

function table<T>(rows: T[], cols: TableColumn<T>[]): string {
  if (rows.length === 0) return dim('  (no rows)');
  const widths = cols.map((c, i) =>
    Math.max(c.header.length, ...rows.map((r) => cols[i].get(r).length)),
  );
  const header = cols.map((c, i) => c.header.padEnd(widths[i])).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const body = rows
    .map((r) => cols.map((c, i) => c.get(r).padEnd(widths[i])).join('  '))
    .join('\n');
  return [paint(header, 'bold'), dim(sep), body].join('\n');
}

// --------------------------------------------------------------------------- //
// Argv parsing
// --------------------------------------------------------------------------- //

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parse(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const name = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
    } else if (a.startsWith('-') && a.length > 1) {
      const name = a.slice(1);
      flags[name] = true;
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function flag(args: ParsedArgs, name: string, alias?: string): string | undefined {
  const v = args.flags[name] ?? (alias ? args.flags[alias] : undefined);
  if (typeof v === 'string') return v;
  if (v === true) return '';
  return undefined;
}
function bool(args: ParsedArgs, name: string, alias?: string): boolean {
  return Boolean(args.flags[name] ?? (alias ? args.flags[alias] : undefined));
}

function requireFlag(args: ParsedArgs, name: string): string {
  const v = flag(args, name);
  if (v === undefined || v === '') fail(`Missing required flag --${name}`);
  return v;
}

// --------------------------------------------------------------------------- //
// Commands
// --------------------------------------------------------------------------- //

async function cmdLogin(args: ParsedArgs): Promise<void> {
  let apiKey = flag(args, 'api-key');
  if (!apiKey) {
    if (!process.stdin.isTTY) {
      fail('No API key supplied and stdin is not a TTY. Use --api-key=<token>.');
    }
    info('Open https://app.mailgenius.pro/settings/api-keys, create a key, and paste it here.');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    apiKey = (await rl.question(paint('API key: ', 'cyan'))).trim();
    rl.close();
    if (!apiKey) fail('No API key entered.');
  }
  const apiUrl = flag(args, 'api-url');
  // Verify the key works before persisting.
  const probe = new MailGenius({
    apiKey,
    baseUrl: apiUrl ?? 'https://api.mailgenius.pro',
  });
  try {
    const ws = await probe.workspace.get();
    saveCredentials({ apiKey, apiUrl });
    ok(`Logged in to ${paint(ws.name, 'bold')} (workspace ${ws.id}, plan: ${ws.plan}).`);
    info(dim(`Credentials written to ${credentialsPath()}.`));
  } catch (e) {
    fail(formatError(e));
  }
}

function cmdLogout(): void {
  try {
    saveCredentials({});
    ok('Logged out. Credentials cleared.');
  } catch (e) {
    fail(formatError(e));
  }
}

async function cmdWhoami(): Promise<void> {
  const mg = makeClient();
  const ws = await mg.workspace.get();
  info(`${paint(ws.name, 'bold')} (${ws.id})`);
  info(`  plan:       ${ws.plan}`);
  info(`  scopes:     ${ws.scopes.join(', ') || dim('(none)')}`);
  info(`  rate limit: ${ws.rateLimitPerMinute}/min`);
}

async function cmdKeys(args: ParsedArgs): Promise<void> {
  const sub = args.positionals.shift();
  const mg = makeClient();
  if (sub === 'list' || sub === undefined) {
    const keys = await mg.keys.list();
    info(
      table(keys, [
        { header: 'ID', get: (k) => k.id },
        { header: 'NAME', get: (k) => k.name },
        { header: 'PREFIX', get: (k) => k.prefix },
        { header: 'SCOPES', get: (k) => k.scopes.join(',') },
        { header: 'LAST USED', get: (k) => formatDate(k.lastUsedAt) },
      ]),
    );
    return;
  }
  if (sub === 'get') {
    const id = args.positionals.shift();
    if (!id) fail('genius keys get <id>');
    info(asJson(await mg.keys.get(id)));
    return;
  }
  fail(`Unknown subcommand: keys ${sub}\n  Available: list, get`);
}

async function cmdWebhooks(args: ParsedArgs): Promise<void> {
  const sub = args.positionals.shift();
  const mg = makeClient();
  if (sub === 'list' || sub === undefined) {
    const items = await mg.webhooks.list();
    info(
      table(items, [
        { header: 'ID', get: (w) => w.id },
        { header: 'URL', get: (w) => w.url },
        { header: 'EVENTS', get: (w) => (w.events.length ? w.events.join(',') : '*') },
        {
          header: 'STATUS',
          get: (w) =>
            w.disabledAt
              ? paint('disabled', 'yellow')
              : w.lastDeliveryStatus === 'failure'
                ? paint('failing', 'red')
                : paint('healthy', 'green'),
        },
      ]),
    );
    return;
  }
  if (sub === 'create') {
    const url = requireFlag(args, 'url');
    const events = flag(args, 'events');
    const description = flag(args, 'description');
    const created = await mg.webhooks.create({
      url,
      events: events ? events.split(',').map((s) => s.trim() as never) : undefined,
      description,
    });
    ok(`Created webhook ${created.webhook.id}`);
    info(
      paint(
        '\n  Save this secret now — it will be masked on subsequent reads:',
        'yellow',
      ),
    );
    info(`  ${created.webhook.secret}\n`);
    return;
  }
  if (sub === 'delete') {
    const id = args.positionals.shift();
    if (!id) fail('genius webhooks delete <id>');
    await mg.webhooks.delete(id);
    ok(`Deleted webhook ${id}`);
    return;
  }
  fail(`Unknown subcommand: webhooks ${sub}\n  Available: list, create, delete`);
}

async function cmdTemplates(args: ParsedArgs): Promise<void> {
  const sub = args.positionals.shift();
  const mg = makeClient();
  if (sub === 'list' || sub === undefined) {
    const items = await mg.templates.list();
    info(
      table(items, [
        { header: 'KEY', get: (t) => t.key },
        { header: 'NAME', get: (t) => t.name },
        { header: 'SUBJECT', get: (t) => (t.subject ?? '').slice(0, 50) },
        { header: 'V', get: (t) => String(t.version) },
        { header: 'UPDATED', get: (t) => formatDate(t.updatedAt) },
      ]),
    );
    return;
  }
  if (sub === 'get') {
    const key = args.positionals.shift();
    if (!key) fail('genius templates get <key>');
    info(asJson(await mg.templates.get(key)));
    return;
  }
  if (sub === 'render') {
    const key = args.positionals.shift();
    if (!key) fail('genius templates render <key> [--vars=<json>]');
    const vars = parseJsonFlag(args, 'vars');
    const out = await mg.templates.render(key, { variables: vars });
    info(paint('Subject:', 'bold') + ' ' + out.subject);
    if (out.warnings?.length) {
      info(paint('\nWarnings:', 'yellow'));
      for (const w of out.warnings) info('  - ' + w);
    }
    info(paint('\nHTML:', 'bold'));
    info(out.html);
    return;
  }
  if (sub === 'send') {
    const key = args.positionals.shift();
    if (!key) fail('genius templates send <key> --to=<email> [--vars=<json>]');
    const to = requireFlag(args, 'to');
    const vars = parseJsonFlag(args, 'vars');
    const out = await mg.templates.send(key, { to, variables: vars });
    ok(`Queued send ${out.id}`);
    return;
  }
  fail(`Unknown subcommand: templates ${sub}\n  Available: list, get, render, send`);
}

async function cmdEvents(args: ParsedArgs): Promise<void> {
  const sub = args.positionals.shift();
  const mg = makeClient();
  if (sub === 'emit') {
    const name = args.positionals.shift() ?? requireFlag(args, 'name');
    const userId = flag(args, 'user-id');
    const email = flag(args, 'email');
    const traits = parseJsonFlag(args, 'traits');
    const out = await mg.events.emit({ name, userId, email, traits });
    ok(`Recorded event ${out.eventId}`);
    if (out.enrollments?.length) {
      info(`  Enrolled into ${out.enrollments.length} sequence(s):`);
      for (const e of out.enrollments) info(`  - ${e.sequenceKey} (${e.runId})`);
    }
    return;
  }
  fail(`Unknown subcommand: events ${sub}\n  Available: emit`);
}

async function cmdLogs(args: ParsedArgs): Promise<void> {
  const sub = args.positionals.shift();
  if (sub !== 'tail' && sub !== undefined) {
    fail(`Unknown subcommand: logs ${sub}\n  Available: tail`);
  }
  const mg = makeClient();
  const intervalMs = Number(flag(args, 'interval') ?? '5000');
  const limit = Number(flag(args, 'limit') ?? '50');

  let seen = new Set<string>();
  // Prime from the most recent page so we don't dump history.
  try {
    const initial = await mg.audit.list({ limit });
    seen = new Set(initial.map((e) => e.id));
    info(dim(`Tailing audit log (every ${intervalMs}ms, ^C to stop) — primed with ${seen.size} entries.`));
  } catch (e) {
    fail(formatError(e));
  }

  const stop = { v: false };
  process.on('SIGINT', () => {
    stop.v = true;
    process.stdout.write('\n');
    info(dim('Stopped.'));
    process.exit(0);
  });

  while (!stop.v) {
    try {
      const page = await mg.audit.list({ limit });
      // page is reverse-chronological; iterate oldest -> newest.
      const fresh = page.filter((e) => !seen.has(e.id)).reverse();
      for (const e of fresh) {
        seen.add(e.id);
        info(
          [
            dim(formatDate(e.occurredAt)),
            paint(e.action, 'cyan'),
            e.target ? dim(e.target) : '',
            e.actor,
          ]
            .filter(Boolean)
            .join('  '),
        );
      }
    } catch (e) {
      info(paint(`audit poll failed: ${formatError(e)}`, 'yellow'));
    }
    await sleep(intervalMs);
  }
}

function cmdHelp(): void {
  info(`genius v${VERSION}  —  MailGenius command-line client

USAGE
  genius <command> [subcommand] [flags]

COMMANDS
  login                Authenticate with an API key (saved to ~/.mailgenius/credentials.json)
  logout               Forget the saved API key
  whoami               Print the current workspace and plan

  keys list            List API keys for the workspace
  keys get <id>        Inspect a single API key

  webhooks list                              List webhook subscriptions
  webhooks create --url=... [--events=a,b]   Create a subscription
  webhooks delete <id>                       Delete a subscription

  templates list                                                       List templates
  templates get <key>                                                  Inspect a template
  templates render <key> [--vars='{...}']                              Render to HTML
  templates send <key> --to=<email> [--vars='{...}']                   Send a transactional email

  events emit <name> [--email=...] [--user-id=...] [--traits='{...}']  Emit a customer event

  logs tail [--interval=5000] [--limit=50]                             Stream the audit log

GLOBAL FLAGS
  --api-key=<token>    Override the saved key for one invocation
  --api-url=<url>      Point at a custom MailGenius API host (default https://api.mailgenius.pro)
  --json               Print raw JSON responses where supported
  -h, --help           Show this message
`);
}

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //

function parseJsonFlag(args: ParsedArgs, name: string): Record<string, unknown> | undefined {
  const v = flag(args, name);
  if (!v) return undefined;
  try {
    const parsed = JSON.parse(v);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      fail(`--${name} must be a JSON object, got ${typeof parsed}`);
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    fail(`--${name}: invalid JSON (${(e as Error).message})`);
  }
}

function formatDate(iso: string | undefined | null): string {
  if (!iso) return dim('—');
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  } catch {
    return iso;
  }
}

function formatError(e: unknown): string {
  if (e instanceof MailGeniusError) {
    return `${e.message} (${e.code}${e.status ? `, HTTP ${e.status}` : ''})`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --------------------------------------------------------------------------- //
// Dispatch
// --------------------------------------------------------------------------- //

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    cmdHelp();
    return;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    info(`genius v${VERSION}`);
    return;
  }

  const command = argv.shift()!;
  const args = parse(argv);

  switch (command) {
    case 'login':
      await cmdLogin(args);
      break;
    case 'logout':
      cmdLogout();
      break;
    case 'whoami':
      await cmdWhoami();
      break;
    case 'keys':
      await cmdKeys(args);
      break;
    case 'webhooks':
      await cmdWebhooks(args);
      break;
    case 'templates':
      await cmdTemplates(args);
      break;
    case 'events':
      await cmdEvents(args);
      break;
    case 'logs':
      await cmdLogs(args);
      break;
    default:
      fail(`Unknown command: ${command}\n  Run \`genius help\` for usage.`);
  }
}

main().catch((e) => {
  fail(formatError(e));
});
