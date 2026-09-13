// Store packaging: build the Chrome target in release mode, zip it for a
// Chrome Web Store upload, and validate the exact artifact
// (wiki/ops/chrome-store-submission.md §3.3). The zip carries dist/chrome minus
// sourcemaps and build-id.txt — the bundles ship unminified, so review
// readability never needed the maps — with fixed entry timestamps and sorted
// paths, so one source tree always zips to the same bytes; the sha256 printed
// at the end is that identity. Validation re-reads the zip it just wrote:
// central directory, per-entry CRCs, manifest contracts, the files the manifest
// points at, and the absence of every development-only hook.
//
// Usage: node tools/package.mjs [--out=<zip path>]
// Without --out the zip is dist/remixlet-chrome-<version>-unverified.zip: a
// local build is a real production build, but nothing here proves it matches a
// published source tree, and the name says so. The release pipeline calls this
// with --out and records the hash against the source it verified.
// Zero npm deps; node >= 22.2 (zlib.crc32).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const fail = (message) => {
  throw new Error(message);
};
const assert = (condition, message) => {
  if (!condition) fail(`package check failed: ${message}`);
};
if (typeof zlib.crc32 !== "function") fail("node >= 22.2 is required (zlib.crc32)");

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(extensionRoot, "dist/chrome");

let outPath;
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("--out=")) outPath = path.resolve(arg.slice("--out=".length));
  else fail(`unknown flag ${arg} (usage: node tools/package.mjs [--out=<zip path>])`);
}

// Sourcemaps and the build-id mirror are build/dev aids, not shipped surface.
const excluded = (rel) => rel.endsWith(".map") || rel === "build-id.txt";

// Depth-first walk, forward-slash relative paths, byte order — deterministic.
function* walk(dir, prefix = "") {
  const entries = [...fs.readdirSync(dir, { withFileTypes: true })].sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) yield* walk(path.join(dir, entry.name), rel);
    else yield rel;
  }
}

// --- Minimal zip writer: local headers + central directory + EOCD. Fixed DOS
// timestamp (2026-01-01 00:00) and no extra fields, so the bytes are a pure
// function of the file set. Deflate unless stored is smaller.
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    assert(!/[^\x20-\x7e]/.test(name), `zip entry name is plain ASCII: ${name}`);
    const nameBytes = Buffer.from(name, "utf8");
    const crc = zlib.crc32(data) >>> 0;
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const method = deflated.length < data.length ? 8 : 0;
    const payload = method === 8 ? deflated : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    chunks.push(local, nameBytes, payload);
    central.push({ nameBytes, crc, method, csize: payload.length, usize: data.length, offset });
    offset += local.length + nameBytes.length + payload.length;
  }
  const cdStart = offset;
  for (const entry of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0, 8); // flags
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(0, 12); // mod time
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.csize, 20);
    header.writeUInt32LE(entry.usize, 24);
    header.writeUInt16LE(entry.nameBytes.length, 28);
    header.writeUInt32LE(entry.offset, 42);
    chunks.push(header, entry.nameBytes);
    offset += header.length + entry.nameBytes.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(offset - cdStart, 12);
  eocd.writeUInt32LE(cdStart, 16);
  chunks.push(eocd);
  return Buffer.concat(chunks);
}

// --- Zip reader for validation: walks the central directory, inflates every
// entry, and re-checks CRC and sizes, so a corrupt artifact can never pass.
function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65536); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert(eocd !== -1, "zip has an end-of-central-directory record");
  const count = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    assert(buffer.readUInt32LE(at) === 0x02014b50, `central directory entry ${i} has its signature`);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const csize = buffer.readUInt32LE(at + 20);
    const usize = buffer.readUInt32LE(at + 24);
    const nameLen = buffer.readUInt16LE(at + 28);
    const extraLen = buffer.readUInt16LE(at + 30);
    const commentLen = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLen);
    assert(buffer.readUInt32LE(local) === 0x04034b50, `${name}: local header signature`);
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const payload = buffer.subarray(dataStart, dataStart + csize);
    const data = method === 8 ? zlib.inflateRawSync(payload) : Buffer.from(payload);
    assert(method === 8 || method === 0, `${name}: known compression method`);
    assert(data.length === usize, `${name}: uncompressed size matches the directory`);
    assert((zlib.crc32(data) >>> 0) === crc, `${name}: CRC32 round-trips`);
    entries.set(name, data);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const globToRegExp = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);

// Every path the manifest points at must exist in the artifact — a dangling
// reference is a packaging error the review would hit (§2.4-4).
function checkManifestPaths(manifest, names) {
  const present = (file, why) => assert(names.has(file), `${why} exists in the zip: ${file}`);
  present(manifest.background.service_worker, "background service worker");
  present(manifest.action.default_popup, "action popup");
  present(manifest.side_panel.default_path, "side panel document");
  for (const file of Object.values(manifest.icons)) present(file, "manifest icon");
  for (const file of Object.values(manifest.action.default_icon)) present(file, "action icon");
  for (const { resources } of manifest.web_accessible_resources) {
    for (const resource of resources) {
      const pattern = globToRegExp(resource);
      assert(
        [...names].some((name) => pattern.test(name)),
        `web-accessible resource matches at least one file: ${resource}`,
      );
    }
  }
}

