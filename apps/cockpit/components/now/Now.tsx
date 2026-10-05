"use client";

import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Row } from "@/convex/model/inbox";
import type { Running } from "@/convex/now";
import { useClock } from "../clock";
import { Drawer } from "../Drawer";
import { LiveGate } from "../gate/GateDrawer";
import { verbsOf } from "../gate/answer";
import type { Step } from "../gate/GateView";
import { keyOf, onlyOf, splitKey } from "../inbox/waits";
import { keyed } from "../inbox/keys";
import { useSignIn } from "../signIn";
import { type Go, Loading, Notice } from "../ui";
import { NowView } from "./NowView";
import { RunningRow } from "./rows";

/** What Now's address says: the factory it is narrowed to, the gate open in the drawer, and that drawer's tab. */
export interface NowAddress {
  factory?: string;
  open?: string;
  tab?: string;
}

/** Now's address for `to`: "/" when it says nothing. */
export function nowAddress(to: NowAddress): string {
  const search = new URLSearchParams();
  if (to.factory) search.set("factory", to.factory);
  if (to.open) search.set("open", to.open);
  if (to.open && to.tab) search.set("tab", to.tab);
  const query = search.toString();
  return query ? `/?${query}` : "/";
}

/**
 * Where a wait sits among the ones that can still be answered — the open one
 * counted, answerable or not — for the drawer's "n of m" and its arrows.
 */
export function stepOf(rows: Row[], open: string, go: (key: string) => Go): Step | null {
  const queue = rows.filter((row) => row.blocked === null || keyOf(row) === open);
  const at = queue.findIndex((row) => keyOf(row) === open);
  if (at < 0) return null;
  return {
    at: at + 1, of: queue.length,
    previous: at > 0 ? go(keyOf(queue[at - 1])) : null,
    next: at < queue.length - 1 ? go(keyOf(queue[at + 1])) : null,
  };
}

/** Which gate the drawer over Now holds. */
export interface NowTarget {
  factory: string;
  session: string;
  tab: string | null;
}

/** What the drawer over Now holds for the address: the gate `open` names, on `tab` — or nothing. Pure: a test renders it as is. */
export function NowDrawerView({ open, tab, gate }: { open: string | undefined; tab: string | undefined; gate: (target: NowTarget) => ReactNode }) {
  return open ? gate({ ...splitKey(open), tab: tab ?? null }) : null;
}

/**
 * The home page (#115): the gates waiting on the viewer, what needs their
 * attention, what runs and what waits on someone else, across every factory
 * they can read. A gate opens in the drawer over the page, and the address
 * says which, so a link — from an issue comment, the session page — opens
 * exactly that gate. `j`/`k` move through the Inbox and Enter, `a` or `r`
 * open the gate the keys are on; once it is open, its drawer has the keys.
 * All live: a gate that opens appears, one the factory acted on goes.
 */
export function Now({ open, factory, tab }: NowAddress) {
  const signIn = useSignIn();
  const page = useQuery(api.now.page, { signIn });
  const now = useClock();
  const router = useRouter();
  const [cursor, setCursor] = useState<string | null>(null);
  const [posted, setPosted] = useState<{ what: string; url: string; to: string } | null>(null);
  const rows = useMemo(() => onlyOf(page?.inbox ?? [], factory), [page, factory]);
  const at = Math.max(rows.findIndex((row) => keyOf(row) === (cursor ?? open)), 0);
  const go = useCallback((to: NowAddress) => router.replace(nowAddress({ factory, ...to }), { scroll: false }), [factory, router]);
  const link = (key: string): Go => ({ href: nowAddress({ factory, open: key }), onClick: () => { setCursor(key); go({ open: key }); } });

  useEffect(() => {
    // With a gate open, its drawer has the keys.
    if (open) return;
    const onKey = (event: KeyboardEvent) => {
      const key = keyed(event);
      // Enter on a row the focus is on is that row's own click.
      const onControl = event.target instanceof Element && event.target.closest("button, a") !== null;
      if ((key === "approve" || key === "reject" || (key === "open" && !onControl)) && rows[at]) {
        event.preventDefault();
        go({ open: keyOf(rows[at]) });
        return;
      }
      if (key !== "next" && key !== "previous") return;
      const next = rows[Math.min(Math.max(at + (key === "next" ? 1 : -1), 0), rows.length - 1)];
      if (next) {
        event.preventDefault();
        setCursor(keyOf(next));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, at, open, go]);

  if (page === undefined) return <Loading />;
  if (page === null) return null;      // signed out: the shell says so
  const close: Go = { href: nowAddress({ factory }), onClick: () => go({}) };
  const answered = (row: Row, url: string, verdict: string) => {
    const key = keyOf(row);
    setPosted({ what: `${verdict} at ${row.gate} round ${row.round} of ${row.factory}`, url, to: row.station });
    setCursor(key);
    // On to the next wait that can still be answered, or closed when none is left.
    const from = rows.findIndex((each) => keyOf(each) === key);
    const after = [...rows.slice(from + 1), ...rows.slice(0, Math.max(from, 0))]
      .find((each) => each.blocked === null && keyOf(each) !== key);
    go(after ? { open: keyOf(after) } : {});
  };
  return (
    <>
      {posted?.url ? (
        <Notice tone="ok" className="mt-0 mb-6 text-sm">
          Answered {posted.what}: <a href={posted.url} target="_blank" rel="noreferrer">the comment</a>. The station picks
          it up from the comment on the issue.
        </Notice>
      ) : posted ? (
        <Notice tone="ok" className="mt-0 mb-6 text-sm">
          Answered {posted.what}: sent to {posted.to}. It goes on once the station records it as your decision.
        </Notice>
      ) : null}
      <NowView page={page} now={now} factory={factory} selected={open ?? (rows[at] ? keyOf(rows[at]) : null)} openGate={link}
               runningRow={(row) => <LiveRunning row={row} now={now} signIn={signIn} />} />
      <Drawer open={Boolean(open)} label={open ? gateLabel([...page.inbox, ...page.others], open) : ""} onClose={() => go({})}>
        <NowDrawerView open={open} tab={tab} gate={(target) => (
          <LiveGate key={open} signIn={signIn} now={now}
                    target={{ ...target, close, onTab: (next) => go({ open, tab: next }), step: stepOf(rows, open!, link) }}
                    onAnswered={(gate, given, url) => answered(gate.row, url, given.verdict)} />
        )} />
      </Drawer>
    </>
  );
}

/** A running session's row, with where it is in its workflow: its own query, so one long record weighs on its row alone. */
function LiveRunning({ row, now, signIn }: { row: Running; now: number; signIn: string | undefined }) {
  const progress = useQuery(api.sessions.progress, { factory: row.factory, session: row.session, signIn });
  return <RunningRow row={row} progress={progress} now={now} />;
}

/** What the drawer is, to a screen reader: the open wait's question, when the page has it. */
function gateLabel(rows: Row[], open: string): string {
  const row = rows.find((each) => keyOf(each) === open);
  return row ? verbsOf(row).question : "A gate";
}
