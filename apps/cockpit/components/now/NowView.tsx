import Link from "next/link";
import type { ReactNode } from "react";
import type { NowPage, Running } from "@/convex/now";
import { onlyOf } from "../inbox/waits";
import { type Go, Kbd, PageHeader } from "../ui";
import { AttentionRows, Empty, FoldSection, InboxRows, neededAt, OtherRows, Rows } from "./rows";

/**
 * Now (#115), as first painted: the Inbox of gates waiting on the viewer —
 * never folded — then what needs attention across their factories, what is
 * running, and, folded, what waits on someone else. Pure: the page, the clock
 * and where the keys are come in, so a test renders it as a browser first
 * paints it. `factory` narrows every section to that factory's, as its
 * Factory page links here; `runningRow` draws a running session, with its
 * progress — a query of its own per row.
 */
export function NowView({ page, now, factory, selected, openGate, runningRow }: {
  page: NowPage;
  now: number;
  factory?: string;
  selected: string | null;
  openGate: (key: string) => Go;
  runningRow: (row: Running) => ReactNode;
}) {
  const inbox = onlyOf(page.inbox, factory);
  const needed = neededAt(onlyOf(page.attention, factory), now);
  const running = onlyOf(page.running, factory);
  const others = onlyOf(page.others, factory);
  return (
    <div>
      <PageHeader title="Now" sub={factory ? <>Only {factory}. <Link href="/">Every factory</Link></> : undefined} />
      <section>
        <div className="mb-3 flex items-baseline gap-2">
          <h2>Inbox</h2>
          <span className="text-sm text-faint tabular-nums">{inbox.length}</span>
          <span className="grow" />
          {inbox.length ? (
            <span className="hidden items-center gap-1 text-xs text-faint md:flex pointer-coarse:hidden">
              <Kbd>j</Kbd><Kbd>k</Kbd> move · <Kbd>↵</Kbd> open · <Kbd>a</Kbd> approve · <Kbd>r</Kbd> reject
            </span>
          ) : null}
        </div>
        {inbox.length ? <InboxRows rows={inbox} selected={selected} now={now} open={openGate} />
          : <Empty>Nothing is waiting on you.</Empty>}
      </section>
      <FoldSection title="Needs attention" count={needed.length} open>
        {needed.length ? <AttentionRows rows={needed} /> : <Empty>Nothing needs attention.</Empty>}
      </FoldSection>
      <FoldSection title="Running" count={running.length} open>
        {running.length ? (
          <Rows label="Running">
            {running.map((row) => (
              <li key={`${row.factory}/${row.session}`}>
                {runningRow(row)}
              </li>
            ))}
          </Rows>
        ) : <Empty>Nothing is running.</Empty>}
      </FoldSection>
      <FoldSection title="Waiting on others" count={others.length} open={false}>
        {others.length ? <OtherRows rows={others} now={now} open={openGate} /> : <Empty>Nothing is waiting on anyone else.</Empty>}
      </FoldSection>
    </div>
  );
}
