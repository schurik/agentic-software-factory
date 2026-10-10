---
workflow: issue
kind: code
predicate: corrections_above(2)
---

# Corrections

An issue's chapter fails this when its agents were sent back to correct themselves more than twice:
an answer that was not the JSON its task asked for, or a round of gates that found a claim untrue.
Each correction is cited, so the chapter's own record says which agent and which claim.

A few corrections are the factory working as designed. Many, chapter after chapter, say a task
file, an agent's prose or a gate is asking for something the agent does not understand.

This scorer is yours, like `factory.yaml`: change the number, focus it on one agent
(`focus: builder`) or delete it, and `install.py --force` leaves it as you left it.
