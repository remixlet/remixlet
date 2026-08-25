export type CapabilityGrants = Record<string, string[]>;

/**
 * Reads existing grants directly, deriving them from the installed manifests
 * exactly ONCE for the pre-grants legacy artifacts that predate this record.
 * Concurrent callers share the same migration promise, so a late migration
 * write cannot overwrite a grant written by an activation that awaited it.
 *
 * The one-time guard is the whole point: grants live in `storage.local` while
 * artifacts live in OPFS, on independent lifetimes, so a missing grants key is
 * NOT proof of a legacy install — it can equally be a cleared or lost record.
 * Re-deriving grants from the agent-authored manifest in that case would
 * silently promote every remixlet's DECLARED capabilities to APPROVED, which
 * the manifest is not (it is a request, not a consent record). So once the
 * migration has run, an absent key fails CLOSED: a remixlet with no grant entry
 * holds no capabilities until the user re-approves it.
 */
export class CapabilityGrantStore {
  #initialization: Promise<CapabilityGrants> | undefined;

  constructor(
    private readonly readStored: () => Promise<CapabilityGrants | undefined>,
    private readonly writeStored: (grants: CapabilityGrants) => Promise<void>,
    private readonly migrate: () => Promise<CapabilityGrants>,
    private readonly hasMigrated: () => Promise<boolean>,
    private readonly markMigrated: () => Promise<void>,
  ) {}

  async read(): Promise<CapabilityGrants> {
    const existing = await this.readStored();
    if (existing) return existing;
    this.#initialization ??= this.#initialize().catch((cause: unknown) => {
      this.#initialization = undefined;
      throw cause;
    });
    return this.#initialization;
  }

  async write(grants: CapabilityGrants): Promise<void> {
    if (this.#initialization) await this.#initialization;
    await this.writeStored(grants);
  }

  async #initialize(): Promise<CapabilityGrants> {
    // Another extension context could have initialized the key after the
    // caller's first read. Recheck before deriving legacy grants.
    const existing = await this.readStored();
    if (existing) return existing;
    // The migration is one-shot. If it has already run, an absent key means the
    // record was cleared or lost — fail closed with an empty set rather than
    // re-deriving (and thereby re-granting) from the manifest.
    if (await this.hasMigrated()) {
      await this.writeStored({});
      return {};
    }
    const migrated = await this.migrate();
    await this.writeStored(migrated);
    await this.markMigrated();
    return migrated;
  }
}
