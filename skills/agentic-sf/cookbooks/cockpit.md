# Switch the cockpit: local ↔ team

Move a stamped checkout from the cockpit on its own machine to the team's
shared one, or back. The mode is one line of `.env`: `ASF_COCKPIT_URL` set is
**team**, unset is **local**. Nothing in `asf/factory.yaml` changes and
nothing is re-stamped, so a switch is cheap. What makes it worth a cookbook is
the state the old cockpit still holds about this checkout: claims, a command
token, and sessions it has seen.

| | local | team |
|---|---|---|
| where it runs | this machine, Docker, `http://localhost:3000`, started by `just up` | wherever the team deployed it |
| `.env` | no `ASF_COCKPIT_URL` | `ASF_COCKPIT_URL` (site origin) + `ASF_COCKPIT_TOKEN` (ingest token) |
| who sees the sessions | the engineer | everyone the forge lets read the repository |
| claims (one station per work item) | none: run **one** issues watcher per repository | every starter asks the cockpit first |
| commands (kill, resume, answer) | the station is its owner's already | `just station-register`, approved by a person |
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

1. **Get the two values from whoever runs the team's cockpit**:
   - `ASF_COCKPIT_URL`: the backend's **site** origin (`CONVEX_SITE_ORIGIN`,
     `:3211` on docker compose; `https://<deployment>.convex.site` on Convex
     Cloud). Never the page's `:3000` or the API's `:3210`.
   - `ASF_COCKPIT_TOKEN`: an ingest token issued for this repository as
     `owner/name`:

     ```bash
     docker compose exec app ./convex.sh run tokens:issue '{"factory": "acme/widgets"}'
     ```

     On Convex Cloud it is `npx convex run tokens:issue '…'` from
     `apps/cockpit`. A factory named any other way is shown to nobody.

2. **Write them into `.env`.** The installer does it without re-stamping
   anything (every stamped file is skipped), asks for the token without echo,
   and prints the `tokens:issue` command for this repository if a value is
   still missing:

   ```bash
   uv run <skill>/scripts/install.py --harness <the one it runs> --cockpit team --cockpit-url <site origin>
   ```

   Or edit `.env` by hand. Either way the token is the engineer's to type:
   never ask for it in chat, and never pass it as a flag.

3. **Ship what this checkout has.** It sends every session from its first
   event: a session's acknowledgement belongs to one cockpit, so nothing the
   local one received counts as received here. It fails only when the token is
   refused.

   ```bash
   just station-sync
   ```

4. **Register the station** if the team should be able to kill, resume or
   answer from the cockpit. The command token the local cockpit gave this
   station does not carry over. It prints a code that a person with write
   access approves on the cockpit, signed in. That approval is theirs, never
   yours.

   ```bash
   just station-register
   ```

5. **`just up` again.** It starts no local cockpit now. The watchers ask the
   team's cockpit for a claim before starting anything, so other stations on
   the repository can run watchers too.

The local cockpit's data stays in its Docker volume, for every factory on this
machine. `docker compose -p asf-cockpit down --volumes` deletes it, which is
irreversible and covers other repositories' sessions too, so ask first.

## Team → local

1. **Comment out both lines in `.env`** (`# ASF_COCKPIT_URL=…`,
   `# ASF_COCKPIT_TOKEN=…`). Commenting keeps the values for the way back.
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
registration, which a person can revoke under **Stations**. A CI job keeps
shipping to it through the repository's `vars`/`secrets`, whatever this
checkout does.

## Switching back and forth

Harmless. Each switch resends every session from its first event, because the
acknowledgement kept in `shipped.json` names one cockpit and resets for any
other. A cockpit skips every `seq` it already stores, so it gains no duplicates.
On the way back to team, `just station-register` is needed again only if the
person's registration was revoked meanwhile.
