import fs from 'node:fs';
import path from 'node:path';

/**
 * Permission policy for everything the app writes under DATA_DIR.
 *
 * DATA_DIR holds the transaction database (every transaction, balance and
 * account mask in plaintext), its backups, the Plaid token encryption key, the
 * .env with PLAID_SECRET/LLM keys, and rendered screens. None of it is meant
 * for anyone but the owner, so: directories 0700, files 0600.
 *
 * This module is the only place those numbers are defined; writers import from
 * here rather than passing their own mode (or none at all, which is how the db
 * ended up 0644 under any umask).
 */

export const DATA_DIR_MODE = 0o700;
export const SECRET_FILE_MODE = 0o600;

function warn(target: string, mode: number, want: number, err: unknown): void {
  process.stderr.write(
    `[fungible] warning: ${target} is mode ${mode.toString(8)} and could not be ` +
    `tightened to ${want.toString(8)} (${(err as Error).message}). It holds your ` +
    `financial data — run: chmod ${want.toString(8)} ${target}\n`,
  );
}

/**
 * Create `dir` owner-only (0700) and tighten it if it already exists with
 * looser bits — an install made by an earlier version left it 0755/0775.
 *
 * The leaf is created with the mode in the same syscall, so it is never
 * briefly world-readable; parent directories are created with the default mode
 * because DATA_DIR may legitimately live under a shared path.
 *
 * Best effort on chmod: a directory we do not own warns instead of throwing so
 * that startup paths can call this unconditionally.
 */
export function ensureSecureDir(dir: string): { changed: boolean; previousMode?: number } {
  const parent = path.dirname(dir);
  if (parent && parent !== dir) fs.mkdirSync(parent, { recursive: true });
  try {
    fs.mkdirSync(dir, { mode: DATA_DIR_MODE });
    return { changed: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  return secureExisting(dir, DATA_DIR_MODE);
}

/**
 * Tighten an existing file to 0600. Files SQLite creates for us (the database
 * itself when it predates this version, `-wal`/`-shm`, and `VACUUM INTO`
 * backups) are born 0644; nothing else in the app revisits their mode.
 * Missing files are a no-op — the creator applies the mode instead.
 */
export function secureFile(file: string): { changed: boolean; previousMode?: number } {
  return secureExisting(file, SECRET_FILE_MODE);
}

function secureExisting(target: string, want: number): { changed: boolean; previousMode?: number } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return { changed: false };
  }
  const mode = stat.mode & 0o777;
  if (mode === want) return { changed: false };
  try {
    fs.chmodSync(target, want);
    return { changed: true, previousMode: mode };
  } catch (err) {
    warn(target, mode, want, err);
    return { changed: false, previousMode: mode };
  }
}

/**
 * Create an empty file 0600 if it does not exist yet, so that a program which
 * creates it itself with a laxer mode (SQLite uses 0644) opens ours instead.
 * Returns true when the file was created by this call.
 */
export function touchSecureFile(file: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, 'wx', SECRET_FILE_MODE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  fs.closeSync(fd);
  return true;
}

/**
 * writeFileSync's `mode` only applies when the file is created, so a file first
 * written by an older version keeps its 0644 forever. This writes and then
 * enforces the mode, and is what every writer of DATA_DIR content should use.
 */
export function writeSecretFileSync(file: string, data: string | Buffer): void {
  fs.writeFileSync(file, data, { mode: SECRET_FILE_MODE });
  secureFile(file);
}
