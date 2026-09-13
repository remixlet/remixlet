// The one artifact-level answer to "may this remixlet run?", and the two
// durable facts it consults that live outside the registry: the deleting
// mark (a delete-forever in progress, worker/activation.ts) and the
// quarantine record (an enabled artifact the mirror build could not admit).
//
// judgeArtifact is consulted in exactly one place — the mirror build in
// activation.ts — and its verdict is materialised as mirror membership. Every
// runtime consumer (script registration, CSS, DNR rules, the bridge, menu
// commands, schedules, the badge) reads the mirror, so an artifact this
// function refuses has no code registered, no rules installed, no bridge
// token in reach and no owned registrations left: the reconcilers that run
// after each mirror write tear down whatever an earlier verdict admitted
// (wiki/ops/2026-09-04-security-remediation-plan.md item 10).
//
// Both records are storage.local and reconstructible: the mirror build
// rewrites the quarantine from what it observes on every run, and a deleting
// mark is cleared by the deletion that set it (or resumed at boot).

import { ext } from "../platform/ext.js";
import { bridgeSkewReason } from "../shared/bridge-version.js";
import type { RegistryEntry, RemixletContent, RemixletStore } from "../store/remixlet-store.js";
import { validateNetRulesFile } from "./netrules.js";

const DELETING_KEY = "remixletDeleting";
const QUARANTINE_KEY = "remixletQuarantine";

/** An enabled artifact the worker refuses to run, and why. */
export interface QuarantineRecord {
  reason: string;
  /** The committed head the verdict was made on; a new version is re-judged. */
  headSha: string;
  at: number;
}

export type ArtifactVerdict =
  | { eligible: true; content: RemixletContent }
  /** Not a fault of the artifact: it is off, archived, or being deleted. */
  | { eligible: false; quarantine: false; reason: string }
  /** The artifact is on but cannot be admitted; the record says why. */
  | { eligible: false; quarantine: true; reason: string };

/**
 * Judge one registry entry. The read is the store's committed read, so the
 * verdict describes the tagged snapshot at `headSha` — a worktree edit or an
 * interrupted activation changes nothing here. Every failure to read or parse
 * is a quarantine, never a thrown error: one unreadable artifact must not
 * take the others down with it (the mirror build used to abort as a whole).
 */
export async function judgeArtifact(
  store: RemixletStore,
  listed: RegistryEntry,
  deleting: ReadonlySet<string>,
): Promise<ArtifactVerdict> {
  if (deleting.has(listed.id)) return { eligible: false, quarantine: false, reason: "being deleted" };
  if (listed.state !== "enabled") return { eligible: false, quarantine: false, reason: `state is ${listed.state}` };
  let content: RemixletContent;
  try {
    content = await store.read(listed.id);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { eligible: false, quarantine: true, reason: `its stored files could not be read: ${detail}` };
  }
  // The registry may have moved under the list (a mutation between list and
  // read); the read's own entry is the coherent one.
  if (content.entry.state !== "enabled") {
    return { eligible: false, quarantine: false, reason: `state is ${content.entry.state}` };
  }
  try {
    validateNetRulesFile(content.manifest, content.files);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { eligible: false, quarantine: true, reason: `its network rules are invalid: ${detail}` };
  }
  const skew = bridgeSkewReason(content.manifest.builtWith);
  if (skew !== undefined) return { eligible: false, quarantine: true, reason: skew };
  return { eligible: true, content };
}

/** What a quarantined artifact's owner can do about it — appended to every reason. */
export function quarantineAdvice(reason: string): string {
  return `not running — ${reason}. Update it from a chat, roll back to an earlier version, or delete it.`;
}

// ---- deleting marks --------------------------------------------------------

export async function readDeletingMarks(): Promise<Set<string>> {
  const stored = await ext.storage.local.get(DELETING_KEY);
  // SAFETY: this module is the key's only writer and stores an id → { at } map.
  const marks = (stored[DELETING_KEY] as Record<string, { at: number }> | undefined) ?? {};
  return new Set(Object.keys(marks));
}

export async function markDeleting(id: string): Promise<void> {
  const stored = await ext.storage.local.get(DELETING_KEY);
  // SAFETY: see readDeletingMarks.
  const marks = (stored[DELETING_KEY] as Record<string, { at: number }> | undefined) ?? {};
  if (marks[id] === undefined) marks[id] = { at: Date.now() };
  await ext.storage.local.set({ [DELETING_KEY]: marks });
}

export async function clearDeletingMark(id: string): Promise<void> {
  const stored = await ext.storage.local.get(DELETING_KEY);
  // SAFETY: see readDeletingMarks.
  const marks = (stored[DELETING_KEY] as Record<string, { at: number }> | undefined) ?? {};
  delete marks[id];
  await ext.storage.local.set({ [DELETING_KEY]: marks });
}

// ---- quarantine ------------------------------------------------------------

export async function readQuarantine(): Promise<Record<string, QuarantineRecord>> {
  const stored = await ext.storage.local.get(QUARANTINE_KEY);
  // SAFETY: writeQuarantine is the key's only writer and stores an id → QuarantineRecord map.
  return (stored[QUARANTINE_KEY] as Record<string, QuarantineRecord> | undefined) ?? {};
}

export async function writeQuarantine(records: Record<string, QuarantineRecord>): Promise<void> {
  await ext.storage.local.set({ [QUARANTINE_KEY]: records });
}
