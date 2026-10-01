import { type ForYou, type Row, stationWords } from "@/convex/model/inbox";
import { repoKey } from "@/convex/forge/forge";
import { formatAgo } from "../format";

/** A wait older than this is flagged: a day is long enough for a run to be noticed missing. */
export const STALE_AFTER = 24 * 3600_000;

export function keyOf({ factory, session }: Pick<Row, "factory" | "session">): string {
  return `${factory}/${session}`;
}

/** The waits at `factory`'s sessions — the inbox a Factory page links to — or every one when none is named. */
export function onlyOf(rows: Row[], factory: string | undefined): Row[] {
  return factory ? rows.filter((row) => repoKey(row.factory) === repoKey(factory)) : rows;
}

/** What a wait asks, in a word or two: which gate, or how many questions. */
export function asks(row: Pick<Row, "kind" | "gate" | "questions">): string {
  if (row.kind === "questions") return `${row.questions || "open"} question${row.questions === 1 ? "" : "s"}`;
  return `${row.gate} gate`;
}

/** What asked for the session: its request (`#42 title`), else its issue, else a prompt. */
export function workItem(row: Pick<Row, "workItem" | "issueNumber">): string {
  return row.workItem || (row.issueNumber ? `#${row.issueNumber}` : "a prompt, no work item");
}

const WHY: Record<ForYou, string> = { triggered: "you triggered it", wrote: "you wrote the issue", assigned: "assigned to you" };

/** Why a wait is the viewer's own, in words. */
export function whyYours(reasons: ForYou[]): string {
  return `for you: ${reasons.map((reason) => WHY[reason]).join(", ")}`;
}

/**
 * The list half of the inbox: one dense row per wait, the open one marked.
 * Pure — the rows, which is open and the clock come in — so a test renders it.
 */
export function InboxList({ rows, selected, now, onSelect }: {
  rows: Row[];
  selected: string | null;
  now: number;
  onSelect: (key: string) => void;
}) {
  return (
    <ul className="inbox-list" role="listbox" aria-label="Waiting to be answered">
      {rows.map((row) => {
        const key = keyOf(row);
        const stale = now - Date.parse(row.since) > STALE_AFTER;
        return (
          <li key={key} role="option" aria-selected={key === selected}
              className={`inbox-row${key === selected ? " open" : ""}${row.blocked ? " blocked" : ""}`}>
            <button type="button" onClick={() => onSelect(key)}>
              <span className="line">
                <strong>{row.factory}</strong>
                {row.forYou.length ? <span className="tag tag-mine" title={whyYours(row.forYou)}>for you</span> : null}
                <span className={`waited${stale ? " stale" : ""}`}>{formatAgo(row.since, now)}</span>
              </span>
              <span className="line">
                <span className={`tag ${row.kind === "questions" ? "tag-wait" : "tag-gate"}`}>{asks(row)}</span>
                {row.round > 1 ? <span className="tag">round {row.round}</span> : null}
                {stale ? <span className="tag tag-bad">waiting {formatAgo(row.since, now).replace(/ ago$/, "")}</span> : null}
              </span>
              <span className="work small">{workItem(row)}</span>
              {row.blocked ? (
                <span className="why small">{row.blocked}{row.queued ? `: ${stationWords(row, now)}` : ""}</span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
