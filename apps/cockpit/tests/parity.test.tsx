import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatClock, formatCost, formatDollars, formatDuration, formatTokenCount, formatTokens } from "../components/format";
import { PhaseTabs, tabsFor, type Where } from "../components/session/PhaseTabs";
import { SessionView, type Page } from "../components/session/SessionView";
import { phaseView, view } from "../convex/model/session";
import { recorded, type WireEvent } from "./helpers";

// The parity test: the gate the legacy trace UI was deleted behind, in 1.2.
//
// That UI showed one factory's runs from a local database. The cockpit shows
// everything it showed, for a real session: the one the corpus recorded under the old factory, an issue
// and then two rounds of pull-request review (provenance beside it, in
// tests/golden/sessions/issue-then-two-reviews/provenance.md). Each test below
// is one item of that UI's session view, the checklist:
//
//   phases · gates · envelopes · cost and context · tool-call timing ·
//   events · the pull request and issue links
//
// and the two it showed from what the cockpit only holds when a factory opted
// in to transcripts — the compiled prompts, and what a tool call was given and
// returned. That is the deliberate trade: without the opt-in, neither leaves
// the station, and the last test proves the page then shows neither.
//
// Not on the list on purpose: the waterfall's time axis. A phase's clock time
// and duration are shown; the bars laid out against a shared axis are not.
//
// Every expectation is read off the recorded events themselves — what the
// factory wrote down — never off the cockpit's own fold of them, so the test
// cannot agree with the page by construction.

const { events: RECORDED } = recorded["issue-then-two-reviews"];
const LATER = Date.parse("2026-09-30T18:00:00Z");
const WHERE: Where = { factory: "acme/widgets", session: "a9f259f0", forge: "https://github.com" };

const stored = (events: WireEvent[]) => events.map((event) => ({ ...event, payload: JSON.stringify(event.payload) }));

function page(events: WireEvent[]): Page {
  const acked = events.at(-1)!.seq;
  return { ...WHERE, acked, budget: null, ...view(stored(events), acked) };
}

/** The session page as a browser first paints it. */
const sessionHtml = (events: WireEvent[] = RECORDED) =>
  renderToStaticMarkup(<SessionView page={page(events)} now={LATER} />);

/** One phase's tab as a person opens it. */
function tabHtml(phaseId: string, tab: string, events: WireEvent[] = RECORDED): string {
  const detail = phaseView(stored(events), events.at(-1)!.seq, phaseId)!;
  return renderToStaticMarkup(<PhaseTabs detail={detail} where={WHERE} initial={tab} />);
}

/** What a person reads: the text, whitespace collapsed, markup and entities gone. */
function read(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
}

/** What a person reads of one phase's card on the page: from its anchor to the next item. */
function card(html: string, phaseId: string): string {
  const from = html.indexOf(` id="phase-${phaseId}"`);
  if (from === -1) throw new Error(`no card for ${phaseId} on the page`);
  const to = html.slice(from + 1).search(/<li |<\/ol>/);
  return read(html.slice(from, to === -1 ? undefined : from + 1 + to));
}

/** Text as `read` leaves it, to look for in what it returns. */
const collapsed = (text: string) => text.replace(/\s+/g, " ").trim();

const of = (kind: string, events: WireEvent[] = RECORDED) => events.filter((event) => event.kind === kind);
const phaseOf = (event: WireEvent) => String(event.payload.phase_id ?? "");

/** Every phase the session entered, once each, in the order it first started. */
const PHASES = [...new Map(of("phase_started").map((event) => [phaseOf(event), event])).values()];
/** The phases a person opens into tabs: what an agent or code ran. A gate is a card of its own. */
const OPENED = PHASES.filter((event) => event.payload.kind !== "engineer");

/** Seconds `phaseId` spent running: each start to its end, but for a run that only replayed the record. */
function ran(phaseId: string): number {
  let seconds = 0;
  let start: WireEvent | null = null;
  let replayed = false;
  for (const event of RECORDED.filter((each) => phaseOf(each) === phaseId)) {
    if (event.kind === "phase_started") [start, replayed] = [event, false];
    if (event.kind === "phase_replayed") replayed = true;
    if (event.kind === "phase_ended" && start && !replayed) seconds += (Date.parse(event.ts) - Date.parse(start.ts)) / 1000;
  }
  return seconds;
}

