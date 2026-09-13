// Provider credentials stay panel-local and leave the panel only as a request header or body
// to the provider they belong to. Two static checks enforce that (wiki/design/privacy.md):
//
// 1. Boundary: the service worker, the bridge and the shared protocol never reference a
//    provider API key at all, so no future message or bridge lane can carry one.
// 2. Sinks: nowhere in the extension may a credential be written into a URL (query string,
//    URL constructor, percent-encoding) or into log or error text. A URL is copied into
//    history, logs and error reports; a header is not.
//
// The sink check runs over the whole source tree, panel included — the panel is where the
// keys live, so it is where a leak would be written. Fixtures below pin the shapes it must
// catch (the Google `?key=` discovery request that shipped in 0.1.1) and the shapes it must
// allow (the same key as a header).
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const CREDENTIAL = String.raw`(?:apiKey|accessToken|refreshToken|idToken|api_key|access_token|refresh_token|id_token)`;

// Each sink is a regex over the whole file; `[^)]*` and `[^`]*` span lines so a multi-line
// call is still one match. Every pattern must reach the credential identifier itself: a
// message that merely says "API key" is copy, not a leak.
const SINKS = [
  { why: "query parameter", pattern: new RegExp(String.raw`searchParams\.(?:set|append)\([^)]*\b${CREDENTIAL}\b`, "g") },
  { why: "URL constructor", pattern: new RegExp(String.raw`new URL\([^)]*\b${CREDENTIAL}\b`, "g") },
  { why: "URL search assignment", pattern: new RegExp(String.raw`\.search\s*=[^;]*\b${CREDENTIAL}\b`, "g") },
  { why: "percent-encoded", pattern: new RegExp(String.raw`encodeURI(?:Component)?\([^)]*\b${CREDENTIAL}\b`, "g") },
  {
    why: "query string in a template",
    pattern: new RegExp("`[^`]*[?&][A-Za-z_]*=\\$\\{[^}]*\\b" + CREDENTIAL + "\\b", "g"),
    raw: true,
  },
  { why: "console output", pattern: new RegExp(String.raw`console\.\w+\([^)]*\b${CREDENTIAL}\b`, "g") },
  { why: "error message", pattern: new RegExp(String.raw`new Error\([^)]*\b${CREDENTIAL}\b`, "g") },
];

// Message text that names a credential ("Enter an API key.", "returned no access_token") is
// copy, not a value, so string literal contents are blanked before matching; template
// literals keep only their `${…}` expressions. Newlines are preserved so line numbers hold.
// The one sink that needs the literal text — `?key=${…}` inside a template — runs on the raw
// source instead.
function blankLiterals(source) {
  const keepNewlines = (text) => text.replace(/[^\n]/g, "");
  return source
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (literal) => `""${keepNewlines(literal)}`)
    .replace(/`(?:[^`\\]|\\.)*`/g, (literal) => {
      const expressions = [...literal.matchAll(/\$\{[^}]*\}/g)].map((match) => match[0]).join("");
      return `\`${expressions}\`${keepNewlines(literal)}`;
    });
}

/** Every credential sink in `source`: line number and what kind of sink it is. */
export function findCredentialSinks(source) {
  const blanked = blankLiterals(source);
  const findings = [];
  for (const { why, pattern, raw } of SINKS) {
    const haystack = raw ? source : blanked;
    for (const match of haystack.matchAll(pattern)) {
      const line = haystack.slice(0, match.index).split("\n").length;
      findings.push({ line, why });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

// --- fixtures: the rule must fail on these ...
const mustFail = [
  {
    name: "key set as a query parameter (the 0.1.1 Google discovery request)",
    code: `const googleUrl = new URL(endpoint(baseUrl, "models"));
googleUrl.searchParams.set("key", options.apiKey);
url = googleUrl.href;`,
    why: "query parameter",
  },
  {
    name: "key interpolated into a URL template",
    code: "const url = `${baseUrl}/models?key=${options.apiKey}`;",
    why: "query string in a template",
  },
  {
    name: "key spread into a URL constructor across lines",
    code: `const url = new URL(
  \`\${base}/models?key=\${apiKey}\`,
);`,
    why: "URL constructor",
  },
  {
    name: "token assigned into url.search",
    code: `url.search = new URLSearchParams({ access_token: accessToken }).toString();`,
    why: "URL search assignment",
  },
  {
    name: "key percent-encoded for a URL",
    code: `const q = encodeURIComponent(settings.apiKey);`,
    why: "percent-encoded",
  },
  {
    name: "key logged",
    code: `console.warn("discovery failed for", apiKey, error);`,
    why: "console output",
  },
  {
    name: "key in an error message",
    code: "throw new Error(`The provider rejected ${apiKey}`);",
    why: "error message",
  },
];

// ... and pass on these.
const mustPass = [
  {
    name: "key sent as a request header",
    code: `headers.set("x-goog-api-key", options.apiKey);
headers.set("Authorization", \`Bearer \${options.apiKey}\`);`,
  },
  {
    name: "error copy that names the concept, not the value",
    code: `if (!options.apiKey) throw new Error("Enter an API key.");`,
  },
  {
    name: "a non-credential query parameter",
    code: `codexUrl.searchParams.set("client_version", CODEX_MODELS_CLIENT_VERSION);`,
  },
  {
    name: "message text that names a wire field",
    code: `if (!tokens.access_token) throw new Error("Token refresh returned no access_token.");
console.warn("the id_token carried no account claim");`,
  },
  {
    name: "a token in a POST body",
    code: `const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: auth.refreshToken });
await fetch(url, { method: "POST", body });`,
  },
];

let fixtureFailures = 0;
for (const { name, code, why } of mustFail) {
  const hit = findCredentialSinks(code);
  if (!hit.some((finding) => finding.why === why)) {
    console.error(`fixture not caught: ${name} (expected ${why}, got ${JSON.stringify(hit)})`);
    fixtureFailures += 1;
  }
}
for (const { name, code } of mustPass) {
  const hit = findCredentialSinks(code);
  if (hit.length > 0) {
    console.error(`fixture wrongly flagged: ${name} (${JSON.stringify(hit)})`);
    fixtureFailures += 1;
  }
}
if (fixtureFailures > 0) {
  console.error(`provider key boundary: ${fixtureFailures} fixture(s) failed; the rule itself is broken`);
  process.exit(1);
}

// --- the source tree.
async function sources(directory) {
  const entries = await readdir(directory, { recursive: true });
  return entries.filter((entry) => /\.tsx?$/.test(entry)).map((entry) => path.join(directory, entry));
}

const boundaryFiles = ["src/shared/protocol.ts", ...(await sources("src/bridge")), ...(await sources("src/worker"))];
const problems = [];
for (const file of boundaryFiles) {
  const source = await readFile(file, "utf8");
  if (/\bapiKey\b|\bproviderSettings\b/.test(source)) problems.push(`${file}: references a provider key outside the panel`);
}
for (const file of await sources("src")) {
  const source = await readFile(file, "utf8");
  for (const { line, why } of findCredentialSinks(source)) problems.push(`${file}:${line}: credential in a ${why}`);
}

if (problems.length > 0) {
  console.error("Provider credentials must stay panel-local and out of URLs, logs and errors:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`provider key boundary: panel-local, no URL/log/error sinks (${boundaryFiles.length} boundary files)`);
}
