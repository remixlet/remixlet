// Site favicon store: one small JSON map from site key → the site's favicon,
// snapshotted as a data URL when a chat binds to a tab on that site. Snapshots
// (not live URLs) so the manager renders icons offline and after a site
// rotates its assets; sourceUrl remembers where each snapshot came from so an
// unchanged favicon is never refetched. The worker is the only writer
// (single-writer rule, same as the conversation index).
//
// Store code is extension-API-free by convention.

import { isFsError, OpfsFs } from "./opfs-fs.js";

export interface SiteIcon {
  /** The icon URL the snapshot was taken from (often a discovered high-res one). */
  sourceUrl: string;
  /**
   * The favicon URL the tab reported at record time — the short-circuit key,
   * since sourceUrl may be a discovered URL the next bind never mentions.
   * Absent on records written before discovery existed and on refresh-path
   * captures; such records re-record once on the next bind.
   */
  reportedUrl?: string;
  /** data:image/… snapshot; UI slots run 16–32px. */
  dataUrl: string;
  updatedAt: number;
}

const INDEX_PATH = "site-icons/index.json";

export class SiteIconStore {
  readonly #fs: OpfsFs;

  constructor(fs: OpfsFs = new OpfsFs()) {
    this.#fs = fs;
  }

  async get(siteKey: string): Promise<SiteIcon | undefined> {
    return (await this.#read())[siteKey];
  }

  /** Every stored icon's data URL, keyed by site key — the shape the UI wants. */
  async list(): Promise<Record<string, string>> {
    const entries = await this.#read();
    return Object.fromEntries(Object.entries(entries).map(([siteKey, icon]) => [siteKey, icon.dataUrl]));
  }

  async put(siteKey: string, icon: SiteIcon): Promise<void> {
    const entries = await this.#read();
    entries[siteKey] = icon;
    await this.#fs.promises.writeFile(INDEX_PATH, JSON.stringify(entries));
  }

  async #read(): Promise<Record<string, SiteIcon>> {
    let raw: string;
    try {
      // SAFETY: readFile's utf8 overload resolves to a string.
      raw = (await this.#fs.promises.readFile(INDEX_PATH, "utf8")) as string;
    } catch (error) {
      if (isFsError(error, "ENOENT")) return {};
      throw error;
    }
    try {
      // SAFETY: this store exclusively writes the index from Record<string, SiteIcon> entries.
      return JSON.parse(raw) as Record<string, SiteIcon>;
    } catch {
      // A torn write only costs cached icons; they resnapshot on the next chat.
      return {};
    }
  }
}
