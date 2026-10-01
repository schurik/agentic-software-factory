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
