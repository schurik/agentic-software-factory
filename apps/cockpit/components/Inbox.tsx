"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Row } from "@/convex/model/inbox";
import { useClock } from "./clock";
import { Drawer } from "./Drawer";
import { LiveGate } from "./gate/GateDrawer";
import { verbsOf } from "./gate/answer";
import type { Step } from "./gate/GateView";
import { InboxList, keyOf, onlyOf, splitKey } from "./inbox/InboxList";
import { keyed } from "./inbox/keys";
import { useSignIn } from "./signIn";
import { type Go, Kbd, Loading, Notice, PageHeader } from "./ui";

/** What the inbox's address says: the factory it is narrowed to, the wait open in the drawer, and that drawer's tab. */
export interface InboxAddress {
  factory?: string;
  open?: string;
  tab?: string;
}

/** The inbox's address for `to`: "/" when it says nothing. */
export function inboxAddress(to: InboxAddress): string {
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

/**
 * The home page: every gate the viewer is permitted to answer, across every
 * factory. A row opens its gate in the drawer over the list (#113), and the
 * address says which, so a link — from an issue comment, the session page —
 * opens exactly that gate. Both are live queries, so a gate that opens
 * appears and one the factory acted on goes, with nothing to reload.
 * `factory` narrows it to one factory's waits: what that factory's page links to.
 */
export function Inbox({ open, factory, tab }: InboxAddress) {
  const signIn = useSignIn();
  const inbox = useQuery(api.inbox.list, { signIn });
  const now = useClock();
  const router = useRouter();
  const [cursor, setCursor] = useState<string | null>(null);
  const [posted, setPosted] = useState<{ what: string; url: string; to: string } | null>(null);
  const rows = useMemo(() => onlyOf(inbox?.rows ?? [], factory), [inbox, factory]);
  const at = Math.max(rows.findIndex((row) => keyOf(row) === (cursor ?? open)), 0);
  const go = useCallback((to: InboxAddress) => router.replace(inboxAddress({ factory, ...to }), { scroll: false }), [factory, router]);
  const link = (key: string): Go => ({ href: inboxAddress({ factory, open: key }), onClick: () => go({ open: key }) });

  useEffect(() => {
    // With a gate open, its drawer has the keys.
    if (open) return;
    const onKey = (event: KeyboardEvent) => {
      const key = keyed(event);
      // Enter on a row the focus is on is that row's own click.
      const onControl = event.target instanceof Element && event.target.closest("button, a") !== null;
      if (key === "open" && rows[at] && !onControl) {
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

  if (inbox === undefined) return <Loading />;
  const close: Go = { href: inboxAddress({ factory }), onClick: () => go({}) };
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
      <PageHeader title="Inbox" sub={rows.length === 0 ? (factory
        ? <>Nothing at {factory} is waiting on you. <Link href="/">Every factory&apos;s waits</Link></>
        : "Nothing is waiting on you.") : (
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
          {factory ? <>only {factory} (<Link href="/">all</Link>) ·</> : null}
          <span>{rows.length} waiting</span>
          <span className="flex items-center gap-1.5 pointer-coarse:hidden">
            · <Kbd>j</Kbd>/<Kbd>k</Kbd> next/previous · <Kbd>Enter</Kbd> open · <Kbd>a</Kbd> approve · <Kbd>r</Kbd> reject
          </span>
        </span>
      )} />
      {posted?.url ? (
        <Notice tone="ok" className="text-sm">
          Answered {posted.what}: <a href={posted.url} target="_blank" rel="noreferrer">the comment</a>. The station picks
          it up from the comment on the issue.
        </Notice>
      ) : posted ? (
        <Notice tone="ok" className="text-sm">
          Answered {posted.what}: sent to {posted.to}. It goes on once the station records it as your decision.
        </Notice>
      ) : null}
      {rows.length ? (
        <InboxList rows={rows} selected={rows[at] ? keyOf(rows[at]) : null} now={now}
                   onSelect={(key) => { setCursor(key); go({ open: key }); }} />
      ) : null}
      <Drawer open={Boolean(open)} label={open ? gateLabel(rows, open) : ""} onClose={() => go({})}>
        {open ? (
          <LiveGate key={open} signIn={signIn} now={now}
                    target={{ ...splitKey(open), tab: tab ?? null, close,
                              onTab: (next) => go({ open, tab: next }), step: stepOf(rows, open, link) }}
                    onAnswered={(gate, given, url) => answered(gate.row, url, given.verdict)} />
        ) : null}
      </Drawer>
    </>
  );
}

/** What the drawer is, to a screen reader: the open wait's question, when the list has it. */
function gateLabel(rows: Row[], open: string): string {
  const row = rows.find((each) => keyOf(each) === open);
  return row ? verbsOf(row).question : "A gate";
}
