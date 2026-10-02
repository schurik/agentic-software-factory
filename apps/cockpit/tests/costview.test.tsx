import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CostView } from "../components/cost/CostView";
import type { Rollup } from "../convex/cost";

// The Cost tab and the Cost page, rendered from a roll-up with no backend
// (spec #40, #62): every dimension, labelled list-price equivalent, with the
// tokens alongside every amount, and no budget but the per-session one.

const ROLLUP: Rollup = {
  cut: false,
  total: { cost: 0.5185, tokens: 30_700 },
  sessions: [
    { factory: "acme/widgets", session: "a9f259f0", request: "resolve relative due dates", workflows: ["issue", "pr-review"],
      cost: 0.463, tokens: 27_100 },
    { factory: "acme/gadgets", session: "77aa0011", request: "", workflows: ["ship"], cost: 0.0185, tokens: 1_200 },
  ],
  workflows: [
    { factory: "acme/widgets", workflow: "issue", cost: 0.383, tokens: 23_100 },
    { factory: "acme/gadgets", workflow: "ship", cost: 0.0185, tokens: 1_200 },
  ],
  factories: [
    { factory: "acme/widgets", cost: 0.5, tokens: 29_500 },
    { factory: "acme/gadgets", cost: 0.0185, tokens: 1_200 },
  ],
  stations: [
    { factory: "acme/widgets", station: "st_7f3a9c", name: "alex@mbp:widgets", owner: "alex", cost: 0.463, tokens: 27_100 },
    { factory: "acme/gadgets", station: "st_gadgets", name: "runner@ci:gadgets", owner: "", cost: 0.0185, tokens: 1_200 },
  ],
  people: [
    { person: "sam", cost: 0.463, tokens: 27_100 },
    { person: "", cost: 0.0185, tokens: 1_200 },
  ],
};

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

const shown = (rollup: Rollup, factory?: string) =>
  text(renderToStaticMarkup(<CostView rollup={rollup} period="this month" factory={factory} />));

describe("cost across factories", () => {
  const page = shown(ROLLUP);

  it("totals the period as list-price equivalent, tokens alongside", () => {
    expect(page).toContain("$0.52 · 30,700 tokens this month");
    expect(page).toContain("list-price equivalent");
  });

  it("rolls up by factory, workflow, station with its owner, person and session", () => {
    expect(page).toContain("acme/widgets $0.50 29,500 tokens");
    expect(page).toContain("acme/gadgets ship $0.02 1,200 tokens");
    expect(page).toContain("alex@mbp:widgets acme/widgets alex $0.46 27,100 tokens");
    expect(page).toContain("runner@ci:gadgets acme/gadgets not registered $0.02 1,200 tokens");
    expect(page).toContain("sam $0.46 27,100 tokens");
    expect(page).toContain("not named by the factory $0.02 1,200 tokens");
    expect(page).toContain("a9f259f0 acme/widgets resolve relative due dates issue → pr-review $0.46 27,100 tokens");
  });

  it("tells who paid from who asked", () => {
    expect(page).toContain("By station — whose machine and key paid");
    expect(page).toContain("By person — who triggered the run");
  });

  it("shows no budget but the per-session one, which is not here", () => {
    expect(page).not.toMatch(/budget|ceiling|limit/i);
  });
});

describe("one factory's Cost tab", () => {
  const tab = shown({ ...ROLLUP, factories: [ROLLUP.factories[0]] }, "acme/widgets");

  it("drops what only tells factories apart", () => {
    expect(tab).not.toContain("By factory");
    expect(tab).toContain("alex@mbp:widgets alex $0.46 27,100 tokens");
    expect(tab).toContain("issue $0.38 23,100 tokens");
    expect(tab).toContain("a9f259f0 resolve relative due dates issue → pr-review $0.46");
  });
});

describe("a period nothing was spent in", () => {
  it("says so, instead of empty tables", () => {
    const empty: Rollup = { cut: false, total: { cost: 0, tokens: 0 }, sessions: [], workflows: [], factories: [], stations: [], people: [] };
    expect(shown(empty)).toContain("Nothing was spent this month.");
    expect(shown(empty)).not.toContain("By workflow");
  });
});

describe("a period too long to sum at once", () => {
  it("asks for a shorter one, and shows no sums", () => {
    const cut: Rollup = { cut: true, total: { cost: 0, tokens: 0 }, sessions: [], workflows: [], factories: [], stations: [], people: [] };
    expect(shown(cut)).toContain("More was spent this month than the cockpit sums at once: pick a shorter period.");
    expect(shown(cut)).not.toContain("Nothing was spent");
  });
});
