import { describe, expect, it } from "vitest";
import type { Graph } from "../convex/model/graph";
import { view } from "../convex/model/session";
import { fixture, recorded, type WireEvent } from "./helpers";

// A chapter's graph: its phases grouped under the stages its `workflow_started`
// named, each stage with a status and its rejected rounds — read off the
// recordings, the way the session page's stage graph draws them. Every
// expectation here is read off the recording by hand.

const STAGED = recorded["issue-then-two-reviews-in-stages"].events;
const BEFORE = recorded["issue-then-two-reviews"].events;

function graphs(events: WireEvent[]): Graph[] {
  const stored = events.map((event) => ({ ...event, payload: JSON.stringify(event.payload) }));
  return view(stored, events.at(-1)!.seq).story.chapters.map((chapter) => chapter.graph);
}

/** The recording up to and including the event at `seq`. */
const upTo = (seq: number) => STAGED.filter((event) => event.seq <= seq);

/** A stage as a line: its name, status, rejected rounds and phases. */
function outline(graph: Graph) {
  if (graph.kind !== "stages") throw new Error("not drawn in stages");
  return graph.stages.map((stage) =>
    `${stage.name} ${stage.status}${stage.rejected ? ` ↺${stage.rejected}` : ""}: ${stage.phases.map((phase) => phase.name).join(", ")}`);
}

describe("a chapter's graph, from a factory that records its stages", () => {
  it("lays each chapter's stages out in order, with their phases, statuses and rejected rounds", () => {
    const [issue, review] = graphs(STAGED);

    expect(outline(issue)).toEqual([
      "scout done: scout",
      "plan done ↺1: plan, approve_plan, plan_revise_1, approve_plan_2",
      "commit done: commit_plan",
      "implement done: implement",
      "verify done: verify_1",
      "review done: review_1",
      "commit done: commit_implement",
      "document done: changes, document",
      "commit done: commit_document",
      "integrate done: integrate",
    ]);
    expect(outline(review)).toEqual(["implement done: implement", "verify done: verify_1", "commit done: commit_implement"]);
  });

  it("starts from the phase that read the work item and ends on the report, which belong to no stage", () => {
    const [issue, review] = graphs(STAGED);

    expect(issue).toMatchObject({ start: { name: "issue" }, end: { name: "report" }, current: null });
    expect(review).toMatchObject({ start: { name: "pr" }, end: { name: "report" } });
  });

  it("marks the stage a person is asked at as waiting, and current, with the stages to come pending", () => {
    const [issue] = graphs(upTo(37));              // suspended at the plan gate, round 1

    expect(issue.current).toBe(1);
    expect(outline(issue)).toEqual([
      "scout done: scout", "plan waiting: plan, approve_plan", "commit pending: ", "implement pending: ",
      "verify pending: ", "review pending: ", "commit pending: ", "document pending: ", "commit pending: ",
      "integrate pending: ",
    ]);
    expect(issue).toMatchObject({ end: null });
  });

  it("marks the stage an agent works in as running, and a session that ended there as failed in it", () => {
    const working = upTo(126);                     // the builder has just started
    expect(graphs(working)[0]).toMatchObject({ current: 3, stages: { 3: { name: "implement", status: "running" } } });

    const killed = [...working, fixture("session_finished", 127)];
    expect(graphs(killed)[0]).toMatchObject({ current: 3, stages: { 3: { name: "implement", status: "failed" } } });
  });
});

describe("a chapter's graph, from a factory before stages", () => {
  it("is a flat chain of the chapter's phases, in order, with no stage guessed from their names", () => {
    const [issue, review] = graphs(BEFORE);

    expect(issue.kind).toBe("phases");
    expect(issue.kind === "phases" && issue.phases.map((phase) => phase.name)).toEqual([
      "issue", "scout", "plan", "approve_plan", "plan_revise_1", "approve_plan_2", "commit_plan", "implement",
      "verify_1", "review_1", "commit_implement", "changes", "document", "commit_document", "integrate", "report",
    ]);
    expect(review.kind === "phases" && review.phases.map((phase) => phase.name))
      .toEqual(["pr", "implement", "verify_1", "commit_implement", "report"]);
    expect(issue.current).toBeNull();
  });
});
