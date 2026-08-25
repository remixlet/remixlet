// Display-only rendering of a script awaiting approval: pretty-printed with
// the prettier standalone bundle already used at the write boundary
// (tools/format.ts) and highlighted with the slim shiki bundle (build.mjs
// resolves bare "shiki" there). What executes is always the exact string the
// agent sent — if prettier can't parse it, that string is shown verbatim.
//
// The css-variables theme emits colors as var(--shiki-token-*) references,
// mapped onto the brand palette in styles.css so dark mode tracks for free.
import { useEffect, useState } from "react";
import { codeToTokens, createCssVariablesTheme, type ThemedToken } from "shiki";
import * as prettier from "prettier/standalone";
import * as pluginBabel from "prettier/plugins/babel";
import * as pluginEstree from "prettier/plugins/estree";

const cssVariablesTheme = createCssVariablesTheme({ name: "css-variables" });

// The side panel is narrow; 60 columns keeps formatted lines visible without
// horizontal scrolling in most cases.
const PRINT_WIDTH = 60;

export function ScriptCode({ code }: { code: string }) {
  const [display, setDisplay] = useState(code);
  const [lines, setLines] = useState<ThemedToken[][] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDisplay(code);
    setLines(null);
    void (async () => {
      let formatted = code;
      try {
        formatted = (
          await prettier.format(code, {
            parser: "babel",
            plugins: [pluginBabel, pluginEstree],
            printWidth: PRINT_WIDTH,
          })
        ).trimEnd();
      } catch {
        // Not parseable as JS — show the raw string; the dialog still gates it.
      }
      let tokens: ThemedToken[][] | null = null;
      try {
        tokens = (await codeToTokens(formatted, { lang: "javascript", theme: cssVariablesTheme })).tokens;
      } catch {
        // Highlighting is cosmetic; plain text is fine.
      }
      if (cancelled) return;
      setDisplay(formatted);
      setLines(tokens);
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (!lines) return <>{display}</>;
  return (
    <>
      {lines.map((line, lineIndex) => (
        <span key={lineIndex}>
          {line.map((token, tokenIndex) => (
            <span key={tokenIndex} style={{ color: token.color }}>
              {token.content}
            </span>
          ))}
          {"\n"}
        </span>
      ))}
    </>
  );
}
