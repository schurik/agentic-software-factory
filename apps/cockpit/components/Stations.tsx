"use client";

import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import { soleAddress, tabHref } from "./factory/view";
import { said } from "./said";
import { useSignIn } from "./signIn";
import { Button, Control, Facts, Field, Loading, Notice, Standalone } from "./ui";

/**
 * Where an old `/stations` link lands (#118): a factory's page holds its
 * stations now, so it goes on to the Stations tab of the one factory the
 * viewer's stations are in, or to the Factories list to pick one.
 */
export function StationsRedirect() {
  const signIn = useSignIn();
  const stations = useQuery(api.stations.mine, { signIn });
  const router = useRouter();
  const to = stations === undefined ? null : soleAddress(stations.map((row) => row.factory), "stations");
  useEffect(() => {
    if (to !== null) router.replace(to);
  }, [to, router]);
  return <Loading />;
}

/** What `asf station register`'s code finds: the station asking, null when none is, undefined while that is asked. */
export type Asked = FunctionReturnType<typeof api.stations.pending> | undefined;

/** What approving came to: done, with the factory it was for, or refused, and why. */
export interface Outcome {
  ok: boolean;
  text: string;
  factory?: string;
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
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const go = () => {
    setOutcome(null);
    // Once the station has its token the request is spent: which factory's it was is kept here.
    const factory = asked?.factory;
    void approve({ code: code.trim(), signIn })
      .then((done) => setOutcome(done.ok ? { ok: true, text: "Approved: the station picks up its token on its next poll.", factory }
        : { ok: false, text: done.because }))
      .catch((error: unknown) => setOutcome({ ok: false, text: said(error) }));
  };

  return <ApprovalView code={code} asked={asked} outcome={outcome} onCode={setCode} onApprove={go} />;
}

export interface Approval {
  /** The code as typed, or as the link carried it. */
  code: string;
  asked: Asked;
  outcome: Outcome | null;
  onCode: (code: string) => void;
  onApprove: () => void;
}

/** The approval page itself: the code, and what it finds — the station asking, nothing, or what approving it came to. */
export function ApprovalView({ code, asked, outcome, onCode, onApprove }: Approval) {
  return (
    <Standalone title="Approve a station">
      <form onSubmit={(event) => { event.preventDefault(); }}>
        <Field label="Code">
          <Control value={code} placeholder="ABCD-EF23" onValueChange={onCode}
                   autoComplete="off" spellCheck={false} className="w-full font-mono sm:w-48" />
        </Field>
      </form>
      {/* Once the station has its token the request is spent, and the code finds nothing: say what was done. */}
      {outcome?.ok ? (
        <Notice tone="ok">
          {outcome.text}{outcome.factory ? <> <Link href={tabHref(outcome.factory, "stations")}>Its factory&apos;s stations</Link></> : null}
        </Notice>
      ) : !code.trim() ? <p className="text-muted">Enter the code <code>asf station register</code> printed.</p>
        : asked === undefined ? <Loading what="Looking…" />
        : asked === null ? <Notice>No station is waiting on that code: it may have expired. Run <code>asf station register</code> again.</Notice>
        : (
          <div className="rounded-lg border border-line bg-surface-2 px-4 py-3">
            <Facts>
              <dt>Repository</dt><dd>{asked.factory}</dd>
              <dt>Station</dt><dd><code>{asked.name}</code> <span className="text-sm text-muted">({asked.kind}, {asked.station})</span></dd>
              <dt>Host</dt>
              <dd>
                {asked.host ? <code>{asked.host}</code> : <span className="text-muted">it did not say</span>}
                {asked.from ? <span className="text-sm text-muted"> — as it says; the request came from {asked.from}</span> : null}
              </dd>
            </Facts>
            <p className="mt-3 text-sm">
              Approving makes this station yours: it takes commands from this cockpit for you, as far as its own{" "}
              <code>asf/factory.yaml</code> opts them in. Approve only a station you started, whose terminal shows this code.
            </p>
            {asked.open ? (
              <p className="mt-2 text-sm">
                It asked without an ingest token, so approving also hands it one for {asked.factory}: it ships that
                factory&apos;s sessions as yours, listed on the factory&apos;s Stations tab, where it can be revoked.
              </p>
            ) : null}
            {asked.because ? <Notice className="mt-3 text-sm">{asked.because}</Notice> : null}
            <Button variant="primary" className="mt-3" disabled={asked.because !== null || asked.approved} onClick={onApprove}>
              {asked.approved ? "Approved" : "Approve"}
            </Button>
            {outcome ? <Notice tone="bad" role="alert" className="mt-3 text-sm">{outcome.text}</Notice> : null}
          </div>
        )}
    </Standalone>
  );
}
