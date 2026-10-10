import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { type Entry, numbered, render } from "../convex/model/journal";
import { toldVersions } from "../convex/model/story";
import { cockpit, corpus, factory, fixture, ingest, recorded, type Cockpit, type WireEvent } from "./helpers";

// The session page's story, told from the golden corpus's recorded session:
// issue #42, planned, rejected and approved at the plan gate (each answer
// resuming the session), built and proposed as pull request #9 — then two
// rounds of review on it. Every expectation here is read off that recording by
// hand, the way sessions.test.ts reads the per-kind fixtures.

const SESSION = "a9f259f0";
const WHERE = { factory: "acme/widgets", session: SESSION };
const { events: RECORDED, journal: JOURNAL } = recorded["issue-then-two-reviews"];

async function ship(t: Cockpit, token: string, events: WireEvent[]) {
  const response = await ingest(t, token, { session: SESSION, events });
  expect(response.status).toBe(200);
}

/** The recording, shipped up to and including `seq` (all of it by default). */
async function told(upTo = RECORDED.length) {
  const t = cockpit();
  const token = await factory(t);
  await ship(t, token, RECORDED.slice(0, upTo));
  return { t, token };
}

async function story(t: Cockpit) {
  return (await t.query(api.sessions.get, WHERE))!.story;
}

beforeEach(() => {
  vi.stubEnv("COCKPIT_MODE", "local");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a session told in chapters", () => {
  it("has one chapter per workflow it passed through, in order, each saying what it answered", async () => {
    const { t } = await told();

    const { chapters } = await story(t);

    expect(chapters.map(({ number, workflow, title, input, answering, status }) =>
      ({ number, workflow, title, input, answering, status }))).toEqual([
      { number: 1, workflow: "issue", title: "issue", input: "issue", status: "success",
        answering: { kind: "issue", number: 42, url: "https://forge/acme/widgets/issues/42" } },
      { number: 2, workflow: "pr-review", title: "pr-review, round 1", input: "pr", status: "success",
        answering: { kind: "pr", number: 9, url: "https://forge/acme/widgets/pull/9" } },
      { number: 3, workflow: "pr-review", title: "pr-review, round 2", input: "pr", status: "success",
        answering: { kind: "pr", number: 9, url: "https://forge/acme/widgets/pull/9" } },
    ]);
  });

  it("opens each chapter with Asked: the issue with its agreed requirements, or the reviewers' threads", async () => {
    const { t } = await told();

    const [issue, first, second] = (await story(t)).chapters.map((chapter) => chapter.asked!);

    expect(issue.path).toBe("context_handoff/issue.md");
    expect(issue.content).toContain("## Requirements (agreed with schurik)");
    expect(issue.content).toContain("- R1 The prompt receives the meeting date; there is no fallback to now.");
    expect([first.path, second.path]).toEqual(["context_handoff/pr_review.md", "context_handoff/pr_review.md"]);
    expect(first.content).toContain("> the date should read like Sep 25, 2026");
    expect(second.content).toContain("> use that format two lines below too");
    expect(issue.truncated || first.truncated || second.truncated).toBe(false);
  });

  it("tells agent phases as cards, code steps as rows and gates as their own cards, in the order they happened", async () => {
    const { t } = await told();

    const outline = (await story(t)).chapters.map((chapter) =>
      chapter.items.map((item) => `${item.type} ${"name" in item ? item.name : ""}`.trimEnd()));

    // The phase that read the issue or the threads is the chapter's Asked, not a row.
    expect(outline).toEqual([
      ["agent scout", "agent plan", "gate approve_plan", "resumed", "agent plan_revise_1",
       "gate approve_plan_2", "resumed", "code commit_plan", "agent implement", "code verify_1",
       "agent review_1", "code commit_implement", "code changes", "agent document",
       "code commit_document", "automatic", "code integrate", "code report"],
      ["agent implement", "code verify_1", "code commit_implement", "code report"],
      ["agent implement", "code verify_1", "code commit_implement", "code report"],
    ]);
  });

  it("gives an agent card its outcome, tool calls, cost, artifact chips and the notes it filed", async () => {
    const { t } = await told();
    const [first] = (await story(t)).chapters;
    const card = (name: string) => first.items.find((item) => item.type === "agent" && item.name === name)!;

    expect(card("scout")).toMatchObject({
      owner: "scout", task: "asf/stages/scout/task.md", status: "success",
      outputType: "ScoutOutput", summary: "the prompt is built in app.py; no date reaches it",
      toolCalls: 3, toolFailures: 1, cost: 0.021, tokens: 1900, corrections: 0,
      artifacts: [{ path: "context_handoff/scout_findings.md", location: "handoff" }],
      notes: [],
    });
    expect(card("plan")).toMatchObject({
      outputType: "PlanOutput", toolCalls: 1, cost: 0.102,
      artifacts: [{ path: "docs/asf/spec/plan.md", location: "repo" }],
      notes: [{ kind: "risk", what: "the date is local midnight",
                because: "converted in UTC it is the previous day", insteadOf: "" }],
    });
    // One reply was not JSON: re-prompted in the same session, as a correction.
    expect(card("plan_revise_1")).toMatchObject({ corrections: 1, summary: "the plan now names the module" });
    expect(card("implement")).toMatchObject({
      changedFiles: ["app.py"],
      notes: [{ kind: "deviation", what: "kept the summary helpers",
                insteadOf: "reworking every prompt", because: "only the action items need a date" }],
    });
  });

  it("gives a code row what it ran or committed", async () => {
    const { t } = await told();
    const [first, review] = (await story(t)).chapters;
    const row = (items: typeof first.items, name: string) =>
      items.find((item) => item.type === "code" && item.name === name)!;

    expect(row(first.items, "commit_implement")).toMatchObject({
      owner: "git", status: "success", commands: [],
      commits: [{ sha: expect.stringMatching(/^[0-9a-f]{40}$/),
                  message: "feat: the prompt knows the meeting date", filesTotal: 1 }],
    });
    expect(row(review.items, "verify_1")).toMatchObject({
      owner: "quality", status: "success", commits: [],
      commands: [{ name: "test", exitCode: 0 }],
    });
  });

  it("shows a gate with its round, where it was asked, the verdict and the person's remark", async () => {
    const { t } = await told();
    const gates = (await story(t)).chapters[0].items.filter((item) => item.type === "gate");

    expect(gates).toMatchObject([
      { name: "approve_plan", gate: "plan", round: 1, status: "rejected", channel: "issue", issueNumber: 42,
        decision: { verdict: "reject", by: "asf tests", channel: "cli",
                    notes: "name the module the date is converted in" } },
      { name: "approve_plan_2", gate: "plan", round: 2, status: "approved", channel: "issue",
        summary: "the plan now names the module",
        decision: { verdict: "approve", by: "asf tests", notes: "keep the prompt in English" } },
    ]);
  });
});

