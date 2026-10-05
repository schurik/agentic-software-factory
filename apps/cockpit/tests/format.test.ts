import { describe, expect, it } from "vitest";
import {
  formatAgo, formatClock, formatCost, formatDay, formatDollars, formatDuration, formatNumber, formatSpan, formatTime,
  formatTokenCount, formatTokens, who,
} from "../components/format";
import { phaseName } from "../components/session/words";

// The one set of formats every page uses (#105): whatever the viewer's
// browser locale, a number reads "10,400" and never "10.400".

describe("numbers", () => {
  it("group in en-US whatever the locale", () => {
    expect(formatNumber(10_400)).toBe("10,400");
    expect(formatNumber(7)).toBe("7");
  });

  it("are dollars to the cent", () => {
    expect(formatDollars(0)).toBe("$0.00");
    expect(formatDollars(0.4631)).toBe("$0.46");
    expect(formatDollars(1234.5)).toBe("$1,234.50");
    expect(formatCost(0)).toBe("—");
    expect(formatCost(2.5)).toBe("$2.50");
  });

  it("count tokens exactly while that is readable, then in thousands and millions", () => {
    expect(formatTokenCount(9_800)).toBe("9,800");
    expect(formatTokenCount(12_340)).toBe("12.3k");
    expect(formatTokenCount(121_000)).toBe("121k");
    expect(formatTokenCount(999_960)).toBe("1M");
    expect(formatTokenCount(2_000_000)).toBe("2M");
    expect(formatTokenCount(2_450_000)).toBe("2.5M");
    expect(formatTokens(27_100)).toBe("27.1k tokens");
    expect(formatTokens(1)).toBe("1 token");
  });
});

describe("durations", () => {
  it("keep seconds only while they matter", () => {
    expect(formatDuration(null)).toBe("…");
    expect(formatDuration(0.2)).toBe("<1s");
    expect(formatDuration(28)).toBe("28s");
    expect(formatDuration(274)).toBe("4m 34s");
    expect(formatDuration(245)).toBe("4m 05s");
    expect(formatDuration(58 * 60 + 40)).toBe("58m");
    expect(formatDuration(2 * 3600 + 8 * 60 + 5)).toBe("2h 8m");
    expect(formatDuration(3 * 3600)).toBe("3h");
    expect(formatDuration(2 * 86400 + 5 * 3600)).toBe("2d 5h");
  });

  it("say a span in its largest whole unit, in the same letters", () => {
    expect(formatSpan(40_000)).toBe("40s");
    expect(formatSpan(12 * 60_000)).toBe("12m");
    expect(formatSpan(5 * 3600_000)).toBe("5h");
    expect(formatSpan(2 * 86400_000 + 1)).toBe("2d");
  });

  it("say how long ago in the same letters", () => {
    const now = Date.parse("2026-10-04T12:00:00Z");
    expect(formatAgo("2026-10-04T11:55:00Z", now)).toBe("5m ago");
    expect(formatAgo("2026-10-02T12:00:00Z", now)).toBe("2d ago");
  });
});

describe("times", () => {
  // The viewer's own timezone is whatever the browser runs in; the test pins the instant, not the zone.
  const at = "2026-10-04T14:05:09Z";
  const local = new Date(at);
  const hh = String(local.getHours()).padStart(2, "0");
  const mm = String(local.getMinutes()).padStart(2, "0");

  it("read as a 24-hour clock in the viewer's timezone", () => {
    expect(formatClock(at)).toBe(`${hh}:${mm}`);
    expect(formatClock("")).toBe("");
  });

  it("name the day, and the year only when it is not this one", () => {
    const now = Date.parse("2026-12-01T00:00:00Z");
    const day = local.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    expect(formatTime(at, now)).toBe(`${day}, ${hh}:${mm}`);
    expect(formatTime(at, Date.parse("2027-06-01T00:00:00Z"))).toBe(`${day}, 2026, ${hh}:${mm}`);
    expect(formatTime("", now)).toBe("—");
  });

  it("say a day the same way for every viewer", () => {
    expect(formatDay("2026-10-03T23:30:00Z")).toBe("Oct 3, 2026");
  });
});

describe("who", () => {
  it("is the viewer as you, and anyone else by login", () => {
    expect(who("Alex", "alex")).toBe("you");
    expect(who("sam", "alex")).toBe("sam");
    expect(who("sam", null)).toBe("sam");
    expect(who("", "alex")).toBe("");
  });
});

describe("phase names", () => {
  const phase = (name: string, gate?: { gate: string; round: number; kind?: string }) =>
    gate ? { type: "gate" as const, name, kind: "gate", ...gate } : { type: "agent" as const, name };

  it("say what a phase did in words, and keep any name the table does not know", () => {
    expect(["plan_revise_1", "verify_2", "fix_1", "review_3", "commit_plan", "commit_implement", "commit_document",
            "issue", "pr", "changes", "scout", "integrate"].map((name) => phaseName(phase(name)))).toEqual([
      "plan revision 1", "verify #2", "fix #1", "review #3", "commit plan", "commit code", "commit docs",
      "read the issue", "read the review", "collect the diff", "scout", "integrate"]);
  });

  it("name a gate by what it asks and its round", () => {
    expect(phaseName(phase("approve_plan_2", { gate: "plan", round: 2 }))).toBe("plan gate · round 2");
    expect(phaseName(phase("refine", { gate: "requirements", round: 1, kind: "questions" })))
      .toBe("requirements questions · round 1");
  });
});
