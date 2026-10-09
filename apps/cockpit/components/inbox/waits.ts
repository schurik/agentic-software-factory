/**
 * A wait as the Inbox and the gate's drawer name it: its key in the address,
 * what asked for its session, and why it is the viewer's own.
 */
import type { ForYou, Row } from "@/convex/model/inbox";
import { repoKey } from "@/convex/forge/forge";


/** A wait's key, `owner/repo/session`: what the inbox's address opens. */
export function keyOf({ factory, session }: Pick<Row, "factory" | "session">): string {
  return `${factory}/${session}`;
}

/** A wait's key as its factory and session: `keyOf` the other way. */
export function splitKey(key: string): { factory: string; session: string } {
  const at = key.lastIndexOf("/");
  return { factory: key.slice(0, at), session: key.slice(at + 1) };
}

/** The rows of `factory`'s sessions — Now narrowed, as a Factory page links to it — or every one when none is named. */
export function onlyOf<R extends { factory: string }>(rows: R[], factory: string | undefined): R[] {
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
