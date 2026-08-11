/**
 * DATA_DIR permission policy (core/fs-perms.ts).
 *
 * The database, its backups and the token key hold every transaction, balance
 * and account mask in plaintext. Before this was fixed, core/db.ts created
 * DATA_DIR with `mkdirSync(dir, { recursive: true })` and let SQLite create
 * fungible.db, which lands at 0644 whatever the umask — readable by every other
 * account on the machine. These tests assert the modes, for a fresh install and
 * for an install left behind by an earlier version.
 */
import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DATA_DIR_MODE,
  SECRET_FILE_MODE,
  ensureSecureDir,
  secureExistingTree,
  secureFile,
  touchSecureFile,
  writeSecretFileSync,
} from '../core/fs-perms.js';

const ROOT = path.join(os.tmpdir(), `fungible-perms-${process.pid}-${Date.now()}`);
let caseNo = 0;

/** A fresh throwaway DATA_DIR path (not created). */
function caseDir(name: string): string {
  return path.join(ROOT, `${++caseNo}-${name}`);
}

const modeOf = (p: string) => fs.statSync(p).mode & 0o777;

/** Import core/db.ts and core/backup.ts against `dataDir`. Module-level code in
 *  db.ts is what creates the directory and the file, so each case needs a fresh
 *  module registry. */
async function loadDbModules(dataDir: string) {
  vi.resetModules();
  vi.doMock('../core/paths.js', () => ({ DATA_DIR: dataDir }));
  const { db, initDb } = await import('../core/db.js');
  const { backupDb } = await import('../core/backup.js');
  return { db, initDb, backupDb };
}

beforeEach(() => {
  fs.mkdirSync(ROOT, { recursive: true });
});

