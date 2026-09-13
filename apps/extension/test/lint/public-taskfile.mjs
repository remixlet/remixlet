// The public Taskfile is maintained as an export overlay. Keep its pnpm
// commands tied to scripts that still exist in the exported package.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const taskfilePath = path.join(repoRoot, "publish", "overlay", "Taskfile.yml");

const taskfile = await readFile(taskfilePath, "utf8").catch((error) => {
  if (error?.code === "ENOENT") return undefined;
  throw error;
});

if (taskfile !== undefined) {
  const packageJson = JSON.parse(await readFile(path.join(repoRoot, "apps", "extension", "package.json"), "utf8"));
  const scripts = new Set(Object.keys(packageJson.scripts ?? {}));
  const commands = [...taskfile.matchAll(/^\s+- pnpm ([^\s]+)\s*$/gm)].map((match) => match[1]);
  const missing = commands.filter((command) => command !== "install" && !scripts.has(command));

  assert.deepEqual(missing, [], `public Taskfile calls missing package scripts: ${missing.join(", ")}`);
  console.log(`public Taskfile: ${commands.length} pnpm command(s) resolve`);
}
