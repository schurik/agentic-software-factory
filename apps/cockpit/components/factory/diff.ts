/**
 * The diff preview of a config edit: a unified diff of one file's text before
 * and after, as `git diff` would print it — what the pull request will show.
 * Small files, so the plain longest-common-subsequence table does, once the
 * lines both ends share are set aside.
 */

const CONTEXT = 3;
/** Past this many cells, the middle that changed is shown as removed and added whole rather than matched up. */
const MOST_CELLS = 4_000_000;

type Op = { sign: " " | "-" | "+"; line: string };

/** A unified diff of `before` and `after`, the file at `path`; empty when they are the same. */
export function unified(path: string, before: string, after: string): string {
  if (before === after) return "";
  const ops = script(lines(before), lines(after));
  const changes = ops.flatMap((op, at) => (op.sign === " " ? [] : [at]));
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (let first = 0; first < changes.length;) {
    let last = first;
    while (last + 1 < changes.length && changes[last + 1] - changes[last] - 1 <= 2 * CONTEXT) last += 1;
    const from = Math.max(0, changes[first] - CONTEXT);
    const to = Math.min(ops.length, changes[last] + CONTEXT + 1);
    const prior = ops.slice(0, from);
    const hunk = ops.slice(from, to);
    const old = range(prior.filter((op) => op.sign !== "+").length, hunk.filter((op) => op.sign !== "+").length);
    const now = range(prior.filter((op) => op.sign !== "-").length, hunk.filter((op) => op.sign !== "-").length);
    out.push(`@@ -${old} +${now} @@`);
    for (const { sign, line } of hunk) {
      out.push(sign + line.replace(/\n$/, ""));
      if (!line.endsWith("\n")) out.push("\\ No newline at end of file");
    }
    first = last + 1;
  }
  return `${out.join("\n")}\n`;
}

/** A hunk's side as its header says it: where it starts, and how many lines — left out when one. */
function range(skipped: number, count: number): string {
  const start = count === 0 ? skipped : skipped + 1;
  return count === 1 ? `${start}` : `${start},${count}`;
}

/** The lines of `text`, each with the newline that ends it — the last may have none. */
function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Every line of `a` and `b`, kept, removed or added, in order. */
function script(a: string[], b: string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const [x, y] = [a.slice(head, a.length - tail), b.slice(head, b.length - tail)];
  const kept = (line: string): Op => ({ sign: " ", line });
  return [...a.slice(0, head).map(kept), ...middle(x, y), ...a.slice(a.length - tail).map(kept)];
}

/** The longest common subsequence's edit script of `x` and `y`. */
function middle(x: string[], y: string[]): Op[] {
  if ((x.length + 1) * (y.length + 1) > MOST_CELLS) {
    return [...x.map((line): Op => ({ sign: "-", line })), ...y.map((line): Op => ({ sign: "+", line }))];
  }
  const width = y.length + 1;
  const table = new Uint32Array((x.length + 1) * width);
  for (let i = x.length - 1; i >= 0; i -= 1) {
    for (let j = y.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = x[i] === y[j] ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const ops: Op[] = [];
  let [i, j] = [0, 0];
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      ops.push({ sign: " ", line: x[i] });
      i += 1;
      j += 1;
    } else if (j === y.length || (i < x.length && table[(i + 1) * width + j] >= table[i * width + j + 1])) {
      ops.push({ sign: "-", line: x[i] });
      i += 1;
    } else {
      ops.push({ sign: "+", line: y[j] });
      j += 1;
    }
  }
  return ops;
}
