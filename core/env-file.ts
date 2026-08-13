import fs from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';
import { DATA_DIR } from './paths.js';
import { SECRET_FILE_MODE, ensureSecureDir, secureFile } from './fs-perms.js';

export const ENV_PATH = path.join(DATA_DIR, '.env');

/** The .env holds PLAID_SECRET, LLM API keys and FUNGIBLE_API_KEY: owner-only.
 *  Re-exported for callers that already import it from here; the policy itself
 *  lives in core/fs-perms.ts alongside the database and backup modes. */
export { SECRET_FILE_MODE };

const KEY_RE = /^([A-Z][A-Z0-9_]*)=/;
const LINE_RE = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/;

export type EnvUpdates = Record<string, string>;

/** Read the env file into a plain object. Missing file -> {}. Values are
 *  trimmed and surrounding quotes stripped, matching how dotenv loads them.
 *  This is the only reader; screens must not keep their own copy. */
export function readEnvFile(): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync(ENV_PATH, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length > 1 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v; // last assignment wins, matching dotenv
  }
  return out;
}

/** Tighten an already-existing .env to 0600. A file created by an older
 *  version (or by hand) can be group/world readable, and nothing else in the
 *  app ever revisits its mode. Best effort: never throws, so a startup path
 *  can call it unconditionally. Returns the mode it replaced, if it changed. */
export function secureEnvFile(): { changed: boolean; previousMode?: number } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(ENV_PATH);
  } catch {
    return { changed: false }; // no file yet — writeEnvFile creates it 0600
  }
  if (!stat.isFile()) return { changed: false };
  return secureFile(ENV_PATH);
}

/** Load DATA_DIR/.env into process.env. Every entry point uses this so the
 *  file's permissions are re-checked on every startup, not only when written. */
export function loadEnvFile(opts: { quiet?: boolean } = {}): void {
  secureEnvFile();
  config({ path: ENV_PATH, quiet: opts.quiet });
}

/**
 * Merge updates into ~/.fungible/.env without exposing existing values.
 *
 * The keys you pass are exactly the keys this changes:
 *
 *   a key with a value      — written, replacing any existing line in place, or
 *                             appended if it is new
 *   a key with an EMPTY or  — REMOVED from the file
 *   whitespace-only value
 *   a key you do not pass   — left exactly as it is
 *
 * Empty used to mean "ignore this", which made removing a credential
 * impossible: an owner who blanked their Plaid secret in the Setup wizard was
 * moved on to the next step while the old secret stayed on disk. For a file
 * holding PLAID_SECRET and the LLM API keys that is the wrong direction to fail
 * in — "I removed my secret" has to remove it. A caller that means "leave this
 * alone" says so by not passing the key, which is what the GUI's Configuration
 * panel does with the fields the owner left blank.
 *
 * Everything else in the file — comments, blank lines, keys not mentioned — is
 * preserved. `cleared` lists the keys that were actually present and removed.
 */
export function writeEnvFile(
  updates: EnvUpdates,
): { written: string[]; cleared: string[]; path: string } {
  const set: EnvUpdates = {};
  const remove = new Set<string>();
  for (const [k, v] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`Invalid env key: ${JSON.stringify(k)}`);
    if (typeof v !== 'string' || v.trim() === '') {
      remove.add(k);
      continue;
    }
    const value = v.trim();
    if (/[\r\n]/.test(value)) throw new Error(`Value for ${k} must not contain line breaks`);
    set[k] = value;
  }
  const written = Object.keys(set);
  const existing = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : null;
  // Nothing to write, and nothing that could be removed: do not create a file
  // just to say a key the owner cleared is absent from it.
  if (written.length === 0 && (existing === null || remove.size === 0)) {
    return { written, cleared: [], path: ENV_PATH };
  }

  ensureSecureDir(DATA_DIR);

  const lines = existing ? existing.split('\n') : [];
  const seen = new Set<string>();
  const cleared: string[] = [];

  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(KEY_RE);
    if (m && set[m[1]] !== undefined) {
      out.push(`${m[1]}=${set[m[1]]}`);
      seen.add(m[1]);
    } else if (m && remove.has(m[1])) {
      // Dropped, not blanked: `KEY=` in a .env is ambiguous about whether the
      // value is empty or gone. Every assignment of the key goes, since
      // readEnvFile and dotenv both take the last one.
      if (!cleared.includes(m[1])) cleared.push(m[1]);
    } else {
      out.push(line);
    }
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  for (const k of written) {
    if (!seen.has(k)) out.push(`${k}=${set[k]}`);
  }

  const text = out.length > 0 ? `${out.join('\n')}\n` : '';
  fs.writeFileSync(ENV_PATH, text, { encoding: 'utf8', mode: SECRET_FILE_MODE });
  // writeFileSync only applies mode on creation; tighten pre-existing files too
  fs.chmodSync(ENV_PATH, SECRET_FILE_MODE);
  return { written, cleared, path: ENV_PATH };
}
