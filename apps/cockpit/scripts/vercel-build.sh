#!/bin/sh
# Vercel's build, for a cockpit whose backend is Convex Cloud: push the Convex
# functions this commit has, then build the pages against the deployment they
# went to. It is docker/start.sh's promise kept on Vercel — the backend's
# functions and the app's pages are always the same version, because one
# command ships both — and what keeps a merged change from serving new pages
# to old functions ("This page couldn't load").
#
# Every build pushes, so every build needs the deploy key of the deployment it
# pushes to, set per Vercel environment (README.md, "On Vercel"); one without
# it fails rather than ship pages ahead of their functions. A preview's key may
# be the same deployment's as production's — then the last build's functions
# are what every environment runs — or Convex's preview deploy key, which gives
# each branch a deployment of its own. That address is new with every branch,
# so the build bakes it in as NEXT_PUBLIC_CONVEX_URL, which the pages use when
# CONVEX_URL is unset.
set -eu

if [ -z "${CONVEX_DEPLOY_KEY:-}" ]; then
  echo "vercel-build: CONVEX_DEPLOY_KEY is not set for ${VERCEL_ENV:-this build}; without it the" \
       "pages would ship without their functions (README.md, \"On Vercel\")" >&2
  exit 1
fi

bun x convex deploy --cmd 'bun run build' --cmd-url-env-var-name NEXT_PUBLIC_CONVEX_URL

# What docker/start.sh runs after deploying, for production only: a preview
# deployment of its own starts empty, with nothing an older cockpit stored.
# Not worth failing a deploy over — each says what it would have fixed.
if [ "${VERCEL_ENV:-}" = "production" ]; then
  bun x convex run inbox:backfill > /dev/null 2>&1 || echo "vercel-build: the inbox's backfill did not run; older waiting sessions are missing from it"
  bun x convex run retention:backfill > /dev/null 2>&1 || echo "vercel-build: the retention backfill did not run; transcripts stored before it may not age out"
  bun x convex run phases:backfill > /dev/null 2>&1 || echo "vercel-build: the phases' backfill did not run; older sessions' gates are missing from the Overview"
  bun x convex run chapters:backfill > /dev/null 2>&1 || echo "vercel-build: the chapters' backfill did not run; older sessions' chapters are missing from Measure"
  bun x convex run scores:backfill > /dev/null 2>&1 || echo "vercel-build: the scores' backfill did not run; older sessions' scores are missing from Measure"
fi
