// The read gate: no tool reads a tab that is no longer showing the page the
// conversation was pointed at (wiki/design/page-binding.md,
// wiki/ops/2026-09-04-security-remediation-plan.md item 7).
//
// The panel runs the same comparison before it sends (panel/tab-binding.ts),
// which is what puts the recovery card on screen. This is the authoritative
// copy: the panel's record can be stale by exactly the window that matters —
// a navigation that commits between its check and the worker's read — and a
// worker that trusted the panel's verdict would have no gate at all for the
// case the gate exists for.
//
// Checked twice per read, deliberately. BEFORE, so a moved tab is never
// touched. AFTER, so a navigation that commits WHILE the read runs discards
// the result: capture persists to OPFS and every read returns page text to the
// model, and neither may carry bytes from a page nobody pointed the agent at.

import { readPageIdentity } from "../platform/page-identity.js";
import { type BoundPage, type PageVerdict, comparePage, navigationRefusal } from "../shared/page-binding.js";

/**
 * Thrown by the guards below. Carries the site the tab moved TO so callers can
 * tell a refusal apart from an ordinary failure; the message is the
 * model-facing sentence and already says nothing was read.
 */
export class PageMovedError extends Error {
  readonly siteKey: string;
  constructor(verdict: Extract<PageVerdict, { kind: "moved" }>) {
    super(verdict.message);
    this.name = "PageMovedError";
    this.siteKey = verdict.siteKey;
  }
}

/**
 * One check. `expected` undefined means the caller has no binding to hold the
 * read to — the manager's own actions, the harness suites, a restart
 * reconcile — and those are not agent reads; they pass.
 */
export async function checkBoundPage(tabId: number, expected: BoundPage | undefined): Promise<PageVerdict> {
  if (expected === undefined) return { kind: "same-document" };
  const identity = await readPageIdentity(tabId);
  // A tab that has gone entirely is the closed-tab case, which the binding
  // already owns and reports with its own message; nothing to read either way.
  return comparePage(expected, identity ?? {});
}

export async function assertBoundPage(tabId: number, expected: BoundPage | undefined): Promise<void> {
  const verdict = await checkBoundPage(tabId, expected);
  if (verdict.kind === "moved") throw new PageMovedError(verdict);
}

/**
 * Run a read against the bound page, or not at all. The trailing check is what
 * makes the result safe to return and to persist: a tab that moved mid-read
 * throws here, before the caller can hand the bytes on.
 */
/** The navigate tool's destination gate; a caller with no binding may go anywhere. */
export async function assertNavigationWithinSite(url: string, expected: BoundPage | undefined): Promise<void> {
  if (expected === undefined) return;
  const refusal = navigationRefusal(expected, url);
  if (refusal !== undefined) throw new Error(refusal);
}

export async function onBoundPage<T>(tabId: number, expected: BoundPage | undefined, read: () => Promise<T>): Promise<T> {
  await assertBoundPage(tabId, expected);
  const result = await read();
  await assertBoundPage(tabId, expected);
  return result;
}
