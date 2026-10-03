"use client";
// PROTOTYPE, throwaway. Diffs: jsdiff computes the hunks from before/after text, and this draws
// them — unified or split, line numbers, and the changed words marked inside a changed line.
// In the real build the before/after would come from the forge at two shas (the `committed`
// sha of each artifact), never from the event stream.
import { diffWordsWithSpace, structuredPatch } from "diff";
import { Columns2, Rows2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { FileDiff } from "@/lib/data";
import { Chevron, cx } from "./ui";

type Line = { kind: " " | "+" | "-"; text: string; old?: number; new?: number; pair?: string };
type Hunk = { header: string; lines: Line[] };

function hunksOf(f: FileDiff): { hunks: Hunk[]; adds: number; dels: number } {
  const patch = structuredPatch(f.path, f.path, f.before, f.after, "", "", { context: 3 });
  let adds = 0;
  let dels = 0;
  const hunks = patch.hunks.map((h) => {
    let o = h.oldStart;
    let n = h.newStart;
    const lines: Line[] = h.lines
      .filter((l) => !l.startsWith("\\"))
      .map((l) => {
        const kind = l[0] as Line["kind"];
        const text = l.slice(1);
        if (kind === "+") { adds++; return { kind, text, new: n++ }; }
        if (kind === "-") { dels++; return { kind, text, old: o++ }; }
        return { kind, text, old: o++, new: n++ };
      });
    // Pair a run of removed lines with the run of added lines after it, line by line,
    // so the words that changed can be marked.
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].kind !== "-") continue;
      let j = i;
      while (j < lines.length && lines[j].kind === "-") j++;
      let k = j;
      while (k < lines.length && lines[k].kind === "+") k++;
      for (let x = 0; x < Math.min(j - i, k - j); x++) {
        lines[i + x].pair = lines[j + x].text;
        lines[j + x].pair = lines[i + x].text;
      }
      i = k - 1;
    }
    return { header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, lines };
  });
  return { hunks, adds, dels };
}

function Words({ line }: { line: Line }) {
  if (line.pair === undefined || line.kind === " ") return <>{line.text || " "}</>;
  const [a, b] = line.kind === "-" ? [line.text, line.pair] : [line.pair, line.text];
  const parts = diffWordsWithSpace(a, b);
  return (
    <>
      {parts.map((p, i) => {
        if (line.kind === "-" && p.added) return null;
        if (line.kind === "+" && p.removed) return null;
        const marked = (line.kind === "-" && p.removed) || (line.kind === "+" && p.added);
        return <span key={i} className={marked ? (line.kind === "+" ? "rounded-[2px] bg-add-word" : "rounded-[2px] bg-del-word") : undefined}>{p.value}</span>;
      })}
    </>
  );
}

const rowTone = (k: Line["kind"]) => (k === "+" ? "bg-add-bg" : k === "-" ? "bg-del-bg" : "");
const num = "w-10 shrink-0 select-none pr-2 text-right text-faint tabular-nums";

