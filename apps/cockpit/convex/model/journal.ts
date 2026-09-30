/**
 * The run's journal, exactly as the next agent reads it — the cockpit's copy of
 * `engine/journal.py`'s `render`, fed by the `journal_noted` events every
 * `journal.file` emits.
 *
 * "Exactly" is the whole point: the Journal view is where a person checks what
 * an agent was told, so it is the factory's text, not a cockpit's rewording of
 * it. The rules are the factory's, kept in step by the golden sessions' own
 * `journal.md` (tests/story.test.ts): an entry is KEYED, so a resumed process
 * re-filing a phase lands on the old row instead of beside it, and entries
 * sort by the phase they belong to, the phase's own line first.
 */
import { Payload } from "./payload";

const NOTE_MARK = "⚑";
const REMARK_MARK = "✎";

// Word for word the factory's PREAMBLE, both marker paragraphs included:
// they are what tells an agent a note is a report and a remark an instruction.
const PREAMBLE =
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

function line(entry: Entry): string {
  if (entry.kind === "phase") {
    const head = `${entry.seq}. ${entry.phase} · ${entry.by || "—"} · ${entry.status || "running"}`;
    return entry.summary ? `${head} — ${entry.summary}` : head;
  }
  if (entry.note !== null) {
    const { note } = entry;
    const parts = [`   ${NOTE_MARK} ${note.kind} (${entry.by}, in ${entry.phase}): ${note.what}`];
    if (note.insteadOf) parts.push(`     instead of: ${note.insteadOf}`);
    if (note.because) parts.push(`     because: ${note.because}`);
    return parts.join("\n");
  }
  const remark = entry.remark ?? { gate: "", round: 1, kind: "gate", verdict: "approve", text: "" };
  const where = WHERE[remark.kind] ?? remark.kind;
  return `   ${REMARK_MARK} ${entry.by} said, ${remark.verdict} at the ${remark.gate} ` +
    `${where} (round ${remark.round}): ${remark.text}`;
}

/** The block a prompt carries, or "" while the run has done nothing yet. */
export function render(entries: Entry[]): string {
  if (entries.length === 0) return "";
  return PREAMBLE + "\n" + entries.map(line).join("\n") + "\n";
}
