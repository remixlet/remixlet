// The worker's network-id registry and the two network probes' worker halves
// (wiki/design/network-probes.md). list_network_resources answers the worker
// with verbatim URLs; this module registers an id for each endpoint group
// and call, replaces the URLs with the ids, and hands the panel the rest.
// replay_network_resource names an id; this module resolves it to the
// recorded URL and page-load token, injects both as worker-authored params,
// and turns the template's refusals into plain errors. The capture's Data
// endpoints census is the same listing in census mode.
//
// storage.local holds the one registry value: a worker death between two
// probes loses nothing, and the counter keeps growing across page loads,
// worker restarts and browser restarts, so an id is never reused. Every
// read-modify-write is serialised here (MV3 handlers interleave at each
// await; the model batches probes), which is what keeps two concurrent
// listings from minting the same number.

import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { ext } from "../platform/ext.js";
import { NETWORK_CENSUS_MAX_ENDPOINTS, type NetworkCensus, type NetworkEndpointSummary } from "../shared/capture.js";
import {
  NETWORK_IDS_STORAGE_KEY,
  NetworkListingSchema,
  ReplayRefusalSchema,
  ReplayResultSchema,
  assignNetworkIds,
  callKey,
  endpointKey,
  goneNetworkIdMessage,
  normalizeNetworkIdState,
  staleNetworkIdMessage,
  unknownNetworkIdMessage,
  type CallForModel,
  type EndpointForModel,
  type NetworkIdState,
  type NetworkListing,
  type NetworkListingForModel,
  type NetworkRecord,
  type StoredNetworkIdsPayload,
} from "../shared/network-ids.js";
import type { ListNetworkResourcesParamsType, ReplayNetworkResourceParamsType } from "../shared/probe-schemas.js";
import { capProbeValue, runProbeUncapped, type ProbePayload } from "./page-probes/engine.js";

/** Where the registry lives; the default is storage.local, tests pass memory. */
export interface NetworkIdStore {
  read(): Promise<StoredNetworkIdsPayload>;
  write(state: NetworkIdState): Promise<void>;
}

const localStore: NetworkIdStore = {
  async read() {
    return (await ext.storage.local.get(NETWORK_IDS_STORAGE_KEY))[NETWORK_IDS_STORAGE_KEY];
  },
  async write(state) {
    await ext.storage.local.set({ [NETWORK_IDS_STORAGE_KEY]: state });
  },
};

export class NetworkIdRegistry {
  #store: NetworkIdStore;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(store: NetworkIdStore = localStore) {
    this.#store = store;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Ids for the items, in order: existing ones where the key is known, fresh ones otherwise. One storage write. */
  register(items: { key: string; record: NetworkRecord }[]): Promise<string[]> {
    if (items.length === 0) return Promise.resolve([]);
    return this.#enqueue(async () => {
      const state = normalizeNetworkIdState(await this.#store.read());
      const assigned = assignNetworkIds(state, items);
      await this.#store.write(assigned.state);
      return assigned.ids;
    });
  }

  lookup(id: string): Promise<NetworkRecord | undefined> {
    return this.#enqueue(async () => normalizeNetworkIdState(await this.#store.read()).records[id]);
  }
}

export const networkIds = new NetworkIdRegistry();

// ---- the listing: what the template answers, and what the model gets ------

// The template's serialised value, parsed but not yet checked: named so the
// two probe readers below are the one place its contract is decided.
const ProbeReplyPayloadSchema = Type.Unknown();
type ProbeReplyPayload = Static<typeof ProbeReplyPayloadSchema>;

/**
 * Register every listed request and rebuild the listing for the model: ids
 * in, URLs and the page-load token out. The template's other fields pass
 * through unchanged.
 */
export async function registerNetworkListing(
  registry: NetworkIdRegistry,
  listing: NetworkListing,
  recordedAt: number = Date.now(),
): Promise<NetworkListingForModel> {
  const { pageLoad, pageUrl, endpoints = [], calls = [], ...rest } = listing;
  const record = (row: { url: string; host: string; path: string }, kind: NetworkRecord["kind"]): NetworkRecord => ({
    url: row.url,
    pageLoad,
    pageUrl,
    host: row.host,
    path: row.path,
    recordedAt,
    kind,
  });
  const ids = await registry.register([
    ...endpoints.map((row) => ({ key: endpointKey(pageLoad, row.host, row.pattern), record: record(row, "endpoint") })),
    ...calls.map((row) => ({ key: callKey(pageLoad, row.url, row.startTime), record: record(row, "call") })),
  ]);
  // The id leads the row, where the URL used to be the thing to read.
  const forModel: NetworkListingForModel = rest;
  if (listing.endpoints !== undefined) {
    forModel.endpoints = endpoints.map((row, index): EndpointForModel => {
      const { url: _url, pattern: _pattern, ...fields } = row;
      return { id: ids[index] ?? "", ...fields };
    });
  }
  if (listing.calls !== undefined) {
    forModel.calls = calls.map((row, index): CallForModel => {
      const { url: _url, pattern: _pattern, ...fields } = row;
      return { id: ids[endpoints.length + index] ?? "", ...fields };
    });
  }
  return forModel;
}

