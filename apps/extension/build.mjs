// Build driver: one source tree → per-browser bundles in dist/<target>/.
// Usage: node build.mjs --target=chrome|firefox [--watch | --release]
//
// --release is what tools/package.mjs builds: development-only modules are
// swapped for stubs (the Codex issuer test hook) and the build id is pinned to
// the version, so one source tree always builds to the same bytes and a
// packaged zip can be checked against a recorded hash.
import * as esbuild from "esbuild";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { watch as fsWatch } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const args = process.argv.slice(2);
const target = (args.find((a) => a.startsWith("--target=")) ?? "--target=chrome").split("=")[1];
const watch = args.includes("--watch");
const release = args.includes("--release");
if (watch && release) {
  console.error("--watch and --release are exclusive");
  process.exit(1);
}

const TARGETS = ["chrome", "firefox", "safari"];
if (!TARGETS.includes(target)) {
  console.error(`unknown target "${target}" (expected ${TARGETS.join("|")})`);
  process.exit(1);
}

const outdir = path.join("dist", target);

// Dev auto-reload (watch mode only): serve a monotonic build id on localhost;
// the dev build's service worker polls it and runtime.reload()s on change (see
// src/worker/dev-reload.ts). Production builds define the port as 0, which
// dead-code-eliminates the client entirely.
const RELOAD_PORT = Number(process.env.RMX_RELOAD_PORT ?? 43117);
let buildId = 0;

const devReloadBump = {
  name: "dev-reload-bump",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0) buildId += 1;
    });
  },
};

// Panel/worker build-skew detection: every (re)build stamps a fresh id into
// src/shared/build-id.ts, so both bundles of one build carry the same
// compiled-in constant and bundles from different builds never do. The worker
// answers page.probe with a named "build mismatch" error when the panel's
// stamp differs (the dev rebuild-without-reload state). The id is mirrored to
// dist/<target>/build-id.txt so the test harness can send the real value.
// Release builds pin the id to the version: every bundle in a package comes
// from one build, an update always bumps the version, and a pinned id is what
// makes two builds of one source tree byte-identical.
let stampSeq = 0;
let stampedBuildId = "";
const buildIdStamp = {
  name: "build-id-stamp",
  setup(build) {
    build.onStart(() => {
      stampedBuildId = release ? `${target}-v${releaseVersion}` : `${target}-${Date.now().toString(36)}-${(stampSeq += 1)}`;
    });
    build.onLoad({ filter: /[\\/]shared[\\/]build-id\.ts$/ }, () => ({
      contents: `export const BUILD_ID = ${JSON.stringify(stampedBuildId)};`,
      loader: "ts",
    }));
    build.onEnd((result) => {
      if (result.errors.length === 0) void writeFile(path.join(outdir, "build-id.txt"), stampedBuildId).catch(() => {});
    });
  },
};

// Non-watch builds swap the dev-reload module for an empty stub — esbuild
// folds the port define to `if (false)` but keeps the dead branch unminified,
// and shipped bundles should not carry the client at all.
const devReloadStrip = {
  name: "dev-reload-strip",
  setup(build) {
    build.onResolve({ filter: /\/dev-reload\.js$/ }, () => ({
      path: "dev-reload-stub",
      namespace: "dev-reload-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "dev-reload-stub" }, () => ({
      contents: "export function installDevReload() {}",
      loader: "js",
    }));
  },
};

// Release builds carry no test hooks: modules listed here resolve to a stub
// that exports the same names with inert bodies, so the packaged bundles never
// contain the code — or the storage key names — a hook would honour.
const releaseStubs = {
  "/codex-issuer-override.js": "export async function testIssuerOverride() { return undefined; }",
  "/deletion-fault.js": "export async function testDeletionFault() { return undefined; }",
};
const releaseStrip = {
  name: "release-strip",
  setup(build) {
    for (const [suffix, contents] of Object.entries(releaseStubs)) {
      const filter = new RegExp(`${suffix.replace(/[.]/g, "\\.")}$`);
      build.onResolve({ filter }, () => ({ path: suffix, namespace: "release-stub" }));
      build.onLoad({ filter, namespace: "release-stub" }, () => ({ contents, loader: "js" }));
    }
  },
};

