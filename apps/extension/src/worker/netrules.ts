// Remixlet-owned declarativeNetRequest dynamic rules. Artifact rule ids are
// local (1..RANGE_SIZE); durable allocations map them into disjoint global
// ranges. The Codex OAuth session-rule id is excluded even though Chrome keeps
// session and dynamic rules in separate stores.

import { dnrActionType, dnrHeaderOperation, getDynamicRules, updateDynamicRules } from "../platform/dnr.js";
import { dnrRegexSubstitutionAvailable } from "../platform/capabilities.js";
import { platformReason } from "../platform/capability-reasons.js";
import { BROWSER_TARGET, ext } from "../platform/ext.js";
import type { RemixletManifest } from "../shared/remixlet.js";
import { manifestDnrDomains } from "../shared/site-key.js";

const ALLOCATIONS_KEY = "remixletDnrAllocations";
const RANGE_SIZE = 1000;
const OAUTH_RULE_ID = 1455001;
const MAX_RULES_PER_REMIXLET = 1000;
const MAX_PRIORITY = 1_000_000;

interface RuleAllocation {
  start: number;
  size: number;
}
type Allocations = Record<string, RuleAllocation>;
type RuleValue = string | number | boolean | null | RuleObject | RuleValue[];
interface RuleObject {
  [key: string]: RuleValue;
}
type NetActionType = "block" | "redirect" | "upgradeScheme" | "modifyHeaders";
type HeaderOperation = "append" | "set" | "remove";

const ACTION_TYPES = new Set(["block", "redirect", "upgradeScheme", "modifyHeaders"]);
const RESOURCE_TYPES = new Set([
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "webtransport",
  "webbundle",
  "other",
]);
const METHODS = new Set(["connect", "delete", "get", "head", "options", "patch", "post", "put"]);
const CONDITION_KEYS = new Set([
  "urlFilter",
  "regexFilter",
  "isUrlFilterCaseSensitive",
  "resourceTypes",
  "excludedResourceTypes",
  "requestDomains",
  "excludedRequestDomains",
  "initiatorDomains",
  "excludedInitiatorDomains",
  "requestMethods",
  "excludedRequestMethods",
  "domainType",
]);
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const DOMAIN_RE = /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i;

export interface ParsedNetRule {
  id: number;
  priority?: number;
  action: RuleObject & { type: NetActionType };
  condition: RuleObject;
}

let reconciliationQueue: Promise<void> = Promise.resolve();

/** Parse and validate before a capability proposal or store commit is made. */
export function validateNetRulesFile(manifest: RemixletManifest, files: Record<string, string>): ParsedNetRule[] {
  if (!manifest.netRules) return [];
  const source = files[manifest.netRules];
  if (source === undefined) throw new Error(`netRules file is missing: ${manifest.netRules}`);

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new Error(`${manifest.netRules} is not valid JSON: ${String(error)}`);
  }
  if (!Array.isArray(value)) throw new Error(`${manifest.netRules}: expected an array of DNR rules`);
  if (value.length > MAX_RULES_PER_REMIXLET) {
    throw new Error(`${manifest.netRules}: at most ${MAX_RULES_PER_REMIXLET} rules are allowed`);
  }

  const ids = new Set<number>();
  return value.map((raw, index) => validateRule(raw, index, ids));
}

export async function reconcileNetRules(
  active: { manifest: RemixletManifest; files: Record<string, string> }[],
  pausedSiteKeys: readonly string[],
  grantedIds: ReadonlySet<string>,
): Promise<void> {
  const run = reconciliationQueue.then(() => reconcileNetRulesNow(active, pausedSiteKeys, grantedIds));
  reconciliationQueue = run.catch(() => {});
  return run;
}

/**
 * Delete-forever's network step. Serialised behind the reconcile queue so no
 * concurrent reconcile can re-allocate the range mid-release. Rules first,
 * then the allocation: the reconciler identifies owned rules THROUGH the
 * allocation map, so releasing the slot before its rules are gone would
 * orphan them where nothing could remove them again. By the time this runs
 * the mirror build has already reconciled without the artifact (its rules are
 * gone); the explicit removal here makes the step correct on its own, so a
 * resumed deletion after a worker death needs no particular order of events.
 */