describe("authority and replays", () => {
  it("shows a decision made by policy as automatic, never as somebody's verdict", async () => {
    const { t } = await told();
    const { chapters } = await story(t);
    const items = chapters.flatMap((chapter) => chapter.items);

    expect(items.filter((item) => item.type === "automatic")).toMatchObject([
      { gate: "integrate", round: 1 },
    ]);
    // Only people answer gates: no gate card anywhere says policy decided it.
    for (const item of items) {
      if (item.type === "gate") expect(item.decision?.by).not.toBe("policy");
    }
  });

  it("folds what a resume replayed into the phase it replayed, rather than showing it twice", async () => {
    const { t } = await told();
    const [first] = (await story(t)).chapters;

    const phaseIds = first.items.flatMap((item) => ("phaseId" in item ? [item.phaseId] : []));
    expect(new Set(phaseIds).size).toBe(phaseIds.length);
    expect(first.items.filter((item) => item.type === "resumed")).toMatchObject([
      { replayed: ["scout", "plan"] },
      { replayed: ["scout", "plan", "plan_revise_1"] },
    ]);
    const replayed = first.items.filter((item) => item.type === "agent" && item.replayed);
    expect(replayed.map((item) => "name" in item && item.name)).toEqual(["scout", "plan", "plan_revise_1"]);
    // Replays sent nothing and cost nothing: the card keeps what its live run did.
    expect(first.items.find((item) => item.type === "agent" && item.name === "scout"))
      .toMatchObject({ toolCalls: 3, cost: 0.021, status: "success" });
  });
});

