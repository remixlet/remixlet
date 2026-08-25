// CSS injection (wiki/handoff.md §5): the userScripts API is JS-only, so remixlet CSS
// is inserted as strings on every top-frame navigation, read fresh from the
// mirror each time. That freshness is the defense against the field-tested
// stale-CSS pitfall: nothing ever caches CSS content at registration time —
// a CSS-only update changes the mirror, the pipeline reloads the tab once,
// and this listener injects the new strings on that load. (Regression-tested
// in the activation suite.)
//
// Tabs that are NOT reloaded keep their old CSS until their next navigation —
// the M3 per-site pause/disable UI reloads affected tabs for the same reason.
//
// Client-side navigations (history.pushState) never fire onCommitted, so this
// also listens to onHistoryStateUpdated/onReferenceFragmentUpdated and keeps
// CSS congruent with the manifest matches in BOTH directions: inserted when
// the URL enters them, removed when it leaves (a hard navigation achieves
// both by dropping the document). What was actually inserted per tab lives in
// storage.session — reconstructible state only; losing it merely risks a
// duplicate insert of identical rules.

import { ext } from "../platform/ext.js";
import { matchesPaused, urlMatchesAny, urlPaused } from "../shared/site-key.js";
import { readMirror } from "./injection.js";
import { readPausedSites } from "./site-pause.js";

const CSS_STATE_PREFIX = "cssInjected:";

/** Exactly what was inserted, so removal cannot miss a since-updated mirror. */
interface InjectedCssEntry {
  id: string;
  css: string;
}

// webNavigation events for one tab can interleave; serialize the read-
// modify-write of the per-tab state (same tail-promise shape activation uses).
let cssMutationTail: Promise<void> = Promise.resolve();

function enqueue(operation: () => Promise<void>): void {
  cssMutationTail = cssMutationTail.then(operation, operation);
}

export function installCssInjection(): void {
  ext.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    enqueue(() => syncCssForTab(details.tabId, details.url, { freshDocument: true }));
  });
  const onSameDocumentNavigation = (details: { frameId: number; tabId: number; url: string }) => {
    if (details.frameId !== 0) return;
    enqueue(() => syncCssForTab(details.tabId, details.url, { freshDocument: false }));
  };
  ext.webNavigation.onHistoryStateUpdated.addListener(onSameDocumentNavigation);
  ext.webNavigation.onReferenceFragmentUpdated.addListener(onSameDocumentNavigation);
  ext.tabs.onRemoved.addListener((tabId) => {
    enqueue(() => ext.storage.session.remove(CSS_STATE_PREFIX + tabId));
  });
}

async function syncCssForTab(tabId: number, url: string, options: { freshDocument: boolean }): Promise<void> {
  try {
    const stateKey = CSS_STATE_PREFIX + tabId;
    // A committed navigation replaced the document — whatever was inserted
    // died with it.
    const injected = options.freshDocument ? [] : await readInjectedCss(stateKey);
    const pausedSites = await readPausedSites();
    const paused = urlPaused(url, pausedSites);
    const next: InjectedCssEntry[] = [];
    const mirror = await readMirror();
    for (const remixlet of mirror) {
      if (remixlet.css.length === 0) continue;
      const has = injected.find((entry) => entry.id === remixlet.id);
      // Two pause rules, same pair the registration path applies: this site is
      // paused, or a pause elsewhere owns this remixlet outright (a remixlet
      // spanning several hosts pauses on all of them, not just the host the
      // pause was authored from).
      // A skewed remixlet (builtWith outside the supported bridge range) never
      // wants its CSS either — none of its code runs, and half of a broken
      // feature styling the page would be worse than nothing.
      const wants =
        remixlet.skew === undefined &&
        !paused &&
        !matchesPaused(remixlet.matches, pausedSites) &&
        urlMatchesAny(url, remixlet.matches);
      if (wants && !has) {
        const css = remixlet.css.join("\n");
        await ext.scripting.insertCSS({ target: { tabId }, origin: "AUTHOR", css });
        next.push({ id: remixlet.id, css });
      } else if (!wants && has) {
        await ext.scripting.removeCSS({ target: { tabId }, origin: "AUTHOR", css: has.css }).catch(() => {});
      } else if (has) {
        next.push(has);
      }
    }
    // CSS whose remixlet left the mirror sheds on this navigation, the same
    // way a hard navigation would shed it with the document.
    for (const orphan of injected.filter((entry) => !mirror.some((remixlet) => remixlet.id === entry.id))) {
      await ext.scripting.removeCSS({ target: { tabId }, origin: "AUTHOR", css: orphan.css }).catch(() => {});
    }
    if (next.length > 0) await ext.storage.session.set({ [stateKey]: next });
    else await ext.storage.session.remove(stateKey);
  } catch (error) {
    // Expected on pages we can't touch (chrome://, the web store).
    console.debug(`[remixlet] css injection skipped for ${url}: ${String(error)}`);
  }
}

async function readInjectedCss(stateKey: string): Promise<InjectedCssEntry[]> {
  const stored = await ext.storage.session.get(stateKey);
  // SAFETY: this module writes this session key exclusively with InjectedCssEntry arrays.
  return (stored[stateKey] as InjectedCssEntry[] | undefined) ?? [];
}