function startDevReloadServer() {
  createServer((req, res) => {
    // CORS * so the extension worker can fetch without host permissions.
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ id: buildId }));
  })
    .once("error", (error) => console.warn(`dev-reload server unavailable: ${error.message}`))
    .listen(RELOAD_PORT, "127.0.0.1", () => console.log(`dev-reload serving on http://127.0.0.1:${RELOAD_PORT}`));

  // Tailwind runs its own watch process, so CSS-only edits never pass through
  // esbuild's onEnd. Watch its output instead — content-hashed, because the
  // CLI rewrites the file on any content-file save even when nothing changed.
  let cssHash;
  fsWatch(path.join(outdir, "panel"), (_event, filename) => {
    if (filename !== "styles.css") return;
    void readFile(path.join(outdir, "panel/styles.css"))
      .then((css) => {
        const hash = createHash("sha1").update(css).digest("hex");
        if (hash === cssHash) return;
        if (cssHash !== undefined) buildId += 1;
        cssHash = hash;
      })
      .catch(() => {});
  });

  // Brand generation changes files outside esbuild's module graph. Copy the
  // whole icon batch before notifying the loaded extension to reload.
  let iconsTimer;
  let iconsCopy = Promise.resolve();
  fsWatch("assets/icons", () => {
    clearTimeout(iconsTimer);
    iconsTimer = setTimeout(() => {
      iconsCopy = iconsCopy
        .then(copyIcons)
        .then(() => { buildId += 1; })
        .catch((error) => console.error(`Icon refresh failed: ${error.message}`));
    }, 100);
  });
}

