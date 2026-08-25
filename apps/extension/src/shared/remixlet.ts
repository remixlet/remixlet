// remixlet.json — the manifest of a remixlet artifact (wiki/handoff.md §4). Shared
// shape + validation used by the store, the activation pipeline, and the
// agent's write_remixlet tool. Pure module, no extension APIs.

import { RMX_BRIDGE_VERSION, type RemixletBuiltWith } from "./bridge-version.js";
import { fetchHostPattern, FETCH_CAPABILITY_PREFIX } from "./fetch-capability.js";
import { NETWORK_OBSERVE_PREFIX, observeHostPattern, PAGE_WORLD_CAPABILITY } from "./observe-capability.js";
import { matchPatternStorageError } from "./site-key.js";
import { containsUnsafeText } from "./safe-text.js";

export interface RemixletScript {
  file: string;
  runAt?: "document_start" | "document_end" | "document_idle";
  /** USER_SCRIPT (default; sandboxed, bridge messaging) or MAIN (unsafeWindow cases). */
  world?: "USER_SCRIPT" | "MAIN";
}

export interface RemixletManifest {
  id: string;
  name: string;
  description?: string;
  /**
   * Store-assigned on activation (the `vN` tag number) and stamped into the
   * committed manifest — optional on authored input, always present in
   * stored artifacts. History truth lives in git.
   */
  version?: number;
  matches: string[];
  scripts?: RemixletScript[];
  styles?: string[];
  /**
   * The contract versions this artifact was written against (today just the
   * rmx bridge — shared/bridge-version.ts). Extension-authored: write_remixlet
   * stamps it on every save, overwriting model-supplied values, and the mirror
   * build refuses to run code whose stamp is outside the bridge's supported
   * range. Absent on legacy artifacts, which reads as bridge 1 (compatible).
   */
  builtWith?: RemixletBuiltWith;
  /** Capability grants (storage, fetch:<host>, menu, …) — enforced from M2 bridge on. */
  capabilities?: string[];
  /** Human-readable reason this remixlet needs each requested capability. */
  capabilityRationales?: Record<string, string>;
  netRules?: string;
}

export const MANIFEST_FILE = "remixlet.json";

/**
 * The script extensions the runtime injects AND the write-time formatter
 * (panel/tools/format.ts) actually parses. A file outside this set skips the
 * Prettier syntax gate, so a `main.jsx` could ship malformed code that breaks
 * out of the injected IIFE wrapper. A manifest may therefore declare only these
 * as scripts, and the mirror build refuses to inject anything else.
 */
export function isSupportedScriptFile(path: string): boolean {
  return path.endsWith(".js") || path.endsWith(".mjs");
}

/**
 * The remixlet's plain-English record of intent — what the feature is supposed
 * to do, what the page is assumed to look like, and why it is built the way it
 * is. Required on every agent write (agent/contracts.ts) so a future fix turn
 * can recover the intention without re-deriving it from code; stored/legacy
 * artifacts from before the requirement may lack it.
 */
export const README_FILE = "README.md";

/** id doubles as a directory name and a userScripts id fragment. */
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

interface JsonObject {
  [key: string]: JsonValue;
}

function isJsonObject(value: JsonValue | RemixletBuiltWith | undefined): value is JsonObject {
  return value instanceof Object && !Array.isArray(value);
}

function isJsonString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isJsonNumber(value: JsonValue | undefined): value is number {
  return Object.prototype.toString.call(value) === "[object Number]";
}

/** Parse a newly-authored manifest. Capability rationales are mandatory. */
export function parseRemixletManifest(json: string): RemixletManifest {
  return parseManifest(json, false);
}

/**
 * Read an artifact committed before capability rationales became mandatory.
 * Stored artifacts always carry the store-stamped version number.
 * New activation paths must use parseRemixletManifest instead.
 */
export function parseStoredRemixletManifest(json: string): RemixletManifest & { version: number } {
  // SAFETY: parseManifest requires a stored manifest version before this legacy read returns.
  return parseManifest(json, true) as RemixletManifest & { version: number };
}

/**
 * Every file the manifest names must arrive in the same write — a declared but
 * missing style.css would otherwise activate "ok" with its rules silently
 * dropped (the SoundCloud mixes-filter failure). Newly-authored writes only;
 * stored/legacy artifacts stay tolerant so the mirror can rebuild.
 */
export function validateManifestFileReferences(manifest: RemixletManifest, files: Record<string, string>): void {
  const missing = (field: '"scripts"' | '"styles"', file: string) =>
    new Error(
      `remixlet.json ${field} lists ${JSON.stringify(file)} but that file is not in this write — ` +
        `write_remixlet takes the COMPLETE file set every call; include every file named in "scripts" and "styles" with its content`,
    );
  for (const script of manifest.scripts ?? []) {
    if (files[script.file] === undefined) throw missing('"scripts"', script.file);
  }
  for (const style of manifest.styles ?? []) {
    if (files[style] === undefined) throw missing('"styles"', style);
  }
}

