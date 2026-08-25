// Sidecar conversation index (wiki/handoff.md §8): Remixlet metadata about each
// conversation — site key, title, linked remixlets — kept OUTSIDE the pi
// JSONL (which stays pure pi format). One JSON file; the worker is the only
// writer (single-writer rule), so upserts from concurrent panels serialize
// through the worker's message queue.
//
// Site keys here use the SAME derivation as remixlet matches and captures
// (src/shared/site-key.ts) — that agreement is what groups the history menu
// by site exactly as the manager does.
//
// Store code is extension-API-free by convention.

import { isFsError, OpfsFs } from "./opfs-fs.js";

export interface ConversationMeta {
  id: string;
  /** Provisional (active tab at first prompt) until a remixlet write pins it. */
  siteKey: string;
  title: string;
  /** Remixlet ids this conversation has written — the refine trail. */
  remixletIds: string[];
  updatedAt: number;
}

const INDEX_PATH = "sessions/index.json";

export class ConversationIndex {
  readonly #fs: OpfsFs;

  constructor(fs: OpfsFs = new OpfsFs()) {
    this.#fs = fs;
  }

  /** Newest first — the shape the history menu wants. */
  async list(): Promise<ConversationMeta[]> {
    const entries = await this.#read();
    return [...entries.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Merge-upsert: omitted fields keep their stored values; remixletIds are
   * unioned (a conversation never un-touches a remixlet).
   */
  async upsert(meta: { id: string } & Partial<Omit<ConversationMeta, "id">>): Promise<ConversationMeta> {
    const entries = await this.#read();
    const previous = entries.get(meta.id);
    const merged: ConversationMeta = {
      id: meta.id,
      siteKey: meta.siteKey ?? previous?.siteKey ?? "",
      title: meta.title ?? previous?.title ?? "",
      remixletIds: [...new Set([...(previous?.remixletIds ?? []), ...(meta.remixletIds ?? [])])],
      updatedAt: meta.updatedAt ?? Date.now(),
    };
    entries.set(meta.id, merged);
    await this.#fs.promises.writeFile(INDEX_PATH, JSON.stringify([...entries.values()]));
    return merged;
  }

  async #read(): Promise<Map<string, ConversationMeta>> {
    let raw: string;
    try {
      // SAFETY: the utf8 overload of the OPFS facade always returns a string.
      raw = (await this.#fs.promises.readFile(INDEX_PATH, "utf8")) as string;
    } catch (error) {
      if (isFsError(error, "ENOENT")) return new Map();
      throw error;
    }
    try {
      // SAFETY: this worker is the only index writer and serializes ConversationMeta entries above.
      const list = JSON.parse(raw) as ConversationMeta[];
      return new Map(list.map((meta) => [meta.id, meta]));
    } catch {
      // A torn write loses grouping metadata, never conversations — the
      // JSONL files are the durable record; the index is rebuildable UI state.
      return new Map();
    }
  }
}
