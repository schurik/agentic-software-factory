import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { decide, NEEDS_NOTE } from "../components/gate/answer";
import { type Gate, GateView, type Read } from "../components/gate/GateView";
import { ViewerLogin } from "../components/viewer";
import type { Row } from "../convex/model/inbox";

// A gate's drawer (#113), rendered to static markup the way a browser first
// paints it: the question, the round before's note, the agents' flags, the
// tabs for the gate's kind and the footer that answers it. A click on a tab is
// the tab it sets, so "one click away" is rendering with that tab.

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const ROW: Row = {
  factory: "acme/widgets", session: "a9f259f0", gate: "plan", round: 2, kind: "gate", questions: 0,
  since: "2026-10-01T11:30:00.000Z", summary: "the plan now names the module", channel: "issue", issueNumber: 42,
  issueUrl: "https://github.com/acme/widgets/issues/42", workItem: "#42 Resolve relative due dates",
  workflow: "issue", station: "schurik@mbp:widgets", forYou: [], blocked: null,
  via: "comment", refused: null, queued: null, stationSeenAt: 0, attendedAt: null, note: "",
};
const GATE: Gate = {
  row: ROW, mine: true, waitsOn: [], answered: null, title: "Resolve relative due dates via the meeting date",
  subjectDigest: "6151fe4319d06427379e4ef96b3898549880d60e220f8868b7376e5cecfe3a78", notes: "",
  subject: { headSha: "89abcdef0123456789abcdef0123456789abcdef", baseCommit: "", outside: [],
             files: [{ path: "docs/asf/spec/plan.md", absolute: "/w/docs/asf/spec/plan.md" }] },
  questions: [], earlier: [{ round: 1, verdict: "reject", by: "schurik", notes: "name the module", channel: "issue" }],
  material: {
    flags: [{ kind: "risk", what: "the date is local midnight", because: "converted in UTC it is the previous day", insteadOf: "", by: "planner" }],
    issue: { path: "context_handoff/issue.md", content: "# Resolve relative due dates\n\n- R1 the meeting date\n", truncated: false, pruned: false },
    findings: { path: "context_handoff/scout_findings.md", content: "# Findings\n\n- app.py takes no date\n", truncated: false, pruned: false },
    checks: [], review: null,
  },
  forge: "https://github.com", as: "alex",
};
const READ: Read = { ok: true, headSha: GATE.subject.headSha, diff: null, current: true,
                     files: [{ path: "docs/asf/spec/plan.md", content: "# Plan\n\n1. Convert in `dates.py`.\n", truncated: false, binary: false }] };
const CLOSE = { href: "/", onClick: () => {} };

function html(gate: Gate, { read = READ as Read | null, tab = null as string | null, viewer = null as string | null } = {}): string {
  return renderToStaticMarkup(
    <ViewerLogin.Provider value={viewer}>
      <GateView gate={gate} read={read} now={NOW} posting={false} problem="" onAnswer={() => {}}
                tab={tab} onTab={() => {}} close={CLOSE} step={null} />
    </ViewerLogin.Provider>,
  );
}

/** What a person reads: the text, whitespace collapsed, markup and entities gone. */
function read(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
}

const tabs = (markup: string) => [...markup.matchAll(/<button[^>]*role="tab"[^>]*>(.*?)<\/button>/g)].map((m) => read(m[1]).trim());
const selected = (markup: string) => read(/<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*>(.*?)<\/button>/.exec(markup)![1]).trim();

describe("a plan gate's drawer", () => {
  const markup = html(GATE);
  const text = read(markup);

  it("asks its question as the title, under the session's title, how long it waited and where it was asked", () => {
    expect(text).toMatch(/plan gate · round 2/);
    expect(text).toContain("Approve the plan?");
    expect(text).toContain("Resolve relative due dates via the meeting date");
    expect(text).toContain("Waiting 30m · asked on issue #42");
  });

  it("shows the round before's verdict and the person's own note first, then every agent's flag", () => {
    expect(text).toMatch(/Round 1: rejected by schurik .*“name the module”/);
    expect(text).toMatch(/⚑ risk .*the date is local midnight .*converted in UTC it is the previous day .*planner/);
    expect(text.indexOf("Round 1: rejected")).toBeLessThan(text.indexOf("⚑"));
    expect(text.indexOf("⚑")).toBeLessThan(text.indexOf("Scout's findings"));
  });

  it("opens on the plan, read from the forge and rendered as markdown, with the issue and the findings a click away", () => {
    expect(tabs(markup)).toEqual(["Plan", "Issue #42", "Scout's findings"]);
    expect(selected(markup)).toBe("Plan");
    expect(markup).toContain("<h1>Plan</h1>");
    expect(markup).toContain("<code>dates.py</code>");
    expect(html(GATE, { tab: "issue" })).toContain("<h1>Resolve relative due dates</h1>");
    expect(html(GATE, { tab: "findings" })).toContain("<li>app.py takes no date</li>");
  });

  it("has a footer: notes asking what the plan should change, Approve plan first, Reject, and a quiet Abort session", () => {
    expect(markup).toMatch(/<textarea[^>]*placeholder="Notes — required to reject: what should the plan change\?"/);
    const buttons = [...markup.matchAll(/<button(?![^>]*role="tab")[^>]*>(.*?)<\/button>/g)].map((m) => read(m[1]).trim());
    expect(buttons).toEqual(["Approve plan a", "Reject r", "Abort session"]);
    expect(markup).not.toContain(' disabled=""');
    expect(text).toContain("Posts a comment on issue #42 as alex");
  });

  it("on a phone, stacks the footer's buttons full width, the primary first", () => {
    const row = /<div class="([^"]*)"><button[^>]*>Approve plan/.exec(markup)![1];
    expect(row).toContain("flex-col");
    expect(row).toContain("md:flex-row-reverse");
    for (const button of markup.match(/<button(?![^>]*role="tab")[^>]*>/g)!.slice(0, 2)) expect(button).toContain("max-md:w-full");
  });

  it("says the viewer as you", () => {
    const own = read(html({ ...GATE, as: "schurik" }, { viewer: "schurik" }));
    expect(own).toContain("Round 1: rejected by you");
    expect(own).toContain("Posts a comment on issue #42 as you");
  });

  it("offers no verdict on a subject that is not what the factory asked about", () => {
    const changed = html(GATE, { read: { ...READ, current: false } });
    expect(read(changed)).toContain("Cannot be answered here: digest changed");
    for (const button of changed.match(/<button(?![^>]*role="tab")[^>]*>/g) ?? []) expect(button).toContain(' disabled=""');
  });
});

