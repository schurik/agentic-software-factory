import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionView, type Page } from "../components/session/SessionView";
import type { SteeringView } from "../convex/model/command";
import { firstLine } from "../components/session/Chapter";
import { view } from "../convex/model/session";
import { fixture, recorded, type WireEvent } from "./helpers";

// The session page rendered from the golden corpus, the way a browser would
// first paint it: the same fold the query runs (model/session.ts), straight
// into the component, with no backend in between. story.test.ts says what the
// story IS; this says what a person SEES of it.

const { events: RECORDED } = recorded["issue-then-two-reviews"];
const LATER = Date.parse("2026-09-30T18:00:00Z");

function page(events: WireEvent[]): Page {
  const stored = events.map((event) => ({ ...event, payload: JSON.stringify(event.payload) }));
  const acked = events.at(-1)?.seq ?? 0;
  return { factory: "acme/widgets", session: "a9f259f0", acked, forge: "https://github.com", ...view(stored, acked) };
}

function shown(events: WireEvent[], steering?: SteeringView): string {
  const html = renderToStaticMarkup(<SessionView page={page(events)} now={LATER} steering={steering} onCommand={() => {}} />);
  // What a person reads: the text, whitespace collapsed, markup and entities gone.
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
}

const upTo = (kind: string, nth = 1) => RECORDED.slice(0, RECORDED.filter((e) => e.kind === kind)[nth - 1].seq);

