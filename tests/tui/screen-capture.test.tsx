import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import stripAnsi from 'strip-ansi';
import { render, cleanup } from 'ink-testing-library';

const { TEST_DATA_DIR } = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const dir = path.join(os.tmpdir(), `fungible-screen-capture-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { TEST_DATA_DIR: dir };
});

vi.mock('../../core/paths.js', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../../core/db.js', async () => {
  const { makeTestDb } = await import('../helpers/makeTestDb.js');
  return { db: await makeTestDb() };
});

import { Setup } from '../../tui/Setup.js';
import { captureFrame, installScreenCapture, SCREEN_PATH } from '../../tui/screen-capture.js';
import { executeTool } from '../../core/tools.js';

const SCREEN_FILE = path.join(TEST_DATA_DIR, 'screen.txt');
const CLIENT_ID = '68b0feedfacecafe0badc0de';   // fake, shaped like a Plaid client_id
const SECRET = 'a1b2c3d4e5f6a7b8c9d0e1f2';      // fake

const frame = (r: ReturnType<typeof render>) => stripAnsi(r.lastFrame() ?? '');

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

/** Drive the first-run wizard to the step named, typing what the owner types. */
async function wizardAt(step: 'plaid-client-id' | 'plaid-secret') {
  const r = render(<Setup />);
  await waitForFrame(r, 'Welcome to fungible');
  r.stdin.write('\r');                          // welcome -> plaid-choice
  await waitForFrame(r, 'Do you have a Plaid account?');
  r.stdin.write('y');                           // -> plaid-client-id
  await waitForFrame(r, 'Plaid Client ID');
  r.stdin.write(CLIENT_ID);
  await tick();
  if (step === 'plaid-secret') {
    r.stdin.write('\r');                        // -> plaid-secret
    await waitForFrame(r, 'Plaid Secret');
    r.stdin.write(SECRET);
    await tick();
  }
  return r;
}

beforeEach(() => {
  fs.rmSync(SCREEN_FILE, { force: true });
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('screen capture of the Plaid credential steps', () => {
  it('never lets the Plaid Client ID reach screen.txt or the get_screen tool', async () => {
    const r = await wizardAt('plaid-client-id');
    // Sanity: this is the frame the owner is looking at while typing.
    expect(frame(r)).toContain('Client ID:');

    // Exactly what tui/index.tsx does with the frame ink just wrote.
    captureFrame(r.lastFrame() ?? '');

    const onDisk = fs.readFileSync(SCREEN_FILE, 'utf8');
    // core/tools.ts reads screen.txt; mcp/create-server.ts exposes this tool.
    const viaTool = await executeTool('get_screen', {});

    expect(onDisk).toContain('Plaid Client ID');       // the frame really was captured
    expect(onDisk).not.toContain(CLIENT_ID);
    expect(onDisk).toContain('*'.repeat(CLIENT_ID.length));
    expect(viaTool).not.toContain(CLIENT_ID);
  });

  it('never lets the Plaid secret reach screen.txt or the get_screen tool', async () => {
    const r = await wizardAt('plaid-secret');
    expect(frame(r)).toContain('Secret:');

    captureFrame(r.lastFrame() ?? '');

    const onDisk = fs.readFileSync(SCREEN_FILE, 'utf8');
    const viaTool = await executeTool('get_screen', {});

    expect(onDisk).toContain('Plaid Secret');
    expect(onDisk).not.toContain(SECRET);
    expect(viaTool).not.toContain(SECRET);
  });
});

describe('screen.txt permissions', () => {
  it('writes a captured frame owner-only (0600)', () => {
    captureFrame('Checking  ****1234   $8,215.02');
    expect((fs.statSync(SCREEN_FILE).mode & 0o777).toString(8)).toBe('600');
  });

  it('re-tightens a captured frame over a file an older version left readable', () => {
    fs.writeFileSync(SCREEN_FILE, 'old frame');
    fs.chmodSync(SCREEN_FILE, 0o664);

    captureFrame('Checking  ****1234   $8,215.02');

    expect(fs.readFileSync(SCREEN_FILE, 'utf8')).toContain('$8,215.02');
    expect((fs.statSync(SCREEN_FILE).mode & 0o777).toString(8)).toBe('600');
  });

  it('repairs a world-readable screen.txt at startup, before any frame is captured', () => {
    // An install from before the 0600 policy: the file already holds a render
    // of the owner's balances and nothing ever rewrites it.
    fs.writeFileSync(SCREEN_FILE, 'Checking  ****1234   $8,215.02');
    fs.chmodSync(SCREEN_FILE, 0o664);

    const fakeStdout = { write: () => true } as unknown as NodeJS.WriteStream;
    const restore = installScreenCapture(fakeStdout);
    try {
      expect((fs.statSync(SCREEN_FILE).mode & 0o777).toString(8)).toBe('600');
    } finally {
      restore();
    }
  });

  it('exposes the path core/tools.ts reads', () => {
    expect(SCREEN_PATH).toBe(SCREEN_FILE);
  });
});
