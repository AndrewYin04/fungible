import type { fullRegistry } from '../main/bridge.js';

type AsyncFn<F> = F extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : never;

export type RendererApi = {
  [N in keyof typeof fullRegistry]: {
    [K in keyof (typeof fullRegistry)[N]]: AsyncFn<(typeof fullRegistry)[N][K]>;
  };
};

export type Bridge = {
  call: (ns: string, fn: string, args: unknown[]) => Promise<unknown>;
  /** The agent chat channels, named. The preload takes no channel from the
   *  renderer, so this list is the renderer's whole reach into agent-ipc.ts. */
  agent: {
    provider: () => Promise<unknown>;
    run: (userMessage: string) => Promise<unknown>;
    reset: () => Promise<unknown>;
    respondConfirm: (id: number, yes: boolean) => Promise<unknown>;
  };
  /** Only the main→renderer event channels listed in gui/preload/index.ts;
   *  any other name throws. */
  on: (channel: string, cb: (...args: unknown[]) => void) => () => void;
};
