import { describe, expect, it } from "vitest";
import { keyed } from "../components/inbox/keys";
import { renderToStaticMarkup } from "react-dom/server";
import { inboxAddress, stepOf } from "../components/Inbox";
import { InboxList, onlyOf } from "../components/inbox/InboxList";
import type { Row } from "../convex/model/inbox";

// The inbox's pages, rendered to static markup with no backend: the list, the
// drawer a row opens its gate in (#113; the gate itself is gateview.test.tsx's),
// and the keyboard flow (spec #40) — next and previous through the list, Enter
// to open, approve and reject on the gate that is open, never while typing.

describe("the inbox's keys", () => {
  const plain = { target: null, metaKey: false, ctrlKey: false, altKey: false };

  it("move through the list and answer the wait that is open", () => {
    expect(keyed({ ...plain, key: "j" })).toBe("next");
    expect(keyed({ ...plain, key: "ArrowDown" })).toBe("next");
    expect(keyed({ ...plain, key: "k" })).toBe("previous");
    expect(keyed({ ...plain, key: "ArrowUp" })).toBe("previous");
    expect(keyed({ ...plain, key: "Enter" })).toBe("open");
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

describe("the inbox's drawer", () => {
  const rows = [ROW, { ...ROW, session: "b1", blocked: "answered by alex in the cockpit (approve)" }, { ...ROW, session: "c1" }];
  const link = (key: string) => ({ href: `/?open=${key}`, onClick: () => {} });

  it("opens the gate a row names, from the address, so a link opens exactly that gate", () => {
    expect(inboxAddress({ open: "acme/widgets/a9f259f0" })).toBe("/?open=acme%2Fwidgets%2Fa9f259f0");
    expect(inboxAddress({ factory: "acme/widgets", open: "acme/widgets/c1", tab: "issue" }))
      .toBe("/?factory=acme%2Fwidgets&open=acme%2Fwidgets%2Fc1&tab=issue");
    expect(inboxAddress({})).toBe("/");
  });

  it("steps through the gates that can still be answered: n of m, and the ones either side", () => {
    expect(stepOf(rows, "acme/widgets/a9f259f0", link)).toMatchObject({
      at: 1, of: 2, previous: null, next: { href: "/?open=acme/widgets/c1" },
    });
    expect(stepOf(rows, "acme/widgets/c1", link)).toMatchObject({ at: 2, of: 2, next: null });
    // The one just answered still counts while it is open, saying so.
    expect(stepOf(rows, "acme/widgets/b1", link)).toMatchObject({ at: 2, of: 3 });
    expect(stepOf(rows, "acme/gadgets/zz", link)).toBeNull();
  });
});

describe("the inbox filtered to one factory", () => {
  it("keeps that factory's waits, whatever case its name is linked in, and all of them with none named", () => {
    const rows = [ROW, { ...ROW, factory: "acme/gadgets", session: "b1" }, { ...ROW, session: "c1" }];
    expect(onlyOf(rows, "Acme/Widgets").map((row) => row.session)).toEqual(["a9f259f0", "c1"]);
    expect(onlyOf(rows, undefined)).toEqual(rows);
  });
});
