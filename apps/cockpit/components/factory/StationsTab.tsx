import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { SessionRow, StationDetail, Waiting } from "@/convex/activity";
import type { ClaimView } from "@/convex/model/claim";
import { liveness, pending } from "@/convex/model/command";
import type { Drift } from "@/convex/model/drift";
import { ClaimRow } from "../ClaimRow";
import { useState } from "react";
import { formatAgoAt, formatCost, formatDollars, formatSpan, plural, sessionHref } from "../format";
import { Button, Card, control, cx, Facts, num, StatusDot, StatusPill, Table, Tag } from "../ui";
import { useWho } from "../viewer";
import { behind, short } from "./view";

/** Every CI job of the factory, as one entry: the sessions that ran in CI and the checks CI pushed. */
export interface Ci {
  jobs: SessionRow[];
  checks: { ref: string; head: string; ok: boolean; station: string; at: number }[];
}

/** A station asking to become one of the factory's (stations.registrations). */
export type Registration = NonNullable<FunctionReturnType<typeof api.stations.registrations>>[number];

/** What each watcher a station loop runs does, in words. */
const WATCHES: Record<string, string> = {
  issues: "labelled issues", answers: "answers on work items", prs: "pull-request reviews",
};

/** A station's liveness at `now` — online while its loop polls, away once it stopped, never polled before it began — and the status it is drawn as. */
function stateOf(station: StationDetail, now: number): { word: string; status: "success" | "waiting" | "pending" } {
  const live = liveness(station.seenAt, null, now);
  if (live.lastSeen === null) return { word: "never polled", status: "pending" };
  if (live.online) return { word: "online", status: "success" };
  return { word: `away ${formatSpan(now - live.lastSeen)}`, status: "waiting" };
}

/** A station's drift: the page's measure when it has one, else what its report allows. */
function driftOf(station: StationDetail, drifts: Map<string, Drift>): Drift {
  return drifts.get(station.station) ?? { badges: [station.report ? "not measured yet" : "no report yet"], drifted: false };
}

/**
 * One factory's Stations (#118): the stations asking to join it on top, to
 * approve only when the code matches the one the station's terminal shows,
 * then a card per station — online, away or never polled, and whose it is;
 * what it watches and which commands it takes; the release it runs, its
 * commit and whether its config is the default branch's; what it holds now;
 * its last 30 days; the commands waiting for it, with when each expires; and
 * Revoke — and every CI job as one card. Pure but for the code typed into a
 * registration: judged at `now`, the page's clock, which is what lets a
 * command's expiry count down.
 */
export function StationsTab({
  stations, ci, registrations, drifts, now, factory, forge, defaultBranch, release, onApprove, onRevoke, onRelease,
}: {
  stations: StationDetail[];
  ci: Ci;
  registrations: Registration[];
  /** Each reporting station's drift, as the page measured it against the forge. */
  drifts: Map<string, Drift>;
  now: number;
  factory: string;
  /** The forge's web origin, e.g. https://github.com. */
  forge: string;
  /** The default branch, by name: what a station's config and release are the same as, or behind. */
  defaultBranch: string | null;
  /** The release the default branch's check ran: "" when no check said. */
  release: string;
  /** Approve a registration with the code the approver typed from its station's terminal. */
  onApprove: (code: string) => void;
  onRevoke: (station: StationDetail) => void;
  onRelease?: (claim: ClaimView) => void;
}) {
  const asking = registrations.filter((registration) => now < registration.expiresAt);
  return (
    <div className="grid gap-4">
      {asking.map((registration) => (
        <Asking key={registration.station} registration={registration} factory={factory} now={now} onApprove={onApprove} />
      ))}
      {stations.length === 0 && !ci.jobs.length && !ci.checks.length ? (
        <p className="text-muted">
          No station has reported yet. A checkout reports once <code>asf up</code> runs there with this cockpit&apos;s
          URL; <code>asf station register</code> asks to take commands from here.
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {stations.map((station) => (
            <StationCard key={station.station} station={station} drift={driftOf(station, drifts)} factory={factory} forge={forge}
                         defaultBranch={defaultBranch} release={release} now={now} onRevoke={onRevoke} onRelease={onRelease} />
          ))}
          {ci.jobs.length || ci.checks.length ? <CiCard ci={ci} factory={factory} now={now} /> : null}
        </div>
      )}
      <p className="text-xs text-muted">
        A machine&apos;s station is online while its loop asks for commands, and belongs to the person who approved it. A CI
        station lives for one job and takes no commands.
      </p>
    </div>
  );
}

