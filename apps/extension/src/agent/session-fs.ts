// pi's JSONL session repo writes against an injectable FileSystem slice
// (JsonlSessionRepoFileSystem — spike-a §6 said this seam exists so OPFS
// slots in without forking upstream; it does). This adapter backs that slice
// with the same tested OpfsFs the stores use.
//
// Lives in src/agent/ because pi types (Result, FileError) may not leak
// outside it — nothing here is exported to product code.

import { FileError, err, ok, type FileInfo, type JsonlSessionRepoFileSystem, type Result } from "@earendil-works/pi-agent-core";
import { isFsError, OpfsFs } from "../store/opfs-fs.js";

function toFileError(cause: unknown, path: string): FileError {
  if (isFsError(cause, "ENOENT")) return new FileError("not_found", `not found: ${path}`, path);
  if (isFsError(cause, "ENOTDIR")) return new FileError("not_directory", `not a directory: ${path}`, path);
  if (isFsError(cause, "EISDIR")) return new FileError("is_directory", `is a directory: ${path}`, path);
  return new FileError("unknown", cause instanceof Error ? cause.message : String(cause), path);
}

const text = (content: string | Uint8Array): string =>
  content instanceof Uint8Array ? new TextDecoder().decode(content) : content;

/** OPFS paths are rooted at "/"; normalize to "/a/b" with no trailing slash. */
const normalize = (path: string): string => `/${path.split("/").filter((s) => s.length > 0 && s !== ".").join("/")}`;

const basename = (path: string): string => normalize(path).split("/").at(-1) ?? "";

/**
 * Appends are read-modify-write: OPFS writables replace file contents, and at
 * conversation scale (KBs per session, one append per message) that is well
 * inside budget. Callers already serialize appends per session file.
 */
export function createSessionFs(fs: OpfsFs): JsonlSessionRepoFileSystem {
  const fileInfo = async (path: string): Promise<Result<FileInfo, FileError>> => {
    try {
      const stat = await fs.promises.stat(path);
      return ok({
        name: basename(path),
        path: normalize(path),
        kind: stat.isDirectory() ? ("directory" as const) : ("file" as const),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    } catch (error) {
      return err(toFileError(error, path));
    }
  };

  return {
    async absolutePath(path) {
      return ok(normalize(path));
    },
    async joinPath(parts) {
      return ok(normalize(parts.join("/")));
    },
    async readTextFile(path) {
      try {
        // SAFETY: OpfsFs returns text when the requested encoding is "utf8".
        return ok((await fs.promises.readFile(path, "utf8")) as string);
      } catch (error) {
        return err(toFileError(error, path));
      }
    },
    async readTextLines(path, options) {
      try {
        // SAFETY: OpfsFs returns text when the requested encoding is "utf8".
        const lines = ((await fs.promises.readFile(path, "utf8")) as string).split("\n");
        if (lines.at(-1) === "") lines.pop();
        return ok(options?.maxLines !== undefined ? lines.slice(0, options.maxLines) : lines);
      } catch (error) {
        return err(toFileError(error, path));
      }
    },
    async writeFile(path, content) {
      try {
        await fs.promises.writeFile(path, text(content));
        return ok(undefined);
      } catch (error) {
        return err(toFileError(error, path));
      }
    },
    async appendFile(path, content) {
      try {
        let existing = "";
        try {
          // SAFETY: OpfsFs returns text when the requested encoding is "utf8".
          existing = (await fs.promises.readFile(path, "utf8")) as string;
        } catch (error) {
          if (!isFsError(error, "ENOENT")) throw error;
        }
        await fs.promises.writeFile(path, existing + text(content));
        return ok(undefined);
      } catch (error) {
        return err(toFileError(error, path));
      }
    },
    // OPFS has no rename; copy-then-delete is atomic enough here because the
    // repo serializes publications to a destination and the write itself is
    // a single OPFS writable close.
    async renameFile(sourcePath, destinationPath) {
      try {
        // SAFETY: OpfsFs returns text when the requested encoding is "utf8".
        const content = (await fs.promises.readFile(sourcePath, "utf8")) as string;
        await fs.promises.writeFile(destinationPath, content);
        await fs.promises.unlink(sourcePath);
        return ok(undefined);
      } catch (error) {
        return err(toFileError(error, sourcePath));
      }
    },
    fileInfo,
    async listDir(path) {
      try {
        const names = await fs.promises.readdir(path);
        const entries: FileInfo[] = [];
        for (const name of names) {
          const info = await fileInfo(`${normalize(path)}/${name}`);
          if (info.ok) entries.push(info.value);
        }
        return ok(entries);
      } catch (error) {
        return err(toFileError(error, path));
      }
    },
    async exists(path) {
      try {
        await fs.promises.stat(path);
        return ok(true);
      } catch (error) {
        if (isFsError(error, "ENOENT")) return ok(false);
        return err(toFileError(error, path));
      }
    },
    // OpfsFs mkdir creates the whole chain, so `recursive` needs no branching.
    async createDir(path) {
      try {
        await fs.promises.mkdir(path);
        return ok(undefined);
      } catch (error) {
        return err(toFileError(error, path));
      }
    },
    async remove(path, options) {
      try {
        await fs.promises.unlink(path);
        return ok(undefined);
      } catch (error) {
        if (options?.force && isFsError(error, "ENOENT")) return ok(undefined);
        return err(toFileError(error, path));
      }
    },
  };
}
