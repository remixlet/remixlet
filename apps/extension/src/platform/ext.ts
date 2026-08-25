// The WebExtensions namespace seam — the ONLY module allowed to touch the raw
// extension global. Browsers expose the same MV3 extension API under different
// globals: Chrome's `chrome`, Firefox and Safari's promise-based `browser`.
// Everything else imports the normalized `ext` (and the backends in this
// directory) so per-browser differences never leak into product code. See
// wiki/plan.md §1.

export type BrowserTarget = "chrome" | "firefox" | "safari";

declare const __BROWSER_TARGET__: BrowserTarget;

/** Build-time browser target. Prefer runtime capability detection over this. */
export const BROWSER_TARGET = __BROWSER_TARGET__;

/**
 * Firefox (and Safari) expose the promise-based `browser` namespace; Chrome's
 * `chrome` namespace has been promise-capable since MV3. Normalize here.
 */
// SAFETY: browsers expose the promise-compatible WebExtensions namespace at globalThis.browser when it exists.
const browserGlobal = globalThis as { browser?: typeof chrome };
export const ext: typeof chrome = browserGlobal.browser ?? chrome;
