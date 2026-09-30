/**
 * A session's repo artifacts, read from the forge.
 *
 * A handoff file travels inline in its `artifact_written` and is on the page
 * already. A repo file — the spec, the doc — travels only as a path, because
 * it is committed on the session's branch: the cockpit reads it from the forge
 * at the sha of the commit after it was written (`model/phase.ts` says which),
 * never at the branch tip, which later phases, or people, have moved on
 * (CLAUDE.md, invariant 11). What is read is shown and forgotten; the cockpit
 * stores no file bodies.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalQuery } from "./_generated/server";
import { ForgeError, RateLimited } from "./forge/github";
import { open } from "./forge/open";
import { Payload } from "./model/payload";
import { phaseView } from "./model/session";
import { storedSession } from "./sessions";

/** The most of a file the cockpit shows, as the factory caps a handoff file (`BODY_BYTES`). */
export const READ_BYTES = 256 * 1024;

export type Read =
  | { ok: true; sha: string; content: string; truncated: boolean; binary: boolean;
      matches: boolean }        // whether the bytes at `sha` are the ones the phase wrote (its digest)
  | { ok: false; because: string };

interface Located {
  repo: string;
  path: string;
  sha: string;
  digest: string;
}

/** Where the repo artifact written at `seq` is on the forge, if the viewer may see its session and it is anywhere. */
export const locate = internalQuery({
  args: { factory: v.string(), session: v.string(), seq: v.number(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory, session, seq, signIn }): Promise<Located | { because: string }> => {
    const stored = await storedSession(ctx, factory, session, signIn);
    const event = stored?.events.find((each) => each.seq === seq && each.kind === "artifact_written");
    if (!stored || !event) return { because: "no such artifact in a session you can see" };
    const phaseId = Payload.parse(event.payload).str("phase_id");
    const artifact = phaseView(stored.events, stored.acked, phaseId)?.artifacts.find((each) => each.seq === seq);
    if (!artifact || artifact.location !== "repo") return { because: "not a repository file: it travelled with the session" };
    if (artifact.rewritten) {
      return { because: `${artifact.rewritten.phase || "a later phase"} wrote it again before anything committed it, so this version never reached the forge` };
    }
    if (!artifact.committed) return { because: "not committed yet: a repository file is read from the forge at the commit after it" };
    return { repo: factory, path: artifact.path, sha: artifact.committed.sha, digest: artifact.digest };
  },
});

export const read = action({
  args: { factory: v.string(), session: v.string(), seq: v.number(), signIn: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Read> => {
    const located: Located | { because: string } = await ctx.runQuery(internal.artifacts.locate, args);
    if ("because" in located) return { ok: false, because: located.because };
    const opened = await open(ctx);
    if (opened === null) return { ok: false, because: "this cockpit has no forge credential to read it with" };
    let bytes: Uint8Array<ArrayBuffer> | null;
    try {
      bytes = await opened.forge.file(located.repo, located.path, located.sha);
    } catch (error) {
      if (!(error instanceof ForgeError || error instanceof RateLimited)) throw error;
      return { ok: false, because: error.message };
    } finally {
      await opened.close();
    }
    if (bytes === null) {
      return { ok: false, because: `the forge does not show ${located.path} at ${located.sha.slice(0, 7)} ` +
                                   "to this cockpit: the branch may not be pushed, or was deleted" };
    }
    return { ok: true, sha: located.sha, ...(await shown(bytes)), matches: (await sha256(bytes)) === located.digest };
  },
});

/** A file's bytes as the page shows them: text up to the cap, and nothing of a file that is not text. */
async function shown(bytes: Uint8Array): Promise<{ content: string; truncated: boolean; binary: boolean }> {
  // The factory's own test for "not text": a NUL anywhere in it.
  if (bytes.includes(0)) return { content: "", truncated: false, binary: true };
  const truncated = bytes.length > READ_BYTES;
  // `stream` leaves a character the cap cut in half undecoded rather than mangled.
  const content = new TextDecoder().decode(truncated ? bytes.subarray(0, READ_BYTES) : bytes, { stream: truncated });
  return { content, truncated, binary: false };
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
