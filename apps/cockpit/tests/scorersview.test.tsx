import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MeasureTab } from "../components/factory/MeasureTab";
import type { Scorers, ScorerView } from "../convex/measure";
import { lastDays } from "../convex/model/period";
import type { Mark } from "../convex/model/scorers";

// The Measure tab's Scorers view (#190), rendered from the query's answer
// with no backend: an accordion, one scorer open at a time, each row words in
// shared columns, and the open one telling one story — where it stands in a
// sentence, the session strip, its failing counted sessions, and what it is.

const NOW = Date.parse("2026-10-06T12:00:00Z");
const WEEK = lastDays(7, NOW, "UTC");

/** Ten sessions, s1 oldest: `judged` says how the scorer saw each — x failing, o passing, - not judged — and the last `counted` judged are counted. */
function stripOf(judged: string, counted: number): Mark[] {
  const marks = [...judged].map((c, index) => ({ session: `s${index + 1}`, judged: c !== "-", failing: c === "x", counted: false }));
  for (const mark of marks.filter((each) => each.judged).slice(-counted)) mark.counted = true;
  return marks;
}

function scorer(fields: Partial<ScorerView> & { name: string }): ScorerView {
  const strip = fields.strip ?? [];
  const counted = fields.counted ?? strip.filter((mark) => mark.counted).map(({ session, failing }) => ({ session, failing }));
  return {
    kind: "code", workflow: "issue", focus: "", sampleRate: 1, inactive: false,
    classes: [{ name: "above", fail: true }, { name: "within", fail: false }],
    threshold: { failures: 3, ofLast: 10 }, strip, counted,
    failures: counted.filter((each) => each.failing).length, shares: { before: null, counted: null }, failing: [],
    ...fields,
  };
}

const CORRECTIONS = scorer({
  name: "corrections", focus: "builder", strip: stripOf("o-xo-o-x-o", 4), shares: { before: 0.5, counted: 0.25 },
  failing: [{ session: "s8", chapter: 2, class: "above", cite: { seq: 14, detail: "gate artifacts_exist failed: docs/asf/spec/plan.md: missing", phaseId: "s8_03_plan" } }],
});
const REVIEWER = scorer({
  name: "reviewer-scope", kind: "judge", focus: "reviewer", sampleRate: 0.2, threshold: { failures: 2, ofLast: 5 },
  classes: [{ name: "checked_both", fail: false }, { name: "plan_only", fail: true }], strip: stripOf("----------", 0),
});
const IDLE = scorer({ name: "limit-hits", sampleRate: 0, inactive: true, strip: stripOf("----------", 0) });

const SCORERS: Scorers = { described: true, sessions: 10, scorers: [CORRECTIONS, REVIEWER, IDLE] };

function text(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").replace(/ ([:.,])/g, "$1");
}

/** The view over `scorers` — the ones above unless said otherwise, undefined while the query asks — with `open` open. */
const render = (scorers: Scorers | null | undefined = SCORERS, open: string | null = null) => renderToStaticMarkup(
  <MeasureTab factory="acme/widgets" metrics={undefined} scorers={scorers} openScorer={open} onOpenScorer={() => {}}
              view="scorers" onView={() => {}} days={7} midnights={WEEK} timeZone="UTC" onDays={() => {}} />,
);

/** The open scorer's story alone: what follows its opening tag. */
function storyHtml(html: string): string {
  const after = html.split('data-story=""')[1] ?? "";
  const next = after.indexOf("data-row=");
  return after.slice(after.indexOf(">") + 1, next === -1 ? undefined : after.lastIndexOf("<li", next));
}

const story = (html: string) => text(storyHtml(html));

