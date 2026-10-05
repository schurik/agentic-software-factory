"use client";

import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRight, Columns2, Rows2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { Read } from "@/convex/diffs";
import { usePhone } from "../Drawer";
import { plural } from "../format";
import { cx, DiffBlock, Tag } from "../ui";
import { type DiffFile, filesOf, isProse, type Line, wordsOf } from "./files";

/**
 * Read a diff from the forge (`diffs.commit`, `diffs.changes`). `subject` is
 * what the diff is of — a commit, or two — and a new one is read again; a
 * reader that already knows which diff it reads may ignore it.
 */
export type ReadDiff = (subject: string) => Promise<Read>;

/**
 * A diff as the forge printed it, drawn by the cockpit (#112): a summary
 * line, unified or split, each file collapsible with what became of it and
 * its lines added and removed, each hunk under its header with old and new
 * line numbers, and the words that changed marked inside a changed line.
 * Prose wraps; code keeps its columns and scrolls.
 */
export function DiffView({ text, title, defaultSplit = false }: { text: string; title?: ReactNode; defaultSplit?: boolean }) {
  const [chosen, setSplit] = useState(defaultSplit);
  // Two columns need the room: a phone reads the diff unified, whatever was chosen on a wider screen.
  const phone = usePhone();
  const split = chosen && !phone;
  const files = useMemo(() => {
    try {
      return filesOf(text);
    } catch {
      return null;
    }
  }, [text]);
  if (files === null) {
    return (
      <div className="flex flex-col gap-3">
        <Summary title={title} />
        <p className={quiet}>The forge&apos;s diff could not be read into files: here it is as it was sent.</p>
        <DiffBlock text={text} />
      </div>
    );
  }
  const added = files.reduce((total, file) => total + file.added, 0);
  const removed = files.reduce((total, file) => total + file.removed, 0);
  return (
    <div className="flex flex-col gap-3">
      <Summary title={title}>
        <span>{plural(files.length, "file")} changed</span>
        <Counts added={added} removed={removed} />
        <span className="grow" />
        <div className="flex rounded-md border border-line p-0.5 max-md:hidden">
          {([false, true] as const).map((each) => (
            <button key={String(each)} type="button" aria-pressed={split === each} onClick={() => setSplit(each)}
                    className={cx("flex h-6 items-center gap-1 rounded px-2 text-xs",
                                  split === each ? "bg-surface-3 text-fg" : "text-muted hover:text-fg")}>
              {each ? <Columns2 size={13} aria-hidden="true" /> : <Rows2 size={13} aria-hidden="true" />}{each ? "Split" : "Unified"}
            </button>
          ))}
        </div>
      </Summary>
      {files.map((file) => <FileBlock key={`${file.from ?? ""}>${file.path}`} file={file} split={split} />)}
    </div>
  );
}

/** What reading a diff from the forge gave, or null while it is being read: never nothing, without saying why. */
export function DiffRead({ got, title }: { got: Read | null; title?: ReactNode }) {
  if (got !== null && got.ok && got.diff.trim()) return <DiffView text={got.diff} title={title} />;
  return (
    <div className="flex flex-col gap-3">
      {title ? <Summary title={title} /> : null}
      <p className="text-sm text-muted">
        {got === null ? "Reading the diff from the forge…" : !got.ok ? `Cannot read the diff: ${got.because}.` : "No changes."}
      </p>
    </div>
  );
}

/**
 * A diff read from the forge as it is shown, and never kept. Keyed by
 * `subject`, so another subject starts from "Reading…" rather than showing
 * the last one's diff under the new title.
 */
export function ForgeDiff({ subject, read, title }: { subject: string; read?: ReadDiff; title?: ReactNode }) {
  return <Reading key={subject} subject={subject} read={read} title={title} />;
}

function Reading({ subject, read, title }: { subject: string; read?: ReadDiff; title?: ReactNode }) {
  const [got, setGot] = useState<Read | null>(null);
  useEffect(() => {
    let current = true;
    read?.(subject).then(
      (answer) => { if (current) setGot(answer); },
      (error: unknown) => { if (current) setGot({ ok: false, because: error instanceof Error ? error.message : String(error) }); });
    return () => { current = false; };
  }, [read, subject]);
  return <DiffRead got={got} title={title} />;
}

function Summary({ title, children }: { title?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {title ? <span className="min-w-0 font-medium break-words">{title}</span> : null}
      {title && children ? <span aria-hidden="true" className="text-faint">·</span> : null}
      {children}
    </div>
  );
}

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      <span className="text-ok">+{added}</span> <span className="text-bad">−{removed}</span>
    </span>
  );
}

const BADGE: Partial<Record<DiffFile["change"], ReactNode>> = {
  added: <Tag tone="ok">new</Tag>, deleted: <Tag tone="bad">deleted</Tag>, renamed: <Tag>renamed</Tag>,
};

