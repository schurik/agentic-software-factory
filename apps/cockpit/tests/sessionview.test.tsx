import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PhaseTabs, tabsFor, type Where } from "../components/session/PhaseTabs";
import { DrawerView } from "../components/session/SessionDrawer";
import { SessionView, sessionMenu, type Page } from "../components/session/SessionView";
import { readShown, SHOWN, type Shown, writeShown } from "../components/session/shown";
import { firstLine } from "../components/session/Timeline";
import { ViewerLogin } from "../components/viewer";
import type { ClaimView } from "../convex/model/claim";
import type { SteeringView } from "../convex/model/command";
import type { Phase } from "../convex/model/graph";
import { phaseView, view } from "../convex/model/session";
import { fixture, recorded, type WireEvent } from "./helpers";

// The session page rendered from the golden corpus, the way a browser first
// paints it: the same fold the query runs (model/session.ts), straight into the
// component, with no backend in between. What a click would show is rendered
// from the address that click sets (`Shown`), the way a shared link opens it.
// graph.test.ts says what the graph IS; this says what a person SEES of it.

const STAGED = recorded["issue-then-two-reviews-in-stages"].events;
const { journal: STAGED_JOURNAL } = recorded["issue-then-two-reviews-in-stages"];
const BEFORE = recorded["issue-then-two-reviews"].events;
const WHERE: Where = { factory: "acme/widgets", session: "a9f259f0", forge: "https://github.com" };
// Three and a half minutes after the session started, on the recording's own clock.
const NOW = Date.parse("2026-10-04T22:45:00Z");

const stored = (events: WireEvent[]) => events.map((event) => ({ ...event, payload: JSON.stringify(event.payload) }));
/** The recording up to and including the event at `seq`. */
const upTo = (seq: number, events = STAGED) => events.filter((event) => event.seq <= seq);
const failedIn = (events: WireEvent[]) => [...events, fixture("session_finished", events.at(-1)!.seq + 1)];

const SUSPENDED = 37;          // at the plan gate, round 1
const BUILDING = 126;          // the builder has just started

function page(events: WireEvent[], extra: Partial<Page> = {}): Page {
  const acked = events.at(-1)?.seq ?? 0;
  return { ...WHERE, acked, budget: null, ...view(stored(events), acked), ...extra };
}

interface Rendered {
  events?: WireEvent[];
  shown?: Partial<Shown>;
  steering?: SteeringView;
  claims?: ClaimView[];
  extra?: Partial<Page>;
  viewer?: string;
}

/**
 * The page as first painted, and the drawer the address opens over it — with
 * a phase's tabs the way the live page asks for them. The drawer's shell
 * draws nothing until a browser opens it, so its view is rendered after the page.
 */
function html({ events = STAGED, shown = {}, steering, claims, extra, viewer }: Rendered = {}): string {
  const phase = (item: Phase, tab: string | null): ReactNode => (
    <PhaseTabs item={item} detail={phaseView(stored(events), events.at(-1)!.seq, item.phaseId)!} where={WHERE} tab={tab} />
  );
  const at = { page: page(events, extra), shown: { ...SHOWN, ...shown }, onShow: () => {}, phase };
  return renderToStaticMarkup(
    <ViewerLogin.Provider value={viewer ?? null}>
      <SessionView {...at} now={NOW} steering={steering} claims={claims} onCommand={() => {}} onRelease={() => {}} />
      <DrawerView {...at} />
    </ViewerLogin.Provider>,
  );
}

/** What a person reads: the text, whitespace collapsed, markup and entities gone. */
function read(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
}

const text = (rendered: Rendered = {}) => read(html(rendered));

/** The header: from the page's start to the end of its <header>. */
const header = (markup: string) => markup.slice(0, markup.indexOf("</header>"));

/** One chapter's row on the page, by its number. */
function chapter(markup: string, number: number): string {
  const from = markup.indexOf(`data-chapter="${number}"`);
  if (from === -1) throw new Error(`no chapter ${number} on the page`);
  const next = markup.indexOf("data-chapter=", from + 1);
  return markup.slice(markup.lastIndexOf("<", from), next === -1 ? markup.indexOf('role="tablist"', from) : next);
}

