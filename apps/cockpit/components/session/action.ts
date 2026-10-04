import { liveness, pending, type SteeringView } from "@/convex/model/command";
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
  command: Command | null;          // the command the button queues, when it is one
  disabledBecause: string;          // "" when it can be used
  note: string;                     // what the person should know before pressing it, or ""
}

export type Command = "kill" | "resume";

const verb = (label: string, disabledBecause: string, command: Action["command"] = null, note = ""): Action =>
  ({ label, href: null, command, disabledBecause, note });

export function actionFor(factory: string, session: string, summary: Summary, story: Story,
                          steering: SteeringView | null | undefined, now: number,
                          who: (login: string) => string = (login) => login): Action | null {
  const name = steering?.station?.name || story.station.name;
  const at = name ? ` on ${name}` : " on its station";
  switch (summary.status) {
    case "running":
      return commandAction("kill", { session, at, who }, steering, now);
    // The inbox is where answering happens, and it says there whether this
    // wait can be answered from the cockpit and, if not, why not.
    case "waiting":
      return { label: "Answer in inbox", href: inboxHref(factory, session), command: null, disabledBecause: "", note: "" };
    case "fail":
      return commandAction("resume", { session, at, who }, steering, now);
    case "success":
      return summary.prUrl ? { label: "Open pull request", href: summary.prUrl, command: null, disabledBecause: "", note: "" } : null;
    default:
      return null;
  }
}

const WORDS: Record<Command, { label: string; cli: string; awaited: string; done: string; going: string }> = {
  kill: { label: "Kill session", cli: "asf kill", awaited: "say it stopped", done: "killed", going: "the run is stopping" },
  resume: { label: "Resume", cli: "asf resume", awaited: "say it relaunched", done: "resumed", going: "the run goes on" },
};

/**
 * Kill a running session, or resume a failed one: queued for the station
 * holding it — carried out by the run itself while it is attended and by the
 * station loop otherwise — and done only when the station says so. A station
 * that is offline gets it when it is back, until the command expires.
 */
function commandAction(command: Command, { session, at, who }: { session: string; at: string; who: (login: string) => string },
                       steering: SteeringView | null | undefined, now: number): Action {
  const { label, cli, awaited, done, going } = WORDS[command];
  if (!steering) return verb(label, `the cockpit has not heard from this session's station — \`${cli} ${session}\`${at}`);
  const refused = command === "kill" ? steering.killRefused : steering.resumeRefused;
  if (refused !== null) return verb(label, refused);
  const station = steering.station?.name ?? "the station";
  const live = liveness(steering.station?.seenAt ?? 0, steering.attendedAt, now);
  const reachable = live.attended || live.online;
  const last = command === "kill" ? steering.kill : steering.resume;
  if (last !== null && pending(last, now)) {
    if (last.state === "delivered") return verb(label, `sent to ${station} by ${who(last.by)}: waiting for it to ${awaited}`);
    return verb(label, reachable ? `queued by ${who(last.by)}: ${station} takes it within seconds`
      : `queued, station offline: ${station} takes it when it is back, until ${formatClock(new Date(last.expiresAt).toISOString())}`);
  }
  if (last?.state === "done") return verb(label, `${done} by ${who(last.by)}: ${last.detail || going}`);
  const note = last?.state === "refused" ? `${station} refused the last ${command}: ${last.detail}`
    : reachable ? "" : `${station} is offline: a ${command} waits for it, and expires if it does not come back in time`;
  return verb(label, "", command, note);
}
