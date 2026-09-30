/**
 * Which cockpit this deployment is, read from its environment.
 *
 * `team` is the default, and the one that asks who is looking: a GitHub App
 * the team registered, and a sign-in with it. `local` is the cockpit `asf up`
 * starts on one person's machine, bound to 127.0.0.1: there is no sign-in, and
 * the forge is asked with that person's own `gh auth token`. Local is the one
 * that has to be asked for (`COCKPIT_MODE=local`, which the stamped compose
 * file sets), so a deployment that says nothing is never the open one.
 */
export type Mode = "local" | "team";

export function mode(): Mode {
  return process.env.COCKPIT_MODE === "local" ? "local" : "team";
}

/** The person's own token, in local mode: what `gh auth token` printed for `asf up`. */
export function localToken(): string {
  return (process.env.COCKPIT_FORGE_TOKEN ?? "").trim();
}

/** The forge host that token is for. An Enterprise Server is named here; nothing assumes github.com. */
export function localHost(): string {
  return (process.env.COCKPIT_FORGE_HOST ?? "").trim() || "github.com";
}
