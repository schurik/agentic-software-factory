/**
 * An answer from the inbox, as the comment the factory's answers watcher
 * reads (`issues.read_reply` and `watch.reply_to` in the skill's templates).
 *
 * A verdict is the comment's first line — `/approve`, `/reject`, `/abort` —
 * and what the person wrote follows it. A question round's answer is prose,
 * each answered question beside what the person said, the rest left at their
 * recommendation, which is what a question round's defaults mean. Every
 * comment ends with a mark naming the session, gate, round and subject digest
 * it answers: the watcher ignores an answer to a wait the run has moved past.
 *
 * `tests/golden/answers/` holds this module's renderings, and the factory's
 * suite proves it hears each of them as it was meant: the comment is a
 * contract between the two, and that corpus is the only place they meet.
 */

/** The wait an answer is for, as the corpus names it (snake case: it is the factory's). */
export interface Asked {
  session: string;
  gate: string;
  round: number;
  kind: string;                   // gate | questions
  subject_digest: string;
  questions: { question: string }[];
}

export type Verdict = "approve" | "reject" | "abort" | "answer";

export interface Answer {
  verdict: Verdict;
  notes: string;
  /** At a question round, what the person said to each question in order; "" leaves one at its recommendation. */
  answers: string[];
}

const VERDICT_LINE = /^\/(approve|reject|abort)\b/i;
const DEFAULTS = "Every question I did not answer stands at its recommendation.";
const FOOTER = "<sub>Answered in the asf cockpit.</sub>";

/** Why the factory would refuse this answer — its own `hitl.answer` rules — or null when it would take it. */
export function refusal(asked: Asked, answer: Answer): string | null {
  const notes = answer.notes.trim();
  if (asked.kind === "questions") {
    if (answer.verdict === "reject") {
      return "a question round has nothing to reject: answer it, take every recommendation, or abort";
    }
    if (answer.verdict === "answer") {
      if (!notes && !answer.answers.some((each) => each.trim())) {
        return "an answer needs words: answer a question, or take every recommendation";
      }
      if (VERDICT_LINE.test(words(asked, answer))) {
        return "an answer whose first line starts with /approve, /reject or /abort reads as that verdict: reword it";
      }
    }
    return null;
  }
  if (answer.verdict === "answer") return `the ${asked.gate} gate asked no questions: approve, reject or abort it`;
  if (answer.verdict === "reject" && !notes) return "a reject needs notes: they are what the agent revises from";
  return null;
}

/**
 * What the person said, without the comment's mark or footer: the notes a
 * terminal-channel answer carries to the station as a command, where the
 * station itself checks which wait it answers. A question round's answers are
 * the same prose the comment would hold.
 */
export function spoken(asked: Asked, answer: Answer): string {
  return answer.verdict === "answer" ? words(asked, answer) : answer.notes.trim();
}

/** The comment's body. Call `refusal` first: this renders whatever it is given. */
export function render(asked: Asked, answer: Answer): string {
  const said = answer.verdict === "answer" ? words(asked, answer) : verdict(answer);
  const mark = `<!-- asf:answer adw=${asked.session} gate=${asked.gate} round=${asked.round} ` +
    `digest=${asked.subject_digest} -->`;
  return `${said}\n\n${mark}\n${FOOTER}\n`;
}

function verdict({ verdict, notes }: Answer): string {
  return [`/${verdict}`, notes.trim()].filter(Boolean).join("\n\n");
}

/** A question round's answer, as prose the analyst weighs. */
function words(asked: Asked, { notes, answers }: Answer): string {
  const answered = asked.questions.flatMap((question, at) => {
    const said = (answers[at] ?? "").trim();
    return said ? [`- **${question.question}** — ${said}`] : [];
  });
  const open = answered.length < asked.questions.length;
  return [answered.join("\n"), notes.trim(), open ? DEFAULTS : ""].filter(Boolean).join("\n\n");
}
