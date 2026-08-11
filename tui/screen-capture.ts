import { join } from 'node:path';
import stripAnsi from 'strip-ansi';
import { DATA_DIR } from '../core/paths.js';
import { secureFile, writeSecretFileSync } from '../core/fs-perms.js';

/**
 * Screen capture: the TUI mirrors the last frame it rendered to
 * DATA_DIR/screen.txt so the `get_screen` tool (core/tools.ts) can tell the
 * agent what the owner is looking at.
 *
 * That frame is a verbatim render of the owner's accounts, balances and
 * transactions, and mcp/create-server.ts exposes get_screen over the local MCP
 * HTTP server, so the file follows the same rule as the rest of DATA_DIR:
 * owner-only, 0600 (core/fs-perms.ts). Anything a screen renders in the clear
 * ends up in this file and is readable through that tool, so credentials must
 * be masked at the point they are rendered — see tui/Setup.tsx.
 */

export const SCREEN_PATH = join(DATA_DIR, 'screen.txt');

/** How quiet the terminal has to go before the last chunk counts as a frame. */
export const CAPTURE_DEBOUNCE_MS = 80;

/**
 * Persist one rendered frame at 0600. Chunks that are pure terminal control
 * sequences strip down to nothing and are not captured — they are not frames.
 */
export function captureFrame(chunk: string): void {
  const clean = stripAnsi(chunk).trimEnd();
  if (!clean) return;
  try {
    writeSecretFileSync(SCREEN_PATH, clean);
  } catch {
    /* capture is best effort — never take the TUI down over it */
  }
}

/**
 * Wrap `stdout.write` so the last chunk written before the terminal goes quiet
 * is mirrored to SCREEN_PATH. Returns a function that cancels any pending
 * capture and restores the original write.
 */
export function installScreenCapture(
  stdout: NodeJS.WriteStream = process.stdout,
): () => void {
  // A screen.txt written before this policy existed keeps its old mode
  // forever otherwise: writeSecretFileSync only tightens the file when a new
  // frame is captured, and a frame may never come (the app can be launched and
  // quit, or run a build of ink that never leaves a plain frame as the last
  // chunk), while the stale render of the owner's balances stays on disk.
  secureFile(SCREEN_PATH);

  const origWrite = stdout.write.bind(stdout) as (
    chunk: unknown, enc?: unknown, cb?: unknown,
  ) => boolean;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastChunk = '';

  const patched = function (chunk: unknown, enc?: unknown, cb?: unknown): boolean {
    const result = origWrite(chunk, enc, cb);
    lastChunk = typeof chunk === 'string' ? chunk : String(chunk);
    clearTimeout(timer);
    timer = setTimeout(() => captureFrame(lastChunk), CAPTURE_DEBOUNCE_MS);
    return result;
  } as typeof stdout.write;

  stdout.write = patched;

  return () => {
    clearTimeout(timer);
    if (stdout.write === patched) {
      stdout.write = origWrite as typeof stdout.write;
    }
  };
}
