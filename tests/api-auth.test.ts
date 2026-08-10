import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const { TEST_DATA_DIR } = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const dir = path.join(os.tmpdir(), `fungible-api-auth-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return { TEST_DATA_DIR: dir };
});

vi.mock('../core/paths.js', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../core/db.js', () => ({ initDb: vi.fn(), db: {} }));
vi.mock('../core/backup.js', () => ({ backupDb: vi.fn(async () => {}) }));
vi.mock('../core/tools.js', () => ({
  TOOL_DEFS: [{ name: 'list_rules' }, { name: 'add_rule' }],
  WRITE_TOOLS: new Set(['add_rule']),
  executeTool: vi.fn(async (name: string) => `executed:${name}`),
}));

import {
  checkApiRequest,
  currentApiKey,
  ensureApiKey,
  isHostAllowed,
  isOriginAllowed,
  readApiKeyFromEnvFile,
  stripPort,
} from '../core/api-auth.js';
import { executeTool } from '../core/tools.js';
import { startApiServer } from '../api/server.js';

const ENV_PATH = path.join(TEST_DATA_DIR, '.env');
const KEY = 'a'.repeat(64);

/** Minimal stand-in for the parts of IncomingMessage the guard reads. */
function reqWith(headers: Record<string, string | string[] | undefined>) {
  return { headers } as unknown as Parameters<typeof checkApiRequest>[0];
}

function localHeaders(extra: Record<string, string | string[]> = {}) {
  return reqWith({ host: '127.0.0.1:3456', authorization: `Bearer ${KEY}`, ...extra });
}

const SAVED = {
  FUNGIBLE_API_KEY: process.env.FUNGIBLE_API_KEY,
  FUNGIBLE_ALLOWED_HOSTS: process.env.FUNGIBLE_ALLOWED_HOSTS,
  FUNGIBLE_ALLOWED_ORIGINS: process.env.FUNGIBLE_ALLOWED_ORIGINS,
};

beforeEach(() => {
  delete process.env.FUNGIBLE_API_KEY;
  delete process.env.FUNGIBLE_ALLOWED_HOSTS;
  delete process.env.FUNGIBLE_ALLOWED_ORIGINS;
  if (fs.existsSync(ENV_PATH)) fs.rmSync(ENV_PATH);
});

afterAll(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ── key lifecycle ────────────────────────────────────────────────────────────

describe('ensureApiKey', () => {
  it('generates and persists a key on first run, at 0600', () => {
    const { key, generated } = ensureApiKey();
    expect(generated).toBe(true);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(readApiKeyFromEnvFile()).toBe(key);
    expect(fs.statSync(ENV_PATH).mode & 0o777).toBe(0o600);
  });

  it('reuses the persisted key on the next run instead of rotating it', () => {
    const first = ensureApiKey().key;
    delete process.env.FUNGIBLE_API_KEY; // fresh process, .env not yet loaded
    const second = ensureApiKey();
    expect(second.generated).toBe(false);
    expect(second.key).toBe(first);
  });

  it('honours an operator-set FUNGIBLE_API_KEY and does not write the file', () => {
    process.env.FUNGIBLE_API_KEY = 'operator-supplied';
    const { key, generated } = ensureApiKey();
    expect(key).toBe('operator-supplied');
    expect(generated).toBe(false);
    expect(fs.existsSync(ENV_PATH)).toBe(false);
  });

  it('keeps other .env entries intact when it appends the key', () => {
    fs.writeFileSync(ENV_PATH, '# bank\nPLAID_CLIENT_ID=abc\n');
    const { key } = ensureApiKey();
    expect(fs.readFileSync(ENV_PATH, 'utf8')).toBe(`# bank\nPLAID_CLIENT_ID=abc\nFUNGIBLE_API_KEY=${key}\n`);
  });

  it('throws rather than serving unauthenticated when the key cannot be persisted', () => {
    fs.mkdirSync(ENV_PATH); // a directory where the file should be: write fails
    try {
      expect(() => ensureApiKey()).toThrow();
    } finally {
      fs.rmdirSync(ENV_PATH);
    }
  });

  it('currentApiKey falls back to the file when the env was loaded before the key existed', () => {
    fs.writeFileSync(ENV_PATH, 'FUNGIBLE_API_KEY=from-disk\n');
    expect(currentApiKey()).toBe('from-disk');
  });
});