export async function releaseNetRuleAllocation(remixletId: string): Promise<void> {
  const run = reconciliationQueue.then(async () => {
    const allocations = await readAllocations();
    const allocation = allocations[remixletId];
    if (allocation === undefined) return;
    const owned = (await getDynamicRules())
      .filter((rule) => inRange(rule.id, allocation))
      .map((rule) => rule.id);
    if (owned.length > 0) await updateDynamicRules(owned, []);
    delete allocations[remixletId];
    await ext.storage.local.set({ [ALLOCATIONS_KEY]: allocations });
  });
  reconciliationQueue = run.catch(() => {});
  return run;
}

async function reconcileNetRulesNow(
  active: { manifest: RemixletManifest; files: Record<string, string> }[],
  pausedSiteKeys: readonly string[],
  grantedIds: ReadonlySet<string>,
): Promise<void> {
  const wanted: chrome.declarativeNetRequest.Rule[] = [];
  const allocations = await readAllocations();
  const current = await getDynamicRules();
  const reservedIds = new Set(
    current
      .filter((rule) => !Object.values(allocations).some((allocation) => inRange(rule.id, allocation)))
      .map((rule) => rule.id),
  );

  for (const { manifest, files } of active) {
    if (!manifest.netRules || !grantedIds.has(manifest.id)) continue;
    // A structurally invalid stored artifact must not break reconciliation for
    // every other remixlet — all rules share one updateDynamicRules call, so
    // skip this one and keep going rather than throwing the whole batch.
    let localRules: ParsedNetRule[];
    try {
      localRules = validateNetRulesFile(manifest, files);
    } catch {
      continue;
    }
    const approvedDomains = manifestDnrDomains(manifest.matches);
    const allocation = allocations[manifest.id] ?? allocateRange(allocations, reservedIds);
    allocations[manifest.id] = allocation;
    for (const rule of localRules) {
      // materializeRule confines each rule to the remixlet's own sites and
      // drops (returns undefined for) rules that touch a denied header or
      // redirect off-scope — dropping one offending rule, never the batch.
      const materialized = materializeRule(rule, allocation, pausedSiteKeys, approvedDomains);
      if (materialized !== undefined) wanted.push(materialized);
    }
  }
  await ext.storage.local.set({ [ALLOCATIONS_KEY]: allocations });

  const ownedIds = current
    .filter((rule) => Object.values(allocations).some((allocation) => inRange(rule.id, allocation)))
    .map((rule) => rule.id);
  await updateDynamicRules(ownedIds, wanted);
}

function validateRule(raw: RuleValue, index: number, ids: Set<number>): ParsedNetRule {
  if (!isRecord(raw)) throw new Error(`rules.json[${index}]: rule must be an object`);
  assertOnlyKeys(raw, new Set(["id", "priority", "action", "condition"]), `rules.json[${index}]`);
  const id = positiveInteger(raw.id, `rules.json[${index}].id`);
  if (id > RANGE_SIZE) throw new Error(`rules.json[${index}].id must be <= ${RANGE_SIZE}`);
  if (ids.has(id)) throw new Error(`rules.json: duplicate rule id ${id}`);
  ids.add(id);
  const priority = raw.priority === undefined ? undefined : positiveInteger(raw.priority, `rules.json[${index}].priority`);
  if (priority !== undefined && priority > MAX_PRIORITY) throw new Error(`rules.json[${index}].priority is too large`);
  if (!isRecord(raw.action)) throw new Error(`rules.json[${index}].action must be an object`);
  if (!isRecord(raw.condition)) throw new Error(`rules.json[${index}].condition must be an object`);
  validateAction(raw.action, index);
  validateCondition(raw.condition, index);
  if (!hasActionType(raw.action)) throw new Error(`rules.json[${index}].action.type is not in the safe subset`);
  const rule: ParsedNetRule = { id, action: raw.action, condition: raw.condition };
  if (priority !== undefined) rule.priority = priority;
  return rule;
}

