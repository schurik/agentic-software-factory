import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfigTab } from "../components/factory/ConfigTab";
import { FactoryHeader } from "../components/factory/FactoryHeader";
import { FactoryView } from "../components/factory/FactoryView";
import { type Registration, StationsTab } from "../components/factory/StationsTab";
import {
  behind, budgetWords, drifts, type FactoryTab, type Page, referenceOf, soleAddress, tabHref, tabOf,
} from "../components/factory/view";
import { type WorkflowsRecord, WorkflowsTab } from "../components/factory/WorkflowsTab";
import type { StationDetail } from "../convex/activity";
import type { Look } from "../convex/factory";
import { editRefusal } from "../convex/model/config";
import { readDescription } from "../convex/model/description";
import { phasedIn } from "../convex/model/phases";
import { EMPTY_SUMMARY } from "../convex/model/session";
import { stagesOf } from "../convex/model/workflows";
import { ViewerLogin } from "../components/viewer";
import { recorded } from "./helpers";

// The Factory page's header and tabs, rendered to static markup with no
// backend (spec #40): workflows from the factory's own self-description, a
// factory without one shown as unchecked rather than broken, and each
// station's drift from the default branch.

const golden = import.meta.glob("../../../tests/golden/self-description/v1.json",
                                { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
const DESCRIPTION = readDescription(Object.values(golden)[0]);
const current = import.meta.glob("../../../tests/golden/self-description/v2.json",
                                 { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
const SETTINGS = readDescription(Object.values(current)[0]);
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
      { station: "st_a", name: "alex@mbp:widgets", kind: "local", owner: "alex", seenAt: NOW - 5_000, head: TIP, configHash: "beef",
        watchers: ["issues", "answers"] },
      { station: "st_b", name: "sam@old:widgets", kind: "local", owner: "sam", seenAt: NOW - 3_600_000, head: "1".repeat(40), configHash: "0ld",
        watchers: ["issues", "prs"] },
    ],
    ...fields,
  };
}

const LOOK: Look = {
  ok: true, tip: TIP, files: ["asf/factory.yaml", "asf/workflows/sdlc/workflow.yaml"],
  distances: { ["1".repeat(40)]: { ahead: 0, behind: 3 } }, proposals: [],
};

// The Workflows tab (#120) reads the newer description, whose workflows are the
// ones the staged recording ran, with a record drawn from that recording's rows.
const goldenV2 = import.meta.glob("../../../tests/golden/self-description/v2.json",
                                  { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
const DESCRIBED = readDescription(Object.values(goldenV2)[0]);
const ROWS = phasedIn([], recorded["issue-then-two-reviews-in-stages"].events.map((event) => ({ ...event, payload: JSON.stringify(event.payload) })),
                      EMPTY_SUMMARY, 0).map((row) => ({ ...row, session: "a9f259f0" }));
// Another issue session ended in verify.
const FAILED = { ...ROWS.find((row) => row.workflow === "issue" && row.stage === "verify")!, session: "b0b0b0b0", status: "fail" };
const RECORD: WorkflowsRecord = {
  cut: false,
  workflows: [{ workflow: "issue", sessions: 2, done: 1, failed: 1, open: 0, finish: 14.96, cost: 0.383, tokens: 23_100, last: NOW }],
  stages: stagesOf([...ROWS, FAILED]),
};

function workflowsTab(record?: WorkflowsRecord): string {
  const shown = page({ check: { ...page().check!, description: DESCRIBED } });
  return renderToStaticMarkup(
    <WorkflowsTab check={shown.check} factory="acme/widgets" stations={shown.stations} now={NOW} record={record} onRun={() => {}} />);
}

/** One workflow's card, by its name. */
function card(html: string, name: string): string {
  const from = html.indexOf(`<section aria-label="${name}"`);
  return html.slice(from, html.indexOf("</section>", from));
}

/** One stage's card in a workflow's graph, by its place. */
function stage(html: string, index: number): string {
  const from = html.indexOf(`data-stage="${index}"`);
  const next = html.indexOf(`data-stage="${index + 1}"`, from);
  return html.slice(from, next === -1 ? undefined : next);
}

describe("the Workflows tab", () => {
  it("lists a workflow that does not load first, with asf check's error", () => {
    const html = workflowsTab(RECORD);

    expect(html.indexOf('aria-label="nightly"')).toBeLessThan(html.indexOf('aria-label="issue"'));
    expect(card(html, "nightly")).toContain("does not load, so a run of it is refused");
    expect(card(html, "nightly")).toContain("agent &#x27;nobody&#x27; is neither in the roster");
    expect(html).toContain(`Budget: ${budgetWords(DESCRIBED.budget)}`);
  });

  it("heads each workflow with its input, its trigger labels and how many online stations watch for it — in amber when none", () => {
    const html = workflowsTab(RECORD);

    expect(card(html, "issue")).toContain("asf:ship");
    expect(card(html, "issue")).toContain("watched by 1 online station");           // alex's; sam's is away
    expect(card(html, "pr-review")).toMatch(/text-wait">no online station watches for it/);
    expect(card(html, "quick")).not.toContain("watch");                             // a prompt's: nothing watches for it
    expect(card(html, "issue")).toContain("a tracked work item, scouted, planned");
    expect(card(html, "issue")).toContain("an issue labelled `asf:queued` + `asf:ship`");
  });

  it("says each workflow's last 30 days, one link from its sessions", () => {
    const html = workflowsTab(RECORD);

    expect(card(html, "issue")).toMatch(/2 sessions · 1 done<span class="text-bad"> · 1 failed<\/span> · median 15s · \$0\.38/);
    expect(card(html, "issue")).toContain('href="/sessions?factory=acme%2Fwidgets"');
    expect(card(html, "quick")).toContain("no runs");
    expect(workflowsTab()).not.toContain("Last 30 days");                           // still loading: no record said
  });

  it("draws each workflow with the session page's stage graph, in neutral cards from what starts it to its report", () => {
    const html = card(workflowsTab(RECORD), "issue");

    expect(html.match(/data-stage="\d+"/g)).toHaveLength(10);
    expect(stage(html, 0)).toContain("border-t-fg/40");                             // neutral, never a status edge
    expect(html).not.toMatch(/border-t-(ok|accent|wait|bad)/);
    expect(html).toContain(">an issue</span>");
    expect(html).toContain(">report</span>");
    expect(stage(html, 0)).toContain("scout");
    expect(stage(html, 5)).toContain("reviewer, builder");                         // the agents bound to it
    expect(stage(html, 2)).toContain(">code</span>");
  });

  it("annotates each stage with its rows' median time and cost, its gate's rounds and wait, and marks the slowest and failures", () => {
    const html = card(workflowsTab(RECORD), "issue");

    // plan worked 0.509s for $0.143; its gate asked twice, rejected once, waiting 0.457s at the median.
    expect(stage(html, 1)).toContain("&lt;1s · $0.14 <span class=\"text-faint\">median</span>");
    expect(stage(html, 1)).toContain("plan gate · asks a person");
    expect(stage(html, 1)).toContain("1 of 2 rounds rejected · wait &lt;1s");
    expect(stage(html, 9)).toContain("integrate gate · passes by policy");
    expect(stage(html, 7)).toContain("slowest stage");                             // document: 0.715s
    expect(html.match(/slowest stage/g)).toHaveLength(1);
    expect(stage(html, 4)).toContain("1 failure");
    expect(html.match(/failure/g)).toHaveLength(1);
  });

  it("folds each workflow's agents into a table: where each runs, its tools, and what it may write", () => {
    const html = card(workflowsTab(RECORD), "issue");

    const agents = DESCRIBED.workflows.find((w) => w.name === "issue")!.agents.map((agent) => agent.name);
    expect(html).toContain(`${agents.length} agents: ${agents.join(", ")}`);
    expect(html).toContain("docs/asf/spec/");                                       // the planner's write boundary
    expect(html).toContain("rolls back any change outside what it may write");
  });

  it("runs a prompt workflow from the header's dialog, and only a prompt workflow", () => {
    const html = workflowsTab(RECORD);
    const prompts = DESCRIBED.workflows.filter((w) => w.input === "prompt");

    expect(html.match(/aria-label="Run [^"]+"/g)).toEqual(prompts.map((w) => `aria-label="Run ${w.name}"`));
  });

  it("says a factory without a description is unchecked, and how to check it", () => {
    const html = renderToStaticMarkup(<WorkflowsTab check={null} factory="acme/widgets" stations={[]} now={NOW} />);

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
  /** The Config tab of `shown`, its stations' drift measured by LOOK, for the viewer alex. */
  function config(shown: Page, given: Partial<Parameters<typeof ConfigTab>[0]> = {}): string {
    return renderToStaticMarkup(
      <ViewerLogin.Provider value="alex">
        <ConfigTab page={shown} look={LOOK} drifts={drifts(shown, LOOK)} forge={FORGE} now={NOW} onEdit={() => {}}
                   onTab={() => {}} {...given} />
      </ViewerLogin.Provider>);
  }
  /** The text of the group titled `title`, up to the next one. */
  function group(html: string, title: string): string {
    const from = html.indexOf(`<h2>${title}</h2>`);
    expect(from).toBeGreaterThan(-1);
    const to = html.indexOf("<h2>", from + 1);
    return text(html.slice(from, to < 0 ? undefined : to));
  }
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'").replace(/\s+/g, " ").replace(/ ([,.:;])(?= )/g, "$1");
  const described = page({ check: { ...page().check!, description: SETTINGS } });

  it("leads with Edit config, the files it edits, and the proposals still open", () => {
    const opened: Look = { ...LOOK, proposals: [{
      number: 12, title: "Raise the budget", url: `${FORGE}/acme/widgets/pull/12`, head: "cockpit/alex/raise-the-budget",
      author: "alex", at: NOW - 3_600_000,
    }] };
    const html = config(described, { look: opened });

    expect(html).toMatch(/<button[^>]*>Edit config<\/button>/);
    expect(html).toContain(`href="${FORGE}/acme/widgets/blob/${TIP}/asf/factory.yaml"`);
    expect(html).toMatch(new RegExp(`<a [^>]*href="${FORGE}/acme/widgets/pull/12"[^>]*><svg [^>]*aria-label="pull request"`));
    // The default branch, as the forge has it.
    expect(html).toMatch(new RegExp(`<a [^>]*href="${FORGE}/acme/widgets/tree/main"[^>]*><svg [^>]*aria-label="branch".*?main</span></a>`));
    expect(text(html)).toContain("#12 Raise the budget · by you 1h ago");
    expect(text(config(described))).toContain("No config edit proposed here is open.");
  });

  it("disables Edit config without write access, and says why", () => {
    const because = editRefusal("triage")!;
    const html = config(page({ ...described, edit: because }));

    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Edit config<\/button>/);
    expect(html).toContain(because);
  });

  it("shows each group's resolved settings, from the factory's own self-description", () => {
    const html = config(described);

    const check = group(html, "Check");
    expect(check).toContain("failing");
    expect(check).toMatch(/✓ issue/);
    expect(check).toMatch(/✗ nightly .*agent 'nobody' is neither in the roster/);

    const forge = group(html, "Forge and tracker");
    expect(forge).toContain("GitHub · github.com");
    expect(forge).toContain("Issues GitHub Issues of acme/widgets");
    expect(forge).toContain("Reviews pull requests of acme/widgets, answered by pr-review");
    expect(forge).toContain("queued asf:queued");
    expect(forge).toContain("review failed asf:pr-failed");

    const intake = group(html, "Where work comes from");
    expect(intake).toContain("asf:ship → issue");
    expect(intake).toContain("asf:refine-ship → refine-ship");
    expect(intake).toContain("Queued as asf:queued");
    expect(intake).toContain("Trusted authors you, sam");
    expect(intake).toContain("At once 2 issue runs");
    expect(intake).toContain("Trusted reviewers anyone who can review");
    expect(intake).toContain("Never work review comments by codecov[bot]");
    expect(intake).toContain("Prompts quick, sdlc, ship");

    const gates = group(html, "People at gates");
    expect(gates).toContain("plan passes by policy — on in issue");
    expect(gates).toContain("integrate passes by policy");
    expect(gates).toContain("Every other gate passes by policy.");
    expect(gates).toContain("Attended asks in place for 15m, then suspends");
    expect(gates).toContain("Rounds at most 3");
    expect(gates).toContain("Notifies scripts/notify.sh");

    const landing = group(html, "How work lands");
    expect(landing).toContain("Prompt runs a pull request, opened by the factory");
    expect(landing).toContain("Branches asf/<session> on origin");
    expect(landing).toContain("Based on the branch each station's checkout has out");
    expect(landing).toContain("Worktrees .asf-worktrees/, removed after a clean success, kept otherwise for resume");

    const limits = group(html, "Limits and data");
    expect(limits).toContain("Budget $2.50 · 2M tokens per session");
    expect(limits).toContain("Transcripts kept, and aged out 14 days after a session finishes");
    expect(limits).toContain("The cockpit may send answer, abort, kill, resume");
    expect(limits).toContain("Drift 2 stations on another config → Stations");    // st_a edited, st_b behind on another
    expect(limits).toContain("Purged nothing");
  });

  it("says what a setting's empty or zero value means, and leaves out what an unwatched review watcher would do", () => {
    const settings = structuredClone(SETTINGS.settings!);
    settings.hitl = { ...settings.hitl, waitSeconds: 0, maxRounds: 0, notifyCommand: [] };
    settings.intake.reviews.watched = false;
    settings.intake.trustedAuthors = [];
    const html = config(page({ check: { ...page().check!, description: { ...SETTINGS, settings } } }));

    const gates = group(html, "People at gates");
    expect(gates).toContain("Attended suspends at once");
    expect(gates).toContain("Rounds until the person approves or aborts");
    expect(gates).toContain("Notifies runs no command");
    const intake = group(html, "Where work comes from");
    expect(intake).toContain("Trusted authors anyone whose issue gets labelled");
    expect(intake).toContain("Reviews not watched");
    expect(intake).not.toContain("Trusted reviewers");
    expect(group(html, "Forge and tracker")).toContain("Reviews not watched");
  });

  it("says the settings are not described when the self-description predates them, and still shows the check", () => {
    const html = config(page());

    expect(group(html, "Check")).toMatch(/✗ nightly/);
    expect(text(html)).toContain("Not described.");
    expect(text(html)).toContain("format 1");
    for (const title of ["Forge and tracker", "Where work comes from", "People at gates", "How work lands"]) {
      expect(html).not.toContain(`<h2>${title}</h2>`);
    }
    expect(group(html, "Limits and data")).toContain("Budget $2.50 · 2M tokens per session");
  });

  it("says a factory without a self-description is unchecked, never broken", () => {
    const html = text(config(page({ check: null })));

    expect(html).toContain("Unchecked");
    expect(html).toContain("install.py --ci");
    expect(html).toContain("Not described.");
    expect(html).not.toMatch(/broken|failing/);
  });

  it("lists every purge of the factory's bodies", () => {
    const html = config(described, { purges: [{ at: NOW - 60_000, session: "", via: "cockpit", by: "sam", reason: "a key in a prompt" }] });

    expect(group(html, "Limits and data")).toContain("Purged every session, by sam 1m ago: a key in a prompt");
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
      stations: [{ station: "st_a", name: "alex@mbp:widgets", kind: "local", owner: "alex", seenAt: NOW, head: TIP, configHash: DESCRIPTION.checked.configHash, watchers: [] }],
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
    expect(soleAddress(["acme/widgets", "acme/widgets"], "stations")).toBe("/factories/acme/widgets?tab=stations");
    expect(soleAddress(["acme/widgets", "acme/gadgets"], "stations")).toBe("/factories");
    expect(soleAddress([], "stations")).toBe("/factories");
  });

  it("is where /cost goes: the Overview of the viewer's one factory, or the factories to choose from", () => {
    expect(soleAddress(["acme/widgets"], "overview")).toBe("/factories/acme/widgets");
    expect(soleAddress(["acme/widgets", "acme/gadgets"], "overview")).toBe("/factories");
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
    expect(html).toContain("machine · online");
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

  it("is what the page shows at ?tab=stations: the cards and the registrations waiting, every other tab hidden", () => {
    const shown = page();
    const html = renderToStaticMarkup(
      <FactoryView page={shown} look={LOOK} drifts={drifts(shown, LOOK)} forge={FORGE} now={NOW} tab={tabOf("stations")} onTab={() => {}}
                   triggering={false} onTrigger={() => {}} trigger={null}
                   panels={{ ...PANELS, stations: (
                     <StationsTab stations={[CARD]} ci={{ jobs: [], checks: [] }} drifts={drifts(shown, LOOK)} now={NOW} factory="acme/widgets"
                                  forge={FORGE} defaultBranch="main" release="1.0.0" onApprove={() => {}} onRevoke={() => {}}
                                  registrations={[{ station: "st_new", name: "alex@new:widgets", expiresAt: NOW + 60_000, approved: false, because: null }]} />
                   ) }} />);
    const stations = html.slice(html.indexOf('id="factory-stations"'), html.indexOf('id="factory-config"'));

    expect(panel(html, "stations")).not.toContain("hidden");
    expect(stations).toContain("alex@new:widgets</code> asks to become a station");
    expect(stations).toContain("alex@mbp:widgets");
    for (const tab of ["overview", "workflows", "config"] as const) expect(panel(html, tab)).toContain("hidden");
  });

  it("puts pending registrations on top, to approve with the code the station's terminal shows", () => {
    const html = stationsTab([CARD], [
      { station: "st_new", name: "alex@new:widgets", expiresAt: NOW + 8 * 60_000, approved: false, because: null },
      { station: "st_sam", name: "sam@lab:widgets", expiresAt: NOW + 9 * 60_000, approved: false,
        because: "a station takes commands for its owner, which needs write on acme/widgets; the forge says you have read" },
      { station: "st_ok", name: "dana@box:widgets", expiresAt: NOW + 9 * 60_000, approved: true, because: null },
    ]);

    expect(html.indexOf("alex@new:widgets")).toBeLessThan(html.indexOf("alex@mbp:widgets"));
    expect(html).toContain("the code expires in 8m");
    // The code is typed from the terminal, never shown: Approve waits for it.
    expect(html.match(/<input[^>]*placeholder="ABCD-EF23"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-label="The code alex@new:widgets(&#x27;|')s terminal shows"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve<\/button>/);
    expect(html).toContain("the forge says you have read");
    expect(html).toContain("Approved: it picks up its token on its next poll.");
  });
});
