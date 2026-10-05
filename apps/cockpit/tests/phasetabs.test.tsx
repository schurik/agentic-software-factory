import { renderToStaticMarkup } from "react-dom/server";
import { ViewerLogin } from "../components/viewer";
import { describe, expect, it } from "vitest";
import { PhaseTabs, RepoFile, tabsFor, type Where } from "../components/session/PhaseTabs";
import type { Phase } from "../convex/model/graph";
import type { Artifact, PhaseDetail } from "../convex/model/phase";
import { phaseView, view } from "../convex/model/session";
import { fixture, recorded, type WireEvent } from "./helpers";

// A phase opened into its tabs in the drawer, rendered from the golden corpus
// the way a browser first paints it: the same folds the queries run, straight
// into the component. phase.test.ts says what each tab holds; this says what
// a person reads in it.

const { events: RECORDED } = recorded["issue-then-two-reviews"];
const WHERE: Where = { factory: "acme/widgets", session: "a9f259f0", forge: "https://github.com" };

const stored = (events: WireEvent[]) => events.map((event) => ({ ...event, payload: JSON.stringify(event.payload) }));

function detail(phaseId: string, events: WireEvent[] = RECORDED): PhaseDetail {
  return phaseView(stored(events), events.at(-1)!.seq, phaseId)!;
}

/** The phase as the session's story tells it: the part of the drawer that is not its tabs' own query. */
function item(phaseId: string, events: WireEvent[] = RECORDED): Phase {
  const { story } = view(stored(events), events.at(-1)!.seq);
  return story.chapters.flatMap((chapter) => [...(chapter.reader ? [chapter.reader] : []), ...chapter.items])
    .find((each): each is Phase => "phaseId" in each && each.phaseId === phaseId)!;
}

/** The tabs as the drawer renders them, `name` showing — the tab its address names. */
const tabs = (phaseId: string, name: string, events: WireEvent[] = RECORDED) =>
  renderToStaticMarkup(<PhaseTabs item={item(phaseId, events)} detail={detail(phaseId, events)} where={WHERE} tab={name} />);

function shown(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
}

const tab = (phaseId: string, name: string, events?: WireEvent[]) => shown(tabs(phaseId, name, events));

describe("every tab of every phase of the recorded session", () => {
  const { story } = view(stored(RECORDED), RECORDED.at(-1)!.seq);
  const phases = story.chapters.flatMap((chapter) => chapter.items)
    .filter((item) => item.type === "agent" || item.type === "code");

  it("offers only the tabs with something in them, Overview first", () => {
    expect(tabsFor(detail("a9f259f0_02_scout"))).toEqual(["overview", "artifacts", "checks", "tools", "transcript", "events"]);
    expect(tabsFor(detail("a9f259f0_08_implement"))).toEqual(["overview", "checks", "tools", "transcript", "events"]);
    expect(tabsFor(detail("a9f259f0_09_verify_1"))).toEqual(["overview", "checks", "events"]);
    expect(tabsFor(detail("a9f259f0_04_approve_plan"))).toEqual(["overview", "events"]);
  });

  it("opens on Overview when the address names no tab, or one the phase does not have", () => {
    expect(tabs("a9f259f0_09_verify_1", "")).toMatch(/<button[^>]*aria-selected="true"[^>]*>Overview/);
    expect(tabs("a9f259f0_09_verify_1", "transcript")).toMatch(/<button[^>]*aria-selected="true"[^>]*>Overview/);
  });

  it.each(phases.map((item) => [item.name, item.phaseId]))("renders for %s (%s)", (_, phaseId) => {
    for (const name of tabsFor(detail(phaseId))) {
      const html = tabs(phaseId, name);
      expect(html).toMatch(new RegExp(`<button[^>]*aria-selected="true"[^>]*>${name}`, "i"));
      expect(shown(html).length).toBeGreaterThan(0);
    }
  });
});

describe("the Artifacts tab", () => {
  it("shows a handoff file inline, a markdown one rendered", () => {
    const text = tab("a9f259f0_02_scout", "artifacts");
    expect(text).toContain("context_handoff/scout_findings.md handoff · 112 B · shipped with the session");
    expect(tabs("a9f259f0_02_scout", "artifacts")).toMatch(/<h1>Findings<\/h1>/);
    expect(text).not.toContain("# Findings");
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
    const html = tabs("5c0075aa_03_plan", "artifacts", events);
    expect(shown(html)).toContain("Changed later in 9999999 · compare");
    expect(html).toContain(`href="https://github.com/acme/widgets/compare/3e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f...${"9".repeat(40)}"`);
  });
});

describe("a repo file, as read from the forge", () => {
  const artifact = detail("a9f259f0_05_plan_revise_1").artifacts[0] as Artifact;
  const file = (got: Parameters<typeof RepoFile>[0]["got"]) =>
    shown(renderToStaticMarkup(<RepoFile artifact={artifact} got={got} />));

  it("shows the file, a markdown one rendered, and says so when it was cut at the cap", () => {
    const got = { ok: true as const, sha: "2512a3c", content: "# Plan\n- one", truncated: true, binary: false, matches: true };
    expect(renderToStaticMarkup(<RepoFile artifact={artifact} got={got} />)).toMatch(/<h1>Plan<\/h1>\s*<ul>\s*<li>one<\/li>/);
    const text = file(got);
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
  it("Overview: what it was for, what it reported, and the flags it filed", () => {
    const text = tab("a9f259f0_03_plan", "overview");
    expect(text).toContain("Turn the request into an implementable plan");
    expect(text).toContain("PlanOutput a required meeting date, and a test for its format");
    expect(text).toContain('"summary": "a required meeting date, and a test for its format"');
    expect(text).toContain("⚑ risk the date is local midnight");
    expect(text).toMatch(/Instructions asf\/stages\/plan\/task\.md ?, and the journal as of this phase/);
    expect(text).toContain("Context window 121k of 200k tokens · 61%");
  });

  it("Overview: what a person said at a gate, as the instruction the next agent reads", () => {
    const text = tab("a9f259f0_04_approve_plan", "overview");
    expect(text).toContain("Rejected by asf tests · via the terminal");
    expect(text).toContain("✎ “name the module the date is converted in”");
  });

  it("Overview: the command a code step ran, with the end of its output, and the commit it made", () => {
    expect(tab("a9f259f0_09_verify_1", "overview")).toMatch(/\$ .+ exit 0/);
    const commit = tabs("a9f259f0_07_commit_plan", "overview");
    expect(commit).toMatch(/<a href="https:\/\/github.com\/acme\/widgets\/commit\/2512a3c[0-9a-f]*"><code>2512a3c<\/code><\/a>/);
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
    const html = tabs("a9f259f0_03_plan", "transcript", events);
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

  it("Transcript: says the viewer purged it as you", () => {
    const events = pruned(["prompt_rendered", "harness_output"], { on: "2026-11-01T09:30:00.000Z", reason: "purged", by: "alex" });
    const html = renderToStaticMarkup(
      <ViewerLogin.Provider value="alex">
        <PhaseTabs item={item("a9f259f0_05_plan_revise_1", events)} detail={detail("a9f259f0_05_plan_revise_1", events)} where={WHERE} tab="transcript" />
      </ViewerLogin.Provider>);
    expect(shown(html)).toContain("transcript purged on Nov 1, 2026 by you");
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
