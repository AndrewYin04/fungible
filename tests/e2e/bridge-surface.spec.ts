import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What page JavaScript can reach, asserted from inside a real Electron process.
 *
 * The preload used to expose `invoke(channel, ...args)`, which handed the
 * renderer every IPC channel the main process registers — and `config.writeEnv`
 * took the caller's keys with no allow-list, so anything running in the renderer
 * could rewrite `~/.fungible/.env`, the file holding PLAID_SECRET and the LLM
 * API keys. Pointing ANTHROPIC_BASE_URL at another host redirects the owner's
 * financial context to it. That was F-004 in the audit, rubric class F1.
 *
 * The fix is verified two other ways already: unit tests over `registry`, and
 * driving the main-process handler directly. Neither crosses the contextBridge,
 * and that is the half only a running app can show — contextBridge has to CLONE
 * the exposed object into the renderer, and a nested object of functions is
 * exactly the shape that can arrive with its keys visible and its calls dead.
 * The app would come up looking fine and do nothing.
 *
 * So this suite asks the running renderer what it actually has, and then uses
 * it. It is deliberately about the SHAPE of the surface rather than any one
 * channel: a future `invoke` added back for convenience fails here.
 */

const MAIN_ENTRY = fileURLToPath(new URL('../../out/main/index.js', import.meta.url));

type BridgeWindow = Window & {
  __bridge: {
    call: (ns: string, fn: string, args: unknown[]) => Promise<unknown>;
    agent: Record<string, (...args: unknown[]) => Promise<unknown>>;
    on: (channel: string, cb: (...args: unknown[]) => void) => () => void;
  };
};

let app: ElectronApplication;
let win: Page;
let dataDir: string;

test.beforeEach(async () => {
  // Never the owner's real ~/.fungible. Deliberately not FUNGIBLE_DEMO, which
  // redirects to ~/.fungible-demo and would defeat the isolation.
  dataDir = mkdtempSync(join(tmpdir(), 'fungible-bridge-'));
  app = await electron.launch({
    args: [MAIN_ENTRY],
    env: { ...process.env, FUNGIBLE_DATA_DIR: dataDir, NODE_ENV: 'test' },
  });
  win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
});

test.afterEach(async () => {
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('the preload exposes named calls, not a way to reach every channel', async () => {
  const shape = await win.evaluate(() => {
    const b = (window as unknown as BridgeWindow).__bridge;
    const out: Record<string, string> = {};
    for (const k of Object.keys(b ?? {})) {
      const v = (b as unknown as Record<string, unknown>)[k];
      out[k] =
        typeof v === 'function'
          ? 'function'
          : v && typeof v === 'object'
            ? `object{${Object.keys(v).sort().join(',')}}`
            : typeof v;
    }
    return out;
  });

  expect(
    Object.keys(shape),
    'a generic invoke(channel, ...args) hands the renderer every registered ' +
      'channel; the whole point of this bridge is that it cannot',
  ).not.toContain('invoke');
  expect(shape.call).toBe('function');
  expect(shape.on).toBe('function');
  // Nested object of functions — the contextBridge clone that can fail silently.
  expect(shape.agent).toMatch(/^object\{/);
});

test('the nested agent calls survive the contextBridge clone and actually invoke', async () => {
  // Keys being present is not the property that matters: they can be visible
  // while every call throws. Invoke one for real and require a resolved value.
  const result = await win.evaluate(async () => {
    try {
      const r = await (window as unknown as BridgeWindow).__bridge.agent.provider();
      return { ok: true, type: typeof r };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  expect(result.ok, `agent.provider() threw: ${result.error ?? ''}`).toBe(true);
});

test('writeEnv refuses a key the Configuration panel does not offer', async () => {
  const attempt = (updates: Record<string, string>) =>
    win.evaluate(async (u) => {
      try {
        return { ok: true, r: await (window as unknown as BridgeWindow).__bridge.call('config', 'writeEnv', [u]) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }, updates);

  // Redirects every LLM call, including the owner's financial context.
  const base = await attempt({ ANTHROPIC_BASE_URL: 'http://evil.example' });
  expect(base.ok, 'ANTHROPIC_BASE_URL was accepted').toBe(false);

  // Widens the API listener beyond loopback.
  const bind = await attempt({ FUNGIBLE_BIND_HOST: '0.0.0.0' });
  expect(bind.ok, 'FUNGIBLE_BIND_HOST was accepted').toBe(false);

  // ...while the panel's own fields still work, or the fix has broken the app.
  const legit = await attempt({ PLAID_ENV: 'sandbox' });
  expect(legit.ok, `a legitimate key was refused: ${legit.error ?? ''}`).toBe(true);

  // And the file on disk is the real check — a refusal that still wrote would
  // be the worst of both.
  const envPath = join(dataDir, '.env');
  const env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  expect(env).not.toMatch(/ANTHROPIC_BASE_URL/);
  expect(env).not.toMatch(/FUNGIBLE_BIND_HOST/);
  expect(env).toMatch(/PLAID_ENV/);
});
