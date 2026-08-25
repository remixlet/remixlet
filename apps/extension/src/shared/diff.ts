// Line diff for the history UI's colored diffs (wiki/plan.md §3 M3). Plain
// LCS over lines — remixlet files are small (the store suite works at "few
// files, tens of commits" scale), so the O(n·m) table is nothing. Pure module,
// no extension APIs; rendering (colors) is the UI's job.

export interface DiffLine {
  kind: "same" | "add" | "del";
  text: string;
}

/** Line-based diff from `before` to `after`: del lines left, add lines arrived. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);

  // Trim common prefix/suffix — the typical remixlet edit touches a few lines.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  const out: DiffLine[] = [];
  for (const text of a.slice(0, start)) out.push({ kind: "same", text });
  out.push(...diffCore(midA, midB));
  for (const text of a.slice(endA)) out.push({ kind: "same", text });
  return out;
}

export interface DiffStats {
  added: number;
  removed: number;
}

export function diffStats(lines: readonly DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added += 1;
    else if (line.kind === "del") removed += 1;
  }
  return { added, removed };
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split("\n");
}

function diffCore(a: string[], b: string[]): DiffLine[] {
  // Degenerate cases first — they cover whole-file adds/removes.
  if (a.length === 0) return b.map((text) => ({ kind: "add" as const, text }));
  if (b.length === 0) return a.map((text) => ({ kind: "del" as const, text }));

  // LCS length table; guard against pathological sizes with a replace-all
  // fallback (still a correct diff, just not minimal).
  if (a.length * b.length > 4_000_000) {
    return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))];
  }
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      out.push({ kind: "del", text: a[i]! });
      i += 1;
    } else {
      out.push({ kind: "add", text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++]! });
  while (j < b.length) out.push({ kind: "add", text: b[j++]! });
  return out;
}
