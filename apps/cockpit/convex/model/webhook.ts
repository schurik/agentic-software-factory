/**
 * What a webhook delivery from the team's App asks the cockpit to do.
 *
 * Deliveries are hints, never the record: GitHub sends each one once and does
 * not retry, so everything a delivery can tell the cockpit the catch-up poll
 * (discovery.ts) can find out for itself. That is also why a delivery is
 * never de-duplicated — acting on one twice is one more look at the forge.
 */
import { isRecord } from "./wire";

export type Asked =
  | { look: string }     // this repository's default branch moved: ask again whether it holds a factory
  | "list"               // the set of repositories changed: list them again
  | null;                // nothing this cockpit reads

export function asks(event: string, payload: unknown): Asked {
  if (!isRecord(payload)) return null;
  switch (event) {
    case "push": {
      const repository = isRecord(payload.repository) ? payload.repository : {};
      const { full_name: name, default_branch: branch } = repository;
      if (typeof name !== "string" || typeof branch !== "string") return null;
      // A factory is what the default branch holds; any other branch changes nothing here.
      return payload.ref === `refs/heads/${branch}` ? { look: name } : null;
    }
    // Installed, uninstalled, suspended; repositories added or removed; one
    // renamed, transferred, deleted, or given another default branch.
    case "installation":
    case "installation_repositories":
    case "repository":
      return "list";
    default:
      return null;
  }
}
