# Connect a repository to a cockpit

A cockpit shows a factory's sessions and steers its stations. Connecting one
takes two secrets, and neither is copy-pasted out of the cockpit's source: a
skill user has never seen that source, and needs it for nothing here.

- the **setup code**, once per cockpit: it proves whoever registers the
  team's GitHub App can run a function on that deployment;
- an **ingest token**, per factory: what a station ships sessions with. A
  machine is handed one when its registration is approved; a CI job holds one
  an admin issued on the factory page.

## Local or shared

Without `ASF_COCKPIT_URL` in `.env`, `just up` runs a **local** cockpit on this
machine (Docker, `http://localhost:3000`) and ships to it. It issues its own
tokens and its station is the engineer's already: **nothing to register**, and
the rest of this cookbook does not apply. `just doctor`'s `cockpit` lines say
what it needs.

A **shared** cockpit is a team's: one deployment, many repositories and
people. The rest of this cookbook is that one.

## Once per cockpit — its operator

Done by whoever runs the deployment, not per repository. If the team has a
cockpit already, skip to the next section.

1. **Deploy it**: the cockpit's `docker-compose.yml` on a host the team can
   reach, or its pages on Vercel with the backend on Convex Cloud. The
   cockpit's README has both.
2. **Print a setup code**, on the deployment, by whatever runs a function
   there. It works once, for an hour:
   - self-hosted: `docker compose exec app ./convex.sh run setup:code`
   - Convex Cloud: the dashboard → the deployment → **Functions** →
     `setup:code` → **Run**; or `npx convex run setup:code` from a directory
     linked to that deployment.

   The cockpit's `/setup` page shows the one that fits where it runs.
3. **Register the GitHub App** at `/setup` with that code, then **install it**
   on the repositories that hold factories. An organization owner installs;
   anyone else requests it from the same page.
4. **Set the deployment's own variables**: `COCKPIT_APP_URL` (where people open
   the pages — the link a registration prints is built from it) and
   `COCKPIT_MODE`. The compose file passes them; on **Convex Cloud nothing copies
   them into the backend** — set them in the Convex dashboard's environment
   variables.

## Once per repository checkout

1. **Set `ASF_COCKPIT_URL` in `.env`** to the deployment's **site** origin:
   - Convex Cloud: `https://<name>.convex.site` — not the `.convex.cloud`
     address (that is the API browsers use) and not the pages' URL;
   - self-hosted: what `CONVEX_SITE_ORIGIN` names (`:3211` by default).

   Leave `ASF_COCKPIT_TOKEN` unset.
2. **`just station-register`.** With no token it names the factory itself — the
   checkout's `origin` remote, as `owner/name` — prints a code and a link, and
   waits up to ten minutes.
3. **A person with write on that repository approves the code** in the
   browser, signed in to the cockpit. The page names the repository, the
   station, its kind and the host it asked from; they approve only if that is
   the terminal in front of them. **Never approve it for them**, and never open
   the link on their behalf: approving is what makes the station theirs, and
   the commands it takes are taken as them.
4. The station is handed a **command token** and that factory's **ingest
   token** — the approver's, recorded with who and when — and keeps both in the
   gitignored `asf/data/station-token.json`. From then on `just up` ships with
   that ingest token while `ASF_COCKPIT_TOKEN` stays unset; set, the variable
   wins.
5. **Check**: `just doctor` — its `cockpit` line says the station ships with the
   token it was handed — then `just up` and `just status`; the session appears
   on the cockpit within seconds.

With `ASF_COCKPIT_TOKEN` already set (an operator issued one), registering
works as before: the token says which factory, and only a command token comes
back.

## CI

A CI job cannot take part in a device flow, so it holds a token copied into
the repository's settings. An **admin** of the repository opens the factory's
page → **Stations** → **Ingest tokens** → **Issue a token for CI**. It is shown
once: store it as `secrets.ASF_COCKPIT_TOKEN`, with `vars.ASF_COCKPIT_URL` set
to the site origin (the page shows it). The stamped `asf-check.yml` and a job's
`just station-sync` read both. Revoke it on the same list.

The operator's route stays: with the deployment's admin key,
`docker compose exec app ./convex.sh run tokens:issue '{"factory": "owner/name"}'`
(or `npx convex run tokens:issue …` on Convex Cloud) prints a token.

## When it does not work

| What it says | Why | Fix |
|---|---|---|
| "the code expired before anyone approved it" / the page finds no station on that code | Ten minutes passed, or the request was spent | `just station-register` again for a fresh code |
| `/setup`: "that is not a setup code this deployment printed" | The code was printed on another deployment than the one the pages talk to — a dev deployment's code on production's pages, say — or it is over an hour old, or used | Print it on the deployment whose site `/setup` is served against, and use it within the hour |
| the approval page: "…needs write on owner/name; the forge says you have read" / the code finds nothing | The approver lacks write on that repository, or cannot read it at all (or the App is not installed on it) | Someone with write approves; install the App on the repository |
| `just station-register`: "no origin remote to name the factory by" | The checkout has no `origin`, or one the forge would not know | `git remote add origin …`, or set `ASF_COCKPIT_TOKEN` |
| `just station-register`: "…older than this release, and registers only with the factory's ingest token" | The cockpit predates registering without a token | Upgrade the cockpit, or set `ASF_COCKPIT_TOKEN` to a token the operator issued |
| `just station-register`: "refused ASF_COCKPIT_TOKEN" / `just up`, `just station-sync`: "the cockpit refused the ingest token" | The token was revoked on the factory page, or is another cockpit's | Unset `ASF_COCKPIT_TOKEN` and `just station-register` again; CI: an admin issues a fresh one |
| "…registrations … are waiting already" (HTTP 429) | Too many unapproved requests from this address, or for this factory | Approve the one wanted, or wait ten minutes for the rest to run out |
| "could not reach the cockpit" / "the cockpit answered without a code" | The URL is wrong: the `.convex.cloud` address, the pages' URL, or a missing `https://` | `ASF_COCKPIT_URL` is the **site** origin, `https://<name>.convex.site` on Convex Cloud |
| Kill, Resume, Approve or Run greyed out | One of three conditions does not hold: the verb is not in `cockpit.commands` in `asf/factory.yaml` (the repository's decision, in a reviewed file — never add one for the engineer); the station is not registered, or its token was revoked; or the asking person's login fails `issues.trusted_authors` | The cockpit says which beside the greyed button; register with `just station-register`, or change the config by pull request |
