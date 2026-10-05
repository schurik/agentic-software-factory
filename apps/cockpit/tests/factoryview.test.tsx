import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfigTab } from "../components/factory/ConfigTab";
import { FactoryHeader } from "../components/factory/FactoryHeader";
import { FactoryView } from "../components/factory/FactoryView";
import { type Registration, StationsTab } from "../components/factory/StationsTab";
import {
  behind, budgetWords, drifts, type FactoryTab, type Page, referenceOf, stationsAddress, tabHref, tabOf,
} from "../components/factory/view";
import { WorkflowsTab } from "../components/factory/WorkflowsTab";
import type { StationDetail } from "../convex/activity";
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
  it("leaves Run a prompt to the app header", () => {
    const html = renderToStaticMarkup(
      <FactoryHeader page={page()} look={LOOK} forge={FORGE} now={NOW} triggering={false} onTrigger={() => {}} />);

    expect(html).not.toContain("Run a prompt");                     // the app header's, not the factory's (#108)
  });

  it("offers Trigger… on a factory the forge shows — the Factories list's rows open the page, so this is its one way in", () => {
    const header = (shown: Page) => renderToStaticMarkup(
      <FactoryHeader page={shown} look={null} forge={FORGE} now={NOW} triggering={false} onTrigger={() => {}} />);

    expect(header(page())).toMatch(/<button[^>]*>Trigger…<\/button>/);
    expect(header(page({ onForge: false }))).not.toContain("Trigger…");
  });

  it("is unchecked, never broken, without a CI workflow", () => {
    const shown = page({ check: null, stations: [] });
    const html = renderToStaticMarkup(
      <FactoryHeader page={shown} look={null} forge={FORGE} now={NOW} triggering={false} onTrigger={() => {}} />);

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

// ── the page's shell and its Stations tab (#118) ─────────────────────────────

const PANELS = { overview: <p>the overview</p>, workflows: <p>the workflows</p>, stations: <p>the stations</p>, config: <p>the config</p> };

function factoryView(shown: Page, tab: FactoryTab, look: Look | null = LOOK) {
  return renderToStaticMarkup(
    <FactoryView page={shown} look={look} drifts={drifts(shown, look)} forge={FORGE} now={NOW} tab={tab} onTab={() => {}}
                 triggering={false} onTrigger={() => {}} trigger={null} panels={PANELS} />);
}

/** The panel of `tab`, as `html` has it: hidden or not. */
function panel(html: string, tab: FactoryTab): string {
  return html.match(new RegExp(`<div[^>]*id="factory-${tab}"[^>]*>`))?.[0] ?? "";
}

describe("the factory page", () => {
  it("is headed by the name, its check, the default branch at its commit, the stations online and the budget", () => {
    const html = factoryView(page(), "overview");

    expect(html).toContain(`href="${FORGE}/acme/widgets"`);
    expect(html).toContain("check failing");
    expect(html).toContain(`<code>main</code> at <code>${TIP.slice(0, 7)}</code>`);
    expect(html).toContain("1/2 stations online");                 // st_a polled 5s ago, st_b an hour ago
    expect(html).toContain("$2.50 · 2M tokens per session");
  });

  it("has four tabs, opens on the one its address names, and links to the factory's sessions", () => {
    const html = factoryView(page(), "stations");

    expect(html.match(/role="tab"/g)).toHaveLength(4);
    expect(html).toMatch(/aria-selected="true"[^>]*><span[^>]*>Stations/);
    expect(panel(html, "stations")).not.toContain("hidden");
    expect(panel(html, "overview")).toContain("hidden");
    expect(html).toContain('href="/sessions?factory=acme%2Fwidgets"');
    expect(html).toContain("All sessions →");
  });

  it("marks a tab that holds a problem with a dot: drifted stations, a broken workflow, a failing check", () => {
    const html = factoryView(page(), "overview");

    expect(html).toMatch(/Stations<span[^>]*aria-label="2 stations drifted"/);
    expect(html).toMatch(/Workflows<span[^>]*aria-label="1 broken workflow"/);
    expect(html).toMatch(/Config<span[^>]*aria-label="check failing"/);

    const quiet = page({
      check: { ...page().check!, ok: true, description: { ...DESCRIPTION, problems: [] } },
      stations: [{ station: "st_a", name: "alex@mbp:widgets", kind: "local", owner: "alex", seenAt: NOW, head: TIP, configHash: DESCRIPTION.checked.configHash }],
    });
    expect(factoryView(quiet, "overview")).not.toContain("aria-label=\"1 station drifted\"");
    expect(factoryView(quiet, "overview")).not.toMatch(/<span[^>]*aria-label="[^"]*"[^>]*class="[^"]*rounded-full/);
  });

  it("reads its tab from the address, and writes it there", () => {
    expect(tabOf("stations")).toBe("stations");
    expect(tabOf("nonsense")).toBe("overview");
    expect(tabOf(null)).toBe("overview");
    expect(tabHref("acme/widgets", "stations")).toBe("/factories/acme/widgets?tab=stations");
    expect(tabHref("acme/widgets", "overview")).toBe("/factories/acme/widgets");
  });

  it("is where /stations goes: the stations tab of the viewer's one factory, or the factories to choose from", () => {
    expect(stationsAddress(["acme/widgets", "acme/widgets"])).toBe("/factories/acme/widgets?tab=stations");
    expect(stationsAddress(["acme/widgets", "acme/gadgets"])).toBe("/factories");
    expect(stationsAddress([])).toBe("/factories");
  });
});

const CARD: StationDetail = {
  station: "st_a", name: "alex@mbp:widgets", kind: "local", owner: "alex", registered: true, seenAt: NOW - 5_000,
  report: { verbs: ["kill", "resume"], head: TIP, configHash: "beef", watchers: ["issues", "answers"] },
  sessions: [], claims: [], release: "1.0.0", period: { sessions: 12, failed: 2, cost: 4.2 }, commands: [], revocable: true,
};

function stationsTab(stations: StationDetail[], registrations: Registration[] = [], release = DESCRIPTION.skillVersion) {
  const shown = page();
  return renderToStaticMarkup(
    <StationsTab stations={stations} ci={{ jobs: [], checks: [] }} registrations={registrations} drifts={drifts(shown, LOOK)}
                 now={NOW} factory="acme/widgets" forge={FORGE} defaultBranch="main" release={release}
                 onApprove={() => {}} onRevoke={() => {}} />);
}

describe("the Stations tab", () => {
  it("draws one card per station: liveness and whose, what it watches and takes, its release, commit and config, and its month", () => {
    const html = stationsTab([CARD, { ...CARD, station: "st_b", name: "sam@old:widgets", owner: "sam", seenAt: NOW - 3_600_000, revocable: false }]);

    expect(html).toContain("alex&#x27;s machine");
    expect(html).toContain(">online<");
    expect(html).toContain("away 1h");
    expect(html).toContain("labelled issues · answers on work items");
    expect(html).toContain("kill, resume");
    expect(html).toContain("release 1.0.0");
    expect(html).toContain(`<code>${TIP.slice(0, 7)}</code>`);
    expect(html).toContain("config drifted");                      // local edits: st_a's hash is not main's
    expect(html).toContain("3 commits behind");
    expect(html).toContain("12 sessions");
    expect(html).toContain("2 failed");
    expect(html).toContain("$4.20 on its key");
    expect(html.match(/>Revoke<\/button>/g)).toHaveLength(1);       // only the one the viewer may revoke
  });

  it("says a station never polled, and one nobody registered takes no commands", () => {
    const html = stationsTab([{ ...CARD, owner: "", registered: false, seenAt: 0, report: null, revocable: false }]);

    expect(html).toContain("never polled");
    expect(html).toContain("asf station register");
    expect(html).not.toContain(">Revoke<");
  });

  it("marks a release behind main's in amber, and says nothing of one that is not", () => {
    expect(stationsTab([CARD], [], "1.3.0")).toMatch(/class="[^"]*text-wait[^"]*">behind main(&#x27;|')s 1\.3\.0/);
    expect(stationsTab([CARD], [], "1.0.0")).not.toContain("behind main");
    expect(behind("1.2.0", "1.10.0")).toBe(true);
    expect(behind("1.10.0", "1.2.0")).toBe(false);
    expect(behind("", "1.2.0")).toBe(false);
  });

  it("shows a command waiting for a station on its card, with when it expires", () => {
    const html = stationsTab([{
      ...CARD, commands: [{ verb: "resume", session: "f1", workflow: "", by: "sam", state: "queued", issuedAt: NOW - 15 * 60_000, expiresAt: NOW + 45 * 60_000 }],
    }]);

    expect(html).toContain("resume");
    expect(html).toContain('href="/sessions/acme/widgets/f1"');
    expect(html).toContain("queued by sam 15m ago");
    expect(html).toContain("expires in 45m");
  });

  it("leaves out a command whose time ran out", () => {
    const html = stationsTab([{
      ...CARD, commands: [{ verb: "kill", session: "f1", workflow: "", by: "sam", state: "queued", issuedAt: NOW - 10 * 60_000, expiresAt: NOW - 5 * 60_000 }],
    }]);

    expect(html).not.toContain("expires in");
  });

  it("puts pending registrations on top, to approve only when the code matches the station's terminal", () => {
    const html = stationsTab([CARD], [
      { code: "ABCD-EF23", station: "st_new", name: "alex@new:widgets", kind: "local", expiresAt: NOW + 8 * 60_000, approved: false, because: null },
      { code: "WXYZ-2345", station: "st_sam", name: "sam@lab:widgets", kind: "local", expiresAt: NOW + 9 * 60_000, approved: false,
        because: "a station takes commands for its owner, which needs write on acme/widgets; the forge says you have read" },
    ]);

    expect(html.indexOf("ABCD-EF23")).toBeLessThan(html.indexOf("alex@mbp:widgets"));
    expect(html).toContain("alex@new:widgets");
    expect(html).toContain("Approve only if its terminal shows");
    expect(html).toContain("the code expires in 8m");
    expect(html).toMatch(/<button[^>]*>Approve<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve<\/button>/);
    expect(html).toContain("the forge says you have read");
  });
});
