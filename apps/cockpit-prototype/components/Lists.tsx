"use client";
// PROTOTYPE, throwaway. Sessions and Factories only so far as navigation needs them —
// the prototype's questions are about Now and the session page.
import { Tooltip } from "@base-ui/react/tooltip";
import { useSearchParams } from "next/navigation";
import { FACTORIES, HISTORY, NOW, SESSIONS, type SessionStatus } from "@/lib/data";
import { cost, fmtAgo, fmtCost, sessionPhases } from "@/lib/model";
import { MiniGraph } from "./Graph";
import { PLink } from "./state";
import { Card, cx } from "./ui";

const dotTone: Record<SessionStatus, string> = { done: "bg-ok", running: "bg-accent", waiting: "bg-wait", failed: "bg-bad" };

/** A session's status as a dot; the word only on hover. */
function StatusDot({ status }: { status: SessionStatus }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={<span />} className="grid size-5 place-items-center" aria-label={status}>
        <span className={cx("size-2 rounded-full", dotTone[status], status === "running" && "pulse")} />
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side="right" sideOffset={6}>
          <Tooltip.Popup className="rounded-md bg-fg px-2 py-1 text-xs font-medium text-bg shadow-pop transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0">
            {status}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

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
        <Tooltip.Provider delay={150}>
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col className="w-10" />
              <col />
              <col className="hidden w-[38%] md:table-column" />
              <col className="w-16" />
              <col className="hidden w-20 sm:table-column" />
            </colgroup>
            <thead className="border-b border-line text-left text-xs text-muted">
              <tr>
                <th className="py-2" aria-label="Status" />
                <th className="py-2 pr-3 font-medium">Session</th>
                <th className="hidden py-2 pr-3 font-medium md:table-cell">Where</th>
                <th className="py-2 pr-2 text-right font-medium">Cost</th>
                <th className="hidden py-2 pr-4 text-right font-medium sm:table-cell">Started</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-surface-2">
                  <td className="py-2.5 pl-3 align-top"><StatusDot status={r.status} /></td>
                  <td className="py-2.5 pr-3 align-top">
                    <PLink href={r.live ? `/sessions/${r.id}` : "#"} className="block font-medium hover:text-accent">{r.title}</PLink>
                    <span className="block text-xs text-muted">{r.factory} · {r.ref} · <span className="font-mono">{r.id}</span></span>
                  </td>
                  <td className="hidden py-2.5 pr-3 align-top md:table-cell">
                    {r.live && r.status !== "done" ? <MiniGraph chapter={r.live.chapters.at(-1)!} /> : <span className="text-muted">{r.workflow}</span>}
                  </td>
                  <td className="py-2.5 pr-2 text-right align-top tabular-nums">{fmtCost(r.cost)}</td>
                  <td className="hidden py-2.5 pr-4 text-right align-top text-muted tabular-nums sm:table-cell">{fmtAgo(NOW - r.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Tooltip.Provider>
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