afterAll(() => {
  vi.doUnmock('../core/paths.js');
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('fs-perms helpers', () => {
  it('creates a directory 0700 and tightens one that already exists', () => {
    const dir = caseDir('dir');
    ensureSecureDir(dir);
    expect(modeOf(dir)).toBe(DATA_DIR_MODE);

    fs.chmodSync(dir, 0o755);
    expect(ensureSecureDir(dir)).toEqual({ changed: true, previousMode: 0o755 });
    expect(modeOf(dir)).toBe(DATA_DIR_MODE);
  });

  it('creates missing parents without forcing them to 0700', () => {
    const parent = caseDir('parent');
    ensureSecureDir(path.join(parent, 'nested', 'data'));
    expect(modeOf(path.join(parent, 'nested', 'data'))).toBe(DATA_DIR_MODE);
    expect(modeOf(parent) & 0o077).not.toBe(0); // parent keeps the default mode
  });

  it('touchSecureFile creates 0600 and leaves an existing file alone', () => {
    const dir = caseDir('touch');
    ensureSecureDir(dir);
    const file = path.join(dir, 'f');
    expect(touchSecureFile(file)).toBe(true);
    expect(modeOf(file)).toBe(SECRET_FILE_MODE);

    fs.writeFileSync(file, 'existing content');
    expect(touchSecureFile(file)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('existing content');
  });

  it('secureFile tightens 0644 and is a no-op on a missing file', () => {
    const dir = caseDir('secure');
    ensureSecureDir(dir);
    const file = path.join(dir, 'f');
    fs.writeFileSync(file, 'x', { mode: 0o644 });
    expect(secureFile(file)).toEqual({ changed: true, previousMode: 0o644 });
    expect(modeOf(file)).toBe(SECRET_FILE_MODE);
    expect(secureFile(file)).toEqual({ changed: false });
    expect(secureFile(path.join(dir, 'nope'))).toEqual({ changed: false });
  });

  it('writeSecretFileSync enforces 0600 even when the file already exists 0644', () => {
    const dir = caseDir('write');
    ensureSecureDir(dir);
    const file = path.join(dir, 'f');
    fs.writeFileSync(file, 'old', { mode: 0o644 });
    writeSecretFileSync(file, 'new');
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
    expect(modeOf(file)).toBe(SECRET_FILE_MODE);
  });

  it('secureExistingTree tightens files and directories at every depth', () => {
    const dir = caseDir('tree');
    fs.mkdirSync(path.join(dir, 'backups', 'deeper'), { recursive: true });
    const files = ['loose', path.join('backups', 'a.bak'), path.join('backups', 'deeper', 'b')];
    for (const rel of files) fs.writeFileSync(path.join(dir, rel), 'x', { mode: 0o644 });
    for (const rel of files) fs.chmodSync(path.join(dir, rel), 0o644);
    fs.chmodSync(path.join(dir, 'backups', 'deeper'), 0o755);
    fs.chmodSync(path.join(dir, 'backups'), 0o755);

    const { changed } = secureExistingTree(dir);

    for (const rel of files) expect(modeOf(path.join(dir, rel))).toBe(SECRET_FILE_MODE);
    expect(modeOf(path.join(dir, 'backups'))).toBe(DATA_DIR_MODE);
    expect(modeOf(path.join(dir, 'backups', 'deeper'))).toBe(DATA_DIR_MODE);
    expect(changed.length).toBe(5); // three files, two directories
    // Idempotent: a second pass finds nothing left to change.
    expect(secureExistingTree(dir).changed).toEqual([]);
  });

  it('secureExistingTree does not chmod through a symlink', () => {
    const dir = caseDir('tree-symlink');
    ensureSecureDir(dir);
    const outsider = path.join(ROOT, `outsider-${caseNo}`);
    fs.writeFileSync(outsider, 'not ours', { mode: 0o644 });
    fs.chmodSync(outsider, 0o644);
    fs.symlinkSync(outsider, path.join(dir, 'link'));

    secureExistingTree(dir);

    // chmod() acts on the target, so following the link would re-mode a file
    // outside DATA_DIR that the app does not own.
    expect(modeOf(outsider)).toBe(0o644);
  });

  it('secureExistingTree is a no-op on a directory that does not exist', () => {
    expect(secureExistingTree(path.join(ROOT, 'never-created')).changed).toEqual([]);
  });
});

/**
 * Every file the app puts in DATA_DIR, at the mode an install from an earlier
 * version leaves it. The list is derived from the writers, not from whatever the
 * tighten path happens to enumerate — that is the whole point of the case below.
 *
 *   .env                  core/env-file.ts        PLAID_SECRET, LLM keys, FUNGIBLE_API_KEY
 *   fungible.db (+wal/shm) core/db.ts             every transaction, balance and mask
 *   backups/*.bak         core/backup.ts          full copies of the same database
 *   key                   core/crypto.ts          decrypts the stored Plaid access tokens
 *   canvas-history.json   core/canvas-history.ts  saved canvases and the prompts behind them
 *   canvas-spec.json      core/canvas-history.ts  the canvas currently on screen
 *   screen.txt            tui/screen-capture.ts   last rendered frame — balances in the clear
 *   gui-window.json       gui/main/app.ts         window geometry
 *   profile.json          legacy, read by the household migration in core/db.ts
 */
const LEGACY_DATA_DIR_FILES = [
  '.env',
  'fungible.db',
  'fungible.db-wal',
  'fungible.db-shm',
  'key',
  'canvas-history.json',
  'canvas-spec.json',
  'screen.txt',
  'gui-window.json',
  'profile.json',
  path.join('backups', 'fungible.2026-01-03.bak'),
];

/** A DATA_DIR as an older version of the app left it: 0755 dirs, 0644 files. */
function makeLegacyInstall(dir: string): void {
  fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
  for (const rel of LEGACY_DATA_DIR_FILES) {
    fs.writeFileSync(path.join(dir, rel), '');
    fs.chmodSync(path.join(dir, rel), 0o644);
  }
  fs.chmodSync(path.join(dir, 'backups'), 0o755);
  fs.chmodSync(dir, 0o755);
}

describe('startup on an install left world-readable by an earlier version', () => {
  /**
   * Importing core/db.ts IS the startup path — every entry point (tui/index.tsx,
   * api/server.ts, mcp/server.ts, gui/main/app.ts) pulls it in.
   *
   * Before this was fixed the tighten was a hand-maintained list of names, so it
   * fixed .env, fungible.db and the backups and left `key` — the AES key that
   * decrypts the stored Plaid access tokens — plus both canvas files, the GUI
   * window state and profile.json at 0644, readable by every other account on
   * the machine. A list of names is only ever as current as the last person who
   * remembered to add to it.
   */
  it('tightens every file the app owns in DATA_DIR, not a list of names', async () => {
    const dir = caseDir('legacy-install');
    makeLegacyInstall(dir);

    const { initDb } = await loadDbModules(dir);
    await initDb();

    expect(modeOf(dir)).toBe(DATA_DIR_MODE);
    expect(modeOf(path.join(dir, 'backups'))).toBe(DATA_DIR_MODE);

    const stillLoose = LEGACY_DATA_DIR_FILES
      .filter((rel) => fs.existsSync(path.join(dir, rel)))
      .filter((rel) => modeOf(path.join(dir, rel)) !== SECRET_FILE_MODE)
      .map((rel) => `${rel} is ${modeOf(path.join(dir, rel)).toString(8)}`);
    expect(stillLoose).toEqual([]);
  });

  it('tightens a file the app has never heard of, because DATA_DIR is the unit', async () => {
    const dir = caseDir('legacy-unknown');
    makeLegacyInstall(dir);
    const future = path.join(dir, 'some-file-a-later-version-writes.json');
    fs.writeFileSync(future, '{}');
    fs.chmodSync(future, 0o644);

    const { initDb } = await loadDbModules(dir);
    await initDb();

    expect(modeOf(future)).toBe(SECRET_FILE_MODE);
  });
});

describe('core/db.ts', () => {
  it('creates DATA_DIR 0700 and fungible.db 0600 on a fresh install', async () => {
    const dir = caseDir('db-fresh');
    const { initDb } = await loadDbModules(dir);
    await initDb();

    expect(modeOf(dir)).toBe(DATA_DIR_MODE);
    expect(modeOf(path.join(dir, 'fungible.db'))).toBe(SECRET_FILE_MODE);
    for (const sidecar of ['-wal', '-shm', '-journal']) {
      const p = path.join(dir, `fungible.db${sidecar}`);
      if (fs.existsSync(p)) expect(modeOf(p)).toBe(SECRET_FILE_MODE);
    }
  });

  it('tightens a data dir and database left world-readable by an earlier version', async () => {
    const dir = caseDir('db-upgrade');
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o755);
    fs.writeFileSync(path.join(dir, 'fungible.db'), '', { mode: 0o644 });
    fs.chmodSync(path.join(dir, 'fungible.db'), 0o644);

    const { initDb, db } = await loadDbModules(dir);
    await initDb();

    expect(modeOf(dir)).toBe(DATA_DIR_MODE);
    expect(modeOf(path.join(dir, 'fungible.db'))).toBe(SECRET_FILE_MODE);

    // and the pre-existing database is still usable, not clobbered
    await db.execute("INSERT OR IGNORE INTO categories (name) VALUES ('Dining')");
    const { rows } = await db.execute("SELECT name FROM categories WHERE name = 'Dining'");
    expect(rows).toHaveLength(1);
  });
});

describe('core/backup.ts', () => {
  it('writes the daily backup 0600 inside a 0700 backups dir', async () => {
    const dir = caseDir('backup-fresh');
    const { initDb, db, backupDb } = await loadDbModules(dir);
    await initDb();
    await db.execute(
      "INSERT OR IGNORE INTO accounts (id,name,type,mask) VALUES ('a1','Checking','depository','4321')",
    );
    await db.execute(
      "INSERT OR REPLACE INTO transactions (id,account_id,date,name,amount) VALUES ('t1','a1','2026-08-01','PAYCHECK ACME CORP',4210.55)",
    );
    await backupDb();

    const backupDir = path.join(dir, 'backups');
    const today = new Date().toISOString().slice(0, 10);
    const backupPath = path.join(backupDir, `fungible.${today}.bak`);

    expect(modeOf(backupDir)).toBe(DATA_DIR_MODE);
    expect(modeOf(backupPath)).toBe(SECRET_FILE_MODE);
    // the backup really is a plaintext copy — hence the mode
    expect(fs.readFileSync(backupPath).includes(Buffer.from('PAYCHECK ACME CORP'))).toBe(true);
  });

  it('tightens backups and a backups dir left behind by an earlier version', async () => {
    const dir = caseDir('backup-upgrade');
    const { initDb, backupDb } = await loadDbModules(dir);
    await initDb();

    const backupDir = path.join(dir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.chmodSync(backupDir, 0o755);
    const stale = path.join(backupDir, 'fungible.2026-01-03.bak');
    fs.writeFileSync(stale, 'old backup', { mode: 0o644 });
    fs.chmodSync(stale, 0o644);

    await backupDb();

    expect(modeOf(backupDir)).toBe(DATA_DIR_MODE);
    expect(modeOf(stale)).toBe(SECRET_FILE_MODE);
  });
});