describe("a session scored, after a rollback and a limit hit", () => {
  // The recording's chapter 1 failed twice before it shipped — a scout rolled
  // back, then the builder's first turn refused by the session's cost ceiling —
  // and was scored each time it ended; each review round was scored too.
  const SCORED = recorded["issue-then-two-reviews-scored"];

  async function scored(upTo = SCORED.events.length) {
    const t = cockpit();
    await ship(t, await factory(t), SCORED.events.slice(0, upTo));
    return story(t);
  }

  it("tells the rollback and the limit hit as facts of the phases they stopped, while each was how it stood", async () => {
    // A phase card tells its latest run: shipped as far as each failed process, it is the failure.
    const phase = async (upTo: number, phaseId: string) =>
      (await scored(upTo)).chapters[0].items.find((item) => item.type === "agent" && item.phaseId === phaseId);

    expect(await phase(23, "a9f259f0_02_scout")).toMatchObject({
      status: "fail", rollback: { paths: ["NOTES.md"], notUndone: [] }, limit: null });
    expect(await phase(157, "a9f259f0_08_implement")).toMatchObject({
      status: "fail", rollback: null, limit: { kind: "cost", limit: 0.17, reached: 0.183 } });
  });

  it("tells each chapter's scores as they stood when it last ended, citing the phases of their evidence", async () => {
    const { chapters } = await scored();

    expect(chapters.map(({ number, status, accepted }) => [number, status, accepted]))
      .toEqual([[1, "success", true], [2, "success", true], [3, "success", true]]);
    expect(chapters[0].scores).toEqual([
      { scorer: "corrections", kind: "code", class: "within", failing: false, evidence: [91],
        cites: [{ phaseId: "a9f259f0_05_plan_revise_1", name: "plan_revise_1" }] },
      { scorer: "limit-hits", kind: "code", class: "hit", failing: true, evidence: [149],
        cites: [{ phaseId: "a9f259f0_08_implement", name: "implement" }] },
      { scorer: "not-accepted", kind: "code", class: "accepted", failing: false, evidence: [], cites: [] },
      { scorer: "permission-rollbacks", kind: "code", class: "rolled_back", failing: true, evidence: [15],
        cites: [{ phaseId: "a9f259f0_02_scout", name: "scout" }] },
    ]);
    // Counted per session: its evidence is each review chapter's opening, which no phase owns.
    expect(chapters.slice(1).map(({ scores }) => scores)).toEqual([
      [{ scorer: "review-rounds", kind: "code", class: "within", failing: false, evidence: [263], cites: [] }],
      [{ scorer: "review-rounds", kind: "code", class: "above", failing: true, evidence: [263, 295], cites: [] }],
    ]);
  });

  it("is the journal the factory rendered for the next agent, byte for byte", async () => {
    expect((await scored()).journal).toBe(SCORED.journal);
  });
});

