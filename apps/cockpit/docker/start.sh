#!/bin/sh
# The app container's entrypoint: push the Convex functions this image was
# built with to the backend, then serve the front end. Deploying on every start
# is what keeps the backend's functions and the app's pages the same version —
# there is no second artifact to forget to upgrade.
set -eu

if [ -z "${CONVEX_SELF_HOSTED_ADMIN_KEY:-}" ]; then
  # Written by the compose file's `keygen` service from the backend's own secret.
  CONVEX_SELF_HOSTED_ADMIN_KEY="$(tail -n 1 /keys/admin_key)"
  export CONVEX_SELF_HOSTED_ADMIN_KEY
fi

npx convex deploy --yes --typecheck disable --codegen disable
exec npx next start --hostname 0.0.0.0 --port 3000
