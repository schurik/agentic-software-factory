/**
 * The run's journal, exactly as the next agent reads it — the cockpit's copy of
 * `engine/journal.py`'s `render`, fed by the `journal_noted` events every
 * `journal.file` emits.
 *
 * "Exactly" is the whole point: the Journal tab is where a person checks what
 * an agent was told, so `render` is the factory's text, not a cockpit's
 * rewording of it, and the tab draws that text's own lines (`numbered`) as
 * markdown, under its own numbers. The rules are the factory's, kept in step
 * by the golden sessions' own `journal.md` (tests/story.test.ts): an entry is
 * KEYED, so a resumed process
 * re-filing a phase lands on the old row instead of beside it, and entries
 * sort by the phase they belong to, the phase's own line first.
 */
import { Payload } from "./payload";

const NOTE_MARK = "⚑";
const REMARK_MARK = "✎";

// Word for word the factory's PREAMBLE, both marker paragraphs included:
// they are what tells an agent a note is a report and a remark an instruction.
export const PREAMBLE =
  "## This run so far\n" +
  "\n" +
  "The factory wrote this as the run went. Each numbered line is a phase that closed;\n" +
  "the marked lines under one are what came out of it. Nothing here is a plan — it is\n" +
  "what already happened, and it is later than the plan.\n" +
  "\n" +
  `${NOTE_MARK} is a note an agent filed on work that was then accepted: a \`deviation\`,\n` +
  "a `discovery` or a `risk`. It is a REPORT. Judge it like any other claim, and say\n" +
  "so if the reason does not hold. But a deviation is a departure somebody already\n" +
  "made, with the reason they made it — the plan is the thing that is out of date, so\n" +
  "do not report the departure itself as unrequested work, and do not ask for it to be\n" +
  "undone because no plan mentions it.\n" +
  "\n" +
  `${REMARK_MARK} is something a PERSON typed at a gate or a question round. It is not a\n` +
  "report, it is an INSTRUCTION: it amends the request, it is later than the request\n" +
  "and the plan both, and where they disagree it wins. Work it asks for is in scope\n" +
  "even where no plan mentions it, and an agent that already acted on one did what it\n" +
  "was told — that work is not yours to take back out.\n";

const WHERE: Record<string, string> = { gate: "gate", questions: "question round" };

export interface Note {
  kind: string;          // deviation | discovery | risk
  what: string;
  because: string;
  insteadOf: string;
}

export interface Remark {
  gate: string;
  round: number;
  kind: string;          // gate | questions
  verdict: string;
  text: string;
}

export interface Entry {
  seq: number;           // the phase this belongs to, by number
  kind: string;          // phase | note | remark
  phase: string;
  by: string;
  status: string;
  summary: string;
  note: Note | null;
  remark: Remark | null;
}

export function readEntry(p: Payload | null): Entry | null {
  if (p === null) return null;
  const note = p.obj("note");
  const remark = p.obj("remark");
  return {
    seq: p.num("seq"), kind: p.str("kind") || "phase", phase: p.str("phase"), by: p.str("by"),
    status: p.str("status"), summary: p.str("summary"),
    note: note && { kind: note.str("kind") || "discovery", what: note.str("what"),
                    because: note.str("because"), insteadOf: note.str("instead_of") },
    remark: remark && { gate: remark.str("gate"), round: remark.num("round") || 1,
                        kind: remark.str("kind") || "gate", verdict: remark.str("verdict") || "approve",
                        text: remark.str("text") },
  };
}

/** What makes two entries the same one — `JournalEntry.key`. */
function key(entry: Entry): string {
  let body = "";
  if (entry.note !== null) body = `${entry.note.kind}:${entry.note.what}`;
  else if (entry.remark !== null) body = `${entry.remark.gate}:${entry.remark.round}:${entry.remark.kind}`;
  return JSON.stringify([entry.kind, entry.phase, body]);
}

const rank = (entry: Entry) => (entry.kind === "phase" ? 0 : 1);

/** `entries` with `entry` filed: in place of the one it re-files, or added, then sorted. */
export function file(entries: Entry[], entry: Entry): Entry[] {
  const at = entries.findIndex((existing) => key(existing) === key(entry));
  const next = at === -1 ? [...entries, entry] : entries.map((each, i) => (i === at ? entry : each));
  // Stable, as Python's sort is: equal keys keep the order they were filed in.
  return next.sort((a, b) => a.seq - b.seq || rank(a) - rank(b));
}

/** A phase's line without its number: the head of its entry on the page. */
function head(entry: Entry): string {
  const said = `${entry.phase} · ${entry.by || "—"} · ${entry.status || "running"}`;
  return entry.summary ? `${said} — ${entry.summary}` : said;
}

/** A ⚑ or ✎ mark's lines, before the journal indents them under their phase. */
function markLines(entry: Entry): string[] {
  if (entry.note !== null) {
    const { note } = entry;
    const parts = [`${NOTE_MARK} ${note.kind} (${entry.by}, in ${entry.phase}): ${note.what}`];
    if (note.insteadOf) parts.push(`instead of: ${note.insteadOf}`);
    if (note.because) parts.push(`because: ${note.because}`);
    return parts;
  }
  const remark = entry.remark ?? { gate: "", round: 1, kind: "gate", verdict: "approve", text: "" };
  const where = WHERE[remark.kind] ?? remark.kind;
  return [`${REMARK_MARK} ${entry.by} said, ${remark.verdict} at the ${remark.gate} ` +
    `${where} (round ${remark.round}): ${remark.text}`];
}

function line(entry: Entry): string {
  if (entry.kind === "phase") return `${entry.seq}. ${head(entry)}`;
  // The mark three spaces in, what it says of itself two more.
  return markLines(entry).map((part, i) => (i === 0 ? "   " : "     ") + part).join("\n");
}

/** The block a prompt carries, or "" while the run has done nothing yet. */
export function render(entries: Entry[]): string {
  if (entries.length === 0) return "";
  return PREAMBLE + "\n" + entries.map(line).join("\n") + "\n";
}

/**
 * A ⚑ or ✎ line with the lines under it, as markdown reads them: without the
 * indentation `line` puts them under their phase, which markdown would take
 * for code — and only that indentation, so what an agent or a person wrote
 * keeps its own.
 */
export interface Mark {
  kind: "note" | "remark";
  text: string;
}

/**
 * One numbered line of the journal and the marked lines under it in the text,
 * for a page to draw. The number is the phase's seq, so the numbers skip (7,
 * 10, 12): a page that handed `render`'s text to a stock markdown renderer
 * would renumber them 7, 8, 9. A mark filed under a phase that wrote no line
 * of its own sits under the line before it, as it does in the text — and under
 * no number (`seq` null) when nothing precedes it.
 */
export interface Numbered {
  seq: number | null;
  head: string;          // the phase's line, without its number
  marks: Mark[];
}

/** The journal `render` writes, as its numbered lines: one entry per number. */
export function numbered(entries: Entry[]): Numbered[] {
  const out: Numbered[] = [];
  for (const entry of entries) {
    if (entry.kind === "phase") {
      out.push({ seq: entry.seq, head: head(entry), marks: [] });
      continue;
    }
    if (out.length === 0) out.push({ seq: null, head: "", marks: [] });
    out.at(-1)!.marks.push({ kind: entry.note !== null ? "note" : "remark", text: markLines(entry).join("\n") });
  }
  return out;
}
