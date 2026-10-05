import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NowDrawerView, nowAddress } from "../components/now/Now";
import { type Progress, RunningRow } from "../components/now/rows";
import { NowView } from "../components/now/NowView";
import { ViewerLogin } from "../components/viewer";
import type { Facts } from "../convex/model/attention";
import type { Row } from "../convex/model/inbox";
import type { NowPage, Running } from "../convex/now";

// Now (#115), rendered to static markup from a page model and a clock, the
// way a browser first paints it: the Inbox, Needs attention and Running open,
// Waiting on others folded. A click is the address it sets, so the gate a row
// opens is rendering with that address. Whether a wait is long, a session
// stuck or its spend close to the ceiling is judged against the given clock.

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const MINUTE = 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const ROW: Row = {
  factory: "acme/widgets", session: "a9f259f0", gate: "plan", round: 2, kind: "gate", questions: 0,
  since: ago(12 * MINUTE), summary: "the plan now names the module", channel: "issue", issueNumber: 42,
  issueUrl: "https://github.com/acme/widgets/issues/42", workItem: "#42 Resolve relative due dates",
  workflow: "issue", station: "schurik@mbp:widgets", forYou: [], blocked: null,
  via: "comment", refused: null, queued: null, stationSeenAt: 0, attendedAt: null, note: "",
};

const QUIET: Facts = { gates: { mine: 0, total: 0 }, failed: [], claims: [], check: "passing", drifted: [], queued: null, watchers: [] };

const RUNNING: Running = {
  factory: "acme/gadgets", session: "7d2f90aa", title: "#7 Add a health check", workflow: "issue",
  issueUrl: "https://github.com/acme/gadgets/issues/7", prUrl: "", startedAt: ago(42 * MINUTE), cost: 0.12, ceiling: 0.25,
};

const PROGRESS: Progress = {
  mini: {
    blocks: [
      { key: "0", status: "done", stage: "scout", phase: null },
      { key: "1", status: "done", stage: "plan", phase: null },
      { key: "2", status: "running", stage: "verify", phase: null },
      { key: "3", status: "pending", stage: "integrate", phase: null },
    ],
    current: 2,
  },
  stage: "verify",
  phase: { name: "verify_2", since: ago(4 * MINUTE) },
};

const PAGE: NowPage = {
  inbox: [ROW],
  attention: [
    { factory: "acme/widgets", facts: { ...QUIET, check: "failing" } },
    { factory: "acme/gadgets", facts: {
      ...QUIET, failed: [{ session: "e5b3a118", title: "#9 Parse ISO weeks", workflow: "issue", station: "ci", endedAt: NOW - 2 * 3600_000 }],
    } },
  ],
  running: [RUNNING],
  others: [{ ...ROW, session: "0f9a6c3d", workItem: "#51 Rename the export", issueNumber: 51,
             blocked: "waiting on dana: the factory hears only them", waitsOn: ["dana"] }],
};

const link = (key: string) => ({ href: `/?open=${encodeURIComponent(key)}`, onClick: () => {} });

function html(page: NowPage = PAGE, { progress = PROGRESS as Progress | undefined, viewer = "alex" } = {}): string {
  return renderToStaticMarkup(
    <ViewerLogin.Provider value={viewer}>
      <NowView page={page} now={NOW} selected={null} openGate={link}
               runningRow={(row) => <RunningRow row={row} now={NOW} progress={progress} />} />
    </ViewerLogin.Provider>,
  );
}

/** What a person reads: the text, whitespace collapsed, markup and entities gone. */
function read(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
}

/** The markup of the section titled `title`, up to the next section. */
function section(markup: string, title: string): string {
  const sections = markup.split("<section").map((each) => `<section${each}`);
  return sections.find((each) => read(each).trimStart().startsWith(title)) ?? "";
}

