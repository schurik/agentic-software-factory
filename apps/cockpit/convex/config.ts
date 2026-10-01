/**
 * A config edit becomes a pull request opened AS THE VIEWER (spec #40, #58).
 *
 * The repository is the source of truth for a factory's config, and the
 * cockpit never becomes one: from the Config tab a writer edits the real
 * files under `asf/` as text, and what they typed is committed — byte for
 * byte, comments and all — on top of the commit the editor read the files
 * at, on a `cockpit/<login>/<slug>` branch, and proposed to the default
 * branch as a pull request. Through the team's App on the person's own user
 * access token, or with the token a local cockpit holds: the commit and the
 * pull request are theirs. The cockpit checks YAML syntax and nothing more
 * (`model/config.ts`); the repository's CI checks the rest, and its branch
 * protection governs the merge.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, type ActionCtx, internalQuery, type QueryCtx } from "./_generated/server";
import { type Change, repoKey } from "./forge/forge";
import { ForgeError } from "./forge/github";
import { forgeSaid, open, UNREADABLE } from "./forge/open";
import { asEdited, branchFor, type Edited, editRefusal, outsideConfig, proposalProblem, provenance } from "./model/config";
import { actAs, canRead, roleOn, viewing, type Viewing } from "./viewer";

type Refused = { ok: false; because: string };

/** A config file's bytes, as text, or why they cannot be edited here. */
type Read = { ok: true; text: string } | Refused;

export type Proposed = { ok: true; number: number; url: string; branch: string; paths: string[] } | Refused;

/** How many branch names a proposal tries — `<slug>`, `<slug>-2`, … — before it says they are taken. */
const BRANCH_TRIES = 20;

async function repoOf(ctx: QueryCtx, factory: string): Promise<Doc<"repos"> | null> {
  return await ctx.db.query("repos").withIndex("by_key", (q) => q.eq("key", repoKey(factory))).unique();
}

/**
 * Why `who` may not edit `factory`'s config, or null when they may: someone
 * to open the pull request as, a default branch on the forge to propose it
 * to, and write or higher there as the forge last said — in a local cockpit
 * too, whose token may reach a repository it cannot push to.
 */
export async function editing(ctx: QueryCtx, who: Viewing, factory: string): Promise<string | null> {
  if (who.viewer === null) {
    return who.mode === "team" ? "sign in to edit the config"
      : "this cockpit holds no forge token to open a pull request with: run `gh auth login`, then `asf up` again";
  }
  const repo = await repoOf(ctx, factory);
  if (repo === null || !repo.factory || !repo.defaultBranch) {
    return "the forge does not show this factory, so there is no default branch to propose a change to";
  }
  return editRefusal(await roleOn(ctx, who.viewer, factory));
}

/** Who is asking, whether they may read `factory` and edit its config, and what a proposal of theirs needs. */
export const asking = internalQuery({
  args: { factory: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory, signIn }): Promise<{
    reads: boolean; because: string | null; actor: Id<"viewers"> | null; login: string; into: string;
  }> => {
    const who = await viewing(ctx, signIn);
    const reads = await canRead(ctx, who, factory);
    const repo = await repoOf(ctx, factory);
    return {
      reads,
      because: reads || who.viewer === null ? await editing(ctx, who, factory) : UNREADABLE,
      actor: who.mode === "team" && who.viewer !== null ? who.viewer._id : null,
      login: who.viewer?.login ?? "",
      into: repo?.defaultBranch ?? "",
    };
  },
});