// Overlay wins; arrays are unioned, objects merged deep, scalars replaced.
function mergeManifest(base, overlay) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const prev = out[key];
    if (Array.isArray(prev) && Array.isArray(value)) {
      out[key] = [...new Set([...prev, ...value])];
    } else if (prev && value && typeof prev === "object" && typeof value === "object" && !Array.isArray(value)) {
      out[key] = mergeManifest(prev, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

async function readManifest() {
  const base = JSON.parse(await readFile("manifests/manifest.base.json", "utf8"));
  const overlay = JSON.parse(await readFile(`manifests/manifest.${target}.json`, "utf8"));
  return mergeManifest(base, overlay);
}

async function buildManifest() {
  await writeFile(path.join(outdir, "manifest.json"), JSON.stringify(await readManifest(), null, 2));
}

async function copyIcons() {
  // Toolbar PNGs and both themed UI SVGs are generated from assets/brand.
  await cp("assets/icons", path.join(outdir, "icons"), { recursive: true });
}

async function copyStatic() {
  await mkdir(path.join(outdir, "panel"), { recursive: true });
  await copyIcons();
  await cp("src/panel/index.html", path.join(outdir, "panel/index.html"));
  // Top-level so the OAuth DNR regexSubstitution target is /oauth-callback.html.
  await cp("src/ui/oauth-callback.html", path.join(outdir, "oauth-callback.html"));
  // M3 trust surface pages: popup (action), the standalone first-run page
  // (welcome), and the control center (manager, hash-routed). All root-level,
  // linking panel/styles.css.
  for (const page of ["popup", "manager", "welcome"]) {
    await cp(`src/ui/${page}.html`, path.join(outdir, `${page}.html`));
  }
  // The sandboxed box page every remixlet runs in (manifest sandbox.pages;
  // wiki/design/mediated-execution.md) and, on Chrome, the offscreen document
  // that hosts the box iframes and the clipboard backend.
  await cp("src/box/box.html", path.join(outdir, "box.html"));
  if (target === "chrome") {
    await cp("src/platform/offscreen.html", path.join(outdir, "offscreen.html"));
  }
  // The design system faces (Space Grotesk + IBM Plex Mono, shared with the
  // website via packages/design) ship with the extension: fontsource's own
  // @font-face css concatenated next to its woff2 payloads, so url(./files/…)
  // resolves inside the packed extension. Only the weights the css references
  // are copied; italics are unused — skip them.
  const fontCssFiles = [
    "node_modules/@fontsource-variable/space-grotesk/index.css",
    "node_modules/@fontsource/ibm-plex-mono/400.css",
    "node_modules/@fontsource/ibm-plex-mono/500.css",
  ];
  const fontCss = await Promise.all(fontCssFiles.map((file) => readFile(file, "utf8")));
  await writeFile(path.join(outdir, "panel/fonts.css"), fontCss.join("\n"));
  await cp("node_modules/@fontsource-variable/space-grotesk/files", path.join(outdir, "panel/files"), {
    recursive: true,
    filter: (source) => !source.includes("italic"),
  });
  await cp("node_modules/@fontsource/ibm-plex-mono/files", path.join(outdir, "panel/files"), {
    recursive: true,
    filter: (source) => !source.includes("italic") && (!path.basename(source).includes(".") || /-[45]00-/.test(source)),
  });
}

// Tailwind v4 compiles the design system stylesheet (tokens + shadcn/Base UI
// component classes scanned from src/) into a plain css file the extension
// pages link — esbuild never sees css.
const tailwindBin = path.join("node_modules", ".bin", "tailwindcss");
const tailwindArgs = () => ["-i", "src/panel/styles.css", "-o", path.join(outdir, "panel/styles.css")];

function tailwindBuild() {
  return new Promise((resolve, reject) => {
    const proc = spawn(tailwindBin, tailwindArgs(), { stdio: "inherit" });
    proc.on("error", reject);
    proc.on("exit", (code) => (code === 0 ? resolve(undefined) : reject(new Error(`tailwind exited with ${code}`))));
  });
}

// Bare "shiki" imports (from @pierre/diffs and friends) resolve to the slim
// bundle: the real entry point registers every grammar shiki ships, and
// esbuild would inline all ~10MB of them into manager.js. Subpath imports
// ("shiki/core", "shiki/engine/*") pass through untouched — the shim itself
// is built from them.
const shikiSlim = {
  name: "shiki-slim",
  setup(build) {
    build.onResolve({ filter: /^shiki$/ }, () => ({
      path: path.resolve("src/ui/shiki-slim.ts"),
    }));
    // Unreachable-by-construction modules resolve to an empty stub instead of
    // being inlined (see src/ui/shiki-stub.ts).
    build.onResolve({ filter: /^(shiki\/wasm|@shikijs\/themes\/)/ }, () => ({
      path: path.resolve("src/ui/shiki-stub.ts"),
    }));
  },
};

const bundles = {
  plugins: [shikiSlim, buildIdStamp, ...(watch ? [devReloadBump] : [devReloadStrip]), ...(release ? [releaseStrip] : [])],
  entryPoints: {
    worker: "src/worker/index.ts",
    "panel/main": "src/panel/main.tsx",
    "oauth-callback": "src/ui/oauth-callback.tsx",
    popup: "src/ui/popup.tsx",
    manager: "src/ui/manager.tsx",
    welcome: "src/ui/welcome.tsx",
    "annotate-host": "src/platform/annotate-host-content.ts",
    "show-changes-host": "src/platform/show-changes-host-content.ts",
    box: "src/box/box-entry.ts",
    "page-agent": "src/platform/page-agent-content.ts",
    // The two MAIN-world files worker/injection.ts registers as content
    // scripts: the network:observe relay and the development-time observer.
    relay: "src/bridge/relay-entry.ts",
    "dev-observe": "src/bridge/dev-observe-entry.ts",
    // The two files the probe engine injects on demand through
    // scripting.executeScript (worker/page-probes/engine.ts): the probe
    // runner for the ISOLATED world and the read_page_state reader for MAIN.
    probes: "src/worker/page-probes/probes-entry.ts",
    "page-state": "src/worker/page-probes/page-state-entry.ts",
    ...(target === "chrome" ? { offscreen: "src/platform/offscreen.ts" } : {}),
  },
  outdir,
  bundle: true,
  format: "esm",
  sourcemap: true,
  define: {
    __BROWSER_TARGET__: JSON.stringify(target),
    __DEV_RELOAD_PORT__: JSON.stringify(watch ? RELOAD_PORT : 0),
    // React ships dev/prod branches behind this; always bundle prod.
    "process.env.NODE_ENV": '"production"',
  },
  logLevel: "info",
};

const releaseVersion = release ? (await readManifest()).version : undefined;

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await buildManifest();
await copyStatic();

if (watch) {
  const ctx = await esbuild.context(bundles);
  await ctx.watch();
  // "always": plain --watch exits when stdin closes, so a watch started
  // detached (agent background task, nohup) silently loses the stylesheet.
  spawn(tailwindBin, [...tailwindArgs(), "--watch=always"], { stdio: "inherit" });
  startDevReloadServer();
  console.log(`watching (${target}) → ${outdir}`);
} else {
  await Promise.all([esbuild.build(bundles), tailwindBuild()]);
  console.log(`built (${target}${release ? ", release" : ""}) → ${outdir}`);
}
