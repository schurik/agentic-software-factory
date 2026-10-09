import type { ReactNode } from "react";
import type { Day, Ended } from "@/convex/model/overview";
import type { Overview } from "@/convex/overview";
import { formatAgoAt as ago, formatDollars as dollars, formatDuration, formatTokens as tokens } from "../format";
import { Card, cx, Loading, Notice, num, Section, Table } from "../ui";
import { useWho } from "../viewer";

/** The periods an Overview is over: the last 7 or 30 of the viewer's days. */
export const OVERVIEW_DAYS = { 7: "Last 7 days", 30: "Last 30 days" } as const;
export type OverviewDays = keyof typeof OVERVIEW_DAYS;

const LIST_PRICE = "list-price equivalent: what the tokens would cost at the provider's list price, subscription or not";

/**
 * A factory's Overview (#119): only what no other page shows — what the
 * factory spent, how its sessions ended and how long its gates waited, and
 * the same by workflow — over the last 7 or 30 days, with one filter row
 * above everything it filters. What is happening now is Now's, and any one
 * session is Sessions'. Pure: `overview` is the query's answer, undefined
 * while it is asked and null for a factory the viewer may not read.
 */
export function OverviewTab({ overview, days, midnights, now, timeZone, onDays }: {
  overview: Overview | null | undefined;
  days: OverviewDays;
  /** The midnights that start each day of the period, and the one after its last (`lastDays`). */
  midnights: number[];
  now: number;
  timeZone: string;
  onDays: (days: OverviewDays) => void;
}) {
  const day = dayIn(timeZone);
  const period = OVERVIEW_DAYS[days].toLowerCase();
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <PeriodFilter days={days} midnights={midnights} timeZone={timeZone} onDays={onDays} />
      </div>
      {overview === undefined ? <Loading />
        : overview === null ? <Notice>This is not a factory you can read.</Notice>
        : overview.cut ? <Notice>More happened in the {period} than the cockpit sums at once: pick a shorter period.</Notice>
        : <Figures overview={overview} period={period} days={days} now={now} day={day} />}
    </div>
  );
}

/**
 * The period a tab is over, as one filter row ends: the days it spans, then
 * the choice of the last 7 or 30. The Overview's, and the Measure tab's.
 */
export function PeriodFilter({ days, midnights, timeZone, onDays }: {
  days: OverviewDays;
  midnights: number[];
  timeZone: string;
  onDays: (days: OverviewDays) => void;
}) {
  const day = dayIn(timeZone);
  return (
    <>
      <span className="text-sm text-muted tabular-nums">{day(midnights[0])} – {day(midnights.at(-2) ?? midnights[0])}</span>
      <span className="grow" />
      <div role="radiogroup" aria-label="Period" className="flex rounded-md border border-line p-0.5 text-xs">
        {(Object.keys(OVERVIEW_DAYS).map(Number) as OverviewDays[]).map((each) => (
          <button key={each} type="button" role="radio" aria-checked={days === each} onClick={() => onDays(each)}
                  className={cx("h-6 cursor-pointer rounded px-2", days === each ? "bg-surface-3 text-fg" : "text-muted hover:text-fg")}>
            {OVERVIEW_DAYS[each]}
          </button>
        ))}
      </div>
    </>
  );
}

