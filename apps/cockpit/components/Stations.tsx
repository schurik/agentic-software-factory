"use client";

import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { liveness } from "@/convex/model/command";
import { useClock } from "./clock";
import { formatAgo } from "./format";
import { said, useCockpit } from "./Shell";
import { useSignIn } from "./signIn";
import { Button, Loading, Notice, PageHeader, Table } from "./ui";
import { useWho } from "./viewer";

/**
 * The stations the viewer owns — on a local cockpit, the machine's — with
 * whether each is online and what it would obey, and the one thing an owner
 * does here: revoke a station's command token, which takes it offline for
 * commands (a lost laptop, a checkout given away).
 */
export function Stations() {
  const signIn = useSignIn();
  const { mode } = useCockpit();
  const who = useWho();
  const stations = useQuery(api.stations.mine, { signIn });
  const revoke = useMutation(api.stations.revoke);
  const [problem, setProblem] = useState("");
  const now = useClock();
  if (stations === undefined) return <Loading />;
  return (
    <>
      <PageHeader title="Stations" sub={
        <>
          {mode === "local"
            ? <>The stations on this machine: a local cockpit&apos;s are yours without approving them.</>
            : <>The stations you approved. A station takes commands from the cockpit for you; run{" "}
                <code>asf station register</code> in a checkout to add one.</>}
          <span className="mt-2 block"><Link href="/stations/approve">Approve a station by its code…</Link> · <Link href="/run">Run a prompt on one of them…</Link></span>
        </>
      } />
      {problem ? <Notice tone="bad">{problem}</Notice> : null}
      {stations.length === 0 ? <p className="text-muted">No stations yet.</p> : (
        <Table>
          <thead>
            <tr><th>station</th><th>factory</th><th>owner</th><th>liveness</th><th>obeys</th><th /></tr>
          </thead>
          <tbody>
            {stations.map((row) => {
              const live = liveness(row.seenAt, null, now);
              return (
                <tr key={`${row.factory}/${row.station}`}>
                  <td><code>{row.name}</code></td>
                  <td>{row.factory}</td>
                  <td>{who(row.owner) || "—"}</td>
                  <td className="text-sm whitespace-nowrap">
                    {!row.registered ? "revoked" : live.online ? "● online" : "○ offline"}
                    {live.lastSeen !== null ? ` · ${formatAgo(new Date(live.lastSeen).toISOString(), now)}` : " · never polled"}
                  </td>
                  <td className="text-sm">{row.report?.verbs.join(", ") || "—"}</td>
                  <td>
                    {row.registered ? (
                      <Button size="sm" variant="danger"
                              onClick={() => void revoke({ factory: row.factory, station: row.station, signIn })
                                .then((done) => setProblem(done.ok ? "" : done.because))
                                .catch((error: unknown) => setProblem(said(error)))}>
                        Revoke
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </>
  );
}

/**
 * Approving a station: what `asf station register` printed a link to. It
 * shows which station of which factory is asking, and approving makes it the
 * viewer's — the commands it takes from here on are taken for them.
 */
export function StationApproval({ code: given }: { code: string }) {
  const signIn = useSignIn();
  const [code, setCode] = useState(given);
  const asked = useQuery(api.stations.pending, code.trim() ? { code: code.trim(), signIn } : "skip");
  const approve = useMutation(api.stations.approve);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);

  const go = () => {
    setOutcome(null);
    void approve({ code: code.trim(), signIn })
      .then((done) => setOutcome(done.ok ? { ok: true, text: "Approved: the station picks up its token on its next poll." }
        : { ok: false, text: done.because }))
      .catch((error: unknown) => setOutcome({ ok: false, text: said(error) }));
  };

  return (
    <>
      <h1>Approve a station</h1>
      <form className="form" onSubmit={(event) => { event.preventDefault(); }}>
        <label>
          Code
          <input value={code} placeholder="ABCD-EF23" onChange={(event) => setCode(event.target.value)} />
        </label>
      </form>
      {/* Once the station has its token the request is spent, and the code finds nothing: say what was done. */}
      {outcome?.ok ? <p className="notice small">{outcome.text} <Link href="/stations">Your stations</Link></p>
        : !code.trim() ? <p className="muted">Enter the code <code>asf station register</code> printed.</p>
        : asked === undefined ? <p className="muted">Looking…</p>
        : asked === null ? <p className="notice">No station is waiting on that code: it may have expired. Run <code>asf station register</code> again.</p>
        : (
          <div className="card">
            <dl className="facts">
              <dt>Station</dt><dd><code>{asked.name}</code> <span className="muted small">({asked.kind}, {asked.station})</span></dd>
              <dt>Factory</dt><dd>{asked.factory}</dd>
            </dl>
            <p className="small">
              Approving makes this station yours: it takes commands from this cockpit for you, as far as its own{" "}
              <code>asf/factory.yaml</code> opts them in. Approve only a station you started.
            </p>
            {asked.because ? <p className="notice small">{asked.because}</p> : null}
            <button type="button" className="button" disabled={asked.because !== null || asked.approved} onClick={go}>
              {asked.approved ? "Approved" : "Approve"}
            </button>
            {outcome ? <p className="notice small">{outcome.text}</p> : null}
          </div>
        )}
    </>
  );
}