describe("the journal", () => {
  it("is the journal the factory rendered for the next agent, byte for byte", async () => {
    const { t } = await told();
    expect((await story(t)).journal).toBe(JOURNAL);
  });

  it("is that journal byte for byte for a factory that records its stages too", async () => {
    const t = cockpit();
    const { events, journal } = recorded["issue-then-two-reviews-in-stages"];
    await ship(t, await factory(t), events);
    expect((await story(t)).journal).toBe(journal);
  });

  it("comes in entries under the journal's own numbers, which are phase sequences and skip", async () => {
    const { t } = await told();
    const { journalEntries } = await story(t);
    // Read off the recorded journal.md: a numbered line opens each entry, whatever number it says.
    const numbers = [...JOURNAL.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]));
    expect(journalEntries.map((entry) => entry.seq)).toEqual(numbers);
    expect(numbers.join(" ")).toContain("7 10 12");
  });

  it("comes in entries that are the journal's own lines, each once and in its order", async () => {
    const { t } = await told();
    const { journalEntries } = await story(t);
    const lines = journalEntries.flatMap(({ seq, head, marks }) => [`${seq}. ${head}`, ...marks.map((mark) => mark.text)]);
    // Only the indentation that sets a mark under its phase is the entries' to drop.
    const body = JOURNAL.slice(JOURNAL.search(/^1\. /m)).trimEnd().split("\n").map((each) => each.trimStart());
    expect(lines.join("\n").split("\n")).toEqual(body);
  });

  it("keeps each marked line under the numbered line it follows in the text, without the indent that put it there", async () => {
    const { t } = await told();
    const byNumber = new Map((await story(t)).journalEntries.map((entry) => [entry.seq, entry]));
    expect(byNumber.get(3)).toMatchObject({
      head: "plan · planner · success — a required meeting date, and a test for its format",
      marks: [{ kind: "note", text: "⚑ risk (planner, in plan): the date is local midnight\nbecause: converted in UTC it is the previous day" }],
    });
    expect(byNumber.get(4)?.marks).toEqual([
      { kind: "remark", text: "✎ asf tests said, reject at the plan gate (round 1): name the module the date is converted in" },
    ]);
    // The builder's deviation was filed under a phase that wrote no line of its
    // own, so the text puts it under commit_plan, and so does the entry.
    expect(byNumber.get(7)?.marks.map((mark) => mark.text)).toEqual([expect.stringContaining("⚑ deviation (builder, in implement)")]);
    expect(byNumber.get(10)?.marks).toEqual([]);
  });

  it("puts a mark filed before any numbered line under no number, where the text has it", () => {
    // What a person typed keeps its own indentation; only the journal's goes.
    const remark = { gate: "plan", round: 1, kind: "gate", verdict: "reject", text: "say *why*:\n  - the date" };
    const entries: Entry[] = [
      { seq: 2, kind: "remark", phase: "approve_plan", by: "ana", status: "", summary: "", note: null, remark },
      { seq: 3, kind: "phase", phase: "plan", by: "planner", status: "success", summary: "", note: null, remark: null },
    ];
    expect(numbered(entries)).toEqual([
      { seq: null, head: "", marks: [{ kind: "remark", text: "✎ ana said, reject at the plan gate (round 1): say *why*:\n  - the date" }] },
      { seq: 3, head: "plan · planner · success", marks: [] },
    ]);
    expect(render(entries).split("\n").slice(-4)).toEqual([
      "   ✎ ana said, reject at the plan gate (round 1): say *why*:", "  - the date", "3. plan · planner · success", ""]);
  });

  it("is, at every task the factory sent an agent, the journal that prompt ended with", async () => {
    // Send 1 is the task; a later send in the same session is a correction,
    // which the agent reads with the task (and its journal) still in context.
    const prompts = RECORDED.filter((event) =>
      event.kind === "prompt_rendered" && (event.payload as { send: number }).send === 1);
    expect(prompts.length).toBeGreaterThan(5);
    for (const sent of prompts) {
      const { t } = await told(sent.seq - 1);
      const journal = (await story(t)).journal;
      const prompt = (sent.payload as { prompt: string }).prompt;
      if (journal === "") expect(prompt).not.toContain("## This run so far");
      else expect(prompt.endsWith(`\n\n${journal}`), `the prompt at seq ${sent.seq}`).toBe(true);
    }
  });
});

describe("a live session", () => {
  it("says what is happening now, and moves on as events arrive without anything reloading", async () => {
    const at = (kind: string, name: string) =>
      RECORDED.find((event) => event.kind === kind && (event.payload as { name?: string }).name === name)!.seq;
    // Shipped up to the builder at work in the first chapter.
    const { t, token } = await told(at("phase_started", "implement") + 2);
    const before = await t.query(api.sessions.get, WHERE);
    expect(before!.summary.status).toBe("running");
    expect(before!.story.now).toMatchObject({ phase: { name: "implement", owner: "builder", kind: "agent" } });
    expect(before!.story.chapters).toHaveLength(1);

    // ...then the rest of the first chapter, to the policy-passed integration.
    await ship(t, token, RECORDED.slice(at("phase_started", "implement") + 2, at("phase_started", "integrate")));
    const after = await t.query(api.sessions.get, WHERE);
    expect(after!.story.now.phase).toMatchObject({ name: "integrate", kind: "code" });
    expect(after!.story.chapters[0].items.at(-1)).toMatchObject({ type: "code", name: "integrate" });
  });

  it("waits at a gate with the round, the channel and the work item it was asked on", async () => {
    const suspended = RECORDED.find((event) => event.kind === "suspended")!.seq;
    const { t } = await told(suspended);

    const { now, chapters } = await story(t);
    expect(now.waiting).toEqual({ gate: "plan", round: 1, kind: "gate", channel: "issue", issueNumber: 42 });
    expect(chapters[0].items.at(-1)).toMatchObject({ type: "gate", status: "waiting", decision: null });
  });

  it("ends saying where the work went, over how many chapters", async () => {
    const { t } = await told();
    expect((await story(t)).now).toMatchObject({
      status: "success", chapters: 3, prUrl: "https://forge/acme/widgets/pull/9", phase: null, waiting: null,
    });
  });
});