function Unified({ hunks, wrap }: { hunks: Hunk[]; wrap: boolean }) {
  return (
    <div className={wrap ? undefined : "min-w-max"}>
      {hunks.map((h, hi) => (
        <div key={hi}>
          <div className="bg-surface-2 px-3 py-1 text-faint">{h.header}</div>
          {h.lines.map((l, i) => (
            <div key={i} className={cx("flex", rowTone(l.kind))}>
              <span className={num}>{l.old ?? ""}</span>
              <span className={num}>{l.new ?? ""}</span>
              <span className={cx("w-4 shrink-0 select-none text-center", l.kind === "+" ? "text-ok" : l.kind === "-" ? "text-bad" : "text-faint")}>{l.kind}</span>
              <span className={cx("pr-4", wrap ? "min-w-0 whitespace-pre-wrap break-words" : "whitespace-pre")}><Words line={l} /></span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Split({ hunks, wrap }: { hunks: Hunk[]; wrap: boolean }) {
  // Context lines sit on both sides; a change block puts its removals left and additions right.
  const rows = (lines: Line[]) => {
    const out: [Line | null, Line | null][] = [];
    for (let i = 0; i < lines.length;) {
      if (lines[i].kind === " ") { out.push([lines[i], lines[i]]); i++; continue; }
      const dels: Line[] = [];
      const adds: Line[] = [];
      while (i < lines.length && lines[i].kind === "-") dels.push(lines[i++]);
      while (i < lines.length && lines[i].kind === "+") adds.push(lines[i++]);
      for (let x = 0; x < Math.max(dels.length, adds.length); x++) out.push([dels[x] ?? null, adds[x] ?? null]);
    }
    return out;
  };
  const side = (l: Line | null, which: "old" | "new") => (
    <div className={cx("flex min-w-0 grow basis-0 overflow-x-auto", l ? rowTone(l.kind === " " ? " " : l.kind) : "bg-surface-2/60")}>
      <span className={num}>{l ? (which === "old" ? l.old : l.new) ?? "" : ""}</span>
      <span className={cx("pr-3", wrap ? "min-w-0 whitespace-pre-wrap break-words" : "whitespace-pre")}>{l ? <Words line={l} /> : " "}</span>
    </div>
  );
  return (
    <div>
      {hunks.map((h, hi) => (
        <div key={hi}>
          <div className="bg-surface-2 px-3 py-1 text-faint">{h.header}</div>
          {rows(h.lines).map(([a, b], i) => (
            <div key={i} className="flex divide-x divide-line">{side(a, "old")}{side(b, "new")}</div>
          ))}
        </div>
      ))}
    </div>
  );
}

function FileBlock({ file, split, right }: { file: FileDiff; split: boolean; right?: ReactNode }) {
  const { hunks, adds, dels } = useMemo(() => hunksOf(file), [file]);
  const [open, setOpen] = useState(true);
  const added = file.before === "";
  // Prose wraps, code keeps its columns.
  const prose = /\.(md|txt)$/.test(file.path);
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 border-b border-line bg-surface px-3 py-2 text-left text-sm cursor-pointer">
        <Chevron open={open} className="text-faint" />
        <code className="min-w-0 truncate font-mono">{file.path}</code>
        {added ? <span className="rounded bg-ok-soft px-1.5 text-xs text-ok">new</span> : null}
        <span className="grow" />
        <span className="font-mono text-xs tabular-nums"><span className="text-ok">+{adds}</span> <span className="text-bad">−{dels}</span></span>
        {right}
      </button>
      {open ? (
        <div className="overflow-x-auto font-mono text-xs leading-5">
          {split ? <Split hunks={hunks} wrap={prose} /> : <Unified hunks={hunks} wrap={prose} />}
        </div>
      ) : null}
    </div>
  );
}

/** A set of file diffs with a summary line and a unified/split switch. */
export function DiffView({ files, title, defaultSplit = false }: { files: FileDiff[]; title?: ReactNode; defaultSplit?: boolean }) {
  const [split, setSplit] = useState(defaultSplit);
  const totals = useMemo(() => files.map(hunksOf).reduce((t, h) => ({ adds: t.adds + h.adds, dels: t.dels + h.dels }), { adds: 0, dels: 0 }), [files]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 text-sm">
        <span className="text-muted">{title ?? <>{files.length} file{files.length > 1 ? "s" : ""} changed</>}</span>
        <span className="font-mono text-xs tabular-nums"><span className="text-ok">+{totals.adds}</span> <span className="text-bad">−{totals.dels}</span></span>
        <span className="grow" />
        <div className="hidden rounded-md border border-line p-0.5 sm:flex">
          {([false, true] as const).map((s) => (
            <button key={String(s)} onClick={() => setSplit(s)} className={cx("flex h-6 items-center gap-1 rounded px-2 text-xs cursor-pointer", split === s ? "bg-surface-3 text-fg" : "text-muted hover:text-fg")}>
              {s ? <Columns2 size={13} /> : <Rows2 size={13} />}{s ? "Split" : "Unified"}
            </button>
          ))}
        </div>
      </div>
      {files.map((f) => <FileBlock key={f.path} file={f} split={split} />)}
    </div>
  );
}
