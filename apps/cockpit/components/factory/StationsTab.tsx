import type { SessionRow, StationDetail } from "@/convex/activity";
import type { ClaimView } from "@/convex/model/claim";
import { liveness } from "@/convex/model/command";
import type { Drift } from "@/convex/model/drift";
import { ClaimRow } from "../ClaimRow";
import { formatAgoAt, plural } from "../format";
import { Sessions } from "./ActivityTab";
import { Card, Facts, LinkButton, Table, Tag } from "../ui";
import { useWho } from "../viewer";
import { short } from "./view";

/** Every CI job of the factory, as one entry: the sessions that ran in CI and the checks CI pushed. */
export interface Ci {
  jobs: SessionRow[];
  checks: { ref: string; head: string; ok: boolean; station: string; at: number }[];
}

/** What the CI entry is selected as. */
export const CI = "ci";


function seenWords(station: StationDetail, now: number): string {
  if (!station.registered) {
    return station.seenAt === 0 ? "never polled" : `revoked · last seen ${formatAgoAt(station.seenAt, now)}`;
  }
  const live = liveness(station.seenAt, null, now);
  if (live.lastSeen === null) return "never polled";
  return `${live.online ? "● online" : "○ offline"} · ${formatAgoAt(live.lastSeen, now)}`;
}

/** A station's drift badges: the page's measure when it has one, else what its report allows. */
function driftOf(station: StationDetail, drifts: Map<string, Drift>): Drift {
  return drifts.get(station.station) ?? { badges: [station.report ? "not measured yet" : "no report yet"], drifted: false };
}

/**
 * One factory's Stations (spec #40): each station's name, owner, kind, when it
 * was last seen and its drift; opened, what it obeys, where its checkout
 * stands, the watchers it runs, and the sessions and claims it holds — each
 * claim with Release claim. Every CI job is one "CI" entry. Pure.
 */
export function StationsTab({ stations, ci, drifts, now, selected, onSelect, factory = "", onRelease }: {
  stations: StationDetail[];
  ci: Ci;
  /** Each reporting station's drift, as the page measured it against the forge. */
  drifts: Map<string, Drift>;
  now: number;
  /** The station open in detail — its id, or CI — or null for none. */
  selected: string | null;
  onSelect: (station: string | null) => void;
  factory?: string;
  onRelease?: (claim: ClaimView) => void;
}) {
  const who = useWho();
  const open = stations.find((station) => station.station === selected) ?? null;
  const toggle = (station: string) => onSelect(selected === station ? null : station);
  return (
    <div className="grid gap-6">
      {stations.length === 0 && !ci.jobs.length && !ci.checks.length ? (
        <p className="text-muted">No station has reported yet. A checkout reports once <code>asf up</code> runs there with this cockpit&apos;s URL.</p>
      ) : (
        <Table>
          <thead><tr><th>station</th><th>owner</th><th>kind</th><th>last seen</th><th>drift</th></tr></thead>
          <tbody>
            {stations.map((station) => {
              const drift = driftOf(station, drifts);
              return (
                <tr key={station.station} aria-selected={station.station === selected} className="aria-selected:bg-accent-soft">
                  <td>
                    <LinkButton aria-expanded={station.station === selected} onClick={() => toggle(station.station)}>
                      <code>{station.name}</code>
                    </LinkButton>
                  </td>
                  <td>{who(station.owner) || "—"}</td>
                  <td>{station.kind}</td>
                  <td className="text-sm whitespace-nowrap">{seenWords(station, now)}</td>
                  <td><span className="flex flex-wrap gap-1">{drift.badges.map((badge) => <Tag key={badge} tone={drift.drifted ? "wait" : "none"}>{badge}</Tag>)}</span></td>
                </tr>
              );
            })}
            {ci.jobs.length || ci.checks.length ? (
              <tr aria-selected={selected === CI} className="aria-selected:bg-accent-soft">
                <td><LinkButton aria-expanded={selected === CI} onClick={() => toggle(CI)}>CI</LinkButton></td>
                <td>—</td>
                <td>ci</td>
                <td className="text-sm">{plural(ci.jobs.length, "job")} · {plural(ci.checks.length, "check push")}</td>
                <td />
              </tr>
            ) : null}
          </tbody>
        </Table>
      )}
      {open ? <StationOpen station={open} drift={driftOf(open, drifts)} factory={factory} now={now} onRelease={onRelease} />
        : selected === CI ? <CiOpen ci={ci} factory={factory} now={now} /> : null}
    </div>
  );
}

function StationOpen({ station, drift, factory, now, onRelease }: {
  station: StationDetail; drift: Drift; factory: string; now: number; onRelease?: (claim: ClaimView) => void;
}) {
  const { report } = station;
  return (
    <Card className="p-4 sm:p-5">
      <h3 className="mb-3"><code>{station.name}</code></h3>
      <Facts>
        <dt>Obeys</dt>
        <dd>
          {!station.registered ? <>takes no commands: <code>asf station register</code> on it</>
            : report === null ? "has never polled for commands"
            : report.verbs.join(", ") || "nothing: its asf/factory.yaml's cockpit.commands lists no verb"}
        </dd>
        <dt>Checkout</dt>
        <dd>
          {report?.head ? <code>{short(report.head)}</code> : "not reported"}
          {drift.badges.map((badge) => <span key={badge}> <Tag tone={drift.drifted ? "wait" : "none"}>{badge}</Tag></span>)}
        </dd>
        <dt>Watchers</dt>
        <dd>{report === null ? "not reported" : report.watchers.join(", ") || "none running"}</dd>
      </Facts>
      <h4 className="mt-5 mb-2">Sessions it holds</h4>
      {station.sessions.length ? <Sessions factory={factory} rows={station.sessions} now={now} workflow station={false} />
        : <p className="text-sm text-muted">None live, suspended or failed.</p>}
      <h4 className="mt-5 mb-2">Claims it holds</h4>
      {station.claims.length ? station.claims.map((claim) => <ClaimRow key={claim.id} claim={claim} now={now} onRelease={onRelease} />)
        : <p className="text-sm text-muted">None.</p>}
    </Card>
  );
}

function CiOpen({ ci, factory, now }: { ci: Ci; factory: string; now: number }) {
  return (
    <Card className="p-4 sm:p-5">
      <h3>CI</h3>
      <p className="mt-1 text-sm text-muted">Every CI job is a station of its own that comes and goes: they are one entry here. A CI station takes no commands.</p>
      <h4 className="mt-5 mb-2">Recent jobs</h4>
      {ci.jobs.length ? <Sessions factory={factory} rows={ci.jobs} now={now} workflow /> : <p className="text-sm text-muted">No session has run in CI.</p>}
      <h4 className="mt-5 mb-2">Check pushes</h4>
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
                <td>{formatAgoAt(check.at, now)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : <p className="text-sm text-muted">No <code>asf check</code> pushed yet: the optional CI workflow does that.</p>}
    </Card>
  );
}
