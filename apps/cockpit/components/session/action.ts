import { liveness, pending, type SteeringView } from "@/convex/model/command";
import { permitted } from "@/convex/model/inbox";
import type { Summary } from "@/convex/model/session";
import type { Story } from "@/convex/model/story";
import { formatClock } from "../format";

/**
 * The one thing a person can do about a session right now, in its header
 * (#104) — and, while the cockpit cannot do it, why not and where to do it
 * instead. The session page never offers a button that does nothing: a verb
 * the station would refuse, or that is already on its way, is shown disabled
 * with the reason.
 *
 *   done                        → its pull request
 *   waiting on someone else     → whom it waits on, in words
 *   running                     → Kill
 *   failed, station online      → Resume
 *   failed, station away        → Queue resume, if it is back within the hour
 *
 * A gate waiting on the viewer is not here: answering starts on the Now card.
 */
export type Action =
  | { kind: "link"; label: string; href: string }
  | { kind: "words"; label: string }
  | { kind: "command"; label: string; command: Command;
      disabledBecause: string;      // "" when it can be used
      note: string };               // what the person should know before pressing it, or ""

export type Command = "kill" | "resume";

const verb = (command: Command, label: string, disabledBecause: string, note = ""): Action =>
  ({ kind: "command", label, command, disabledBecause, note });

/** Whom a session's wait is on: the viewer — anyone the factory hears, when it names nobody — or the people it names. */
export function waitsOn(summary: Summary, viewer: string | null): { mine: boolean; on: string[] } {
  const trusted = summary.waitingFor?.trusted ?? null;
  return { mine: permitted(trusted, viewer), on: trusted ?? [] };
}

export function actionFor(session: string, summary: Summary, story: Story, steering: SteeringView | null | undefined, now: number,
                          { viewer = null, who = (login) => login }: { viewer?: string | null; who?: (login: string) => string } = {}): Action | null {
  const name = steering?.station?.name || story.station.name;
  const at = name ? ` on ${name}` : " on its station";
  switch (summary.status) {
    case "running":
      return commandAction("kill", { session, at, who }, steering, now);
    case "waiting": {
      const { mine, on } = waitsOn(summary, viewer);
      return mine ? null : { kind: "words", label: `Waiting on ${on.map(who).join(", ")}` };
    }
    case "fail":
      return commandAction("resume", { session, at, who }, steering, now);
    case "success":
      return summary.prUrl ? { kind: "link", label: `Pull request #${summary.prUrl.split("/").pop()}`, href: summary.prUrl } : null;
    default:
      return null;
  }
}

const WORDS: Record<Command, { label: string; cli: string; awaited: string; done: string; going: string }> = {
  kill: { label: "Kill", cli: "asf kill", awaited: "say it stopped", done: "killed", going: "the run is stopping" },
  resume: { label: "Resume", cli: "asf resume", awaited: "say it relaunched", done: "resumed", going: "the run goes on" },
};

/**
 * Kill a running session, or resume a failed one: queued for the station
 * holding it — carried out by the run itself while it is attended and by the
 * station loop otherwise — and done only when the station says so. A station
 * that is away gets it when it is back, until the command expires: a resume
 * waits an hour for it (`TTL.resume`), which is what "Queue resume" promises.
 */
function commandAction(command: Command, { session, at, who }: { session: string; at: string; who: (login: string) => string },
                       steering: SteeringView | null | undefined, now: number): Action {
  const { label, cli, awaited, done, going } = WORDS[command];
  if (!steering) return verb(command, label, `the cockpit has not heard from this session's station — \`${cli} ${session}\`${at}`);
  const refused = command === "kill" ? steering.killRefused : steering.resumeRefused;
  if (refused !== null) return verb(command, label, refused);
  const station = steering.station?.name ?? "the station";
  const live = liveness(steering.station?.seenAt ?? 0, steering.attendedAt, now);
  const reachable = live.attended || live.online;
  const last = command === "kill" ? steering.kill : steering.resume;
  if (last !== null && pending(last, now)) {
    if (last.state === "delivered") return verb(command, label, `sent to ${station} by ${who(last.by)}: waiting for it to ${awaited}`);
    return verb(command, label, reachable ? `queued by ${who(last.by)}: ${station} takes it within seconds`
      : `queued, station offline: ${station} takes it when it is back, until ${formatClock(new Date(last.expiresAt).toISOString())}`);
  }
  if (last?.state === "done") return verb(command, label, `${done} by ${who(last.by)}: ${last.detail || going}`);
  const refusedLast = last?.state === "refused" ? `${station} refused the last ${command}: ${last.detail}` : "";
  if (reachable) return verb(command, label, "", refusedLast);
  if (command === "resume") {
    return verb(command, "Queue resume", "", refusedLast || `${station} is away: it resumes if the station is back within the hour`);
  }
  return verb(command, label, "", refusedLast || `${station} is offline: a kill waits for it, and expires if it does not come back in time`);
}
