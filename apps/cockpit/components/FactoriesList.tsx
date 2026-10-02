"use client";

import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/convex/_generated/api";
import { onlyFactory, type Order, rank } from "@/convex/model/factories";
import { type PeriodKind, PERIODS, periodOf } from "@/convex/model/period";
import { PENDING_SHOWN } from "@/convex/model/progress";
import { useClock, viewersTimeZone } from "./clock";
import { FactoriesTable } from "./FactoriesTable";
import { factoryHref } from "./factory/view";
import { useCockpit } from "./Shell";
import { formatTime } from "./format";
import { useSignIn } from "./signIn";
import { TriggerForm } from "./trigger/Trigger";

/**
 * Every factory the viewer can read (spec #40), what needs attention first
 * and then the most recently active — or by name, on the toggle — with spend
 * in a calendar period of the viewer's own timezone, month-to-date unless
 * they pick another.
 */
export function FactoriesList() {
  const signIn = useSignIn();
  const { mode, forge, viewer } = useCockpit();
  const now = useClock();
  const [kind, setKind] = useState<PeriodKind>("month");
  const [order, setOrder] = useState<Order>("attention");
  // The period's bounds stay put between its midnights, so the query is asked again only when it moves on.
  const { from, to } = periodOf(kind, now, viewersTimeZone());
  const list = useQuery(api.factories.list, { signIn, period: { from, to } });
  const [triggering, setTriggering] = useState<string | null>(null);
  const router = useRouter();
  // A solo developer's one factory is not a list: straight to its page.
  const only = list ? onlyFactory(mode, list.factories) : null;
  useEffect(() => {
    if (only !== null) router.replace(factoryHref(only));
  }, [only, router]);
  const ranked = useMemo(() => (list ? rank(list.factories, now, order) : []), [list, now, order]);
  if (list === undefined) return <p className="muted">Loading…</p>;
  if (list === null) return null;       // signed out between two renders: the shell is about to say so
  const { factories, discovery } = list;

  return (
    <>
      <h1>Factories</h1>
      <p className="muted">
        {mode === "local"
          ? <>Every repository your token reaches on {forge.host} whose default branch holds <code>asf/factory.yaml</code>, and every one a station here ships from.</>
          : <>Every repository you can read on {forge.host} whose default branch holds <code>asf/factory.yaml</code>. Nothing is registered here: the forge is asked.</>}
      </p>

      {mode === "local" && !forge.ready ? (
        <p className="notice">
          This cockpit has no token to ask {forge.host} with, so it shows only what its stations ship. Run{" "}
          <code>gh auth login</code>, then start <code>asf up</code> again: it hands the cockpit your{" "}
          <code>gh auth token</code>.
        </p>
      ) : null}
      {discovery.problem ? <p className="notice">The forge was last asked in vain: {discovery.problem}</p> : null}
      {discovery.pausedUntil !== null ? (
        <p className="notice">
          The forge&apos;s rate limit holds the poll until {formatTime(new Date(discovery.pausedUntil).toISOString())}
          {discovery.pending > 0 ? <>, with {pending(discovery.pending)} still to look at</> : null}.
        </p>
      ) : discovery.pending > 0 ? (
        <p className="muted">Looking at {pending(discovery.pending)} for a factory…</p>
      ) : null}

      {factories.length === 0 ? (
        <p className="notice">
          {discovery.listedAt === null && forge.ready
            ? "The forge has not been asked yet; the first poll runs within a minute."
            : mode === "team"
              ? "No repository you can read holds a factory."
              : "No factory yet."}
          {mode === "team" && forge.app ? (
            <> If one is missing, the App may not be installed on it: <a href={forge.app.installUrl}>install {forge.app.slug}</a>.</>
          ) : null}
        </p>
      ) : (
        <>
          <p className="list-controls">
            <label>
              Spend{" "}
              <select value={kind} onChange={(event) => setKind(event.target.value as PeriodKind)}>
                {Object.entries(PERIODS).map(([value, words]) => <option key={value} value={value}>{words}</option>)}
              </select>
            </label>{" "}
            <label>
              <input type="checkbox" checked={order === "name"} onChange={(event) => setOrder(event.target.checked ? "name" : "attention")} />{" "}
              A–Z
            </label>
            <span className="muted small">
              {" "}{order === "name" ? "By name." : "What needs attention first, then the most recently active."}{" "}
              Spend is list-price equivalent.
            </span>
          </p>
          <FactoriesTable rows={ranked} now={now} host={forge.host} period={PERIODS[kind]} triggering={triggering}
                          onTrigger={(repo) => setTriggering(triggering === repo ? null : repo)}
                          form={triggering === null ? null : <TriggerForm factory={triggering} signIn={signIn} as={viewer?.login ?? ""} />} />
        </>
      )}

      {discovery.listedAt !== null ? (
        <p className="muted small">Repositories last listed {formatTime(new Date(discovery.listedAt).toISOString())}.</p>
      ) : null}
    </>
  );
}

function pending(count: number): string {
  if (count >= PENDING_SHOWN) return `${PENDING_SHOWN}+ repositories`;
  return `${count} ${count === 1 ? "repository" : "repositories"}`;
}
