// Network ids: the short handles (r1, r2, ...) the model uses for the
// requests a page made, instead of URLs (wiki/design/network-probes.md).
// The worker mints them from one counter that only ever increases and keeps
// every id's verbatim URL in storage, so a replay names an id and the worker
// resolves it; nothing the model sees can be cut off, and no request URL
// (query strings carry session values) rides into the model's context.
//
// This module is the browser-free half: the stored shape, its bound, the
// pure read-modify-write step, and the schemas of what the listing template
// answers. The worker half (worker/network-ids.ts) puts the registry behind
// storage.local and serialises access.

import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

/**
 * The ISOLATED-world global that names one page load. Minted by whichever
 * extension code reads the page first (the capture's snapshot function or
 * probes.js), read by both afterwards: the resource timeline, the snapshot
 * and the token all come from the same document in the same call, so an id
 * belongs to exactly the load that produced it. It dies with the document,
 * which is what makes a stale id detectable inside the page that would fetch.
 */
export const PAGE_LOAD_TOKEN_GLOBAL = "__rmxPageLoad";

/** The world global as the token sees it: one property, owned by the extension. */
interface PageLoadTokenHost {
  __rmxPageLoad?: string;
}

/**
 * The page-load token of the world this code runs in, minted on first use.
 * crypto.getRandomValues rather than randomUUID: the latter needs a secure
 * context and a plain http page is not one.
 */
export function currentPageLoadToken(): string {
  // SAFETY: the token is the one property the extension owns on this world's global; nothing else in the world writes it.
  const host = globalThis as PageLoadTokenHost;
  const existing = host.__rmxPageLoad ?? "";
  if (existing.length > 0) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  host.__rmxPageLoad = token;
  return token;
}

/** storage.local key of the one registry value. */
export const NETWORK_IDS_STORAGE_KEY = "remixletNetworkIds";

/**
 * Records kept, oldest evicted first. A busy page lists at most a few dozen
 * endpoint groups per load plus the individual calls the model asks for;
 * 400 covers many loads and stays well under a megabyte of URLs.
 */
export const NETWORK_IDS_MAX_RECORDS = 400;

/** What an id stands for. Never shown to the model; the worker reads it back at replay. */
const NetworkRecordSchema = Type.Object({
  /** The request URL, verbatim and uncapped. */
  url: Type.String(),
  /** The page-load token of the document that made the request (PAGE_LOAD_TOKEN_GLOBAL). */
  pageLoad: Type.String(),
  /** The page's URL at listing time, for the message a stale id gets. */
  pageUrl: Type.String(),
  /** Host and path pattern, as the model saw them. */
  host: Type.String(),
  path: Type.String(),
  /** ms since epoch when the id was minted or last refreshed. */
  recordedAt: Type.Number(),
  /** One id per endpoint group (newest call) or per individual call. */
  kind: Type.Union([Type.Literal("endpoint"), Type.Literal("call")]),
});
export type NetworkRecord = Static<typeof NetworkRecordSchema>;

export interface NetworkIdState {
  /** The next id number to mint. Only ever grows. */
  next: number;
  /** Ids in minting order, oldest first: the eviction order. */
  order: string[];
  records: Record<string, NetworkRecord>;
  /** Dedupe key (page load + group or call identity) to id, so a re-listed group keeps its id. */
  keys: Record<string, string>;
}

export const EMPTY_NETWORK_ID_STATE: NetworkIdState = { next: 1, order: [], records: {}, keys: {} };

// The unparsed value storage.local hands back for the key, named like the
// script log's payload so the normalizer is the one place its shape is decided.
const StoredNetworkIdsPayloadSchema = Type.Unknown();
export type StoredNetworkIdsPayload = Static<typeof StoredNetworkIdsPayloadSchema>;

const StoredNetworkIdsSchema = Type.Object({
  next: Type.Optional(Type.Integer({ minimum: 1 })),
  order: Type.Optional(Type.Array(Type.String())),
  records: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  keys: Type.Optional(Type.Record(Type.String(), Type.String())),
});

// The counter alone, so a value whose records are unreadable still never rewinds it.
const StoredCounterSchema = Type.Object({ next: Type.Integer({ minimum: 1 }) });

