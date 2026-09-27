# The local cockpit ships as the team deployment's container images

The cockpit lives outside the skill (ADR 0001), so a stamped repository doesn't contain it, but
`asf up` has to start one on localhost when no shared cockpit is configured. It does this by running
the same published container images a team deploys: the self-hosted Convex backend plus the cockpit
app, from `ghcr.io`, through a compose file. There is then one artifact to build, version and test,
and local mode stays exactly the team deployment on localhost (ADR 0002). Each skill release names a
**minimum** cockpit version, and `asf up` pulls anything at least that new, because the cockpit
upgrades first. The price is that local mode needs Docker, where the legacy visualizer needed only
bun. Without Docker, `asf up` drops the `cockpit` child with a warning and the watchers still run.

## Considered Options

- **A clone of this repository, pointed at by `ASF_COCKPIT_DIR`**, like `ASF_SKILL` today:
  rejected. It couples a stamped factory to a path in someone's checkout, which is exactly why
  deleting the visualizer breaks every old stamp at once.
- **An npm package run with `bunx`, bundling a Convex local backend**: a lighter prerequisite, but a
  second distribution of the cockpit, built and tested apart from the one teams run.

## Consequences

Publishing images becomes part of cutting a release. The skill's `doctor` checks for Docker and for
the minimum image version, not for bun.
