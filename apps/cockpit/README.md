# The cockpit

Observes and steers many factories from one place (ADR 0001, spec #40). This is the tracer bullet:
a station ships a session's domain events to `POST /ingest`, and a sessions list and a session page
render live from what was stored. It is a Next.js front end on a **self-hosted Convex** backend
(ADR 0002), and it lives here, outside `skills/agentic-sf/`, so it never ships in a stamp.

## Run it

```bash
docker compose up --build        # backend :3210/:3211, dashboard :6791, app :3000
```

That is the whole setup. The backend runs on SQLite and local disk inside the `data` volume; a
one-shot `keygen` service derives the deployment's admin key from the backend's own secret, and the
app deploys its Convex functions with it every time it starts, so the functions and the pages are
always the same version. To log in to the dashboard, print the key:

```bash
docker compose exec backend ./generate_admin_key.sh
```

A factory is known to the cockpit by its repository. Give it an **ingest token** — factory-scoped
and append-only: it can add events to that factory's sessions and read nothing back. It is printed
once; only its SHA-256 is stored.

```bash
docker compose exec app ./convex.sh run tokens:issue '{"factory": "acme/widgets"}'
```

There is no sign-in yet: anyone who can reach the app or the backend sees every session. Until forge
identity lands (a later slice of #40), keep a cockpit off the public internet.

## The ingest wire

A station sends one session's lines of `events.jsonl`, unchanged, to the backend's **site** origin
(`:3211`, `CONVEX_SITE_ORIGIN`):

```http
POST /ingest
Authorization: Bearer asf_ingest_…
Content-Type: application/json

{"session": "5c0075aa", "events": [{"seq": 1, "ts": "…", "kind": "session_started", "v": 1, "payload": {…}}]}
```

```json
{"acked": 1}
```

- Each event is stored as one document keyed by (factory, session, `seq`). The factory comes from
  the token, never from the body.
- `acked` is the highest `seq` with every `seq` below it stored: what the station resumes after. A
  batch with a gap is stored, and `acked` catches up when the gap is filled.
- A batch holds at most 500 events and 4 MB of payload (one event at most 900 KB); a bigger one is
  refused with `413` and nothing of it is stored. A station sends a backlog as several batches.
- Resending is harmless. A `seq` already stored is skipped, never overwritten, because a `seq` means
  one line forever.
- No event is refused for its kind or version. One this cockpit has no reader for (an unknown kind,
  or a `v` newer than it reads) is stored raw, shown as a generic row, and counted in the "upgrade
  the cockpit" banner. `401` is for a missing or unknown token, and `400` is for a body that is not a
  batch. Neither says anything about the events. A payload is stored as the JSON text it arrived as,
  so no key a factory writes can make an event unstorable.

## Ship from a station

A stamped factory ships on its own once its `.env` (or a CI job's environment) names the cockpit:

```bash
ASF_COCKPIT_URL=http://127.0.0.1:3211      # the site origin, not :3210
ASF_COCKPIT_TOKEN=asf_ingest_…
```

Every `asf run` then ships its session from a background thread as it goes, and `asf station sync`
sends whatever the cockpit has not acknowledged, for every session in the checkout. That is a CI
job's last step, and the way to catch up after the cockpit was down. The station keeps the
acknowledged `seq` per session and resends from there, so nothing is lost while the cockpit is
away. The factory's half is `engine/station.py` in the skill's templates.

A manual smoke test, with the stack up and a token issued:

```bash
cd /path/to/a/stamped/repo                 # fake harness: see tests/asf_helpers.fake_roster
echo "ASF_COCKPIT_URL=http://127.0.0.1:3211" >> .env
echo "ASF_COCKPIT_TOKEN=asf_ingest_…" >> .env
uv run asf/asf.py run quick "add a health check"   # appears on :3000 within seconds
```

## Develop

```bash
bun install
docker compose up -d backend
printf 'CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210\nCONVEX_SELF_HOSTED_ADMIN_KEY=%s\nCONVEX_URL=http://127.0.0.1:3210\n' \
  "$(docker compose exec -T backend ./generate_admin_key.sh | tail -n 1)" > .env.local
bun x convex dev                 # pushes convex/ on every save, regenerates convex/_generated
bun run dev                      # the app on :3000
```

`bun run typecheck`, `bun run lint` and `bun run test` are what CI runs (`bun run test`, not
`bun test`, which is Bun's own test runner rather than vitest). The tests are `convex-test`
under vitest, and they need no backend: they ingest every fixture in the golden corpus
(`../../tests/golden/events/`, which the factory's pytest suite writes against) and assert what the
sessions list and the session page return. When the factory adds a kind or a version, its fixture
lands there, and this suite fails until `convex/model/session.ts` has a reader for it. That is the
rule from `CLAUDE.md`: the cockpit's reader ships in the same pull request.

`convex/_generated/` is committed, so typecheck and tests run on a fresh clone. Regenerate it with
`bun x convex codegen` (or `bun x convex dev`) after changing a function's signature.

## Licence of what it runs on

The Convex backend and dashboard images (`ghcr.io/get-convex/convex-backend`,
`…/convex-dashboard`) are licensed **FSL-1.1-Apache-2.0**. That was confirmed from `LICENSE.md` in
`get-convex/convex-backend` when this app was scaffolded. Its Permitted Purpose covers "your internal
use and access", which is what a team's own cockpit is. It excludes offering the software to others
as a competing commercial product or service. Each version becomes Apache-2.0 two years after its
release. The `convex` npm client used here is Apache-2.0.
