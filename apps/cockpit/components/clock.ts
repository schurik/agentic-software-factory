"use client";

import { useEffect, useState } from "react";

/** The time now, ticking every second: so "waited for" and "last heard from" keep counting between events. */
export function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The viewer's own timezone, as their browser has it: what a period of spend is a calendar period of. */
export function viewersTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
