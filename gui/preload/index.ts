import { contextBridge, ipcRenderer } from 'electron';

/**
 * Everything the renderer is allowed to reach in the main process.
 *
 * This object is the whole boundary: whatever it exposes, any JavaScript
 * running in the page can call — the app's own screens, but equally a
 * compromised renderer dependency or an injected script. So it names the
 * calls the app makes instead of taking a channel from the caller. A generic
 * `invoke(channel, ...args)` handed the page every handler the main process
 * registers, including `agent:respond-confirm`, which answers the owner's
 * confirmation prompt for an agent write tool without the owner seeing it.
 *
 * The callers are gui/renderer/src/api.ts (`call`), components/ChatDrawer.tsx
 * (`agent`, and the four agent events), hooks/useRefresh.tsx and
 * hooks/useSyncStatus.tsx (`refresh`, `sync-status`).
 */

/** Main→renderer pushes the renderer subscribes to. */
const EVENT_CHANNELS = new Set([
  'refresh',
  'sync-status',
  'agent:text',
  'agent:tool',
  'agent:confirm',
  'agent:navigate',
]);

contextBridge.exposeInMainWorld('__bridge', {
  // The one generic door, and it is gated on the far side: gui/main/bridge.ts
  // resolves ns/fn against the registry with Object.hasOwn and rejects
  // anything it does not find.
  call: (ns: string, fn: string, args: unknown[]) =>
    ipcRenderer.invoke('bridge:call', ns, fn, args),
  agent: {
    provider: () => ipcRenderer.invoke('agent:provider'),
    run: (userMessage: string) => ipcRenderer.invoke('agent:run', userMessage),
    reset: () => ipcRenderer.invoke('agent:reset'),
    respondConfirm: (id: number, yes: boolean) =>
      ipcRenderer.invoke('agent:respond-confirm', id, yes),
  },
  on: (channel: string, cb: (...args: unknown[]) => void) => {
    if (!EVENT_CHANNELS.has(channel)) {
      throw new Error(`Not a renderer event channel: ${channel}`);
    }
    const listener = (_e: unknown, ...args: unknown[]) => cb(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