describe("edges a recording does not reach", () => {
  const started = (seq: number, phaseId: string, name: string, kind = "agent") => ({
    seq, ts: `2026-09-29T12:00:${String(seq).padStart(2, "0")}.000+00:00`, kind: "phase_started", v: 2,
    payload: { phase_id: phaseId, seq: Number(phaseId.split("_")[1]), name, kind, owner: "someone",
               description: "Do the thing this phase is for", task: "", prompt_digest: "" },
  });
  const ended = (seq: number, phaseId: string, name: string, status = "success", extra = {}) => ({
    seq, ts: `2026-09-29T12:00:${String(seq).padStart(2, "0")}.000+00:00`, kind: "phase_ended", v: 1,
    payload: { phase_id: phaseId, name, status, attempt: 1, error: "", gate: "", round: 0, ...extra },
  });
  const chapter = (seq: number, number: number) => ({
    seq, ts: "2026-09-29T12:00:00.000+00:00", kind: "workflow_started", v: 1,
    payload: { workflow: "gated", chapter: number, input: "prompt" },
  });
  const decided = (seq: number, notes: string) => {
    const event = fixture("decision_recorded", seq);
    Object.assign((event.payload as { decision: Record<string, unknown> }).decision,
                  { gate: "plan", round: 1, verdict: "approve", notes });
    return event;
  };

  it("gives each chapter's gate the decision taken there, though two chapters ask the same round", async () => {
    const t = cockpit();
    const token = await factory(t);
    await ship(t, token, [
      fixture("session_started", 1),
      chapter(2, 1), started(3, "x_01_approve_plan", "approve_plan", "engineer"), decided(4, "first"),
      ended(5, "x_01_approve_plan", "approve_plan"),
      chapter(6, 2), started(7, "x_02_approve_plan", "approve_plan", "engineer"), decided(8, "second"),
      ended(9, "x_02_approve_plan", "approve_plan"),
    ]);

    const notes = (await story(t)).chapters.map((each) =>
      each.items.map((item) => (item.type === "gate" ? item.decision?.notes : "")));
    expect(notes).toEqual([["first"], ["second"]]);
  });

  it("stops a phase the session ended under, and counts the time of a run a resume took over", async () => {
    const t = cockpit();
    const token = await factory(t);
    const finished = { ...fixture("session_finished", 4), ts: "2026-09-29T12:00:04.000+00:00" };
    await ship(t, token, [fixture("session_started", 1), chapter(2, 1), started(3, "x_01_build", "build"), finished]);
    // Killed mid-phase: no phase_ended, only the session's end.
    expect((await story(t)).chapters[0].items[0]).toMatchObject({ status: "fail", duration: 1 });

    const resumed = { ...fixture("session_resumed", 7), payload: { workflow: "gated", chapter: 1 } };
    await ship(t, token, [{ ...fixture("session_started", 5), ts: "2026-09-29T12:00:05.000+00:00" },
                          { ...fixture("session_finished", 6), ts: "2026-09-29T12:00:05.500+00:00" },
                          resumed, started(8, "x_01_build", "build"), ended(10, "x_01_build", "build")]);
    await ship(t, token, [{ ...fixture("usage", 9), ts: "2026-09-29T12:00:09.000+00:00" }]);
    // One second before the kill, two after the resume.
    expect((await story(t)).chapters[0].items).toMatchObject([
      { type: "agent", name: "build", status: "success", duration: 3 },
      { type: "resumed" },
    ]);
  });

  it("tells a rollback and a limit hit as facts of the phase they stopped, not as its error", async () => {
    const t = cockpit();
    const token = await factory(t);
    const said = (kind: string, seq: number, payload: Record<string, unknown>) => ({ ...fixture(kind, seq), payload });
    await ship(t, token, [
      fixture("session_started", 1), chapter(2, 1),
      started(3, "x_01_scout", "scout"),
      said("permission_rolled_back", 4, { phase_id: "x_01_scout", phase: "scout", agent: "scout",
                                          paths: ["notes/a.md"], not_undone: ["README.md"] }),
      ended(5, "x_01_scout", "scout", "fail", { error: "scout is read-only but modified 2 path(s)" }),
      started(6, "x_02_build", "build"),
      said("limit_hit", 7, { phase_id: "x_02_build", phase: "build", agent: "builder", kind: "timeout",
                             limit: 1800, reached: 1800.4 }),
      ended(8, "x_02_build", "build", "fail", { error: "agent ran past its 1800s limit" }),
    ]);

    const [scout, build] = (await story(t)).chapters[0].items;
    expect(scout).toMatchObject({ type: "agent", rollback: { paths: ["notes/a.md"], notUndone: ["README.md"] }, limit: null });
    expect(build).toMatchObject({ type: "agent", rollback: null, limit: { kind: "timeout", limit: 1800, reached: 1800.4 } });
  });

  it("says a chapter whose phases passed was not accepted, and nothing for a factory that did not say", async () => {
    const t = cockpit();
    const token = await factory(t);
    const finished = (seq: number, number: number, v: number, payload: Record<string, unknown>) => ({
      ...fixture("workflow_finished", seq, v), payload: { workflow: "gated", chapter: number, ...payload } });
    await ship(t, token, [
      fixture("session_started", 1),
      chapter(2, 1), finished(3, 1, 1, { status: "fail", reason: "the run's acceptance criterion was not met" }),
      chapter(4, 2), finished(5, 2, 2, { status: "fail", reason: "test still failed", accepted: false }),
      chapter(6, 3), finished(7, 3, 2, { status: "success", reason: "", accepted: true }),
    ]);

    expect((await story(t)).chapters.map(({ status, accepted }) => [status, accepted]))
      .toEqual([["fail", null], ["fail", false], ["success", true]]);
  });

  it("tells each chapter's scores, arriving late, the latest of each scorer standing, with the phases they cite", async () => {
    const t = cockpit();
    const token = await factory(t);
    const said = (kind: string, seq: number, payload: Record<string, unknown>) => ({ ...fixture(kind, seq), payload });
    const scored = (seq: number, payload: Record<string, unknown>) =>
      said("chapter_scored", seq, { ...(fixture("chapter_scored", seq).payload as object), ...payload });
    await ship(t, token, [
      fixture("session_started", 1), chapter(2, 1),
      started(3, "x_01_plan", "plan"), ended(4, "x_01_plan", "plan"),
      started(5, "x_02_build", "build"),
      said("envelope_rejected", 6, { phase_id: "x_02_build", agent: "builder", output_type: "BuildOutput", attempt: 1 }),
      said("gate_result", 7, { phase_id: "x_02_build", gate: "diff_matches_claims", attempt: 1, passed: false }),
      ended(8, "x_02_build", "build"),
      said("workflow_finished", 9, { workflow: "gated", chapter: 1, status: "success", reason: "", accepted: true }),
      fixture("session_finished", 10),
    ]);
    const before = await story(t);
    // Scored after the session finished, and one scorer twice: a chapter resumed and finished again.
    await ship(t, token, [
      scored(11, { chapter: 1, scorer: "corrections", class: "above", failing: true, evidence: [6, 7] }),
      scored(12, { chapter: 1, scorer: "lenient", class: "within", failing: false, evidence: [] }),
      scored(13, { chapter: 1, scorer: "corrections", class: "within", failing: false, evidence: [6] }),
      scored(14, { chapter: 7, scorer: "corrections", class: "above", failing: true, evidence: [] }),
    ]);

    const after = await story(t);
    expect(before.chapters[0].scores).toEqual([]);
    expect(after.chapters.map((each) => each.number)).toEqual([1]);      // no chapter opened by a score
    expect(after.chapters[0].scores).toEqual([
      { scorer: "corrections", kind: "code", class: "within", failing: false, evidence: [6],
        cites: [{ phaseId: "x_02_build", name: "build" }] },
      { scorer: "lenient", kind: "code", class: "within", failing: false, evidence: [], cites: [] },
    ]);
    expect({ ...after.chapters[0], scores: [] }).toEqual(before.chapters[0]);   // a score changes nothing else
  });

  it("keeps an agent phase's card though it wrote the chapter's request", async () => {
    const t = cockpit();
    const token = await factory(t);
    const request = { ...fixture("artifact_written", 4),
                      payload: { ...fixture("artifact_written", 4).payload as object, phase_id: "x_01_ask", role: "request" } };
    await ship(t, token, [fixture("session_started", 1), chapter(2, 1), started(3, "x_01_ask", "ask"), request]);

    const [first] = (await story(t)).chapters;
    expect(first.asked).not.toBeNull();
    expect(first.items).toMatchObject([{ type: "agent", name: "ask" }]);
  });
});

