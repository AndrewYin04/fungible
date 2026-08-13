import { loadEnvFile } from '../core/env-file.js';
// Loads the secrets file and re-tightens it to 0600 if anything loosened it.
loadEnvFile();
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initDb } from '../core/db.js';
import { backupDb } from '../core/backup.js';
import { createMcpServer } from './create-server.js';
import { currentApiKey } from '../core/api-auth.js';

await initDb();
backupDb().catch(() => {});
const apiPort = parseInt(process.env.FUNGIBLE_API_PORT ?? '3456', 10);
const server = createMcpServer({
  afterWrite: () => {
    // The REST API requires a bearer token. Re-read the key on every notify:
    // the TUI may have generated it into ~/.fungible/.env after this stdio
    // process loaded its environment.
    const key = currentApiKey();
    if (!key) return;
    fetch(`http://127.0.0.1:${apiPort}/notify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
    }).catch(() => {});
  },
});


const transport = new StdioServerTransport();
await server.connect(transport);
