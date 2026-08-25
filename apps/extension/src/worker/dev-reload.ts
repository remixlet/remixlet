// Dev-only auto-reload: `build.mjs --watch` serves a monotonic build id on
// localhost; we poll it and call runtime.reload() when it changes, so saving a
// file reloads the unpacked extension in whatever browser has it loaded — no
// chrome://extensions clicks. Production builds define the port as 0 and
// esbuild drops the whole branch.

import { ext } from "../platform/ext.js";

declare const __DEV_RELOAD_PORT__: number;

export function installDevReload(): void {
  if (__DEV_RELOAD_PORT__ !== 0) {
    const url = `http://127.0.0.1:${__DEV_RELOAD_PORT__}/build`;
    let known: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const reply = await fetch(url, { cache: "no-store" });
        // SAFETY: the local dev-reload server emits a numeric build id at this fixed endpoint.
        const { id } = (await reply.json()) as { id: number };
        if (known !== undefined && id !== known) {
          console.log("[remixlet] dev rebuild detected — reloading extension");
          ext.runtime.reload();
          return;
        }
        known = id;
        // Extension API calls reset the MV3 idle timer — keeps the worker (and
        // therefore the polling) alive for as long as the dev server is up.
        void ext.runtime.getPlatformInfo();
        setTimeout(() => void poll(), 1000);
      } catch {
        // Watch not running. Back off without touching the idle timer: the
        // worker may sleep, and polling resumes on its next wake.
        setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
  }
}