function checkManifest(manifest, names, version) {
  assert(manifest.manifest_version === 3, "manifest_version is 3");
  assert(manifest.name === "Remixlet", "extension name is Remixlet");
  assert(manifest.version === version, `manifest version ${manifest.version} matches package.json ${version}`);
  assert(/^\d{1,5}(\.\d{1,5}){0,3}$/.test(manifest.version), "version is a dotted integer string");
  assert(manifest.description.length <= 132, "description fits the store's 132-char manifest limit");
  assert(!("key" in manifest) && !("update_url" in manifest), "no key or update_url field — store uploads must not carry them");
  assert(manifest.minimum_chrome_version === "138", "Chrome floor is 138 (submission plan §3.2)");
  const expectedPermissions = new Set([
    "alarms",
    "clipboardWrite",
    "declarativeNetRequestWithHostAccess",
    "notifications",
    "offscreen",
    "scripting",
    "sidePanel",
    "storage",
    "tabs",
    "unlimitedStorage",
    "webNavigation",
    "webRequest",
  ]);
  assert(
    manifest.permissions.length === expectedPermissions.size &&
      manifest.permissions.every((permission) => expectedPermissions.has(permission)),
    "permissions match the audited Chrome allowlist",
  );
  assert(!("optional_permissions" in manifest), "the package requests no optional permissions");
  assert(
    manifest.permissions.includes("declarativeNetRequestWithHostAccess") &&
      !manifest.permissions.includes("declarativeNetRequest"),
    "DNR is the WithHostAccess variant (submission plan §3.1)",
  );
  const hasLocales = [...names].some((name) => name.startsWith("_locales/"));
  assert(
    ("default_locale" in manifest) === hasLocales,
    "default_locale and _locales/ come and go together",
  );
  checkManifestPaths(manifest, names);
}

// 1. Fresh release build: test hooks stubbed out, build id pinned (build.mjs).
console.log("== build");
execFileSync(process.execPath, ["build.mjs", "--target=chrome", "--release"], { cwd: extensionRoot, stdio: "inherit" });

// 2. Stage the file set.
const staged = [];
for (const rel of walk(distDir)) {
  if (excluded(rel)) continue;
  assert(!/(^|\/)\./.test(rel), `no dotfiles in the artifact: ${rel}`);
  staged.push({ name: rel, data: fs.readFileSync(path.join(distDir, rel)) });
}
assert(staged.length > 0, "the build produced files");
assert(
  staged.some((file) => file.name === "manifest.json"),
  "manifest.json sits at the artifact root",
);

// 3. Zip and write.
console.log("== zip");
const { version } = JSON.parse(fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8"));
const zipPath = outPath ?? path.join(extensionRoot, "dist", `remixlet-chrome-${version}-unverified.zip`);
const zip = buildZip(staged);
fs.mkdirSync(path.dirname(zipPath), { recursive: true });
fs.writeFileSync(zipPath, zip);

// 4. Validate the artifact just written — the zip's own bytes, not the staging.
console.log("== validate");
const entries = readZip(fs.readFileSync(zipPath));
const names = new Set(entries.keys());
assert(names.size === staged.length, `zip carries every staged file (${names.size} of ${staged.length})`);
for (const { name } of staged) assert(names.has(name), `staged file made it into the zip: ${name}`);
for (const name of names) {
  assert(!name.includes("\\") && !name.startsWith("/") && !name.split("/").includes(".."), `entry path is safe: ${name}`);
  assert(!name.endsWith(".map"), `no sourcemaps ship: ${name}`);
  assert(name !== "build-id.txt", "build-id.txt stays out of the artifact");
}
const manifest = JSON.parse(entries.get("manifest.json").toString("utf8"));
checkManifest(manifest, names, version);
const worker = entries.get(manifest.background.service_worker).toString("utf8");
assert(!worker.includes("dev rebuild detected"), "the dev-reload client is stripped from the shipped worker");
// The OAuth harness redirects the Codex issuer through one storage key; the
// shipped worker must not know the key exists (build.mjs --release stubs it).
assert(!worker.includes("codexIssuerOverride"), "the Codex issuer test hook is stripped from the shipped worker");
// The lifecycle harness interrupts delete-forever through one storage key;
// same rule: the shipped worker must not know the key exists.
assert(!worker.includes("remixletDeletionFault"), "the deletion fault test hook is stripped from the shipped worker");
assert(worker.includes(`BUILD_ID = "chrome-v${version}"`), "the build id is pinned to the version (reproducible bytes)");
assert(zip.length < 2 * 1024 ** 3, "zip is under the store's 2 GB cap");

const totalUncompressed = staged.reduce((sum, file) => sum + file.data.length, 0);
const mb = (bytes) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const sha256 = createHash("sha256").update(zip).digest("hex");
fs.writeFileSync(`${zipPath}.sha256`, `${sha256}  ${path.basename(zipPath)}\n`);
console.log(`${zipPath}`);
console.log(`DONE — ${names.size} files, ${mb(totalUncompressed)} unpacked → ${mb(zip.length)} zipped, sha256 ${sha256}`);
