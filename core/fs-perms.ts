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
 * Re-apply the policy to everything already inside `dir`: every regular file to
 * 0600 and every subdirectory to 0700, at any depth. `dir` itself is left to
 * ensureSecureDir, which is what creates it. Returns the paths it changed.
 *
 * DATA_DIR, not a list of file names, is the unit this policy applies to. The
 * per-name version of the startup tighten fixed .env, fungible.db and the
 * backups and missed everything else the app writes there — `key` (the AES key
 * that decrypts the stored Plaid access tokens), canvas-history.json,
 * canvas-spec.json, gui-window.json and profile.json all stayed 0644 on an
 * upgraded install. A list is only ever as current as the last person who
 * remembered to add to it, and the file it misses is world-readable until
 * someone notices.
 *
 * Symlinks are skipped, not followed: chmod() acts on the link's target, so a
 * link planted in DATA_DIR would aim the chmod at a file outside it. Skipping
 * them also makes the walk cycle-free. Anything that is neither a regular file
 * nor a directory is left alone — the app writes neither.
 *
 * Best effort, like the rest of this module: an entry that cannot be chmodded
 * warns (via secureExisting) and the walk continues, so a startup path can call
 * this unconditionally.
 */
export function secureExistingTree(dir: string): { changed: string[] } {
  const changed: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { changed }; // missing or unreadable — nothing of ours to tighten
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (secureExisting(full, DATA_DIR_MODE).changed) changed.push(full);
      changed.push(...secureExistingTree(full).changed);
    } else if (entry.isFile()) {
      if (secureExisting(full, SECRET_FILE_MODE).changed) changed.push(full);
    }
  }
  return { changed };
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
