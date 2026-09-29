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
 *
 * A batch is stored in one transaction, so it has a size: at most MAX_EVENTS
 * events and MAX_BATCH_BYTES of payload. A station sends a longer backlog as
 * several batches, which it has to anyway — it resumes from `acked`.
 */
import { v } from "convex/values";

export const MAX_EVENTS = 500;
export const MAX_BATCH_BYTES = 4_000_000;
// Under Convex's 1 MiB document limit, with room for the fields around it.
export const MAX_PAYLOAD_BYTES = 900_000;

export interface WireEvent {
  seq: number;
  ts: string;
  kind: string;
  v: number;
  payload: Record<string, unknown>;
}

/**
 * An event as the cockpit stores it: the payload kept as the JSON text it
 * arrived as. Convex refuses some keys in a stored object (a leading `$`,
 * non-ASCII), and a payload is the factory's to shape, not the cockpit's — so
 * it is stored as text and parsed when read, and nothing a factory writes can
 * make a batch unstorable.
 */
export const storedEventFields = {
  seq: v.number(),
  ts: v.string(),
  kind: v.string(),
  v: v.number(),
  payload: v.string(),
};

export interface StoredEvent {
  seq: number;
  ts: string;
  kind: string;
  v: number;
  payload: string;
}

export interface Batch {
  session: string;
  events: WireEvent[];
}

export interface Refusal {
  status: 400 | 413;
  error: string;
}

/** The batch in `body`, or why it is refused. Checks the envelope only — a
 * payload is never judged against its kind, so no version is ever refused. */
export function parseBatch(body: unknown): Batch | Refusal {
  if (!isRecord(body)) return bad("the body is not a JSON object");
  const { session, events } = body;
  if (typeof session !== "string" || session === "") return bad("`session` must be a non-empty string");
  if (!Array.isArray(events)) return bad("`events` must be an array");
  if (events.length > MAX_EVENTS) {
    return { status: 413, error: `a batch holds at most ${MAX_EVENTS} events; send the rest in another` };
  }
  let bytes = 0;
  for (const [index, event] of events.entries()) {
    const problem = eventProblem(event);
    if (problem) return bad(`events[${index}]: ${problem}`);
    const size = JSON.stringify(event.payload).length;
    if (size > MAX_PAYLOAD_BYTES) {
      return { status: 413, error: `events[${index}]: a payload holds at most ${MAX_PAYLOAD_BYTES} bytes` };
    }
    bytes += size;
  }
  if (bytes > MAX_BATCH_BYTES) {
    return { status: 413, error: `a batch holds at most ${MAX_BATCH_BYTES} bytes of payload; send fewer events` };
  }
  return { session, events: events as WireEvent[] };
}

export function isRefusal(parsed: Batch | Refusal): parsed is Refusal {
  return "error" in parsed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bad(error: string): Refusal {
  return { status: 400, error };
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
