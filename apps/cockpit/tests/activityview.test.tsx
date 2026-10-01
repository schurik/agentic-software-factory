import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityTab } from "../components/factory/ActivityTab";
import { StationsTab } from "../components/factory/StationsTab";
import type { SessionRow, StationDetail } from "../convex/activity";
import type { Attention } from "../convex/model/attention";
import type { ClaimView } from "../convex/model/claim";

// The Factory page's Activity and Stations tabs, rendered to static markup with
// no backend (spec #40): what needs attention, what runs now and where, and
// every station with what depends on it — CI as one entry.

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const HOUR = 3600_000;
const FORGE = "https://github.com";

const CLAIM: ClaimView = {
  id: "k1", kind: "issue", number: 42, repo: "acme/widgets", session: "b1", station: "st_bob", stationName: "bob@desk:widgets",
  seenAt: 0, heardAt: NOW - 50 * HOUR, grantedAt: NOW - 50 * HOUR, released: null, refused: null,
  consequence: "relabels #42 `asf:queued` and abandons session b1",
};

function row(fields: Partial<SessionRow>): SessionRow {
  return {
    session: "s1", workflow: "issue", status: "running", station: "alex@mbp:widgets", stationKind: "local", gate: "",
    triggeredBy: "alex", cost: 0.42, endedAt: NOW - HOUR, ...fields,
  };
}

/** The markup's text, one space between words, the way a person reads it. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");
}

describe("the Activity tab", () => {
  const items: Attention[] = [
    { kind: "gates", mine: 2, total: 3 },
    { kind: "failed", sessions: [{ session: "f1", workflow: "issue", station: "alex@mbp:widgets", endedAt: NOW - 3 * HOUR }] },
    { kind: "claim", claim: CLAIM, away: 50 * HOUR },
    { kind: "drift", stations: [{ station: "st_alex", name: "alex@mbp:widgets", badges: ["on 89abcde"] }] },
    { kind: "check" },
    { kind: "unwatched", issues: [42, 43] },
  ];
  const render = (attention: Attention[] = items) => renderToStaticMarkup(
    <ActivityTab factory="acme/widgets" forge={FORGE} now={NOW} attention={attention} onRelease={() => {}}
                 page={{
                   running: [{ workflow: "issue", sessions: [row({ session: "w1", status: "waiting", gate: "plan round 1", station: "bob@desk:widgets" })] }],
                   recent: [row({ session: "d1", status: "success" })],
                 }} />);

  it("lists each thing that needs attention, with where to act on it", () => {
    const html = render();
    const said = text(html);

    expect(said).toContain("2 gates waiting on you (3 in all)");
    expect(html).toContain('href="/?factory=acme%2Fwidgets"');            // the inbox, filtered to this factory
    expect(said).toContain("f1");
    expect(html).toContain('href="/sessions/acme/widgets/f1"');
    expect(said).toContain("issue #42 held by bob@desk:widgets , offline 2 d");
    expect(html).toContain(">Release claim</button>");
    expect(said).toContain("alex@mbp:widgets");
    expect(said).toContain("on 89abcde");
    expect(said).toMatch(/asf check.*failing/);
    expect(said).toContain("Nobody watching");
    expect(html).toContain(`href="${FORGE}/acme/widgets/issues/42"`);
    expect(said).not.toMatch(/orphan/i);
  });

  it("says when nothing needs attention", () => {
    expect(text(render([]))).toContain("Nothing needs attention");
  });

  it("shows what runs now by workflow, naming each station, and what finished last", () => {
    const said = text(render());

    expect(said).toMatch(/Running now.*issue.*w1.*plan round 1.*bob@desk:widgets/);
    expect(said).toMatch(/Recent.*d1.*success/);
  });
});

describe("the Stations tab", () => {
  const stations: StationDetail[] = [
    {
      station: "st_alex", name: "alex@mbp:widgets", kind: "local", owner: "alex", registered: true, seenAt: NOW - 2_000,
      report: { verbs: ["kill", "resume"], head: "89abcdef", configHash: "beef", watchers: ["issues", "answers"] },
      sessions: [row({ session: "r1" }), row({ session: "f1", status: "fail" })], claims: [],
    },
    {
      station: "st_bob", name: "bob@desk:widgets", kind: "local", owner: "", registered: false, seenAt: 0, report: null,
      sessions: [row({ session: "b1", station: "bob@desk:widgets" })], claims: [CLAIM],
    },
  ];
  const ci = {
    jobs: [row({ session: "ci1", workflow: "pr-review", station: "runner@fv-az1:widgets", stationKind: "ci", status: "success" })],
    checks: [{ ref: "main", head: "a".repeat(40), ok: false, station: "runner@fv-az1:widgets", at: NOW - HOUR }],
  };
  const drifts = new Map([["st_alex", { badges: ["3 commits behind"], drifted: true }]]);
  const render = (selected: string | null) => renderToStaticMarkup(
    <StationsTab stations={stations} ci={ci} drifts={drifts} now={NOW} selected={selected} onSelect={() => {}} onRelease={() => {}} />);

  it("lists each station's name, owner, kind, last seen and drift, and CI as one entry", () => {
    const said = text(render(null));

    expect(said).toMatch(/alex@mbp:widgets alex local .*online.*3 commits behind/);
    expect(said).toMatch(/bob@desk:widgets — local .*never polled/);
    expect(said).toMatch(/CI .*1 job.*1 check push/);
    expect(said.match(/runner@fv-az1/g)).toBeNull();                       // collapsed until opened
  });

  it("opens a station into its verbs, checkout, watchers, sessions and claims", () => {
    const alex = text(render("st_alex"));
    expect(alex).toContain("kill, resume");
    expect(alex).toContain("89abcde");
    expect(alex).toContain("issues, answers");
    expect(alex).toMatch(/r1.*running.*f1.*fail/);

    const bob = text(render("st_bob"));
    expect(bob).toContain("takes no commands");
    expect(bob).toContain("issue #42 held by bob@desk:widgets , offline 2 d");
    expect(bob).toMatch(/Release claim/);
  });

  it("opens the CI entry into its recent jobs and check pushes", () => {
    const said = text(render("ci"));
    expect(said).toMatch(/ci1.*pr-review.*success/);
    expect(said).toMatch(/main.*aaaaaaa.*failing.*runner@fv-az1:widgets/);
  });
});
