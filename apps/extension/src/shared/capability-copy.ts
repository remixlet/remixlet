// Plain-language, extension-authored copy for a capability — shared by every
// surface that shows one to a human (the panel's permission card and activation
// dialog, and the manager's per-remixlet capability list). Pure module, no
// extension APIs, so both the panel and the control-center bundles can use it
// without pulling agent/panel code across the boundary.
//
// These strings are extension-authored on purpose: capability names arrive from
// a model that has just read untrusted page data, so nothing here may be model
// prose. Raw names (fetch:host, network:observe:host) never render — they mean
// nothing to the person deciding, and the host they'd convey is in the title.
//
// The title is the grant, short enough to scan as a list; the detail is one
// sentence on what it means for the person deciding, written for someone who
// has never heard of a request, a sandbox, or a content script. Table and
// rationale: wiki/design/permission-copy.md.

import { FETCH_CAPABILITY_PREFIX } from "./fetch-capability.js";
import { NETWORK_OBSERVE_PREFIX } from "./observe-capability.js";

export interface CapabilityExplanation {
  title: string;
  detail: string;
}

/**
 * Throws on a name it has no copy for. The chat card filters requests to
 * known names and the write tool refuses unknown ones, so an unknown name
 * here means a stored manifest from a build that supported it — that must
 * fail loudly, never render as a vague grant.
 */
export function capabilityExplanation(capability: string): CapabilityExplanation {
  if (capability.startsWith(NETWORK_OBSERVE_PREFIX)) {
    const host = capability.slice(NETWORK_OBSERVE_PREFIX.length);
    return {
      title: `See what this page loads from ${host}`,
      detail: "The site already downloads this data to show you the page. Allowing this lets the remixlet see it.",
    };
  }
  if (capability.startsWith(FETCH_CAPABILITY_PREFIX)) {
    const host = capability.slice(FETCH_CAPABILITY_PREFIX.length);
    return {
      title: `Send requests to ${host}`,
      detail: "Sent from your browser, so they use your account if you're signed in.",
    };
  }
  if (capability === "storage") {
    return {
      title: "Remember things between visits",
      detail: "Keeps its own data on your computer.",
    };
  }
  if (capability === "netrules") {
    return { title: "Change what pages load", detail: "Blocks, redirects, or alters requests the site makes." };
  }
  if (capability === "notifications") {
    return { title: "Send you notifications", detail: "Allows the remixlet to fire push notifications." };
  }
  if (capability === "clipboard") {
    return { title: "Copy text to your clipboard", detail: "Put text on your clipboard so you can paste it elsewhere." };
  }
  if (capability === "schedule") {
    return {
      title: "Run on a schedule and open tabs",
      detail: "It can run at set times or when you open this site, and bring tabs to the front.",
    };
  }
  if (capability === "menu") {
    return {
      title: "Add an item to the Remixlet menu",
      detail: "Puts a command in the Remixlet toolbar menu that runs when you click it.",
    };
  }
  throw new Error(`no permission copy for capability ${JSON.stringify(capability)}`);
}
