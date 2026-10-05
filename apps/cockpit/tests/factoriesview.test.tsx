import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FactoryRows } from "../components/factories/FactoryRows";
import type { FactoryRow } from "../convex/factories";
import type { Facts } from "../convex/model/attention";
import type { ClaimView } from "../convex/model/claim";
import { rank } from "../convex/model/factories";

// The Factories list (#117), drawn with Now's rows and rendered to static
// markup with no backend: each factory says what needs the viewer, what is
// moving, what it spent this month and when it last moved — the factories
// that need attention first — and opens its own page.

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const HOUR = 3600_000;

const QUIET: Facts = {
  gates: { mine: 0, total: 0 }, failed: [], claims: [], check: "unchecked", drifted: [], queued: null, watchers: [],
};

const CLAIM: ClaimView = {
  id: "k1", kind: "issue", number: 42, repo: "acme/widgets", session: "b1", station: "st_bob", stationName: "bob@desk:widgets",
  seenAt: 0, heardAt: NOW - 50 * HOUR, grantedAt: NOW - 50 * HOUR, released: null, refused: null,
  consequence: "relabels #42 `asf:queued` and abandons session b1",
};

function row(repo: string, fields: Partial<FactoryRow> = {}): FactoryRow {
  return {
    repo, role: "write", private: false, onForge: true, reporting: true, lastActivity: NOW - HOUR,
    live: 0, seen: [], spend: { cost: 0, tokens: 0 }, workflows: 3, facts: QUIET, ...fields,
  };
}

/** The markup's text, one space between words, the way a person reads it. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");
}

function render(rows: FactoryRow[]) {
  return renderToStaticMarkup(<FactoryRows rows={rank(rows, NOW)} now={NOW} />);
}

/** One factory's row of `html`: from its link to the next one. */
function rowOf(html: string, repo: string): string {
  const start = html.indexOf(`href="/factories/${repo}"`);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf('href="/factories/', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

const busy = row("acme/widgets", {
  live: 2,
  seen: [NOW - 2_000, NOW - 5 * 60_000],
  spend: { cost: 2.75, tokens: 4500 },
  workflows: 7,
  lastActivity: NOW - 2 * HOUR,
  facts: {
    ...QUIET,
    gates: { mine: 1, total: 3 },
    failed: [{ session: "f1", title: "#42 health check broken", workflow: "issue", station: "alex@mbp:widgets", endedAt: NOW - 3 * HOUR }],
    claims: [CLAIM],
    check: "failing",
    drifted: [{ station: "st_alex", name: "alex@mbp:widgets", badges: ["3 commits behind"] }],
    queued: [42, 43],
    watchers: [],
  },
});

describe("a row of the Factories list", () => {
  it("says what needs the viewer: the gates on them, a failing check, and how much more needs attention", () => {
    expect(text(render([busy]))).toContain("1 gate on you · check failing · 4 more need attention");
  });

  it("counts each failed session as a thing that needs attention, as Now lists them", () => {
    const failed = (session: string) => ({ session, title: session, workflow: "issue", station: "alex@mbp:widgets", endedAt: NOW - HOUR });
    const said = text(render([row("acme/alpha", { facts: { ...QUIET, failed: [failed("f1"), failed("f2"), failed("f3")] } })]));

    expect(said).toContain("3 more need attention");
  });

  it("says nothing needs attention where nothing does — a gate waiting on someone else included", () => {
    const said = text(render([row("acme/alpha", { facts: { ...QUIET, gates: { mine: 0, total: 2 } } })]));

    expect(said).toContain("Nothing needs attention");
    expect(said).not.toMatch(/on you|check failing|more need/);
  });

  it("says what is moving: sessions running, stations online of all, and the workflows it loads", () => {
    expect(text(render([busy]))).toContain("2 running · 1/2 stations online · 7 workflows");
  });

  it("says when no station has reported yet, and leaves workflows out until a self-description says how many", () => {
    const said = text(render([row("acme/alpha", { reporting: false, workflows: null })]));

    expect(said).toContain("0 running · no station yet");
    expect(said).not.toContain("workflows");
  });

  it("says what it spent this month, list-price equivalent, and when it was last active", () => {
    const html = render([busy, row("acme/alpha", { lastActivity: null, reporting: false })]);

    expect(text(rowOf(html, "acme/widgets"))).toContain("$2.75 this month");
    expect(rowOf(html, "acme/widgets")).toContain("list-price equivalent");
    expect(text(rowOf(html, "acme/widgets"))).toContain("active 2h ago");
    expect(text(rowOf(html, "acme/alpha"))).toContain("never active");
  });

  it("opens its factory", () => {
    expect(render([busy])).toContain('href="/factories/acme/widgets"');
  });

  it("marks a failing factory as failed, one waiting on something as waiting, and a quiet one as fine", () => {
    const html = render([busy, row("acme/beta", { facts: { ...QUIET, gates: { mine: 1, total: 1 } } }), row("acme/alpha")]);

    expect(rowOf(html, "acme/widgets")).toContain('aria-label="failed"');
    expect(rowOf(html, "acme/beta")).toContain('aria-label="waiting"');
    expect(rowOf(html, "acme/alpha")).toContain('aria-label="done"');
  });

  it("says a factory is private, or not found on the forge", () => {
    const said = text(render([row("acme/secret", { private: true }), row("acme/local", { onForge: false })]));

    expect(said).toContain("private");
    expect(said).toContain("not found on the forge");
  });
});

describe("the Factories list's rows", () => {
  it("lead with the factories that need attention, then the most recently active", () => {
    const html = render([
      row("acme/alpha", { lastActivity: NOW - HOUR }),
      row("acme/beta", { lastActivity: NOW - 3 * HOUR }),
      busy,
      row("acme/gamma", { lastActivity: null }),
    ]);
    const order = [...html.matchAll(/href="\/factories\/([^"]+)"/g)].map((match) => match[1]);

    expect(order).toEqual(["acme/widgets", "acme/alpha", "acme/beta", "acme/gamma"]);
  });
});
