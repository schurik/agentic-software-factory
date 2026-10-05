import { type Numbered, PREAMBLE } from "@/convex/model/journal";
import { Markdown } from "../Markdown";
import { cx } from "../ui";

/**
 * The Journal tab (#111): the journal the next agent reads, drawn entry by
 * entry. Each entry keeps the journal's own number — the phase's seq, which
 * skips (7, 10, 12) — drawn here rather than left to a list's counter, and
 * renders its markdown inside, at a reading width. The legend says in a line
 * what the preamble under it says at length: a ⚑ note is a report, a ✎
 * remark an instruction.
 * The text itself is `story.journal`, held byte for byte to the factory's
 * `journal.md` (tests/story.test.ts); this is how a person reads it.
 */
export function Journal({ entries }: { entries: Numbered[] }) {
  if (entries.length === 0) return <p className="text-sm text-muted">Nothing has closed yet: the next agent would be told nothing.</p>;
  return (
    <div className="flex max-w-[80ch] flex-col gap-4">
      <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-lg bg-surface-2 px-4 py-2.5 text-sm">
        <span><b>⚑</b> a note an agent filed — a report, judged like any claim</span>
        <span><b>✎</b> what a person typed at a gate — an instruction, and where it disagrees it wins</span>
      </div>
      <Markdown text={PREAMBLE} />
      <ol className="flex flex-col gap-2">
        {entries.map((entry, index) => (
          <li key={index} value={entry.seq ?? undefined} className="grid grid-cols-[2.5rem_1fr] gap-x-2">
            <span className="pt-px text-right text-sm text-faint tabular-nums">{entry.seq === null ? "" : `${entry.seq}.`}</span>
            <div className="flex min-w-0 flex-col gap-1.5">
              {entry.head ? <Markdown text={entry.head} /> : null}
              {entry.marks.map((mark, at) => (
                <Markdown key={at} text={mark.text}
                          className={cx("border-l-2 pl-3", mark.kind === "remark" ? "border-fg" : "border-line-strong")} />
              ))}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
