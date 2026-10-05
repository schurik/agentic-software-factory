import { describe, expect, it } from "vitest";
import { materialOf } from "../convex/model/gate";
import { view } from "../convex/model/session";
import { recorded, type WireEvent } from "./helpers";

// What a gate's drawer shows beside its subject (#113), read off the golden
// session recorded in stages: issue #42, scouted, planned, rejected at the
// plan gate and asked again — then built, verified and reviewed. Every
// expectation is read off that recording by hand.

const STAGED = recorded["issue-then-two-reviews-in-stages"].events;
const stored = (events: WireEvent[]) => events.map((event) => ({ ...event, payload: JSON.stringify(event.payload) }));

/** The material as the session stood once its station had shipped up to `seq`. */
function upTo(seq: number) {
  const events = stored(STAGED.filter((event) => event.seq <= seq));
  return materialOf(events, seq, view(events, seq).story);
}

describe("a plan gate's material", () => {
  // The second plan round's wait: suspended at seq 82.
  const material = upTo(82);

  it("is the issue in the reporter's words and what the scout found", () => {
    expect(material.issue?.path).toBe("context_handoff/issue.md");
    expect(material.issue?.content).toContain("- R1 The prompt receives the meeting date; there is no fallback to now.");
    expect(material.findings?.content).toBe(
      "# Findings\n\n- app.py: `build_prompt` takes the transcript, and no date.\n- tests: nothing covers the prompt yet.\n");
  });

  it("lists every flag an agent filed in the chapter, saying who filed it", () => {
    expect(material.flags).toEqual([
      { kind: "risk", what: "the date is local midnight", because: "converted in UTC it is the previous day", insteadOf: "", by: "planner" },
    ]);
  });

  it("has no checks and no review before anything was built", () => {
    expect(material.checks).toEqual([]);
    expect(material.review).toBeNull();
  });
});

describe("an integrate gate's material", () => {
  // The first chapter, committed and documented: where its integrate gate asks.
  const material = upTo(172);

  it("is the latest verify's checks and the reviewer's verdict", () => {
    expect(material.checks).toEqual([
      { name: "test", argv: ["python", "-c", "import runpy; runpy.run_path('app.py')"], ok: true, exitCode: 0, seconds: 0.04 },
    ]);
    expect(material.review).toEqual({
      summary: "approved: R1 and R2 are met",
      doc: { path: "context_handoff/review.md", content: "# Review\n\nVerdict: approved. R1 and R2 are met.\n", truncated: false, pruned: false },
    });
  });

  it("keeps every flag of the chapter, the builder's deviation after the planner's risk", () => {
    expect(material.flags.map((flag) => `${flag.by}: ${flag.kind}`)).toEqual(["planner: risk", "builder: deviation"]);
  });
});
