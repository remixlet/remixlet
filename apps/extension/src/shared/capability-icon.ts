// The list marker for a capability row: one lucide icon per grant, shared by
// every surface that lists grants to a human (the panel's permission card and
// activation dialog, and the website's specimen mirrors it by hand). The
// rows are plain text with no box around them (wiki/design/permission-copy.md,
// "Dialog layout"), so the icon is what makes a row read as one item of a
// list. Keyed on the capability name, like capabilityExplanation, and for the
// same reason: the name is validated before it gets here, and the icon is the
// extension's choice, never the model's.

import { ArrowUpRight, Bell, Clipboard, Clock, Database, Eye, Globe, ListPlus, Route, type LucideIcon } from "lucide-react";

import { FETCH_CAPABILITY_PREFIX } from "./fetch-capability.js";
import { NETWORK_OBSERVE_PREFIX } from "./observe-capability.js";

/** The scope row of the activation dialog: which sites the code runs on. */
export const SCOPE_ICON: LucideIcon = Globe;

/** The dev-observe ask: the same act as network:observe, for this chat only. */
export const DEV_OBSERVE_ICON: LucideIcon = Eye;

export function capabilityIcon(capability: string): LucideIcon {
  if (capability.startsWith(NETWORK_OBSERVE_PREFIX)) return Eye;
  if (capability.startsWith(FETCH_CAPABILITY_PREFIX)) return ArrowUpRight;
  switch (capability) {
    case "storage":
      return Database;
    case "netrules":
      return Route;
    case "notifications":
      return Bell;
    case "clipboard":
      return Clipboard;
    case "schedule":
      return Clock;
    case "menu":
      return ListPlus;
    default:
      throw new Error(`no permission icon for capability ${JSON.stringify(capability)}`);
  }
}
