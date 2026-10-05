/**
 * What the session page shows besides the session itself — its tab, the
 * chapters and stages a person opened, the phase they are reading — kept in
 * the address, so a link (from an issue comment, say) opens exactly what its
 * sender saw. The page as it first opens writes nothing: a bare link is the
 * default view, not a frozen copy of one.
 */

export const TABS = ["details", "timeline", "journal"] as const;
export type SessionTab = (typeof TABS)[number];

export interface Shown {
  tab: SessionTab;
  /** The chapters open, by number; null for the default, the latest alone. */
  chapters: number[] | null;
  /** The stages opened by hand, as "chapter.stage": they stay open when their chapter folds and opens again. */
  stages: string[];
  /** The phase opened on the Timeline, and which of its tabs. */
  phase: string | null;
  phaseTab: string | null;
}

export const SHOWN: Shown = { tab: "details", chapters: null, stages: [], phase: null, phaseTab: null };

const KEYS = ["tab", "chapters", "stages", "phase", "phaseTab"] as const;

const list = (value: string | null) => (value ? value.split(",").filter(Boolean) : []);

export function readShown(search: URLSearchParams): Shown {
  const tab = search.get("tab");
  const chapters = search.get("chapters");
  return {
    tab: TABS.includes(tab as SessionTab) ? tab as SessionTab : SHOWN.tab,
    chapters: chapters === null ? null : list(chapters).map(Number).filter(Number.isInteger),
    stages: list(search.get("stages")).filter((key) => /^\d+\.\d+$/.test(key)),
    phase: search.get("phase") || null,
    phaseTab: search.get("phaseTab") || null,
  };
}

/** The address's query for `shown`, keeping whatever else `rest` says: "" when there is nothing to say. */
export function writeShown(shown: Shown, rest = new URLSearchParams()): string {
  const search = new URLSearchParams(rest);
  for (const key of KEYS) search.delete(key);
  if (shown.tab !== SHOWN.tab) search.set("tab", shown.tab);
  if (shown.chapters !== null) search.set("chapters", shown.chapters.join(","));
  if (shown.stages.length) search.set("stages", shown.stages.join(","));
  if (shown.phase) search.set("phase", shown.phase);
  if (shown.phaseTab) search.set("phaseTab", shown.phaseTab);
  const query = search.toString();
  return query ? `?${query}` : "";
}

/** Whether chapter `number` is open, the latest being `latest`. */
export function chapterOpen(shown: Shown, number: number, latest: number): boolean {
  return shown.chapters === null ? number === latest : shown.chapters.includes(number);
}

export const stageKey = (chapter: number, stage: number) => `${chapter}.${stage}`;
