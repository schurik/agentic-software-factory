# Run a station on a server

How a factory keeps working when nobody's laptop is open: the same `asf up` a
person runs, in a container on a server, as a station of a **shared cockpit**.
Its watchers start a run per labelled issue, resume a run when somebody answers
it, and answer review threads; the cockpit's webhooks wake them (ADR 0008), and
a session waiting at a gate waits on the server's disk until it is answered.

Two things here are a person's and never yours: **logging in** — `gh` and the
harness, in the container, as themselves, or the tokens that stand in for those
logins — and **approving the station's code** in the cockpit. You run the
commands, say what each will show; they type and click.

## Before

- **A shared cockpit**, reachable from the server: `ASF_COCKPIT_URL` is its site
  origin (`https://site.<host>` behind the cockpit's `compose.vps.yaml`, the
  same address on the cockpit's own server). A local cockpit has no sign-in;
  never put one on a server. No team cockpit yet:
  [connect_cockpit.md](connect_cockpit.md#once-per-cockpit--its-operator) first.
- **The factory on the default branch** — the server clones it, and the cockpit
  lists only factories whose default branch holds `asf/factory.yaml`
  ([onboard.md § 3](onboard.md#3-commit-and-publish-the-factory)).
- **Whose station it is.** It acts as whoever logs `gh` in: every label, comment,
  push and pull request is theirs, and the cockpit's commands reach it for the
  person who approves its code. Say so before they log in.

## Once, in the repository

On a laptop, in the stamped repository:

1. **Stamp the container**: `uv run <skill>/scripts/install.py --harness <harness>
   --station` writes `asf/station/Dockerfile` and `asf/station/compose.yaml`.
   They are the repository's from then on — a re-stamp, `--force` or not, never
   overwrites them.
2. **Add the repository's toolchain** to the Dockerfile's marked block: whatever
   `asf/engine/quality.py` and the repository's scripts call — read them, and
   name each addition to the person. A factory whose agents drive a browser
   (`@playwright/mcp`, the `accept` stage) needs the Chromium line uncommented.
3. **Decide what an unattended station may do**, each with the question tool
   ([SKILL.md § Asking the person](../SKILL.md#asking-the-person)), writing into
   `asf/factory.yaml` only an answer that differs from the defaults:
   - `issues.trusted_authors` — empty, anyone who can label an issue starts a run
     on this server, on the account that logged in;
   - `issues.max_concurrent` and `pull_requests.max_concurrent` — `1` beside a
     cockpit on a small server: agents, builds and test suites share it;
   - `budget` — what one session may spend while nobody watches.
4. **Commit and push** to the default branch. The server pulls it.

## Once, on the server

```bash
git clone https://github.com/<owner>/<repo>.git ~/<repo> && cd ~/<repo>
cp .env.sample .env      # ASF_COCKPIT_URL=https://site.<host>, ASF_STATION_NAME=<a name>
export ASF_UID=$(id -u)  # the checkout's owner; the container writes as it (never root)
station() { docker compose -f asf/station/compose.yaml "$@"; }

station build
station run --rm station gh auth login               # the person, by device code
station run --rm station gh auth setup-git           # git pushes with that login
station run --rm station git config --global user.name "<name>"
station run --rm station git config --global user.email "<email>"
station run --rm station claude                      # the person logs in (claude_code)
station run --rm station uv run asf/asf.py doctor
station run --rm station uv run asf/asf.py station register
station up -d
station logs -f
```

- **Clone over HTTPS.** The container holds no SSH key; it pushes with the `gh`
  login, through `gh auth setup-git`.
- **The harness's login.** `claude` in the container is the interactive login,
  kept in the `home` volume — or a token instead, below. A factory on pi: its
  provider's key in the checkout's `.env`, which the person types in themselves.
- **`station register`** prints a code and a link; a person with write approves
  it in the cockpit, signed in — never approve it for them
  ([connect_cockpit.md](connect_cockpit.md#once-per-repository-checkout)).
- **`doctor` first**: it names a missing tool from the toolchain before a run
  meets it.

## Tokens instead of logins

The two logins above can be tokens instead, so nobody types a device code on
the server. The compose file passes three names through to the container —
`GH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` — with their values
from **`asf/station/.env`**, beside it. The person writes that file themselves,
on the server, never in the chat:

```bash
nano asf/station/.env    # GH_TOKEN=github_pat_…  and  CLAUDE_CODE_OAUTH_TOKEN=…
chmod 600 asf/station/.env
station run --rm station gh auth setup-git           # still once: git pushes with GH_TOKEN
station run --rm station gh auth status              # names the token's account
```

Then the git identity, `doctor`, `register` and `up -d` as above; `gh auth
login` and `claude` are skipped. A name that file does not set is not in the
container at all, so the login in the `home` volume holds for it — one token
and one login is fine.

- **`GH_TOKEN`** — a **fine-grained** personal access token for this one
  repository: *Contents*, *Issues* and *Pull requests* read and write,
  *Metadata* read; *Workflows* read and write only when agents edit
  `.github/workflows/`. It acts as the account that made it, as a login would.
  A repository that belongs neither to that account nor to an organization
  cannot be chosen for a fine-grained token: a **classic** token with `repo`
  then, which reaches every repository the account can.
- **It expires.** Both kinds carry an expiry date, and from that day every run
  fails at its first push or label while the factory looks otherwise healthy.
  The factory watches the date for you: GitHub names it on every answer, and
  `asf doctor` says it — a warning from two weeks before, fatal from three days
  before and once past. The station loop reports it with its command poll, so
  the cockpit's Stations tab shows it on the station's card and lists the
  station under Needs attention two weeks ahead. A new token is a new line in
  `asf/station/.env`, then `station up -d`; the cockpit has the new date within
  the hour, and at once after the container restarts.
- **`CLAUDE_CODE_OAUTH_TOKEN`** comes from `claude setup-token`, run on the
  person's laptop — the subscription, without a login on the server.
  `ANTHROPIC_API_KEY` instead bills the API; set one of the two, not both.
- **Why that file, not the checkout's `.env`**: `worktree.copy` puts the root
  `.env` on disk in every session's worktree, and `asf/station/.env` is copied
  nowhere. It hides nothing from an agent — the tokens are in the container's
  environment, which every agent's shell inherits. And a `.env` beside a
  compose file only fills in `${…}` in it; a name reaches the container because
  `environment:` lists it.
- **It is gitignored** by the stamp's own `.env` rule, which matches at any
  depth: `git check-ignore -v asf/station/.env` names the rule.
- **A station stamped before this** has no `environment:` block, and no re-stamp
  adds it: `asf/station/` is the repository's, `--force` or not. Copy the block
  from the skill's `templates/station/compose.yaml` into the repository's, push
  it, and once the station has pulled it, `station up -d` on the server.

## What it does

`asf up --pull` is the container's command. Besides the watchers and the station
loop, every `--interval` (120 s) it fast-forwards the checkout to its remote —
**between runs**: a run holds the checkout for its whole life, and a pull waits
for none to. So a run is cut from the current default branch and reads the
current workflows. When a pull changed `asf/`, `up` stops everything as ctrl-c
would and starts again on the new code; its log says `pulled … — the factory
changed`.

It only ever fast-forwards. Uncommitted or untracked changes, a branch ahead of
or diverged from the remote, a detached checkout: said once in the log
(`not pulled: …`) and left alone until a person resolves it. **Nobody edits
the server's checkout** — a change goes through the repository like any other.

What lives where: the sessions (`asf/data/`), their worktrees
(`.asf-worktrees/`), `.env` and the station's id are in the checkout, which is
mounted; the logins and uv's cache are in the `home` volume. Rebuilding or
restarting the container keeps both, and every session waiting at a gate.

**Never mount the Docker socket into it.** An agent runs shell commands with the
container's environment and logins; with the socket it owns the server, a
cockpit beside it included. The compose file says so; keep it that way.

## Keeping it current

- **The factory** — workflows, agents, settings, a skill upgrade
  ([upgrade.md](upgrade.md)): merge it to the default branch. The station
  pulls it and restarts on it.
- **The image** — a toolchain change in the Dockerfile, a newer harness CLI:
  after the station has pulled it, `station up -d --build` on the server.
  Sessions waiting at a gate survive it; a run in flight is stopped, and
  `asf resume` picks it up.

## When it doesn't work

| What you see | Why | Fix |
|---|---|---|
| `not pulled: the checkout has uncommitted or untracked changes` | Something was edited or written in the server's checkout outside `asf/data/` | `station run --rm station git status`; move the change into the repository, then drop it on the server |
| `not pulled: … have diverged` / `… has commits … does not` | The server's branch has commits the remote lacks — a hand-made commit, or a run that merged into it (`worktree.integration.mode: merge`; issue runs never do, `issues.force_pr`) | Reconcile by hand, then let it be the remote's again |
| `not pulled: the checkout is detached` | The checkout is not on a branch | `git checkout <default branch>` on the server |
| `Permission denied` under `/work`, or git's "dubious ownership" | The container's user is not the checkout's owner | `ASF_UID=$(stat -c %u .) station build`, then `station up -d` |
| `useradd: UID 0 is not unique` at build | `ASF_UID` is root's | Clone and run it as a non-root user: Claude Code refuses `bypassPermissions` as root |
| A push asks for a username, or `Permission denied (publickey)` | An SSH remote, or no `gh auth setup-git` | `git remote set-url origin https://…`; `station run --rm station gh auth setup-git` |
| An agent phase fails at once, the harness not logged in | No login in the `home` volume and no token in the container — `asf/station/.env` does not set one, or the compose file has no `environment:` | `station run --rm station claude`, or a token in `asf/station/.env` ([above](#tokens-instead-of-logins)), then `station up -d` |
| `doctor` says `forge token … expires …` or `refused`, or the cockpit lists the station under Needs attention | `GH_TOKEN` runs out soon, or already has | A new token in `asf/station/.env`, then `station up -d` ([above](#tokens-instead-of-logins)) |
| Runs fail at their first push, label or comment: `Bad credentials`, a 401 or a 403 | `GH_TOKEN` expired, was revoked, or lacks a permission | `station run --rm station gh auth status`; a new token in `asf/station/.env`, then `station up -d` |
| The station is not on the cockpit's Stations tab | Not registered, or the wrong URL | [connect_cockpit.md](connect_cockpit.md#when-it-doesnt-work) |
| Runs start, but a quality phase cannot find a tool | The toolchain is not in the image | Add it to the Dockerfile, push, `station up -d --build` |
