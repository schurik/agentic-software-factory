import type { Look } from "@/convex/factory";
import type { Drift } from "@/convex/model/drift";
import { PageHeader, Tag } from "../ui";
import { budgetWords, checkWords, type Page, short } from "./view";

/**
 * The Factory page's fixed header: the repository, its default branch's
 * commit, what its `asf check` last said, the flags worth acting on, the
 * configured per-session budget. Run a prompt is the app header's (#108). Pure.
 */
export function FactoryHeader({ page, look, drifts, forge }: {
  page: Page;
  look: Look | null;
  drifts: Map<string, Drift>;
  /** The forge's web origin, e.g. https://github.com. */
  forge: string;
}) {
  const check = checkWords(page.check);
  const tip = (look?.ok ? look.tip : null) ?? page.check?.head ?? null;
  const drifted = [...drifts.values()].filter((each) => each.drifted).length;
  return (
    <PageHeader
      title={
        <span className="flex flex-wrap items-center gap-2">
          {page.onForge ? <a href={`${forge}/${page.repo}`} className="text-fg">{page.repo}</a> : page.repo}
          {page.private ? <Tag>private</Tag> : null}
        </span>
      }
      sub={
        <div className="grid gap-2">
          <p className="text-sm">
            {page.defaultBranch ? <><code>{page.defaultBranch}</code>{tip ? <> at <code>{short(tip)}</code></> : null}</>
              : "no default branch the forge shows"}
            {page.check ? <> · budget {budgetWords(page.check.description.budget)}</> : null}
          </p>
          <p className="flex flex-wrap gap-1.5">
            <Tag tone={check.tone}>{check.text}</Tag>
            {drifted ? <Tag tone="wait">{drifted} {drifted === 1 ? "station" : "stations"} drifted</Tag> : null}
            {page.check?.description.newer ? <Tag tone="wait">upgrade the cockpit</Tag> : null}
          </p>
        </div>
      } />
  );
}
