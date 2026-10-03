# The cockpit owes no parity with the legacy trace UI

`tests/parity.test.tsx` held the session page to everything the legacy trace UI showed, so that the
UI could be deleted behind it in 1.2 — and once it was, the rule kept every fact on the first paint,
which is why the page grew to a dozen sidebar facts and forty "details" links (#100). The cockpit is
now designed for the person who answers a gate and the person who watches what is moving; the person
debugging a phase finds its detail one drawer deep, not on the page. So the parity checklist is
deleted, and each page is held instead to acceptance tests written from those people's side: what
the first paint shows, and what is one click away.

## Consequences

Two of the parity tests were never about the legacy UI and move into the session page's own tests:
that without `cockpit: {transcripts: true}` no prompt and no tool call's arguments appear anywhere,
and say why (invariant 11); and that the Journal is `engine/journal.py`'s `render` byte for byte —
a contract between two codebases, kept on the model's output however the page then displays it.