/** One stage card of a chapter's graph, by its index. */
function stage(markup: string, index: number): string {
  const from = markup.indexOf(`data-stage="${index}"`);
  if (from === -1) throw new Error(`no stage ${index} drawn`);
  const next = markup.indexOf("data-stage=", from + 1);
  return read(markup.slice(markup.lastIndexOf("<", from), next === -1 ? undefined : markup.lastIndexOf("<", next))).trim();
}

const station = { name: "schurik@mbp:widgets", kind: "local", owner: "schurik", registered: true, seenAt: 0, verbs: ["kill", "resume"] };
const attended: SteeringView = { station, attendedAt: NOW - 2000, kill: null, killRefused: null, resume: null, resumeRefused: null };
const online: SteeringView = { ...attended, attendedAt: null, station: { ...station, seenAt: NOW - 2000 } };
const away: SteeringView = { ...attended, attendedAt: null, station: { ...station, seenAt: NOW - 26 * 3600_000 } };

describe("the header", () => {
  it("names the session, links its work item, pull request and branch on the forge, and says its status", () => {
    const top = header(html());
    expect(read(top)).toContain("acme/widgets / sessions / a9f259f0");
    expect(read(top)).toContain("#42 Resolve relative due dates via the meeting date");
    expect(top).toMatch(/<a [^>]*href="https:\/\/forge\/acme\/widgets\/issues\/42"[^>]*>.*?#42<\/span><\/a>/);
    expect(top).toMatch(/<a [^>]*href="https:\/\/forge\/acme\/widgets\/pull\/9"[^>]*>.*?#9<\/span><\/a>/);
    expect(top).toMatch(/<a [^>]*href="https:\/\/github.com\/acme\/widgets\/tree\/asf\/a9f259f0"[^>]*>.*?asf\/a9f259f0<\/span><\/a>/);
    expect(read(top)).toContain("success");
  });

  it("offers a finished session's pull request as its one action", () => {
    expect(header(html())).toMatch(/<a [^>]*href="https:\/\/forge\/acme\/widgets\/pull\/9"[^>]*>Pull request #9/);
  });

  it("says whom a gate waits on when it is someone else, and offers nothing to press", () => {
    const events = upTo(SUSPENDED).map((event) => event.kind === "suspended"
      ? { ...event, payload: { ...event.payload, trusted: ["octocat"] } } : event);
    const top = header(html({ events, viewer: "alex" }));
    expect(read(top)).toContain("Waiting on octocat");
    expect(top).not.toMatch(/<button[^>]*>(?!<)/);
  });

  it("leaves a gate waiting on the viewer to the Now card, which sends them to answer it", () => {
    const markup = html({ events: upTo(SUSPENDED), viewer: "alex" });
    expect(read(header(markup))).not.toContain("Waiting on");
    expect(markup).toMatch(/<a [^>]*href="\/\?open=acme%2Fwidgets%2Fa9f259f0"[^>]*>Answer in the inbox/);
  });

  it("offers Kill while it runs, and says why not while the station cannot be reached", () => {
    const kill = (steering?: SteeringView) => header(html({ events: upTo(BUILDING), steering })).match(/<button[^>]*>Kill<\/button>/)![0];
    expect(kill(attended)).not.toContain(' disabled=""');
    expect(kill()).toContain(' disabled=""');
    expect(text({ events: upTo(BUILDING) })).toContain("the cockpit has not heard from this session's station");
  });

  it("offers Resume on a failed session whose station is online", () => {
    const top = header(html({ events: failedIn(upTo(BUILDING)), steering: online }));
    expect(top.match(/<button[^>]*>Resume<\/button>/)![0]).not.toContain(' disabled=""');
  });

  it("offers to queue a resume when the station is away, if it is back within the hour", () => {
    const top = header(html({ events: failedIn(upTo(BUILDING)), steering: away }));
    expect(top.match(/<button[^>]*>Queue resume<\/button>/)![0]).not.toContain(' disabled=""');
    expect(read(top)).toContain("if the station is back within the hour");
  });

  it("keeps copying the id and purging behind a ⋯ menu, purging for an admin only", () => {
    expect(html()).toMatch(/<button[^>]*aria-label="More"/);
    expect(sessionMenu({ ...page(STAGED), mayPurge: true })).toEqual(["copy", "purge"]);
    expect(sessionMenu({ ...page(STAGED), mayPurge: false })).toEqual(["copy"]);
  });
});

describe("the chapters, each one row", () => {
  it("opens the latest and folds the earlier ones to a line with a mini graph, how long and what it cost", () => {
    const markup = html();
    expect(chapter(markup, 3)).toContain('data-open="true"');
    for (const number of [1, 2]) {
      const row = chapter(markup, number);
      expect(row).toContain('data-open="false"');
      expect(row).not.toContain("data-stage=");
    }
    expect(read(chapter(markup, 1))).toMatch(/Chapter 1 issue answering issue #42 .*\d+s \$0\.\d\d/);
    expect(chapter(markup, 1)).toMatch(/<span[^>]*title="scout"/);
    expect(read(chapter(markup, 2))).toContain("Chapter 2 pr-review, round 1 answering pull request #9");
  });

  it("draws the open chapter as its stages, from the work item to the report, folded to a count when nothing happened there", () => {
    const row = chapter(html(), 3);
    expect(read(row)).toMatch(/read the review .*implement .*verify .*commit .*report/);
    expect(stage(row, 0)).toContain("implement 1 phase ›");
    expect(stage(row, 1)).toContain("verify 1 phase ›");
  });

  it("opens the stage a session is at, marked NOW, with its phases under their names for people", () => {
    const row = chapter(html({ events: upTo(SUSPENDED) }), 1);
    const plan = stage(row, 1);
    expect(plan).toMatch(/^now plan /i);
    expect(plan).toContain("plan gate · round 1 waiting");
    expect(stage(row, 0)).toContain("scout 1 phase ›");
    expect(stage(row, 2)).not.toContain("phase");     // not reached yet: nothing to count
  });

  it("opens a failed stage on its phases", () => {
    const row = chapter(html({ events: failedIn(upTo(BUILDING)) }), 1);
    expect(stage(row, 3)).toMatch(/implement .*implement failed/);
  });

  it("opens a stage that had a rejected round, and counts the rounds", () => {
    const row = chapter(html({ shown: { opened: [1] } }), 1);
    expect(stage(row, 1)).toContain("plan ↺ 1");
    expect(stage(row, 1)).toMatch(/plan .*plan gate · round 1 rejected by asf tests .*plan revision 1 .*plan gate · round 2 approved by asf tests/);
    expect(stage(row, 7)).toContain("document 2 phases ›");
  });

  it("shows a chapter, and a stage, opened from the address one click away", () => {
    const markup = html({ shown: { opened: [1], stages: ["3.1", "1.7"] } });
    expect(chapter(markup, 1)).toContain('data-open="true"');
    expect(chapter(markup, 2)).toContain('data-open="false"');
    expect(stage(chapter(markup, 3), 1)).toMatch(/verify verify #1 /);
    expect(stage(chapter(markup, 1), 7)).toMatch(/document collect the diff .*document /);
    // Folding the latest is an address too — and one that folded an earlier chapter still opens a later one.
    expect(html({ shown: { folded: [3] } })).not.toContain('data-open="true"');
    expect(chapter(html({ events: upTo(SUSPENDED), shown: { folded: [2] } }), 1)).toContain('data-open="true"');
  });

  it("opens a stage's drawer from its name, and a phase's from its row, keeping the tab the page is on", () => {
    const row = chapter(html({ events: upTo(SUSPENDED), shown: { tab: "journal" } }), 1);
    expect(row).toMatch(/<a href="\?tab=journal&amp;stage=1\.1"[^>]*>.*?plan<\/span>/);
    expect(row).toMatch(/<a href="\?tab=journal&amp;phase=a9f259f0_04_approve_plan"/);
  });

  it("draws a session recorded before stages as a flat chain of its phases", () => {
    const row = chapter(html({ events: BEFORE }), 3);
    expect(row).not.toContain("data-stage=");
    expect(read(row)).toMatch(/read the review .*implement .*verify #1 .*commit code .*report/);
  });
});

describe("the Now card", () => {
  const nowCard = (markup: string) => {
    const from = markup.indexOf('data-now=""');
    return markup.slice(from, markup.indexOf("</section>", from));
  };

  it("says what is happening in one sentence, and how long it has been going", () => {
    const card = read(nowCard(html({ events: upTo(BUILDING) })));
    expect(card).toContain("builder is working on implement in issue");
    expect(card).toMatch(/3m 2\ds elapsed/);
  });

  it("says where a finished session's work went, and how long it took", () => {
    const card = read(nowCard(html()));
    expect(card).toContain("All work landed in pull request #9");
    expect(card).toContain("15s took");
  });

  it("gauges the spend against the session's ceiling: amber from 80%, red at it, and no gauge without one", () => {
    const gauge = (maxCostUsd: number) => nowCard(html({ extra: { budget: { maxCostUsd, maxTokens: 0 } } }));
    expect(read(gauge(2.5))).toContain("$0.46 19% of $2.50");
    expect(gauge(2.5)).toMatch(/role="meter"[^>]*aria-valuenow="19"/);
    expect(gauge(2.5)).toContain("bg-accent");
    expect(gauge(0.5)).toContain("bg-wait");
    expect(read(gauge(0.5))).toContain("93% of $0.50");
    expect(gauge(0.4)).toContain("bg-bad");
    expect(read(gauge(0))).toContain("$0.46");
    expect(gauge(0)).not.toContain('role="meter"');
    expect(nowCard(html())).not.toContain('role="meter"');
  });

  it("links a failed session to the latest failure's phase, in the drawer", () => {
    const card = nowCard(html({ events: failedIn(upTo(BUILDING)) }));
    expect(read(card)).toContain("Failed in implement");
    expect(card).toMatch(/<a [^>]*href="\?phase=a9f259f0_08_implement"[^>]*>See implement’s output/);
  });
});

describe("the tabs", () => {
  it("open on Details, which holds only what the page shows nowhere else", () => {
    const markup = html({ claims: [], extra: { budget: { maxCostUsd: 2.5, maxTokens: 2_000_000 } } });
    expect(markup).toMatch(/<button[^>]*aria-selected="true"[^>]*>Details/);
    const details = read(markup.slice(markup.indexOf('role="tablist"')));
    expect(details).toContain("Station schurik@mbp:widgets run by asf tests");
    expect(details).toContain("Triggered by asf tests");
    expect(details).toContain("Tokens 27.1k of 2M tokens");
    expect(details).toContain("Base commit 2029981");
    expect(details).toContain("Transcripts on: the prompts and the harness's output are kept");
    // The branch and what it is based on are under the title.
    expect(details).not.toMatch(/Branch|main at/);
  });

  it("list every phase on the Timeline, per chapter, by its name for people, with who ran it and what came of it", () => {
    const timeline = text({ shown: { tab: "timeline" } });
    expect(timeline).toMatch(/Chapter 1 · issue .*read the issue .*tracker — Rules and decisions from a meeting/);
    expect(timeline).toContain("plan planner — a required meeting date, and a test for its format");
    expect(timeline).toContain("⚑ risk: the date is local midnight");
    expect(timeline).toContain("plan gate · round 1 asf tests — rejected");
    expect(timeline).toContain("✎ asf tests: name the module the date is converted in");
    expect(timeline).toContain("commit code git — feat: the prompt knows the meeting date");
    expect(timeline).toContain("⚙ integrate gate passed by policy · automatic, nobody was asked");
    expect(timeline).toMatch(/Chapter 3 · pr-review, round 2 .*read the review/);
  });

  it("keep the Journal exactly as the next agent reads it", () => {
    expect(text({ shown: { tab: "journal" } })).toContain(read(STAGED_JOURNAL).trim().slice(0, 400));
  });

  it("open a phase in the drawer from a Timeline row, and mark the row the drawer has open", () => {
    const timeline = html({ shown: { tab: "timeline" } });
    expect(timeline).toMatch(/<a href="\?tab=timeline&amp;phase=a9f259f0_03_plan"/);
    expect(timeline).not.toContain('aria-label="Phase"');
    const opened = html({ shown: { tab: "timeline", phase: "a9f259f0_03_plan" } });
    expect(opened).toMatch(/<a href="\?tab=timeline&amp;phase=a9f259f0_03_plan" aria-current="true"/);
    expect(opened.match(/aria-label="Phase"/g)).toHaveLength(1);
  });
});

describe("without the transcript opt-in", () => {
  const TRANSCRIPT = ["prompt_rendered", "harness_output"];
  const shipped = STAGED.filter((event) => !TRANSCRIPT.includes(event.kind)).map((event, index) => ({ ...event, seq: index + 1 }));
  const phases = view(stored(shipped), shipped.length).story.chapters
    .flatMap((each) => [...(each.reader ? [each.reader] : []), ...each.items])
    .flatMap((item) => (item.type === "agent" || item.type === "code" ? [item.phaseId] : []));

  it("shows no prompt and no tool call's arguments on the page or in any phase's tabs, and says why", () => {
    const everything = read([
      html({ events: shipped }),
      ...phases.flatMap((phaseId) => tabsFor(phaseView(stored(shipped), shipped.length, phaseId)!)
        .map((tab) => html({ events: shipped, shown: { tab: "timeline", phase: phaseId, phaseTab: tab } }))),
    ].join(" "));

    for (const sent of STAGED.filter((event) => event.kind === "prompt_rendered")) {
      for (const said of [sent.payload.system, sent.payload.prompt].map(String).filter(Boolean)) {
        expect(everything, `seq ${sent.seq}`).not.toContain(read(said).trim());
      }
    }
    expect(everything).not.toContain('"args"');
    expect(everything).toContain("Transcripts none kept: the session shipped no prompt and no tool call's arguments");
    expect(everything).toContain("Transcripts are off for this factory: the session shipped no prompt and no harness output.");
    expect(everything).toContain("What a call was given and returned is transcript material, and this factory has not opted in");
  });

  it("shows them once it opted in", () => {
    const [sent] = STAGED.filter((event) => event.kind === "prompt_rendered");
    const markup = html({ shown: { tab: "timeline", phase: String(sent.payload.phase_id), phaseTab: "transcript" } });
    expect(read(markup)).toContain(read(String(sent.payload.prompt)).trim().slice(0, 200));
  });
});

describe("the address", () => {
  it("reads back what it wrote, and writes nothing for the page as it first opens", () => {
    const shown: Shown = { tab: "timeline", opened: [1], folded: [3], stages: ["3.1"], stage: "1.1", phase: "a9f259f0_03_plan", phaseTab: "checks" };
    expect(readShown(new URLSearchParams(writeShown(shown)))).toEqual(shown);
    expect(readShown(new URLSearchParams("stage=plan")).stage).toBeNull();
    expect(writeShown(SHOWN)).toBe("");
    expect(readShown(new URLSearchParams("tab=nonsense&opened=x,2"))).toEqual({ ...SHOWN, opened: [2] });
  });

  it("keeps whatever else the address says", () => {
    expect(writeShown({ ...SHOWN, tab: "journal" }, new URLSearchParams("run=acme/widgets&tab=timeline")))
      .toBe("?run=acme%2Fwidgets&tab=journal");
  });
});

describe("a claim the session holds", () => {
  const held: ClaimView = {
    id: "k1", kind: "issue", number: 42, repo: "acme/widgets", session: "a9f259f0", station: "st_7f3a9c",
    stationName: "alex@mbp:widgets", seenAt: NOW - 2 * 86_400_000, heardAt: NOW - 2 * 86_400_000,
    grantedAt: NOW - 3 * 86_400_000, released: null, refused: null,
    consequence: "relabels #42 `asf:queued` and abandons session a9f259f0",
  };

  it("is in Details: which station holds it and how long it has been away, with Release spelled out", () => {
    const markup = html({ events: failedIn(upTo(BUILDING)), claims: [held] });
    expect(markup.replace(/<[^>]+>/g, "").replace(/\s+/g, " ")).toContain("issue #42 held by alex@mbp:widgets, offline 2d");
    expect(markup).toMatch(/<button[^>]*title="Relabels #42 `asf:queued` and abandons session a9f259f0"[^>]*>Release claim<\/button>/);
  });
});

describe("a session from a newer factory", () => {
  it("still tells what it can, and lists what it cannot read, open", () => {
    const unknown = { seq: 2, ts: "2026-09-29T12:00:00.000+00:00", kind: "phase_paused", v: 1, payload: {} };
    const markup = html({ events: [fixture("session_started", 1), unknown, fixture("phase_started", 3, 2)] });
    expect(markup).toMatch(/<details[^>]* open=""><summary[^>]*>1 event of this session came from a newer factory/);
    expect(markup).toContain("phase_paused");
    expect(markup).toContain("upgrade the cockpit to read them");
  });
});

describe("what a chapter was asked, in one line", () => {
  it("is the reviewer's last words, or the reporter's first line, never a heading or a framing comment", () => {
    expect(firstLine("# Review\n\n<!-- quoted -->\n\n> first\n\n> the last thing said\n")).toBe("the last thing said");
    expect(firstLine("# Title\n\n<!-- a frame -->\n\nThe endpoint\nreturns 500.\n\nMore.\n")).toBe("The endpoint returns 500.");
  });
});
