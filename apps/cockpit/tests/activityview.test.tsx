import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StationsTab } from "../components/factory/StationsTab";
import type { SessionRow, StationDetail } from "../convex/activity";
import type { ClaimView } from "../convex/model/claim";

// The Factory page's Stations tab, rendered to static markup with no backend
// (spec #40): every station with what depends on it — CI as one entry.

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const HOUR = 3600_000;

const CLAIM: ClaimView = {
  id: "k1", kind: "issue", number: 42, repo: "acme/widgets", session: "b1", station: "st_bob", stationName: "bob@desk:widgets",
  seenAt: 0, heardAt: NOW - 50 * HOUR, grantedAt: NOW - 50 * HOUR, released: null, refused: null, state: null,
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

describe("the Stations tab", () => {
  const PERIOD = { sessions: 0, failed: 0, cost: 0 };
  const stations: StationDetail[] = [
    {
      station: "st_alex", name: "alex@mbp:widgets", kind: "local", owner: "alex", registered: true, seenAt: NOW - 2_000,
      report: { verbs: ["kill", "resume"], head: "89abcdef", configHash: "beef", watchers: ["issues", "answers"] },
      sessions: [row({ session: "r1" }), row({ session: "f1", status: "fail" })], claims: [],
      release: "1.2.0", period: PERIOD, commands: [], revocable: true,
    },
    {
      station: "st_bob", name: "bob@desk:widgets", kind: "local", owner: "", registered: false, seenAt: 0, report: null,
      sessions: [row({ session: "b1", station: "bob@desk:widgets" })], claims: [CLAIM],
      release: "", period: PERIOD, commands: [], revocable: false,
    },
  ];
  const ci = {
    jobs: [row({ session: "ci1", workflow: "pr-review", station: "runner@fv-az1:widgets", stationKind: "ci", status: "success" })],
    checks: [{ ref: "main", head: "a".repeat(40), ok: false, station: "runner@fv-az1:widgets", at: NOW - HOUR }],
  };
  const drifts = new Map([["st_alex", { badges: ["3 commits behind"], drifted: true }]]);
  const render = () => renderToStaticMarkup(
    <StationsTab stations={stations} ci={ci} registrations={[]} drifts={drifts} now={NOW} factory="acme/widgets" forge="https://github.com"
                 defaultBranch="main" release="1.2.0" onApprove={() => {}} onRevoke={() => {}} onRelease={() => {}} />);

  it("lists under each station the sessions and claims it holds", () => {
    const said = text(render());

    expect(said).toMatch(/alex@mbp:widgets.*r1.*running.*f1.*fail/);
    expect(said).toContain("#42 held by bob@desk:widgets , offline 2d");
    expect(render()).toMatch(/<a [^>]*href="https:\/\/github.com\/acme\/widgets\/issues\/42"[^>]*><svg [^>]*aria-label="issue"/);
    expect(said).toMatch(/Release claim/);
  });

  it("says when a station's forge token expires: amber within two weeks, red within three days, and nothing a station never said", () => {
    const expiring = (tokenExpires: string | undefined) => text(renderToStaticMarkup(
      <StationsTab stations={[{ ...stations[0], report: { ...stations[0].report!, tokenExpires } }]} ci={{ jobs: [], checks: [] }}
                   registrations={[]} drifts={drifts} now={NOW} factory="acme/widgets" forge="https://github.com" defaultBranch="main"
                   release="1.2.0" onApprove={() => {}} onRevoke={() => {}} />));
    const at = (days: number) => new Date(NOW + days * 24 * HOUR).toISOString();

    expect(expiring(at(40))).toMatch(/Forge token expires Nov 10, 2026 · in 40d/);
    expect(expiring(at(10))).toMatch(/Forge token expires Oct 11, 2026 in 10d/);
    expect(expiring(at(-2))).toMatch(/Forge token expired Sep 29, 2026 2d ago/);
    expect(expiring("")).toMatch(/Forge token no expiry date/);
    expect(expiring(undefined)).not.toContain("Forge token");
    const tone = (tokenExpires: string) => renderToStaticMarkup(
      <StationsTab stations={[{ ...stations[0], report: { ...stations[0].report!, tokenExpires } }]} ci={{ jobs: [], checks: [] }}
                   registrations={[]} drifts={new Map()} now={NOW} factory="acme/widgets" forge="https://github.com" defaultBranch="main"
                   release="1.2.0" onApprove={() => {}} onRevoke={() => {}} />);
    expect(tone(at(10))).toMatch(/text-wait[^>]*>in 10d</);
    expect(tone(at(2))).toMatch(/text-bad[^>]*>in 2d</);
  });

  it("draws every CI job as one card, with its recent jobs and check pushes", () => {
    const said = text(render());

    expect(said).toMatch(/CI .*1 job.*1 check push/);
    expect(said).toMatch(/ci1.*pr-review.*success/);
    expect(said).toMatch(/main.*aaaaaaa.*failing.*runner@fv-az1:widgets/);
  });
});