/** The listing template's value, or undefined when it is not the shape the template writes. */
function parseListing(raw: string): NetworkListing | undefined {
  const value: ProbeReplyPayload = JSON.parse(raw);
  return Check(NetworkListingSchema, value) ? value : undefined;
}

/** list_network_resources through the registry: run, register, strip, cap. */
export async function runListNetworkResources(tabId: number, params: ListNetworkResourcesParamsType): Promise<string> {
  const raw = await runProbeUncapped(tabId, "list_network_resources", params);
  const listing = parseListing(raw);
  if (listing === undefined) throw new Error("list_network_resources: the page answered with a result this build does not read; try again");
  return capProbeValue(JSON.stringify(await registerNetworkListing(networkIds, listing)));
}

// ---- replay -----------------------------------------------------------------

/**
 * replay_network_resource through the registry: resolve the id, run the
 * template with the recorded URL and page-load token as worker-authored
 * params (spread last), and refuse plainly when the id is unknown, from an
 * earlier load, or gone from the timeline.
 */
export async function runReplayNetworkResource(tabId: number, params: ReplayNetworkResourceParamsType): Promise<string> {
  const record = await networkIds.lookup(params.id);
  if (record === undefined) throw new Error(unknownNetworkIdMessage(params.id));
  const payload: ProbePayload = { ...params, url: record.url, pageLoad: record.pageLoad };
  const raw = await runProbeUncapped(tabId, "replay_network_resource", payload);
  const outcome: ProbeReplyPayload = JSON.parse(raw);
  if (Check(ReplayRefusalSchema, outcome)) {
    if (outcome.reason === "stale-id") throw new Error(staleNetworkIdMessage(params.id, record));
    if (outcome.reason === "url-not-recorded") throw new Error(goneNetworkIdMessage(params.id));
    if (outcome.reason === "not-prepared") throw new Error(`${params.id}: the replay was not prepared; nothing was fetched`);
    return capProbeValue(JSON.stringify({ id: params.id, ...outcome }));
  }
  // Ordered so the id leads the reply the way it leads a listing row.
  if (Check(ReplayResultSchema, outcome)) return capProbeValue(JSON.stringify({ id: params.id, ...outcome }));
  return capProbeValue(raw);
}

// ---- the capture's census ---------------------------------------------------

/**
 * Every data endpoint group of the tab's current page load, registered and
 * cut down to the largest NETWORK_CENSUS_MAX_ENDPOINTS for the capture text.
 * `expectedPageLoad` is the token the DOM snapshot read moments earlier:
 * when the census comes from a different document (the page reloaded
 * between the two reads), undefined is returned and the caller says so.
 */
export async function readNetworkCensus(tabId: number, expectedPageLoad: string | undefined): Promise<NetworkCensus | undefined> {
  const raw = await runProbeUncapped(tabId, "list_network_resources", { census: true });
  const listing = parseListing(raw);
  if (listing === undefined) return undefined;
  if (expectedPageLoad !== undefined && listing.pageLoad !== expectedPageLoad) return undefined;
  const forModel = await registerNetworkListing(networkIds, listing);
  const endpoints = (forModel.endpoints ?? [])
    .map(
      (row): NetworkEndpointSummary => ({
        id: row.id,
        host: row.host,
        path: row.path,
        count: row.count,
        bytes: row.bytes,
        sizeSource: row.sizeSource,
        contentType: row.contentType,
        statuses: row.statuses,
        sameSite: row.sameSite,
      }),
    )
    .sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || b.count - a.count);
  return {
    endpoints: endpoints.slice(0, NETWORK_CENSUS_MAX_ENDPOINTS),
    endpointTotal: forModel.endpointTotal ?? endpoints.length,
    requestTotal: forModel.dataTotal,
    bufferPossiblySaturated: forModel.bufferPossiblySaturated,
  };
}
