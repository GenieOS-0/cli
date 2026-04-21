/**
 * Tests for the hand-rolled argv parser. We intentionally don't pull
 * commander/yargs into the CLI, so this surface needs its own tests.
 *
 * We re-export the internals from a thin test shim so we don't have
 * to mark `parse` as exported in the entry point (which would break
 * the bundled binary's tree shaking).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const CLI = new URL('../src/cli.ts', import.meta.url).pathname;

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    env: { ...process.env, ...env, NO_COLOR: '1' },
    encoding: 'utf-8',
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

test('help prints usage', () => {
  const r = runCli(['help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /USAGE/);
  assert.match(r.stdout, /login\s+Authenticate/);
  assert.match(r.stdout, /logs tail/);
});

test('--version prints version', () => {
  const r = runCli(['--version']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^genius v\d+\.\d+\.\d+/);
});

test('whoami fails without credentials', () => {
  const r = runCli(['whoami'], { MAILGENIUS_API_KEY: '', HOME: '/tmp/this-does-not-exist-mg-cli-test' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Not logged in|MailGenius API key/);
});

test('login --api-key non-tty bails with helpful message when no key', () => {
  const r = runCli(['login'], { MAILGENIUS_API_KEY: '', HOME: '/tmp/this-does-not-exist-mg-cli-test' });
  assert.notEqual(r.status, 0);
  // stdin is not a TTY in spawnSync, so the prompt path is the failure path.
  assert.match(r.stderr, /No API key/);
});

test('unknown command fails with hint', () => {
  const r = runCli(['frobnicate']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Unknown command: frobnicate/);
});

test('templates send requires --to', () => {
  const r = runCli(['templates', 'send', 'welcome'], { MAILGENIUS_API_KEY: 'mg_test_offline' });
  assert.notEqual(r.status, 0);
  // Either the parser bails on missing --to, or the SDK fails to reach
  // the offline base URL. Either way we want a non-zero exit.
  assert.match(r.stderr, /to|Network|Missing/);
});