function validateAction(action: RuleObject, index: number): void {
  if (!hasActionType(action)) {
    throw new Error(`rules.json[${index}].action.type is not in the safe subset`);
  }
  const type = action.type;
  const allowed =
    type === "redirect"
      ? new Set(["type", "redirect"])
      : type === "modifyHeaders"
        ? new Set(["type", "requestHeaders", "responseHeaders"])
        : new Set(["type"]);
  assertOnlyKeys(action, allowed, `rules.json[${index}].action`);

  if (type === "redirect") validateRedirect(action.redirect, index);
  if (type === "modifyHeaders") {
    const request = validateHeaders(action.requestHeaders, index, "requestHeaders");
    const response = validateHeaders(action.responseHeaders, index, "responseHeaders");
    if (request + response === 0) throw new Error(`rules.json[${index}]: modifyHeaders needs at least one header operation`);
  }
}

function validateRedirect(value: RuleValue | undefined, index: number): void {
  if (!isRecord(value)) throw new Error(`rules.json[${index}].action.redirect must be an object`);
  assertOnlyKeys(value, new Set(["url", "regexSubstitution"]), `rules.json[${index}].action.redirect`);
  if (Object.keys(value).length !== 1) throw new Error(`rules.json[${index}].action.redirect needs exactly one target`);
  if (value.url !== undefined) assertHttpUrl(value.url, `rules.json[${index}].action.redirect.url`);
  if (value.regexSubstitution !== undefined) {
    if (!dnrRegexSubstitutionAvailable()) {
      throw new Error(
        `rules.json[${index}].action.redirect.regexSubstitution is unavailable — ${platformReason(BROWSER_TARGET, "dnrRegexSubstitution")}`,
      );
    }
    if (
      !isString(value.regexSubstitution) ||
      !/^https?:\/\//i.test(value.regexSubstitution) ||
      value.regexSubstitution.length > 2048
    ) {
      throw new Error(`rules.json[${index}].action.redirect.regexSubstitution must be an http(s) target`);
    }
  }
}

function validateHeaders(value: RuleValue | undefined, index: number, field: string): number {
  if (value === undefined) return 0;
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new Error(`rules.json[${index}].action.${field} must be a non-empty bounded array`);
  }
  for (const [headerIndex, raw] of value.entries()) {
    if (!isRecord(raw)) throw new Error(`rules.json[${index}].action.${field}[${headerIndex}] must be an object`);
    assertOnlyKeys(raw, new Set(["header", "operation", "value"]), `rules.json[${index}].action.${field}[${headerIndex}]`);
    if (!isString(raw.header) || !HEADER_NAME_RE.test(raw.header)) throw new Error(`invalid DNR header name`);
    if (!isHeaderOperation(raw.operation)) throw new Error(`invalid DNR header operation`);
    if (raw.operation === "remove" ? raw.value !== undefined : !isString(raw.value) || raw.value.length > 8192) {
      throw new Error(`invalid DNR header value`);
    }
  }
  return value.length;
}

