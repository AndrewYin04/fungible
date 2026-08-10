import { join } from 'node:path';
import { DATA_DIR } from '../core/paths.js';
import { loadEnvFile } from '../core/env-file.js';
// Loads the secrets file and re-tightens it to 0600 if anything loosened it.
loadEnvFile({ quiet: true });
import React from 'react';
import { render } from 'ink';
import { writeSecretFileSync } from '../core/fs-perms.js';
import stripAnsi from 'strip-ansi';
import { initDb } from '../core/db.js';
import { backupDb } from '../core/backup.js';
import { syncAll } from '../core/sync.js';
import { setSyncResult } from '../core/sync-status.js';
import { plaidErrorMessage } from '../core/plaid.js';
import { rebuildDisplayNames } from '../core/rename.js';
import { App } from './App.js';
import { Setup } from './Setup.js';
import { startMcpHttpServer } from '../mcp/http.js';
import { startApiServer } from '../api/server.js';

// ── Screen capture ─────────────────────────────────────────────────────────────
const SCREEN_PATH = join(DATA_DIR, 'screen.txt');
let _captureTimer: ReturnType<typeof setTimeout> | undefined;
let _lastChunk = '';
const _origWrite = process.stdout.write.bind(process.stdout);
(process.stdout.write as typeof process.stdout.write) = function (chunk, enc?, cb?) {
  const result = (_origWrite as any)(chunk, enc, cb);
  _lastChunk = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString();
  clearTimeout(_captureTimer);
  _captureTimer = setTimeout(() => {
    const clean = stripAnsi(_lastChunk).trimEnd();
    // screen.txt is a rendering of the owner's balances and transactions.
    if (clean) try { writeSecretFileSync(SCREEN_PATH, clean); } catch { /* ignore */ }
  }, 80);
  return result;
};

const isDemo = process.argv.includes('--demo');

await initDb();
if (!isDemo) backupDb().catch(() => {});

if (process.argv.includes('--setup')) {
  render(<Setup />);
} else {
  if (isDemo) {
    const { seedDemo } = await import('../scripts/seed-demo.js');
    await seedDemo();
  }
  await rebuildDisplayNames();
  if (!isDemo) {
    // Startup sync runs in the background; feed its outcome to the shared store
    // so failures surface (global banner + Accounts badges) instead of vanishing.
    syncAll()
      .then(setSyncResult)
      .catch((err) => setSyncResult([
        { itemId: '', added: 0, modified: 0, removed: 0, dupes: 0, skipped: false, error: plaidErrorMessage(err) },
      ]));
  }

  const mcpPort = parseInt(process.env.FUNGIBLE_MCP_PORT ?? '3741', 10);
  const apiPort = parseInt(process.env.FUNGIBLE_API_PORT ?? '3456', 10);
  startMcpHttpServer(mcpPort);
  startApiServer(apiPort, { quiet: true });

  render(<App />);
}
