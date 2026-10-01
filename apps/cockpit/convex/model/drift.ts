/**
 * How far a station's config is from its factory's (spec #40).
 *
 * The default branch IS the factory's config. A station never sends its
 * config, only where it stands — in every command poll's report, the commit
 * its checkout has out and a hash over its `asf/` files — and the cockpit
 * works out the rest: how many commits behind the default branch that is (the
 * forge's comparison), and whether its files are the default branch's (the
 * hash the CI station's self-description carried from there).
 *
 * Drift is about the CONFIG. A station three commits behind whose `asf/`
 * hashes like the default branch's still says so, but is not drifted: what it
 * runs is what the repository says. What it cannot know, it says.
 */

/** Where a station's checkout stands, as its last report put it. */
export interface Standing {
  head: string;
  configHash: string;
}

/** The default branch: its commit, and its config's hash when a check measured it at that commit. */
export interface Reference {
  head: string | null;
  configHash: string | null;
}

/** The forge's word on station head vs default branch; null when it would not say, undefined when not asked. */
export type Distance = { ahead: number; behind: number } | null | undefined;

export interface Drift {
  badges: string[];
  drifted: boolean;
}

export function drift(standing: Standing, reference: Reference, distance: Distance): Drift {
  if (!standing.head) return { badges: ["no report yet"], drifted: false };
  if (!reference.head) return { badges: ["default branch unknown"], drifted: false };
  const sameConfig = reference.configHash && standing.configHash ? reference.configHash === standing.configHash : null;
  if (standing.head === reference.head) {
    return sameConfig === false ? { badges: ["local edits"], drifted: true } : { badges: [], drifted: false };
  }
  if (distance === undefined) return { badges: [`on ${standing.head.slice(0, 7)}`], drifted: sameConfig !== true };
  if (distance === null) return { badges: ["on a commit the forge does not show"], drifted: sameConfig !== true };
  const badges = [
    ...(distance.behind > 0 ? [commits(distance.behind, "behind")] : []),
    ...(distance.ahead > 0 ? [commits(distance.ahead, "ahead")] : []),
  ];
  return { badges, drifted: sameConfig === true ? false : distance.behind > 0 || sameConfig === false };
}

function commits(count: number, where: string): string {
  return `${count} ${count === 1 ? "commit" : "commits"} ${where}`;
}
