import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { render, cleanup } from 'ink-testing-library';

const { TEST_DATA_DIR } = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const dir = path.join(os.tmpdir(), `fungible-setup-perms-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return { TEST_DATA_DIR: dir };
});

vi.mock('../../core/paths.js', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { Setup } from '../../tui/Setup.js';

const ENV_PATH = path.join(TEST_DATA_DIR, '.env');

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
const frame = (r: ReturnType<typeof render>) => (r.lastFrame() ?? '').replace(ANSI_RE, '');

async function tick(ms = 60) {
  await new Promise((res) => setTimeout(res, ms));
}

async function waitForFrame(r: ReturnType<typeof render>, needle: string, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (frame(r).includes(needle)) return;
    await tick(25);
  }
  throw new Error(`timed out waiting for ${JSON.stringify(needle)}; last frame:\n${frame(r)}`);
}

/** Drive the first-run wizard through the Plaid credential steps, which is the
 *  point where the secret the owner typed is persisted to DATA_DIR/.env. */
async function runFirstRunPlaidSetup() {
  const r = render(<Setup />);
  await waitForFrame(r, 'Welcome to fungible');
  r.stdin.write('\r');                        // welcome -> plaid-choice
  await waitForFrame(r, 'Do you have a Plaid account?');
  r.stdin.write('y');                         // -> plaid-client-id
  await waitForFrame(r, 'Plaid Client ID');
  r.stdin.write('fake-client-id-not-real');
  await tick();
  r.stdin.write('\r');                        // -> plaid-secret
  await waitForFrame(r, 'Plaid Secret');
  r.stdin.write('fake-secret-not-real');
  await tick();
  r.stdin.write('\r');                        // -> plaid-env
  await waitForFrame(r, 'Plaid Environment');
  r.stdin.write('\r');                        // Enter saves the credentials
  await waitForFrame(r, 'Default history start date');
  await tick();
  return r;
}

beforeEach(() => {
  if (fs.existsSync(ENV_PATH)) fs.rmSync(ENV_PATH);
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('Setup wizard .env permissions', () => {
  it('creates .env with 0600 when the owner types a Plaid secret on first run', async () => {
    await runFirstRunPlaidSetup();

    expect(fs.existsSync(ENV_PATH)).toBe(true);
    const contents = fs.readFileSync(ENV_PATH, 'utf8');
    expect(contents).toContain('PLAID_CLIENT_ID=fake-client-id-not-real');
    expect(contents).toContain('PLAID_SECRET=fake-secret-not-real');
    expect(contents).toContain('PLAID_ENV=sandbox');

    const mode = fs.statSync(ENV_PATH).mode & 0o777;
    expect(mode.toString(8)).toBe('600');
  });

  it('tightens a pre-existing world-readable .env when it saves credentials', async () => {
    // No PLAID_* keys, so the wizard treats this as an unconfigured first run
    // (env-file.test.ts covers replacing an existing key in place).
    fs.writeFileSync(ENV_PATH, '# bank\n\nFUNGIBLE_BACKUP_DAYS=14\n', { mode: 0o644 });
    fs.chmodSync(ENV_PATH, 0o644);
    expect((fs.statSync(ENV_PATH).mode & 0o777).toString(8)).toBe('644');

    await runFirstRunPlaidSetup();

    const mode = fs.statSync(ENV_PATH).mode & 0o777;
    expect(mode.toString(8)).toBe('600');
    // unrelated entries and comments survive the merge
    const contents = fs.readFileSync(ENV_PATH, 'utf8');
    expect(contents).toContain('# bank');
    expect(contents).toContain('FUNGIBLE_BACKUP_DAYS=14');
    expect(contents).toContain('PLAID_CLIENT_ID=fake-client-id-not-real');
  });
});
