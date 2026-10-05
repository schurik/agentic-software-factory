import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DRAWER_LOOK } from "../components/Drawer";
import { PhaseTabs } from "../components/session/PhaseTabs";
import { DrawerView } from "../components/session/SessionDrawer";
import type { Page } from "../components/session/SessionView";
import { SHOWN, type Shown } from "../components/session/shown";
import { ViewerLogin } from "../components/viewer";
import type { Phase } from "../convex/model/graph";
import { phaseView, view } from "../convex/model/session";
import { recorded, type WireEvent } from "./helpers";

// The one drawer a stage and a phase open into (#110), rendered from the
// golden corpus the way a browser first paints it: what the address says is
// open (`Shown`), drawn from the same fold the query runs. A click is the
// address it sets, so "one click away" is rendering with that address.

const STAGED = recorded["issue-then-two-reviews-in-stages"].events;
const WHERE = { factory: "acme/widgets", session: "a9f259f0", forge: "https://github.com" };

const stored = (events: WireEvent[]) => events.map((event) => ({ ...event, payload: JSON.stringify(event.payload) }));

function page(events: WireEvent[]): Page {
  const acked = events.at(-1)?.seq ?? 0;
  return { ...WHERE, acked, budget: null, ...view(stored(events), acked) };
}

function html(shown: Partial<Shown>, { events = STAGED, viewer = null as string | null } = {}): string {
  // A phase's tabs, the way the live page asks for them: its detail is a query of its own.
  const phase = (item: Phase, tab: string | null): ReactNode => (
    <PhaseTabs item={item} detail={phaseView(stored(events), events.at(-1)!.seq, item.phaseId)!} where={WHERE} tab={tab} />
  );
  return renderToStaticMarkup(
    <ViewerLogin.Provider value={viewer}>
      <DrawerView page={page(events)} shown={{ ...SHOWN, ...shown }} onShow={() => {}} phase={phase} />
    </ViewerLogin.Provider>,
  );
}

/** What a person reads: the text, whitespace collapsed, markup and entities gone. */
function read(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
}

describe("a stage's drawer", () => {
  it("opens from the address on the stage: its context, a pill and its purpose, and its phases", () => {
    const text = read(html({ stage: "1.1" }));
    expect(text).toMatch(/plan stage/);
    expect(text).toContain("acme/widgets · a9f259f0 · chapter 1 · issue · stage 2 of 10");
    expect(text).toContain("Turn the request into a plan");
    expect(text).toMatch(/plan gate · round 1 .*✎ asf tests: name the module the date is converted in/);
    expect(text).toMatch(/plan revision 1 .*plan gate · round 2/);
    // A gate took no work: what it took is how long it waited for the person.
    expect(text).toMatch(/plan gate · round 1 .*✎ asf tests: name the module the date is converted in waited (<1s|\d+s)/);
  });
});

describe("a phase's drawer", () => {
  it("opens from the address on Overview, with who ran it, how long, tokens and cost in its header line", () => {
    const markup = html({ phase: "a9f259f0_03_plan" });
    expect(markup).toMatch(/<button[^>]*aria-selected="true"[^>]*>Overview/);
    const text = read(markup);
    expect(text).toMatch(/plan phase/);
    expect(text).toContain("acme/widgets · a9f259f0 · chapter 1 · plan stage");
    expect(text).toMatch(/agent · planner · opus .*<1s .*6,100 tokens .*\$0\.10 .*replayed on resume/);
    expect(text).toContain("a required meeting date, and a test for its format");
  });

  it("counts the corrections an agent was re-prompted with", () => {
    expect(read(html({ phase: "a9f259f0_05_plan_revise_1" }))).toContain("1 correction");
  });

  it("is one click from a stage's phase row, and Back goes to the stage", () => {
    const stage = html({ stage: "1.1" });
    expect(stage).toMatch(/<a [^>]*href="\?stage=1\.1&amp;phase=a9f259f0_05_plan_revise_1"/);
    const pushed = html({ stage: "1.1", phase: "a9f259f0_05_plan_revise_1" });
    expect(pushed).toMatch(/<a [^>]*href="\?stage=1\.1"[^>]*>.*?Back<\/a>/);
    expect(read(pushed)).toMatch(/plan revision 1 phase/);
    // Opened on its own, there is nothing to go back to.
    expect(html({ phase: "a9f259f0_05_plan_revise_1" })).not.toContain("Back</a>");
  });

  it("shows nothing when the address names no stage or phase of the session", () => {
    expect(html({})).toBe("");
    expect(html({ stage: "9.9" })).toBe("");
  });
});

describe("without the transcript opt-in", () => {
  const TRANSCRIPT = ["prompt_rendered", "harness_output"];
  const shipped = STAGED.filter((event) => !TRANSCRIPT.includes(event.kind)).map((event, index) => ({ ...event, seq: index + 1 }));

  it("marks an agent's Transcript tab off on whichever tab the drawer opens, and says why on it", () => {
    expect(read(html({ phase: "a9f259f0_03_plan" }, { events: shipped }))).toContain("Transcript · off");
    const transcript = read(html({ phase: "a9f259f0_03_plan", phaseTab: "transcript" }, { events: shipped }));
    expect(transcript).toContain("Transcripts are off for this factory: the session shipped no prompt and no harness output.");
    expect(transcript).toContain("cockpit: {transcripts: true} in asf/factory.yaml turns them on");
  });
});

describe("the drawer's shell", () => {
  // The shell is Base UI's and draws nothing outside a browser; what it is drawn
  // as is its classes — a bottom sheet below 768px, a right-hand panel from it.
  it("is a bottom sheet at 92% of the screen's height below 768px", () => {
    expect(DRAWER_LOOK.viewport).toContain("items-end");
    expect(DRAWER_LOOK.popup).toMatch(/max-md:h-\[92dvh\] max-md:w-full max-md:rounded-t-2xl/);
  });

  it("is a panel from the right, up to 720px wide, from 768px", () => {
    expect(DRAWER_LOOK.viewport).toContain("md:justify-end");
    expect(DRAWER_LOOK.popup).toMatch(/md:h-full md:w-\[min\(720px,100vw\)\]/);
  });
});
