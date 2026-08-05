/**
 * `genie` CLI.
 *
 * Surface:
 *
 *   genie login                       interactive — paste an API key
 *   genie logout
 *   genie whoami                      print workspace + plan
 *   genie keys list|get
 *   genie webhooks list|create|delete
 *   genie templates list|get|render|send
 *   genie sequences list|get|enroll
 *   genie pages list|get
 *   genie brand list|get
 *   genie sms kit|catalog|send|deliveries
 *   genie social networks|posts|get|create|schedule|publish|delete
 *   genie events emit
 *   genie logs tail                   poll /v1/audit until ^C
 *
 * Credentials live at ``~/.genieos/credentials.json`` and are
 * shared with ``@genie-os/mcp``. The GENIEOS_API_KEY env var
 * always wins.
 *
 * Dependency-light by design — no commander / yargs. Routing is a
 * hand-rolled dispatcher because the surface is small.
 */
import { GenieOS, GenieOSError } from '@genie-os/sdk';
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
  return join(homedir(), '.genieos', 'credentials.json');
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
  const env = process.env.GENIEOS_API_KEY?.trim();
  if (env) return env;
  const file = loadCredentials();
  return file.apiKey?.trim() ?? '';
}

function resolveApiUrl(): string {
  return (
    process.env.GENIEOS_API_URL?.trim() ||
    loadCredentials().apiUrl?.trim() ||
    'https://api.genieos.pro'
  );
}

function makeClient(): GenieOS {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    fail(
      'Not logged in.\n' +
        '  Run `genie login`, or set GENIEOS_API_KEY in your shell.',
    );
  }
  return new GenieOS({ apiKey, baseUrl: resolveApiUrl() });
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
    info('Open https://app.genieos.pro/settings/api-keys, create a key, and paste it here.');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    apiKey = (await rl.question(paint('API key: ', 'cyan'))).trim();
    rl.close();
    if (!apiKey) fail('No API key entered.');
  }
  const apiUrl = flag(args, 'api-url');
  // Verify the key works before persisting.
  const probe = new GenieOS({
    apiKey,
    baseUrl: apiUrl ?? 'https://api.genieos.pro',
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
  const gos = makeClient();
  const ws = await gos.workspace.get();
  info(`${paint(ws.name, 'bold')} (${ws.id})`);
  info(`  plan:       ${ws.plan}`);
  info(`  scopes:     ${ws.scopes.join(', ') || dim('(none)')}`);
  info(`  rate limit: ${ws.rateLimitPerMinute}/min`);
}

async function cmdKeys(args: ParsedArgs): Promise<void> {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === 'list' || sub === undefined) {
    const keys = await gos.keys.list();
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
    if (!id) fail('genie keys get <id>');
    info(asJson(await gos.keys.get(id)));
    return;
  }
  fail(`Unknown subcommand: keys ${sub}\n  Available: list, get`);
}

async function cmdWebhooks(args: ParsedArgs): Promise<void> {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === 'list' || sub === undefined) {
    const items = await gos.webhooks.list();
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
    const created = await gos.webhooks.create({
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
    if (!id) fail('genie webhooks delete <id>');
    await gos.webhooks.delete(id);
    ok(`Deleted webhook ${id}`);
    return;
  }
  fail(`Unknown subcommand: webhooks ${sub}\n  Available: list, create, delete`);
}

async function cmdTemplates(args: ParsedArgs): Promise<void> {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === 'list' || sub === undefined) {
    const items = await gos.templates.list();
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
    if (!key) fail('genie templates get <key>');
    info(asJson(await gos.templates.get(key)));
    return;
  }
  if (sub === 'render') {
    const key = args.positionals.shift();
    if (!key) fail('genie templates render <key> [--vars=<json>]');
    const vars = parseJsonFlag(args, 'vars');
    const out = await gos.templates.render(key, { variables: vars });
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
    if (!key) fail('genie templates send <key> --to=<email> [--vars=<json>]');
    const to = requireFlag(args, 'to');
    const vars = parseJsonFlag(args, 'vars');
    const out = await gos.templates.send(key, { to, variables: vars });
    ok(`Queued send ${out.id}`);
    return;
  }
  if (sub === 'create') {
    const name = flag(args, 'name');
    const key = flag(args, 'key');
    const out = (await gos.templates.create({
      ...(name ? { name } : {}),
      ...(key ? { key } : {}),
    })) as { id?: string; key?: string; name?: string };
    ok(`Created template ${out.key ?? out.id ?? ''}`.trim());
    info(asJson(out));
    return;
  }
  if (sub === 'compose') {
    const prompt = args.positionals.shift() || flag(args, 'prompt');
    if (!prompt) fail('genie templates compose "<brief>" [--key=…] [--name=…]');
    const key = flag(args, 'key');
    const name = flag(args, 'name');
    const out = (await gos.templates.compose({
      prompt,
      ...(key ? { key } : {}),
      ...(name ? { name } : {}),
    })) as { id?: string; key?: string; name?: string; subject?: string };
    ok(`Composed template ${out.key ?? out.id ?? ''}`.trim());
    if (out.subject) info(paint('Subject:', 'bold') + ' ' + out.subject);
    info(asJson(out));
    return;
  }
  fail(`Unknown subcommand: templates ${sub}\n  Available: list, get, render, send, create, compose`);
}

