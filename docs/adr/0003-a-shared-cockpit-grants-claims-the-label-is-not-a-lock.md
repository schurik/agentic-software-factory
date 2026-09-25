# A shared cockpit grants claims; the forge label is not a lock

When one factory has several stations (two laptops and CI on one repo), their watchers must not both
start a session for the same issue or pull request. The obvious lock, flipping `asf:queued` to
`asf:running`, is not one: the forge has no conditional label edit, so two racing flips both succeed.
So a **claim** is granted by the shared cockpit, one transactional Convex mutation keyed on repo, kind
and number, and every starter asks for it before it touches a label: the watchers, a manual
`asf run issue N` (`--force` overrides), and PR comment triggers. Without a shared cockpit there are
no claims, only the rule of one issues watcher per repository, which the watcher warns about when it
starts. Coordinating several stations is a team feature, and a team has a shared cockpit.

## Considered Options

- **Claim on the forge with read-back**: flip the label, post a claim comment carrying the station
  id, re-read, earliest comment wins. It needs no cockpit, but it is a home-made consensus over an
  API with eventual consistency.
- **One designated issues-watcher station per factory**: correct but brittle, because the chosen
  laptop sleeps. This is kept only as the fallback when there is no shared cockpit.
- **A lease that expires when a station goes offline**: rejected, because a laptop being offline is
  normal, and a suspended session is waiting, not dead. Expiry would start a second session beside it.

## Consequences

A claim is held until its session finishes or is aborted, and a failed session keeps it so `resume`
still works. An orphan is freed only by a writer's "release claim" in the cockpit, which relabels the
item `asf:queued`. The factory's `IssueStates` docstring, which says the flip is the lock, is wrong
and must be corrected.
