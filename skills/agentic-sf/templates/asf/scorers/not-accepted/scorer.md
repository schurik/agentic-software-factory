---
workflow: issue
kind: code
predicate: not_accepted
---

# Not accepted

An issue's chapter fails this when its phases passed and the workflow still did not accept it: a
fix loop that ran out of attempts, or a reviewer who withheld approval. The chapter's end is cited,
with the reason it gave. A chapter that failed in a phase was never judged, and does not count here.

This scorer is yours, like `factory.yaml`: delete it if it does not measure something your team
cares about, and `install.py --force` leaves it as you left it.