describe("a session whose factory records its stages", () => {
  // The same story, recorded by a factory whose chapters name their stages
  // (`workflow_started` v2) and whose phases say which one they belong to
  // (`phase_started` v3).
  async function staged() {
    const t = cockpit();
    const token = await factory(t);
    await ship(t, token, recorded["issue-then-two-reviews-in-stages"].events);
    return story(t);
  }

  it("names each chapter's stages, in order, as its workflow listed them", async () => {
    const { chapters } = await staged();

    expect(chapters.map((chapter) => chapter.stages)).toEqual([
      ["scout", "plan", "commit", "implement", "verify", "review", "commit", "document", "commit", "integrate"],
      ["implement", "verify", "commit"],
      ["implement", "verify", "commit"],
    ]);
  });

  it("puts every phase in the stage that opened it, gates and revisions included, and the work item and report in none", async () => {
    const { chapters } = await staged();
    const [first, review] = chapters;
    const stageOf = (items: typeof first.items) => items.flatMap((item) =>
      item.type === "automatic" || item.type === "resumed" ? [] : [`${item.name} ${item.stageIndex}`]);

    expect(first.reader).toMatchObject({ name: "issue", stageIndex: null });
    expect(stageOf(first.items)).toEqual([
      "scout 0", "plan 1", "approve_plan 1", "plan_revise_1 1", "approve_plan_2 1", "commit_plan 2",
      "implement 3", "verify_1 4", "review_1 5", "commit_implement 6", "changes 7", "document 7",
      "commit_document 8", "integrate 9", "report null"]);
    expect(review.reader).toMatchObject({ name: "pr", stageIndex: null });
    expect(stageOf(review.items)).toEqual(["implement 0", "verify_1 1", "commit_implement 2", "report null"]);
  });

  it("tells a session recorded before stages were with none, and no stage guessed from a phase's name", async () => {
    const { t } = await told();
    const { chapters } = await story(t);

    expect(chapters.map((chapter) => chapter.stages)).toEqual([[], [], []]);
    for (const chapter of chapters) {
      for (const item of chapter.items) {
        if ("stageIndex" in item) expect(item.stageIndex, `${item.type} ${item.name}`).toBeNull();
      }
    }
  });
});

describe("the story's readers", () => {
  it.each(Object.keys(corpus))("tell %s if they tell its kind at all", (name) => {
    const { kind, v: version } = corpus[name];
    const told = toldVersions(kind);
    if (told.length) expect(told, `${kind} v${version} has a reader but no teller in story.ts`).toContain(version);
  });
});

describe("a story from a newer factory", () => {
  it("leaves out what it cannot read, and still tells the rest", async () => {
    const t = cockpit();
    const token = await factory(t);
    const unknown = { seq: 2, ts: "2026-09-29T12:00:00.000+00:00", kind: "phase_paused", v: 1,
                      payload: { phase_id: "5c0075aa_03_plan" } };
    await ship(t, token, [fixture("session_started", 1), unknown, { ...fixture("phase_started", 3, 2) }]);

    const { chapters, now } = await story(t);
    expect(now.phase).toMatchObject({ name: "plan", kind: "agent" });
    // No workflow_started from this factory yet: the phases still have a chapter to sit in.
    expect(chapters).toMatchObject([{ number: 0, workflow: "ship", items: [{ type: "agent", name: "plan" }] }]);
  });
});
