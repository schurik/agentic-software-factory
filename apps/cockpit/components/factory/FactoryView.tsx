import Link from "next/link";
import type { ReactNode } from "react";
import type { Look } from "@/convex/factory";
import type { Drift } from "@/convex/model/drift";
import { StatusDot, TabPanel, Tabs } from "../ui";
import { FactoryHeader } from "./FactoryHeader";
import { dotsOf, FACTORY_TABS, type FactoryTab, type Page } from "./view";

/**
 * One factory's page (#118): its header, and five tabs — Overview, Workflows,
 * Measure, Stations and Config — the one open being the address's (`?tab=`), each
 * marked with a dot when it holds a problem, and the factory's sessions one
 * link away on the Sessions page. Every panel stays mounted, so a draft — the
 * config editor's — outlives a look at another tab. Pure: the panels come in
 * drawn.
 */
export function FactoryView({ page, look, drifts, forge, now, tab, onTab, panels }: {
  page: Page;
  look: Look | null;
  drifts: Map<string, Drift>;
  /** The forge's web origin, e.g. https://github.com. */
  forge: string;
  now: number;
  tab: FactoryTab;
  onTab: (tab: FactoryTab) => void;
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
          {dot ? <StatusDot status={dot.status} label={dot.label} /> : null}
        </span>
      ),
    };
  });
  return (
    <div className="flex flex-col gap-5">
      <FactoryHeader page={page} look={look} forge={forge} now={now} />
      <Tabs label="Factory" selected={tab} onSelect={onTab} tabs={tabs} className="flex flex-col gap-6" end={
        <Link href={`/sessions?factory=${encodeURIComponent(page.repo)}`}
              className="text-sm whitespace-nowrap text-muted no-underline hover:text-fg">
          All sessions →
        </Link>
      }>
        {(Object.keys(FACTORY_TABS) as FactoryTab[]).map((id) => (
          <TabPanel key={id} value={id} keepMounted>{panels[id]}</TabPanel>
        ))}
      </Tabs>
    </div>
  );
}