describe("Now's first paint", () => {
  it("shows the Inbox, Needs attention and Running open, and Waiting on others folded, in that order", () => {
    const markup = html();
    const text = read(markup);
    expect(text.indexOf("Inbox")).toBeLessThan(text.indexOf("Needs attention"));
    expect(text.indexOf("Needs attention")).toBeLessThan(text.indexOf("Running"));
    expect(text.indexOf("Running")).toBeLessThan(text.indexOf("Waiting on others"));

    // The Inbox row: the session's title, the question with its gate and round, the subject, where, and the wait.
    const inbox = read(section(markup, "Inbox"));
    expect(inbox).toContain("Resolve relative due dates");
    expect(inbox).toContain("Approve the plan? plan gate · round 2");
    expect(inbox).toContain("the plan now names the module");
    expect(inbox).toContain("acme/widgets #42");
    expect(inbox).toContain("waiting 12m");
    expect(section(markup, "Inbox")).toContain('href="/?open=acme%2Fwidgets%2Fa9f259f0"');

    expect(read(section(markup, "Needs attention"))).toContain("Session failed: #9 Parse ISO weeks");
    expect(read(section(markup, "Running"))).toContain("Add a health check");

    const others = section(markup, "Waiting on others");
    expect(read(others)).toMatch(/Waiting on others 1 Show/);
    expect(read(others)).not.toContain("Rename the export");
  });

  it("says nothing waits on the viewer when nothing does", () => {
    expect(read(section(html({ ...PAGE, inbox: [] }), "Inbox"))).toContain("Nothing is waiting on you.");
  });

  it("says why an Inbox row cannot be answered here, and why it is the viewer's own", () => {
    const text = read(html({ ...PAGE, inbox: [
      { ...ROW, forYou: ["triggered"] },
      { ...ROW, session: "c2c2c2c2", kind: "questions", questions: 3, round: 1, channel: "terminal",
        blocked: "being asked at the station's terminal right now" },
    ] }));
    expect(text).toContain("3 questions before the plan · round 1");
    expect(text).toContain("being asked at the station's terminal right now");
    expect(text).toContain("for you");
  });
});

describe("Needs attention", () => {
  it("names each row's next step, and goes there", () => {
    const page: NowPage = { ...PAGE, attention: [{ factory: "acme/widgets", facts: {
      ...QUIET,
      failed: [{ session: "e5b3a118", title: "#9 Parse ISO weeks", workflow: "issue", station: "ci", endedAt: NOW - 3600_000 }],
      check: "failing",
      claims: [{ id: "cl_1", station: "st_1", stationName: "alex@mbp:widgets", repo: "acme/widgets", kind: "issue", number: 42,
                 session: "c1", seenAt: NOW - 30 * 3600_000, heardAt: NOW - 30 * 3600_000, grantedAt: NOW - 31 * 3600_000,
                 released: null, refused: null, consequence: "the issue goes back to the queue" }],
      queued: [44, 45], watchers: [],
      drifted: [{ station: "st_2", name: "sam@box:widgets", badges: ["config differs"] }],
    } }] };
    const markup = section(html(page), "Needs attention");
    const steps = [...markup.matchAll(/<a[^>]*href="([^"]+)"[^>]*>(?:(?!<\/a>).)*?([A-Z][a-z]+(?: [a-z]+)?) →/g)]
      .map(([, href, step]) => `${step} ${href}`);
    expect(steps).toEqual([
      "Open /sessions/acme/widgets/e5b3a118",
      "Release /sessions/acme/widgets/c1",
      "Compare /factories/acme/widgets?tab=stations",
      "See config /factories/acme/widgets?tab=config",
      "Stations /factories/acme/widgets?tab=stations",
    ]);
    // The gates waiting on the viewer are the Inbox's; they are not said twice.
    expect(read(section(html({ ...PAGE, attention: [{ factory: "acme/widgets", facts: { ...QUIET, gates: { mine: 2, total: 2 } } }] }),
                        "Needs attention"))).toContain("Nothing needs attention.");
  });
});