async function cmdEvents(args: ParsedArgs): Promise<void> {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === 'emit') {
    const name = args.positionals.shift() ?? requireFlag(args, 'name');
    const userId = flag(args, 'user-id');
    const email = flag(args, 'email');
    const traits = parseJsonFlag(args, 'traits');
    const out = await gos.events.emit({ name, userId, email, traits });
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
  const gos = makeClient();
  const intervalMs = Number(flag(args, 'interval') ?? '5000');
  const limit = Number(flag(args, 'limit') ?? '50');

  let seen = new Set<string>();
  // Prime from the most recent page so we don't dump history.
  try {
    const initial = await gos.audit.list({ limit });
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
      const page = await gos.audit.list({ limit });
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

async function cmdSequences(args: ParsedArgs): Promise<void> {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === 'list' || sub === undefined) {
    const items = await gos.sequences.list();
    if (bool(args, 'json')) {
      info(asJson(items));
      return;
    }
    info(
      table(items, [
        { header: 'KEY', get: (s) => s.key },
        { header: 'NAME', get: (s) => s.name },
        { header: 'STATUS', get: (s) => s.status },
        { header: 'ENROLLED', get: (s) => String(s.enrolledCount) },
      ]),
    );
    return;
  }
  if (sub === 'get') {
    const key = args.positionals.shift();
    if (!key) fail('genie sequences get <keyOrId>');
    info(asJson(await gos.sequences.get(key)));
    return;
  }
  if (sub === 'enroll') {
    const key = args.positionals.shift();
    if (!key) fail('genie sequences enroll <keyOrId> --email=...');
    const email = flag(args, 'email');
    const userId = flag(args, 'user-id');
    if (!email && !userId) fail('Provide --email or --user-id');
    const result = await gos.sequences.enroll(key, {
      contact: { email, userId, traits: parseJsonFlag(args, 'traits') },
      variables: parseJsonFlag(args, 'vars'),
    });
    ok(`Enrolled run ${result.runId} on ${result.sequenceKey}`);
    if (bool(args, 'json')) info(asJson(result));
    return;
  }
  fail(`Unknown subcommand: sequences ${sub}\n  Available: list, get, enroll`);
}

async function cmdPages(args: ParsedArgs): Promise<void> {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === 'list' || sub === undefined) {
    const items = await gos.pages.list();
    if (bool(args, 'json')) {
      info(asJson(items));
      return;
    }
    info(
      table(items, [
        { header: 'ID', get: (p) => p.id },
        { header: 'SLUG', get: (p) => p.slug },
        { header: 'STATUS', get: (p) => p.status },
        { header: 'TITLE', get: (p) => p.title },
      ]),
    );
    return;
  }
  if (sub === 'get') {
    const id = args.positionals.shift();
    if (!id) fail('genie pages get <idOrSlug>');
    info(asJson(await gos.pages.get(id)));
    return;
  }
  if (sub === 'publish') {
    const id = args.positionals.shift();
    if (!id) fail('genie pages publish <idOrSlug>');
    info(asJson(await gos.pages.publish(id, flag(args, 'slug') ? { slug: flag(args, 'slug') } : {})));
    return;
  }
  if (sub === 'unpublish') {
    const id = args.positionals.shift();
    if (!id) fail('genie pages unpublish <idOrSlug>');
    info(asJson(await gos.pages.unpublish(id)));
    return;
  }
  fail(`Unknown subcommand: pages ${sub}\n  Available: list, get, publish, unpublish`);
}

