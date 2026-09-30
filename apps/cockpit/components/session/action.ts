import type { Summary } from "@/convex/model/session";
import type { Story } from "@/convex/model/story";
import { channelWords } from "./words";

/**
 * The one thing a person can do about a session right now, and — while the
 * cockpit cannot do it yet — why not and where to do it instead. The session
 * page never offers a button that does nothing: a verb whose command channel
 * is not built says so, and names the place it can be done today.
 */
export interface Action {
  label: string;
  href: string | null;              // a link that works, or null for a verb
  disabledBecause: string;          // "" when it can be used
}

export function actionFor(session: string, summary: Summary, story: Story): Action | null {
  const at = story.station.name ? ` on ${story.station.name}` : " on its station";
  switch (summary.status) {
    case "running":
      return { label: "Kill session", href: null,
               disabledBecause: `killing from the cockpit arrives with station commands — ` +
                                `for now, \`asf kill ${session}\`${at}` };
    case "waiting": {
      const waiting = story.now.waiting;
      const where = waiting && ["issue", "pr"].includes(waiting.channel)
        ? `reply on ${channelWords(waiting.channel, waiting.issueNumber)}`
        : `\`asf approve ${session}\` or \`asf reject ${session}\`${at}`;
      return { label: "Answer in inbox", href: null,
               disabledBecause: `answering from the cockpit arrives with the inbox — for now, ${where}` };
    }
    case "fail":
      return { label: "Resume", href: null,
               disabledBecause: `resuming from the cockpit arrives with station commands — ` +
                                `for now, \`asf resume ${session}\`${at}` };
    case "success":
      return summary.prUrl ? { label: "Open pull request", href: summary.prUrl, disabledBecause: "" } : null;
    default:
      return null;
  }
}
