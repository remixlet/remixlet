import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const eslint = new ESLint({ cwd: root });

const cases = [
  {
    name: "rejects chrome runtime access",
    filePath: "src/worker/lint-fixture.ts",
    code: "chrome.runtime.reload();",
    errors: 1,
  },
  {
    name: "rejects browser runtime access",
    filePath: "src/worker/lint-fixture.ts",
    code: "void browser.tabs.query({});",
    errors: 1,
  },
  {
    name: "allows type-only chrome namespace access",
    filePath: "src/worker/lint-fixture.ts",
    code: "type Runtime = typeof chrome.runtime;",
    errors: 0,
  },
  {
    name: "still rejects runtime access inside a TypeScript cast",
    filePath: "src/worker/lint-fixture.ts",
    code: "const runtime = chrome.runtime as unknown;",
    errors: 1,
  },
  {
    name: "ignores generated bridge source strings",
    filePath: "src/bridge/lint-fixture.ts",
    code: 'export const bridge = "chrome.runtime.sendMessage({});";',
    errors: 0,
  },
  {
    name: "allows platform runtime access",
    filePath: "src/platform/lint-fixture.ts",
    code: "export const runtime = chrome.runtime;",
    errors: 0,
  },
];

for (const fixture of cases) {
  const [result] = await eslint.lintText(fixture.code, { filePath: fixture.filePath });
  assert(result, `${fixture.name}: ESLint returned no result`);
  assert.equal(
    result.errorCount,
    fixture.errors,
    `${fixture.name}: ${result.messages.map((message) => message.message).join("; ")}`,
  );
}

console.log("DONE — platform-boundary lint fixtures");