async function cmdBrand(args: ParsedArgs): Promise<void> {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === 'list' || sub === undefined) {
    const items = await gos.brand.list();
    if (bool(args, 'json')) {
      info(asJson(items));
      return;
    }
    info(
      table(items, [
        { header: 'ID', get: (b) => b.id },
        { header: 'NAME', get: (b) => b.name },
        { header: 'DEFAULT', get: (b) => (b.isDefault ? 'yes' : '') },
        { header: 'DOMAIN', get: (b) => b.domain ?? '—' },
      ]),
    );
    return;
  }
  if (sub === 'get') {
    const id = args.positionals.shift() ?? 'default';
    info(asJson(await gos.brand.get(id)));
    return;
  }
  fail(`Unknown subcommand: brand ${sub}\n  Available: list, get`);
}

async function cmdSms(args: ParsedArgs): Promise<void> {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === 'kit' || sub === 'catalog') {
    const items = sub === 'kit' ? await gos.messaging.kit() : await gos.messaging.catalog();
    info(asJson(items));
    return;
  }
  if (sub === 'send') {
    const templateKey = requireFlag(args, 'template');
    const to = flag(args, 'to');
    const result = await gos.messaging.send({
      templateKey,
      to,
      variables: parseJsonFlag(args, 'vars') as Record<string, string | number | boolean> | undefined,
    });
    ok(`SMS ${result.status} · delivery ${result.deliveryId}`);
    if (bool(args, 'json')) info(asJson(result));
    return;
  }
  if (sub === 'deliveries') {
    info(
      asJson(
        await gos.messaging.listDeliveries({
          templateKey: flag(args, 'template'),
          limit: Number(flag(args, 'limit') ?? 50),
        }),
      ),
    );
    return;
  }
  fail(`Unknown subcommand: sms ${sub}\n  Available: kit, catalog, send, deliveries`);
}

async function cmdMarketing(args: ParsedArgs): Promise<void> {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === 'strategy' || sub === undefined) {
    info(asJson(await gos.marketing.strategy({ detail: bool(args, 'full') ? 'full' : 'summary' })));
    return;
  }
  if (sub === 'icps') {
    info(asJson(await gos.marketing.listIcps({ detail: bool(args, 'full') ? 'full' : 'summary' })));
    return;
  }
  if (sub === 'defaults') {
    info(asJson(await gos.marketing.creationDefaults()));
    return;
  }
  if (sub === 'set-defaults') {
    const body: Record<string, unknown> = {};
    const kind = flag(args, 'coordination-kind');
    const emailCount = flag(args, 'email-count');
    const goal = flag(args, 'goal');
    const askMode = flag(args, 'ask-mode');
    const strategyMode = flag(args, 'strategy-mode');
    if (kind) body.coordinationKind = kind;
    if (emailCount) body.emailCount = Number(emailCount);
    if (goal) body.goal = goal;
    if (askMode) body.askMode = askMode;
    if (strategyMode) body.strategyMode = strategyMode;
    info(asJson(await gos.marketing.setCreationDefaults(body)));
    return;
  }
  fail(
    `Unknown subcommand: marketing ${sub}\n  Available: strategy, icps, defaults, set-defaults`,
  );
}

async function cmdCreations(args: ParsedArgs): Promise<void> {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === 'list' || sub === undefined) {
    info(asJson(await gos.creations.list({ status: flag(args, 'status'), limit: Number(flag(args, 'limit') ?? 25) })));
    return;
  }
  if (sub === 'get') {
    const id = args.positionals.shift();
    if (!id) fail('genie creations get <creationId>');
    info(asJson(await gos.creations.get(id, { detail: bool(args, 'full') ? 'full' : 'summary' })));
    return;
  }
  if (sub === 'spawn') {
    const brief = flag(args, 'brief') ?? args.positionals.shift();
    if (!brief) fail('genie creations spawn --brief "…"');
    info(
      asJson(
        await gos.creations.spawn({
          brief,
          ...(flag(args, 'strategy-mode')
            ? { strategyMode: flag(args, 'strategy-mode') }
            : {}),
        }),
      ),
    );
    return;
  }
  if (sub === 'approve') {
    const id = args.positionals.shift();
    if (!id) fail('genie creations approve <creationId>');
    info(asJson(await gos.creations.approveStrategy(id)));
    return;
  }
  fail(`Unknown subcommand: creations ${sub}\n  Available: list, get, spawn, approve`);
}

