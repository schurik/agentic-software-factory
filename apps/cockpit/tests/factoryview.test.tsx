import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfigTab } from "../components/factory/ConfigTab";
import { FactoryHeader } from "../components/factory/FactoryHeader";
import { budgetWords, drifts, type Page, referenceOf } from "../components/factory/view";
import { WorkflowsTab } from "../components/factory/WorkflowsTab";
import type { Look } from "../convex/factory";
import { readDescription } from "../convex/model/description";

// The Factory page's header and tabs, rendered to static markup with no
// backend (spec #40): workflows from the factory's own self-description, a
// factory without one shown as unchecked rather than broken, and each
// station's drift from the default branch.

const golden = import.meta.glob("../../../tests/golden/self-description/v1.json",
                                { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
const DESCRIPTION = readDescription(Object.values(golden)[0]);
const TIP = DESCRIPTION.checked.head;
const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const FORGE = "https://github.com";

function page(fields: Partial<Page> = {}): Page {
  return {
    repo: "acme/widgets", onForge: true, private: false, defaultBranch: "main", role: "write", edit: null,
    check: {
      ref: "main", head: TIP, configHash: DESCRIPTION.checked.configHash, ok: false, at: NOW - 60_000,
      station: "runner@fv-az1:widgets", description: DESCRIPTION,
    },
    stations: [
      { station: "st_a", name: "alex@mbp:widgets", kind: "local", owner: "alex", seenAt: NOW - 5_000, head: TIP, configHash: "beef" },
      { station: "st_b", name: "sam@old:widgets", kind: "local", owner: "sam", seenAt: NOW - 3_600_000, head: "1".repeat(40), configHash: "0ld" },
    ],
    ...fields,
  };
}

const LOOK: Look = {
  ok: true, tip: TIP, files: ["asf/factory.yaml", "asf/workflows/sdlc/workflow.yaml"],
  distances: { ["1".repeat(40)]: { ahead: 0, behind: 3 } },
};

describe("the Workflows tab", () => {
  it("shows each workflow's purpose, trigger, chain, gates and agents from the description", () => {
    const html = renderToStaticMarkup(<WorkflowsTab check={page().check} onRun={() => {}} />);

    expect(html).toContain("a tracked work item, scouted, planned");
    expect(html).toContain("an issue labelled `asf:queued` + `asf:ship`");
    expect(html).toContain("gate: plan · on");
    expect(html).toContain("gate: integrate · off");
    expect(html).toContain("asks: requirements");
    expect(html).toContain("docs/asf/spec/");                       // the planner's write boundary
    expect(html).toContain("$2.50 · 2M tokens per session");
    expect(html).toContain("nightly");                               // a workflow that does not load, said
    // Run, for a prompt workflow only: it opens the header's dialog on that workflow (#108).
    expect(html.match(/>Run<\/button>/g)?.length).toBe(DESCRIPTION.workflows.filter((w) => w.input === "prompt").length);
  });

  it("says a factory without a description is unchecked, and how to check it", () => {
    const html = renderToStaticMarkup(<WorkflowsTab check={null} />);

    expect(html).toContain("Unchecked.");
    expect(html).toContain("install.py --ci");
    expect(html).not.toMatch(/broken|failing/);
  });
});

describe("the header", () => {
  it("names the check's state, the budget, and the stations whose config drifted", () => {
    const shown = page();
    const html = renderToStaticMarkup(
      <FactoryHeader page={shown} look={LOOK} drifts={drifts(shown, LOOK)} forge={FORGE} />);

    expect(html).toContain("check failing");
    expect(html).toContain("2 stations drifted");
    expect(html).toContain(`<code>main</code> at <code>${TIP.slice(0, 7)}</code>`);
    expect(html).not.toContain("Run a prompt");                     // the app header's, not the factory's (#108)
  });

  it("is unchecked, never broken, without a CI workflow", () => {
    const shown = page({ check: null, stations: [] });
    const html = renderToStaticMarkup(
      <FactoryHeader page={shown} look={null} drifts={new Map()} forge={FORGE} />);

    expect(html).toContain("unchecked");
    expect(html).not.toContain("failing");
  });
});

describe("the Config tab", () => {
  it("lists the default branch's files, the check, and each station's drift", () => {
    const shown = page();
    const html = renderToStaticMarkup(
      <ConfigTab page={shown} look={LOOK} drifts={drifts(shown, LOOK)} forge={FORGE} now={NOW} />);

    expect(html).toContain(`href="${FORGE}/acme/widgets/blob/${TIP}/asf/factory.yaml"`);
    expect(html).toContain("failing");
    expect(html).toContain("✗</span> nightly");
    expect(html).toContain("local edits");
    expect(html).toContain("3 commits behind");
  });

  it("measures config only against a check made at the default branch's commit", () => {
    const moved: Look = { ...LOOK, tip: "f".repeat(40) };
    expect(referenceOf(page().check, moved)).toEqual({ head: "f".repeat(40), configHash: null });
    expect(referenceOf(page().check, LOOK)).toEqual({ head: TIP, configHash: DESCRIPTION.checked.configHash });
    expect(referenceOf(null, null)).toEqual({ head: null, configHash: null });
  });

  it("puts the budget in words, and no budget as none", () => {
    expect(budgetWords({ maxCostUsd: 0, maxTokens: 0 })).toBe("no per-session budget");
    expect(budgetWords({ maxCostUsd: 1, maxTokens: 0 })).toBe("$1.00 per session");
  });
});
