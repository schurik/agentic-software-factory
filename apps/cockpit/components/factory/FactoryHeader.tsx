import type { Look } from "@/convex/factory";
import type { Drift } from "@/convex/model/drift";
import { budgetWords, checkWords, type Page, short } from "./view";

/**
 * The Factory page's fixed header: the repository, its default branch's
 * commit, what its `asf check` last said, the flags worth acting on, the
 * configured per-session budget, and Run a prompt. Pure.
 */
export function FactoryHeader({ page, look, drifts, forge, running, onRun }: {
  page: Page;
  look: Look | null;
  drifts: Map<string, Drift>;
  /** The forge's web origin, e.g. https://github.com. */
  forge: string;
  /** Whether the run form is open. */
  running: boolean;
  onRun: () => void;
}) {
  const check = checkWords(page.check);
  const tip = (look?.ok ? look.tip : null) ?? page.check?.head ?? null;
  const drifted = [...drifts.values()].filter((each) => each.drifted).length;
  return (
    <header className="topbar factory-head">
      <div className="grow">
        <h1>
          {page.onForge ? <a href={`${forge}/${page.repo}`}>{page.repo}</a> : page.repo}
          {page.private ? <> <span className="tag">private</span></> : null}
        </h1>
        <p className="muted small">
          {page.defaultBranch ? <><code>{page.defaultBranch}</code>{tip ? <> at <code>{short(tip)}</code></> : null}</>
            : "no default branch the forge shows"}
          {page.check ? <> · budget {budgetWords(page.check.description.budget)}</> : null}
        </p>
        <p className="flags">
          <span className={`tag${check.tone === "bad" ? " tag-bad" : check.tone === "ok" ? " tag-ok" : ""}`}>{check.text}</span>
          {drifted ? <span className="tag tag-wait">{drifted} {drifted === 1 ? "station" : "stations"} drifted</span> : null}
          {page.check?.description.newer ? <span className="tag tag-wait">upgrade the cockpit</span> : null}
        </p>
      </div>
      <div className="action">
        <button type="button" className="button" aria-expanded={running} onClick={onRun}>
          {running ? "Close" : "Run a prompt"}
        </button>
      </div>
    </header>
  );
}
