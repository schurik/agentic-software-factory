"use client";

import { useState } from "react";
import type { ClaimView } from "@/convex/model/claim";
import { ONLINE_FOR } from "@/convex/model/command";
import { formatSpan } from "./format";

const RELEASED_WHY: Record<string, string> = {
  finished: "freed: the run finished", aborted: "freed: the run was aborted", "never started": "given back: the run never started",
};

/** How long a claim's station has been away, in words: "online", or "offline 2 d" — never "orphaned". */
function awayWords(claim: Pick<ClaimView, "heardAt">, now: number): string {
  const away = now - claim.heardAt;
  return away < ONLINE_FOR ? "online" : `offline ${formatSpan(away)}`;
}

/**
 * A claimed work item (ADR 0003): which station holds it and how long that
 * station has been away — away, never "orphaned": a laptop asleep over a
 * weekend is not a dead one, and nothing releases a claim by the clock. A
 * writer may release it, in two steps, the second saying what that does.
 * Shown on the session page, under its station and in Needs attention.
 */
export function ClaimRow({ claim, now, onRelease }: { claim: ClaimView; now: number; onRelease?: (claim: ClaimView) => void }) {
  const [asking, setAsking] = useState(false);
  const item = `${claim.kind === "pr" ? "pull request" : "issue"} #${claim.number}`;
  const consequence = claim.consequence.charAt(0).toUpperCase() + claim.consequence.slice(1);
  if (claim.released !== null) {
    const { by, why } = claim.released;
    return <div className="small muted">{item} {why === "released" ? `released by ${by || "someone"}: session abandoned` : RELEASED_WHY[why] ?? why}</div>;
  }
  return (
    <div className="claim">
      <div className="small">{item} held by <code>{claim.stationName}</code>, {awayWords(claim, now)}</div>
      {claim.refused !== null ? <div className="muted small">{claim.refused}</div>
        : asking ? (
          <div className="confirm small">
            {consequence}.{" "}
            <button className="button small danger" onClick={() => { setAsking(false); onRelease?.(claim); }}>Release</button>{" "}
            <button className="link small" onClick={() => setAsking(false)}>Cancel</button>
          </div>
        ) : (
          <button className="button small" title={consequence} disabled={!onRelease} onClick={() => setAsking(true)}>Release claim</button>
        )}
    </div>
  );
}
