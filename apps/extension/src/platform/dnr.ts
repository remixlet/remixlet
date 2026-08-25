// declarativeNetRequest (DNR) wrappers. DNR is the Manifest V3 API for
// declaring network-request rules — here, URL redirects — as data that the
// browser applies itself, without the extension intercepting traffic in JS.
//
// This file exists for two reasons:
//  1. Isolate chrome.* types. Rules are pure data cross-browser, but the
//     @types/chrome surface uses TS enums for the literal fields — the casts
//     live here so product code never touches chrome.* types (wiki/plan.md §1).
//  2. Centralize cross-browser capability checks: DNR is gated to Chrome, and
//     each wrapper degrades explicitly (throw / no-op) where it's unavailable.
//
// Two rule categories are wrapped, each with a distinct consumer:
//  - Session rules (cleared on browser close): temporary OAuth redirect
//    capture during the Codex sign-in flow (worker/codex-auth.ts).
//  - Dynamic rules (persist across restarts): rules.json redirect sync
//    (worker/netrules.ts) and the activation compensating transaction's
//    snapshot/restore rollback (worker/activation.ts).

import { BROWSER_TARGET, ext } from "./ext.js";
import { platformReason } from "./capability-reasons.js";

/** Convert the extension's validated rule-action literals to Chrome's enum API. */
export function dnrActionType(
  value: "block" | "redirect" | "upgradeScheme" | "modifyHeaders",
): chrome.declarativeNetRequest.RuleActionType {
  const actionTypes = {
    block: chrome.declarativeNetRequest.RuleActionType.BLOCK,
    redirect: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
    upgradeScheme: chrome.declarativeNetRequest.RuleActionType.UPGRADE_SCHEME,
    modifyHeaders: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
  } as const;
  return actionTypes[value];
}

/** Convert a validated header operation to Chrome's enum API. */
export function dnrHeaderOperation(value: "append" | "set" | "remove"): chrome.declarativeNetRequest.HeaderOperation {
  const operations = {
    append: chrome.declarativeNetRequest.HeaderOperation.APPEND,
    set: chrome.declarativeNetRequest.HeaderOperation.SET,
    remove: chrome.declarativeNetRequest.HeaderOperation.REMOVE,
  } as const;
  return operations[value];
}

/** Chrome's DNR rewrite is an optimization. Firefox deliberately uses the
 * already-installed webNavigation fallback as its primary OAuth path. */
export function useDnrOAuthRedirect(): boolean {
  return BROWSER_TARGET === "chrome" && "declarativeNetRequest" in ext;
}

/**
 * Install (or replace — same id) a session rule that rewrites main-frame
 * navigations matching `regexFilter` via `regexSubstitution` (\1-style
 * capture references).
 */
export async function setSessionRedirectRule(
  ruleId: number,
  regexFilter: string,
  regexSubstitution: string,
): Promise<void> {
  await ext.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [
      {
        id: ruleId,
        priority: 1,
        condition: {
          regexFilter,
          // SAFETY: "main_frame" is Chrome's documented ResourceType literal.
          resourceTypes: ["main_frame" as chrome.declarativeNetRequest.ResourceType],
        },
        action: {
          // SAFETY: "redirect" is Chrome's documented RuleActionType literal.
          type: "redirect" as chrome.declarativeNetRequest.RuleActionType,
          redirect: { regexSubstitution },
        },
      },
    ],
  });
}

export async function removeSessionRule(ruleId: number): Promise<void> {
  await ext.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
}

export async function getSessionRuleIds(): Promise<number[]> {
  return (await ext.declarativeNetRequest.getSessionRules()).map((rule) => rule.id);
}

/** Replace dynamic rules in one Chrome operation (remove-before-add is atomic). */
export async function updateDynamicRules(
  removeRuleIds: number[],
  addRules: chrome.declarativeNetRequest.Rule[],
): Promise<void> {
  if (removeRuleIds.length === 0 && addRules.length === 0) return;
  if (!("declarativeNetRequest" in ext)) throw new Error(platformReason(BROWSER_TARGET, "dnr"));
  await ext.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

export async function getDynamicRules(): Promise<chrome.declarativeNetRequest.Rule[]> {
  if (!("declarativeNetRequest" in ext)) return [];
  return ext.declarativeNetRequest.getDynamicRules();
}

/** Exact restoration used by the activation compensating transaction. */
export async function replaceDynamicRules(rules: chrome.declarativeNetRequest.Rule[]): Promise<void> {
  const current = await getDynamicRules();
  await updateDynamicRules(
    current.map((rule) => rule.id),
    rules,
  );
}