describe("the Scorers view", () => {
  it("is a view of the Measure tab, with no period: a scorer counts sessions, not days", () => {
    const html = render();
    expect(html).toMatch(/aria-current="page"[^>]*>Scorers</);
    expect(html).not.toMatch(/aria-label="Period"/);
  });

  it("lists each scorer as a row of words in shared columns, the columns named once over them", () => {
    const html = render();
    const said = text(html);

    expect(said).toMatch(/Scorer .*Judges .*Issue .*Failing, counted/);
    expect(said).toMatch(/corrections code issue · builder · every chapter 1/);
    expect(said).toMatch(/reviewer-scope judge issue · reviewer · samples 20% 0/);
    expect(said).toMatch(/limit-hits code issue inactive/);
    for (const name of ["Scorer", "Judges", "Issue", "Failing, counted"]) expect(html).toContain(`aria-label="About: ${name}"`);
  });

  it("draws the counted sessions as cells: failing amber below the threshold, the rest still to count dashed", () => {
    const row = render().split(">corrections<")[1].split(">reviewer-scope<")[0];
    expect(row.match(/data-cell="failing"/g)).toHaveLength(1);
    expect(row.match(/data-cell="passing"/g)).toHaveLength(3);
    expect(row.match(/data-cell="uncounted"/g)).toHaveLength(6);
    expect(row).toMatch(/class="[^"]*bg-wait[^"]*" data-cell="failing"/);
  });

  it("draws a dashed cell for every session still to count, all of them while nothing is", () => {
    const row = render().split(">reviewer-scope<")[1].split(">limit-hits<")[0];
    expect(row.match(/data-cell="uncounted"/g)).toHaveLength(5);
  });

  it("draws the cells red once the counted failures are the threshold", () => {
    const at = scorer({ name: "corrections", strip: stripOf("xxxo------", 4) });
    const row = render({ ...SCORERS, scorers: [at] });
    expect(row).toMatch(/class="[^"]*bg-bad[^"]*" data-cell="failing"/);
    expect(story(render({ ...SCORERS, scorers: [at] }, "corrections"))).toContain("3 of the last 4 sessions it judged failed: the threshold for an issue is reached.");
  });

  it("opens one scorer at a time, the open row saying so", () => {
    const html = render(SCORERS, "corrections");
    expect(html.match(/data-row=/g)).toHaveLength(3);
    expect(html.match(/aria-expanded="true"[^>]*data-row="corrections"/g)).toHaveLength(1);
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1);
    expect(html.match(/data-story/g)).toHaveLength(1);
  });
});

