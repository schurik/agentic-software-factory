---
workflow: issue
kind: code
predicate: permission_rolled_back
---

# Permission rollbacks

An issue's chapter fails this when an agent changed a path outside its `writes:` and the factory
undid it. Each rollback is cited, naming the agent, its phase and the paths reverted.

One rollback is a boundary doing its job. The same agent rolled back again and again says its prose
or its task asks for work its `writes:` does not allow, and one of the two is wrong.

This scorer is yours, like `factory.yaml`: focus it on one agent (`focus: builder`) or delete it,
and `install.py --force` leaves it as you left it.
