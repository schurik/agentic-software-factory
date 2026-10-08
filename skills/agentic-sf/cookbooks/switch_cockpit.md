# Switch the cockpit: local ↔ team

Move a stamped checkout from the cockpit on its own machine to the team's
shared one, or back. The mode is one line of `.env`: `ASF_COCKPIT_URL` set is
**team**, unset is **local**. Nothing in `asf/factory.yaml` changes and
nothing is re-stamped, so a switch is cheap. What makes it worth a cookbook is
the state the old cockpit still holds about this checkout: claims, and the
sessions it has seen. Connecting to a team cockpit in the first place is
[connect_cockpit.md](connect_cockpit.md); this is moving between the two.

| | local | team |
|---|---|---|
| where it runs | this machine, Docker, `http://localhost:3000`, started by `just up` | wherever the team deployed it |
| `.env` | no `ASF_COCKPIT_URL` | `ASF_COCKPIT_URL` (site origin); the ingest token comes from registering |
| who sees the sessions | the engineer | everyone the forge lets read the repository |
| claims (one station per work item) | none: run **one** issues watcher per repository | every starter asks the cockpit first |
| tokens | issued by the local cockpit itself, kept in `asf/data/cockpit.json` | `just station-register`, approved by a person with write; kept in `asf/data/station-token.json` |
| a CI job's `asf check --ship` | has nothing to ship to (127.0.0.1 only) | `vars.ASF_COCKPIT_URL`, `secrets.ASF_COCKPIT_TOKEN` |

## Before either direction

**Switch with nothing in flight.** `just status` says what is running and
waiting. Stop `just up` (ctrl-c stops the station loop, the watchers and a local
cockpit it started) and let any run finish first. A claim is held until the
cockpit that granted it reads that session's end. A session that ends after the
switch, such as one waiting at a gate and resumed later, ships its end to the
*new* cockpit, so the old one holds the claim for good. Only **Release claim** on
the old cockpit's session page fixes that: it relabels the item `asf:queued` and
abandons the session.

**Check the shell, not just `.env`.** `.env` is loaded without overriding the
environment, so an `ASF_COCKPIT_URL` exported in the shell beats whatever
`.env` says. `echo $ASF_COCKPIT_URL` should print nothing.

## Local → team

1. **Get the URL from whoever runs the team's cockpit**: the backend's
   **site** origin. That is `https://<name>.convex.site` on Convex Cloud (not
   the `.convex.cloud` address), and `CONVEX_SITE_ORIGIN` (`:3211`) on docker
   compose. Never the pages' `:3000` or the API's `:3210`.

2. **Write it into `.env`.** The installer does it without re-stamping anything
   (every stamped file is skipped), and names a URL on the wrong port:

   ```bash
   uv run <skill>/scripts/install.py --harness <the one it runs> --cockpit team --cockpit-url <site origin>
   ```

   Or edit `.env` by hand. Leave `ASF_COCKPIT_TOKEN` unset; it is CI's.

3. **Register the station.** It names the factory by the `origin` remote,
   prints a code and a link, and waits ten minutes. A person with write on the
   repository approves it in the cockpit, signed in. That approval is theirs,
   never yours. The station is handed an ingest token and a command token, both
   for this cockpit. Nothing the local cockpit issued carries over.

   ```bash
   just station-register
   ```

   Every failure it can print, with its cause, is in
   [connect_cockpit.md](connect_cockpit.md#when-it-doesnt-work).

4. **Ship what this checkout has.** It sends every session from its first
   event: a session's acknowledgement belongs to one cockpit, so nothing the
   local one received counts as received here.

   ```bash
   just station-sync
   ```

5. **`just up` again.** It starts no local cockpit now. The watchers ask the
   team's cockpit for a claim before starting anything, so other stations on
   the repository can run watchers too.

The local cockpit's data stays in its Docker volume, for every factory on this
machine. `docker compose -p asf-cockpit down --volumes` deletes it, which is
irreversible and covers other repositories' sessions too, so ask first.

## Team → local

1. **Comment out `ASF_COCKPIT_URL` in `.env`** (and `ASF_COCKPIT_TOKEN`, if
   the checkout has one). Commenting keeps the value for the way back.
   Re-running the installer with `--cockpit local` changes nothing: it never
   removes a value from `.env`, and says so.
2. **Docker with compose**: `just doctor`'s `cockpit` line says whether it is
   there and which version it would run.
3. **Mind the watchers.** Without the team's cockpit this station asks nobody
   for claims. If other stations on the same repository still ship to the team
   one, an issues or pull-request watcher here can start an item one of them
   also starts. Run only what is safe:

   ```bash
   just up --only cockpit,answers
   ```

   Run every watcher (`just up`) only when this is the one station watching
   the repository.
4. **`just up`** starts the local cockpit at `http://localhost:3000`, issues
   its own tokens, and ships every session on this checkout to it, from the
   first event.

What the team's cockpit holds stays there: its sessions, and this station's
registration, which a person can revoke on the factory's **Stations** tab. The
tokens it handed stay in `asf/data/station-token.json` for the way back. A CI job keeps
shipping to it through the repository's `vars`/`secrets`, whatever this
checkout does.

## Switching back and forth

Harmless. Each switch resends every session from its first event, because the
acknowledgement kept in `shipped.json` names one cockpit and resets for any
other. A cockpit skips every `seq` it already stores, so it gains no duplicates.
On the way back to team, the station ships with the tokens its registration
kept, and `just station-register` is needed again only if they were revoked
meanwhile. `just status`'s `cockpit:` line says what it ships with.
