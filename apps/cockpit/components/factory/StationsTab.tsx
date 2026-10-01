import type { SessionRow, StationDetail } from "@/convex/activity";
import type { ClaimView } from "@/convex/model/claim";
import { liveness } from "@/convex/model/command";
import type { Drift } from "@/convex/model/drift";
import { ClaimRow } from "../ClaimRow";
import { formatAgoAt, plural } from "../format";
import { Sessions } from "./ActivityTab";
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
  const open = stations.find((station) => station.station === selected) ?? null;
  const toggle = (station: string) => onSelect(selected === station ? null : station);
  return (
    <div className="stations">
      {stations.length === 0 && !ci.jobs.length && !ci.checks.length ? (
        <p className="muted">No station has reported yet. A checkout reports once <code>asf up</code> runs there with this cockpit&apos;s URL.</p>
      ) : (
        <table className="table">
          <thead><tr><th>station</th><th>owner</th><th>kind</th><th>last seen</th><th>drift</th></tr></thead>
          <tbody>
            {stations.map((station) => {
              const drift = driftOf(station, drifts);
              return (
                <tr key={station.station} aria-selected={station.station === selected}>
                  <td>
                    <button type="button" className="link" aria-expanded={station.station === selected} onClick={() => toggle(station.station)}>
                      <code>{station.name}</code>
                    </button>
                  </td>
                  <td>{station.owner || "—"}</td>
                  <td>{station.kind}</td>
                  <td className="small">{seenWords(station, now)}</td>
                  <td>{drift.badges.map((badge) => <span key={badge} className={`tag${drift.drifted ? " tag-wait" : ""}`}>{badge}</span>)}</td>
                </tr>
              );
            })}
            {ci.jobs.length || ci.checks.length ? (
              <tr aria-selected={selected === CI}>
                <td><button type="button" className="link" aria-expanded={selected === CI} onClick={() => toggle(CI)}>CI</button></td>
                <td>—</td>
                <td>ci</td>
                <td className="small">{plural(ci.jobs.length, "job")} · {plural(ci.checks.length, "check push")}</td>
                <td />
              </tr>
            ) : null}
          </tbody>
        </table>
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
    <section className="card">
      <h3><code>{station.name}</code></h3>
      <dl className="facts">
        <dt>Obeys</dt>
        <dd>
          {!station.registered ? <>takes no commands: <code>asf station register</code> on it</>
            : report === null ? "has never polled for commands"
            : report.verbs.join(", ") || "nothing: its asf/factory.yaml's cockpit.commands lists no verb"}
        </dd>
        <dt>Checkout</dt>
        <dd>
          {report?.head ? <code>{short(report.head)}</code> : "not reported"}
          {drift.badges.map((badge) => <span key={badge} className={`tag${drift.drifted ? " tag-wait" : ""}`}> {badge}</span>)}
        </dd>
        <dt>Watchers</dt>
        <dd>{report === null ? "not reported" : report.watchers.join(", ") || "none running"}</dd>
      </dl>
      <h4>Sessions it holds</h4>
      {station.sessions.length ? <Sessions factory={factory} rows={station.sessions} now={now} workflow station={false} />
        : <p className="muted small">None live, suspended or failed.</p>}
      <h4>Claims it holds</h4>
      {station.claims.length ? station.claims.map((claim) => <ClaimRow key={claim.id} claim={claim} now={now} onRelease={onRelease} />)
        : <p className="muted small">None.</p>}
    </section>
  );
}

function CiOpen({ ci, factory, now }: { ci: Ci; factory: string; now: number }) {
  return (
    <section className="card">
      <h3>CI</h3>
      <p className="muted small">Every CI job is a station of its own that comes and goes: they are one entry here. A CI station takes no commands.</p>
      <h4>Recent jobs</h4>
      {ci.jobs.length ? <Sessions factory={factory} rows={ci.jobs} now={now} workflow /> : <p className="muted small">No session has run in CI.</p>}
      <h4>Check pushes</h4>
      {ci.checks.length ? (
        <table className="table small">
          <thead><tr><th>ref</th><th>commit</th><th>check</th><th>by</th><th>when</th></tr></thead>
          <tbody>
            {ci.checks.map((check) => (
              <tr key={check.ref}>
                <td><code>{check.ref}</code></td>
                <td><code>{short(check.head)}</code></td>
                <td><span className={`tag ${check.ok ? "tag-ok" : "tag-bad"}`}>{check.ok ? "passing" : "failing"}</span></td>
                <td>{check.station}</td>
                <td>{formatAgoAt(check.at, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="muted small">No <code>asf check</code> pushed yet: the optional CI workflow does that.</p>}
    </section>
  );
}
