---
workflow: issue
focus: reviewer
kind: judge
classes:
  - {name: checked_both, fail: false}
  - {name: plan_only, fail: true}
sample_rate: 0
---

# Reviewer scope

Did the reviewer judge the code that was written, or only the plan it was written from?

- **checked_both** — the reviewer read the diff, or the files the build changed, and ruled on the
  requirements against that code. Its findings name files and lines, or say what is missing from
  them.
- **plan_only** — the reviewer ruled from the plan or the builder's summary alone. Its findings
  restate the plan, or could have been written without opening a changed file. An approval like
  that is a reviewer taking the build's word for it.

Read the reviewer's prompts and raw output to see what it actually opened, and cite its accepted
envelope and the tool calls or gate results that show it.

This is an example judge, stamped at `sample_rate: 0`: present, checked by `asf check`, shown as
inactive, and judging nothing. A judge is a model call, paid for each chapter it reads. Give it a
rate (`sample_rate: 0.2` judges a fifth of `issue`'s chapters) to turn it on, change the criteria or
the classes, or delete it. It is yours, like `factory.yaml`: `install.py --force` leaves it as you
left it.
