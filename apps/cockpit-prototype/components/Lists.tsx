"use client";
// PROTOTYPE, throwaway. Sessions and Factories only so far as navigation needs them —
// the prototype's questions are about Now and the session page.
import { useSearchParams } from "next/navigation";
import { FACTORIES, HISTORY, NOW, SESSIONS } from "@/lib/data";
import { cost, fmtAgo, fmtCost, sessionPhases } from "@/lib/model";
import { MiniGraph } from "./Graph";
import { PLink } from "./state";
import { Card, Pill, cx } from "./ui";

export function SessionsList() {
  const factory = useSearchParams().get("factory");
  const rows = [
    ...SESSIONS.map((s) => ({ id: s.id, factory: s.factory, title: s.title, ref: s.ref, workflow: s.chapters.at(-1)!.workflow, status: s.status, cost: cost(sessionPhases(s)), at: s.startedAt, live: s })),
    ...HISTORY.map((h) => ({ ...h, live: undefined })),
  ].filter((r) => !factory || r.factory === factory);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
        <div className="flex flex-wrap gap-1.5 text-sm">
          {[null, ...FACTORIES.map((f) => f.name)].map((f) => (
            <PLink key={f ?? "all"} href={f ? `/sessions?factory=${f}` : "/sessions"} className={cx("rounded-full border px-2.5 py-0.5", factory === f ? "border-fg bg-fg text-bg" : "border-line text-muted hover:text-fg")}>{f ?? "all"}</PLink>
          ))}
        </div>
        <input placeholder="Search title, #issue, id…" className="ml-auto h-8 w-full rounded-md border border-line-strong bg-surface px-3 text-sm outline-none focus:border-accent md:w-64" />
      </div>
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-line text-left text-xs text-muted">
            <tr><th className="px-4 py-2 font-medium">Session</th><th className="hidden px-2 py-2 font-medium md:table-cell">Where</th><th className="px-2 py-2 font-medium">Status</th><th className="px-2 py-2 text-right font-medium">Cost</th><th className="hidden px-4 py-2 text-right font-medium sm:table-cell">Started</th></tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-surface-2">
                <td className="max-w-0 px-4 py-2">
                  <PLink href={r.live ? `/sessions/${r.id}` : "#"} className="block truncate font-medium hover:text-accent">{r.title}</PLink>
                  <span className="block truncate text-xs text-muted">{r.factory} · {r.ref} · <span className="font-mono">{r.id}</span></span>
                </td>
                <td className="hidden px-2 py-2 md:table-cell">{r.live && r.status !== "done" ? <MiniGraph chapter={r.live.chapters.at(-1)!} /> : <span className="text-muted">{r.workflow}</span>}</td>
                <td className="px-2 py-2"><Pill status={r.status} /></td>
                <td className="px-2 py-2 text-right tabular-nums">{fmtCost(r.cost)}</td>
                <td className="hidden px-4 py-2 text-right text-muted tabular-nums sm:table-cell">{fmtAgo(NOW - r.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function FactoriesList() {
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-2xl font-semibold tracking-tight">Factories</h1>
      <p className="text-muted">Not prototyped: a factory page would be Overview · Workflows (drawn with the same stage graph) · Stations · Config.</p>
      <div className="grid gap-3 md:grid-cols-3">
        {FACTORIES.map((f) => (
          <Card key={f.name} className="p-4">
            <div className="font-semibold">{f.name}</div>
            <div className="mt-2 flex gap-4 text-sm text-muted tabular-nums">
              <span>{f.online}/{f.stations} stations online</span><span>{f.running} running</span>
            </div>
            {f.attention ? <div className="mt-2 text-sm text-wait">{f.attention} need attention</div> : null}
            <PLink href={`/sessions?factory=${f.name}`} className="mt-3 block text-sm text-accent hover:underline">Sessions →</PLink>
          </Card>
        ))}
      </div>
    </div>
  );
}
