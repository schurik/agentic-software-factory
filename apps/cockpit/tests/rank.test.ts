import { describe, expect, it } from "vitest";
import type { Facts } from "../convex/model/attention";
import { rank, type Rankable } from "../convex/model/factories";

// How the Factories list orders its rows (spec #40): what needs attention
// first, then the most recently active, with alphabetical a toggle — read
// against the page's clock, like the Factory page's Needs attention.

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const HOUR = 3600_000;

const QUIET: Facts = {
  gates: { mine: 0, total: 0 }, failed: [], claims: [], check: "unchecked", drifted: [], queued: null, watchers: [],
};

function row(repo: string, fields: Partial<Rankable> = {}): Rankable {
  return { repo, lastActivity: null, seen: [], facts: QUIET, ...fields };
}

const names = (ranked: { row: Rankable }[]) => ranked.map((each) => each.row.repo);

describe("the Factories list's order", () => {
  it("puts the factories that need attention first, then the most recently active, then the rest by name", () => {
    const rows = [
      row("acme/alpha"),
      row("acme/beta", { lastActivity: NOW - HOUR }),
      row("acme/gamma", { lastActivity: NOW - 5 * HOUR, facts: { ...QUIET, check: "failing" } }),
      row("acme/delta", { lastActivity: NOW - 2 * HOUR }),
      row("acme/omega", { lastActivity: NOW - 9 * HOUR, facts: { ...QUIET, gates: { mine: 1, total: 1 } } }),
      row("acme/Zeta"),
    ];

    expect(names(rank(rows, NOW, "attention")))
      .toEqual(["acme/gamma", "acme/omega", "acme/beta", "acme/delta", "acme/alpha", "acme/Zeta"]);
  });

  it("is alphabetical, case aside, when the viewer toggles it", () => {
    const rows = [row("acme/Zeta"), row("acme/beta", { facts: { ...QUIET, check: "failing" } }), row("acme/alpha")];

    expect(names(rank(rows, NOW, "name"))).toEqual(["acme/alpha", "acme/beta", "acme/Zeta"]);
  });

  it("stops ranking a failure first once it is a day old, without anything new arriving", () => {
    const failed = { session: "f1", title: "#42 health check broken", workflow: "issue", station: "alex@mbp:widgets", endedAt: NOW - 2 * HOUR };
    const rows = [row("acme/fresh", { lastActivity: NOW - HOUR }), row("acme/failed", { lastActivity: NOW - 2 * HOUR, facts: { ...QUIET, failed: [failed] } })];

    expect(names(rank(rows, NOW, "attention"))).toEqual(["acme/failed", "acme/fresh"]);
    expect(names(rank(rows, NOW + 23 * HOUR, "attention"))).toEqual(["acme/fresh", "acme/failed"]);
  });

  it("does not rank first a factory whose gates wait only on someone else", () => {
    const rows = [row("acme/beta", { lastActivity: NOW - HOUR }), row("acme/alpha", { facts: { ...QUIET, gates: { mine: 0, total: 2 } } })];

    expect(rank(rows, NOW, "attention").map((each) => [each.row.repo, each.attention.length]))
      .toEqual([["acme/beta", 0], ["acme/alpha", 0]]);
  });

  it("counts the stations online by the page's clock", () => {
    const [ranked] = rank([row("acme/widgets", { seen: [NOW - 2_000, NOW - 60_000, 0] })], NOW, "attention");

    expect(ranked.online).toBe(1);
  });
});
