// Prettier at the write boundary: every file set the agent saves through
// write_remixlet is formatted before it reaches the worker, so the store only
// ever holds readable code and version-to-version diffs stay line-oriented.
// A file that fails to parse rejects the whole write — shipping it would only
// defer the failure to the reloaded tab, where the agent has to fish it back
// out of read_remixlet_logs.
import * as prettier from "prettier/standalone";
import * as pluginBabel from "prettier/plugins/babel";
import * as pluginEstree from "prettier/plugins/estree";
import * as pluginMarkdown from "prettier/plugins/markdown";
import * as pluginPostcss from "prettier/plugins/postcss";

const PLUGINS = [pluginBabel, pluginEstree, pluginMarkdown, pluginPostcss];

function parserFor(path: string): string | undefined {
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "babel";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  return undefined;
}

// A file whose name reads as JavaScript/TypeScript source but has no parser
// here (.jsx, .ts, .cjs, …). Passing it through unformatted would skip the only
// syntax gate before injection, so such a file fails the write closed rather
// than shipping unchecked — the worker enforces the same rule at the manifest
// boundary (shared/remixlet.ts isSupportedScriptFile). Plain data files
// (notes.txt, a .yml) are not script-shaped and still pass through untouched.
function looksLikeUnparsableScript(path: string): boolean {
  return /\.[cm]?[jt]sx?$/i.test(path) && parserFor(path) === undefined;
}

export interface RemixletFile {
  path: string;
  content: string;
}

export async function formatRemixletFiles(files: RemixletFile[]): Promise<RemixletFile[]> {
  return Promise.all(
    files.map(async ({ path, content }) => {
      if (looksLikeUnparsableScript(path)) {
        throw new Error(
          `${path} has an unsupported script extension (nothing was saved): scripts must be .js or .mjs so they can be ` +
            "syntax-checked before activation",
        );
      }
      const parser = parserFor(path);
      if (parser === undefined) return { path, content };
      try {
        return { path, content: await prettier.format(content, { parser, plugins: PLUGINS }) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${path} does not parse (nothing was saved): ${message}`);
      }
    }),
  );
}
