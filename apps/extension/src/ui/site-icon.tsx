// Favicon slot for a site key: the snapshotted icon when one is stored, a
// neutral globe otherwise — every site name gets the same 16px slot either
// way. Composite keys (a.com+b.com, from multi-host match patterns) borrow
// the first part that has a snapshot; chats record icons per single host.
//
// Two ways a missing icon gets filled in:
// - List slots (control center, history) pass the preloaded `icons` map.
//   Rendering the globe when that map has loaded means the first capture
//   never landed, so the slot asks the worker for one re-capture
//   (siteIcon.refresh) and swaps the icon in if it arrives.
// - Live slots (the panel's start-here preview and Working-on bar) pass
//   `eager` — no preloaded map, capture starts on first render. With a
//   tab-reported `favIconUrl` at hand the slot records it first
//   (siteIcon.record, which also runs high-res discovery), then reads the
//   stored snapshot back.
// Either way the arriving icon fades in over the globe. One in-flight
// request per site key per document; the worker additionally caps refresh
// attempts per its lifetime.

import { Globe } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

import { send } from "./control-center/send.js";

export function siteIconFor(icons: Record<string, string> | undefined, siteKey: string): string | undefined {
  if (!icons) return undefined;
  if (icons[siteKey]) return icons[siteKey];
  for (const part of siteKey.split("+")) {
    if (icons[part]) return icons[part];
  }
  return undefined;
}

const captureRequests = new Map<string, Promise<string | undefined>>();

function requestCapture(siteKey: string, favIconUrl: string | undefined): Promise<string | undefined> {
  // Keyed on the URL too: a tab that finishes loading mid-capture reports its
  // favicon late, and that better-informed attempt deserves its own request
  // (the worker short-circuits repeats by reported URL, so this stays cheap).
  const requestKey = `${siteKey}\n${favIconUrl ?? ""}`;
  let pending = captureRequests.get(requestKey);
  if (pending === undefined) {
    const recorded =
      favIconUrl === undefined
        ? Promise.resolve()
        : send({ kind: "siteIcon.record", siteKey, favIconUrl }, "siteIcon.recorded").then(
            () => undefined,
            () => undefined,
          );
    pending = recorded
      .then(() => send({ kind: "siteIcon.refresh", siteKey }, "siteIcon.refreshed"))
      .then((reply) => reply.dataUrl)
      .catch(() => undefined);
    captureRequests.set(requestKey, pending);
  }
  return pending;
}

export function SiteIcon({
  icons,
  siteKey,
  favIconUrl,
  eager = false,
  className,
}: {
  icons?: Record<string, string> | undefined;
  siteKey: string;
  /** The tab-reported favicon URL, when a live tab is at hand to ask. */
  favIconUrl?: string;
  /** Capture on first render instead of waiting for the `icons` map to load. */
  eager?: boolean;
  className?: string;
}) {
  const stored = siteIconFor(icons, siteKey);
  // Keyed by site key: live slots swap siteKey in place (the user changes
  // tabs), and a recapture for the previous site must not bleed over.
  const [recaptured, setRecaptured] = useState<{ siteKey: string; dataUrl: string } | undefined>(undefined);
  const missing = stored === undefined && (eager || icons !== undefined);
  useEffect(() => {
    if (!missing) return;
    let cancelled = false;
    void requestCapture(siteKey, favIconUrl).then((dataUrl) => {
      if (!cancelled && dataUrl !== undefined) setRecaptured({ siteKey, dataUrl });
    });
    return () => {
      cancelled = true;
    };
  }, [missing, siteKey, favIconUrl]);
  const src = stored ?? (recaptured?.siteKey === siteKey ? recaptured.dataUrl : undefined);
  if (src === undefined) {
    return <Globe className={cn("size-4 shrink-0 text-muted-foreground/50", className)} aria-hidden />;
  }
  return (
    <img
      src={src}
      alt=""
      className={cn("size-4 shrink-0 rounded-[3px] animate-in fade-in duration-300", className)}
      aria-hidden
    />
  );
}
