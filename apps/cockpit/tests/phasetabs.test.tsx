import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PhaseTabs, RepoFile, tabsFor, type Where } from "../components/session/PhaseTabs";
import type { Artifact, PhaseDetail } from "../convex/model/phase";
import { phaseView, view } from "../convex/model/session";
import { fixture, recorded, type WireEvent } from "./helpers";

// A phase opened into its tabs, rendered from the golden corpus the way a
// browser first paints it: the same fold the query runs, straight into the
// component. phase.test.ts says what each tab holds; this says what a person
// reads in it.

const { events: RECORDED } = recorded["issue-then-two-reviews"];
const WHERE: Where = { factory: "acme/widgets", session: "a9f259f0", forge: "https://github.com" };

const stored = (events: WireEvent[]) => events.map((event) => ({ ...event, payload: JSON.stringify(event.payload) }));

function detail(phaseId: string, events: WireEvent[] = RECORDED): PhaseDetail {
  return phaseView(stored(events), events.at(-1)!.seq, phaseId)!;
}

function shown(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
}

const tab = (phaseId: string, name: string, events?: WireEvent[]) =>
  shown(renderToStaticMarkup(<PhaseTabs detail={detail(phaseId, events)} where={WHERE} initial={name} />));

describe("every tab of every phase of the recorded session", () => {
  const { story } = view(stored(RECORDED), RECORDED.at(-1)!.seq);
  const phases = story.chapters.flatMap((chapter) => chapter.items)
    .filter((item) => item.type === "agent" || item.type === "code");

  it("offers an agent all seven, and a code step what it has", () => {
    expect(tabsFor(detail("a9f259f0_02_scout"))).toEqual(
      ["artifacts", "overview", "checks", "tools", "transcript", "cost", "events"]);
    expect(tabsFor(detail("a9f259f0_08_implement"))).toEqual(
      ["overview", "checks", "tools", "transcript", "cost", "events"]);
    expect(tabsFor(detail("a9f259f0_09_verify_1"))).toEqual(["overview", "checks", "events"]);
  });

  it.each(phases.map((item) => [item.name, item.phaseId]))("renders for %s (%s)", (_, phaseId) => {
    for (const name of tabsFor(detail(phaseId))) {
      const html = renderToStaticMarkup(<PhaseTabs detail={detail(phaseId)} where={WHERE} initial={name} />);
      expect(html).toMatch(new RegExp(`<button[^>]*aria-selected="true"[^>]*>${name}`, "i"));
      expect(shown(html).length).toBeGreaterThan(0);
    }
  });
});

describe("the Artifacts tab", () => {
  it("shows a handoff file inline", () => {
    const text = tab("a9f259f0_02_scout", "artifacts");
    expect(text).toContain("context_handoff/scout_findings.md handoff · 112 B · shipped with the session");
    expect(text).toContain("# Findings");
  });

  it("says where a repo file is read from, or why it cannot be", () => {
    expect(tab("a9f259f0_05_plan_revise_1", "artifacts")).toContain(
      "docs/asf/spec/plan.md in the repository · 122 B · committed by commit_plan at 2512a3c");
    expect(tab("a9f259f0_03_plan", "artifacts")).toContain(
      "plan_revise_1 wrote it again before anything committed it: this version never reached the forge.");
  });

  it("says a capped handoff file was cut, and how big it was", () => {
    const capped = fixture("artifact_written", 3);
    Object.assign(capped.payload, { phase_id: "5c0075aa_03_plan", size: 400_000, truncated: true });
    const text = tab("5c0075aa_03_plan", "artifacts", [fixture("session_started", 1), fixture("phase_started", 2, 2), capped]);
    expect(text).toContain("Cut at the factory's cap: the file was 390.6 KB, and this is its start.");
  });

  it("links a repo file changed by a later commit to the comparison", () => {
    const written = fixture("artifact_written", 3);
    Object.assign(written.payload, { phase_id: "5c0075aa_03_plan", location: "repo", path: "docs/spec.md", content: "" });
    const later = fixture("committed", 5);
    Object.assign(later.payload, { sha: "9".repeat(40), files: ["docs/spec.md"] });
    const events = [fixture("session_started", 1), fixture("phase_started", 2, 2), written, fixture("committed", 4), later];
    const html = renderToStaticMarkup(<PhaseTabs detail={detail("5c0075aa_03_plan", events)} where={WHERE} initial="artifacts" />);
    expect(shown(html)).toContain("Changed later in 9999999 · compare");
    expect(html).toContain(`href="https://github.com/acme/widgets/compare/3e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f...${"9".repeat(40)}"`);
  });
});

