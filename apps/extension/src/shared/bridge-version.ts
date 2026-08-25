// The rmx bridge contract version. Pure module, no extension APIs — it lives
// in shared/ because every layer that handles the version may import shared/
// and nothing else in common: shared/remixlet.ts validates the manifest stamp,
// the write tool (panel/tools) authors it, the worker's mirror build compares
// it against the running bridge, and bridge/rmx.ts is the contract it
// describes (that module's header states the change discipline).

/** The rmx.* contract version this build of the extension provides. */
export const RMX_BRIDGE_VERSION = 1;

/**
 * The oldest builtWith.bridge stamp this build still runs. Raised only when a
 * breaking bridge change truly cannot serve old remixlets. Today it equals
 * RMX_BRIDGE_VERSION, so no stored remixlet can actually be skewed — the
 * detection below exists NOW so the first breaking change finds it already
 * wired and tested instead of shipping the hazard and the guard together.
 */
export const RMX_BRIDGE_MIN_SUPPORTED = 1;

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
 * injecting. A manifest without the stamp predates it; every bridge that
 * existed then was version 1, so absence reads as 1 and needs no migration.
 */
export function bridgeSkewReason(builtWith: RemixletBuiltWith | undefined): string | undefined {
  const built = builtWith?.bridge ?? 1;
  if (built > RMX_BRIDGE_VERSION) {
    return `built against rmx bridge v${built}, but this extension provides v${RMX_BRIDGE_VERSION}`;
  }
  if (built < RMX_BRIDGE_MIN_SUPPORTED) {
    return `built against rmx bridge v${built}, which this extension no longer supports (minimum v${RMX_BRIDGE_MIN_SUPPORTED})`;
  }
  return undefined;
}
