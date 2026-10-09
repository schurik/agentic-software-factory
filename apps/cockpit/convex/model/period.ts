/**
 * A period spend is rolled up over (spec #40): a calendar day, week or month
 * in the viewer's own timezone — month-to-date by default — because that is
 * how a team budgets, not by UTC.
 *
 * A period is [`from`, `to`) in epoch ms: from the midnight it starts at
 * there to the one the next period starts at, so a query given it changes
 * only when the period does. Nothing has been spent after now, which is what
 * makes the current period "to date".
 */

import { v } from "convex/values";

export type PeriodKind = "day" | "week" | "month";

export const PERIODS: Record<PeriodKind, string> = { day: "today", week: "this week", month: "this month" };

export interface Period {
  from: number;
  to: number;
}

/** A period as a query takes it. */
export const periodValidator = v.object({ from: v.number(), to: v.number() });

/** The `kind` of period `now` falls in, in `timeZone` (an IANA name). Weeks start on Monday. */
export function periodOf(kind: PeriodKind, now: number, timeZone: string): Period {
  const { year, month, day, weekday } = wallDate(now, timeZone);
  if (kind === "day") return { from: midnight(year, month, day, timeZone), to: midnight(year, month, day + 1, timeZone) };
  if (kind === "week") {
    const monday = day - ((weekday + 6) % 7);
    return { from: midnight(year, month, monday, timeZone), to: midnight(year, month, monday + 7, timeZone) };
  }
  return { from: midnight(year, month, 1, timeZone), to: midnight(year, month + 1, 1, timeZone) };
}

/**
 * The calendar days `first` through `last` (`YYYY-MM-DD`, as a date input
 * gives them) in `timeZone`: a custom range, from its first midnight there to
 * the one after its last day. Null when either is not a date, or it ends
 * before it starts.
 */
export function daysOf(first: string, last: string, timeZone: string): Period | null {
  const start = dateOf(first);
  const end = dateOf(last);
  if (start === null || end === null || Date.UTC(...end) < Date.UTC(...start)) return null;
  return { from: midnight(...start, timeZone), to: midnight(end[0], end[1], end[2] + 1, timeZone) };
}

/**
 * The last `count` calendar days in `timeZone`, today's included, as the
 * midnights that start each of them there and the one after today: a
 * factory's Overview spends over them, a column a day. `count + 1` instants;
 * a day a DST change falls on is 23 or 25 hours long, as the viewer lived it.
 */
export function lastDays(count: number, now: number, timeZone: string): number[] {
  const { year, month, day } = wallDate(now, timeZone);
  return Array.from({ length: count + 1 }, (_, index) => midnight(year, month, day - count + 1 + index, timeZone));
}

/** The calendar day `at` falls on in `timeZone`, as `YYYY-MM-DD`: what a custom range starts from. */
export function dayOf(at: number, timeZone: string): string {
  const { year, month, day } = wallDate(at, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dateOf(day: string): [number, number, number] | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

interface Wall {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 is Sunday, as `Date.getUTCDay` has it. */
  weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The wall clock in `timeZone` at `at`. */
function wallDate(at: number, timeZone: string): Wall {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", weekday: "short",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((each) => each.type === type)?.value ?? "";
  return {
    year: Number(part("year")), month: Number(part("month")), day: Number(part("day")),
    hour: Number(part("hour")), minute: Number(part("minute")), second: Number(part("second")),
    weekday: WEEKDAYS.indexOf(part("weekday")),
  };
}

/** How far `timeZone`'s wall clock is ahead of UTC at `at`, in ms. */
function offset(at: number, timeZone: string): number {
  const wall = wallDate(at, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

/**
 * The instant midnight starts `day` of `month` in `timeZone` — a day or month
 * past its end rolls over, as `Date.UTC` has it. The offset is read twice:
 * once at the UTC guess, again at the answer, because a DST change between
 * the two moves it.
 */
function midnight(year: number, month: number, day: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day);
  const first = guess - offset(guess, timeZone);
  return guess - offset(first, timeZone);
}