describe("a repo file, as read from the forge", () => {
  const artifact = detail("a9f259f0_05_plan_revise_1").artifacts[0] as Artifact;
  const file = (got: Parameters<typeof RepoFile>[0]["got"]) =>
    shown(renderToStaticMarkup(<RepoFile artifact={artifact} got={got} />));

  it("shows the file, and says so when it was cut at the cap", () => {
    const text = file({ ok: true, sha: "2512a3c", content: "# Plan", truncated: true, binary: false, matches: true });
    expect(text).toContain("# Plan");
    expect(text).toContain("Cut at 256 KB: the file is 122 B, and this is its start.");
  });

  it("says when the forge holds something other than what the phase wrote", () => {
    expect(file({ ok: true, sha: "2512a3c", content: "# Plan", truncated: false, binary: false, matches: false }))
      .toContain("Not byte for byte what this phase wrote: it was changed again before this commit.");
  });

  it("says why it could not be read", () => {
    expect(file({ ok: false, because: "the forge does not show it" })).toContain("Not read: the forge does not show it.");
    expect(file(null)).toContain("Reading it from the forge at 2512a3c");
  });
});

describe("the other tabs", () => {
  it("Overview: what it was for, what it was given, and the envelope it reported", () => {
    const text = tab("a9f259f0_03_plan", "overview");
    expect(text).toContain("Turn the request into an implementable plan");
    expect(text).toContain("asf/stages/plan/task.md");
    expect(text).toContain("Envelope · PlanOutput");
    expect(text).toContain('"summary": "a required meeting date, and a test for its format"');
  });

  it("Checks: each gate's verdict and each refused envelope", () => {
    const text = tab("a9f259f0_05_plan_revise_1", "checks");
    expect(text).toMatch(/✓ artifacts_exist attempt 1 · \d\d:\d\d( [AP]M)? docs\/asf\/spec\/plan\.md: exists, 122B/);
    expect(text).toContain("✓ artifacts_exist on resume, checked against the record ·");
    expect(text).toContain("✕ PlanOutput refused, attempt 1: no JSON object found in the response → re-prompted in the same session");
  });

  it("Tools: every call's name, outcome and duration, and nothing it was given", () => {
    const text = tab("a9f259f0_02_scout", "tools");
    expect(text).toContain("3 calls, 1 failed");
    expect(text).toMatch(/read ✕ failed 0ms/);
    expect(text).toContain("What a call was given and returned is transcript material");
  });

  it("Cost: the phase's spend, and how full the context window got", () => {
    const text = tab("a9f259f0_03_plan", "cost");
    expect(text).toContain("opus 6,100 $0.10");
    expect(text).toContain("121k of 200k tokens · 61%");
  });

  it("Transcript: the prompts and harness output when the factory opted in", () => {
    const text = tab("a9f259f0_05_plan_revise_1", "transcript");
    expect(text).toContain("Prompt 1");
    expect(text).toContain("# Planner");
    expect(text).toContain("Prompt 2 · a correction");
    expect(text).toContain("Harness output");
  });

  it("Transcript: says transcripts are off, and how to turn them on, when the session shipped none", () => {
    const events = RECORDED.filter((event) => !["prompt_rendered", "harness_output"].includes(event.kind))
      .map((event, index) => ({ ...event, seq: index + 1 }));
    const html = renderToStaticMarkup(<PhaseTabs detail={detail("a9f259f0_03_plan", events)} where={WHERE} initial="transcript" />);
    expect(shown(html)).toContain("Transcripts are off for this factory");
    expect(shown(html)).toContain("cockpit: {transcripts: true}");
    expect(shown(html)).toMatch(/Transcript · off/);
  });

  it("Events: the phase's own events, each in a line that opens to the raw event", () => {
    const text = tab("a9f259f0_02_scout", "events");
    expect(text).toContain("scout called read: failed after 0ms");
    expect(text).toContain('"tool": "grep"');
  });
});

describe("a pruned body", () => {
  const pruned = (kinds: string[], marker: Record<string, string>) => RECORDED.map((event) =>
    kinds.includes(event.kind) ? { ...event, payload: { phase_id: event.payload.phase_id, pruned: marker } } : event);

  it("Transcript: says when the transcript aged out", () => {
    const events = pruned(["prompt_rendered", "harness_output"], { on: "2026-11-01T09:30:00.000Z", reason: "aged_out" });
    const text = tab("a9f259f0_05_plan_revise_1", "transcript", events);
    expect(text).toContain("transcript aged out on Nov 1, 2026");
    expect(text).not.toContain("Transcripts are off");
  });

  it("Transcript: says who purged it, and when", () => {
    const events = pruned(["prompt_rendered", "harness_output"], { on: "2026-11-01T09:30:00.000Z", reason: "purged", by: "alex" });
    expect(tab("a9f259f0_05_plan_revise_1", "transcript", events)).toContain("transcript purged on Nov 1, 2026 by alex");
  });

  it("Artifacts: says a handoff file's content was purged", () => {
    const events = RECORDED.map((event) => event.kind === "artifact_written"
      ? { ...event, payload: { ...event.payload, content: undefined, pruned: { on: "2026-11-01T09:30:00.000Z", reason: "purged", by: "alex" } } }
      : event);
    const text = tab("a9f259f0_02_scout", "artifacts", events);
    expect(text).toContain("content purged on Nov 1, 2026 by alex");
    expect(text).not.toContain("# Findings");
  });
});
