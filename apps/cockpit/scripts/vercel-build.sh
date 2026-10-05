#!/bin/sh
# Vercel's build, for a cockpit whose backend is Convex Cloud: push the Convex
# functions this commit has, then build the pages against the deployment they
# went to. It is docker/start.sh's promise kept on Vercel — the backend's
# functions and the app's pages are always the same version, because one
# command ships both — and what keeps a merged change from serving new pages
# to old functions ("This page couldn't load").
#
# Which deployment is the deploy key's, set per Vercel environment (README.md,
# "On Vercel"). Production must have one: a production build that only built
# the pages is the bug this script exists for. A preview without one shares
# the backend production's pages talk to, which it must not push to, so it
# builds the pages alone, against the CONVEX_URL it has. A preview WITH one
# (Convex's preview deploy key) gets a deployment of its own per branch; that
# address is new with every branch, so the build bakes it in as
# NEXT_PUBLIC_CONVEX_URL, which the pages use when CONVEX_URL is unset.
set -eu

if [ -z "${CONVEX_DEPLOY_KEY:-}" ]; then
  if [ "${VERCEL_ENV:-}" = "production" ]; then
    echo "vercel-build: CONVEX_DEPLOY_KEY is not set for Production; without it the pages" \
         "would ship without their functions (README.md, \"On Vercel\")" >&2
    exit 1
  fi
  echo "vercel-build: no CONVEX_DEPLOY_KEY for ${VERCEL_ENV:-this build}: building the pages" \
       "against CONVEX_URL, and pushing no functions to it"
  exec bun run build
fi

bun x convex deploy --cmd 'bun run build' --cmd-url-env-var-name NEXT_PUBLIC_CONVEX_URL

# What docker/start.sh runs after deploying, for production only: a preview
# deployment starts empty, with nothing an older cockpit stored. Not worth
# failing a deploy over — each says what it would have fixed.
if [ "${VERCEL_ENV:-}" = "production" ]; then
  bun x convex run inbox:backfill > /dev/null 2>&1 || echo "vercel-build: the inbox's backfill did not run; older waiting sessions are missing from it"
  bun x convex run retention:backfill > /dev/null 2>&1 || echo "vercel-build: the retention backfill did not run; transcripts stored before it may not age out"
fi
