import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { ENV_PATH, writeEnvFile } from './env-file.js';

/** Where the API key is persisted (same file the Plaid/LLM keys live in, 0600). */
export { ENV_PATH };

const ENV_LINE_RE = /^\s*(?:export\s+)?FUNGIBLE_API_KEY\s*=\s*(.*)$/;

/** Read FUNGIBLE_API_KEY straight off disk. Used when the value was written
 *  after this process loaded its .env (e.g. the TUI generated it while a
 *  long-lived `fungible mcp` stdio server was already running). */
export function readApiKeyFromEnvFile(): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    return undefined;
  }
  let found: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const m = ENV_LINE_RE.exec(line);
    if (!m) continue;
    let v = m[1].trim();
    if (v.length > 1 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    if (v) found = v; // last assignment wins, matching dotenv
  }
  return found;
}

/** The key this process should present/expect, or undefined if none exists yet. */
export function currentApiKey(): string | undefined {
  const fromEnv = process.env.FUNGIBLE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  return readApiKeyFromEnvFile();
}

/** Obtain the API key, generating and persisting one on first run.
 *
 *  Throws if a key can neither be found nor durably written — callers must then
 *  refuse to serve. There is deliberately no "no key configured" mode in which
 *  requests are accepted. */
export function ensureApiKey(): { key: string; generated: boolean } {
  const existing = currentApiKey();
  if (existing) {
    process.env.FUNGIBLE_API_KEY = existing;
    return { key: existing, generated: false };
  }

  const key = randomBytes(32).toString('hex');
  writeEnvFile({ FUNGIBLE_API_KEY: key });
  // Confirm it really landed on disk: a key we cannot re-read is a key the
  // user's other tools (mcp stdio, curl) could never present.
  if (readApiKeyFromEnvFile() !== key) {
    throw new Error(`generated key was not persisted to ${ENV_PATH}`);
  }
  process.env.FUNGIBLE_API_KEY = key;
  return { key, generated: true };
}

// ── Host allow-list ──────────────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(['localhost', '::1', '0:0:0:0:0:0:0:1']);

function envList(name: string): Set<string> {
  const raw = process.env[name];
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Strip the :port from a Host header value, keeping IPv6 literals intact. */
export function stripPort(value: string): string {
  const s = value.trim();
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    return end === -1 ? s.toLowerCase() : s.slice(1, end).toLowerCase();
  }
  // A bare (unbracketed) IPv6 literal is malformed in a Host header; treat the
  // whole value as the host rather than splitting it at the wrong colon.
  if (s.indexOf(':') !== s.lastIndexOf(':')) return s.toLowerCase();
  const i = s.lastIndexOf(':');
  return (i === -1 ? s : s.slice(0, i)).toLowerCase();
}

/** Loopback by default. `FUNGIBLE_ALLOWED_HOSTS` opts additional names in
 *  (comma-separated; a :port suffix is ignored). */
export function isHostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false; // HTTP/1.1 requires Host; refuse without it
  const host = stripPort(hostHeader);
  if (!host) return false;
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  const extra = envList('FUNGIBLE_ALLOWED_HOSTS');
  if (extra.has(host)) return true;
  // Allow-list entries may themselves carry a port.
  for (const entry of extra) if (stripPort(entry) === host) return true;
  return false;
}

/** No browser origin is trusted unless explicitly listed in
 *  `FUNGIBLE_ALLOWED_ORIGINS`. A request without an Origin header is a
 *  non-browser client (curl, the mcp server) and is allowed through to the
 *  bearer-token check. */
export function isOriginAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  return envList('FUNGIBLE_ALLOWED_ORIGINS').has(origin.trim().toLowerCase());
}

// ── Request guard ────────────────────────────────────────────────────────────

export type ApiGuardResult =
  | { ok: true; jsonBody: boolean }
  | { ok: false; status: number; error: string };

function mediaType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const t = value.split(';')[0].trim().toLowerCase();
  return t === '' ? undefined : t;
}

function isJsonMediaType(t: string): boolean {
  return t === 'application/json' || t.endsWith('+json');
}

function bearerMatches(header: string | undefined, apiKey: string): boolean {
  if (!header || !apiKey) return false;
  const m = /^bearer\s+(\S.*)$/i.exec(header.trim());
  if (!m) return false;
  // Hash both sides so the comparison is constant-time and length-independent.
  const a = createHash('sha256').update(m[1].trim(), 'utf8').digest();
  const b = createHash('sha256').update(apiKey, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** Fail-closed guard for every REST API request.
 *
 *  Checked in order: Host allow-list, Origin / Sec-Fetch-Site (CSRF + DNS
 *  rebinding), Content-Type, then the bearer token. `jsonBody` tells the caller
 *  whether a request body is permitted at all — a request that declared no
 *  Content-Type must not carry one. */
export function checkApiRequest(
  req: Pick<IncomingMessage, 'headers'>,
  apiKey: string,
): ApiGuardResult {
  const h = (name: string): string | undefined => {
    const v = req.headers[name];
    return Array.isArray(v) ? v.join(', ') : v;
  };

  const host = h('host');
  if (!isHostAllowed(host)) {
    return {
      ok: false,
      status: 403,
      error: `Forbidden: Host ${host ? JSON.stringify(host) : '(missing)'} is not allowed. ` +
        'The API serves loopback only; set FUNGIBLE_ALLOWED_HOSTS to opt another host in.',
    };
  }

  const origin = h('origin');
  if (!isOriginAllowed(origin)) {
    return { ok: false, status: 403, error: 'Forbidden: cross-origin request rejected' };
  }

  const site = h('sec-fetch-site');
  if (site !== undefined && site.trim().toLowerCase() !== 'none') {
    return { ok: false, status: 403, error: 'Forbidden: browser-initiated request rejected' };
  }

  const type = mediaType(h('content-type'));
  const jsonBody = type !== undefined && isJsonMediaType(type);
  if (type !== undefined && !jsonBody) {
    return {
      ok: false,
      status: 415,
      error: `Unsupported Media Type: Content-Type must be application/json (got ${type})`,
    };
  }

  if (!bearerMatches(h('authorization'), apiKey)) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }

  return { ok: true, jsonBody };
}
