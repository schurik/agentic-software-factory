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
  /**
   * The chapters opened and folded by hand, by number. The latest is open
   * unless folded: a chapter that starts after the link was shared opens too.
   */
  opened: number[];
  folded: number[];
  /** The stages opened by hand, as "chapter.stage": they stay open when their chapter folds and opens again. */
  stages: string[];
  /** The phase opened on the Timeline, and which of its tabs. */
  phase: string | null;
  phaseTab: string | null;
}

export const SHOWN: Shown = { tab: "details", opened: [], folded: [], stages: [], phase: null, phaseTab: null };

const KEYS = ["tab", "opened", "folded", "stages", "phase", "phaseTab"] as const;

const list = (value: string | null) => (value ? value.split(",").filter(Boolean) : []);
const numbers = (value: string | null) => list(value).map(Number).filter(Number.isInteger);

export function readShown(search: URLSearchParams): Shown {
  const tab = search.get("tab");
  return {
    tab: TABS.includes(tab as SessionTab) ? tab as SessionTab : SHOWN.tab,
    opened: numbers(search.get("opened")),
    folded: numbers(search.get("folded")),
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
  if (shown.opened.length) search.set("opened", shown.opened.join(","));
  if (shown.folded.length) search.set("folded", shown.folded.join(","));
  if (shown.stages.length) search.set("stages", shown.stages.join(","));
  if (shown.phase) search.set("phase", shown.phase);
  if (shown.phaseTab) search.set("phaseTab", shown.phaseTab);
  const query = search.toString();
  return query ? `?${query}` : "";
}

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