describe("the thresholds, against the given clock", () => {
  const amber = (markup: string, words: string) => new RegExp(`class="[^"]*text-wait[^"]*"[^>]*>${words}<`).test(markup);

  it("calls a wait long past 30 minutes, not at them", () => {
    const at = (since: number) => section(html({ ...PAGE, inbox: [{ ...ROW, since: ago(since) }] }), "Inbox");
    expect(amber(at(30 * MINUTE), "waiting 30m")).toBe(false);
    expect(read(at(30 * MINUTE))).toContain("waiting 30m");
    expect(amber(at(30 * MINUTE + 1000), "waiting 30m")).toBe(true);
  });

  it("calls a session stuck once a phase has run past 10 minutes, naming where", () => {
    const at = (since: number) => read(html(PAGE, { progress: { ...PROGRESS, phase: { name: "verify_2", since: ago(since) } } }));
    expect(at(10 * MINUTE)).not.toContain("in verify");
    expect(at(10 * MINUTE + 1000)).toContain("10m in verify");
    // A chapter drawn without stages says the phase, humanised.
    expect(read(html(PAGE, { progress: { ...PROGRESS, stage: null, phase: { name: "verify_2", since: ago(17 * MINUTE) } } })))
      .toContain("17m in verify #2");
  });

  it("calls a session expensive from 80% of its ceiling, and says the ceiling only then", () => {
    const at = (cost: number) => section(html({ ...PAGE, running: [{ ...RUNNING, cost }] }), "Running");
    expect(read(at(0.19))).toContain("$0.19");
    expect(read(at(0.19))).not.toContain("of $0.25");
    expect(amber(at(0.2), "\\$0.20 of \\$0.25")).toBe(true);
    // At the ceiling, it is over budget: red.
    const red = (markup: string, words: string) => new RegExp(`class="[^"]*text-bad[^"]*"[^>]*>${words}<`).test(markup);
    expect(red(at(0.25), "\\$0.25 of \\$0.25")).toBe(true);
    expect(red(at(0.2), "\\$0.20 of \\$0.25")).toBe(false);
    // No ceiling, nothing to be close to.
    expect(read(section(html({ ...PAGE, running: [{ ...RUNNING, cost: 9, ceiling: 0 }] }), "Running"))).not.toContain(" of ");
  });

  it("shows how long a running session has been going, and the stage it is in", () => {
    const running = section(html(), "Running");
    expect(read(running)).toContain("42m");
    expect(running).toContain('aria-label="running"');
    expect(read(running)).toContain("verify");
    expect(running).toContain('href="/sessions/acme/gadgets/7d2f90aa"');
  });
});

describe("the gate's drawer over Now", () => {
  // The gate's drawer is a live query of its own (gateview.test.tsx renders it): here, which gate it was asked for.
  const gate = (target: { factory: string; session: string; tab: string | null }) =>
    <p>the gate drawer of {target.factory}/{target.session} on {target.tab ?? "its first tab"}</p>;

  /** Now as a browser first paints it at `address`, read back the way the route reads it, and the drawer over it. */
  function at(address: string): string {
    const search = new URLSearchParams(address.split("?")[1] ?? "");
    const [open, tab] = [search.get("open") ?? undefined, search.get("tab") ?? undefined];
    return renderToStaticMarkup(
      <ViewerLogin.Provider value="alex">
        <NowView page={PAGE} now={NOW} selected={open ?? null} openGate={link}
                 runningRow={(row) => <RunningRow row={row} now={NOW} progress={PROGRESS} />} />
        <NowDrawerView open={open} tab={tab} gate={gate} />
      </ViewerLogin.Provider>,
    );
  }

  it("opens from the address on the gate it names, on its tab, over the page with that gate's row marked", () => {
    const markup = at(nowAddress({ open: "acme/widgets/a9f259f0", tab: "issue" }));
    expect(read(markup)).toContain("the gate drawer of acme/widgets/a9f259f0 on issue");
    // The page is still there under it, the open gate's row marked.
    expect(read(section(markup, "Running"))).toContain("Add a health check");
    expect(section(markup, "Inbox")).toMatch(/<a [^>]*href="\/\?open=acme%2Fwidgets%2Fa9f259f0"[^>]*aria-current="true"/);
  });

  it("opens a gate waiting on someone else the same way", () => {
    expect(read(at(nowAddress({ open: "acme/widgets/0f9a6c3d" })))).toContain("the gate drawer of acme/widgets/0f9a6c3d on its first tab");
  });

  it("holds nothing when the address names no gate", () => {
    expect(read(at(nowAddress({})))).not.toContain("the gate drawer of");
  });
});
