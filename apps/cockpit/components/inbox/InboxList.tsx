import { type ForYou, type Row, stationWords } from "@/convex/model/inbox";
import { repoKey } from "@/convex/forge/forge";
import { formatAgo } from "../format";
import { asks } from "../gate/answer";
import { cx, Tag } from "../ui";

/** A wait older than this is flagged: a day is long enough for a run to be noticed missing. */
export const STALE_AFTER = 24 * 3600_000;

export function keyOf({ factory, session }: Pick<Row, "factory" | "session">): string {
  return `${factory}/${session}`;
}

/** The waits at `factory`'s sessions — the inbox a Factory page links to — or every one when none is named. */
export function onlyOf(rows: Row[], factory: string | undefined): Row[] {
  return factory ? rows.filter((row) => repoKey(row.factory) === repoKey(factory)) : rows;
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
 * The inbox's list: one dense row per wait, the one the keys are on marked;
 * a row opens its gate in the drawer.
 * Pure — the rows, which is open and the clock come in — so a test renders it.
 */
export function InboxList({ rows, selected, now, onSelect }: {
  rows: Row[];
  selected: string | null;
  now: number;
  onSelect: (key: string) => void;
}) {
  return (
    <ul role="listbox" aria-label="Waiting to be answered"
        className="overflow-hidden rounded-xl border border-line bg-surface shadow-card">
      {rows.map((row) => {
        const key = keyOf(row);
        const open = key === selected;
        const stale = now - Date.parse(row.since) > STALE_AFTER;
        return (
          <li key={key} role="option" aria-selected={open} className="border-b border-line last:border-b-0">
            <button type="button" onClick={() => onSelect(key)}
                    className={cx("grid w-full gap-1 px-3.5 py-2.5 text-left hover:bg-surface-2",
                                  open && "bg-surface-2 shadow-[inset_3px_0_var(--accent)]")}>
              <span className="flex flex-wrap items-center gap-1.5">
                <strong className={cx("min-w-0 font-medium", row.blocked && "text-muted")}>{row.factory}</strong>
                {row.forYou.length ? <Tag tone="mine" title={whyYours(row.forYou)}>for you</Tag> : null}
                <span className={cx("ml-auto text-xs tabular-nums", stale ? "text-bad" : "text-muted")}>{formatAgo(row.since, now)}</span>
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                <Tag tone={row.kind === "questions" ? "wait" : "run"}>{asks(row)}</Tag>
                {row.round > 1 ? <Tag>round {row.round}</Tag> : null}
                {stale ? <Tag tone="bad">waiting {formatAgo(row.since, now).replace(/ ago$/, "")}</Tag> : null}
              </span>
              <span className="truncate text-sm text-muted">{workItem(row)}</span>
              {row.blocked ? (
                <span className="text-sm text-muted italic">{row.blocked}{row.queued ? `: ${stationWords(row, now)}` : ""}</span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
