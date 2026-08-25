// Session JSONL location, split from conversation-session.ts so read-only
// consumers (conversation-log.ts, and through it the control center) can
// resolve paths without dragging the pi runtime into their bundle.
//
// pi's JsonlSessionRepo owns the layout under SESSIONS_DIR: one directory per
// encoded cwd (ours is always "/", encoded "----") holding
// <timestamp>_<id>.jsonl files. We never construct those paths ourselves —
// finding a conversation's file is a directory scan for the id suffix.

import { isFsError, type OpfsFs } from "../store/opfs-fs.js";

export const SESSIONS_DIR = "sessions";

export const assertConversationId = (conversationId: string): void => {
  // Mirrors pi's session-id rules (alphanumeric plus - _ ., alphanumeric at
  // the ends) so a bad id fails here, not deep inside the repo.
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(conversationId)) {
    throw new Error(`invalid conversation id: ${conversationId}`);
  }
};

/** The conversation's JSONL path, or undefined when it has no file yet. */
export async function findSessionFile(conversationId: string, fs: OpfsFs): Promise<string | undefined> {
  assertConversationId(conversationId);
  const suffix = `_${conversationId}.jsonl`;
  let cwdDirs: string[];
  try {
    cwdDirs = await fs.promises.readdir(SESSIONS_DIR);
  } catch (error) {
    if (isFsError(error, "ENOENT")) return undefined;
    throw error;
  }
  for (const dir of cwdDirs) {
    let files: string[];
    try {
      files = await fs.promises.readdir(`${SESSIONS_DIR}/${dir}`);
    } catch {
      continue; // a stray file (e.g. a pre-launch flat session) — not a cwd dir
    }
    const name = files.find((file) => file.endsWith(suffix));
    if (name) return `${SESSIONS_DIR}/${dir}/${name}`;
  }
  return undefined;
}
