#!/bin/sh
# One deploy of a cockpit on its own server (README.md, "Deployed on every
# merge"): bring this checkout to a commit on main, run the app image CI built
# from that commit, and wait until it answers. .github/workflows/deploy-cockpit.yml
# runs it over SSH after every merge that touches apps/cockpit; a person can run
# it by hand the same way.
#
#   scripts/deploy.sh <commit sha>
#
# Meant as the forced command of the deploy key's line in authorized_keys,
#
#   command="/home/deploy/agentic-software-factory/apps/cockpit/scripts/deploy.sh",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA… deploy-cockpit
#
# so the key does this and nothing else: what the client asked for arrives in
# SSH_ORIGINAL_COMMAND, and the only thing read from it is the sha, which must
# name a commit already on origin/main. The image repository is this server's
# own choice, never the caller's: COCKPIT_IMAGE_REPO in .env, or the ghcr.io
# package of the GitHub owner this checkout was cloned from.
#
# Both compose files come from the checkout, so a merge that moves the backend's
# pin, compose.vps.yaml or the Caddyfile reaches the server with the image. The
# image that runs is written to .env as COCKPIT_IMAGE, so a later `up -d` by hand
# keeps running it. A rollback is this script with an older commit of main: the
# checkout stays where it is (a fast-forward to an ancestor is a no-op) and the
# older image runs — with its own functions, which start.sh pushes as it starts.
#
# The whole body is one function, read in full before any of it runs: the
# `git merge` below rewrites this file while it runs, and sh reads a script as
# it goes.
set -eu

main() {
  if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
    # Word-split on purpose; one word is all that is accepted.
    # shellcheck disable=SC2086
    set -- $SSH_ORIGINAL_COMMAND
  fi
  if [ "$#" -ne 1 ] || ! printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$'; then
    echo "deploy: expected one full commit sha, got: $*" >&2
    return 2
  fi
  sha="$1"

  cd "$(dirname "$0")/.."
  if [ ! -f .env ]; then
    echo "deploy: no .env in $(pwd); set COCKPIT_HOST there first (README.md, \"On one server\")" >&2
    return 1
  fi

  git fetch --quiet origin main
  if ! git merge-base --is-ancestor "$sha" origin/main 2>/dev/null; then
    echo "deploy: $sha is not on origin/main" >&2
    return 1
  fi
  git merge --quiet --ff-only "$sha"

  repo="$(sed -n 's/^COCKPIT_IMAGE_REPO=//p' .env | tail -n 1)"
  if [ -z "$repo" ]; then
    owner="$(git remote get-url origin | sed -n 's#.*github\.com[:/]\([^/]*\)/.*#\1#p' | tr '[:upper:]' '[:lower:]')"
    if [ -z "$owner" ]; then
      echo "deploy: origin is not on github.com; set COCKPIT_IMAGE_REPO in .env" >&2
      return 1
    fi
    repo="ghcr.io/$owner/asf-cockpit"
  fi
  image="$repo:sha-$sha"
  set_env COCKPIT_IMAGE "$image"

  echo "deploy: $image"
  compose pull --quiet
  compose up -d --no-build

  # The app answers once start.sh has pushed its functions and Next is up;
  # until then (and while it restarts, should the push fail) Caddy has nothing
  # to proxy to. The manifest is the cheapest page that needs no sign-in.
  tries=0
  until compose exec -T caddy wget -q -O /dev/null http://app:3000/manifest.webmanifest 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -ge 60 ]; then
      echo "deploy: the app did not answer within three minutes; its last lines:" >&2
      compose logs --no-color --tail 40 app >&2
      return 1
    fi
    sleep 3
  done
  echo "deploy: $(git rev-parse --short HEAD) checked out, $image answering"
}

compose() {
  docker compose -f docker-compose.yml -f compose.vps.yaml "$@"
}

# Replace NAME's line in .env, or add one, writing the file in place so its
# owner and mode (it holds the cockpit's settings) stay what they were.
set_env() {
  tmp="$(mktemp)"
  grep -v "^$1=" .env > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  cat "$tmp" > .env
  rm -f "$tmp"
}

main "$@"; exit
