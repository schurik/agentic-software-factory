# A package, on purpose: it makes the helpers importable as `tests.asf_helpers`
# relative to this file, so a test never depends on pytest's rootdir or on the
# cwd it was invoked from. The tests sit here rather than inside
# `skills/agentic-sf/` because every installer — `npx skills add`, a plugin
# marketplace clone — copies a skill directory wholesale, and none of them offer
# an ignore file. Anything left in there ships to every user of the skill.
