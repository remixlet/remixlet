// Parsing for the network:observe:<host-pattern> capability
// (wiki/raw/handoffs/network-data-visibility.md §3b): a persistent read of
// the page's own API responses on a named host, delivered into the box by
// the extension's MAIN-world relay (bridge/relay.ts). Same host-pattern
// grammar as fetch:.

import { hostPatternFromRaw } from "./fetch-capability.js";

export const NETWORK_OBSERVE_PREFIX = "network:observe:";

export function observeHostPattern(capability: string): string | undefined {
  if (!capability.startsWith(NETWORK_OBSERVE_PREFIX)) return undefined;
  return hostPatternFromRaw(capability.slice(NETWORK_OBSERVE_PREFIX.length));
}
