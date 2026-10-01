import { liveness, type SteeringView } from "@/convex/model/command";
import type { Summary } from "@/convex/model/session";
import type { Story } from "@/convex/model/story";
import { formatClock, inboxHref } from "../format";

/**
 * The one thing a person can do about a session right now, and — while the
 * cockpit cannot do it — why not and where to do it instead. The session
 * page never offers a button that does nothing: a verb the station would
 * refuse, or that is already on its way, is shown disabled with the reason.
 */
export interface Action {
  label: string;
  href: string | null;              // a link that works, or null for a verb
  command: "kill" | null;           // the command the button queues, when it is one
  disabledBecause: string;          // "" when it can be used
  note: string;                     // what the person should know before pressing it, or ""
}

const verb = (label: string, disabledBecause: string, command: Action["command"] = null, note = ""): Action =>
  ({ label, href: null, command, disabledBecause, note });

export function actionFor(factory: string, session: string, summary: Summary, story: Story,
                          steering: SteeringView | null | undefined, now: number): Action | null {
  const name = steering?.station?.name || story.station.name;
  const at = name ? ` on ${name}` : " on its station";
  switch (summary.status) {
    case "running":
      return killAction(session, at, steering, now);
    // The inbox is where answering happens, and it says there whether this
    // wait can be answered from the cockpit and, if not, why not.
    case "waiting":
      return { label: "Answer in inbox", href: inboxHref(factory, session), command: null, disabledBecause: "", note: "" };
    case "fail":
      return verb("Resume", `resuming from the cockpit arrives with the rest of the station commands — ` +
                            `for now, \`asf resume ${session}\`${at}`);
    case "success":
      return summary.prUrl ? { label: "Open pull request", href: summary.prUrl, command: null, disabledBecause: "", note: "" } : null;
    default:
      return null;
  }
}

/**
 * Kill: queued for the station holding the session, carried out by the run
 * itself while it is attended and by the station loop otherwise, and done
 * only when the station says so. A station that is offline gets it when it is
 * back — until the kill expires.
 */
function killAction(session: string, at: string, steering: SteeringView | null | undefined, now: number): Action {
  const label = "Kill session";
  if (!steering) return verb(label, `the cockpit has not heard from this session's station — \`asf kill ${session}\`${at}`);
  if (steering.killRefused !== null) return verb(label, steering.killRefused);
  const station = steering.station?.name ?? "the station";
  const live = liveness(steering.station?.seenAt ?? 0, steering.attendedAt, now);
  const reachable = live.attended || live.online;
  const kill = steering.kill;
  const open = kill !== null && (kill.state === "queued" || kill.state === "delivered") && now <= kill.expiresAt;
  if (kill !== null && open) {
    if (kill.state === "delivered") return verb(label, `sent to ${station} by ${kill.by}: waiting for it to say it stopped`);
    return verb(label, reachable ? `queued by ${kill.by}: ${station} takes it within seconds`
      : `queued, station offline: ${station} takes it when it is back, until ${formatClock(new Date(kill.expiresAt).toISOString())}`);
  }
  if (kill?.state === "done") return verb(label, `killed by ${kill.by}: ${kill.detail || "the run is stopping"}`);
  const note = kill?.state === "refused" ? `${station} refused the last kill: ${kill.detail}`
    : reachable ? "" : `${station} is offline: a kill waits for it, and expires if it does not come back in time`;
  return verb(label, "", "kill", note);
}