function validateCondition(condition: RuleObject, index: number): void {
  assertOnlyKeys(condition, CONDITION_KEYS, `rules.json[${index}].condition`);
  if (condition.urlFilter !== undefined && condition.regexFilter !== undefined) {
    throw new Error(`rules.json[${index}].condition cannot combine urlFilter and regexFilter`);
  }
  if (condition.resourceTypes !== undefined && condition.excludedResourceTypes !== undefined) {
    throw new Error(`rules.json[${index}].condition cannot combine resourceTypes and excludedResourceTypes`);
  }
  if (condition.requestMethods !== undefined && condition.excludedRequestMethods !== undefined) {
    throw new Error(`rules.json[${index}].condition cannot combine requestMethods and excludedRequestMethods`);
  }
  for (const key of ["urlFilter", "regexFilter"] as const) {
    const value = condition[key];
    if (value !== undefined && (!isString(value) || value.length === 0 || value.length > 2048 || !isAscii(value))) {
      throw new Error(`rules.json[${index}].condition.${key} must be a bounded ASCII string`);
    }
  }
  if (condition.isUrlFilterCaseSensitive !== undefined && !isBoolean(condition.isUrlFilterCaseSensitive)) {
    throw new Error(`rules.json[${index}].condition.isUrlFilterCaseSensitive must be boolean`);
  }
  validateStringArray(condition.resourceTypes, RESOURCE_TYPES, index, "resourceTypes");
  validateStringArray(condition.excludedResourceTypes, RESOURCE_TYPES, index, "excludedResourceTypes");
  validateStringArray(condition.requestMethods, METHODS, index, "requestMethods");
  validateStringArray(condition.excludedRequestMethods, METHODS, index, "excludedRequestMethods");
  for (const field of ["requestDomains", "excludedRequestDomains", "initiatorDomains", "excludedInitiatorDomains"]) {
    const value = condition[field];
    if (value !== undefined && (!isStringArray(value) || value.length === 0 || !value.every(validDomain))) {
      throw new Error(`rules.json[${index}].condition.${field} contains an invalid domain`);
    }
  }
  if (condition.domainType !== undefined && !["firstParty", "thirdParty"].includes(String(condition.domainType))) {
    throw new Error(`rules.json[${index}].condition.domainType is invalid`);
  }
}

// Headers a DNR rule may never add, set, or remove (C2). Modifying these
// browser-wide strips the site's own protections (CSP/HSTS/X-Frame-Options),
// opens CORS, or forges/steals credentials. Case-insensitive; the starred
// entries in the review are prefix matches (content-security-policy-report-only,
// set-cookie2, every access-control-* header). `refresh` is on the list because
// Blink honors it as a navigation on document responses — an injected
// `Refresh: 0;url=…` is `location` by another name and would bypass
// redirectWithinScope's target confinement entirely.
const DENIED_HEADER_EXACT = new Set([
  "x-frame-options",
  "strict-transport-security",
  "cookie",
  "authorization",
  "proxy-authorization",
  "clear-site-data",
  "location",
  "refresh",
]);
const DENIED_HEADER_PREFIXES = ["content-security-policy", "set-cookie", "access-control-"];

function isDeniedHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return DENIED_HEADER_EXACT.has(lower) || DENIED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function modifiesDeniedHeader(action: RuleObject): boolean {
  for (const field of ["requestHeaders", "responseHeaders"] as const) {
    const list = action[field];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (isRecord(entry) && isString(entry.header) && isDeniedHeaderName(entry.header)) return true;
    }
  }
  return false;
}

/**
 * Whether a redirect action lands somewhere the remixlet is allowed to send
 * the request (C2). The target must be an absolute https URL (no http
 * downgrade, no cleartext exfiltration) whose host resolves to one of the
 * approved domains — or any host when `approvedDomains` is undefined (an
 * all-sites remixlet whose broad scope was approved). A `regexSubstitution`
 * with a backreference or glob in its host cannot be pinned, so it is refused.
 */
