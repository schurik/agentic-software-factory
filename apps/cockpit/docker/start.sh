#!/bin/sh
# The app container's entrypoint: push the Convex functions this image was
# built with to the backend, then serve the front end. Deploying on every start
# is what keeps the backend's functions and the app's pages the same version —
# there is no second artifact to forget to upgrade.
set -eu

./convex.sh deploy --yes --typecheck disable --codegen disable
exec bun x next start --hostname 0.0.0.0 --port 3000
