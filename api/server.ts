import { config } from 'dotenv';
import { join } from 'node:path';
import { DATA_DIR } from '../core/paths.js';
config({ path: join(DATA_DIR, '.env') });

import { fileURLToPath } from 'node:url';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { initDb } from '../core/db.js';
import { backupDb } from '../core/backup.js';
import { executeTool, TOOL_DEFS } from '../core/tools.js';
import { notifyChange } from '../core/refresh.js';
import { ENV_PATH, checkApiRequest, ensureApiKey } from '../core/api-auth.js';

const DEFAULT_PORT = parseInt(process.env.FUNGIBLE_API_PORT ?? '3456', 10);
const VALID_TOOLS = new Set(TOOL_DEFS.map((t) => t.name));
const MAX_BODY_BYTES = 1024 * 1024;
const HARD_BODY_LIMIT = 16 * MAX_BODY_BYTES;

class BodyTooLarge extends Error {}

function send(res: ServerResponse, status: number, body: object) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(json);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop buffering, but keep draining so the client can read the 413
        // instead of a connection reset — up to a hard ceiling, past which the
        // sender is not worth talking to.
        tooLarge = true;
        chunks.length = 0;
        if (size > HARD_BODY_LIMIT) {
          reject(new BodyTooLarge(`request body exceeds ${MAX_BODY_BYTES} bytes`));
          req.destroy();
        }
        return;
      }
      // Buffer the chunks: decoding each one separately corrupts any multi-byte
      // character that straddles a chunk boundary.
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => {
      if (tooLarge) reject(new BodyTooLarge(`request body exceeds ${MAX_BODY_BYTES} bytes`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

export function startApiServer(port = DEFAULT_PORT, opts: { quiet?: boolean } = {}): Server | undefined {
  let apiKey: string;
  try {
    const resolved = ensureApiKey();
    apiKey = resolved.key;
    if (resolved.generated && !opts.quiet) {
      console.log(`[fungible-api] No FUNGIBLE_API_KEY was set — generated one and saved it to ${ENV_PATH} (mode 0600).`);
    }
  } catch (err) {
    // Fail closed: no key means no API, never an open API.
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[fungible-api] REST API not started: could not establish an API key (${message}). ` +
        `Set FUNGIBLE_API_KEY in ${ENV_PATH} to enable it.`,
    );
    return undefined;
  }

  const server = createServer(async (req, res) => {
    const guard = checkApiRequest(req, apiKey);
    if (!guard.ok) return send(res, guard.status, { error: guard.error });

    if (req.method === 'POST' && req.url === '/notify') {
      notifyChange();
      return send(res, 200, { ok: true });
    }

    const match = req.method === 'POST' && req.url?.match(/^\/tools\/([^/?]+)$/);
    if (!match) return send(res, 404, { error: 'Not found. Use POST /tools/:name' });

    const toolName = match[1];
    if (!VALID_TOOLS.has(toolName)) return send(res, 404, { error: `unknown tool: ${toolName}` });

    let input: Record<string, unknown> = {};
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (err) {
      if (err instanceof BodyTooLarge) return send(res, 413, { error: err.message });
      return send(res, 400, { error: 'could not read request body' });
    }
    if (raw) {
      // A body is only accepted when it was declared as JSON: a browser can send
      // text/plain (or no Content-Type) cross-origin without a preflight.
      if (!guard.jsonBody) {
        return send(res, 415, { error: 'Unsupported Media Type: Content-Type must be application/json' });
      }
      try {
        input = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: 'invalid JSON body' });
      }
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return send(res, 400, { error: 'body must be a JSON object' });
      }
    }

    try {
      const result = await executeTool(toolName, input);
      send(res, 200, { result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send(res, 500, { error: message });
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[fungible-api] port ${port} in use — REST API server not started`);
    }
  });

  const host = process.env.FUNGIBLE_BIND_HOST ?? '127.0.0.1';
  server.listen(port, host, () => {
    if (!opts.quiet) console.log(`[fungible-api] Listening on http://${host}:${port}`);
  });
  return server;
}

// Standalone entrypoint
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await initDb();
  backupDb().catch(() => {});
  startApiServer();
}
