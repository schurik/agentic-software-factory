#!/bin/sh
# The app container's entrypoint: push the Convex functions this image was
# built with to the backend, then serve the front end. Deploying on every start
# is what keeps the backend's functions and the app's pages the same version —
# there is no second artifact to forget to upgrade.
set -eu

# Which cockpit this is reaches the functions through the DEPLOYMENT's
# environment, not this container's: a Convex function reads the variables
# `convex env set` stored in the backend. So what the compose file gave this
# container is copied over, before the functions that read it are deployed,
# and a variable the container no longer has is taken away again.
#
#   COCKPIT_MODE         `local` is the cockpit `asf up` starts: no sign-in,
#                        and the forge is asked with one person's own token.
#                        Anything else is a team's: a GitHub App, and a sign-in.
#   COCKPIT_FORGE_HOST   local mode: the forge that token is for.
#   COCKPIT_FORGE_TOKEN  local mode: that person's `gh auth token`. Piped in,
#                        so it is never on a command line.
#   COCKPIT_APP_URL      where people open these pages: a station registering
#                        with this cockpit prints its approval link here.
#   COCKPIT_TRANSCRIPT_DAYS  how many days a finished session's transcript is
#                        kept before it ages out; 30 when unset. A factory's
#                        factory.yaml can only shorten it.
for name in COCKPIT_MODE COCKPIT_FORGE_HOST COCKPIT_FORGE_TOKEN COCKPIT_APP_URL COCKPIT_TRANSCRIPT_DAYS; do
  eval "value=\${$name:-}"
  if [ -n "$value" ]; then
    printf '%s' "$value" | ./convex.sh env set "$name" > /dev/null
  else
    ./convex.sh env remove "$name" > /dev/null 2>&1 || true
  fi
done

./convex.sh deploy --yes --typecheck disable --codegen disable

# Sessions an older cockpit stored carry no `waiting` mark, which is what the
# inbox finds a waiting session by; this marks them, and then has nothing to do.
./convex.sh run inbox:backfill > /dev/null 2>&1 || echo "start: the inbox's backfill did not run; older waiting sessions are missing from it"

# Transcripts of sessions an older cockpit stored are found, and every one
# still held is dated again under COCKPIT_TRANSCRIPT_DAYS as it is now.
./convex.sh run retention:backfill > /dev/null 2>&1 || echo "start: the retention backfill did not run; transcripts stored before it may not age out"

# The forge catch-up poll, once as the deployment starts: a cockpit that was
# down missed whatever GitHub delivered meanwhile, and GitHub does not send it
# again. The cron (convex/crons.ts) takes it from here. Not worth failing a
# start over: it says what went wrong on the Factories page.
./convex.sh run discovery:catchUp > /dev/null 2>&1 || echo "start: the first forge catch-up did not run; the cron will"

exec bun x next start --hostname 0.0.0.0 --port 3000