async function cmdLists(args: ParsedArgs): Promise<void> {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === 'list' || sub === undefined) {
    info(asJson(await gos.lists.list()));
    return;
  }
  if (sub === 'get') {
    const id = args.positionals.shift();
    if (!id) fail('genie lists get <listId>');
    info(asJson(await gos.lists.get(id)));
    return;
  }
  if (sub === 'create') {
    const name = flag(args, 'name') ?? args.positionals.shift();
    if (!name) fail('genie lists create --name "…"');
    info(asJson(await gos.lists.create({ name })));
    return;
  }
  if (sub === 'add-members') {
    const id = args.positionals.shift();
    const ids = flag(args, 'contact-ids');
    if (!id || !ids) fail('genie lists add-members <listId> --contact-ids id1,id2');
    info(asJson(await gos.lists.addMembers(id, ids.split(',').map((s) => s.trim()).filter(Boolean))));
    return;
  }
  fail(`Unknown subcommand: lists ${sub}\n  Available: list, get, create, add-members`);
}

async function cmdLinks(args: ParsedArgs): Promise<void> {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === 'list') {
    const limitRaw = flag(args, 'limit');
    info(
      asJson(
        await gos.links.list({
          includeArchived: bool(args, 'include-archived'),
          ...(limitRaw ? { limit: Number(limitRaw) } : {}),
        }),
      ),
    );
    return;
  }
  if (sub === 'utm-suggestions' || sub === 'utm') {
    const field = flag(args, 'field') as
      | 'source'
      | 'medium'
      | 'campaign'
      | 'content'
      | 'term'
      | undefined;
    info(
      asJson(
        await gos.links.utmSuggestions({
          ...(field ? { field } : {}),
          includeCounts: !bool(args, 'no-counts'),
        }),
      ),
    );
    return;
  }
  if (sub === 'create' || sub === undefined) {
    const url = flag(args, 'url') ?? args.positionals.shift();
    if (!url) fail('genie links create --url https://… [--slug=…] [--label=…] [--utm-source=…] …');
    const utmSource = flag(args, 'utm-source');
    const utmMedium = flag(args, 'utm-medium');
    const utmCampaign = flag(args, 'utm-campaign');
    const utmContent = flag(args, 'utm-content');
    const utmTerm = flag(args, 'utm-term');
    const utm =
      utmSource || utmMedium || utmCampaign || utmContent || utmTerm
        ? {
            ...(utmSource ? { source: utmSource } : {}),
            ...(utmMedium ? { medium: utmMedium } : {}),
            ...(utmCampaign ? { campaign: utmCampaign } : {}),
            ...(utmContent ? { content: utmContent } : {}),
            ...(utmTerm ? { term: utmTerm } : {}),
          }
        : undefined;
    const tagsRaw = flag(args, 'tags');
    const tags = tagsRaw
      ? tagsRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    info(
      asJson(
        await gos.links.create({
          destinationUrl: url,
          ...(flag(args, 'slug') ? { slug: flag(args, 'slug') } : {}),
          ...(flag(args, 'label') ? { label: flag(args, 'label') } : {}),
          ...(flag(args, 'campaign-id') ? { campaignId: flag(args, 'campaign-id') } : {}),
          ...(flag(args, 'domain') ? { domain: flag(args, 'domain') } : {}),
          ...(tags?.length ? { tags } : {}),
          ...(utm ? { utm } : {}),
        }),
      ),
    );
    return;
  }
  fail(`Unknown subcommand: links ${sub}\n  Available: list, utm-suggestions, create`);
}

