claude_code — `claude -p`; models are aliases (opus, sonnet, haiku) and the CLI brings its own auth, so no API key is needed

The factory you just stamped runs on Claude Code. Before the first run:

1. **The CLI is installed and on PATH** — `claude --version`. Install with
   `npm i -g @anthropic-ai/claude-code`, or set `CLAUDE_PATH` in `.env`.
2. **You are authenticated** — `claude auth`. A Claude subscription is enough.
3. **Nothing on your machine reaches an agent** — not your `CLAUDE.md`, skills,
   plugins, hooks, settings or MCP servers; a run must not depend on whose machine
   ran it. Hand an agent what it needs in its `harness:` block instead:
   `skills: [tdd]` (from `.claude/skills/` or `.agents/skills/`), `context: [CLAUDE.md]`.
4. **Running as root?** The CLI refuses `permission_mode: bypassPermissions` there.
   Use `acceptEdits`, and know that it silently denies what it would have prompted for.
