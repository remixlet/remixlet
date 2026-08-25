// Parsing for the two capability names introduced by the network-data
// handoff (wiki/raw/handoffs/network-data-visibility.md §3b).
//
// network:observe:<host-pattern> — a persistent read of the page's own API
// responses on a named host, delivered to the remixlet by the extension's
// MAIN-world interceptor. Same host-pattern grammar as fetch:.
//
// page-world — required by any remixlet script declaring world: "MAIN". A
// MAIN-world script can patch page JS, read secrets from closures/stores, and
// alter app behavior — strictly more power than the sandboxed USER_SCRIPT
// default — so it gets its own named entry in the activation approval instead
// of flipping silently on a manifest field.

import { hostPatternFromRaw } from "./fetch-capability.js";

export const NETWORK_OBSERVE_PREFIX = "network:observe:";

export const PAGE_WORLD_CAPABILITY = "page-world";

export function observeHostPattern(capability: string): string | undefined {
  if (!capability.startsWith(NETWORK_OBSERVE_PREFIX)) return undefined;
  return hostPatternFromRaw(capability.slice(NETWORK_OBSERVE_PREFIX.length));
}
