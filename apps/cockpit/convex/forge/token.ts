/**
 * The forge through a person's own token: local mode, where the token is what
 * `gh auth token` printed for whoever ran `asf up`.
 *
 * One credential is both the cockpit's and the person's, so one listing —
 * every repository the token reaches, each with what the person may do there —
 * answers both `repositories()` and `reach()`.
 */
import type { Forge, Reach, Repository } from "./forge";
import {
  branch, commit, commitDiff, compare, distance, type GitHub, items, paths, pull, readPerson, readRepository, readRole, tip,
} from "./github";

export function tokenForge(github: GitHub, token: string): Forge {
  const as = { token, scope: "token" };
  let listing: Promise<{ repository: Repository; reach: Reach | null }[]> | null = null;
  const listed = () =>
    (listing ??= github.list(as, "/user/repos?per_page=100&sort=full_name", (body) =>
      items(body).map((repo) => {
        const repository = readRepository(repo);
        const role = readRole(repo);
        return { repository, reach: role && { repo: repository.name, role } };
      })));

  return {
    repositories: async () => (await listed()).map(({ repository }) => repository),
    holdsFactory: (repo) => github.holdsFactory(as, repo),
    person: () => github.one(as, "/user", readPerson),
    owns: (account) => github.owns(as, account),
    reach: async () => (await listed()).flatMap(({ reach }) => (reach ? [reach] : [])),
    file: (repo, path, ref) => github.file(as, repo, path, ref),
    compare: (repo, base, head) => compare(github, as, repo, base, head),
    commitDiff: (repo, sha) => commitDiff(github, as, repo, sha),
    tip: (repo, branch) => tip(github, as, repo, branch),
    paths: (repo, ref, dir) => paths(github, as, repo, ref, dir),
    distance: (repo, base, head) => distance(github, as, repo, base, head),
    comment: (repo, number, body) => github.comment(as, repo, number, body),
    labels: (repo) => github.labels(as, repo),
    labelled: (repo, label) => github.labelled(as, repo, label),
    issue: (repo, number) => github.issue(as, repo, number),
    label: (repo, number, labels) => github.label(as, repo, number, labels),
    unlabel: (repo, number, label) => github.unlabel(as, repo, number, label),
    commit: (repo, base, changes, message) => commit(github, as, repo, base, changes, message),
    branch: (repo, name, sha) => branch(github, as, repo, name, sha),
    pull: (repo, proposal) => pull(github, as, repo, proposal),
  };
}