// ── host allow-list ──────────────────────────────────────────────────────────

describe('host allow-list', () => {
  it('strips ports, including from IPv6 literals', () => {
    expect(stripPort('127.0.0.1:3456')).toBe('127.0.0.1');
    expect(stripPort('LocalHost')).toBe('localhost');
    expect(stripPort('[::1]:3456')).toBe('::1');
    expect(stripPort('::1')).toBe('::1');
  });

  it('allows loopback by default', () => {
    for (const h of ['127.0.0.1:3456', 'localhost:3456', 'localhost', '[::1]:3456', '127.0.0.53']) {
      expect(isHostAllowed(h), h).toBe(true);
    }
  });

  it('refuses non-loopback hosts and a missing Host header', () => {
    for (const h of ['192.168.1.50:3456', 'fungible.local', 'evil.example', '10.0.0.2']) {
      expect(isHostAllowed(h), h).toBe(false);
    }
    expect(isHostAllowed(undefined)).toBe(false);
    expect(isHostAllowed('')).toBe(false);
  });

  it('opts extra hosts in only when FUNGIBLE_ALLOWED_HOSTS names them', () => {
    process.env.FUNGIBLE_ALLOWED_HOSTS = 'fungible.local, 192.168.1.50:3456';
    expect(isHostAllowed('fungible.local:3456')).toBe(true);
    expect(isHostAllowed('192.168.1.50:9999')).toBe(true);
    expect(isHostAllowed('other.local')).toBe(false);
  });
});

// ── origin ───────────────────────────────────────────────────────────────────

describe('origin allow-list', () => {
  it('allows a request with no Origin (curl, mcp) and refuses any browser origin', () => {
    expect(isOriginAllowed(undefined)).toBe(true);
    expect(isOriginAllowed('https://evil.example')).toBe(false);
    expect(isOriginAllowed('null')).toBe(false);
    expect(isOriginAllowed('http://localhost:5173')).toBe(false);
  });

  it('opts an origin in only when FUNGIBLE_ALLOWED_ORIGINS names it', () => {
    process.env.FUNGIBLE_ALLOWED_ORIGINS = 'http://localhost:5173';
    expect(isOriginAllowed('http://localhost:5173')).toBe(true);
    expect(isOriginAllowed('https://evil.example')).toBe(false);
  });
});

// ── the guard ────────────────────────────────────────────────────────────────

