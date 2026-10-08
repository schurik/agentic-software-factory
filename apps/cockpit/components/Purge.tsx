"use client";

import { useState } from "react";
import type { Purged } from "@/convex/retention";
import { Button, Control, cx, Field } from "./ui";

/**
 * A purge, asked for in two steps: open it, say why, confirm. What it removes
 * cannot be put back, so it is never one click, and the reason is required —
 * it is kept in the audit line with who asked and when (retention.ts).
 */
export function Purge({ label, explains, onPurge }: PurgeProps) {
  return (
    <details className="mt-4 text-sm">
      <summary className="text-muted">{label}…</summary>
      <PurgeForm label={label} explains={explains} onPurge={onPurge} className="mt-2" />
    </details>
  );
}

interface PurgeProps {
  label: string;
  explains: string;
  onPurge: (reason: string) => Promise<Purged>;
}

/**
 * The purge itself — what it removes, why, and the button — for a page that
 * opens it its own way (a dialog). `onPurged` hears of a purge that went
 * through, so whoever opened it can close it; a refusal or an error stays
 * here, said in place, for the viewer to read and try again.
 */
export function PurgeForm({ label, explains, onPurge, onPurged, className }: PurgeProps & { onPurged?: () => void; className?: string }) {
  const [reason, setReason] = useState("");
  const [said, setSaid] = useState("");
  const [busy, setBusy] = useState(false);
  const purge = () => {
    setBusy(true);
    setSaid("");
    void onPurge(reason)
      .then((done) => {
        if (!done.ok) return setSaid(`Not purged: ${done.because}`);
        setSaid("Purging: the bodies are going now, and the audit line is written.");
        onPurged?.();
      })
      .catch((error: unknown) => setSaid(`Not purged: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => setBusy(false));
  };
  return (
    <div className={cx("grid gap-2 text-sm", className)}>
      <p className="text-muted">{explains}</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Why" className="min-w-0 grow">
          <Control type="text" value={reason} onValueChange={setReason} placeholder="a token leaked into an artifact" />
        </Field>
        <Button variant="danger" disabled={busy || !reason.trim()} onClick={purge}>{label}</Button>
      </div>
      {said ? <p>{said}</p> : null}
    </div>
  );
}
