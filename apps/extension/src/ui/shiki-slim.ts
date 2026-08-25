// Slim shiki bundle for @pierre/diffs (build.mjs resolves bare "shiki"
// imports here). The real "shiki" entry point registers every bundled
// grammar, and esbuild inlines all of them (~10MB of manager.js for
// languages a remixlet can never contain). Remixlets are web artifacts —
// manifest.json plus JS/CSS/HTML — so only web-relevant grammars ship.
//
// Rendering always uses the JavaScript regex engine (@pierre/diffs defaults
// to preferredHighlighter "shiki-js", and nothing in this codebase asks for
// "shiki-wasm"), so the oniguruma/WASM engine is a throwing stub instead of
// half a megabyte of bundled engine.

export * from "shiki/core";
export { createJavaScriptRegexEngine } from "shiki/engine/javascript";

import { createBundledHighlighter, createSingletonShorthands, guessEmbeddedLanguages } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

type LanguageModule = typeof import("@shikijs/langs/javascript");
type LanguageLoader = () => Promise<LanguageModule>;

const grammars: [id: string, aliases: string[], load: LanguageLoader][] = [
  ["javascript", ["js"], () => import("@shikijs/langs/javascript")],
  ["jsx", [], () => import("@shikijs/langs/jsx")],
  ["typescript", ["ts"], () => import("@shikijs/langs/typescript")],
  ["tsx", [], () => import("@shikijs/langs/tsx")],
  ["css", [], () => import("@shikijs/langs/css")],
  ["html", [], () => import("@shikijs/langs/html")],
  ["json", [], () => import("@shikijs/langs/json")],
  ["markdown", ["md"], () => import("@shikijs/langs/markdown")],
  ["xml", [], () => import("@shikijs/langs/xml")],
  ["yaml", ["yml"], () => import("@shikijs/langs/yaml")],
];

export const bundledLanguages = Object.fromEntries(
  grammars.flatMap(([id, aliases, load]) => [id, ...aliases].map((name) => [name, load])),
);

export function createOnigurumaEngine(): never {
  throw new Error('the WASM engine is not bundled — only the JavaScript engine ("shiki-js") is available');
}

export const createHighlighter = createBundledHighlighter<string, string>({
  // SAFETY: Shiki's generic language map accepts these bundled language loaders.
  langs: bundledLanguages as never,
  themes: {},
  engine: () => createJavaScriptRegexEngine(),
});

export const {
  codeToHtml,
  codeToHast,
  codeToTokens,
  codeToTokensBase,
  codeToTokensWithThemes,
  getSingletonHighlighter,
  getLastGrammarState,
} = /* @__PURE__ */ createSingletonShorthands<string, string>(createHighlighter, { guessEmbeddedLanguages });