describe('checkApiRequest', () => {
  it('accepts a legitimate local JSON request', () => {
    const r = checkApiRequest(localHeaders({ 'content-type': 'application/json; charset=utf-8' }), KEY);
    expect(r).toEqual({ ok: true, jsonBody: true });
  });

  it('accepts a bodyless local request (the /notify ping) but marks bodies disallowed', () => {
    expect(checkApiRequest(localHeaders(), KEY)).toEqual({ ok: true, jsonBody: false });
  });

  it('refuses a request with no Authorization header', () => {
    const r = checkApiRequest(reqWith({ host: '127.0.0.1:3456', 'content-type': 'application/json' }), KEY);
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses a wrong, truncated, or extended bearer token', () => {
    for (const bad of [`Bearer ${KEY}x`, `Bearer ${KEY.slice(0, -1)}`, 'Bearer ', 'Basic ' + KEY, KEY]) {
      expect(checkApiRequest(reqWith({ host: 'localhost', authorization: bad }), KEY), bad)
        .toMatchObject({ ok: false, status: 401 });
    }
  });

  it('refuses a non-loopback Host even with a valid token (DNS rebinding)', () => {
    const r = checkApiRequest(reqWith({ host: '192.168.1.50:3456', authorization: `Bearer ${KEY}` }), KEY);
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses a cross-origin request even with a valid token (CSRF)', () => {
    const r = checkApiRequest(localHeaders({ origin: 'https://evil.example' }), KEY);
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses a browser-initiated request that omits Origin but sends Sec-Fetch-Site', () => {
    expect(checkApiRequest(localHeaders({ 'sec-fetch-site': 'cross-site' }), KEY))
      .toMatchObject({ ok: false, status: 403 });
    expect(checkApiRequest(localHeaders({ 'sec-fetch-site': 'same-site' }), KEY))
      .toMatchObject({ ok: false, status: 403 });
    // A user-typed navigation / non-browser client sends `none` or nothing.
    expect(checkApiRequest(localHeaders({ 'sec-fetch-site': 'none' }), KEY)).toMatchObject({ ok: true });
  });

  it('refuses text/plain — the CORS simple-request content type that needs no preflight', () => {
    const r = checkApiRequest(localHeaders({ 'content-type': 'text/plain;charset=UTF-8' }), KEY);
    expect(r).toMatchObject({ ok: false, status: 415 });
  });

  it('refuses the other preflight-free content types', () => {
    for (const ct of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      expect(checkApiRequest(localHeaders({ 'content-type': ct }), KEY), ct)
        .toMatchObject({ ok: false, status: 415 });
    }
  });

  it('fails closed on duplicated headers', () => {
    expect(checkApiRequest(reqWith({ host: ['127.0.0.1', 'evil.example'], authorization: `Bearer ${KEY}` }), KEY))
      .toMatchObject({ ok: false, status: 403 });
    expect(checkApiRequest(reqWith({ host: '127.0.0.1', authorization: [`Bearer ${KEY}`, 'Bearer x'] }), KEY))
      .toMatchObject({ ok: false, status: 401 });
  });
});

// ── the real HTTP server ─────────────────────────────────────────────────────

describe('startApiServer', () => {
  let server: import('node:http').Server | undefined;
  let base: string;

  beforeEach(async () => {
    process.env.FUNGIBLE_API_KEY = KEY;
    server = startApiServer(0, { quiet: true });
    if (!server) throw new Error('server did not start');
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.mocked(executeTool).mockClear();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it('refuses an unauthenticated write and never reaches the tool dispatcher', async () => {
    const res = await fetch(`${base}/tools/add_rule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: 'x', match_type: 'name', category: 'Coffee' }),
    });
    expect(res.status).toBe(401);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('refuses a cross-origin text/plain POST (CORS simple request, no preflight)', async () => {
    const res = await fetch(`${base}/tools/add_rule`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8', Origin: 'https://evil.example' },
      body: JSON.stringify({ pattern: 'x', match_type: 'name', category: 'Coffee' }),
    });
    expect(res.status).toBe(403);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('refuses a body sent without a JSON Content-Type even with a valid token', async () => {
    const res = await fetch(`${base}/tools/add_rule`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'text/plain' },
      body: '{"pattern":"x"}',
    });
    expect(res.status).toBe(415);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated /notify', async () => {
    const res = await fetch(`${base}/notify`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('serves a legitimate authenticated local call', async () => {
    const res = await fetch(`${base}/tools/list_rules`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: 'executed:list_rules' });
  });

  it('serves an authenticated /notify (the mcp stdio refresh ping)', async () => {
    const res = await fetch(`${base}/notify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('rejects an oversized body instead of buffering it', async () => {
    const res = await fetch(`${base}/tools/list_rules`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('preserves multi-byte characters that straddle a chunk boundary', async () => {
    const pattern = '☕'.repeat(200_000); // ~600 KB, split across many chunks
    const res = await fetch(`${base}/tools/add_rule`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern }),
    });
    expect(res.status).toBe(200);
    expect(vi.mocked(executeTool).mock.calls[0][1]).toEqual({ pattern });
  });
});
