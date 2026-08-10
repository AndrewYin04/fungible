import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';
import { ensureSecureDir, secureFile } from './fs-perms.js';
import { db } from './db.js';

const DB_PATH = path.join(DATA_DIR, 'fungible.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

export async function backupDb(): Promise<void> {
  const keepDays = parseInt(process.env.FUNGIBLE_BACKUP_DAYS ?? '7', 10);
  if (isNaN(keepDays) || keepDays <= 0) return;

  if (!fs.existsSync(DB_PATH)) return;

  // A backup is a full copy of the database — same secrecy as the original.
  // 0700 on the directory also means the 0644 file SQLite creates for
  // `VACUUM INTO` is unreachable by other users in the moment before the
  // chmod below lands.
  ensureSecureDir(DATA_DIR);
  ensureSecureDir(BACKUP_DIR);

  const today = new Date().toISOString().slice(0, 10);
  const backupPath = path.join(BACKUP_DIR, `fungible.${today}.bak`);

  if (!fs.existsSync(backupPath)) {
    await db.execute({ sql: 'VACUUM INTO ?', args: [backupPath] });
    secureFile(backupPath);
  }

  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => /^fungible\.\d{4}-\d{2}-\d{2}\.bak$/.test(f))
    .sort();

  // Backups written by an earlier version are still 0644; tighten them too.
  for (const file of files) secureFile(path.join(BACKUP_DIR, file));

  for (const file of files.slice(0, -keepDays)) {
    fs.unlinkSync(path.join(BACKUP_DIR, file));
  }
}
