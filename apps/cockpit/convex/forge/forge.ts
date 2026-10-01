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

/** A label a repository defines, as its forge describes it. */
export interface Label {
  name: string;
  description: string;
}

/** An issue as the cockpit needs it before labelling one: what it is, and whether it is still open. */
export interface Issue {
  number: number;
  title: string;
  open: boolean;
  /** A pull request, which the forge also serves as an issue. */
  pull: boolean;
  url: string;
  labels: string[];
}

/** Two commits' distance, as the forge counts it. */
export interface Distance {
  ahead: number;
  behind: number;
}

/** A file as a commit should hold it: its path from the repository's root, and its whole text. */
export interface Change {
  path: string;
  content: string;
}

/** A pull request to open: from branch `head` into branch `base`. */
export interface Proposal {
  head: string;
  base: string;
  title: string;
  body: string;
}

/** A pull request as the forge opened it. */
export interface Pull {
  number: number;
  url: string;
}

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
  /**
   * The forge's diff of `base` and `head` in `repo`, or null when it will not
   * show one: two commits, so what is shown is what was asked about.
   */
  compare(repo: string, base: string, head: string): Promise<string | null>;
  /** The commit `branch` of `repo` is at, or null when the forge will not show it. */
  tip(repo: string, branch: string): Promise<string | null>;
  /**
   * Every file under the directory `dir` of `repo` at the commit `ref`, by
   * its path from the repository's root, or null when the forge will not
   * show them.
   */
  paths(repo: string, ref: string, dir: string): Promise<string[] | null>;
  /**
   * How far the commit `head` is from `base` in `repo`: commits it has that
   * `base` lacks (ahead) and the other way round (behind) — or null when the
   * forge will not compare the two.
   */
  distance(repo: string, base: string, head: string): Promise<Distance | null>;
  /**
   * Post `body` on issue (or pull request) `number` of `repo`, AS the person
   * this forge acts for — never as the cockpit: what the factory hears is a
   * person's comment, checked against its own trust list. The comment's URL.
   */
  comment(repo: string, number: number, body: string): Promise<{ url: string }>;
  /** Every label `repo` defines, or null when the forge will not show them. */
  labels(repo: string): Promise<Label[] | null>;
  /** Issue (or pull request) `number` of `repo`, or null when the forge shows none. */
  issue(repo: string, number: number): Promise<Issue | null>;
  /**
   * Add `labels` to issue `number` of `repo`, AS the person this forge acts
   * for: the forge's `labeled` event names them, and a factory's watcher
   * records whoever that names as having triggered the run it starts.
   */
  label(repo: string, number: number, labels: string[]): Promise<void>;
  /**
   * Take `label` off issue `number` of `repo`, AS the person this forge acts
   * for. A label the issue does not carry is already off: not an error.
   */
  unlabel(repo: string, number: number, label: string): Promise<void>;
  /**
   * A commit on top of commit `base` of `repo` in which each of `changes`
   * holds exactly its text and every other file is as `base` has it — made
   * AS the person this forge acts for, who is its author. It is on no branch
   * yet (`branch`). Its sha.
   */
  commit(repo: string, base: string, changes: Change[], message: string): Promise<string>;
  /**
   * Branch `name` of `repo`, made at commit `sha` AS the person this forge
   * acts for. False, and nothing made, when a branch of that name exists.
   */
  branch(repo: string, name: string, sha: string): Promise<boolean>;
  /** A pull request on `repo`, opened AS the person this forge acts for: its author is them, never the cockpit. */
  pull(repo: string, proposal: Proposal): Promise<Pull>;
}

/** Where a factory's config lives: a repository is a factory when its default branch holds this. */
export const FACTORY_FILE = "asf/factory.yaml";

/** Roles from least to most: what a check for "this or higher" compares by. */
const RANK: Role[] = ["read", "triage", "write", "maintain", "admin"];

/** Whether `role` is `floor` or higher; null, the forge said nothing, is not. */
export function atLeast(role: Role | null, floor: Role): boolean {
  return role !== null && RANK.indexOf(role) >= RANK.indexOf(floor);
}

/** How the cockpit keys a repository: the forge's names are case-insensitive. */
export function repoKey(name: string): string {
  return name.toLowerCase();
}
