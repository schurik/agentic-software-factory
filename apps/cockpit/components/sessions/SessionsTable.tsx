import Link from "next/link";
import type { ReactNode } from "react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { repoKey } from "@/convex/forge/forge";
import { isLive } from "@/convex/model/session";
import { formatAgo, formatCost, formatTime, issueNumber, plural, prNumber, sessionHref } from "../format";
import { MiniGraph } from "../graph/StageGraph";
import { ForgeRef } from "../icons";
import { type Progress, titleOf } from "../now/rows";
import { control, cx, Notice, PageHeader, StatusDot } from "../ui";

/** What the sessions list answers, as much of it as the page draws. */
export type SessionsPage = Pick<NonNullable<FunctionReturnType<typeof api.sessions.list>>, "sessions" | "looked" | "cut" | "factories">;

/** A session as the sessions list returns it. */
export type Listed = SessionsPage["sessions"][number];

/**
 * The Sessions page (#116), as first painted: the factory pills — `factory`
 * is the one the address narrowed it to — and the one search box, over the
 * sessions the query kept. `tab` draws it as one factory's own Sessions tab,
 * which needs neither the page's title nor its pills. Pure: the list, the
 * clock and what was typed come in; `live` draws where a live session is,
 * with its progress — a query of its own per row.
 */
export function SessionsView({ list, factory, tab = false, search, onSearch, now, live }: {
  list: SessionsPage;
  factory?: string;
  tab?: boolean;
  search: string;
  onSearch: (search: string) => void;
  now: number;
  live: (row: Listed) => ReactNode;
}) {
  return (
    <>
      {tab ? null : <PageHeader title="Sessions" />}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {tab ? null : <FactoryPills factories={list.factories} active={factory} />}
        <input type="search" value={search} onChange={(event) => onSearch(event.target.value)}
               placeholder="Search title, #issue, id…" aria-label="Search sessions"
               className={cx(control, "w-full md:ml-auto md:w-64")} />
      </div>
      {list.looked === 0 ? (
        <Notice>
          No station has shipped a session{factory ? " of this factory" : ""} yet. A station sends its events to{" "}
          <code>POST /ingest</code> on this deployment&apos;s site URL with a factory&apos;s ingest token.
        </Notice>
      ) : (
        <>
          <p className="mb-2 text-sm text-muted">
            {list.sessions.length} of {plural(list.looked, "session")} looked at, most recently active first
            {list.cut ? "; older ones were not looked at, and may match too" : ""}.
          </p>
          {list.sessions.length ? <SessionsTable rows={list.sessions} now={now} live={live} /> : <p className="text-muted">No session matches.</p>}
        </>
      )}
    </>
  );
}

/**
 * One pill per factory the viewer can read, and one for all of them, each
 * at its own address, so a factory's "All sessions" link lands on its own.
 * A factory the address names that the list does not hold keeps its pill,
 * so it can be seen and undone.
 */
function FactoryPills({ factories, active }: { factories: string[]; active?: string }) {
  const named = active ? factories.find((each) => repoKey(each) === repoKey(active)) ?? active : null;
  const pills = [null, ...factories, ...(named && !factories.includes(named) ? [named] : [])];
  return (
    <nav aria-label="Factories" className="flex flex-wrap gap-1.5 text-sm">
      {pills.map((each) => (
        <Link key={each ?? ""} href={each ? `/sessions?factory=${encodeURIComponent(each)}` : "/sessions"}
              aria-current={each === named ? "page" : undefined}
              className={cx("rounded-full border px-2.5 py-0.5 no-underline hover:no-underline",
                            each === named ? "border-fg bg-fg text-bg" : "border-line-strong text-muted hover:text-fg")}>
          {each ?? "all"}
        </Link>
      ))}
    </nav>
  );
}

/**
 * The sessions, five columns: a status dot, the session — its title, and its
 * factory, work item, pull request and id under it — where it is, what it
 * cost and when it started. Where folds away below md and Started below sm,
 * and the table is laid out to the page's width, so a phone never scrolls it.
 */
export function SessionsTable({ rows, now, live }: { rows: Listed[]; now: number; live: (row: Listed) => ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
      <table className="w-full table-fixed border-collapse text-left">
        <colgroup>
          <col className="w-9" />
          <col />
          <col className="hidden w-[38%] md:table-column" />
          <col className="w-20" />
          <col className="hidden w-24 sm:table-column" />
        </colgroup>
        <thead className="border-b border-line text-xs text-muted">
          <tr>
            <th className="py-2" aria-label="Status" />
            <th className="py-2 pr-3 font-medium">Session</th>
            <th className="hidden py-2 pr-3 font-medium md:table-cell">Where</th>
            <th className="py-2 pr-3 text-right font-medium"
                title="list-price equivalent: what the tokens would cost at the provider's list price, subscription or not">Cost</th>
            <th className="hidden py-2 pr-4 text-right font-medium sm:table-cell">Started</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row) => <SessionRow key={`${row.factory}/${row.session}`} row={row} now={now} live={live} />)}
        </tbody>
      </table>
    </div>
  );
}

function SessionRow({ row, now, live }: { row: Listed; now: number; live: (row: Listed) => ReactNode }) {
  const { factory, session, summary } = row;
  const [issue, pr] = [issueNumber(summary.issueUrl), prNumber(summary.prUrl)];
  const workflow = summary.workflow || (summary.workflows.at(-1) ?? "");
  return (
    <tr className="hover:bg-surface-2">
      <td className="py-2.5 pl-3.5 align-top"><StatusDot status={summary.status} className="mt-2" /></td>
      <td className="py-2.5 pr-3 align-top">
        <Link href={sessionHref(factory, session)} className="block font-medium text-fg [overflow-wrap:anywhere] hover:text-accent">
          {titleOf(summary.request, Number(issue)) || session}
        </Link>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2.5 text-xs text-muted">
          <span>{factory}</span>
          {issue ? <ForgeRef kind="issue" href={summary.issueUrl}>#{issue}</ForgeRef> : pr ? null : <span>prompt</span>}
          {pr ? <ForgeRef kind="pr" href={summary.prUrl}>#{pr}</ForgeRef> : null}
          <span className="font-mono text-faint">{session}</span>
        </span>
      </td>
      <td className="hidden py-2.5 pr-3 align-top md:table-cell">
        {isLive(summary) ? live(row) : <Where workflow={workflow} progress={null} />}
      </td>
      <td className="py-2.5 pr-3 text-right align-top tabular-nums whitespace-nowrap">{formatCost(summary.totalCost)}</td>
      <td className="hidden py-2.5 pr-4 text-right align-top whitespace-nowrap text-muted tabular-nums sm:table-cell"
          title={formatTime(summary.startedAt, now)}>
        {formatAgo(summary.startedAt, now)}
      </td>
    </tr>
  );
}

/**
 * Where a session is: a live one's mini graph, once its progress answers;
 * until then, and for one that has finished, its workflow's name.
 */
export function Where({ workflow, progress }: { workflow: string; progress: Progress | null | undefined }) {
  return progress ? <MiniGraph mini={progress.mini} /> : <span className="text-muted">{workflow || "—"}</span>;
}