describe("an open scorer's sentence", () => {
  it("says how many more failing sessions are to an issue", () => {
    expect(story(render(SCORERS, "corrections"))).toMatch(/^ 1 of the last 4 sessions it judged failed: 2 more to an issue\./);
  });

  it("says when a scorer is inactive, and how to turn it on", () => {
    expect(story(render(SCORERS, "limit-hits"))).toMatch(/^ Inactive: sample_rate: 0 judges no chapter\. Give it a rate to turn it on\./);
  });

  it("says when nothing is scored yet, and what it will judge", () => {
    expect(story(render(SCORERS, "reviewer-scope"))).toMatch(/^ No chapter scored yet\. It judges 20% of issue's chapters as they end\./);
    const code = scorer({ name: "corrections", strip: stripOf("----------", 0) });
    expect(story(render({ ...SCORERS, scorers: [code] }, "corrections"))).toMatch(/^ No chapter scored yet\. It judges every chapter of issue as it ends\./);
  });

  it("says when no counted session failed", () => {
    const clean = scorer({ name: "corrections", strip: stripOf("oooo------", 4) });
    expect(story(render({ ...SCORERS, scorers: [clean] }, "corrections"))).toMatch(/^ No failing score in the last 4 sessions it judged\./);
  });
});

describe("the session strip", () => {
  it("marks every session of the factory's last ones, a low mark for one the scorer did not judge, each opening its session", () => {
    const html = storyHtml(render(SCORERS, "corrections"));

    expect(html.match(/data-mark="not judged"/g)).toHaveLength(4);
    expect(html.match(/data-mark="counted"/g)).toHaveLength(4);
    expect(html.match(/data-mark="older"/g)).toHaveLength(2);
    expect(html).toContain('href="/sessions/acme/widgets/s1"');
    expect(text(html)).toContain("The factory's last 10 sessions, oldest first");
  });

  it("draws a failing session amber while the scorer is below its threshold, older ones too", () => {
    const html = storyHtml(render(SCORERS, "corrections"));
    expect(html.match(/bg-wait/g)).toHaveLength(2);
    expect(html).not.toContain("bg-bad");
  });

  it("brackets the counted marks and no further: not the unjudged sessions after them", () => {
    const trailing = scorer({ name: "corrections", strip: stripOf("oxoooxoo--", 4) });
    expect(storyHtml(render({ ...SCORERS, scorers: [trailing] }, "corrections"))).toMatch(/data-bracket=""[^>]*style="left:40%;right:20%"/);
  });

  it("opens the bracket on the left when the counted sessions reach back past the strip", () => {
    const back = scorer({ name: "corrections", strip: stripOf("ooo-------", 3), counted: [{ session: "old", failing: true }, ...["s1", "s2", "s3"].map((session) => ({ session, failing: false }))] });
    const html = storyHtml(render({ ...SCORERS, scorers: [back] }, "corrections"));
    expect(html).toMatch(/data-bracket="" class="[^"]*rounded-br-sm[^"]*" style="left:0;right:70%"/);
  });

  it("compares the failing share before the counted sessions with theirs", () => {
    expect(story(render(SCORERS, "corrections"))).toContain("failing share 50% before · 25% counted");
  });

  it("brackets the counted sessions, and says the threshold they are held to", () => {
    const said = story(render(SCORERS, "corrections"));
    expect(said).toContain("counted: the last 4 it judged");
    expect(said).toContain("3 failing of the last 10 are the threshold for an issue");
  });

  it("is never a weekly failing-share chart", () => {
    expect(story(render(SCORERS, "corrections"))).not.toMatch(/week/i);
  });
});

describe("the failing counted sessions", () => {
  it("are each its class, a link to the chapter, and the first event it cites, linking to its phase", () => {
    const html = render(SCORERS, "corrections");
    const said = story(html);

    expect(said).toMatch(/Failing, counted above session s8 · chapter 2 seq 14 gate artifacts_exist failed: docs\/asf\/spec\/plan\.md: missing/);
    expect(html).toContain('href="/sessions/acme/widgets/s8?opened=2"');
    expect(html).toContain('href="/sessions/acme/widgets/s8?opened=2&amp;phase=s8_03_plan"');
  });
});

describe("the footer", () => {
  it("says quietly what the scorer is: its kind, its scope, the classes it fails and passes on", () => {
    expect(story(render(SCORERS, "corrections"))).toMatch(/code · issue · focus builder · every chapter · fails on above · passes on within\s*$/);
    expect(story(render(SCORERS, "reviewer-scope"))).toMatch(/judge · issue · focus reviewer · samples 20% · fails on plan_only · passes on checked_both\s*$/);
  });
});

describe("what the view says when there is nothing to show", () => {
  it("waits while it asks, and refuses a factory the viewer cannot read", () => {
    expect(text(renderToStaticMarkup(
      <MeasureTab factory="acme/widgets" metrics={undefined} scorers={undefined} openScorer={null} onOpenScorer={() => {}}
                  view="scorers" onView={() => {}} days={7} midnights={WEEK} timeZone="UTC" onDays={() => {}} />,
    ))).toContain("Loading");
    expect(text(render(null))).toContain("This is not a factory you can read.");
  });

  it("says the factory has not described itself, which is what names its scorers", () => {
    expect(text(render({ described: false, sessions: 0, scorers: [] }))).toContain("No self-description yet");
  });

  it("says no scorer measures the factory, and how one is added", () => {
    const html = render({ described: true, sessions: 4, scorers: [] });
    expect(text(html)).toContain("No scorer measures this factory.");
    expect(html).toContain("asf/scorers/&lt;name&gt;/scorer.md");
  });

  it("says an empty factory has no session to judge yet, and still lists its scorers", () => {
    const empty: Scorers = { described: true, sessions: 0, scorers: [scorer({ name: "corrections" })] };
    const said = text(render(empty, "corrections"));
    expect(said).toContain("No session yet: each scorer judges a chapter of its workflow once it ends.");
    expect(said).toContain("corrections");
    expect(said).not.toContain("oldest first");
  });
});
