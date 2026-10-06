"use client";

import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import { stationsAddress, tabHref } from "./factory/view";
import { said } from "./said";
import { useSignIn } from "./signIn";
import { Loading } from "./ui";

/**
 * Where an old `/stations` link lands (#118): a factory's page holds its
 * stations now, so it goes on to the Stations tab of the one factory the
 * viewer's stations are in, or to the Factories list to pick one.
 */
export function StationsRedirect() {
  const signIn = useSignIn();
  const stations = useQuery(api.stations.mine, { signIn });
  const router = useRouter();
  const to = stations === undefined ? null : stationsAddress(stations.map((row) => row.factory));
  useEffect(() => {
    if (to !== null) router.replace(to);
  }, [to, router]);
  return <Loading />;
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
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string; factory?: string } | null>(null);

  const go = () => {
    setOutcome(null);
    // Once the station has its token the request is spent: which factory's it was is kept here.
    const factory = asked?.factory;
    void approve({ code: code.trim(), signIn })
      .then((done) => setOutcome(done.ok ? { ok: true, text: "Approved: the station picks up its token on its next poll.", factory }
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
      {outcome?.ok ? <p className="notice small">{outcome.text}{outcome.factory ? <> <Link href={tabHref(outcome.factory, "stations")}>Its factory&apos;s stations</Link></> : null}</p>
        : !code.trim() ? <p className="muted">Enter the code <code>asf station register</code> printed.</p>
        : asked === undefined ? <p className="muted">Looking…</p>
        : asked === null ? <p className="notice">No station is waiting on that code: it may have expired. Run <code>asf station register</code> again.</p>
        : (
          <div className="card">
            <dl className="facts">
              <dt>Repository</dt><dd>{asked.factory}</dd>
              <dt>Station</dt><dd><code>{asked.name}</code> <span className="muted small">({asked.kind}, {asked.station})</span></dd>
              <dt>Host</dt>
              <dd>
                {asked.host ? <code>{asked.host}</code> : <span className="muted">it did not say</span>}
                {asked.from ? <span className="muted small"> — as it says; the request came from {asked.from}</span> : null}
              </dd>
            </dl>
            <p className="small">
              Approving makes this station yours: it takes commands from this cockpit for you, as far as its own{" "}
              <code>asf/factory.yaml</code> opts them in. Approve only a station you started, whose terminal shows this code.
            </p>
            {asked.open ? (
              <p className="small">
                It asked without an ingest token, so approving also hands it one for {asked.factory}: it ships that
                factory&apos;s sessions as yours, listed on the factory&apos;s Stations tab, where it can be revoked.
              </p>
            ) : null}
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
