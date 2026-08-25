// The panel's opening view — what a fresh chat shows where the transcript
// will be: which page this chat would work on, and one line on what sending
// does. On a page remixlets cannot touch (browser and extension pages) it
// says so instead, and the app uses the same tracked state to keep the
// composer from starting a chat there.
//
// It reads the ACTIVE tab, never the conversation's binding: nothing is bound
// until the first message (tab-binding.ts), and binding from here would tie
// the chat to a page the user merely glanced at. So this is a preview that
// follows the user's tab, and it is replaced by the real "Working on:" bar the
// moment a message binds one.

import { useEffect, useState } from "react";
import { PenLine } from "lucide-react";

import { resolveActiveBrowserTab } from "../platform/active-tab.js";
import { ext } from "../platform/ext.js";
import { siteKeyForUrl } from "../shared/site-key.js";
import { SiteIcon } from "../ui/site-icon.js";

/** What the user's current tab is, as far as a fresh chat is concerned. */
export type ActivePage =
  | { kind: "loading" }
  /** No resolvable browser tab at all (detached popup edge cases). */
  | { kind: "no-tab" }
  /** The active tab is a browser or extension page — remixlets cannot run there. */
  | { kind: "not-web" }
  | { kind: "web"; siteKey: string; favIconUrl?: string };

async function readActivePage(): Promise<ActivePage> {
  const target = await resolveActiveBrowserTab();
  if (!target) return { kind: "no-tab" };
  // Extension pages, chrome://, about: — no site, and nothing to remix.
  if (!/^https?:/.test(target.url)) return { kind: "not-web" };
  const tab = await ext.tabs.get(target.id).catch(() => undefined);
  return { kind: "web", siteKey: siteKeyForUrl(target.url), favIconUrl: tab?.favIconUrl };
}

/** Live view of the active tab, shared by the empty state and the composer gate. */
export function useActivePage(): ActivePage {
  const [page, setPage] = useState<ActivePage>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    function refresh(): void {
      void readActivePage()
        .catch((cause: unknown) => {
          console.error("[remixlet] active page context failed", cause);
          return { kind: "no-tab" } as const;
        })
        .then((next) => {
          if (live) setPage(next);
        });
    }
    refresh();
    // The panel outlives any one page, so this follows the user's tab until a
    // message binds one. Only the active tab's own navigation matters — a
    // background tab finishing a load says nothing about what's in front of us.
    const onActivated = (): void => refresh();
    const onUpdated = (_id: number, change: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab): void => {
      if (tab.active && (change.url !== undefined || change.status === "complete" || change.favIconUrl !== undefined)) {
        refresh();
      }
    };
    ext.tabs.onActivated.addListener(onActivated);
    ext.tabs.onUpdated.addListener(onUpdated);
    return () => {
      live = false;
      ext.tabs.onActivated.removeListener(onActivated);
      ext.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  return page;
}

export function StartHere({ page }: { page: ActivePage }) {
  return (
    // Centred in the empty transcript rather than pinned to its top: the
    // scroller is full-height here, and a small block at the top would leave
    // the same void it exists to fill. `m-auto` does it inside
    // MessageScrollerContent's min-h-full column.
    <div id="chat-empty" className="m-auto flex w-full max-w-[17rem] flex-col gap-3 py-6">
      {page.kind === "web" && (
        <div className="flex items-center gap-2">
          {/* Eager: the panel's extension-page CSP (img-src 'self' data:)
              blocks the tab's live favicon URL outright, so this slot renders
              the worker's data-URL snapshot and kicks off the capture itself
              rather than waiting for a chat to bind. */}
          <SiteIcon eager siteKey={page.siteKey} favIconUrl={page.favIconUrl} className="size-4" />
          <span id="start-here-site" className="min-w-0 truncate text-[15px] leading-5 font-semibold tracking-[-0.01em]">
            {page.siteKey}
          </span>
        </div>
      )}
      {page.kind === "not-web" ? (
        <p id="start-here-blocked" className="text-xs leading-relaxed text-muted-foreground">
          Remixlet can’t change this page — remixlets only work on regular websites. Switch to the site you want to
          change, then start the chat.
        </p>
      ) : (
        <div className="flex flex-col gap-2 text-xs leading-relaxed text-muted-foreground">
          <p>
            Describe a change to this page below, either by writing or using the annotation tool (
            <PenLine className="inline size-3 align-[-1.5px]" aria-hidden />
            ).
          </p>
          <p>
            Remixlet reads the page, writes the change, applies it, and checks that it worked. Every version can be
            reverted, so feel free to play around.
          </p>
          <p>After it’s working you can toggle it on or off using the Remixlet site controls at any time.</p>
        </div>
      )}
    </div>
  );
}
