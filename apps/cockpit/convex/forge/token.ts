/**
 * The forge through a person's own token: local mode, where the token is what
 * `gh auth token` printed for whoever ran `asf up`.
 *
 * One credential is both the cockpit's and the person's, so one listing —
 * every repository the token reaches, each with what the person may do there —
 * answers both `repositories()` and `reach()`.
 */
import type { Forge, Reach, Repository } from "./forge";
import { type GitHub, items, readPerson, readRepository, readRole } from "./github";

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
    reach: async () => (await listed()).flatMap(({ reach }) => (reach ? [reach] : [])),
    file: (repo, path, ref) => github.file(as, repo, path, ref),
  };
}
