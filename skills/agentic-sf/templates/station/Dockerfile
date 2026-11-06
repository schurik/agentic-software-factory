# The station image: `asf up --pull` in a container, on a server nobody sits at
# (the skill's cookbooks/run_on_a_server.md). Stamped by the agentic-sf
# installer (`install.py --station`) — and from then on this repository's: a
# re-stamp never overwrites it, --force or not, because the block below is
# where the team adds the toolchain its quality phases run.
#
# What a station needs and a laptop already has: git, `gh` (the forge, as the
# person who logs in), uv (the factory's scripts declare their dependencies
# inline, PEP 723, and uv resolves them), and the harness's CLI — Claude Code,
# an npm package, hence a Node base. Python comes from uv, installed below,
# outside $HOME: $HOME is a volume (compose.yaml), and a volume keeps what an
# older image put there.
#
# A NON-ROOT USER, on purpose: Claude Code refuses `bypassPermissions` as
# root, and the factory runs every agent with it — permissions.py rolls back
# whatever an agent writes outside its `writes:` after the call. ASF_UID is
# the owner of the checkout this container works in (compose.yaml mounts it):
# `id -u` of whoever cloned it on the server — never 0, which `useradd` below
# refuses, as it should.
FROM node:22-bookworm-slim

ARG ASF_UID=1000

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git gnupg \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/uv/python
RUN uv python install

# The harness. A factory whose agents run on pi installs pi here instead (its
# provider's key goes in the checkout's .env).
RUN npm install -g @anthropic-ai/claude-code

# ── this repository's toolchain ──────────────────────────────────────────────
# Whatever asf/engine/quality.py and the repository's own scripts call: the
# quality phases run them in a session's worktree, here. For example:
#
#   RUN npm install -g bun
#   RUN apt-get update && apt-get install -y --no-install-recommends make \
#    && rm -rf /var/lib/apt/lists/*
#
# A factory whose agents drive a browser (`@playwright/mcp`, the accept stage)
# needs Chromium and its libraries:
#
#   RUN npx -y playwright install --with-deps chromium
# ─────────────────────────────────────────────────────────────────────────────

# The base image's own `node` user holds UID 1000; the station's user takes
# whichever UID owns the checkout.
RUN userdel --remove node \
 && useradd --create-home --uid "${ASF_UID}" --shell /bin/bash asf
USER asf
WORKDIR /work

CMD ["uv", "run", "asf/asf.py", "up", "--pull"]
