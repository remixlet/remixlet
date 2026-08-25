// Page probing for the agent's verification loops (wiki/handoff.md §7: evaluate_js,
// navigate). Evaluation uses chrome.userScripts.execute — one-shot injection
// of a code string into the USER_SCRIPT world: the same sanctioned sandbox
// remixlet code runs in, no eval in extension contexts.

import { ext } from "../platform/ext.js";
import { scriptInjector } from "../platform/script-injector.js";
import { invalidateCaptureDigestForTab, invalidateCaptureDigestForUrl } from "./capture-freshness.js";

export async function evaluateInPage(tabId: number, code: string): Promise<string> {
  const backend = scriptInjector();
  if (!backend.available) throw new Error(backend.disabledReason);
  // The expression's completion value is serialized in-page so structured
  // results cross the boundary as JSON text.
  const wrapped = `(async () => {
    try {
      const __value = await (async () => (${code}))();
      return JSON.stringify({ ok: true, value: __value === undefined ? "undefined" : JSON.stringify(__value) });
    } catch (error) {
      return JSON.stringify({ ok: false, message: String(error) });
    }
  })()`;
  const [injection] = await backend.execute(tabId, wrapped);
  if (injection?.error) throw new Error(injection.error);
  // SAFETY: evaluateInPage serializes this exact discriminated reply with JSON.stringify before injection returns it.
  const outcome = JSON.parse(String(injection?.result)) as { ok: boolean; value?: string; message?: string };
  if (!outcome.ok) throw new Error(outcome.message ?? "evaluation failed");
  return outcome.value ?? "undefined";
}

export async function navigateTab(tabId: number, url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`navigate: only http(s) URLs are allowed (got ${parsed.protocol})`);
  }
  // Both the page being left and the page being loaded stop matching their
  // stored capture digests; cleared BEFORE the navigation starts so the
  // capture that follows is deterministically a full one (capture-freshness).
  await invalidateCaptureDigestForTab(tabId);
  await invalidateCaptureDigestForUrl(parsed.href);
  await ext.tabs.update(tabId, { url });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const tab = await ext.tabs.get(tabId);
    if (tab.status === "complete" && tab.url && new URL(tab.url).href.startsWith(parsed.origin)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`navigate: ${url} did not finish loading within 20s`);
}
