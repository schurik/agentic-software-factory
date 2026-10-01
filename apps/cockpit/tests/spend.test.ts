import { describe, expect, it } from "vitest";
import { spentIn } from "../convex/model/spend";
import { corpus } from "./helpers";

// Spend is read from `usage` events by its own reader (`model/spend.ts`), apart
// from the session fold's — so every `usage` version ever written must be read
// by it too, or a new one would ship spending nothing.

describe("spend, over the golden corpus", () => {
  const versions = Object.entries(corpus).filter(([path]) => path.startsWith("usage/"));

  it.each(versions)("reads what %s cost, and the tokens it took", (_, event) => {
    const payload = event.payload as { cost: number; tokens: number };
    const stored = { ...event, payload: JSON.stringify(event.payload) };

    expect(spentIn([stored], 0)).toEqual([
      { at: Date.parse("2026-09-29T12:00:00.000Z"), cost: payload.cost, tokens: payload.tokens },
    ]);
  });

  it("has a usage version to read", () => {
    expect(versions.length).toBeGreaterThan(0);
  });
});
