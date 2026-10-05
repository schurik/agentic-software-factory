/**
 * A diff as the forge prints it, read into what the viewer draws: one entry
 * per file, saying what became of it, each line numbered on the side it is
 * on, and a changed line paired with the one it replaced so the words that
 * changed can be marked. jsdiff reads git's headers (new, deleted, renamed,
 * binary); nothing here guesses at them.
 */
import { diffWordsWithSpace, parsePatch, type StructuredPatch, type StructuredPatchHunk } from "diff";

export type Change = "added" | "deleted" | "renamed" | "modified";

export interface Line {
  sign: " " | "+" | "-";
  text: string;
  /** Its number before and after, null on the side it is not on. */
  old: number | null;
  new: number | null;
  /** The line it replaced, or was replaced by, when a run of removals meets a run of additions. */
  pair: string | null;
}

export interface Hunk {
  header: string;
  lines: Line[];
}

export interface DiffFile {
  path: string;
  /** What it was called before, when it was renamed. */
  from: string | null;
  change: Change;
  binary: boolean;
  hunks: Hunk[];
  added: number;
  removed: number;
}

/** The files `text` changes, in the order the forge printed them; [] for an empty diff. */
export function filesOf(text: string): DiffFile[] {
  if (!text.trim()) return [];
  return parsePatch(text).map(fileOf);
}

/** Whether a file is prose, which wraps, rather than code, which keeps its columns. */
export const isProse = (path: string) => /\.(md|markdown|txt)$/i.test(path);

/** A word of a changed line, and whether it is what changed. */
export interface Word {
  text: string;
  changed: boolean;
}

/** `line`'s words, the ones that differ from the line it is paired with marked; null when it has no pair to differ from. */
export function wordsOf(line: Line): Word[] | null {
  if (line.pair === null || line.sign === " ") return null;
  const [before, after] = line.sign === "-" ? [line.text, line.pair] : [line.pair, line.text];
  return diffWordsWithSpace(before, after)
    .filter((part) => (line.sign === "-" ? !part.added : !part.removed))
    .map((part) => ({ text: part.value, changed: line.sign === "-" ? part.removed : part.added }));
}

function fileOf(patch: StructuredPatch): DiffFile {
  const [before, after] = [unprefixed(patch.oldFileName), unprefixed(patch.newFileName)];
  const change: Change = patch.isCreate || before === null ? "added"
    : patch.isDelete || after === null ? "deleted"
    : patch.isRename || before !== after ? "renamed" : "modified";
  const hunks = patch.hunks.map(hunkOf);
  const count = (sign: Line["sign"]) => hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => line.sign === sign).length, 0);
  return {
    path: (change === "deleted" ? before : after) ?? before ?? "",
    from: change === "renamed" ? before : null,
    change, binary: patch.isBinary === true, hunks, added: count("+"), removed: count("-"),
  };
}

/** A file's name without git's `a/` or `b/`, or null for `/dev/null`: the side it is not on. */
function unprefixed(name: string | undefined): string | null {
  if (!name || name === "/dev/null") return null;
  return name.replace(/^[ab]\//, "");
}

function hunkOf(hunk: StructuredPatchHunk): Hunk {
  let [old, numbered] = [hunk.oldStart, hunk.newStart];
  const lines: Line[] = hunk.lines
    // "\ No newline at end of file" is about the line before it, not a line.
    .filter((line) => !line.startsWith("\\"))
    .map((line) => {
      const sign = line[0] === "+" || line[0] === "-" ? line[0] : " ";
      const text = line.slice(1);
      if (sign === "+") return { sign, text, old: null, new: numbered++, pair: null };
      if (sign === "-") return { sign, text, old: old++, new: null, pair: null };
      return { sign, text, old: old++, new: numbered++, pair: null };
    });
  pair(lines);
  return { header: `@@ -${side(hunk.oldStart, hunk.oldLines)} +${side(hunk.newStart, hunk.newLines)} @@`, lines };
}

/**
 * A side of a hunk's header as git writes it: a count of one left out, and an
 * empty side at the line before it — jsdiff reads "-0,0" as starting at 1.
 */
function side(start: number, count: number): string {
  if (count === 0) return `${start - 1},0`;
  return count === 1 ? `${start}` : `${start},${count}`;
}

/** Pair each run of removed lines with the run of added lines right after it, line by line. */
function pair(lines: Line[]): void {
  for (let at = 0; at < lines.length; at += 1) {
    if (lines[at].sign !== "-") continue;
    let added = at;
    while (added < lines.length && lines[added].sign === "-") added += 1;
    let end = added;
    while (end < lines.length && lines[end].sign === "+") end += 1;
    for (let each = 0; each < Math.min(added - at, end - added); each += 1) {
      lines[at + each].pair = lines[added + each].text;
      lines[added + each].pair = lines[at + each].text;
    }
    at = end - 1;
  }
}