/** Migrate-on-read: anything malformed in storage reads as empty, with the counter kept where it can be. */
export function normalizeNetworkIdState(raw: StoredNetworkIdsPayload): NetworkIdState {
  if (!Check(StoredNetworkIdsSchema, raw)) {
    return { ...EMPTY_NETWORK_ID_STATE, next: Check(StoredCounterSchema, raw) ? raw.next : 1 };
  }
  const records: Record<string, NetworkRecord> = {};
  for (const [id, value] of Object.entries(raw.records ?? {})) {
    if (isNetworkId(id) && Check(NetworkRecordSchema, value)) records[id] = value;
  }
  const order = (raw.order ?? []).filter((id) => id in records);
  for (const id of Object.keys(records)) if (!order.includes(id)) order.push(id);
  const keys: Record<string, string> = {};
  for (const [key, id] of Object.entries(raw.keys ?? {})) if (id in records) keys[key] = id;
  return { next: raw.next ?? 1, order, records, keys };
}

export function isNetworkId(value: string): boolean {
  return /^r[1-9][0-9]*$/.test(value);
}

/** The dedupe key of an endpoint group within one page load. */
export function endpointKey(pageLoad: string, host: string, pathPattern: string): string {
  return `${pageLoad}|e|${host}|${pathPattern}`;
}

/** The dedupe key of one individual call within one page load: the same URL fetched twice is two calls. */
export function callKey(pageLoad: string, url: string, startTime: number): string {
  return `${pageLoad}|c|${startTime}|${url}`;
}

export interface NetworkIdAssignment {
  state: NetworkIdState;
  ids: string[];
}

/**
 * One read-modify-write step: every item gets the id its key already has,
 * or a fresh one from the counter; records are refreshed either way (an
 * endpoint group's newest call moves on as the page fetches more), and the
 * bound is enforced by evicting the oldest ids. Pure: the caller stores the
 * returned state.
 */
export function assignNetworkIds(state: NetworkIdState, items: { key: string; record: NetworkRecord }[]): NetworkIdAssignment {
  const next = { next: state.next, order: [...state.order], records: { ...state.records }, keys: { ...state.keys } };
  const ids: string[] = [];
  for (const { key, record } of items) {
    let id = next.keys[key];
    if (id === undefined || !(id in next.records)) {
      id = `r${next.next}`;
      next.next += 1;
      next.keys[key] = id;
      next.order.push(id);
    }
    next.records[id] = record;
    ids.push(id);
  }
  while (next.order.length > NETWORK_IDS_MAX_RECORDS) {
    const evicted = next.order.shift();
    if (evicted === undefined) break;
    delete next.records[evicted];
    for (const [key, id] of Object.entries(next.keys)) if (id === evicted) delete next.keys[key];
  }
  return { state: next, ids };
}

/** Plain refusals for an id that cannot be replayed. Worker-authored; they never carry page text. */
export function unknownNetworkIdMessage(id: string): string {
  return (
    `${id} is not an id this conversation has seen. Ids come from the capture's Data endpoints section and from ` +
    "list_network_resources; nothing was fetched. Capture the page again and use an id it lists."
  );
}

export function staleNetworkIdMessage(id: string, record: NetworkRecord): string {
  return (
    `${id} belongs to an earlier load of ${record.pageUrl} (recorded ${new Date(record.recordedAt).toISOString()}). ` +
    "The page has loaded again since, so nothing was fetched. Capture the page again and replay an id from that capture."
  );
}

export function goneNetworkIdMessage(id: string): string {
  return (
    `${id} is no longer in this page's resource timeline (the page cleared it), so nothing was fetched. ` +
    "Capture the page again and use an id it lists."
  );
}

// ---- what the listing template answers ---------------------------------------
//
// The worker's view of a list_network_resources result: every endpoint group
// and call carries its verbatim URL and path pattern so the worker can
// register it, and the worker rebuilds the rows for the model with the id
// in their place. The template (worker/page-probes/probes.ts) writes these
// shapes; the worker checks them at the boundary before reading a field.

const SizeSource = Type.Union([Type.Literal("decoded"), Type.Literal("transfer"), Type.Literal("hidden")]);

