// Which unlock does this browser want for the user-script lane, and is it
// open right now? Split out of capabilities.ts because both capabilities.ts
// and script-injector.ts need the answer, and they already depend on each
// other in the other direction.
//
// Three unlocks exist across targets:
//   chrome-toggle   — Chrome 138+: the per-extension "Allow user scripts"
//                     toggle on chrome://extensions/?id=<us>.
//   chrome-dev-mode — Chrome 137 and earlier: no such toggle exists; the API
//                     is gated on Developer mode for the whole browser.
//   permission      — Firefox: an optional MV3 permission, requestable from a
//                     click inside an extension page.
// Safari has no lane at all, hence "unsupported".

import { BROWSER_TARGET, ext } from "./ext.js";
import { CHROME_DEV_MODE_USER_SCRIPTS_REASON, platformReason } from "./capability-reasons.js";

export type UserScriptsSetupKind = "chrome-toggle" | "chrome-dev-mode" | "permission" | "unsupported";

/** First Chrome with the per-extension "Allow user scripts" toggle. */
const CHROME_TOGGLE_VERSION = 138;

/**
 * Chrome 138+: chrome.userScripts is `undefined` until the user flips the
 * per-extension toggle. Pre-138 it exists but throws on property access until
 * Developer Mode is enabled. Probe both; this drives onboarding.
 *
 * Exported for the onboarding poll: availability is decided per JS context at
 * context CREATION, so the poll probes from a freshly created document (an
 * iframe remounted each tick) rather than re-asking one long-lived context —
 * see src/ui/onboarding-probe.ts.
 *
 * NOTE: presence is necessary, not sufficient — a context born while the
 * toggle was on keeps the namespace after it is turned off again, and only a
 * real call reveals that. See ScriptInjector.verifyAvailable().
 */
export function userScriptsUnlocked(): boolean {
  try {
    return ext.userScripts?.getScripts !== undefined;
  } catch {
    return false;
  }
}

export function userScriptsSetupKind(): UserScriptsSetupKind {
  return BROWSER_TARGET === "firefox"
    ? "permission"
    : BROWSER_TARGET === "safari"
      ? "unsupported"
      : chromeUnlockKind();
}

/** The honest "why JavaScript remixlets are off" line for the current unlock. */
export function userScriptsSetupReason(kind: UserScriptsSetupKind = userScriptsSetupKind()): string {
  if (kind === "chrome-dev-mode") return CHROME_DEV_MODE_USER_SCRIPTS_REASON;
  return platformReason(BROWSER_TARGET, "userScripts");
}

/**
 * Chrome 138 replaced "Developer mode unlocks userScripts" with the
 * per-extension toggle, and onboarding has to name the right switch — the two
 * ask for entirely different clicks. The locked states are distinguishable
 * without asking the browser its version: pre-138 leaves the namespace in
 * place and THROWS on property access (Chrome's own documented feature
 * detection), while 138+ leaves it `undefined` (measured on 151 —
 * wiki/design/spike-c-userscripts.md).
 *
 * The version read is the fallback for the cases that probe can't separate —
 * an unlocked browser, or a locked one that returns undefined either way. It
 * is not a capability sniff: the capability itself is always probed above.
 * Whether the browser DRAWS the toggle is a browser-UI fact no API reports,
 * and an unreadable version means the modern UI, which is what every
 * supported Chrome has.
 */
function chromeUnlockKind(): "chrome-toggle" | "chrome-dev-mode" {
  try {
    // Assigned, then used: the read itself is the probe, and a bare
    // expression statement is exactly the shape a minifier may drop.
    const namespace = ext.userScripts;
    void namespace;
  } catch {
    return "chrome-dev-mode";
  }
  const major = chromeMajorVersion();
  return major !== undefined && major < CHROME_TOGGLE_VERSION ? "chrome-dev-mode" : "chrome-toggle";
}

/** Chrome's major version, or undefined where it cannot be read. */
function chromeMajorVersion(): number | undefined {
  // SAFETY: Chromium exposes userAgentData with these fields when the optional API is present.
  const agent = navigator as Navigator & { userAgentData?: { brands?: { brand: string; version: string }[] } };
  const brand = agent.userAgentData?.brands?.find(
    (entry) => entry.brand === "Google Chrome" || entry.brand === "Chromium",
  );
  const branded = brand ? Number.parseInt(brand.version, 10) : Number.NaN;
  if (Number.isFinite(branded)) return branded;
  const match = /Chrom(?:e|ium)\/(\d+)/.exec(agent.userAgent ?? "");
  return match ? Number(match[1]) : undefined;
}
