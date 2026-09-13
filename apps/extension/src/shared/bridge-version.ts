// The rmx bridge contract version. Pure module, no extension APIs — it lives
// in shared/ because every layer that handles the version may import shared/
// and nothing else in common: shared/remixlet.ts validates the manifest stamp,
// the write tool (panel/tools) authors it, the worker's mirror build compares
// it against the running bridge, and box/runtime.ts is the contract it
// describes (that module's header states the change discipline).

/**
 * The rmx.* contract version this build of the extension provides. Version 2
 * is the box (wiki/design/mediated-execution.md) with the mark rule
 * (wiki/decisions/leftover-marks.md): remixlet code runs in a sandboxed
 * extension page, reaches the document only through the async `dom` API, and
 * every attribute or class it writes on the page's own elements carries its
 * prefix. Version 2 narrowed what the `dom` API grants rather than adding to
 * it (wiki/ops/2026-09-12-security-review-plan.md, F2): a `network:observe:`
 * grant no longer admits a URL, an off-site image or link URL must be one the
 * page already loads exactly as written rather than merely on a host it loads
 * from, and a password field's value is never read back. Pre-launch there is
 * one version and no history: a breaking change before launch renumbers
 * nothing but bumps this so stored dev artifacts surface as needs-repair;
 * after launch a bump is a decision record
 * (wiki/decisions/launch-backwards-compatibility.md).
 */
export const RMX_BRIDGE_VERSION = 2;

/**
 * The oldest builtWith.bridge stamp this build still runs. Raised only when a
 * breaking bridge change truly cannot serve old remixlets; an artifact below
 * it is quarantined by the mirror build and surfaces as needs-repair.
 */
export const RMX_BRIDGE_MIN_SUPPORTED = 2;

/**
 * The manifest's record of what the remixlet was built against. Extension-
 * authored at write time (write_remixlet overwrites whatever the model sent),
 * so it can be neither forgotten nor faked. Deliberately an object, not a
 * bare number: future contracts (e.g. the probe shapes) can add their own
 * fields without a manifest migration.
 */
export interface RemixletBuiltWith {
  /** RMX_BRIDGE_VERSION at the moment the artifact was written. */
  bridge: number;
  /**
   * The extension's release version (manifest.json "version") that wrote the
   * artifact. Traceability only — it links a stored remixlet back to the
   * exact release whose system prompt, tools, and bridge produced it. It is
   * NEVER a compatibility input: releases almost always keep the bridge
   * contract (additive-only), so deciding skew from a release number would
   * need a separately-maintained list of which releases broke the contract —
   * the artifact most likely to rot. bridgeSkewReason() ignores this field.
   */
  extension?: string;
}

/**
 * Why a remixlet must not run against this bridge, or undefined when it can.
 * Running skewed code would fail in undefined ways on the user's page (calls
 * into methods that no longer exist or now behave differently), so the caller
 * routes a non-undefined reason into the needs-repair treatment instead of
 * injecting. The stamp is written on every save, so a manifest without one
 * was written before the box existed and is refused outright.
 */
export function bridgeSkewReason(builtWith: RemixletBuiltWith | undefined): string | undefined {
  if (builtWith === undefined) {
    return `carries no rmx bridge stamp, so it predates the box (this extension provides v${RMX_BRIDGE_VERSION})`;
  }
  const built = builtWith.bridge;
  if (built > RMX_BRIDGE_VERSION) {
    return `built against rmx bridge v${built}, but this extension provides v${RMX_BRIDGE_VERSION}`;
  }
  if (built < RMX_BRIDGE_MIN_SUPPORTED) {
    return `built against rmx bridge v${built}, which this extension no longer supports (minimum v${RMX_BRIDGE_MIN_SUPPORTED})`;
  }
  return undefined;
}
