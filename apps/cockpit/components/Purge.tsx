"use client";

import { useState } from "react";
import type { Purged } from "@/convex/retention";
import { Button, control, Field } from "./ui";

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
    <details className="mt-4 text-sm">
      <summary className="text-muted">{label}…</summary>
      <div className="mt-2 grid gap-2">
        <p className="text-muted">{explains}</p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Why" className="min-w-0 grow">
            <input type="text" value={reason} className={control} onChange={(event) => setReason(event.target.value)}
                   placeholder="a token leaked into an artifact" />
          </Field>
          <Button variant="danger" disabled={busy || !reason.trim()} onClick={purge}>{label}</Button>
        </div>
        {said ? <p>{said}</p> : null}
      </div>
    </details>
  );
}
