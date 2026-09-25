# Agentic Software Factory

A skill that stamps a deterministic control plane — a factory — into a repository, where it runs
bounded agent phases under code-owned sequencing, gates and permissions.

## Language

**Factory**:
Exactly one stamped `asf/` in exactly one repository: its config, workflows, agents and runtime data.
A repository holds at most one factory.
_Avoid_: instance, installation, deployment

**Workflow**:
A named, checked composition of stages inside a factory, started against a prompt, an issue or a pull request.
_Avoid_: pipeline, flow

**Session**:
One run of one workflow, identified by its id, with its own directory of state under the factory's data dir.
_Avoid_: run (as a noun for the whole thing), job, execution

**Cockpit**:
A separately deployed, optional system that observes and steers many factories. It never runs a
factory's agents itself; it runs shared for a team or locally for one person, and a factory works
fully without a shared one.
_Avoid_: control tower, dashboard, hub, factory manager, visualizer

**Station**:
One checkout of a repository — on a machine or in a CI job — that runs its factory's sessions and
ships them to a cockpit. A factory is known to a cockpit through its repository; its sessions reach
the cockpit through its stations. A station on a machine belongs to one person, its **owner**, and
is **online** while its long-lived loop keeps asking the cockpit for commands; a CI station lives for
one job, has no owner and takes no commands.
_Avoid_: agent, runner, node, host

**Claim**:
One station's exclusive right, granted by a shared cockpit, to start a session for one work item.
It is what keeps two stations' watchers from both starting the same issue; without a shared cockpit
there is no claim, only the rule of one watcher per repository.
_Avoid_: lock, lease, assignment

**Inbox**:
The cross-repo list, in a cockpit, of every gate currently waiting on the person looking at it.
_Avoid_: queue, pending list, notifications

**Command**:
One steering action, from a closed set, that a cockpit asks a station to carry out on a named session
when the forge cannot carry it: kill, resume, answering a terminal-channel gate, or a prompt run.
_Avoid_: instruction, order, job, RPC

**Self-description**:
A factory's own machine-readable account of its workflows, stages, agents and gates, produced by the
factory's code at one commit. A cockpit renders it and never interprets workflow files itself.
_Avoid_: manifest, schema, config dump

**Domain event**:
A typed, versioned fact about a session, emitted by the factory as it happens. It is the only thing a
station ships; a cockpit builds every view it shows from domain events.
_Avoid_: trace, log line, message, file sync
