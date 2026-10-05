import Link from "next/link";
import type { ReactNode } from "react";
import type { Look } from "@/convex/factory";
import type { Drift } from "@/convex/model/drift";
import { plural } from "../format";
import { cx, Tabs } from "../ui";
import { FactoryHeader } from "./FactoryHeader";
import { FACTORY_TABS, type FactoryTab, type Page } from "./view";

/** A tab's dot: what problem it holds, said to a screen reader and on hover, and how bad. */
interface Dot {
  label: string;
  tone: "wait" | "bad";
}

/**
 * The problem each tab holds, if any (#104): a workflow `asf check` refused,
 * a station whose config drifted from the default branch — as the page
 * measured it — and a failing check.
 */
export function dotsOf(page: Page, drifts: Map<string, Drift>): Partial<Record<FactoryTab, Dot>> {
  const broken = page.check?.description.problems.length ?? 0;
  const drifted = [...drifts.values()].filter((each) => each.drifted).length;
  return {
    ...(broken ? { workflows: { label: `${plural(broken, "broken workflow")}`, tone: "bad" as const } } : {}),
    ...(drifted ? { stations: { label: `${plural(drifted, "station")} drifted`, tone: "wait" as const } } : {}),
    ...(page.check && !page.check.ok ? { config: { label: "check failing", tone: "bad" as const } } : {}),
  };
}

/**
 * One factory's page (#118): its header, and four tabs — Overview, Workflows,
 * Stations and Config — the one open being the address's (`?tab=`), each
 * marked with a dot when it holds a problem, and the factory's sessions one
 * link away on the Sessions page. Every panel stays mounted, so a draft — the
 * config editor's — outlives a look at another tab. Pure: the panels come in
 * drawn.
 */
export function FactoryView({ page, look, drifts, forge, now, tab, onTab, triggering, onTrigger, trigger, panels }: {
  page: Page;
  look: Look | null;
  drifts: Map<string, Drift>;
  /** The forge's web origin, e.g. https://github.com. */
  forge: string;
  now: number;
  tab: FactoryTab;
  onTab: (tab: FactoryTab) => void;
  triggering: boolean;
  onTrigger: () => void;
  /** The trigger form, while it is open. */
  trigger: ReactNode;
  panels: Record<FactoryTab, ReactNode>;
}) {
  const dots = dotsOf(page, drifts);
  const tabs = (Object.keys(FACTORY_TABS) as FactoryTab[]).map((id) => {
    const dot = dots[id];
    return {
      id,
      label: (
        <span className="inline-flex items-center gap-1.5">
          {FACTORY_TABS[id]}
          {dot ? <span role="img" aria-label={dot.label} title={dot.label}
                        className={cx("size-1.5 rounded-full", dot.tone === "bad" ? "bg-bad" : "bg-wait")} /> : null}
        </span>
      ),
    };
  });
  return (
    <div>
      <FactoryHeader page={page} look={look} forge={forge} now={now} triggering={triggering} onTrigger={onTrigger} />
      {trigger}
      <Tabs label="Factory" selected={tab} onSelect={onTab} tabs={tabs} end={
        <Link href={`/sessions?factory=${encodeURIComponent(page.repo)}`}
              className="text-sm whitespace-nowrap text-muted no-underline hover:text-fg">
          All sessions →
        </Link>
      } />
      {(Object.keys(FACTORY_TABS) as FactoryTab[]).map((id) => (
        <div key={id} id={`factory-${id}`} role="tabpanel" aria-label={FACTORY_TABS[id]} className="pt-6" hidden={id !== tab}>
          {panels[id]}
        </div>
      ))}
    </div>
  );
}
