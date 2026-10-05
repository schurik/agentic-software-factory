import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { type Listed, type SessionsFound, SessionsView, Where } from "../components/sessions/SessionsTable";
import { EMPTY_SUMMARY, type Summary } from "../convex/model/session";

// The Sessions page (#116), rendered to static markup with no backend: the
// factory pills and the one search box above a table of five columns — a
// status dot, the session, where it is, what it cost and when it started.
// Where folds away below md and Started below sm, so a phone at 375px reads
// the dot, the session and its cost without scrolling sideways.

/** The markup's text, one space between words, the way a person reads it. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

function listed(session: string, fields: Partial<Summary> = {}, factory = "acme/widgets"): Listed {
  return {
    factory, session, acked: 4,
    summary: {
      ...EMPTY_SUMMARY, status: "success", workflows: ["issue", "pr-review"], workflow: "pr-review", triggeredBy: "sam",
      request: "#42 Resolve relative due dates via the meeting date", issueUrl: "https://github.com/acme/widgets/issues/42",
      prUrl: "https://github.com/acme/widgets/pull/57", totalCost: 1.25,
      startedAt: "2026-10-01T10:00:00.000Z", lastEventAt: "2026-10-01T11:00:00.000Z", ...fields,
    },
  };
}

const NOW = Date.parse("2026-10-01T12:00:00.000Z");

const ROWS = [
  listed("a9f259f0"),
  listed("7d2f90aa", { status: "running", request: "Tidy the README's install section", issueUrl: "", prUrl: "", workflows: ["prompt"], workflow: "prompt", totalCost: 0 }, "acme/gadgets"),
];

function page(fields: Partial<SessionsFound> = {}): SessionsFound {
  return { sessions: ROWS, looked: 2, cut: false, factories: ["acme/gadgets", "acme/widgets"], ...fields };
}

function render(fields: Partial<SessionsFound> = {}, factory?: string, live = (row: Listed) => <i>graph of {row.session}</i>) {
  return renderToStaticMarkup(
    <SessionsView list={page(fields)} factory={factory} search="" onSearch={() => {}} now={NOW} live={live} />);
}

/** The table's header cells, as markup. */
function headers(html: string): string[] {
  return [...html.matchAll(/<th\b[^>]*>.*?<\/th>/g)].map(([cell]) => cell);
}

describe("the sessions page's first paint", () => {
  it("shows the dot, Session, Where, Cost and Started columns, Where from md up and Started from sm up", () => {
    const [dot, session, where, cost, started] = headers(render());

    expect(dot).toContain('aria-label="Status"');
    expect(text(session)).toContain("Session");
    expect(text(where)).toContain("Where");
    expect(where).toMatch(/class="[^"]*hidden[^"]*md:table-cell/);
    expect(text(cost)).toContain("Cost");
    expect(text(started)).toContain("Started");
    expect(started).toMatch(/class="[^"]*hidden[^"]*sm:table-cell/);
  });

  it("lays the table out to the page's width, so a phone never scrolls it sideways", () => {
    expect(render()).toMatch(/<table class="[^"]*table-fixed/);
  });

  it("says each session's status as a dot, with its word on hover", () => {
    const html = render();

    expect(html).toMatch(/title="success"[^>]*aria-label="success"/);
    expect(html).toMatch(/title="running"[^>]*aria-label="running"/);
  });

  it("titles each session, linked to its page, with its factory, work item, pull request and id under it", () => {
    const html = render();
    const said = text(html);

    expect(html).toContain('href="/sessions/acme/widgets/a9f259f0"');
    // The `#42` the title began with is its work item's, said once, under it.
    expect(said).toContain("Resolve relative due dates via the meeting date acme/widgets #42 #57 a9f259f0");
    expect(html).toContain('href="https://github.com/acme/widgets/issues/42"');
    expect(html).toContain('href="https://github.com/acme/widgets/pull/57"');
  });

  it("says a session with no work item was a prompt", () => {
    expect(text(render())).toContain("Tidy the README's install section acme/gadgets prompt 7d2f90aa");
  });

  it("draws where a live session is as its mini graph, and names a finished one's workflow", () => {
    const said = text(render());

    expect(said).toContain("graph of 7d2f90aa");
    expect(said).not.toContain("graph of a9f259f0");
    expect(said).toContain("pr-review");
  });

  it("says what each session cost, and when it started", () => {
    const html = render();
    const said = text(html);

    expect(said).toContain("$1.25");
    expect(said).toContain("2h ago");
    // The clock time, in the viewer's own timezone, on hover.
    expect(html).toMatch(/title="Oct 1, \d\d:\d\d"/);
  });
});

describe("the factory pills", () => {
  /** Each pill's markup, by its words. */
  function pills(html: string): Record<string, string> {
    const nav = /<nav aria-label="Factories"[^>]*>(.*?)<\/nav>/.exec(html)?.[1] ?? "";
    return Object.fromEntries([...nav.matchAll(/<a\b[^>]*>.*?<\/a>/g)].map(([pill]) => [text(pill).trim(), pill]));
  }

  it("offer every factory, and all of them, each at its own address", () => {
    const each = pills(render());

    expect(Object.keys(each)).toEqual(["all", "acme/gadgets", "acme/widgets"]);
    expect(each.all).toContain('href="/sessions"');
    expect(each["acme/widgets"]).toContain('href="/sessions?factory=acme%2Fwidgets"');
  });

  it("show which one the address narrowed the list to, and all when it named none", () => {
    expect(pills(render()).all).toContain('aria-current="page"');
    const narrowed = pills(render({}, "acme/widgets"));
    expect(narrowed["acme/widgets"]).toContain('aria-current="page"');
    expect(narrowed.all).not.toContain("aria-current");
    expect(narrowed["acme/gadgets"]).not.toContain("aria-current");
  });

  it("show a factory the address named in another case as that factory", () => {
    expect(pills(render({}, "Acme/Widgets"))["acme/widgets"]).toContain('aria-current="page"');
  });

  it("keep a factory the address named that the viewer has no sessions of, so it can be seen and undone", () => {
    const each = pills(render({ sessions: [], looked: 0 }, "acme/nowhere"));

    expect(each["acme/nowhere"]).toContain('aria-current="page"');
    expect(each.all).toContain('href="/sessions"');
  });
});

describe("the search box", () => {
  it("is one box, over title, issue or pull request, and id", () => {
    const html = render();

    expect(html.match(/<input\b/g)).toHaveLength(1);
    expect(html).toMatch(/<input[^>]*type="search"/);
    expect(html).toMatch(/placeholder="Search title, #issue, id…"/);
  });

  it("says when nothing it looked at matches", () => {
    expect(text(render({ sessions: [], looked: 2 }))).toContain("No session matches.");
  });
});

describe("a session's where", () => {
  it("is its workflow's name until its progress answers", () => {
    expect(text(renderToStaticMarkup(<Where workflow="issue" progress={undefined} />))).toContain("issue");
  });

  it("is its mini graph once it does", () => {
    const html = renderToStaticMarkup(<Where workflow="issue" progress={{
      mini: { blocks: [{ key: "0", status: "done", stage: "scout", phase: null }, { key: "1", status: "running", stage: "plan", phase: null }], current: 1 },
      stage: "plan", phase: { name: "plan", since: "2026-10-01T11:50:00.000Z" },
    }} />);

    expect(text(html)).toContain("plan");
    expect(html).toContain('title="scout"');
  });
});
