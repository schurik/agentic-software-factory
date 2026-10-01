import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import type { FactoryRow } from "@/convex/factories";
import type { Attention } from "@/convex/model/attention";
import type { Ranked } from "@/convex/model/factories";
import { factoryHref } from "./factory/view";
import { formatAgoAt, formatCost, formatSpan, plural } from "./format";
import { TriggerButton } from "./trigger/Trigger";

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
    <table className="table">
      <thead>
        <tr>
          <th>Factory</th>
          <th className="num">Live</th>
          <th>Gates waiting</th>
          <th>Stations</th>
          <th className="num" title="list-price equivalent: what the tokens would cost at the provider's list price, subscription or not">
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
                <Link href={factoryHref(row.repo)}>{row.repo}</Link>
                {row.onForge ? <> <a className="small muted" href={`https://${host}/${row.repo}`}>on {host}</a></> : null}
                {row.private ? <> <span className="tag">private</span></> : null}
                {!row.onForge ? <> <span className="tag tag-wait">not found on the forge</span></> : null}
              </td>
              <td className="num">{row.live ? `${row.live} live` : "—"}</td>
              <td>
                {row.facts.gates.total === 0 ? "—" : (
                  <><span className={row.facts.gates.mine ? "tag tag-mine" : undefined}>{row.facts.gates.mine} on you</span> / {row.facts.gates.total}</>
                )}
              </td>
              <td>
                {row.seen.length ? `${online} / ${row.seen.length} online`
                  : row.reporting ? "—" : <span className="tag tag-wait">no station yet</span>}
              </td>
              <td className="num">
                {row.spend === null ? "—" : (
                  <>{formatCost(row.spend.cost)} <span className="muted small">{row.spend.tokens.toLocaleString("en-US")} tokens</span></>
                )}
              </td>
              <td>
                <span className="flags">{attention.filter((item) => item.kind !== "gates").map((item, at) => (
                  <Flag key={`${item.kind}-${at}`} item={item} />
                ))}</span>
              </td>
              <td>{row.lastActivity === null ? "—" : formatAgoAt(row.lastActivity, now)}</td>
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
    </table>
  );
}

/** Why a factory needs attention, in a word or two; its Factory page's Activity says the rest. Gates have their own column. */
function Flag({ item }: { item: Attention }) {
  switch (item.kind) {
    case "gates":
      return null;
    case "failed":
      return <span className="tag tag-bad">{item.sessions.length} failed in 24 h</span>;
    case "claim":
      // Never "orphaned": a laptop shut over a weekend is not dead.
      return (
        <span className="tag tag-wait" title={`a writer can release it on the Factory page, which ${item.claim.consequence}`}>
          #{item.claim.number} held by {item.claim.stationName}, offline {formatSpan(item.away)}
        </span>
      );
    case "drift":
      return (
        <span className="tag tag-wait" title={item.stations.map((station) => station.name).join(", ")}>
          {plural(item.stations.length, "station")} drifted
        </span>
      );
    case "check":
      return <span className="tag tag-bad">check failing</span>;
    case "unwatched":
      return (
        <span className="tag tag-wait" title={`${item.issues.map((number) => `#${number}`).join(", ")} queued, and no issues watcher online`}>
          nobody watching
        </span>
      );
  }
}
