/**
 * What the session page shows besides the session itself — its tab, the
 * chapters and stages a person opened, the drawer they are reading in — kept
 * in the address, so a link (from an issue comment, say) opens exactly what
 * its sender saw. The page as it first opens writes nothing: a bare link is
 * the default view, not a frozen copy of one.
 */

import type { Go } from "../ui";

export const TABS = ["details", "timeline", "journal"] as const;
export type SessionTab = (typeof TABS)[number];

export interface Shown {
  tab: SessionTab;
  /**
   * The chapters opened and folded by hand, by number. The latest is open
   * unless folded: a chapter that starts after the link was shared opens too.
   */
  opened: number[];
  folded: number[];
  /** The stages opened by hand, as "chapter.stage": they stay open when their chapter folds and opens again. */
  stages: string[];
  /**
   * The drawer (#110): a stage's view, as "chapter.stage"; a phase's, and
   * which of its tabs. A phase opened from a stage's view keeps the stage, and
   * Back goes to it: the address is the drawer's whole stack.
   */
  stage: string | null;
  phase: string | null;
  phaseTab: string | null;
}

export const SHOWN: Shown = { tab: "details", opened: [], folded: [], stages: [], stage: null, phase: null, phaseTab: null };

const KEYS = ["tab", "opened", "folded", "stages", "stage", "phase", "phaseTab"] as const;

const STAGE_KEY = /^\d+\.\d+$/;

const list = (value: string | null) => (value ? value.split(",").filter(Boolean) : []);
const numbers = (value: string | null) => list(value).map(Number).filter(Number.isInteger);

export function readShown(search: URLSearchParams): Shown {
  const tab = search.get("tab");
  return {
    tab: TABS.includes(tab as SessionTab) ? tab as SessionTab : SHOWN.tab,
    opened: numbers(search.get("opened")),
    folded: numbers(search.get("folded")),
    stages: list(search.get("stages")).filter((key) => STAGE_KEY.test(key)),
    stage: STAGE_KEY.test(search.get("stage") ?? "") ? search.get("stage") : null,
    phase: search.get("phase") || null,
    phaseTab: search.get("phaseTab") || null,
  };
}

/** The address's query for `shown`, keeping whatever else `rest` says: "" when there is nothing to say. */
export function writeShown(shown: Shown, rest = new URLSearchParams()): string {
  const search = new URLSearchParams(rest);
  for (const key of KEYS) search.delete(key);
  if (shown.tab !== SHOWN.tab) search.set("tab", shown.tab);
  if (shown.opened.length) search.set("opened", shown.opened.join(","));
  if (shown.folded.length) search.set("folded", shown.folded.join(","));
  if (shown.stages.length) search.set("stages", shown.stages.join(","));
  if (shown.stage) search.set("stage", shown.stage);
  if (shown.phase) search.set("phase", shown.phase);
  if (shown.phaseTab) search.set("phaseTab", shown.phaseTab);
  const query = search.toString();
  return query ? `?${query}` : "";
}

/** A link to `to`: its address, and following it in place through `onShow`. */
export const goTo = (to: Shown, onShow?: (shown: Shown) => void): Go =>
  ({ href: writeShown(to) || "?", onClick: () => onShow?.(to) });

/** Whether chapter `number` is open, the latest being `latest`. */
export function chapterOpen(shown: Shown, number: number, latest: number): boolean {
  return !shown.folded.includes(number) && (number === latest || shown.opened.includes(number));
}

/** `shown` with chapter `number` opened or folded by hand. */
export function withChapter(shown: Shown, number: number, open: boolean): Shown {
  const opened = shown.opened.filter((each) => each !== number);
  const folded = shown.folded.filter((each) => each !== number);
  return open ? { ...shown, opened: [...opened, number], folded } : { ...shown, opened, folded: [...folded, number] };
}

export const stageKey = (chapter: number, stage: number) => `${chapter}.${stage}`;

// ── the drawer ───────────────────────────────────────────────────────────────

/** `shown` with a stage's view open in the drawer, and nothing stacked on it. */
export const withStage = (shown: Shown, chapter: number, stage: number): Shown =>
  ({ ...shown, stage: stageKey(chapter, stage), phase: null, phaseTab: null });

/** `shown` with a phase's view open in the drawer, on its first tab, and nothing under it. */
export const withPhase = (shown: Shown, phaseId: string): Shown => ({ ...shown, stage: null, phase: phaseId, phaseTab: null });

/** `shown` with a phase's view stacked on the stage's view it was opened from: Back goes to the stage. */
export const pushPhase = (shown: Shown, phaseId: string): Shown => ({ ...shown, phase: phaseId, phaseTab: null });

/** `shown` one view back: the stage a phase was opened from, or the drawer closed. */
export const back = (shown: Shown): Shown =>
  (shown.stage && shown.phase ? { ...shown, phase: null, phaseTab: null } : closed(shown));

/** `shown` with the drawer closed. */
export const closed = (shown: Shown): Shown => ({ ...shown, stage: null, phase: null, phaseTab: null });
