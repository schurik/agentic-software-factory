/**
 * The forge, as the cockpit asks it things: one interface, two credentials.
 *
 * In team mode the answers come through a GitHub App the team registered
 * (`app.ts`): what the cockpit itself reads goes on an installation token, and
 * what is asked or done for a person goes on that person's user access token.
 * In local mode they come through the person's own `gh auth token`
 * (`token.ts`), which is both at once. Whoever asks, asks through `Forge`, and
 * `open.ts` is the one place that picks the credential behind it.
 *
 * The forge is the authority on who may do what; the cockpit only mirrors it
 * (spec #40). So `reach()` is asked of the forge as the person, never worked
 * out here.
 */
import { type Infer, v } from "convex/values";

/** What a person may do on a repository, as the forge ranks it. */
export const roleValidator = v.union(
  v.literal("read"), v.literal("triage"), v.literal("write"), v.literal("maintain"), v.literal("admin"),
);

export const repositoryValidator = v.object({
  id: v.number(),
  /** `owner/name`, as the forge spells it. */
  name: v.string(),
  defaultBranch: v.string(),
  private: v.boolean(),
  /** When anything was last pushed to it: the cheap sign that it is worth looking at again. */
  pushedAt: v.string(),
});

export const reachValidator = v.object({ repo: v.string(), role: roleValidator });

export const personValidator = v.object({
  id: v.number(),
  login: v.string(),
  name: v.string(),
  avatarUrl: v.string(),
});

export type Role = Infer<typeof roleValidator>;
export type Repository = Infer<typeof repositoryValidator>;
export type Reach = Infer<typeof reachValidator>;
export type Person = Infer<typeof personValidator>;

export interface Forge {
  /** Every repository the cockpit's own credential reaches. */
  repositories(): Promise<Repository[]>;
  /** Whether the default branch of `repo` holds `asf/factory.yaml`. */
  holdsFactory(repo: string): Promise<boolean>;
  /** The person this forge acts for: who signed in, or whose token it is. */
  person(): Promise<Person>;
  /** Every repository that person reaches through this forge, and as what. */
  reach(): Promise<Reach[]>;
  /**
   * The bytes of `path` in `repo` at the commit `ref`, or null when the forge
   * will not show it there. A commit, never a branch: what a session wrote is
   * read where it was committed, not wherever the branch has moved since.
   */
  file(repo: string, path: string, ref: string): Promise<Uint8Array<ArrayBuffer> | null>;
}

/** Where a factory's config lives: a repository is a factory when its default branch holds this. */
export const FACTORY_FILE = "asf/factory.yaml";

/** How the cockpit keys a repository: the forge's names are case-insensitive. */
export function repoKey(name: string): string {
  return name.toLowerCase();
}
