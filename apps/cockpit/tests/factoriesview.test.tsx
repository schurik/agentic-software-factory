import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FactoriesTable } from "../components/FactoriesTable";
import type { FactoryRow } from "../convex/factories";
import type { Facts } from "../convex/model/attention";
import type { ClaimView } from "../convex/model/claim";
import { rank } from "../convex/model/factories";

// The Factories list's rows, rendered to static markup with no backend (spec
// #40): each factory's live sessions, gates waiting on the viewer and in all,
// stations online of all, spend in the period with tokens alongside, and the
// flags that say why it needs attention.

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
    live: 0, seen: [], spend: { cost: 0, tokens: 0 }, facts: QUIET, ...fields,
  };
}

/** The markup's text, one space between words, the way a person reads it. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");
}

function render(rows: FactoryRow[]) {
  return renderToStaticMarkup(
    <FactoriesTable rows={rank(rows, NOW, "attention")} now={NOW} host="github.com" period="this month"
                    triggering={null} onTrigger={() => {}} />);
}

describe("a row of the Factories list", () => {
  const busy = row("acme/widgets", {
    live: 2,
    seen: [NOW - 2_000, NOW - 5 * 60_000],
    spend: { cost: 2.75, tokens: 4500 },
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

  it("says how many sessions run, and the gates waiting on the viewer of all that wait", () => {
    const said = text(render([busy]));

    expect(said).toContain("2 live");
    expect(said).toContain("1 on you / 3");
  });

  it("says how many of its stations are online, of all it has", () => {
    expect(text(render([busy]))).toContain("1 / 2 online");
    expect(text(render([row("acme/widgets", { reporting: false })]))).toContain("no station yet");
  });

  it("says what it spent in the period, list-price equivalent, with the tokens alongside", () => {
    const html = render([busy]);

    expect(text(html)).toContain("Spend this month");
    expect(text(html)).toContain("$2.75");
    expect(text(html)).toContain("4,500 tokens");
    expect(html).toContain("list-price equivalent");
  });

  it("flags what needs attention — a failure, a waiting claim, drift, a failing check, nobody watching — never calling a claim orphaned", () => {
    const said = text(render([busy]));

    expect(said).toContain("1 failed in 24h");
    expect(said).toContain("#42 held by bob@desk:widgets, offline 2d");
    expect(said).toContain("1 station drifted");
    expect(said).toContain("check failing");
    expect(said).toContain("nobody watching");
    expect(said).not.toMatch(/orphan/i);
  });

  it("has no flags where nothing needs attention, and leads with what does", () => {
    const html = render([row("acme/alpha"), busy]);

    expect(html.indexOf("acme/widgets")).toBeLessThan(html.indexOf("acme/alpha"));
    expect(text(html.slice(html.indexOf("acme/alpha")))).not.toMatch(/failed|drifted|check failing|nobody watching/);
  });
});
