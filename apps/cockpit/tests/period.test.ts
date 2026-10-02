import { describe, expect, it } from "vitest";
import { dayOf, daysOf, periodOf } from "../convex/model/period";

// A period is a calendar day, week or month in the viewer's own timezone
// (spec #40): where it starts there, and where the next one does.

const at = (iso: string) => Date.parse(iso);

describe("a period in the viewer's timezone", () => {
  it("is this calendar month, by default, from its first midnight there to the next month's", () => {
    const now = at("2026-10-14T09:30:00Z");

    expect(periodOf("month", now, "UTC")).toEqual({ from: at("2026-10-01T00:00:00Z"), to: at("2026-11-01T00:00:00Z") });
    expect(periodOf("month", now, "Europe/Berlin"))
      .toEqual({ from: at("2026-09-30T22:00:00Z"), to: at("2026-10-31T23:00:00Z") });  // CEST, then CET
  });

  it("is the month it already is there, when UTC has not reached it yet", () => {
    // 2026-10-31 20:00 in New York is 2026-11-01 00:30 UTC: still October there.
    expect(periodOf("month", at("2026-11-01T00:30:00Z"), "America/New_York"))
      .toEqual({ from: at("2026-10-01T04:00:00Z"), to: at("2026-11-01T04:00:00Z") });
  });

  it("is a calendar day, from midnight to midnight there, at a half-hour offset too", () => {
    expect(periodOf("day", at("2026-10-14T20:00:00Z"), "Asia/Kolkata"))
      .toEqual({ from: at("2026-10-14T18:30:00Z"), to: at("2026-10-15T18:30:00Z") });
  });

  it("is a week that starts on Monday, across a month's end", () => {
    // Thursday 2026-10-01.
    expect(periodOf("week", at("2026-10-01T12:00:00Z"), "UTC"))
      .toEqual({ from: at("2026-09-28T00:00:00Z"), to: at("2026-10-05T00:00:00Z") });
    // A Sunday is the week's last day, not the next one's first.
    expect(periodOf("week", at("2026-10-04T23:00:00Z"), "UTC"))
      .toEqual({ from: at("2026-09-28T00:00:00Z"), to: at("2026-10-05T00:00:00Z") });
  });
});

describe("a custom range of calendar days in the viewer's timezone", () => {
  it("runs from its first day's midnight there to the midnight after its last, across a DST change", () => {
    // Europe/Berlin leaves summer time on 2026-10-25.
    expect(daysOf("2026-10-01", "2026-10-31", "Europe/Berlin"))
      .toEqual({ from: at("2026-09-30T22:00:00Z"), to: at("2026-10-31T23:00:00Z") });
  });

  it("is one whole day when it starts and ends on the same one, at a half-hour offset too", () => {
    expect(daysOf("2026-10-14", "2026-10-14", "Asia/Kolkata"))
      .toEqual({ from: at("2026-10-13T18:30:00Z"), to: at("2026-10-14T18:30:00Z") });
  });

  it("is null for days that are not dates, or end before they start", () => {
    expect(daysOf("", "2026-10-14", "UTC")).toBeNull();
    expect(daysOf("2026-10-15", "2026-10-14", "UTC")).toBeNull();
  });
});

describe("the calendar day an instant falls on in the viewer's timezone", () => {
  it("is the day it already is there, as a date input writes it", () => {
    expect(dayOf(at("2026-10-31T23:30:00Z"), "Europe/Berlin")).toBe("2026-11-01");
    expect(dayOf(at("2026-10-31T23:30:00Z"), "UTC")).toBe("2026-10-31");
  });
});
