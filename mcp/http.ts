import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './create-server.js';
import { ENV_PATH, checkApiRequest, ensureApiKey } from '../core/api-auth.js';

/**
 * The MCP transport is a SECOND DOOR onto the same 32 tools.
 *
 * The REST API on :3456 was made fail-closed — bearer token, loopback Host,
 * Origin/Sec-Fetch-Site, JSON-only bodies. This server runs in the SAME process,
 * exposes the SAME tools, and had none of it. Every one of those checks was
 * bypassed simply by using port 3741 instead of 3456: an unauthenticated read of
 * the owner's net worth, and a persisted write that recategorised five
 * transactions, both under `Host: evil.example.com`.
 *
 * Fixing one door and leaving the other open fixes nothing, so this applies the
 * identical guard. An MCP client on this transport must now present the same
 * bearer token the REST API uses (it is in ~/.fungible/.env, mode 0600); the
 * stdio transport is unaffected, because a process that can exec the binary
 * already has whatever this would protect.
 */
export function startMcpHttpServer(port: number): void {
  let apiKey: string;
  try {
    apiKey = ensureApiKey().key;
  } catch (err) {
    // Fail closed, exactly as the REST API does: no key means no listener.
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[fungible-mcp] HTTP transport not started: could not establish an API key (${message}). ` +
        `Set FUNGIBLE_API_KEY in ${ENV_PATH} to enable it. The stdio transport is unaffected.`,
    );
    return;
  }

  const httpServer = createServer(async (req, res) => {
    const guard = checkApiRequest(req, apiKey);
    if (!guard.ok) {
      res.writeHead(guard.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: guard.error }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    let body: unknown;
    if (raw) {
      try { body = JSON.parse(raw); } catch { /* let transport handle malformed JSON */ }
    }

    // Stateless: new server+transport per request so no session state is needed
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[fungible-mcp] port ${port} in use — HTTP MCP server not started`);
    }
  });

  httpServer.listen(port, process.env.FUNGIBLE_BIND_HOST ?? '127.0.0.1');
}
