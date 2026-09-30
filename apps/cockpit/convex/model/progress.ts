/** How the forge catch-up poll is doing (discovery.ts), as a page shows it. */
export interface Progress {
  /** When the repositories were last listed in full, or null before the first time. */
  listedAt: number | null;
  /** When the forge's rate limit lets the poll go on, or null when nothing holds it. */
  pausedUntil: number | null;
  /** What the forge last refused, or "" when the last stretch ran to its end. */
  problem: string;
  /** Repositories the forge has not been asked about since they last moved, counted up to `PENDING_SHOWN`. */
  pending: number;
}

/** Past this many repositories still to look at, the count is "this many or more". */
export const PENDING_SHOWN = 1000;
