/**
 * Removing a Plaid credential, driven through the wizard the owner uses:
 * tui/Setup.tsx savePlaidCreds() → core/env-file.ts writeEnvFile().
 *
 * writeEnvFile skipped any value whose trim() was empty, so blanking a field
 * and saving left the old value on disk. For a file holding PLAID_SECRET that
 * is the wrong direction to fail in: "I removed my Plaid secret" has to remove
 * it. The hand-rolled writer this replaced merged empty values through.
 *
 * The wizard also refused to move on from a blank credential field at all, so
 * the owner could not express the removal in the first place.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { render, cleanup } from 'ink-testing-library';

const { TEST_DATA_DIR } = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const dir = path.join(os.tmpdir(), `fungible-setup-creds-${Date.now()}`);
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

const tick = (ms = 30) => new Promise((res) => setTimeout(res, ms));

async function waitForFrame(r: ReturnType<typeof render>, needle: string, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (frame(r).includes(needle)) return;
    await tick(20);
  }
  throw new Error(`timed out waiting for ${JSON.stringify(needle)}; last frame:\n${frame(r)}`);
}

/** Ink parses one write as one keypress, so each backspace arrives on its own. */
async function backspace(r: ReturnType<typeof render>, times: number) {
  for (let i = 0; i < times; i++) {
    r.stdin.write('\x7f');
    await tick(20);
  }
}

/** An install with Plaid credentials already saved. PLAID_ENV is absent, which
 *  is what a GUI Settings save leaves behind when the environment dropdown is
 *  left on "(unchanged)" — and what sends the wizard back through the
 *  credential steps rather than skipping them. */
function seedConfiguredEnv() {
  fs.writeFileSync(
    ENV_PATH,
    '# bank\nPLAID_CLIENT_ID=cid\nPLAID_SECRET=sec\n\nFUNGIBLE_BACKUP_DAYS=14\n',
    { mode: 0o600 },
  );
}

beforeEach(() => {
  if (fs.existsSync(ENV_PATH)) fs.rmSync(ENV_PATH);
  delete process.env.PLAID_CLIENT_ID;
  delete process.env.PLAID_SECRET;
});

afterEach(() => cleanup());

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('Setup wizard: removing a stored credential', () => {
  it('clears the secret from .env when the owner blanks the field and saves', async () => {
    seedConfiguredEnv();

    const r = render(<Setup />);
    await waitForFrame(r, 'Welcome to fungible');
    r.stdin.write('\r');                       // welcome -> plaid-choice
    await waitForFrame(r, 'Do you have a Plaid account?');
    r.stdin.write('y');                        // -> plaid-client-id (pre-filled)
    await waitForFrame(r, 'Plaid Client ID');

    await backspace(r, 3);                     // erase "cid"
    expect(frame(r)).toContain('will be removed');
    r.stdin.write('\r');                       // -> plaid-secret (pre-filled)
    await waitForFrame(r, 'Plaid Secret');

    await backspace(r, 3);                     // erase "sec"
    expect(frame(r)).toContain('will be removed');
    r.stdin.write('\r');                       // -> plaid-env
    await waitForFrame(r, 'Plaid Environment');
    r.stdin.write('\r');                       // Enter saves
    await waitForFrame(r, 'Default history start date');
    await tick();

    const contents = fs.readFileSync(ENV_PATH, 'utf8');
    expect(contents, contents).not.toMatch(/^PLAID_SECRET=/m);
    expect(contents, contents).not.toMatch(/^PLAID_CLIENT_ID=/m);
    // Only what the owner cleared: the environment they did choose is written,
    // and keys and comments the wizard never asked about are left alone.
    expect(contents).toContain('PLAID_ENV=sandbox');
    expect(contents).toContain('FUNGIBLE_BACKUP_DAYS=14');
    expect(contents).toContain('# bank');
    // The running process must not keep serving the credential it just removed.
    expect(process.env.PLAID_SECRET ?? '').toBe('');
    expect(process.env.PLAID_CLIENT_ID ?? '').toBe('');
    expect(fs.statSync(ENV_PATH).mode & 0o777).toBe(0o600);
  });

  it('still saves a credential the owner types, and says nothing about removing', async () => {
    seedConfiguredEnv();

    const r = render(<Setup />);
    await waitForFrame(r, 'Welcome to fungible');
    r.stdin.write('\r');
    await waitForFrame(r, 'Do you have a Plaid account?');
    r.stdin.write('y');
    await waitForFrame(r, 'Plaid Client ID');
    expect(frame(r)).not.toContain('will be removed');

    r.stdin.write('2');                        // "cid" -> "cid2"
    await tick();
    r.stdin.write('\r');
    await waitForFrame(r, 'Plaid Secret');
    r.stdin.write('2');
    await tick();
    r.stdin.write('\r');
    await waitForFrame(r, 'Plaid Environment');
    r.stdin.write('\r');
    await waitForFrame(r, 'Default history start date');
    await tick();

    const contents = fs.readFileSync(ENV_PATH, 'utf8');
    expect(contents).toContain('PLAID_CLIENT_ID=cid2');
    expect(contents).toContain('PLAID_SECRET=sec2');
    expect(process.env.PLAID_SECRET).toBe('sec2');
  });
});
