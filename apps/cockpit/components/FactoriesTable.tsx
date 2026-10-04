import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import type { FactoryRow } from "@/convex/factories";
import type { Attention } from "@/convex/model/attention";
import type { Ranked } from "@/convex/model/factories";
import { factoryHref } from "./factory/view";
import { formatAgoAt, formatCost, formatSpan, formatTokens, plural } from "./format";
import { TriggerButton } from "./trigger/Trigger";
import { num, Table, Tag } from "./ui";

/**
 * The Factories list's rows (spec #40), in the order `rank` put them: each
 * factory's live sessions, gates waiting on the viewer of all that wait, its
 * stations online of all, what it spent in `period`, and a flag for each
 * reason it needs attention. Pure: `rows` were ranked at `now`.
 */
export function FactoriesTable({ rows, now, host, period, triggering, onTrigger, form }: {
  rows: Ranked<FactoryRow>[];
  now: number;
  /** The forge's host, e.g. github.com. */
  host: string;
  /** The period spend is summed over, as words: "this month". */
  period: string;
  /** The factory whose trigger form is open, and how to open or close one. */
  triggering: string | null;
  onTrigger: (repo: string) => void;
  /** The open trigger form, shown under its factory's row. */
  form?: ReactNode;
}) {
  return (
    <Table>
      <thead>
        <tr>
          <th>Factory</th>
          <th className={num}>Live</th>
          <th>Gates waiting</th>
          <th>Stations</th>
          <th className={num} title="list-price equivalent: what the tokens would cost at the provider's list price, subscription or not">
            Spend {period}
          </th>
          <th>Needs attention</th>
          <th>Last activity</th>
          <th>Trigger</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ row, attention, online }) => (
          <Fragment key={row.repo}>
            <tr>
              <td>
                <span className="flex flex-wrap items-center gap-1.5">
                  <Link href={factoryHref(row.repo)} className="font-medium">{row.repo}</Link>
                  {row.onForge ? <a className="text-sm text-muted" href={`https://${host}/${row.repo}`}>on {host}</a> : null}
                  {row.private ? <Tag>private</Tag> : null}
                  {!row.onForge ? <Tag tone="wait">not found on the forge</Tag> : null}
                </span>
              </td>
              <td className={num}>{row.live ? `${row.live} live` : "—"}</td>
              <td className="whitespace-nowrap">
                {row.facts.gates.total === 0 ? "—" : (
                  <>{row.facts.gates.mine ? <Tag tone="mine">{row.facts.gates.mine} on you</Tag> : <>0 on you</>} / {row.facts.gates.total}</>
                )}
              </td>
              <td className="whitespace-nowrap">
                {row.seen.length ? `${online} / ${row.seen.length} online`
                  : row.reporting ? "—" : <Tag tone="wait">no station yet</Tag>}
              </td>
              <td className={num}>
                {row.spend === null ? "—" : (
                  <>{formatCost(row.spend.cost)} <span className="text-sm text-muted">{formatTokens(row.spend.tokens)}</span></>
                )}
              </td>
              <td>
                <span className="flex flex-wrap gap-1.5">{attention.map((item, at) => (
                  <Flag key={`${item.kind}-${at}`} item={item} />
                ))}</span>
              </td>
              <td className="whitespace-nowrap">{row.lastActivity === null ? "—" : formatAgoAt(row.lastActivity, now)}</td>
              <td>
                {row.onForge ? (
                  <TriggerButton role={row.role} open={triggering === row.repo} onToggle={() => onTrigger(row.repo)} />
                ) : "—"}
              </td>
            </tr>
            {triggering === row.repo && form ? <tr><td colSpan={8}>{form}</td></tr> : null}
          </Fragment>
        ))}
      </tbody>
    </Table>
  );
}

/** Why a factory needs attention, in a word or two; its Factory page's Activity says the rest. Gates have their own column. */
function Flag({ item }: { item: Attention }) {
  switch (item.kind) {
    case "gates":
      return null;                      // its own column
    case "failed":
      return <Tag tone="bad">{item.sessions.length} failed in 24h</Tag>;
    case "claim":
      // Never "orphaned": a laptop shut over a weekend is not dead.
      return (
        <Tag tone="wait" title={`a writer can release it on the Factory page, which ${item.claim.consequence}`}>
          #{item.claim.number} held by {item.claim.stationName}, offline {formatSpan(item.away)}
        </Tag>
      );
    case "drift":
      return (
        <Tag tone="wait" title={item.stations.map((station) => station.name).join(", ")}>
          {plural(item.stations.length, "station")} drifted
        </Tag>
      );
    case "check":
      return <Tag tone="bad">check failing</Tag>;
    case "unwatched":
      return (
        <Tag tone="wait" title={`${item.issues.map((number) => `#${number}`).join(", ")} queued, and no issues watcher online`}>
          nobody watching
        </Tag>
      );
  }
}
