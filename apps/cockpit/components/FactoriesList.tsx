"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { PENDING_SHOWN } from "@/convex/model/progress";
import { useCockpit } from "./Shell";
import { formatTime } from "./format";
import { useSignIn } from "./signIn";

export function FactoriesList() {
  const signIn = useSignIn();
  const { mode, forge } = useCockpit();
  const list = useQuery(api.factories.list, { signIn });
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
        <table className="table">
          <thead>
            <tr>
              <th>Factory</th>
              <th>You can</th>
              <th>Stations</th>
              <th>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {factories.map((factory) => (
              <tr key={factory.repo}>
                <td>
                  {factory.onForge
                    ? <a href={`https://${forge.host}/${factory.repo}`}>{factory.repo}</a>
                    : factory.repo}
                  {factory.private ? <> <span className="tag">private</span></> : null}
                  {!factory.onForge ? <> <span className="tag tag-wait">not found on the forge</span></> : null}
                </td>
                <td>{factory.role ?? "—"}</td>
                <td>{factory.reporting ? "reporting" : <span className="tag tag-wait">no station yet</span>}</td>
                <td>{factory.lastActivity === null ? "—" : formatTime(new Date(factory.lastActivity).toISOString())}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
