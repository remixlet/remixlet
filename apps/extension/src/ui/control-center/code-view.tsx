// Source viewers shared across the remixlet page (@pierre/diffs +
// @pierre/trees): colored line diffs, and a file-tree-beside-source browser
// for the full contents of any committed version.

import { useEffect, useMemo, useState } from "react";
import { parseDiffFromFile } from "@pierre/diffs";
import { File as PierreFile, FileDiff as PierreFileDiff } from "@pierre/diffs/react";
import { FileTree, useFileTree } from "@pierre/trees/react";

import { send } from "./send.js";

export interface DiffFile {
  path: string;
  before?: string;
  after?: string;
}

// The stored theme preference can diverge from the OS scheme, so pierre's
// 'system' themeType (which follows the OS) is not enough: read the resolved
// theme off the design system's .dark class, which followThemePreference()
// maintains, and re-render when it flips.
function usePierreOptions(): { themeType: "light" | "dark" } {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.classList.contains("dark")));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return useMemo(() => ({ themeType: dark ? "dark" : "light" }), [dark]);
}

export function FileDiff({ file }: { file: DiffFile }) {
  const pierreOptions = usePierreOptions();
  const fileDiff = useMemo(
    () =>
      parseDiffFromFile(
        { name: file.path, contents: file.before ?? "" },
        { name: file.path, contents: file.after ?? "" },
      ),
    [file],
  );
  return (
    <div className="diff-file overflow-hidden rounded-lg border" data-path={file.path}>
      <PierreFileDiff fileDiff={fileDiff} options={pierreOptions} />
    </div>
  );
}

// One version's full source: file tree beside a syntax-highlighted viewer.
// height "100%" fills the parent (which must have a resolved height); any
// other value is a fixed box, as used inside the history list.
export function VersionCodeBrowser({ files, height = "20rem" }: { files: Record<string, string>; height?: string }) {
  const pierreOptions = usePierreOptions();
  const paths = useMemo(() => Object.keys(files).sort((a, b) => a.localeCompare(b)), [files]);
  const [selected, setSelected] = useState<string | undefined>(paths[0]);
  const { model } = useFileTree({
    paths,
    initialExpansion: "open",
    onSelectionChange: (selectedPaths) => {
      const file = selectedPaths.find((path) => files[path] !== undefined);
      if (file !== undefined) setSelected(file);
    },
  });
  return (
    <div
      className="version-code grid grid-cols-[10rem_minmax(0,1fr)] overflow-hidden rounded-lg border sm:grid-cols-[12rem_minmax(0,1fr)]"
      style={{ height }}
    >
      <FileTree model={model} className="border-r" style={{ height: "100%" }} />
      <div className="version-code-file h-full overflow-auto" data-path={selected}>
        {selected !== undefined && (
          <PierreFile key={selected} file={{ name: selected, contents: files[selected] ?? "" }} options={pierreOptions} />
        )}
      </div>
    </div>
  );
}

export function VersionCode({ id, sha, height }: { id: string; sha: string; height?: string }) {
  const [files, setFiles] = useState<Record<string, string> | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    void send({ kind: "remixlet.filesAt", id, sha }, "remixlet.filesAtResult")
      .then((reply) => setFiles(reply.files))
      .catch((cause: unknown) => setError(String(cause)));
  }, [id, sha]);
  if (error !== undefined) return <p className="text-xs text-destructive">Couldn’t load code: {error}</p>;
  if (!files) return <p className="text-xs text-muted-foreground">Loading code…</p>;
  return <VersionCodeBrowser files={files} height={height} />;
}
