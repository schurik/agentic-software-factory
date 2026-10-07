import type { Look } from "@/convex/factory";
import { liveness } from "@/convex/model/command";
import { branchHref } from "../format";
import { ExternalLink, ForgeRef } from "../icons";
import { TriggerButton } from "../trigger/Trigger";
import { PageHeader, Tag } from "../ui";
import { budgetWords, checkWords, type Page, short } from "./view";

/**
 * The Factory page's fixed header (#118), its state in one line: the
 * repository with a link to it on the forge, what its `asf check` last said,
 * the default branch at its commit, how many of its stations are online by
 * the page's clock, and the configured per-session budget — and on the right
 * Trigger… for a factory the forge shows: the Factories list's rows open this
 * page, so it is triggered from here. Run a prompt is the app header's
 * (#108); what drifted is the Stations tab's dot. Pure.
 */
export function FactoryHeader({ page, look, forge, now, triggering, onTrigger }: {
  page: Page;
  look: Look | null;
  /** The forge's web origin, e.g. https://github.com. */
  forge: string;
  now: number;
  /** Whether the trigger form is open, and how to open or close it. */
  triggering: boolean;
  onTrigger: () => void;
}) {
  const check = checkWords(page.check);
  const tip = (look?.ok ? look.tip : null) ?? page.check?.head ?? null;
  const online = page.stations.filter((row) => liveness(row.seenAt, null, now).online).length;
  return (
    <PageHeader
      title={
        <span className="flex flex-wrap items-center gap-2">
          {page.repo}
          {page.onForge ? (
            <a href={`${forge}/${page.repo}`} aria-label={`${page.repo} on the forge`} className="text-faint hover:text-fg">
              <ExternalLink size={16} aria-hidden="true" />
            </a>
          ) : null}
          {page.private ? <Tag>private</Tag> : null}
          {page.check?.description.newer ? <Tag tone="wait">upgrade the cockpit</Tag> : null}
        </span>
      }
      sub={
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <Tag tone={check.tone}>{check.text}</Tag>
          <span>
            {page.defaultBranch ? <><ForgeRef kind="branch" href={branchHref(forge, page.repo, page.defaultBranch)}>{page.defaultBranch}</ForgeRef>
              {tip ? <> at <code>{short(tip)}</code></> : null}</>
              : "no default branch the forge shows"}
          </span>
          <span>{online}/{page.stations.length} stations online</span>
          {page.check ? <span className="tabular-nums">{budgetWords(page.check.description.budget)}</span> : null}
        </p>
      }>
      {page.onForge ? <div><TriggerButton role={page.role} open={triggering} onToggle={onTrigger} /></div> : null}
    </PageHeader>
  );
}