function FileBlock({ file, split }: { file: DiffFile; split: boolean }) {
  const prose = isProse(file.path);
  return (
    <Collapsible.Root defaultOpen render={<section data-file={file.path} className="overflow-hidden rounded-lg border border-line" />}>
      <Collapsible.Trigger className="group flex w-full items-center gap-2 bg-surface px-3 py-2 text-left text-sm">
        <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-faint transition-transform duration-200 group-data-panel-open:rotate-90" />
        <code className="min-w-0 truncate">{file.from ? `${file.from} → ${file.path}` : file.path}</code>
        {BADGE[file.change] ?? null}
        <span className="grow" />
        <Counts added={file.added} removed={file.removed} />
      </Collapsible.Trigger>
      <Collapsible.Panel className="border-t border-line">
        {file.binary ? <p className={quiet}>A binary file: nothing to show.</p>
          : !file.hunks.length ? <p className={quiet}>{file.change === "renamed" ? "Renamed, with no line changed." : "No line changed."}</p>
          : (
            <div className={cx("font-mono text-xs leading-5", !prose && "overflow-x-auto")}>
              {split ? <SplitTable file={file} prose={prose} /> : (
                <div className={prose ? undefined : "min-w-max"}>
                  {file.hunks.map((hunk, index) => (
                    <div key={index}>
                      <div className={header}>{hunk.header}</div>
                      <UnifiedRows lines={hunk.lines} prose={prose} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

const LINE: Record<Line["sign"], "add" | "del" | "ctx"> = { "+": "add", "-": "del", " ": "ctx" };
const TONE: Record<Line["sign"], string> = { "+": "bg-add-bg", "-": "bg-del-bg", " ": "" };
const number = "w-10 shrink-0 pr-2 text-right whitespace-nowrap text-muted tabular-nums select-none";
const header = "bg-surface-2 px-3 py-1 text-muted";
const textOf = (prose: boolean) => (prose ? "min-w-0 whitespace-pre-wrap break-words px-2" : "whitespace-pre px-2");

function UnifiedRows({ lines, prose }: { lines: Line[]; prose: boolean }) {
  return (
    <>
      {lines.map((line, index) => (
        <div key={index} data-line={LINE[line.sign]} className={cx("flex", TONE[line.sign])}>
          <span data-n="old" className={number}>{line.old ?? ""}</span>
          <span data-n="new" className={number}>{line.new ?? ""}</span>
          <span aria-hidden="true" className={cx("w-4 shrink-0 text-center select-none",
                                                 line.sign === "+" ? "text-ok" : line.sign === "-" ? "text-bad" : "text-muted")}>
            {line.sign}
          </span>
          <span className={textOf(prose)}><Words line={line} /></span>
        </div>
      ))}
    </>
  );
}

/**
 * Context on both sides; a run of changes with what it removed on the left,
 * and what it added on the right. One table for the file, so each side is one
 * column however long its lines: code scrolls as a whole, prose shares the width.
 */
function SplitTable({ file, prose }: { file: DiffFile; prose: boolean }) {
  const side = (line: Line | null, which: "old" | "new") => {
    const tone = line ? TONE[line.sign] : "bg-surface-2";
    return (
      <>
        <td data-side={which} data-line={line ? LINE[line.sign] : undefined} className={cx(number, "align-top", tone)}>
          {line ? line[which] ?? "" : ""}
        </td>
        <td className={cx(textOf(prose), "align-top", tone, which === "old" && "border-r border-line")}>
          {line ? <Words line={line} /> : null}
        </td>
      </>
    );
  };
  return (
    <table className={cx("border-collapse", prose ? "w-full table-fixed" : "min-w-full")}>
      <colgroup><col className="w-10" /><col /><col className="w-10" /><col /></colgroup>
      {file.hunks.map((hunk, index) => (
        <tbody key={index}>
          <tr><td colSpan={4} className={header}>{hunk.header}</td></tr>
          {rowsOf(hunk.lines).map(([old, now], row) => <tr key={row}>{side(old, "old")}{side(now, "new")}</tr>)}
        </tbody>
      ))}
    </table>
  );
}

/** A hunk's lines as split rows: a context line beside itself, a removal beside the addition that replaced it. */
function rowsOf(lines: Line[]): [Line | null, Line | null][] {
  const rows: [Line | null, Line | null][] = [];
  for (let at = 0; at < lines.length;) {
    if (lines[at].sign === " ") {
      rows.push([lines[at], lines[at]]);
      at += 1;
      continue;
    }
    const [removed, added]: Line[][] = [[], []];
    while (at < lines.length && lines[at].sign === "-") removed.push(lines[at++]);
    while (at < lines.length && lines[at].sign === "+") added.push(lines[at++]);
    for (let each = 0; each < Math.max(removed.length, added.length); each += 1) rows.push([removed[each] ?? null, added[each] ?? null]);
  }
  return rows;
}

/** A line's text, the words that changed from the line it is paired with marked. */
function Words({ line }: { line: Line }) {
  const words = wordsOf(line);
  if (words === null) return <>{line.text || " "}</>;
  const kind = line.sign === "+" ? "add" : "del";
  return (
    <>
      {words.map((word, index) => (word.changed
        ? <span key={index} data-word={kind} className={cx("rounded-[2px]", kind === "add" ? "bg-add-word" : "bg-del-word")}>{word.text}</span>
        : <span key={index}>{word.text}</span>))}
    </>
  );
}

const quiet = "px-3 py-2 text-sm text-muted";
