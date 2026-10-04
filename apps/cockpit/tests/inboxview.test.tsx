import { describe, expect, it } from "vitest";
import { keyed } from "../components/inbox/keys";
import { renderToStaticMarkup } from "react-dom/server";
import { AnswerView, type Gate } from "../components/inbox/AnswerView";
import { InboxList, onlyOf } from "../components/inbox/InboxList";
import { ViewerLogin } from "../components/viewer";
import type { Row } from "../convex/model/inbox";

// The inbox's pages, rendered to static markup with no backend: the list, the
// answer view, and the keyboard flow (spec #40) — next and previous through
// the list, approve and reject on the wait that is open, never while typing.

describe("the inbox's keys", () => {
  const plain = { target: null, metaKey: false, ctrlKey: false, altKey: false };

  it("move through the list and answer the wait that is open", () => {
    expect(keyed({ ...plain, key: "j" })).toBe("next");
    expect(keyed({ ...plain, key: "ArrowDown" })).toBe("next");
    expect(keyed({ ...plain, key: "k" })).toBe("previous");
    expect(keyed({ ...plain, key: "ArrowUp" })).toBe("previous");
    expect(keyed({ ...plain, key: "a" })).toBe("approve");
    expect(keyed({ ...plain, key: "r" })).toBe("reject");
    expect(keyed({ ...plain, key: "x" })).toBeNull();
  });

  it("leave a person typing, or using the browser's own shortcuts, alone", () => {
    expect(keyed({ ...plain, key: "a", target: { tagName: "TEXTAREA" } })).toBeNull();
    expect(keyed({ ...plain, key: "j", target: { tagName: "INPUT" } })).toBeNull();
    expect(keyed({ ...plain, key: "r", metaKey: true })).toBeNull();
    expect(keyed({ ...plain, key: "a", ctrlKey: true })).toBeNull();
  });
});


const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const ROW: Row = {
  factory: "acme/widgets", session: "a9f259f0", gate: "plan", round: 2, kind: "gate", questions: 0,
  since: "2026-10-01T11:30:00.000Z", summary: "the plan now names the module", channel: "issue", issueNumber: 42,
  issueUrl: "https://github.com/acme/widgets/issues/42", workItem: "#42 Resolve relative due dates",
  workflow: "issue", station: "schurik@mbp:widgets", forYou: [], blocked: null,
  via: "comment", refused: null, queued: null, stationSeenAt: 0, attendedAt: null, note: "",
};
const GATE: Gate = {
  row: ROW, subjectDigest: "6151fe4319d06427379e4ef96b3898549880d60e220f8868b7376e5cecfe3a78", notes: "",
  subject: { headSha: "89abcdef0123456789abcdef0123456789abcdef", baseCommit: "", outside: [],
             files: [{ path: "docs/asf/spec/plan.md", absolute: "/w/docs/asf/spec/plan.md" }] },
  questions: [], earlier: [{ round: 1, verdict: "reject", by: "schurik", notes: "name the module", channel: "issue" }],
  journal: "## This run so far\n", forge: "https://github.com", as: "alex", cost: 0.42, tokens: 12000,
};
const READ = { ok: true as const, headSha: GATE.subject.headSha, diff: null, current: true,
               files: [{ path: "docs/asf/spec/plan.md", content: "# Plan\n", truncated: false, binary: false }] };

function answerView(gate: Gate, read: Parameters<typeof AnswerView>[0]["read"]): string {
  return renderToStaticMarkup(<AnswerView gate={gate} read={read} now={NOW} posting={false} problem="" onAnswer={() => undefined} />);
}

describe("the inbox list", () => {
  it("shows what each wait asks, how long it waited, and why one cannot be answered here", () => {
    const html = renderToStaticMarkup(<InboxList now={NOW} selected="acme/widgets/a9f259f0" onSelect={() => undefined} rows={[
      ROW,
      { ...ROW, session: "c2c2c2c2", kind: "questions", questions: 3, round: 1, since: "2026-09-29T12:00:00.000Z",
        channel: "terminal", blocked: "started from a prompt, with no work item to answer on" },
    ]} />);
    expect(html).toContain("plan gate");
    expect(html).toContain("round 2");
    expect(html).toContain("30m ago");
    expect(html).toContain("3 questions");
    expect(html).toContain("waiting 2d");                       // stale: flagged
    expect(html).toContain("started from a prompt, with no work item to answer on");
    expect(html.match(/<li role="option" aria-selected="true"/g)).toHaveLength(1);    // the open one: the first
    expect(html.indexOf('aria-selected="true"')).toBeLessThan(html.indexOf('aria-selected="false"'));
    expect(html).not.toContain("for you");
  });

  it("says why a row is the viewer's own", () => {
    const html = renderToStaticMarkup(<InboxList now={NOW} selected={null} onSelect={() => undefined} rows={[
      { ...ROW, forYou: ["triggered", "assigned"] },
    ]} />);
    expect(html).toContain("for you: you triggered it, assigned to you");
  });
});

describe("the answer view", () => {
  it("says what it asks, shows the subject at the pinned commit and where the answer will land", () => {
    const html = answerView(GATE, READ);
    expect(html).toContain("Approve the plan?");
    expect(html).toMatch(/<code>docs\/asf\/spec\/plan.md<\/code> <span[^>]*>at 89abcde<\/span>/);
    expect(html).toContain("Posts a comment on issue #42 as alex");
    expect(html).toContain("Round 1: <strong>reject</strong> by schurik");
    expect(html).toContain("current");
    expect(html).not.toContain(' disabled=""');
  });

  it("says the viewer's own login as you", () => {
    const html = renderToStaticMarkup(
      <ViewerLogin.Provider value="Schurik">
        <AnswerView gate={{ ...GATE, as: "schurik" }} read={READ} now={NOW} posting={false} problem="" onAnswer={() => undefined} />
      </ViewerLogin.Provider>);
    expect(html).toContain("Posts a comment on issue #42 as you");
    expect(html).toContain("Round 1: <strong>reject</strong> by you");
  });

  it("offers no verdict on a subject that is not what the factory asked about", () => {
    const html = answerView(GATE, { ...READ, current: false });
    expect(html).toContain("Cannot be answered here: digest changed");
    for (const button of html.match(/<button[^>]*>/g) ?? []) expect(button).toContain(' disabled=""');
  });

  it("puts each question with its recommendation and a box to answer it, and one action to take them all", () => {
    const html = answerView({
      ...GATE, row: { ...ROW, kind: "questions", gate: "requirements", questions: 1, round: 1 }, earlier: [],
      questions: [{ topic: "scope", question: "Which endpoint?", why: "", blocking: true, options: [
        { answer: "/health", because: "it is the one that 500s", recommended: true },
        { answer: "every endpoint", because: "", recommended: false }] }],
    }, { ...READ, files: [] });
    expect(html).toContain("1 question before the requirements");
    expect(html).toContain("/health<em> — recommended</em>");
    expect(html).toContain("leave empty to take “/health”");
    expect(html).toContain("Take all recommendations");
    expect(html).not.toContain("Reject");
  });
});

describe("the inbox filtered to one factory", () => {
  it("keeps that factory's waits, whatever case its name is linked in, and all of them with none named", () => {
    const rows = [ROW, { ...ROW, factory: "acme/gadgets", session: "b1" }, { ...ROW, session: "c1" }];
    expect(onlyOf(rows, "Acme/Widgets").map((row) => row.session)).toEqual(["a9f259f0", "c1"]);
    expect(onlyOf(rows, undefined)).toEqual(rows);
  });
});
