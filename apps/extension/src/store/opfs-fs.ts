// OPFS-backed filesystem implementing isomorphic-git's FsClient promise
// interface. Every remixlet's git history, capture bundles, and session logs
// live behind this (wiki/handoff.md §6). Validated at M0: see
// wiki/design/spike-b-git-opfs.md for latency numbers and design notes.
//
// Callers in bundles that touch isomorphic-git must install the Buffer global
// first: `import { Buffer } from "buffer"; globalThis.Buffer ??= Buffer;`

export interface FsStat {
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  ino: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** The subset of node:fs/promises that isomorphic-git requires (FsClient). */
export interface FsPromises {
  readFile(filepath: string, opts?: FsEncoding): Promise<string | Uint8Array>;
  writeFile(filepath: string, data: string | Uint8Array, opts?: FsEncoding): Promise<void>;
  unlink(filepath: string): Promise<void>;
  readdir(filepath: string): Promise<string[]>;
  mkdir(filepath: string): Promise<void>;
  rmdir(filepath: string): Promise<void>;
  stat(filepath: string): Promise<FsStat>;
  lstat(filepath: string): Promise<FsStat>;
  readlink(filepath: string): Promise<never>;
  symlink(target: string, filepath: string): Promise<never>;
}

export type FsEncoding = "utf8" | { encoding?: "utf8" } | undefined | null;

// TS's DOM lib doesn't yet type the async-iteration members of
// FileSystemDirectoryHandle (supported in every OPFS implementation).
declare global {
  interface FileSystemDirectoryHandle {
    keys(): AsyncIterableIterator<string>;
  }
}

export interface FsError extends Error {
  code: "ENOENT" | "ENOTDIR" | "EISDIR" | "ENOTEMPTY" | "ENOSYS";
}

function fsError(code: FsError["code"], path: string): FsError {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

export function isFsError(cause: unknown, code: FsError["code"]): cause is FsError {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

function segments(filepath: string): string[] {
  return filepath.split("/").filter((s) => s.length > 0 && s !== ".");
}

const FILE_MODE = 0o100644;
const DIR_MODE = 0o40000;

/**
 * OPFS FsClient. One instance per execution context; safe for our access
 * pattern (a single writer per repo — the activation pipeline serializes).
 *
 * Design notes (validated in the M0 benchmark):
 * - Directory handles are cached; invalidated on rmdir.
 * - stat() uses OPFS's real `File.size`/`lastModified`, so isomorphic-git's
 *   index stat-caching works without fake-mtime hacks.
 * - OPFS has no symlinks: readlink/symlink throw ENOSYS. isomorphic-git only
 *   calls them for symlink modes, which our trees never contain.
 */
export class OpfsFs {
  #root: FileSystemDirectoryHandle | undefined;
  #dirCache = new Map<string, FileSystemDirectoryHandle>();

  readonly promises: FsPromises = {
    readFile: (p, o) => this.#readFile(p, o),
    writeFile: (p, d) => this.#writeFile(p, d),
    unlink: (p) => this.#unlink(p),
    readdir: (p) => this.#readdir(p),
    mkdir: (p) => this.#mkdir(p),
    rmdir: (p) => this.#rmdir(p),
    stat: (p) => this.#stat(p),
    lstat: (p) => this.#stat(p),
    readlink: async (p) => {
      throw fsError("ENOSYS", p);
    },
    symlink: async (_t, p) => {
      throw fsError("ENOSYS", p);
    },
  };

  async #getRoot(): Promise<FileSystemDirectoryHandle> {
    this.#root ??= await navigator.storage.getDirectory();
    return this.#root;
  }

  /** Remove a top-level directory tree (test cleanup / hard reset). */
  async removeTree(topLevelDir: string): Promise<void> {
    const name = segments(topLevelDir)[0];
    if (!name) return;
    try {
      await (await this.#getRoot()).removeEntry(name, { recursive: true });
    } catch {
      /* did not exist */
    }
    this.#dirCache.clear();
  }

  async #dir(path: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
    const key = path.join("/");
    const cached = this.#dirCache.get(key);
    if (cached) return cached;
    let handle = await this.#getRoot();
    for (const name of path) {
      try {
        handle = await handle.getDirectoryHandle(name, { create });
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "TypeMismatchError") throw fsError("ENOTDIR", key);
        throw fsError("ENOENT", key);
      }
    }
    this.#dirCache.set(key, handle);
    return handle;
  }

  async #fileHandle(filepath: string, create: boolean): Promise<FileSystemFileHandle> {
    const path = segments(filepath);
    const name = path.pop();
    if (!name) throw fsError("ENOENT", filepath);
    const dir = await this.#dir(path, create);
    try {
      return await dir.getFileHandle(name, { create });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "TypeMismatchError") throw fsError("EISDIR", filepath);
      throw fsError("ENOENT", filepath);
    }
  }

  async #readFile(filepath: string, opts?: FsEncoding): Promise<string | Uint8Array> {
    const handle = await this.#fileHandle(filepath, false);
    const file = await handle.getFile();
    const utf8 = opts === "utf8" || (opts !== undefined && opts !== null && opts.encoding === "utf8");
    return utf8 ? file.text() : new Uint8Array(await file.arrayBuffer());
  }

  async #writeFile(filepath: string, data: string | Uint8Array): Promise<void> {
    const handle = await this.#fileHandle(filepath, true);
    const writable = await handle.createWritable();
    // Copy into a fresh ArrayBuffer-backed view: DOM types reject SharedArrayBuffer-backed views.
    await writable.write(data instanceof Uint8Array ? new Uint8Array(data).buffer : data);
    await writable.close();
  }

  async #unlink(filepath: string): Promise<void> {
    const path = segments(filepath);
    const name = path.pop();
    if (!name) throw fsError("ENOENT", filepath);
    const dir = await this.#dir(path, false);
    try {
      await dir.removeEntry(name);
    } catch {
      throw fsError("ENOENT", filepath);
    }
  }

  async #readdir(filepath: string): Promise<string[]> {
    const dir = await this.#dir(segments(filepath), false);
    const names: string[] = [];
    for await (const name of dir.keys()) names.push(name);
    return names;
  }

  async #mkdir(filepath: string): Promise<void> {
    await this.#dir(segments(filepath), true);
  }

  async #rmdir(filepath: string): Promise<void> {
    const path = segments(filepath);
    const name = path.pop();
    if (!name) throw fsError("ENOENT", filepath);
    const dir = await this.#dir(path, false);
    try {
      await dir.removeEntry(name);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "InvalidModificationError") throw fsError("ENOTEMPTY", filepath);
      throw fsError("ENOENT", filepath);
    }
    const removedKey = [...path, name].join("/");
    for (const key of this.#dirCache.keys()) {
      if (key === removedKey || key.startsWith(removedKey + "/")) this.#dirCache.delete(key);
    }
  }

  async #stat(filepath: string): Promise<FsStat> {
    const path = segments(filepath);
    if (path.length === 0) return statResult(DIR_MODE, 0, 0);
    const name = path.pop()!;
    const dir = await this.#dir(path, false);
    try {
      const handle = await dir.getFileHandle(name);
      const file = await handle.getFile();
      return statResult(FILE_MODE, file.size, file.lastModified);
    } catch {
      try {
        await dir.getDirectoryHandle(name);
        return statResult(DIR_MODE, 0, 0);
      } catch {
        throw fsError("ENOENT", filepath);
      }
    }
  }
}

function statResult(mode: number, size: number, mtimeMs: number): FsStat {
  return {
    mode,
    size,
    mtimeMs,
    ctimeMs: mtimeMs,
    uid: 0,
    gid: 0,
    dev: 1,
    ino: 0,
    isFile: () => mode === FILE_MODE,
    isDirectory: () => mode === DIR_MODE,
    isSymbolicLink: () => false,
  };
}
