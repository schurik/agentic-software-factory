#!/bin/sh
# The Convex CLI, pointed at this deployment's backend with its admin key:
#   docker compose exec app ./convex.sh run tokens:issue '{"factory": "acme/widgets"}'
set -eu

if [ -z "${CONVEX_SELF_HOSTED_ADMIN_KEY:-}" ]; then
  # Written by the compose file's `keygen` service from the backend's own secret.
  CONVEX_SELF_HOSTED_ADMIN_KEY="$(tail -n 1 /keys/admin_key)"
  export CONVEX_SELF_HOSTED_ADMIN_KEY
fi

exec bun x convex "$@"
