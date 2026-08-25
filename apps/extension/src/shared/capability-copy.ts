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

import { FETCH_CAPABILITY_PREFIX } from "./fetch-capability.js";
import { NETWORK_OBSERVE_PREFIX, PAGE_WORLD_CAPABILITY } from "./observe-capability.js";

/**
 * `title` is the thing being allowed; `detail` is one sentence on what it means
 * for the person deciding, written for someone who has never heard of a
 * request, a sandbox, or a content script.
 */
export interface CapabilityExplanation {
  title: string;
  detail: string;
}

export function capabilityExplanation(capability: string): CapabilityExplanation {
  if (capability.startsWith(NETWORK_OBSERVE_PREFIX)) {
    const host = capability.slice(NETWORK_OBSERVE_PREFIX.length);
    return {
      title: `Read the data this page loads from ${host}`,
      detail: `The site already downloads this data to show you the page — this just lets the remixlet see its own copy as it arrives. It doesn't change what the site loads or shows.`,
    };
  }
  if (capability.startsWith(FETCH_CAPABILITY_PREFIX)) {
    const host = capability.slice(FETCH_CAPABILITY_PREFIX.length);
    return {
      title: `Act on your account at ${host}`,
      detail: `Send requests to ${host} signed in as you, and read what comes back.`,
    };
  }
  if (capability === PAGE_WORLD_CAPABILITY) {
    return {
      title: "Work inside the page itself",
      detail: "Run alongside the site's own code, where it can read and change what the site is doing behind the scenes.",
    };
  }
  if (capability === "storage") {
    return {
      title: "Remember things between visits",
      detail: "Save this remixlet's own data, like your settings or saved items, so it's still there next time.",
    };
  }
  if (capability === "netrules") {
    // Deliberately scope-neutral ("pages", not "this site"): the same card
    // renders for an all-sites remixlet, where "this site" would contradict
    // the scope card shown right above it. The scope card names the reach;
    // this card names the power.
    return {
      title: "Change what pages load",
      detail: "Block, redirect, or alter requests the page makes — for example to hide something or swap it out.",
    };
  }
  if (capability === "notifications") {
    return { title: "Send you alerts", detail: "Show notifications from your browser or computer." };
  }
  if (capability === "clipboard") {
    return { title: "Copy things for you", detail: "Put text on your clipboard so you can paste it elsewhere." };
  }
  if (capability === "schedule") {
    return {
      title: "Run at set times",
      detail: "Run on a timer, or when you open this site — and it can open browser tabs and bring them to the front.",
    };
  }
  if (capability === "menu") {
    return { title: "Add a menu item", detail: "Add a command to Remixlet’s toolbar menu." };
  }
  return { title: "Use another Remixlet feature", detail: "Use an extra Remixlet feature that needs your permission." };
}
