/**
 * The ingest wire, as a station sends it: one session's events, in any order,
 * possibly again.
 *
 *   POST /ingest
 *   Authorization: Bearer <ingest token>
 *   {"session": "<adw_id>", "events": [{"seq", "ts", "kind", "v", "payload"}, ...]}
 *
 *   200 {"acked": <highest seq with every seq below it stored>}
 *
 * Each event is one line of the session's `events.jsonl`, unchanged. The
 * session travels beside the events rather than in them because only
 * `session_started` names it, and the factory is never on the wire at all: the
 * token says which factory is sending.
 */

export interface WireEvent {
  seq: number;
  ts: string;
  kind: string;
  v: number;
  payload: Record<string, unknown>;
}

export interface Batch {
  session: string;
  events: WireEvent[];
}

/** The batch in `body`, or why it is not one. Checks the envelope only — a
 * payload is never judged against its kind, so no version is ever refused. */
export function parseBatch(body: unknown): Batch | string {
  if (!isRecord(body)) return "the body is not a JSON object";
  const { session, events } = body;
  if (typeof session !== "string" || session === "") return "`session` must be a non-empty string";
  if (!Array.isArray(events)) return "`events` must be an array";
  for (const [index, event] of events.entries()) {
    const problem = eventProblem(event);
    if (problem) return `events[${index}]: ${problem}`;
  }
  return { session, events: events as WireEvent[] };
}

function eventProblem(event: unknown): string | null {
  if (!isRecord(event)) return "not an object";
  if (!isCount(event.seq)) return "`seq` must be an integer from 1";
  if (!isCount(event.v)) return "`v` must be an integer from 1";
  if (typeof event.ts !== "string") return "`ts` must be a string";
  if (typeof event.kind !== "string" || event.kind === "") return "`kind` must be a non-empty string";
  if (!isRecord(event.payload)) return "`payload` must be an object";
  return null;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
