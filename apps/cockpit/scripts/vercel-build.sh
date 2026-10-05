#!/bin/sh
# Vercel's build, for a cockpit whose backend is Convex Cloud: push the Convex
# functions this commit has, then build the pages against the deployment they
# went to. It is docker/start.sh's promise kept on Vercel — the backend's
# functions and the app's pages are always the same version, because one
# command ships both — and what keeps a merged change from serving new pages
# to old functions ("This page couldn't load").
#
# Which deployment is the deploy key's, from the Vercel environment it is set
# in (README.md, "On Vercel"): the production key deploys to production, the
# preview key to a preview deployment named after the branch. The deployment's
# URL is baked into the build as NEXT_PUBLIC_CONVEX_URL, because a preview's
# changes with every branch and no runtime variable can know it.
set -eu

if [ -z "${CONVEX_DEPLOY_KEY:-}" ]; then
  echo "vercel-build: CONVEX_DEPLOY_KEY is not set for this Vercel environment;" \
       "set the deployment's deploy key (README.md, \"On Vercel\")" >&2
  exit 1
fi

bun x convex deploy --cmd 'bun run build' --cmd-url-env-var-name NEXT_PUBLIC_CONVEX_URL

# What docker/start.sh runs after deploying, for production only: a preview
# deployment starts empty, with nothing an older cockpit stored. Not worth
# failing a deploy over — each says what it would have fixed.
if [ "${VERCEL_ENV:-}" = "production" ]; then
  bun x convex run inbox:backfill > /dev/null 2>&1 || echo "vercel-build: the inbox's backfill did not run; older waiting sessions are missing from it"
  bun x convex run retention:backfill > /dev/null 2>&1 || echo "vercel-build: the retention backfill did not run; transcripts stored before it may not age out"
fi
