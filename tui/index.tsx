import { loadEnvFile } from '../core/env-file.js';
// Loads the secrets file and re-tightens it to 0600 if anything loosened it.
loadEnvFile({ quiet: true });
import React from 'react';
import { render } from 'ink';
import { installScreenCapture } from './screen-capture.js';
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
// Mirrors the last rendered frame to DATA_DIR/screen.txt (owner-only) for the
// get_screen tool. See tui/screen-capture.ts.
installScreenCapture();

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