async function cmdSocial(args: ParsedArgs): Promise<void> {
  const sub = args.positionals.shift();
  const gos = makeClient();
  if (sub === 'networks') {
    const action = args.positionals.shift();
    if (action === 'refresh') {
      info(asJson(await gos.social.refreshNetworks()));
      return;
    }
    info(asJson(await gos.social.listNetworks()));
    return;
  }
  if (sub === 'posts' || sub === 'list') {
    const items = await gos.social.list({
      status: flag(args, 'status'),
      channelId: flag(args, 'channel'),
      limit: Number(flag(args, 'limit') ?? 25),
    });
    if (bool(args, 'json')) {
      info(asJson(items));
      return;
    }
    info(
      table(items, [
        { header: 'ID', get: (p) => p.id },
        { header: 'CHANNEL', get: (p) => String(p.channelId ?? '—') },
        { header: 'STATUS', get: (p) => String(p.status) },
        {
          header: 'CAPTION',
          get: (p) => {
            const c = String(p.caption ?? '');
            return c.length > 48 ? `${c.slice(0, 45)}…` : c || '—';
          },
        },
      ]),
    );
    return;
  }
  if (sub === 'get') {
    const id = args.positionals.shift();
    if (!id) fail('genie social get <postId>');
    info(asJson(await gos.social.get(id)));
    return;
  }
  if (sub === 'create') {
    const channelsRaw = requireFlag(args, 'channels');
    const channels = channelsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    const mode = (flag(args, 'mode') as 'copy' | 'compose' | undefined) ?? 'copy';
    const result = await gos.social.create({
      mode,
      channels,
      caption: flag(args, 'caption'),
      brief: flag(args, 'brief'),
      scheduleAt: flag(args, 'schedule-at'),
      publish: bool(args, 'publish'),
    });
    ok(`Created social post group ${result.groupId ?? '(see JSON)'}`);
    info(asJson(result));
    return;
  }
  if (sub === 'schedule') {
    const id = args.positionals.shift();
    if (!id) fail('genie social schedule <postId> --at=<ISO>');
    const at = requireFlag(args, 'at');
    info(asJson(await gos.social.schedule(id, { scheduledAt: at })));
    return;
  }
  if (sub === 'publish') {
    const id = args.positionals.shift();
    if (!id) fail('genie social publish <postId>');
    info(asJson(await gos.social.publish(id)));
    return;
  }
  if (sub === 'delete') {
    const id = args.positionals.shift();
    if (!id) fail('genie social delete <postId>');
    info(asJson(await gos.social.delete(id, { fromProvider: bool(args, 'from-provider') })));
    return;
  }
  fail(
    `Unknown subcommand: social ${sub}\n  Available: networks, posts, get, create, schedule, publish, delete`,
  );
}

function cmdHelp(): void {
  info(`genie v${VERSION}  —  GenieOS command-line client

USAGE
  genie <command> [subcommand] [flags]

COMMANDS
  login                Authenticate with an API key (saved to ~/.genieos/credentials.json)
  logout               Forget the saved API key
  whoami               Print the current workspace and plan

  keys list            List API keys for the workspace
  keys get <id>        Inspect a single API key

  webhooks list                              List webhook subscriptions
  webhooks create --url=... [--events=a,b]   Create a subscription
  webhooks delete <id>                       Delete a subscription

  templates list                                                       List templates
  templates get <key>                                                  Inspect a template
  templates create [--name=…] [--key=…]                                Create a blank draft
  templates compose "<brief>" [--key=…] [--name=…]                     Compose from a brief
  templates render <key> [--vars='{...}']                              Render to HTML
  templates send <key> --to=<email> [--vars='{...}']                   Send a transactional email

  sequences list|get|enroll                                            Sequences
  pages list|get|publish|unpublish                                     Landing pages
  brand list|get                                                       Brand kit (read)

  sms kit|catalog|send|deliveries                                      Transactional SMS
  social networks|posts|get|create|schedule|publish|delete             Organic social

  marketing strategy|icps|defaults|set-defaults                        Marketing OS
  creations list|get|spawn|approve                                     Campaigns
  lists list|get|create|add-members                                    Contact lists
  links list|utm-suggestions|create [--utm-source=…] …                 Short links

  events emit <name> [--email=...] [--user-id=...] [--traits='{...}']  Emit a customer event

  logs tail [--interval=5000] [--limit=50]                             Stream the audit log

GLOBAL FLAGS
  --api-key=<token>    Override the saved key for one invocation
  --api-url=<url>      Point at a custom GenieOS API host (default https://api.genieos.pro)
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
  if (e instanceof GenieOSError) {
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
    info(`genie v${VERSION}`);
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
    case 'sequences':
      await cmdSequences(args);
      break;
    case 'pages':
      await cmdPages(args);
      break;
    case 'brand':
      await cmdBrand(args);
      break;
    case 'sms':
      await cmdSms(args);
      break;
    case 'social':
      await cmdSocial(args);
      break;
    case 'marketing':
      await cmdMarketing(args);
      break;
    case 'creations':
      await cmdCreations(args);
      break;
    case 'lists':
      await cmdLists(args);
      break;
    case 'links':
      await cmdLinks(args);
      break;
    case 'logs':
      await cmdLogs(args);
      break;
    default:
      fail(`Unknown command: ${command}\n  Run \`genie help\` for usage.`);
  }
}

main().catch((e) => {
  fail(formatError(e));
});
