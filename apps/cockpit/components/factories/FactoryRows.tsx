import type { ReactNode } from "react";
import type { FactoryRow } from "@/convex/factories";
import type { Ranked } from "@/convex/model/factories";
import { factoryHref } from "../factory/view";
import { formatAgoAt, formatDollars, plural } from "../format";
import { StatusIcon } from "../icons";
import { Row, Rows } from "../now/rows";
import { Tag } from "../ui";

/**
 * The Factories list's rows (#117), drawn with Now's, in the order `rank` put
 * them: each factory's name, what needs the viewer there and what is moving,
 * and on the right what it spent this month and when it last moved. A row
 * opens its factory, whose page says the rest. Pure: `rows` were ranked at `now`.
 */
export function FactoryRows({ rows, now }: { rows: Ranked<FactoryRow>[]; now: number }) {
  return (
    <Rows label="Factories">
      {rows.map(({ row, attention, online }) => {
        const failing = attention.some((item) => item.kind === "check" || item.kind === "failed");
        return (
          <li key={row.repo}>
            <Row href={factoryHref(row.repo)}
                 glyph={<StatusIcon status={failing ? "failed" : attention.length ? "waiting" : "done"} size={16} className="mt-1 ml-1" />}
                 title={<>
                   <span className="truncate">{row.repo}</span>
                   {row.private ? <Tag>private</Tag> : null}
                   {!row.onForge ? <Tag tone="wait">not found on the forge</Tag> : null}
                 </>}
                 lines={[needs(row, attention.length), moving(row, online)]}
                 where={row.spend === null ? "" : (
                   <span title="list-price equivalent: what the tokens would cost at the provider's list price, subscription or not">
                     {formatDollars(row.spend.cost)} this month
                   </span>
                 )}
                 when={<span className="text-faint">{row.lastActivity === null ? "never active" : `active ${formatAgoAt(row.lastActivity, now)}`}</span>} />
          </li>
        );
      })}
    </Rows>
  );
}

/**
 * What needs the viewer there: the gates waiting on them, a failing check,
 * and how many other things need attention — which, its page and Now say.
 */
function needs(row: FactoryRow, attending: number): ReactNode {
  const { gates, check } = row.facts;
  const more = attending - Number(gates.mine > 0) - Number(check === "failing");
  const said = [
    gates.mine ? <span key="gates" className="text-wait">{plural(gates.mine, "gate")} on you</span> : null,
    check === "failing" ? <span key="check" className="text-bad">check failing</span> : null,
    more ? <span key="more" className="text-wait">{more} more {more === 1 ? "needs" : "need"} attention</span> : null,
  ].filter((part) => part !== null);
  if (!said.length) return "Nothing needs attention";
  return <>{said.flatMap((part, at) => (at ? [" · ", part] : [part]))}</>;
}

/** What is moving there: its sessions running, its stations online of all, the workflows it loads. */
function moving(row: FactoryRow, online: number): string {
  return [
    `${row.live} running`,
    row.seen.length ? `${online}/${row.seen.length} stations online` : row.reporting ? "0 stations online" : "no station yet",
    ...(row.workflows === null ? [] : [plural(row.workflows, "workflow")]),
  ].join(" · ");
}
