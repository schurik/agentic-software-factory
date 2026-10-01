/**
 * Triggering a workflow from the cockpit, as a model: which labels on the
 * forge start which workflow, and who may apply them.
 *
 * A factory routes an issue to a workflow by a label (`issues.route` in its
 * `asf/factory.yaml`), and its watcher starts an issue that carries a route
 * label AND the queued label. The cockpit never reads that config (#26: only
 * the factory's own code does). What it reads is the forge: `asf labels
 * --create` gives every label it defines a description, and the route and
 * queued ones (and the running one) are worded so that they can be found again —
 * `tests/golden/labels/` holds both, and the factory's suite and this one read
 * it. A label someone made by hand says nothing here, and is not offered.
 */
import type { Issue, Label, Role } from "../forge/forge";

const ROUTE = /^asf route: a person asked for the (\S+) workflow here$/;
const QUEUED = "asf: waiting for a watcher to claim it";
const RUNNING = "asf: a run has this one";

export interface Route {
  label: string;
  workflow: string;
}

export interface Routes {
  routes: Route[];
  /** The label that queues an issue for the watcher; null when the forge defines none the factory made. */
  queued: string | null;
  /** The label a run puts on the issue it has — and leaves there while it waits at a gate. */
  running: string | null;
}

/** The routes and the queued label among a repository's labels, in the forge's order. */
export function routesOf(labels: Label[]): Routes {
  const routes: Route[] = [];
  let queued: string | null = null;
  let running: string | null = null;
  for (const { name, description } of labels) {
    const routed = ROUTE.exec(description.trim());
    if (routed) routes.push({ label: name, workflow: routed[1] });
    else if (description.trim() === QUEUED) queued ??= name;
    else if (description.trim() === RUNNING) running ??= name;
  }
  return { routes, queued, running };
}

/**
 * Why issue `issue` cannot be triggered with `found`'s labels, or null when it
 * can. What the watcher would do with it decides: an issue already queued
 * starts anyway, with no new `labeled` event to name the viewer, and one a run
 * has — a run parked at a gate leaves it on `running` — would get a second run
 * beside the first.
 */
export function unready(issue: Issue, found: Routes): string | null {
  if (issue.pull) return `#${issue.number} is a pull request: a workflow is triggered on an issue`;
  if (!issue.open) return `#${issue.number} is closed: the watcher starts open issues only`;
  if (found.queued !== null && issue.labels.includes(found.queued)) {
    return `#${issue.number} is already queued: the watcher starts it on its next poll`;
  }
  if (found.running !== null && issue.labels.includes(found.running)) {
    return `a run already has #${issue.number}: answer or end it first`;
  }
  return null;
}

/** Why a repository's routes cannot be offered, or null when they can. */
export function unoffered({ routes, queued }: Routes): string | null {
  if (routes.length && queued !== null) return null;
  const missing = routes.length ? "no queued label" : "no route label";
  return `the forge defines ${missing} this factory made: run \`asf labels --create\` in the repository`;
}

const RANK: Role[] = ["read", "triage", "write", "maintain", "admin"];

/**
 * Why the viewer may not trigger a workflow on a repository where the forge
 * says they are `role` — null when they may. Triage or higher is what the
 * forge asks of anyone who labels an issue (spec #40); the cockpit disables
 * what the forge would refuse, and the forge is what enforces it.
 */
export function refusal(role: Role | null): string | null {
  if (role === null) return "the forge has not said what you may do on this repository";
  if (RANK.indexOf(role) < RANK.indexOf("triage")) {
    return `triggering needs triage or higher on this repository, and the forge says you have ${role}`;
  }
  return null;
}