describe("parity with the legacy trace UI, over the session recorded under the old factory", () => {
  it("phases: every phase the session entered, once, in order, with what it was for, who ran it and how it ended", () => {
    const html = sessionHtml();
    const anchors = [...html.matchAll(/ id="phase-([^"]+)"/g)].map((match) => match[1]);
    expect(anchors).toEqual(PHASES.map(phaseOf));

    for (const started of OPENED) {
      const id = phaseOf(started);
      const ended = of("phase_ended").filter((event) => phaseOf(event) === id).at(-1)!;
      const overview = read(tabHtml(id, "overview"));
      expect(overview, id).toContain(`For ${collapsed(String(started.payload.description))}`);
      expect(overview, id).toContain(`Run by ${started.payload.kind} · ${started.payload.owner}`);
      expect(overview, id).toContain(`Outcome ${ended.payload.status}${ended.payload.error ? ` — ${ended.payload.error}` : ""}`);
    }

    // How long each one took, in the outline beside its name: the time it ran,
    // where a run a resume answered from the record ran nothing.
    const nav = html.indexOf('<nav aria-label="Outline"');
    const outline = read(html.slice(nav, html.indexOf("</nav>", nav)));
    for (const started of OPENED) {
      expect(outline, phaseOf(started)).toContain(`${started.payload.name} ${formatDuration(ran(phaseOf(started)))}`);
    }
  });

  it("gates: every check a gate made, in the phase it checked, and every gate a person or the policy passed", () => {
    for (const result of of("gate_result")) {
      const { gate, attempt, passed, checks, violations } = result.payload as {
        gate: string; attempt: number; passed: boolean; checks: { item: string; ok: boolean; note: string }[];
        violations: string[];
      };
      const when = `${attempt > 0 ? `attempt ${attempt}` : "on resume, checked against the record"} · ${formatClock(result.ts)}`;
      const said = checks.map((check) => (check.note ? `${check.item}: ${check.note}` : check.item)).join(" ");
      const broke = passed ? "" : violations.join("; ");
      expect(read(tabHtml(phaseOf(result), "checks")), `seq ${result.seq}`)
        .toContain(collapsed(`${passed ? "✓" : "✕"} ${gate} ${when} ${said} ${broke}`));
    }

    const page = read(sessionHtml());
    const decided = new Map(of("decision_recorded").map((event) => {
      const decision = event.payload.decision as Record<string, string>;
      return [`${decision.gate}/${decision.round}`, decision];
    }));
    const VERDICT: Record<string, string> = { approve: "approved", reject: "rejected" };
    for (const decision of decided.values()) {
      if (decision.by === "policy") {
        expect(page).toContain(`⚙ ${decision.gate} gate passed by policy · automatic, nobody was asked`);
        continue;
      }
      const asked = of("suspended").map((event) => event.payload as { waiting_for: Record<string, unknown>; head_sha: string })
        .find(({ waiting_for }) => waiting_for.gate === decision.gate && waiting_for.round === Number(decision.round))!;
      expect(page).toContain(`◐ ${decision.gate} gate · round ${decision.round} ${VERDICT[decision.verdict]} by ${decision.by} ` +
        `Asked on issue #${asked.waiting_for.issue_number} · subject at ${asked.head_sha.slice(0, 7)} · ${asked.waiting_for.summary}`);
      expect(page).toContain(`✎ instruction ${decision.notes}`);
    }
    expect([...decided.values()].map((decision) => decision.by)).toContain("policy");
  });

  it("envelopes: every report an agent made, as it made it, and every one refused, with what the agent said instead", () => {
    const page = read(sessionHtml());
    for (const accepted of of("envelope_accepted")) {
      const { output_type: type, envelope } = accepted.payload as { output_type: string; envelope: { summary: string } };
      expect(page, `seq ${accepted.seq}`).toContain(`${type} · ${envelope.summary}`);
      expect(read(tabHtml(phaseOf(accepted), "overview")), `seq ${accepted.seq}`)
        .toContain(collapsed(`Envelope · ${type} ${JSON.stringify(envelope, null, 2)}`));
    }
    for (const refused of of("envelope_rejected")) {
      const { output_type: type, attempt, error, raw } = refused.payload as Record<string, string>;
      expect(read(tabHtml(phaseOf(refused), "checks")), `seq ${refused.seq}`)
        .toContain(collapsed(`✕ ${type} refused, attempt ${attempt}: ${error} → re-prompted in the same session ` +
          `what the agent answered ${raw}`));
    }
    expect(of("envelope_rejected")).not.toHaveLength(0);
  });

  it("cost and context: every agent call's spend in its phase, how full its context got, and the session's total", () => {
    const usages = of("usage").map((event) => ({ event, ...(event.payload as {
      model: string; tokens: number; cost: number; context_tokens: number; context_window: number;
      usage: Record<string, number>;
    }) }));

    for (const id of new Set(usages.map(({ event }) => phaseOf(event)))) {
      const mine = usages.filter(({ event }) => phaseOf(event) === id);
      const tab = read(tabHtml(id, "cost"));
      const cost = mine.reduce((sum, turn) => sum + turn.cost, 0);
      const tokens = mine.reduce((sum, turn) => sum + turn.tokens, 0);
      expect(tab, id).toContain(`${formatCost(cost)} · ${formatTokens(tokens)} · list-price equivalent`);
      for (const { model, tokens: spent, cost: paid, usage } of mine) {
        expect(tab, id).toContain([model, formatTokenCount(spent), formatCost(paid), formatTokenCount(usage.input_tokens),
          formatTokenCount(usage.output_tokens), formatTokenCount(usage.cache_read_tokens), formatTokenCount(usage.cache_write_tokens),
          formatTokenCount(usage.reasoning_tokens)].join(" "));
      }
      const last = mine.filter((turn) => turn.context_window > 0).at(-1);
      if (last) {
        expect(tab, id).toContain(`Context window ${formatTokenCount(last.context_tokens)} of ${formatTokens(last.context_window)} · ` +
          `${Math.round((last.context_tokens / last.context_window) * 100)}%`);
      }
    }
    expect(usages.filter((turn) => turn.context_window > 0)).not.toHaveLength(0);

    const total = usages.reduce((sum, turn) => sum + turn.cost, 0);
    const tokens = usages.reduce((sum, turn) => sum + turn.tokens, 0);
    expect(read(sessionHtml())).toContain(`Cost ${formatDollars(total)} · ${formatTokens(tokens)}`);
  });

  it("tool-call timing: every call in the phase that made it, in order, with when, whether it worked and how long it took", () => {
    const calls = of("tool_called");
    expect(calls).not.toHaveLength(0);
    const ms = (took: number) => (took < 1000 ? `${took}ms` : formatDuration(took / 1000));
    for (const id of new Set(calls.map(phaseOf))) {
      const mine = calls.filter((event) => phaseOf(event) === id);
      const rows = [...tabHtml(id, "tools").matchAll(/<tr><td>([^<]*)<\/td><td><code>([^<]+)<\/code><\/td><td[^>]*>([^<]+)<\/td><td[^>]*>([^<]+)<\/td><\/tr>/g)]
        .map((row) => row.slice(1));
      expect(rows, id).toEqual(mine.map((event) => {
        const { tool, ok, duration_ms: took } = event.payload as { tool: string; ok: boolean; duration_ms: number };
        return [formatClock(event.ts), tool, ok ? "✓ ok" : "✕ failed", ms(took)];
      }));
      const failed = mine.filter((event) => !event.payload.ok).length;
      expect(card(sessionHtml(), id), id)
        .toContain(`${mine.length} tool call${mine.length === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}`);
    }
    expect(read(sessionHtml())).toContain(`${calls.length} tool calls`);
  });

  it("events: every event the session wrote, listed in order and said in words, and each in the phase it is about", () => {
    const rows = [...sessionHtml().matchAll(
      /<tr( class="text-muted")?><td[^>]*>(\d+)<\/td><td><code>([^<]+)<\/code>(?:<span[^>]*>[^<]*<\/span>)?<\/td><td>([^<]*)<\/td>/g)];
    expect(rows.map((row) => [Number(row[2]), row[3]])).toEqual(RECORDED.map((event) => [event.seq, event.kind]));
    for (const row of rows) {
      expect(row[1], `seq ${row[2]} is a generic row`).toBeUndefined();
      expect(row[4].trim(), `seq ${row[2]} says nothing`).not.toBe("");
    }

    for (const started of OPENED) {
      const id = phaseOf(started);
      const tab = tabHtml(id, "events");
      for (const event of RECORDED.filter((each) => phaseOf(each) === id)) {
        expect(tab, `seq ${event.seq}`).toMatch(new RegExp(`<td[^>]*>${event.seq}</td><td><code>${event.kind}</code>`));
        expect(read(tab), `seq ${event.seq}`).toContain(collapsed(JSON.stringify(event.payload, null, 2)));
      }
    }
  });

  it("the pull request and issue links: the work item it started from and the pull request it became, each a link", () => {
    const named = (field: string) => [...new Set(RECORDED.map((event) => String(event.payload[field] ?? "")).filter(Boolean))];
    const [issue, ...otherIssues] = named("issue_url");
    const [pr, ...otherPrs] = named("pr_url");
    expect([issue, pr, otherIssues, otherPrs]).toEqual([expect.any(String), expect.any(String), [], []]);
    const issueNumber = of("provenance_recorded").map((event) => Number(event.payload.issue_number)).find(Boolean);

    const html = sessionHtml();
    expect(html).toContain(`<dt>Links</dt><dd><a href="${issue}">issue</a> · <a href="${pr}">pull request</a></dd>`);
    expect(html).toContain(`answering <a href="${issue}">issue #${issueNumber}</a>`);
    expect(html.split(`answering <a href="${pr}">pull request #${pr.split("/").pop()}</a>`)).toHaveLength(
      of("workflow_started").filter((event) => event.payload.input === "pr").length + 1);
    expect(html).toContain(` href="${pr}">Open pull request ↗</a>`);
  });

  it("compiled prompts, opted in: every prompt sent to an agent, corrections included, with the identity it was given", () => {
    const prompts = of("prompt_rendered");
    expect(prompts).not.toHaveLength(0);
    for (const sent of prompts) {
      const { send, system, prompt } = sent.payload as { send: number; system: string; prompt: string };
      expect(read(tabHtml(phaseOf(sent), "transcript")), `seq ${sent.seq}`).toContain(collapsed(
        `Prompt ${send}${send > 1 ? " · a correction" : ""} ${system ? `the agent's identity ${system} ` : ""}${prompt}`));
    }
  });

  it("tool arguments and results, opted in: what every call was given and returned, in the harness output of its phase", () => {
    const output = of("harness_output");
    const calls = output.flatMap((chunk) => String(chunk.payload.text).split("\n")
      .filter((line) => line.startsWith("{") && JSON.parse(line).type === "tool_call").map((line) => [chunk, line] as const));
    expect(calls).toHaveLength(of("tool_called").length);
    for (const [chunk, line] of calls) {
      const tab = read(tabHtml(phaseOf(chunk), "transcript"));
      expect(tab, `seq ${chunk.seq}`).toContain(collapsed(line));
      const { args, result } = JSON.parse(line) as { args: object; result: string };
      expect(Object.keys(args), `seq ${chunk.seq}`).not.toHaveLength(0);
      expect(result, `seq ${chunk.seq}`).not.toBe("");
    }
    for (const id of new Set(of("tool_called").map(phaseOf))) {
      expect(read(tabHtml(id, "tools")), id).toContain("What a call was given and returned is transcript material, on the Transcript tab");
    }
  });

  it("without the opt-in, neither: the page and every tab show no prompt and no tool call's arguments, and say why", () => {
    const TRANSCRIPT = ["prompt_rendered", "harness_output"];
    const shipped = RECORDED.filter((event) => !TRANSCRIPT.includes(event.kind))
      .map((event, index) => ({ ...event, seq: index + 1 }));
    const everything = read([
      sessionHtml(shipped),
      ...OPENED.flatMap((started) => {
        const id = phaseOf(started);
        const detail = phaseView(stored(shipped), shipped.at(-1)!.seq, id)!;
        return tabsFor(detail).map((tab) => tabHtml(id, tab, shipped));
      }),
    ].join(" "));

    for (const sent of of("prompt_rendered")) {
      for (const text of [sent.payload.system, sent.payload.prompt].map(String).filter(Boolean)) {
        expect(everything, `seq ${sent.seq}`).not.toContain(collapsed(text));
      }
    }
    expect(everything).not.toContain('"args"');
    expect(everything).not.toContain('"pattern": "build_prompt"');
    expect(everything).toContain("Transcripts are off for this factory: the session shipped no prompt and no harness output.");
    expect(everything).toContain("What a call was given and returned is transcript material, and this factory has not opted in");
  });
});
