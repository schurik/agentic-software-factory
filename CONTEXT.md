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
One machine or CI job that runs a given factory's sessions and announces them to a cockpit. A factory
is known to a cockpit through its repository; its sessions reach the cockpit through its stations.
_Avoid_: agent, runner, node, host

**Inbox**:
The cross-repo list, in a cockpit, of every gate currently waiting on the person looking at it.
_Avoid_: queue, pending list, notifications