function Figures({ overview: { spend, outcomes, workflows }, period, days, now, day }: {
  overview: Overview; period: string; days: number; now: number; day: (at: number) => string;
}) {
  const who = useWho();
  const finished = outcomes.done + outcomes.failed;
  const { gates } = outcomes;
  return (
    <>
      <Section title="Spend">
        <Card className="p-5">
          {spend.sessions === 0 ? <p className="text-muted">Nothing was spent in the {period}.</p> : (
            <>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-3xl font-semibold tracking-tight tabular-nums">{dollars(spend.total.cost)}</span>
                <span className="text-sm text-muted tabular-nums">
                  {tokens(spend.total.tokens)} · <span title={LIST_PRICE}>list-price equivalent</span>
                </span>
                <span className="grow" />
                <span className="text-sm text-muted tabular-nums">
                  {dollars(spend.total.cost / days)} a day · {dollars(spend.total.cost / spend.sessions)} a session
                </span>
              </div>
              <SpendChart days={spend.days} day={day} />
              <div className="mt-6 grid gap-6 md:grid-cols-2">
                <Breakdown title="By station — whose key paid" total={spend.total.cost} lines={spend.stations.map((line) => ({
                  key: line.station, cost: line.cost,
                  label: <><span className="font-mono text-[13px]">{line.name || "not named"}</span>{line.owner ? <span className="text-muted"> {who(line.owner)}</span> : null}</>,
                }))} />
                <Breakdown title="By person — who started it" total={spend.total.cost} lines={spend.people.map((line) => ({
                  key: line.person, cost: line.cost,
                  label: line.person ? who(line.person) : <span className="text-muted">not named by the factory</span>,
                }))} />
              </div>
            </>
          )}
        </Card>
      </Section>

      <Section title="Outcomes">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Sessions" value={outcomes.sessions} sub={<Finished ended={outcomes} always />} />
          <Stat label="Finished well" value={finished ? `${Math.round((outcomes.done / finished) * 100)}%` : "—"} sub="of the sessions that finished" />
          <Stat label="Time to finish" value={outcomes.finish === null ? "—" : formatDuration(outcomes.finish)} sub="median, start to finish" />
          <Stat label="Wait at gates" value={gates.wait === null ? "—" : formatDuration(gates.wait)}
                sub={gates.rounds ? `median · ${gates.rounds} ${gates.rounds === 1 ? "round" : "rounds"}, ${gates.rejected} rejected` : "no gate asked a person"} />
        </div>
      </Section>

      <Section title="By workflow">
        {!workflows.length ? <p className="text-muted">No session ran in the {period}.</p> : (
          <Table>
            <thead>
              <tr>
                <th>Workflow</th><th className={num}>Sessions</th><th>Finished</th><th className={num}>Median time</th>
                <th className="w-44" title={LIST_PRICE}>Spend</th><th className={num}>Last run</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map((line) => (
                <tr key={line.workflow}>
                  <td className="font-medium whitespace-nowrap">{line.workflow}</td>
                  <td className={num}>{line.sessions}</td>
                  <td className="whitespace-nowrap tabular-nums"><Finished ended={line} /></td>
                  <td className={num}>{line.finish === null ? "—" : formatDuration(line.finish)}</td>
                  <td>
                    <span className="flex items-center gap-2">
                      <Bar share={line.cost / Math.max(...workflows.map((each) => each.cost))} />
                      <span className="w-14 text-right tabular-nums">{dollars(line.cost)}</span>
                    </span>
                  </td>
                  <td className={cx(num, "text-muted")}>{line.last === null ? "—" : ago(line.last, now)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>
    </>
  );
}

/** "1 done · 1 failed · 1 open": what is there to say, the failures in red; `always` says the zeros too. */
function Finished({ ended, always = false }: { ended: Ended; always?: boolean }) {
  const parts: ReactNode[] = [];
  if (always || ended.done) parts.push(`${ended.done} done`);
  if (always || ended.failed) parts.push(<span key="f" className={ended.failed ? "text-bad" : undefined}>{ended.failed} failed</span>);
  if (always || ended.open) parts.push(<span key="o" className={always ? undefined : "text-muted"}>{ended.open} open</span>);
  if (!parts.length) return <>—</>;
  return <>{parts.map((part, index) => <span key={index}>{index ? " · " : ""}{part}</span>)}</>;
}

/** One figure on a card: what it is, the figure, and a line saying what it is of. */
export function Stat({ label, value, sub, title }: { label: string; value: ReactNode; sub: ReactNode; title?: string }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs text-muted" title={title}>{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-muted">{sub}</div>
    </Card>
  );
}

function Bar({ share }: { share: number }) {
  return (
    <span className="block h-1.5 grow overflow-hidden rounded-full bg-accent-soft">
      <span className="block h-full rounded-full bg-accent" style={{ width: `${Number.isFinite(share) ? share * 100 : 0}%` }} />
    </span>
  );
}

interface Line {
  key: string;
  label: ReactNode;
  cost: number;
}

function Breakdown({ title, lines, total }: { title: string; lines: Line[]; total: number }) {
  return (
    <div>
      <div className="mb-2 text-xs font-medium text-muted">{title}</div>
      <div className="flex flex-col gap-2">
        {lines.map((line) => (
          <div key={line.key} className="text-sm">
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 grow truncate">{line.label}</span>
              <span className="tabular-nums">{dollars(line.cost)}</span>
            </div>
            <div className="mt-1 flex"><Bar share={total ? line.cost / total : 0} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The step a spend axis is marked at: 1, 2, 2.5 or 5 of a power of ten, so that four steps or fewer reach `max`. */
export function stepOf(max: number): number {
  const scale = 10 ** Math.floor(Math.log10(max / 4));
  return [1, 2, 2.5, 5, 10].map((each) => each * scale).find((step) => max / step <= 4) ?? 10 * scale;
}

/**
 * Spend per day: one series, so no legend — the section names it. Columns
 * capped at 24px, round at the top; hairlines at clean amounts; each day's
 * whole column its tooltip's target, on hover and on focus.
 */
function SpendChart({ days, day }: { days: Day[]; day: (at: number) => string }) {
  const max = Math.max(...days.map((each) => each.cost), 0.01);
  const step = stepOf(max);
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, index) => index * step);
  const height = (cost: number) => `${(cost / top) * 100}%`;
  return (
    <div className="mt-8">
      <div className="flex gap-2">
        <div aria-hidden="true" className="relative h-36 w-12 shrink-0 text-right text-[11px] text-muted tabular-nums">
          {ticks.map((tick) => <span key={tick} className="absolute right-0 translate-y-1/2" style={{ bottom: height(tick) }}>{dollars(tick)}</span>)}
        </div>
        <div className="relative h-36 grow">
          {ticks.map((tick) => <span key={tick} aria-hidden="true" className="absolute inset-x-0 h-px bg-line" style={{ bottom: height(tick) }} />)}
          <div role="img" aria-label={`Spend per day, ${days.length} days`} className="absolute inset-0 flex items-end gap-0.5">
            {days.map((each) => (
              <div key={each.from} data-day={each.from} tabIndex={0} aria-label={`${day(each.from)}: ${dollars(each.cost)}`}
                   className="group relative flex h-full min-w-0 flex-1 items-end justify-center outline-none">
                <span className="block w-full max-w-6 rounded-t-[4px] bg-accent group-hover:bg-accent-strong"
                      style={{ height: each.cost ? `max(2px, ${height(each.cost)})` : 0 }} />
                <span className="pointer-events-none absolute z-10 mb-1 hidden rounded-md border border-line bg-surface px-2 py-1 text-xs whitespace-nowrap shadow-pop group-hover:block group-focus-visible:block"
                      style={{ bottom: height(each.cost) }}>
                  <span className="text-muted">{day(each.from)}</span> <b className="font-semibold tabular-nums">{dollars(each.cost)}</b>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div aria-hidden="true" className="mt-1.5 ml-14 flex justify-between text-[11px] text-muted">
        <span>{day(days[0]?.from ?? 0)}</span>
        <span>{day(days[Math.floor(days.length / 2)]?.from ?? 0)}</span>
        <span>{day(days.at(-1)?.from ?? 0)}</span>
      </div>
    </div>
  );
}

/** "Oct 4": the day a midnight starts, in the viewer's timezone. */
function dayIn(timeZone: string): (at: number) => string {
  const format = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone });
  return (at) => format.format(new Date(at));
}
