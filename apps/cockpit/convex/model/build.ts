import { v, type Infer } from "convex/values";

/**
 * Which build of the cockpit this is: what CI baked into the image as it built
 * it (Dockerfile, "Which build this is"), read when a page is served and by
 * `docker/start.sh` as it records a deploy. Every field is "" in a build CI did
 * not make — `docker compose up --build`, `next dev` — which is a local build.
 *
 *   ref      what was built: `main` for a deploy, `vX.Y.Z` for a release
 *   version  `.claude-plugin/plugin.json`'s at that commit: the release it is,
 *            or, on main, the last one cut before it
 *   commit   the full sha
 *   builtAt  when the build began, ISO 8601
 *   number   the workflow run's number, and runUrl the run itself
 *   source   the repository, where `commit` links to
 */
export const buildValidator = v.object({
  ref: v.string(),
  version: v.string(),
  commit: v.string(),
  builtAt: v.string(),
  number: v.string(),
  runUrl: v.string(),
  source: v.string(),
});

export type Build = Infer<typeof buildValidator>;

/** The build an environment names: the image's COCKPIT_BUILD_* variables. */
export function buildFromEnv(env: Record<string, string | undefined>): Build {
  const read = (name: string) => (env[`COCKPIT_BUILD_${name}`] ?? "").trim();
  return {
    ref: read("REF"),
    version: read("VERSION"),
    commit: read("COMMIT"),
    builtAt: read("TIME"),
    number: read("NUMBER"),
    runUrl: read("RUN_URL"),
    source: read("SOURCE").replace(/\/+$/, ""),
  };
}

/** Whether CI built it: a local build knows no commit. */
export function isCiBuild(build: Build): boolean {
  return build.commit !== "";
}

/** The same image started again — a restart, not a deploy. */
export function sameBuild(a: Build, b: Build): boolean {
  return a.commit === b.commit && a.builtAt === b.builtAt && a.ref === b.ref;
}

/** The commit as people quote it. */
export function shortCommit(build: Build): string {
  return build.commit.slice(0, 7);
}

/** Where the commit is read on the forge, or "" when the build does not say. */
export function commitHref(build: Build): string {
  return build.source && build.commit ? `${build.source}/commit/${build.commit}` : "";
}

/** The build in one line: "main · a1b2c3d · #42", "v1.3.0 · a1b2c3d · #7", or "local build". */
export function buildLabel(build: Build): string {
  if (!isCiBuild(build)) return "local build";
  return [build.ref || build.version, shortCommit(build), build.number && `#${build.number}`]
    .filter(Boolean).join(" · ");
}