/**
 * Stamp the bridge contract version into a manifest JSON string. Called by
 * write_remixlet at the write boundary — EXTENSION-authored on purpose, like
 * the store's version stamp: the model cannot forget it and anything it sent
 * for builtWith is overwritten, so skew detection may trust the stamp
 * outright. Unparseable input passes through untouched; the parser downstream
 * reports the real error with its better message.
 */
export function stampManifestBuiltWith(manifestJson: string, extensionVersion?: string): string {
  let raw: JsonValue;
  try {
    raw = JSON.parse(manifestJson);
  } catch {
    return manifestJson;
  }
  if (!isJsonObject(raw)) return manifestJson;
  // extension is release traceability (which build wrote this), bridge is the
  // compatibility gate — see RemixletBuiltWith. Omitted when the caller has no
  // version (pure test contexts) rather than stamping an empty string.
  const builtWith = extensionVersion
    ? { bridge: RMX_BRIDGE_VERSION, extension: extensionVersion }
    : { bridge: RMX_BRIDGE_VERSION };
  return JSON.stringify({ ...raw, builtWith }, null, 2) + "\n";
}

function parseManifest(json: string, allowMissingCapabilityRationales: boolean): RemixletManifest {
  let raw: JsonValue;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new Error(`remixlet.json is not valid JSON: ${String(error)}`);
  }
  if (!isJsonObject(raw)) throw new Error('remixlet.json must be an object');
  // SAFETY: the field-by-field checks below validate every manifest property this module reads.
  const m = raw as Partial<RemixletManifest>;
  if (!isJsonString(m.id) || !ID_RE.test(m.id)) {
    throw new Error(`remixlet.json: "id" must match ${ID_RE} (got ${JSON.stringify(m.id)})`);
  }
  if (!isJsonString(m.name) || m.name.length === 0) throw new Error('remixlet.json: "name" is required');
  // The name renders under the honest title in the activation dialog, so it is
  // model prose that must not distort it (H2): bounded length, and no control,
  // newline, bidi, or zero-width characters. New writes only — stored/legacy
  // artifacts must keep parsing so the mirror can rebuild, like the match,
  // rationale, and MAIN-world checks below.
  if (!allowMissingCapabilityRationales && (m.name.length > 60 || containsUnsafeText(m.name))) {
    throw new Error('remixlet.json: "name" must be at most 60 characters with no control, newline, or bidirectional characters');
  }
  // Authored manifests may omit "version" (the store assigns and stamps it);
  // stored artifacts always carry the stamp, so there it stays required.
  const versionRequired = allowMissingCapabilityRationales;
  if (
    (m.version !== undefined || versionRequired) &&
    (!isJsonNumber(m.version) || !Number.isInteger(m.version) || m.version < 1)
  ) {
    throw new Error('remixlet.json: "version" must be a positive integer');
  }
  if (!Array.isArray(m.matches) || m.matches.length === 0 || !m.matches.every(isJsonString)) {
    throw new Error('remixlet.json: "matches" must be a non-empty string array');
  }
  // Each pattern must be a well-formed MV3 match, and a `*.`-wildcard must not
  // span a public suffix (`*.com`, `*.co.uk`, `*.github.io`) — that would grant
  // one remixlet authority over every unrelated site under it. `<all_urls>` and
  // a bare `*` host stay storable; their broad SCOPE is put to the user at
  // activation (the parse boundary can't know the conversation's site key).
  // New writes only: stored/legacy artifacts must keep parsing so the mirror
  // can rebuild, exactly like the rationale and MAIN-world checks below.
  if (!allowMissingCapabilityRationales) {
    // SAFETY: the string-array validation directly above established every match pattern is a string.
    for (const pattern of m.matches as string[]) {
      const patternError = matchPatternStorageError(pattern);
      if (patternError !== undefined) {
        throw new Error(`remixlet.json: match pattern ${JSON.stringify(pattern)} — ${patternError}`);
      }
    }
  }
  // builtWith stays OPTIONAL in both modes (legacy artifacts predate it and
  // read as bridge 1), but a present stamp must be well-formed — skew handling
  // trusts it. Unknown extra keys are tolerated on purpose: future contract
  // fields must not brick older extensions' mirror rebuilds.
  if (m.builtWith !== undefined) {
    if (!isJsonObject(m.builtWith)) {
      throw new Error('remixlet.json: "builtWith" must be an object');
    }
    // SAFETY: builtWith was verified as a non-array JSON object above.
    const bridge = (m.builtWith as JsonObject).bridge;
    if (!isJsonNumber(bridge) || !Number.isInteger(bridge) || bridge < 1) {
      throw new Error('remixlet.json: "builtWith.bridge" must be a positive integer');
    }
    // SAFETY: builtWith was verified as a non-array JSON object above.
    const extension = (m.builtWith as JsonObject).extension;
    if (extension !== undefined && !isJsonString(extension)) {
      throw new Error('remixlet.json: "builtWith.extension" must be a string');
    }
  }
  for (const script of m.scripts ?? []) {
    if (!isJsonString(script.file)) throw new Error('remixlet.json: each script needs a "file"');
    // New writes only (like the checks above): a declared script must have a
    // parseable extension, or it skips the write-time syntax gate and can break
    // out of the injected wrapper. Stored/legacy artifacts stay tolerant so the
    // mirror can rebuild — the mirror build re-applies isSupportedScriptFile.
    if (!allowMissingCapabilityRationales && !isSupportedScriptFile(script.file)) {
      throw new Error(
        `remixlet.json: script "file" must be a .js or .mjs file (got ${JSON.stringify(script.file)}) — ` +
          "other extensions skip the write-time syntax check and cannot be injected safely",
      );
    }
    if (script.world !== undefined && script.world !== "USER_SCRIPT" && script.world !== "MAIN") {
      throw new Error(`remixlet.json: script "world" must be "USER_SCRIPT" or "MAIN" (got ${JSON.stringify(script.world)})`);
    }
    if (
      script.runAt !== undefined &&
      script.runAt !== "document_start" &&
      script.runAt !== "document_end" &&
      script.runAt !== "document_idle"
    ) {
      throw new Error(`remixlet.json: script "runAt" is invalid (got ${JSON.stringify(script.runAt)})`);
    }
  }
  // MAIN-world code is strictly more power than the sandboxed default; it must
  // ride the capability-approval surface, never flip silently (§3b of the
  // network-data-visibility handoff). Enforced for newly-authored manifests
  // like rationales are — stored legacy artifacts must keep parsing so the
  // mirror can rebuild.
  if (
    !allowMissingCapabilityRationales &&
    (m.scripts ?? []).some((script) => script.world === "MAIN") &&
    !(m.capabilities ?? []).includes(PAGE_WORLD_CAPABILITY)
  ) {
    throw new Error(
      `remixlet.json: scripts with "world": "MAIN" require the "${PAGE_WORLD_CAPABILITY}" capability (with a rationale), so the user approves page-world access at activation`,
    );
  }
  if (m.styles !== undefined && !m.styles.every(isJsonString)) {
    throw new Error('remixlet.json: "styles" must be a string array');
  }
  if (m.capabilities !== undefined && (!Array.isArray(m.capabilities) || !m.capabilities.every(isJsonString))) {
    throw new Error('remixlet.json: "capabilities" must be a string array');
  }
  if (
    m.capabilityRationales !== undefined &&
    !isJsonObject(m.capabilityRationales)
  ) {
    throw new Error('remixlet.json: "capabilityRationales" must be an object');
  }
  const capabilities = [...new Set(m.capabilities ?? [])].sort();
  const rationaleNames = Object.keys(m.capabilityRationales ?? {}).sort();
  if (
    !allowMissingCapabilityRationales &&
    (capabilities.length !== rationaleNames.length ||
      capabilities.some((capability, index) => capability !== rationaleNames[index]))
  ) {
    throw new Error('remixlet.json: "capabilityRationales" must contain exactly one rationale for every capability');
  }
  for (const [capability, rationale] of Object.entries(m.capabilityRationales ?? {})) {
    if (!(m.capabilities ?? []).includes(capability)) {
      throw new Error(`remixlet.json: capability rationale ${JSON.stringify(capability)} has no matching capability`);
    }
    if (!isJsonString(rationale) || rationale.trim().length === 0 || rationale.length > 500) {
      throw new Error(`remixlet.json: rationale for ${JSON.stringify(capability)} must be 1–500 characters`);
    }
  }
  if (m.netRules !== undefined && (!isJsonString(m.netRules) || !/^[^/\\]{1,128}$/.test(m.netRules))) {
    throw new Error('remixlet.json: "netRules" must be a safe top-level file name');
  }
  if (m.netRules !== undefined && !(m.capabilities ?? []).includes("netrules")) {
    throw new Error('remixlet.json: "netRules" requires the "netrules" capability');
  }
  for (const capability of m.capabilities ?? []) {
    if (capability.startsWith(FETCH_CAPABILITY_PREFIX) && fetchHostPattern(capability) === undefined) {
      throw new Error(
        `remixlet.json: invalid fetch capability ${JSON.stringify(capability)} (use fetch:host.example or fetch:*.host.example)`,
      );
    }
    if (capability.startsWith(NETWORK_OBSERVE_PREFIX) && observeHostPattern(capability) === undefined) {
      throw new Error(
        `remixlet.json: invalid network:observe capability ${JSON.stringify(capability)} (use network:observe:host.example or network:observe:*.host.example)`,
      );
    }
  }
  // SAFETY: every contract field used by activation has been validated above; unknown future keys remain intentionally tolerated.
  return m as RemixletManifest;
}