/** One JSON path a search matched, as the probes' searchJson reports it. */
const SearchHitSchema = Type.Object({
  path: Type.String(),
  value: Type.String(),
  siblings: Type.Optional(Type.Array(Type.String())),
  siblingValues: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export const ListedEndpointSchema = Type.Object({
  url: Type.String(),
  host: Type.String(),
  path: Type.String(),
  /** The path with volatile segments collapsed and no query: the group's identity. */
  pattern: Type.String(),
  count: Type.Number(),
  bytes: Type.Union([Type.Number(), Type.Null()]),
  sizeSource: SizeSource,
  statuses: Type.Array(Type.Number()),
  contentType: Type.Union([Type.String(), Type.Null()]),
  sameSite: Type.Boolean(),
  searchStatus: Type.Optional(Type.Number()),
  matches: Type.Optional(Type.Array(SearchHitSchema)),
  searchError: Type.Optional(Type.String()),
});
export type ListedEndpoint = Static<typeof ListedEndpointSchema>;

export const ListedCallSchema = Type.Object({
  url: Type.String(),
  host: Type.String(),
  path: Type.String(),
  pattern: Type.String(),
  startTime: Type.Number(),
  initiatorType: Type.String(),
  bytes: Type.Union([Type.Number(), Type.Null()]),
  sizeSource: SizeSource,
  contentType: Type.Union([Type.String(), Type.Null()]),
  status: Type.Union([Type.Number(), Type.Null()]),
  sameSite: Type.Boolean(),
});
export type ListedCall = Static<typeof ListedCallSchema>;

const ListedAssetSchema = Type.Object({
  host: Type.String(),
  path: Type.String(),
  initiatorType: Type.String(),
  kind: Type.String(),
  contentType: Type.Union([Type.String(), Type.Null()]),
});

export const NetworkListingSchema = Type.Object({
  pageLoad: Type.String(),
  pageUrl: Type.String(),
  total: Type.Number(),
  dataTotal: Type.Number(),
  entryCount: Type.Number(),
  bufferPossiblySaturated: Type.Boolean(),
  otherByOrigin: Type.Array(Type.Object({ origin: Type.String(), count: Type.Number() })),
  otherTotal: Type.Number(),
  endpoints: Type.Optional(Type.Array(ListedEndpointSchema)),
  endpointTotal: Type.Optional(Type.Number()),
  endpointsTruncated: Type.Optional(Type.Boolean()),
  searched: Type.Optional(Type.Number()),
  searchSkipped: Type.Optional(Type.Number()),
  calls: Type.Optional(Type.Array(ListedCallSchema)),
  callTotal: Type.Optional(Type.Number()),
  callsTruncated: Type.Optional(Type.Boolean()),
  other: Type.Optional(Type.Array(ListedAssetSchema)),
  otherTruncated: Type.Optional(Type.Boolean()),
});
export type NetworkListing = Static<typeof NetworkListingSchema>;

/** An endpoint row as the model reads it: the id where the URL was, no pattern, no token. */
export type EndpointForModel = { id: string } & Omit<ListedEndpoint, "url" | "pattern">;
export type CallForModel = { id: string } & Omit<ListedCall, "url" | "pattern">;
export type NetworkListingForModel = Omit<NetworkListing, "pageLoad" | "pageUrl" | "endpoints" | "calls"> & {
  endpoints?: EndpointForModel[];
  calls?: CallForModel[];
};

/** The template's refusal, before the worker turns it into a plain message. */
export const ReplayRefusalSchema = Type.Object({
  replayed: Type.Literal(false),
  reason: Type.String(),
});

/** A successful replay as the template answers it: host and path pattern, never the URL. */
export const ReplayResultSchema = Type.Object({
  replayed: Type.Literal(true),
  host: Type.String(),
  path: Type.String(),
  status: Type.Number(),
  contentType: Type.Union([Type.String(), Type.Null()]),
  totalChars: Type.Number(),
  truncated: Type.Boolean(),
  outline: Type.Optional(Type.String()),
  matches: Type.Optional(Type.Array(SearchHitSchema)),
  searchError: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
});