describe("an integrate gate's drawer", () => {
  const integrate: Gate = {
    ...GATE, row: { ...ROW, gate: "integrate", round: 1 }, earlier: [],
    subject: { ...GATE.subject, baseCommit: "2029981", files: [], outside: ["/w/asf/data/sessions/a9f259f0/changes.diff"] },
    material: {
      ...GATE.material, flags: [],
      checks: [{ name: "test", argv: ["bun", "test"], ok: true, exitCode: 0, seconds: 4 }],
      review: { summary: "approved: R1 and R2 are met", doc: { path: "context_handoff/review.md", content: "# Review\n\nVerdict: approved.\n", truncated: false, pruned: false } },
    },
  };
  const diff = "diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n-old\n+new\n";
  const markup = html(integrate, { read: { ...READ, files: [], diff, current: null } });

  it("opens on the branch's changes, with its checks, the review and the issue a click away", () => {
    expect(read(markup)).toContain("Open the pull request?");
    expect(tabs(markup)).toEqual(["Changes", "Checks", "Review", "Issue #42"]);
    expect(selected(markup)).toBe("Changes");
    expect(markup).toContain('data-file="app.py"');
    expect(read(html(integrate, { tab: "checks" }))).toMatch(/test .*bun test .*4s/);
    expect(html(integrate, { tab: "review" })).toContain("<p>Verdict: approved.</p>");
  });

  it("names its verdicts for landing: Open pull request, and Send back", () => {
    expect(markup).toMatch(/<textarea[^>]*placeholder="Notes — required to send back: what should change before it lands\?"/);
    expect(read(markup)).toMatch(/Open pull request a .*Send back r .*Abort session/);
  });
});

describe("any other gate's drawer", () => {
  it("shows what it asks and its subject", () => {
    const checkpoint: Gate = { ...GATE, row: { ...ROW, gate: "checkpoint", round: 1 }, earlier: [] };
    const markup = html(checkpoint);
    expect(read(markup)).toContain("Approve the checkpoint?");
    expect(tabs(markup)).toEqual(["Subject", "Issue #42"]);
    expect(read(markup)).toMatch(/docs\/asf\/spec\/plan\.md at 89abcde/);
    expect(read(markup)).toMatch(/Approve a .*Reject r .*Abort session/);
  });

  it("puts a question round's questions first, each with its recommendation, and one action to take them all", () => {
    const asking: Gate = {
      ...GATE, row: { ...ROW, kind: "questions", gate: "requirements", questions: 1, round: 1 }, earlier: [],
      questions: [{ topic: "scope", question: "Which endpoint?", why: "", blocking: true, options: [
        { answer: "/health", because: "it is the one that 500s", recommended: true },
        { answer: "every endpoint", because: "", recommended: false }] }],
    };
    const markup = html(asking, { read: { ...READ, files: [] } });
    expect(read(markup)).toContain("1 question before the requirements");
    expect(tabs(markup)).toEqual(["Questions", "Issue #42"]);
    expect(markup).toContain("/health<em> — recommended</em>");
    expect(markup).toContain("leave empty to take “/health”");
    expect(read(markup)).toMatch(/Send answers .*Take all recommendations a .*Abort session/);
    expect(read(markup)).not.toContain("Reject");
  });
});

describe("a gate's footer", () => {
  it("says what was answered, and that the station picks it up from the comment on the issue", () => {
    const answered = read(html({ ...GATE, answered: { by: "alex", verdict: "approve", url: "https://github.com/acme/widgets/issues/42#issuecomment-1" } },
                               { viewer: "alex" }));
    expect(answered).toContain("Answered: approve by you. The station picks it up from the comment on issue #42.");
    expect(answered).not.toContain("Approve plan");
  });

  it("at someone else's gate, says whom it waits on, and that the factory hears only them", () => {
    const theirs = html({ ...GATE, mine: false, waitsOn: ["mira"],
                          row: { ...ROW, blocked: "waiting on mira: the factory hears only them, here or on issue #42" } });
    expect(read(theirs)).toContain("Waiting on mira: the factory hears only them, here or on issue #42.");
    expect(theirs).not.toContain("Approve plan");
    expect(theirs).not.toContain("<textarea");
  });

  it("refuses a reject with no note, saying the next agent reads it as an instruction, and sends nothing", () => {
    expect(decide("reject", "  ", [])).toEqual({ hint: NEEDS_NOTE });
    expect(NEEDS_NOTE).toContain("the next agent reads it as an instruction");
    expect(decide("reject", "name the module", [])).toEqual({ answer: { verdict: "reject", notes: "name the module", answers: [] } });
    expect(decide("approve", "", ["x"])).toEqual({ answer: { verdict: "approve", notes: "", answers: [] } });
    expect(decide("answer", "", ["/health"])).toEqual({ answer: { verdict: "answer", notes: "", answers: ["/health"] } });
  });
});
