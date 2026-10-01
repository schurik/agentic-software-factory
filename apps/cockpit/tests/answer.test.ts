import { describe, expect, it } from "vitest";
import { refusal, render, type Answer, type Asked } from "../convex/model/answer";

// The comment an answer is posted as. `tests/golden/answers/` is shared with
// the factory's suite, which proves its answers watcher hears each one as it
// was meant (tests/test_asf_answers.py): this side renders each byte for byte.

interface Golden {
  asked: Asked;
  answer: Answer;
  body: string;
}

const answers = Object.fromEntries(
  Object.entries(import.meta.glob("../../../tests/golden/answers/*.json", { eager: true, import: "default" }) as
    Record<string, Golden>).map(([path, golden]) => [path.split("/").at(-1)!.replace(/\.json$/, ""), golden]),
);

describe("an answer, as the comment the factory reads", () => {
  it("has a golden rendering for every verdict at a gate and at a question round", () => {
    expect(Object.keys(answers)).toEqual(expect.arrayContaining([
      "gate-approve", "gate-reject", "gate-abort", "questions-answer", "questions-take-all", "questions-abort",
    ]));
  });

  it.each(Object.keys(answers))("renders %s exactly as the corpus has it", (name) => {
    const { asked, answer, body } = answers[name];
    expect(refusal(asked, answer)).toBeNull();
    expect(render(asked, answer)).toBe(body);
  });
});

describe("an answer the factory would refuse", () => {
  const gate = answers["gate-approve"].asked;
  const questions = answers["questions-answer"].asked;

  it("is refused before it is posted", () => {
    expect(refusal(gate, { verdict: "reject", notes: "  ", answers: [] }))
      .toBe("a reject needs notes: they are what the agent revises from");
    expect(refusal(gate, { verdict: "answer", notes: "the refresh path", answers: [] }))
      .toBe("the plan gate asked no questions: approve, reject or abort it");
    expect(refusal(questions, { verdict: "reject", notes: "no", answers: ["", ""] }))
      .toBe("a question round has nothing to reject: answer it, take every recommendation, or abort");
    expect(refusal(questions, { verdict: "answer", notes: "", answers: ["", " "] }))
      .toBe("an answer needs words: answer a question, or take every recommendation");
  });
});
