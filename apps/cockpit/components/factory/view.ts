import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { Look } from "@/convex/factory";
import type { Budget } from "@/convex/model/description";
import { type Drift, drift, type Reference } from "@/convex/model/drift";
import { formatDollars, formatTokens } from "../format";

export type Page = NonNullable<FunctionReturnType<typeof api.factory.page>>;
export type Check = NonNullable<Page["check"]>;
export type StationRow = Page["stations"][number];

/** What the header says of the factory's `asf check`: never "broken" for a factory that never ran one. */
export function checkWords(check: Page["check"]): { text: string; tone: "ok" | "bad" | "none" } {
  if (check === null) return { text: "unchecked", tone: "none" };
  return check.ok ? { text: "check passing", tone: "ok" } : { text: "check failing", tone: "bad" };
}

/** The per-session budget, as factory.yaml sets it — the only ceiling the factory enforces. */
export function budgetWords(budget: Budget): string {
  const parts = [
    ...(budget.maxCostUsd ? [formatDollars(budget.maxCostUsd)] : []),
    ...(budget.maxTokens ? [formatTokens(budget.maxTokens)] : []),
  ];
  return parts.length ? `${parts.join(" · ")} per session` : "no per-session budget";
}

/**
 * The default branch as drift is measured against it: the commit the forge
 * says it is at now (else the one the last check ran on), and the config hash
 * that check carried — only when it ran on that very commit, because a config
 * changed since would make every station look drifted, or none.
 */
export function referenceOf(check: Page["check"], look: Look | null): Reference {
  const head = (look?.ok ? look.tip : null) ?? check?.head ?? null;
  return { head, configHash: check !== null && check.head === head ? check.configHash : null };
}

/** Each reporting station's drift, by the forge's distances when the look asked about its commit. */
export function drifts(page: Page, look: Look | null): Map<string, Drift> {
  const reference = referenceOf(page.check, look);
  return new Map(page.stations.map((row) => {
    const distance = look?.ok && row.head in look.distances ? look.distances[row.head] : undefined;
    return [row.station, drift(row, reference, distance)];
  }));
}

/** The prompt workflows a description names: what Run a prompt may start. */
export function promptWorkflows(check: Page["check"]): string[] {
  return (check?.description.workflows ?? []).filter((workflow) => workflow.input === "prompt").map((workflow) => workflow.name);
}

export function factoryHref(repo: string): string {
  return `/factories/${repo.split("/").map(encodeURIComponent).join("/")}`;
}

export function short(sha: string): string {
  return sha.slice(0, 7);
}
