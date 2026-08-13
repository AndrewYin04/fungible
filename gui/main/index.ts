import { join } from 'node:path';
import { homedir } from 'node:os';

// Demo mode must be resolved before core/paths.ts evaluates (it reads
// FUNGIBLE_DATA_DIR at import time), hence the dynamic imports below.
// Same convention as bin/fungible: --demo forces a separate data dir.
if (process.argv.includes('--demo')) process.env.FUNGIBLE_DEMO = '1';
if (process.env.FUNGIBLE_DEMO) {
  process.env.FUNGIBLE_DATA_DIR = join(homedir(), '.fungible-demo');
}

// Dynamic for the same reason: core/env-file.ts reads DATA_DIR at import time.
const { loadEnvFile } = await import('../../core/env-file.js');

// Loads the secrets file and re-tightens it to 0600 if anything loosened it.
loadEnvFile({ quiet: true });

await import('./app.js');
