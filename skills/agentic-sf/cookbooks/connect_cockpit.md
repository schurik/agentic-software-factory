# Connect a cockpit

How a stamped repository reaches a cockpit, start to end: which cockpit, the
once-per-cockpit setup its operator does, the once-per-checkout registration,
CI, and what each failure means. The cockpit's own README is not in this skill
and the person you are helping may never have seen its source — everything
they need is here.

Two things in this cookbook are a person's and never yours: **approving a
station's code** in the cockpit, and **issuing or storing a token**. You run
the commands, say what to open and what it will show; they click.

## Local or shared

- **No `ASF_COCKPIT_URL` in `.env`**: `just up` starts a **local cockpit** on
  this machine (Docker, `http://localhost:3000`) and its station is the
  engineer's by itself. Nothing to register, nothing to issue. Stop here.
- **`ASF_COCKPIT_URL` set**: a **shared** (team) cockpit. The rest of this
  cookbook — and the repository's **CI check comes with it** (below).

Ask which one they mean before touching `.env` — a URL there turns the local
cockpit off — with the question tool
([SKILL.md § Asking the person](../SKILL.md#asking-the-person)):

- **Local cockpit** `(Recommended)` when nobody mentioned a team — on this
  machine, theirs alone, nothing to register; record it with `just onboard
  --mark cockpit=local`;
- **Our team's cockpit** — they type its URL through Other, or you ask for it
  next; it brings the CI check with it;
- **Set up a team cockpit** — they run the deployment:
  [Once per cockpit](#once-per-cockpit--its-operator) first.

## Once per cockpit — its operator

Done once by whoever runs the deployment, not per repository. If the cockpit
already has people signing in to it, skip to the next section.

1. **Deploy it.** Either the compose file the cockpit ships (`docker compose up`
   with `CONVEX_CLOUD_ORIGIN` and `CONVEX_SITE_ORIGIN` set to its public
   addresses), or the pages on Vercel with the backend on **Convex Cloud**.
2. **Print a setup code.** It proves the person runs the deployment — before a
   GitHub App exists nobody can sign in, so running a function with the
   deployment's admin key is the only check there is. It works once, for an
   hour. The cockpit's `/setup` page shows the route that fits:
   - compose: `docker compose exec app ./convex.sh run setup:code`
   - Convex Cloud: the Convex dashboard → the deployment → **Functions** →
     `setup:code` → **Run**; or `npx convex run setup:code` with the Convex
     CLI pointed at that deployment. There is no container to `exec` into.
3. **Register the GitHub App** at `/setup`: the code, the GitHub host, the
   organization that will own it. GitHub shows the App it is about to create.
4. **Install the App** on the repositories that hold factories (the link is on
   the page `/setup` returns to). An organization owner can; anyone else sends
   the owner a request from there.
5. **Set the deployment's own variables**: `COCKPIT_MODE=team` and
   `COCKPIT_APP_URL` (where the pages are — the approval link a station prints
   is built from it). On Convex Cloud they go in the Convex dashboard's
   environment variables: nothing copies them from Vercel into the backend.

## Once per repository checkout

**First, the factory is on the forge's default branch** — committed and
pushed, or merged. The cockpit lists only factories whose default branch
holds `asf/factory.yaml`, so a code printed before that has no Stations tab to
be approved on. `just onboard` says whether it is (`published`); if not, that
is [onboard.md § 3](onboard.md#3-commit-and-publish-the-factory) first.

1. **`ASF_COCKPIT_URL` in `.env`** — the deployment's **site** origin:
   `https://<name>.convex.site` on Convex Cloud (not the `.convex.cloud`
   address, and not the pages' URL), the compose file's `CONVEX_SITE_ORIGIN`
   (`:3211`) otherwise. Leave `ASF_COCKPIT_TOKEN` unset.
2. **`just station-register`.** It names the factory by the checkout's
   `origin` remote (`owner/name`), prints a code and a link to
   `/stations/approve?code=…`, and waits ten minutes.
3. **A person with write on the repository approves it** in the cockpit,
   signed in. `register` waits for it by itself — there is nothing to ask
   while it does. The page names the repository, the station, its kind and its host
   before the button; they approve only a station they started. **Never approve
   it for them**, and never open the link signed in as anyone.
4. The station is handed a **command token** and an **ingest token**, both
   theirs, kept in the gitignored `asf/data/station-token.json`. From then on
   every run, `just up` and `just station-sync` ship with that ingest token;
   `ASF_COCKPIT_TOKEN`, if it is ever set, wins over it.
5. **The first registration describes the factory.** When nothing has
   described it to this cockpit yet, `register` sends the factory's
   self-description once — what `asf check --json` prints: its workflows,
   agents, gates and settings — so the Factory page shows them from the start
   instead of **unchecked**. Only from the **default branch**: on any other the
   cockpit refuses it, and `register` says so and still succeeds. After that
   first one the cockpit takes descriptions only from CI (next section),
   because the default branch's description is what every station's config
   drift is measured against, and a laptop's edits must not become it.
6. **Check it**: `just doctor` — its `cockpit` line says what the station ships
   with — and `just status`, whose `cockpit:` line says the same and whom the
   station takes commands for. Then `just up`; the station appears on the
   factory's **Stations** tab.

A checkout that already has `ASF_COCKPIT_TOKEN` registers exactly as before:
the token names the factory, and only a command token comes back (and the
factory is described, if nothing has described it yet).

## CI

**Choosing a team cockpit adds the CI check.** Do not ask whether to: stamp it
as part of connecting, and tell them why in these words or close to them —

> I'm adding `.github/workflows/asf-check.yml`. It runs `asf check` on every
> pull request, so a workflow that will not load goes red on the pull request
> that broke it, and on every push to the default branch it sends the
> cockpit the factory's description. Registering described the factory once;
> from now on this keeps it current, and it is what the cockpit measures every
> station's config drift against. It spawns no agent and spends nothing.

```bash
uv run <skill>/scripts/install.py --harness <harness> --ci
```

`<harness>` is `defaults.harness` in `asf/factory.yaml`. The re-run stamps
only what is missing — here, the one workflow — and says so; commit it with
the rest of the change. If `.github/workflows/asf-check.yml` is already there,
it is already done. With a **local** cockpit nothing needs it, and it stays the
repository's call: [install.md](install.md#run-it), and declining it is
recorded with `just onboard --mark ci=declined`.

It ships only once the repository holds the two settings it reads. A CI job
takes part in no device flow, so it ships with a token copied into the
repository. A **repository admin** opens the factory's page → **Stations** →
**Ingest tokens**, names it (e.g. `GitHub Actions`) and issues it. The token is
shown **once**. They store it as `secrets.ASF_COCKPIT_TOKEN`, and the site
origin as `vars.ASF_COCKPIT_URL` (the optional CI workflow,
`.github/workflows/asf-check.yml`, reads both). Revoking it there refuses
whatever ships with it from then on. The operator's route still works too:
`tokens:issue` with the deployment's admin key.

## When it doesn't work

| What you see | Why | Fix |
|---|---|---|
| `register`: "the code expired before anyone approved it", or the page says no station waits on that code | A code lives ten minutes and is spent once the station has its token — and registering again withdraws the station's earlier code, so only the newest is listed and can be approved | `just station-register` again for a fresh code |
| The approval link opens, but the factory has no page, or its Stations tab shows nothing to approve | The factory is **not on the default branch** yet: the cockpit lists only factories whose default branch holds `asf/factory.yaml` | Commit and push it, or merge its pull request (`just onboard` says when `published` is done), then `just station-register` again |
| `/setup`: "not a setup code this deployment printed" | The pages and the backend are on **different deployments**: the code was printed on one, the pages talk to another (on Vercel, `CONVEX_URL` or the deploy key names another deployment) | Print the code on the deployment the pages use — the dashboard link `/setup` shows is that one |
| The approval page: "…needs write on owner/name; the forge says you have read" (or the repository is not one the forge lets them read) | The approver lacks **write** on the repository, or the App is not installed on it | Someone with write approves; or install the App on the repository |
| `register`: "…is alex's station: they register it again, or revoke it first" | The station holds a live token another person approved | Its owner registers it, or revokes it on the Stations tab first |
| `sync`, `up` or a run: "the cockpit refused the ingest token" | The token was **revoked** (the station's Revoke takes its ingest token too), or it was issued by another cockpit | `just station-register` again; in CI, a fresh token from the Stations tab |
| `register`: "the cockpit answered without a code — is ASF_COCKPIT_URL its site origin?", a 404, or nothing answers | **The wrong URL**: the `.convex.cloud` address or the pages' URL instead of the site | `ASF_COCKPIT_URL=https://<name>.convex.site` (compose: `CONVEX_SITE_ORIGIN`) |
| `register`: "no ASF_COCKPIT_TOKEN, and no origin remote to name the factory by" | The checkout has no `origin` the factory can read as `owner/name` | Add the repository's origin, or set `ASF_COCKPIT_TOKEN` |
| `register`: "the cockpit refused to register without an ingest token" | The cockpit is older than registering without one | Upgrade the cockpit, or set `ASF_COCKPIT_TOKEN` to a token its operator issues (`tokens:issue`) |
| `register`: "too many …" (HTTP 429) | Registrations without a token are capped per factory and per source while they wait | Approve or let the waiting codes run out (ten minutes), then register again |
| The cockpit greys out Kill, Resume, Approve or Run | Three things must hold: the verb is listed under `cockpit.commands` in `asf/factory.yaml`, the station is **registered** to a person, and that person passes `issues.trusted_authors` | Say which one is missing. Adding a verb or an author is the repository's decision, made in a reviewed file — never yours |