describe("the finished session", () => {
  const text = shown(RECORDED);

  it("is titled by the work item it was started on", () => {
    expect(text).toContain("acme/widgets / sessions / a9f259f0 #42 Resolve relative due dates via the meeting date success");
  });

  it("renders its three chapters in order, each opening with what it was asked", () => {
    const chapters = [...text.matchAll(/Chapter (\d) (issue|pr-review, round \d)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(chapters).toEqual(["1 issue", "2 pr-review, round 1", "3 pr-review, round 2"]);
    expect(text).toContain("answering issue #42");
    expect(text).toContain("answering pull request #9");
    expect(text).toContain("Asked issue.md Rules and decisions from a meeting are extracted as tasks, and a relative " +
      "deadline (\"in four weeks\") stays relative. #");
    expect(text).toContain("Asked pr_review.md the date should read like Sep 25, 2026");
    expect(text).toContain("Asked pr_review.md use that format two lines below too");
  });

  it("shows agent cards, code rows and gate cards with what each one did", () => {
    expect(text).toContain("scout scout · asf/stages/scout/task.md replayed on resume 3 tool calls, 1 failed");
    expect(text).toContain("PlanOutput · a required meeting date, and a test for its format");
    expect(text).toContain("scout_findings.md handoff");
    expect(text).toContain("plan.md repo");
    expect(text).toContain("⚑ risk the date is local midnight — because converted in UTC it is the previous day");
    expect(text).toContain("1 correction");
    expect(text).toMatch(/commit_implement [0-9a-f]{7} feat: the prompt knows the meeting date/);
    expect(text).toContain("verify_1 ✓ test");
    expect(text).toContain("◐ plan gate · round 1 rejected by asf tests");
    expect(text).toContain("◐ plan gate · round 2 approved by asf tests");
    expect(text).toContain("Asked on issue #42");
  });

  it("shows a person's remark as an instruction, and the policy's pass as automatic", () => {
    expect(text).toContain("✎ instruction name the module the date is converted in");
    expect(text).toContain("✎ instruction keep the prompt in English");
    expect(text).toContain("⚙ integrate gate passed by policy · automatic, nobody was asked");
    expect(text).not.toMatch(/by policy ✎|approved by policy/);
  });

  it("says a resume replayed phases instead of showing them twice", () => {
    expect(text).toContain("▶ Resumed · scout, plan replayed from the record, not run again");
    expect(text).toContain("▶ Resumed · scout, plan, plan_revise_1 replayed from the record, not run again");
    expect(text.match(/scout scout · asf\/stages\/scout\/task\.md/g)).toHaveLength(1);
  });

  it("offers the pull request, says where the work went, and fills the sidebar", () => {
    const html = renderToStaticMarkup(<SessionView page={page(RECORDED)} now={LATER} />);
    expect(html).toContain('<a class="button" href="https://forge/acme/widgets/pull/9">Open pull request ↗</a>');
    expect(text).toContain("Now All work landed in pull request #9 over 3 chapters");
    expect(text).toContain("Chapter pr-review, round 2");
    expect(text).toContain("Station schurik@mbp:widgets run by asf tests");
    // Recorded before a factory named who triggered a run: it says nobody, rather than guess.
    expect(text).toContain("Triggered by —");
    expect(text).toContain("Branch asf/a9f259f0");
    expect(text).toMatch(/Base main at [0-9a-f]{7}/);
    // The outline is the sidebar's first view; the journal is one click away.
    expect(text).toContain("1 · issue");
    expect(text).toContain("✕ plan gate · round 1 ✓ plan_revise_1");
    expect(text).toContain("✓ plan gate · round 2");
  });
});

describe("a phase, one click from its tabs", () => {
  const html = renderToStaticMarkup(<SessionView page={page(RECORDED)} now={LATER} />);

  it("offers every agent card and code row its details, closed until asked", () => {
    const { story } = page(RECORDED);
    const phases = story.chapters.flatMap((chapter) => chapter.items)
      .filter((item) => item.type === "agent" || item.type === "code");
    expect(html.match(/<button[^>]*aria-expanded="false"[^>]*>details<\/button>/g)).toHaveLength(phases.length);
    expect(html).not.toContain('class="phase-tabs"');
  });

  it("makes each artifact chip a way into the Artifacts tab", () => {
    expect(html).toMatch(/<button class="chip"[^>]*><code>scout_findings.md<\/code>/);
  });
});

describe("a session on its way", () => {
  it("while an agent works: says who is on which phase, and offers kill with the reason it is off", () => {
    const text = shown(RECORDED.slice(0, RECORDED.find((e) => e.kind === "tool_called")!.seq));
    expect(text).toContain("Now scout is working on scout in issue");
    expect(text).toContain("live · updating as events arrive");
    expect(text).toContain("Kill session");
    expect(text).toContain("the cockpit has not heard from this session's station — `asf kill a9f259f0` on schurik@mbp:widgets");
  });

  it("at a gate: says it waits on a person, on which work item, and sends them to the inbox to answer", () => {
    const text = shown(upTo("suspended"));
    expect(text).toContain("Now Waiting on a person: the plan gate , round 1, asked on issue #42");
    expect(text).toContain("◐ plan gate · round 1 waiting");
    expect(text).toContain("Answering happens in the inbox, not here.");
    const html = renderToStaticMarkup(<SessionView page={page(upTo("suspended"))} now={LATER} />);
    expect(html).toContain('<a class="button" href="/?open=acme%2Fwidgets%2Fa9f259f0">Answer in inbox</a>');
  });

  it("never offers a button that does nothing", () => {
    for (const events of [upTo("tool_called"), upTo("suspended")]) {
      const html = renderToStaticMarkup(<SessionView page={page(events)} now={LATER} />);
      for (const button of html.match(/<button class="button"[^>]*>/g) ?? []) expect(button).toContain("disabled");
    }
  });
});

describe("killing a live session", () => {
  const working = upTo("tool_called");
  const station = { name: "schurik@mbp:widgets", kind: "local", owner: "schurik", registered: true, seenAt: 0, verbs: ["kill"] };
  const attended: SteeringView = { station, attendedAt: LATER - 2000, kill: null, killRefused: null };
  const killButton = (steering: SteeringView) =>
    renderToStaticMarkup(<SessionView page={page(working)} now={LATER} steering={steering} onCommand={() => {}} />)
      .match(/<button class="button"[^>]*>Kill session<\/button>/)![0];

  it("is offered while the run is attended, and the sidebar says it is and whose station it is", () => {
    expect(killButton(attended)).not.toContain("disabled");
    const text = shown(working, attended);
    expect(text).toContain("owned by schurik");
    expect(text).toContain("● attended · last seen 2s ago");
  });

  it("is greyed out, saying why, when the station's report says it would refuse", () => {
    const because = "schurik@mbp:widgets does not take kill: its asf/factory.yaml's cockpit.commands does not list it";
    const refused = { ...attended, killRefused: because };
    expect(killButton(refused)).toContain("disabled");
    expect(shown(working, refused)).toContain(because);
  });

  it("says a station that is not polling is offline, when it was last seen, and that a kill waits for it", () => {
    const away = { ...attended, attendedAt: LATER - 4 * 60_000, station: { ...station, seenAt: LATER - 3 * 60_000 } };
    expect(killButton(away)).not.toContain("disabled");
    const text = shown(working, away);
    expect(text).toContain("○ offline · last seen 3m ago");
    expect(text).toContain("is offline: a kill waits for it");
  });

  it("shows a queued kill as queued — station offline — until the station takes it, and never as done", () => {
    const kill = { state: "queued" as const, by: "alex", issuedAt: LATER - 1000, expiresAt: LATER + 60_000, detail: "" };
    const queued = { ...attended, attendedAt: null, kill };
    expect(killButton(queued)).toContain("disabled");
    expect(shown(working, queued)).toContain("queued, station offline: schurik@mbp:widgets takes it when it is back");
    expect(shown(working, { ...queued, kill: { ...kill, state: "delivered" } }))
      .toContain("sent to schurik@mbp:widgets by alex: waiting for it to say it stopped");
    expect(shown(working, { ...queued, kill: { ...kill, state: "done", detail: "stopping itself" } }))
      .toContain("killed by alex: stopping itself");
    expect(shown(working, { ...attended, kill: { ...kill, state: "refused", detail: "alex is not in issues.trusted_authors" } }))
      .toContain("refused the last kill: alex is not in issues.trusted_authors");
  });

  it("says so when the station's token was revoked", () => {
    const revoked = { ...attended, station: { ...station, registered: false } };
    expect(shown(working, revoked)).toContain("○ takes no commands: its token was revoked");
  });
});

describe("a session from a newer factory", () => {
  it("still tells what it can, and lists what it cannot read, open", () => {
    const unknown = { seq: 2, ts: "2026-09-29T12:00:00.000+00:00", kind: "phase_paused", v: 1, payload: {} };
    const html = renderToStaticMarkup(
      <SessionView page={page([fixture("session_started", 1), unknown, fixture("phase_started", 3, 2)])} now={LATER} />);
    expect(html).toContain('<details class="all-events" open="">');
    expect(html).toContain("unknown kind — shown as sent");
    expect(html).toContain("upgrade the cockpit to read them");
  });
});

describe("what a chapter was asked, in one line", () => {
  it("is the reviewer's last words, or the reporter's first line, never a heading or a framing comment", () => {
    expect(firstLine("# Review\n\n<!-- quoted -->\n\n> first\n\n> the last thing said\n")).toBe("the last thing said");
    expect(firstLine("# Title\n\n<!-- a frame -->\n\nThe endpoint\nreturns 500.\n\nMore.\n")).toBe("The endpoint returns 500.");
  });
});
