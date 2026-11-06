# The local cockpit runs detached, and no factory owns it

The local cockpit is one per machine (ADR 0004): the compose project name is fixed, so every
factory on the machine ships to the same backend and keeps its sessions in the same `data` volume.
Until now its lifetime was still one factory's. The `asf up` that found no cockpit ran `docker
compose up` in the foreground as a supervised child; a second `asf up`, in another repository or
another checkout, found it running and joined it. Ctrl-c on the first one then stopped the cockpit
for every factory on the machine, and nothing started it again: the joined `up` had no cockpit
child to restart. Its station kept every event and shipped it once the cockpit was back, so nothing
was lost, but the cockpit was gone until someone noticed and ran `asf up` again in the right
terminal. Which terminal "owns" the machine's cockpit is not something a person should have to keep
track of.

So **the cockpit is a machine's service, not a factory's child.** `asf up` makes sure one is running
and ships to it; it never stops it.

- **Started detached.** The `cockpit` child is a one-shot: `docker compose up --detach --pull
  missing`, which returns once the containers are started. The supervisor retires it on exit 0
  (and says where the cockpit is and how to stop it), and retries it like a crash on anything else.
  Ctrl-c on `asf up` stops that factory's station loop and its watchers, and leaves the cockpit
  running for everyone else.
- **Docker brings it back.** `backend` and `app` carry `restart: unless-stopped`, so the cockpit
  comes back after a reboot or a Docker restart. `keygen` does not: it runs once, and the app reads
  the key it left in the `keys` volume.
- **Joined at its version or newer, never recreated.** An `up` that finds a cockpit running at its
  stamp's version or newer ships to it as it is. Before, a running cockpit at the same version was
  started again, which was harmless while the starting `up` was its only user. Detached, `compose
  up` with another factory's compose file or forge token would recreate the containers every other
  factory is shipping to. Only an older cockpit is replaced, because the cockpit upgrades first.
- **Stopped by name.** `asf cockpit down` (`compose down`, keeping the volumes) is the one thing that
  stops it, and it says it stops it for every factory on the machine. `asf cockpit status` says
  whether one runs and at which version; `asf cockpit logs [-f]` shows what it logged, which `asf up`
  no longer prefixes into its own output. `asf status` and `asf doctor` say whether it is running.

The supervisor stays NOT A DAEMON for everything that is the factory's own: the station loop and the
watchers still live and die with the terminal `asf up` runs in.

## Considered Options

- **Keep it attached, and have a joined `up` take over when the owner leaves.** The joined process
  would watch for the cockpit to disappear and start it itself. That is less change, but each ctrl-c
  still stops the cockpit, and the next `up` to notice starts it again a few seconds later. Every
  factory on the machine sees an outage it did not cause.
- **Count the users, and let the last `up` out stop it.** Each `up` would leave a lease in a file on
  the machine, and stop the cockpit only when none is left. A killed `up` leaves its lease behind,
  so this needs pid probes and stale-lease handling, and still stops a cockpit the person may want
  to keep open to read finished sessions.
- **A system service (launchd, systemd).** Two platforms to support, plus installing something
  outside the repository. Docker's own restart policy already does this.

## Consequences

The cockpit keeps running after the last `asf up` on the machine has stopped. That is the point,
but it uses memory, and the containers are visible in `docker ps`; `asf cockpit down` is how to get
the machine back. `asf status` and `asf doctor` name it, so it is never running unnoticed.

The forge token the local cockpit asks the forge with (`ASF_COCKPIT_FORGE_TOKEN`) is the one held
by whoever's `up` started it, as before, but it is no longer handed over again by every `up` at the
same version. A new `gh` login reaches the cockpit the next time it starts: `asf cockpit down`, then
`asf up`.

A stamp from before this change still runs the cockpit attached when its `up` is the one that starts
it, and its ctrl-c still stops it for everyone. Upgrading every factory on the machine removes that.
