"use client";

import { useState } from "react";
import type { Purged } from "@/convex/retention";

/**
 * A purge, asked for in two steps: open it, say why, confirm. What it removes
 * cannot be put back, so it is never one click, and the reason is required —
 * it is kept in the audit line with who asked and when (retention.ts).
 */
export function Purge({ label, explains, onPurge }: {
  label: string;
  explains: string;
  onPurge: (reason: string) => Promise<Purged>;
}) {
  const [reason, setReason] = useState("");
  const [said, setSaid] = useState("");
  const [busy, setBusy] = useState(false);
  const purge = () => {
    setBusy(true);
    setSaid("");
    void onPurge(reason)
      .then((done) => setSaid(done.ok ? "Purging: the bodies are going now, and the audit line is written." : `Not purged: ${done.because}`))
      .catch((error: unknown) => setSaid(`Not purged: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => setBusy(false));
  };
  return (
    <details className="purge small">
      <summary className="muted">{label}…</summary>
      <p className="muted">{explains}</p>
      <label>
        Why <input type="text" value={reason} onChange={(event) => setReason(event.target.value)}
                   placeholder="a token leaked into an artifact" />
      </label>{" "}
      <button type="button" className="button danger" disabled={busy || !reason.trim()} onClick={purge}>{label}</button>
      {said ? <p className="small">{said}</p> : null}
    </details>
  );
}
