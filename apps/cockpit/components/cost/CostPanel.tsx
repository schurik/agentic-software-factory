"use client";

import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { dayOf, daysOf, type PeriodKind, PERIODS, periodOf } from "@/convex/model/period";
import { useClock, viewersTimeZone } from "../clock";
import { useSignIn } from "../signIn";
import { CostView } from "./CostView";

type Choice = PeriodKind | "range";

/**
 * Cost over a period the viewer picks (spec #40): today, this week or this
 * month in their own timezone — month-to-date unless they pick another — or
 * a range of days, which starts as this month so far. Of `factory` alone on
 * its Factory page, of every factory they can read on the Cost page.
 */
export function CostPanel({ factory }: { factory?: string }) {
  const signIn = useSignIn();
  const now = useClock();
  const timeZone = viewersTimeZone();
  const [choice, setChoice] = useState<Choice>("month");
  const [days, setDays] = useState(() => ({
    first: dayOf(periodOf("month", now, timeZone).from, timeZone), last: dayOf(now, timeZone),
  }));
  // A calendar period's bounds stay put between its midnights, so the query is asked again only when it moves on.
  const period = choice === "range" ? daysOf(days.first, days.last, timeZone) : periodOf(choice, now, timeZone);
  const rollup = useQuery(api.cost.rollup, period === null ? "skip" : { factory, period, signIn });
  const words = choice === "range" ? `from ${days.first} to ${days.last}` : PERIODS[choice];

  return (
    <>
      <p className="list-controls">
        <label>
          Spend{" "}
          <select value={choice} onChange={(event) => setChoice(event.target.value as Choice)}>
            {Object.entries(PERIODS).map(([value, each]) => <option key={value} value={value}>{each}</option>)}
            <option value="range">from … to …</option>
          </select>
        </label>
        {choice === "range" ? (
          <>
            <input type="date" aria-label="first day" value={days.first} max={days.last}
                   onChange={(event) => setDays({ ...days, first: event.target.value })} />
            <input type="date" aria-label="last day" value={days.last} min={days.first}
                   onChange={(event) => setDays({ ...days, last: event.target.value })} />
          </>
        ) : null}
        <span className="muted small">Calendar days in {timeZone}.</span>
      </p>
      {period === null ? <p className="notice">Pick a first day on or before the last.</p>
        : rollup === undefined ? <p className="muted">Loading…</p>
          : rollup === null ? <p className="notice">{factory ? `${factory} is not a factory you can read.` : "Sign in to see what was spent."}</p>
            : <CostView rollup={rollup} period={words} factory={factory} />}
    </>
  );
}
