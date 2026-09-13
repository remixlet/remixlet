// The remixlet's front page: README.md rendered as a document. The agent
// maintains the file on every write (agent/contracts.ts requires it), so this
// is where a person — or a future conversation — learns what the remixlet is
// supposed to do without reading code. Remixlets written before the
// requirement existed have no README; they get a quiet explanation instead.

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { README_FILE } from "../../shared/remixlet.js";
import { send } from "./send.js";

export function ReadmeView({ id, sha }: { id: string; sha: string }) {
  const [files, setFiles] = useState<Record<string, string> | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    void send({ kind: "remixlet.filesAt", id, sha }, "remixlet.filesAtResult")
      .then((reply) => setFiles(reply.files))
      .catch((cause: unknown) => setError(String(cause)));
  }, [id, sha]);
  if (error !== undefined) return <p className="text-xs text-destructive">Couldn’t load the README: {error}</p>;
  if (!files) return <p className="text-xs text-muted-foreground">Loading…</p>;
  const readme = files[README_FILE]?.trim() ?? "";
  if (readme === "") {
    return (
      <p className="readme-missing text-sm text-muted-foreground">
        This remixlet was made before READMEs existed, so it has none yet. The next time you ask for a change, one
        will be written along with it.
      </p>
    );
  }
  return (
    <div className="readme-doc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Belt-and-braces over the manifest CSP (H4): a README is model/author
        // content rendered in the privileged manager tab. Drop remote images
        // (zero-click exfil beacon), and force links out into a new tab so a
        // README link can't navigate the manager away.
        disallowedElements={["img"]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {readme}
      </ReactMarkdown>
    </div>
  );
}
