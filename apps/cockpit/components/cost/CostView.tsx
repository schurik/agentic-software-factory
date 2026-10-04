import Link from "next/link";
import type { ReactNode } from "react";
import type { Rollup } from "@/convex/cost";
import type { Spend } from "@/convex/model/spend";
import { factoryHref } from "../factory/view";
import { formatDollars as dollars, formatTokens as tokens, sessionHref } from "../format";
import { Notice, num, Section, Table } from "../ui";
import { useWho } from "../viewer";

const LIST_PRICE = "list-price equivalent: what the tokens would cost at the provider's list price, subscription or not";

/**
 * What was spent in a period, rolled up (spec #40): the Factory page's Cost
 * tab when `factory` names one, the Cost page across every factory the
 * viewer can read when it does not. Every amount is list-price equivalent
 * with its tokens alongside, and no budget is shown: the only one there is
 * is per session, on the session page and the factory's header. Pure.
 */
export function CostView({ rollup, period, factory }: {
  rollup: Rollup;
  /** The period, as words: "this month", "1 Oct 2026 – 14 Oct 2026". */
  period: string;
  factory?: string;
}) {
  const across = factory === undefined;
  const who = useWho();
  if (rollup.cut) return <Notice>More was spent {period} than the cockpit sums at once: pick a shorter period.</Notice>;
  if (!rollup.sessions.length) return <p className="text-muted">Nothing was spent {period}.</p>;
  return (
    <div>
      <p className="mb-6 text-lg">
        <b className="font-semibold">{dollars(rollup.total.cost)}</b> · {tokens(rollup.total.tokens)} {period}{" "}
        <span className="text-sm text-muted" title={LIST_PRICE}>list-price equivalent</span>
      </p>

      {across ? (
        <Breakdown title="By factory" head={["Factory"]} lines={rollup.factories.map((line) => ({
          key: line.factory, spend: line, cells: [<Link key="f" href={factoryHref(line.factory)}>{line.factory}</Link>],
        }))} />
      ) : null}

      <Breakdown title="By workflow" head={[...(across ? ["Factory"] : []), "Workflow"]} lines={rollup.workflows.map((line) => ({
        key: `${line.factory} ${line.workflow}`, spend: line,
        cells: [...(across ? [line.factory] : []), line.workflow || <span className="text-muted">not named</span>],
      }))} />

      <Breakdown title="By station — whose machine and key paid" head={["Station", ...(across ? ["Factory"] : []), "Owner"]}
               lines={rollup.stations.map((line) => ({
                 key: `${line.factory} ${line.station}`, spend: line,
                 cells: [
                   line.name ? <code key="n">{line.name}</code> : <span key="n" className="text-muted">not named</span>,
                   ...(across ? [line.factory] : []),
                   who(line.owner) || <span key="o" className="text-muted">not registered</span>,
                 ],
               }))} />

      <Breakdown title="By person — who triggered the run" head={["Person"]} lines={rollup.people.map((line) => ({
        key: line.person, spend: line,
        cells: [who(line.person) || <span key="p" className="text-muted">not named by the factory</span>],
      }))} />

      <Breakdown title="By session" head={["Session", ...(across ? ["Factory"] : []), "Asked", "Workflows"]}
               lines={rollup.sessions.map((line) => ({
                 key: `${line.factory} ${line.session}`, spend: line,
                 cells: [
                   <Link key="s" href={sessionHref(line.factory, line.session)}><code>{line.session}</code></Link>,
                   ...(across ? [line.factory] : []),
                   line.request || <span key="r" className="text-muted">—</span>,
                   line.workflows.join(" → "),
                 ],
               }))} />
    </div>
  );
}

interface Line {
  key: string;
  spend: Spend;
  cells: ReactNode[];
}

function Breakdown({ title, head, lines }: { title: string; head: string[]; lines: Line[] }) {
  return (
    <Section title={title}>
      <Table>
        <thead>
          <tr>
            {head.map((name) => <th key={name}>{name}</th>)}
            <th className={num} title={LIST_PRICE}>Spend</th>
            <th className={num}>Tokens</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.key}>
              {line.cells.map((cell, at) => <td key={at}>{cell}</td>)}
              <td className={num}>{dollars(line.spend.cost)}</td>
              <td className={num}>{tokens(line.spend.tokens)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Section>
  );
}
