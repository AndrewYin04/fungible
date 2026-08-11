import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The renderer's reach into the main process, pinned at both ends.
 *
 * The preload is the only thing standing between page JavaScript and every IPC
 * handler the app registers, and `config.writeEnv` is the only handler that
 * turns caller-supplied names into lines in ~/.fungible/.env — the file holding
 * PLAID_SECRET and the LLM API keys. These tests drive the real preload object
 * through the real ipcMain handlers (Electron's own transport replaced by a
 * direct call, everything else is the shipping code) and assert on what a
 * hostile script in the renderer can reach.
 */

const { DATA_DIR, handlers, exposed } = vi.hoisted(() => {
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fungible-ipc-'));
  process.env.FUNGIBLE_DATA_DIR = dir;
  return {
    DATA_DIR: dir,
    handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
    exposed: new Map<string, Record<string, unknown>>(),
  };
});

// A working ipcMain/ipcRenderer pair: `invoke` on the renderer side lands in the
// handler `ipcMain.handle` registered on the main side, exactly as Electron
// would route it, so a call really does run the shipping main-process code.
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
  },
  ipcRenderer: {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No ipcMain handler registered for '${channel}'`);
      return handler({ sender: { isDestroyed: () => false, send: () => {} } }, ...args);
    },
    on: () => {},
    removeListener: () => {},
  },
  contextBridge: {
    exposeInMainWorld: (key: string, value: Record<string, unknown>) => {
      exposed.set(key, value);
    },
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));

const ENV_PATH = path.join(DATA_DIR, '.env');
const OWNER_ENV = 'PLAID_CLIENT_ID=owner-client\nPLAID_SECRET=owner-secret\n';

type Bridge = {
  call: (ns: string, fn: string, args: unknown[]) => Promise<unknown>;
  on: (channel: string, cb: (...args: unknown[]) => void) => () => void;
} & Record<string, unknown>;

async function loadBridge(): Promise<Bridge> {
  const { registerBridge } = await import('../../gui/main/bridge.js');
  registerBridge();
  await import('../../gui/preload/index.js');
  const bridge = exposed.get('__bridge');
  if (!bridge) throw new Error('preload exposed nothing on __bridge');
  return bridge as Bridge;
}

beforeEach(() => {
  fs.writeFileSync(ENV_PATH, OWNER_ENV, { mode: 0o600 });
});

afterAll(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('config.writeEnv is limited to the keys the Configuration panel offers', () => {
  it('refuses a key the panel does not offer, and writes nothing at all', async () => {
    const { registry } = await import('../../gui/main/registry.js');

    await expect(
      registry.config.writeEnv({ ANTHROPIC_BASE_URL: 'http://attacker.example/v1' }),
    ).rejects.toThrow(/ANTHROPIC_BASE_URL/);

    // The point of the refusal: the owner's file is untouched, and nothing
    // repoints the LLM client at a host of someone else's choosing.
    expect(fs.readFileSync(ENV_PATH, 'utf8')).toBe(OWNER_ENV);
  });

  it('refuses a batch containing one unknown key without applying the known ones', async () => {
    const { registry } = await import('../../gui/main/registry.js');

    await expect(
      registry.config.writeEnv({
        PLAID_SECRET: 'attacker-secret',
        FUNGIBLE_BIND_HOST: '0.0.0.0',
      }),
    ).rejects.toThrow(/FUNGIBLE_BIND_HOST/);

    expect(fs.readFileSync(ENV_PATH, 'utf8')).toBe(OWNER_ENV);
  });

  it('still writes the keys the panel does offer', async () => {
    const { registry } = await import('../../gui/main/registry.js');

    const { written } = await registry.config.writeEnv({
      PLAID_SECRET: 'new-secret',
      ANTHROPIC_API_KEY: 'sk-ant-new',
    });

    expect(written.sort()).toEqual(['ANTHROPIC_API_KEY', 'PLAID_SECRET']);
    expect(fs.readFileSync(ENV_PATH, 'utf8')).toBe(
      'PLAID_CLIENT_ID=owner-client\nPLAID_SECRET=new-secret\nANTHROPIC_API_KEY=sk-ant-new\n',
    );
  });

  it('allows exactly the fields the Configuration panel renders — no more, no less', async () => {
    const { WRITABLE_ENV_KEYS } = await import('../../gui/main/registry.js');
    const src = fs.readFileSync(
      path.join(import.meta.dirname, '../../gui/renderer/src/screens/Settings.tsx'),
      'utf8',
    );
    const fields = [...src.matchAll(/\{\s*key:\s*'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]);
    // The Plaid environment is a <select>, not a CONFIG_FIELDS row.
    const offered = new Set([...fields, ...(/payload\['(PLAID_ENV)'\]/.exec(src)?.slice(1) ?? [])]);

    expect(offered.size).toBeGreaterThan(0);
    expect([...WRITABLE_ENV_KEYS].sort()).toEqual([...offered].sort());
  });
});

describe('the preload exposes only the channels the app uses', () => {
  it('gives the renderer no way to invoke an arbitrary IPC channel', async () => {
    const bridge = await loadBridge();

    // A generic invoke(channel, ...args) is a key to every registered handler,
    // including ones no part of the UI calls.
    expect(typeof bridge.invoke).toBe('undefined');

    const reachable = Object.keys(bridge).filter((k) => typeof bridge[k] === 'function');
    expect(reachable.sort()).toEqual(['call', 'on']);
  });

  it('refuses a subscription to a channel the renderer does not listen on', async () => {
    const bridge = await loadBridge();
    expect(() => bridge.on('bridge:call', () => {})).toThrow(/bridge:call/);
  });

  it('still subscribes to the events the app really listens for', async () => {
    const bridge = await loadBridge();
    for (const channel of ['refresh', 'sync-status', 'agent:text', 'agent:tool', 'agent:confirm', 'agent:navigate']) {
      expect(() => bridge.on(channel, () => {})).not.toThrow();
    }
  });

  it('reaches the agent handlers through named methods rather than a raw channel', async () => {
    const bridge = await loadBridge();
    const agent = bridge.agent as Record<string, (...a: unknown[]) => Promise<unknown>>;
    expect(Object.keys(agent).sort()).toEqual(['provider', 'reset', 'respondConfirm', 'run']);

    handlers.set('agent:reset', () => 'reset-ran');
    await expect(agent.reset()).resolves.toBe('reset-ran');
  });
});
