import type { Answer } from "@/convex/model/answer";
import type { Row } from "@/convex/model/inbox";

/**
 * What a gate's drawer says and does, by the gate's kind — which is its name
 * (#104): `plan` and `integrate` are named for what approving them does; any
 * other gate is asked in general words, and a question round is answered, not
 * approved. Pure, so a test reads it as the drawer would.
 */
export interface Verbs {
  /** The drawer's title. */
  question: string;
  approve: string;
  /** "" where nothing is rejected: a question round is answered. */
  reject: string;
  placeholder: string;
  /** The Now card's button that opens it. */
  review: string;
}

/** What a wait asks, in a word or two: which gate, or how many questions. */
export function asks(row: Pick<Row, "kind" | "gate" | "questions">): string {
  if (row.kind === "questions") return `${row.questions || "open"} question${row.questions === 1 ? "" : "s"}`;
  return `${row.gate} gate`;
}

export function verbsOf(row: Pick<Row, "kind" | "gate" | "questions">): Verbs {
  if (row.kind === "questions") {
    return { question: `${asks(row)} before the ${row.gate}`, approve: "Send answers", reject: "",
             placeholder: "Anything else (optional)", review: "Answer the questions" };
  }
  if (row.gate === "plan") {
    return { question: "Approve the plan?", approve: "Approve plan", reject: "Reject",
             placeholder: "Notes — required to reject: what should the plan change?", review: "Review the plan and answer" };
  }
  if (row.gate === "integrate") {
    return { question: "Open the pull request?", approve: "Open pull request", reject: "Send back",
             placeholder: "Notes — required to send back: what should change before it lands?", review: "Review the changes and answer" };
  }
  return { question: `Approve the ${row.gate}?`, approve: "Approve", reject: "Reject",
           placeholder: "Notes — required to reject: what should change?", review: `Review the ${row.gate} and answer` };
}

/** Why a reject with no note is refused: the note is what the next agent is told to do. */
export const NEEDS_NOTE = "Say what should change: the next agent reads it as an instruction.";

/**
 * The answer a verdict gives with what was typed — or, for a reject with no
 * note, why not: nothing is sent then. The factory refuses it too
 * (`model/answer.ts`); saying so here saves the round trip.
 */
export function decide(verdict: Answer["verdict"], notes: string, answers: string[]): { answer: Answer } | { hint: string } {
  if (verdict === "reject" && !notes.trim()) return { hint: NEEDS_NOTE };
  return { answer: { verdict, notes, answers: verdict === "answer" ? answers : [] } };
}