/** `bytes` as text, exactly — a byte-order mark kept — or null when they are not UTF-8. */
function text(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** `path` of `factory` at `ref`, as text, read on the cockpit's own credential. */
async function readAt(ctx: ActionCtx, factory: string, path: string, ref: string): Promise<Read> {
  const opened = await open(ctx);
  if (opened === null) return { ok: false, because: "this cockpit has no forge credential to read the file with" };
  try {
    const bytes = await opened.forge.file(factory, path, ref);
    if (bytes === null) return { ok: false, because: `${path} is not on the forge at ${ref.slice(0, 7)}` };
    const read = text(bytes);
    return read === null ? { ok: false, because: `${path} is not text, so it is not edited here` } : { ok: true, text: read };
  } catch (error) {
    return forgeSaid(error);
  } finally {
    await opened.close();
  }
}

/**
 * The text of the config file `path` of `factory` at the commit `ref` — the
 * one the Config tab lists the files at — for a viewer who may read it, as
 * the editor holds it (`asEdited`: LF, and whether the file's own endings
 * are CRLF). Shown and forgotten: the cockpit keeps no file bodies.
 */
export const read = action({
  args: { factory: v.string(), path: v.string(), ref: v.string(), signIn: v.optional(v.string()) },
  handler: async (ctx, { factory, path, ref, signIn }): Promise<Edited> => {
    const asked: { reads: boolean } = await ctx.runQuery(internal.config.asking, { factory, signIn });
    if (!asked.reads) return { ok: false, because: UNREADABLE };
    const outside = outsideConfig(path);
    if (outside !== null) return { ok: false, because: outside };
    const read = await readAt(ctx, factory, path, ref);
    return read.ok ? asEdited(read.text) : read;
  },
});

/**
 * Propose `files` — each one's whole new text, byte for byte as it is to be
 * committed (`asCommitted` gives a CRLF file its endings back) — as a pull request on
 * `factory`, as the viewer: committed on top of `base`, the commit the
 * editor read them at, on a fresh `cockpit/<login>/<slug>` branch, into the
 * default branch, with a body that says where it came from. What the forge
 * would refuse, or the editor would have blocked — below write, YAML that
 * does not parse, a file outside `asf/` or not at `base` — is refused here
 * first, and nothing is pushed then. Files that did not change are left out;
 * a proposal in which none did is refused.
 */
export const propose = action({
  args: {
    factory: v.string(),
    base: v.string(),
    files: v.array(v.object({ path: v.string(), content: v.string() })),
    title: v.string(),
    description: v.optional(v.string()),
    signIn: v.optional(v.string()),
  },
  handler: async (ctx, { factory, base, files, title, description = "", signIn }): Promise<Proposed> => {
    const asked: { because: string | null; actor: Id<"viewers"> | null; login: string; into: string } =
      await ctx.runQuery(internal.config.asking, { factory, signIn });
    if (asked.because !== null) return { ok: false, because: asked.because };
    const problem = proposalProblem(files, title);
    if (problem !== null) return { ok: false, because: problem };

    const changed: Change[] = [];
    for (const file of files) {
      const was = await readAt(ctx, factory, file.path, base);
      if (!was.ok) return was;
      if (was.text !== file.content) changed.push(file);
    }
    if (changed.length === 0) return { ok: false, because: `nothing changed: every file is as ${base.slice(0, 7)} holds it` };
    changed.sort((a, b) => a.path.localeCompare(b.path));
    const paths = changed.map(({ path }) => path);

    let user: string | undefined;
    try {
      if (asked.actor !== null) user = await actAs(ctx, asked.actor);
    } catch (error) {
      if (error instanceof ForgeError && error.status === 401) {
        return { ok: false, because: "your sign-in has run out: sign in again to edit the config" };
      }
      throw error;
    }
    const opened = await open(ctx, { user });
    if (opened === null) return { ok: false, because: "this cockpit has no forge credential to open a pull request with" };
    try {
      const { forge } = opened;
      const message = description.trim() ? `${title.trim()}\n\n${description.trim()}\n` : `${title.trim()}\n`;
      const sha = await forge.commit(factory, base, changed, message);
      const slug = branchFor(asked.login, title);
      let branch: string | null = null;
      for (let attempt = 1; attempt <= BRANCH_TRIES && branch === null; attempt += 1) {
        const name = attempt === 1 ? slug : `${slug}-${attempt}`;
        if (await forge.branch(factory, name, sha)) branch = name;
      }
      if (branch === null) return { ok: false, because: `${slug} and the next ${BRANCH_TRIES - 1} names after it are taken: retitle it` };
      const body = provenance({ login: asked.login, into: asked.into, base, paths, description });
      const pull = await forge.pull(factory, { head: branch, base: asked.into, title: title.trim(), body });
      return { ok: true, ...pull, branch, paths };
    } catch (error) {
      return forgeSaid(error);
    } finally {
      await opened.close();
    }
  },
});