function Asking({ registration, factory, now, onApprove }: {
  registration: Registration; factory: string; now: number; onApprove: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  const refused = registration.because !== null;
  return (
    <Card className="flex flex-col gap-3 border-l-[3px] border-l-wait px-4 py-3 sm:px-5 md:flex-row md:items-center">
      <div className="min-w-0 grow">
        <div><code>{registration.name}</code> asks to become a station of {factory}</div>
        <div className="mt-0.5 text-sm text-muted">
          {registration.approved ? "Approved: it picks up its token on its next poll."
            : <>Approve it with the code its terminal shows, only if that terminal is one you started · the code expires
                in {formatSpan(registration.expiresAt - now)}</>}
        </div>
        {refused && !registration.approved ? <div className="mt-1 text-sm text-muted">{registration.because}</div> : null}
      </div>
      {registration.approved || refused ? null : (
        <form className="flex shrink-0 gap-2" onSubmit={(event) => { event.preventDefault(); if (code.trim()) onApprove(code.trim()); }}>
          <input value={code} onChange={(event) => setCode(event.target.value)} placeholder="ABCD-EF23"
                 aria-label={`The code ${registration.name}'s terminal shows`} className={cx(control, "h-7 w-32 font-mono text-sm")} />
          <Button type="submit" variant="primary" size="sm" disabled={!code.trim()}>Approve</Button>
        </form>
      )}
    </Card>
  );
}

/** Whose a station is, as its card says it: the viewer's machine, someone's, or nobody's yet. */
function whose(station: StationDetail, who: (login: string) => string): string {
  if (!station.owner) return "nobody's";
  const owner = who(station.owner);
  return owner === "you" ? "your machine" : `${owner}'s machine`;
}

function StationCard({ station, drift, factory, forge, defaultBranch, release, now, onRevoke, onRelease }: {
  station: StationDetail;
  drift: Drift;
  factory: string;
  forge: string;
  defaultBranch: string | null;
  release: string;
  now: number;
  onRevoke: (station: StationDetail) => void;
  onRelease?: (claim: ClaimView) => void;
}) {
  const who = useWho();
  const { report } = station;
  const state = stateOf(station, now);
  const waiting = station.commands.filter((command) => pending(command, now));
  const running = station.sessions.filter((row) => row.status === "running" || row.status === "waiting");
  const { period } = station;
  return (
    <Card className="flex min-w-0 flex-col px-4 py-4 sm:px-5">
      <div className="flex items-start gap-3">
        <StatusDot status={state.status} label={state.word} className="mt-2 shrink-0" />
        <div className="min-w-0 grow">
          <div className="truncate font-mono font-medium">{station.name}</div>
          <div className="text-sm text-muted">
            {whose(station, who)} · {state.word}
            {!station.registered && station.owner ? " · revoked" : null}
          </div>
        </div>
      </div>
      <Facts className="mt-4 text-sm">
        <dt>Watches</dt>
        <dd>
          {report === null ? "not reported"
            : report.watchers.length ? report.watchers.map((watcher) => WATCHES[watcher] ?? watcher).join(" · ")
            : <span className="text-muted">nothing: it runs what it is told</span>}
        </dd>
        <dt>Takes commands</dt>
        <dd>
          {!station.registered ? <span className="text-muted">none: <code>asf station register</code> on it</span>
            : report === null ? <span className="text-muted">has never polled for commands</span>
            : report.verbs.join(", ") || <span className="text-muted">none: its <code>asf/factory.yaml</code>&apos;s cockpit.commands lists no verb</span>}
        </dd>
        <dt>Runs</dt>
        <dd className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {station.release ? <span>release {station.release}</span> : <span className="text-muted">no release said yet</span>}
          {behind(station.release, release) ? <Tag tone="wait">behind {defaultBranch ?? "the default branch"}&apos;s {release}</Tag> : null}
          {report?.head ? (
            <a href={`${forge}/${factory}/commit/${report.head}`}><code>{short(report.head)}</code></a>
          ) : null}
          {drift.drifted ? <Tag tone="wait">config drifted</Tag>
            : report?.head && !drift.badges.length ? <Tag tone="ok">config same as {defaultBranch ?? "the default branch"}</Tag>
            : null}
          {drift.badges.length ? (
            <span className="flex basis-full flex-wrap gap-1">
              {drift.badges.map((badge) => <Tag key={badge} tone={drift.drifted ? "wait" : "none"}>{badge}</Tag>)}
            </span>
          ) : null}
        </dd>
        <dt>Now</dt>
        <dd className="tabular-nums">
          {running.length} running · {station.claims.length ? `${plural(station.claims.length, "claim")} held` : "no claims"}
        </dd>
        <dt>Last 30 days</dt>
        <dd className="tabular-nums">
          {plural(period.sessions, "session")}
          {period.failed ? <span className="text-bad"> · {period.failed} failed</span> : null} · {formatDollars(period.cost)} on its key
        </dd>
      </Facts>
      {station.sessions.length ? (
        <div className="mt-4"><Sessions factory={factory} rows={station.sessions} now={now} workflow station={false} /></div>
      ) : null}
      {station.claims.length ? (
        <div className="mt-3">{station.claims.map((claim) => <ClaimRow key={claim.id} claim={claim} now={now} onRelease={onRelease} />)}</div>
      ) : null}
      {waiting.length ? (
        <ul className="mt-3 grid gap-1 rounded-lg bg-wait-soft px-3 py-2 text-sm">
          {waiting.map((command) => <WaitingCommand key={`${command.verb}-${command.issuedAt}`} command={command} factory={factory} now={now} />)}
        </ul>
      ) : null}
      {station.registered && station.revocable ? (
        <div className="mt-auto flex justify-end pt-3">
          <Button variant="danger" size="sm" onClick={() => onRevoke(station)}>Revoke</Button>
        </div>
      ) : null}
    </Card>
  );
}

function WaitingCommand({ command, factory, now }: { command: Waiting; factory: string; now: number }) {
  const who = useWho();
  return (
    <li>
      <span className="font-medium">{command.verb}</span>{" "}
      {command.session ? <Link href={sessionHref(factory, command.session)}><code>{command.session}</code></Link>
        : command.workflow ? <code>{command.workflow}</code> : null}{" "}
      {command.state === "delivered" ? "delivered, not yet answered" : "waits for it"} · queued by {who(command.by) || "someone"}{" "}
      {formatAgoAt(command.issuedAt, now)} · expires in {formatSpan(command.expiresAt - now)}
    </li>
  );
}

function CiCard({ ci, factory, now }: { ci: Ci; factory: string; now: number }) {
  return (
    <Card className="flex min-w-0 flex-col px-4 py-4 sm:px-5">
      <div className="flex items-start gap-3">
        <StatusDot status="pending" label="comes and goes" className="mt-2 shrink-0" />
        <div className="min-w-0 grow">
          <div className="font-medium">CI</div>
          <div className="text-sm text-muted">
            every CI job is a station of its own that comes and goes · {plural(ci.jobs.length, "job")} · {plural(ci.checks.length, "check push", "check pushes")}
          </div>
        </div>
      </div>
      <h4 className="mt-4 mb-2">Recent jobs</h4>
      {ci.jobs.length ? <Sessions factory={factory} rows={ci.jobs} now={now} workflow /> : <p className="text-sm text-muted">No session has run in CI.</p>}
      <h4 className="mt-4 mb-2">Check pushes</h4>
      {ci.checks.length ? (
        <Table className="text-sm">
          <thead><tr><th>ref</th><th>commit</th><th>check</th><th>by</th><th>when</th></tr></thead>
          <tbody>
            {ci.checks.map((check) => (
              <tr key={check.ref}>
                <td><code>{check.ref}</code></td>
                <td><code>{short(check.head)}</code></td>
                <td><Tag tone={check.ok ? "ok" : "bad"}>{check.ok ? "passing" : "failing"}</Tag></td>
                <td>{check.station}</td>
                <td className="whitespace-nowrap">{formatAgoAt(check.at, now)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : <p className="text-sm text-muted">No <code>asf check</code> pushed yet: the optional CI workflow does that.</p>}
    </Card>
  );
}

/** Sessions as a table; `workflow` and `station` say whether those columns are worth a column where it is shown. */
function Sessions({ factory, rows, now, workflow = false, station = true }: {
  factory: string; rows: SessionRow[]; now: number; workflow?: boolean; station?: boolean;
}) {
  return (
    <Table className="text-sm">
      <thead>
        <tr>
          <th>session</th>{workflow ? <th>workflow</th> : null}<th>status</th>{station ? <th>station</th> : null}
          <th className={num}>cost</th><th>last</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.session}>
            <td><Link href={sessionHref(factory, row.session)}><code>{row.session}</code></Link></td>
            {workflow ? <td>{row.workflow || "—"}</td> : null}
            <td className="whitespace-nowrap"><StatusPill status={row.status} />{row.gate ? <span className="text-muted"> at {row.gate}</span> : null}</td>
            {station ? <td>{row.station || "—"}</td> : null}
            <td className={num}>{formatCost(row.cost)}</td>
            <td className="whitespace-nowrap">{formatAgoAt(row.endedAt, now)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
