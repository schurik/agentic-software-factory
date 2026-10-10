---
workflow: issue
kind: code
predicate: limit_hit
---

# Limit hits

An issue's chapter fails this when a limit stopped one of its agents: the session's `budget:`
ceiling (tokens or cost) refused its next turn, or a turn ran past `timeout_seconds`. Each limit hit
is cited, with the limit and the value that met it.

A limit hit now and then is a budget doing its job. Many say the limits are set below honest work,
or an agent loops where it should stop.

This scorer is yours, like `factory.yaml`: count one kind only (`limit_hit(cost)`,
`limit_hit(tokens)`, `limit_hit(timeout)`), focus it on one agent or delete it, and
`install.py --force` leaves it as you left it.
