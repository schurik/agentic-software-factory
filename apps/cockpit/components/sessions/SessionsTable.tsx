import Link from "next/link";
import type { ReactNode } from "react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { repoKey } from "@/convex/forge/forge";
import { isLive, workflowOf } from "@/convex/model/session";
import { formatAgo, formatCost, formatTime, issueNumber, plural, prNumber, sessionHref } from "../format";
import { MiniGraph } from "../graph/StageGraph";
import { ForgeRef } from "../icons";
import { type Progress, titleOf } from "../now/rows";
import { control, cx, Notice, num, PageHeader, pillClass, StatusDot, Table } from "../ui";

/** What the sessions list answers, as much of it as the page draws. */
export type SessionsFound = Pick<NonNullable<FunctionReturnType<typeof api.sessions.list>>, "sessions" | "looked" | "cut" | "factories">;

/** A session as the sessions list returns it. */
export type Listed = SessionsFound["sessions"][number];

/**
 * The Sessions page (#116), as first painted: the factory pills — `factory`
 * is the one the address narrowed it to — and the one search box, over the
 * sessions the query kept. Pure: the list, the clock and what was typed
 * come in; `live` draws where a live session is, with its progress — a query
 * of its own per row.
 */
export function SessionsView({ list, factory, search, onSearch, now, live }: {
  list: SessionsFound;
  factory?: string;
  search: string;
  onSearch: (search: string) => void;
  now: number;
  live: (row: Listed) => ReactNode;
}) {
  return (
    <>
      <PageHeader title="Sessions" />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <FactoryPills factories={list.factories} active={factory} />
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
    <nav aria-label="Factories" className="flex flex-wrap gap-1.5">
      {pills.map((each) => (
        <Link key={each ?? ""} href={each ? `/sessions?factory=${encodeURIComponent(each)}` : "/sessions"}
              aria-current={each === named ? "page" : undefined}
              className={pillClass(each === named)}>
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
    <Table fixed>
      <colgroup>
        <col className="w-9" />
        <col />
        <col className="hidden w-[38%] md:table-column" />
        <col className="w-20" />
        <col className="hidden w-24 sm:table-column" />
      </colgroup>
      <thead>
        <tr>
          <th aria-label="Status" />
          <th>Session</th>
          <th className="hidden md:table-cell">Where</th>
          <th className={num} title="list-price equivalent: what the tokens would cost at the provider's list price, subscription or not">Cost</th>
          <th className={cx(num, "hidden sm:table-cell")}>Started</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => <SessionRow key={`${row.factory}/${row.session}`} row={row} now={now} live={live} />)}
      </tbody>
    </Table>
  );
}

function SessionRow({ row, now, live }: { row: Listed; now: number; live: (row: Listed) => ReactNode }) {
  const { factory, session, summary } = row;
  const [issue, pr] = [issueNumber(summary.issueUrl), prNumber(summary.prUrl)];
  return (
    <tr className="hover:bg-surface-2">
      <td><StatusDot status={summary.status} className="mt-2 ml-0.5" /></td>
      <td>
        <Link href={sessionHref(factory, session)} className="block font-medium text-fg [overflow-wrap:anywhere] hover:text-accent">
          {titleOf(summary.request, Number(issue)) || session}
        </Link>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2.5 text-xs text-muted">
          <span>{factory}</span>
          {/* A session that answers a pull request alone was started from it, not from a prompt. */}
          {issue ? <ForgeRef kind="issue" href={summary.issueUrl}>#{issue}</ForgeRef> : pr ? null : <span>prompt</span>}
          {pr ? <ForgeRef kind="pr" href={summary.prUrl}>#{pr}</ForgeRef> : null}
          <span className="font-mono text-faint">{session}</span>
        </span>
      </td>
      <td className="hidden md:table-cell">
        {isLive(summary) ? live(row) : <Where workflow={workflowOf(summary)} progress={null} />}
      </td>
      <td className={num}>{formatCost(summary.totalCost)}</td>
      <td className={cx(num, "hidden text-muted sm:table-cell")} title={formatTime(summary.startedAt, now)}>
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