function redirectWithinScope(action: RuleObject, approvedDomains: string[] | undefined): boolean {
  const redirect = action.redirect;
  if (!isRecord(redirect)) return false;
  const target = firstString(redirect.url, redirect.regexSubstitution);
  if (target === undefined) return false;
  const match = /^(https?):\/\/([^/\\?#]*)/i.exec(target);
  if (!match) return false; // not an absolute http(s) URL literal
  if (match[1]!.toLowerCase() !== "https") return false; // no downgrade / cleartext
  const hostPort = match[2]!.toLowerCase();
  if (hostPort.length === 0 || hostPort.includes("\\") || hostPort.includes("*") || hostPort.includes("@")) return false;
  const host = hostPort.replace(/:\d+$/, "");
  if (!validDomain(host)) return false;
  if (approvedDomains === undefined) return true;
  return approvedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * Restrict a rule's initiator domains to the remixlet's approved sites: the
 * rule may only act on requests initiated by a page on one of those hosts.
 * An author-supplied `initiatorDomains` is intersected (a domain is kept when
 * it equals or is a subdomain of an approved one); when nothing survives, the
 * rule targets initiators outside its scope entirely and the caller drops it.
 */
function confineInitiators(existing: RuleValue | undefined, approvedDomains: string[]): string[] | undefined {
  const current = asStrings(existing);
  if (current === undefined || current.length === 0) return [...approvedDomains];
  const kept = current.filter((domain) => approvedDomains.some((a) => domain === a || domain.endsWith(`.${a}`)));
  return kept.length > 0 ? kept : undefined;
}

function materializeRule(
  rule: ParsedNetRule,
  allocation: RuleAllocation,
  pausedSiteKeys: readonly string[],
  approvedDomains: string[] | undefined,
): chrome.declarativeNetRequest.Rule | undefined {
  const action = rule.action;
  // Drop rules that touch a denied header or redirect off-scope — never widen.
  if (action.type === "modifyHeaders" && modifiesDeniedHeader(action)) return undefined;
  if (action.type === "redirect" && !redirectWithinScope(action, approvedDomains)) return undefined;

  const condition = { ...rule.condition };
  // Pin the rule to the remixlet's own sites (C2). undefined = an all-sites
  // remixlet whose broad scope was approved, so its rules stay unconfined.
  if (approvedDomains !== undefined) {
    const confined = confineInitiators(condition.initiatorDomains, approvedDomains);
    if (confined === undefined) return undefined;
    condition.initiatorDomains = confined;
  }

  const pausedDomains = pausedSiteKeys.flatMap((key) => key.split("+")).filter((part) => part !== "*" && validDomain(part));
  if (pausedDomains.length > 0) {
    condition.excludedInitiatorDomains = [
      ...new Set([...(asStrings(condition.excludedInitiatorDomains) ?? []), ...pausedDomains]),
    ];
    condition.excludedRequestDomains = [
      ...new Set([...(asStrings(condition.excludedRequestDomains) ?? []), ...pausedDomains]),
    ];
  }
  return {
    id: allocation.start + rule.id - 1,
    priority: rule.priority ?? 1,
    action: materializeAction(rule.action),
    // SAFETY: validateCondition() accepts only the supported RuleCondition fields and values.
    condition: condition as chrome.declarativeNetRequest.RuleCondition,
  };
}

function materializeAction(action: ParsedNetRule["action"]): chrome.declarativeNetRequest.RuleAction {
  if (action.type === "block") return { type: dnrActionType(action.type) };
  if (action.type === "upgradeScheme") return { type: dnrActionType(action.type) };
  if (action.type === "redirect") {
    const redirect = action.redirect;
    if (!isRecord(redirect)) throw new Error("validated redirect action is missing its target");
    if (isString(redirect.url)) return { type: dnrActionType("redirect"), redirect: { url: redirect.url } };
    if (isString(redirect.regexSubstitution)) {
      return { type: dnrActionType("redirect"), redirect: { regexSubstitution: redirect.regexSubstitution } };
    }
    throw new Error("validated redirect action is missing its target");
  }
  return {
    type: dnrActionType("modifyHeaders"),
    requestHeaders: materializeHeaders(action.requestHeaders),
    responseHeaders: materializeHeaders(action.responseHeaders),
  };
}

function materializeHeaders(value: RuleValue | undefined): chrome.declarativeNetRequest.ModifyHeaderInfo[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("validated header list is not an array");
  return value.map((entry) => {
    if (!isRecord(entry) || !isString(entry.header) || !isHeaderOperation(entry.operation)) {
      throw new Error("validated header entry is malformed");
    }
    if (entry.operation === "remove") return { header: entry.header, operation: dnrHeaderOperation(entry.operation) };
    if (!isString(entry.value)) throw new Error("validated header entry is missing a value");
    return {
      header: entry.header,
      operation: dnrHeaderOperation(entry.operation),
      value: entry.value,
    };
  });
}

async function readAllocations(): Promise<Allocations> {
  const stored = await ext.storage.local.get(ALLOCATIONS_KEY);
  const raw = parseAllocations(Object(stored[ALLOCATIONS_KEY]));
  const valid: Allocations = {};
  for (const [id, allocation] of Object.entries(raw)) {
    if (
      Number.isInteger(allocation?.start) &&
      allocation.start >= 1 &&
      allocation.size === RANGE_SIZE &&
      !rangeContains(allocation, OAUTH_RULE_ID) &&
      !Object.values(valid).some((other) => rangesOverlap(allocation, other))
    ) {
      valid[id] = allocation;
    }
  }
  return valid;
}

function allocateRange(allocations: Allocations, reservedIds: ReadonlySet<number>): RuleAllocation {
  for (let slot = 0; ; slot += 1) {
    const candidate = { start: slot * RANGE_SIZE + 1, size: RANGE_SIZE };
    if (rangeContains(candidate, OAUTH_RULE_ID)) continue;
    if ([...reservedIds].some((id) => inRange(id, candidate))) continue;
    if (!Object.values(allocations).some((existing) => rangesOverlap(candidate, existing))) return candidate;
  }
}

function rangesOverlap(a: RuleAllocation, b: RuleAllocation): boolean {
  return a.start <= b.start + b.size - 1 && b.start <= a.start + a.size - 1;
}
function rangeContains(range: RuleAllocation, id: number): boolean {
  return inRange(id, range);
}
function inRange(id: number, range: RuleAllocation): boolean {
  return id >= range.start && id < range.start + range.size;
}
function validateStringArray(value: RuleValue | undefined, allowed: Set<string>, index: number, field: string): void {
  if (value !== undefined && (!isStringArray(value) || value.length === 0 || !value.every((item) => allowed.has(item)))) {
    throw new Error(`rules.json[${index}].condition.${field} is invalid`);
  }
}
function assertOnlyKeys(value: RuleObject, allowed: Set<string>, path: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${path}: unsupported field ${JSON.stringify(unknown)}`);
}
function positiveInteger(value: RuleValue | undefined, path: string): number {
  if (!isPositiveInteger(value)) throw new Error(`${path} must be a positive integer`);
  return value;
}
function assertHttpUrl(value: RuleValue | undefined, path: string): void {
  if (!isString(value) || value.length > 2048) throw new Error(`${path} must be a bounded URL`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${path} is invalid`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${path} must use http or https`);
}
function isRecord(value: RuleValue | undefined): value is RuleObject {
  return Object.prototype.toString.call(value) === "[object Object]";
}
function isString(value: RuleValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}
function isBoolean(value: RuleValue | undefined): value is boolean {
  return Object.prototype.toString.call(value) === "[object Boolean]";
}
function isPositiveInteger(value: RuleValue | undefined): value is number {
  if (Object.prototype.toString.call(value) !== "[object Number]") return false;
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue >= 1;
}
function isStringArray(value: RuleValue | undefined): value is string[] {
  return Array.isArray(value) && value.every(isString);
}
function isHeaderOperation(value: RuleValue | undefined): value is HeaderOperation {
  return value === "append" || value === "set" || value === "remove";
}
function hasActionType(action: RuleObject): action is RuleObject & { type: NetActionType } {
  return isString(action.type) && ACTION_TYPES.has(action.type);
}
function firstString(...values: (RuleValue | undefined)[]): string | undefined {
  return values.find(isString);
}
function isAscii(value: string): boolean {
  return /^[\x20-\x7e]+$/.test(value);
}
function asStrings(value: RuleValue | undefined): string[] | undefined {
  return isStringArray(value) ? value : undefined;
}
function validDomain(value: string): boolean {
  const domain = value.replace(/^\*\./, "");
  return (
    DOMAIN_RE.test(value) &&
    domain.length <= 253 &&
    domain.split(".").every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
  );
}

function parseAllocations(value: RuleValue) {
  if (!isRecord(value)) return {};
  const allocations: Allocations = {};
  for (const [id, allocation] of Object.entries(value)) {
    if (isRecord(allocation) && isPositiveInteger(allocation.start) && allocation.size === RANGE_SIZE) {
      allocations[id] = { start: allocation.start, size: allocation.size };
    }
  }
  return allocations;
}
