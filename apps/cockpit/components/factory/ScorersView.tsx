import Link from "next/link";
import type { ReactNode } from "react";
import type { Scorers, ScorerView } from "@/convex/measure";
import { leftOf, type Mark } from "@/convex/model/scorers";
import { About, Named } from "../About";
import { sessionHref } from "../format";
import { SHOWN, writeShown } from "../session/shown";
import { Card, cx, Notice, Tag } from "../ui";

/**
 * The Measure tab's Scorers view (#190): an accordion, one scorer open at a
 * time — no two scorers are read together — nearest its threshold first and
 * the inactive last. A row is words in the columns every row shares; the open
 * one tells one story, top to bottom: where the scorer stands in a sentence,
 * the session strip, its failing counted sessions, and — quietly, last — what
 * it is. Pure: `scorers` is the query's answer, and `open` the scorer open.
 */
export function ScorersView({ factory, scorers, open, onOpen }: {
  factory: string;
  scorers: Scorers;
  open: string | null;
  onOpen: (scorer: string | null) => void;
}) {
  if (!scorers.described) {
    return (
      <Notice>
        No self-description yet: a factory&apos;s scorers are what its own <code>asf check --json</code> names, pushed by a CI
        station from the default branch.
      </Notice>
    );
  }
  if (!scorers.scorers.length) {
    return (
      <Notice>
        No scorer measures this factory. A scorer is one <code>asf/scorers/&lt;name&gt;/scorer.md</code>, judging the chapters
        of one workflow; a fresh stamp ships four on <code>issue</code>. A factory stamped before 1.3 describes none.
      </Notice>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {scorers.sessions ? null : <Notice>No session yet: each scorer judges a chapter of its workflow once it ends.</Notice>}
      <Card className="overflow-hidden">
        <Legend />
        <ul className="divide-y divide-line">
          {scorers.scorers.map((line) => {
            const opened = line.name === open;
            return (
              <li key={line.name}>
                <button type="button" aria-expanded={opened} data-row={line.name} onClick={() => onOpen(opened ? null : line.name)}
                        className={cx(ROW, "w-full cursor-pointer px-4 py-3 text-left", opened ? "bg-surface-2" : "hover:bg-surface-2/60")}>
                  <RowHead line={line} />
                </button>
                {opened ? <Story factory={factory} line={line} sessions={scorers.sessions} /> : null}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

/** The columns a row and its legend share. */
const ROW = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_5rem_auto]";

const pct = (share: number) => `${Math.round(share * 100)}%`;

/** What a failing session is drawn in: amber while the scorer is below its threshold, red once it is at it. */
const failingTone = (line: ScorerView) => (leftOf(line) === 0 ? "bad" : "wait");
const BG = { bad: "bg-bad", wait: "bg-wait" } as const;
const TEXT = { bad: "text-bad", wait: "text-wait" } as const;

/** How much of its workflow a scorer judges, in words: every chapter, or the share it samples; nothing while inactive. */
function reach(line: ScorerView): string | null {
  if (line.inactive) return null;
  return line.sampleRate >= 1 ? "every chapter" : `samples ${pct(line.sampleRate)}`;
}

/** The column names, once, over the rows — each with what it means, since a row is a button and cannot hold an (i). */
function Legend() {
  return (
    <div className={cx(ROW, "border-b border-line px-4 py-2 text-xs font-medium text-muted")}>
      <Named title="Scorer" about={<>
        <p>A <b>scorer</b> is a team-written judgement of a finished chapter of one workflow. It runs on a station after the chapter ends and records a <b>score</b>: one of its classes, each declared failing or not, with the domain events it cites as evidence. A score is never a number.</p>
        <p>A scorer <b>measures</b>; a gate <b>decides</b>. A score never changes how the chapter ended — a criterion that must block work is a gate instead.</p>
        <p><b>code</b> — a fixed predicate over the chapter&apos;s events, so it judges every chapter. <b>judge</b> — a model judging the chapter against prose criteria, on a sampled share of chapters.</p>
      </>}>Scorer</Named>
      {/* On a phone a row shows the scorer and where it stands: the names of the columns it hides are hidden too. */}
      <span className="hidden md:block"><Named title="Judges" about={<>
        <p>Which chapters the scorer scores: its <b>workflow</b>&apos;s, then the one agent it is <b>focused</b> on, if any.</p>
        <p><b>every chapter</b>, or <b>samples 20%</b> — a judge&apos;s <code>sample_rate</code>. At <code>0</code> it is present but inactive.</p>
      </>}>Judges</Named></span>
      <span className="hidden md:block"><Named title="Issue" about={<>
        <p>The scorer&apos;s open <b>self-improvement</b> issue, on the factory&apos;s own tracker: at most one per scorer, holding the evidence and a diagnosis, worked like any other issue — nothing changes until a person accepts its plan and merges its pull request.</p>
        <p>Empty until the factory files one: self-improvement is still to come.</p>
      </>}>Issue</Named></span>
      <Named className="justify-self-end" title="Failing, counted" about={<>
        <p>The sessions <b>counted</b> toward the scorer&apos;s threshold: the last distinct sessions it judged, as many as its <code>improve_after:</code> says — or the factory&apos;s <code>self_improvement:</code>.</p>
        <p>The <b>number</b> is how many of them failed; each <b>cell</b> is one counted session, oldest first. A <b>dashed</b> cell is one still to count.</p>
        <p><b>Amber</b>: failing, below the threshold. <b>Red</b>: the threshold is reached — that many failing sessions are the pattern self-improvement files an issue for.</p>
      </>}>Failing, counted</Named>
    </div>
  );
}

function RowHead({ line }: { line: ScorerView }) {
  return (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <span className={cx("truncate font-mono text-[14px] font-medium", line.inactive && "text-muted")}>{line.name}</span>
        <span className="shrink-0"><Tag>{line.kind}</Tag></span>
      </span>
      <span className="hidden min-w-0 truncate text-sm text-muted md:block">
        <b className="font-medium text-fg">{line.workflow}</b>
        {line.focus ? <> · <span className="font-mono text-[13px] text-fg">{line.focus}</span></> : null}
        {line.inactive ? null : <> · {reach(line)}</>}
      </span>
      {/* The issue: none until self-improvement files one. */}
      <span className="hidden md:block" />
      <span className="justify-self-end"><Counted line={line} /></span>
    </>
  );
}

/**
 * Where a scorer stands, drawn: the failing count, then a cell per counted
 * session, oldest first — failing amber below the threshold and red at it —
 * and a dashed cell for each session still to count.
 */
function Counted({ line }: { line: ScorerView }) {
  if (line.inactive) return <span className="text-sm text-muted">inactive</span>;
  const failing = failingTone(line);
  const tone = line.failures ? TEXT[failing] : "text-muted";
  const still = Math.max(0, line.threshold.ofLast - line.counted.length);
  return (
    <span className="inline-flex items-center gap-2"
          title={`${line.failures} failing of the ${line.counted.length} sessions counted; ${line.threshold.failures} failing of the last ${line.threshold.ofLast} are the threshold`}>
      <span className={cx("w-3 text-right text-sm font-medium tabular-nums", tone)}>{line.failures}</span>
      <span className="flex items-end gap-[2px]">
        {line.counted.map((each) => (
          <span key={each.session} className={cx("block h-4 w-1.5 rounded-[1px]", each.failing ? BG[failing] : "bg-line-strong")}
                data-cell={each.failing ? "failing" : "passing"} />
        ))}
        {Array.from({ length: still }, (_, index) => (
          <span key={index} className="block h-4 w-1.5 rounded-[1px] border border-dashed border-line-strong" data-cell="uncounted" />
        ))}
      </span>
    </span>
  );
}

// ── the open scorer ─────────────────────────────────────────────────────────

/** Where the scorer stands, in one sentence that depends on its state. */
function sentenceOf(line: ScorerView): ReactNode {
  const { failures, counted } = line;
  if (line.inactive) return <>Inactive: <code>sample_rate: 0</code> judges no chapter. Give it a rate to turn it on.</>;
  if (!counted.length) {
    return line.sampleRate >= 1
      ? <>No chapter scored yet. It judges every chapter of {line.workflow} as it ends.</>
      : <>No chapter scored yet. It judges {pct(line.sampleRate)} of {line.workflow}&apos;s chapters as they end.</>;
  }
  const last = `the last ${counted.length} sessions it judged`;
  if (!failures) return <><b className="font-semibold">No failing score</b> in {last}.</>;
  const left = leftOf(line);
  const said = <b className={cx("font-semibold", TEXT[failingTone(line)])}>{failures} of {last} failed</b>;
  return left ? <>{said}: {left} more to an issue.</> : <>{said}: the threshold for an issue is reached.</>;
}

function Story({ factory, line, sessions }: { factory: string; line: ScorerView; sessions: number }) {
  const scope = [line.kind, line.workflow, ...(line.focus ? [`focus ${line.focus}`] : []), reach(line) ?? "inactive"].join(" · ");
  return (
    <div data-story="" className="flex flex-col gap-5 border-t border-line bg-surface-2/40 px-4 py-4">
      <p>{sentenceOf(line)}</p>
      {sessions ? <Strip factory={factory} line={line} /> : null}
      {line.failing.length ? (
        <section className="flex flex-col gap-1.5">
          <h4 className="inline-flex items-center gap-1 text-sm font-medium">
            Failing, counted
            <About title="Failing, counted">
              <p>The counted sessions this scorer scored failing, newest first: the class it gave, the chapter it judged, and the first domain event it cites as <b>evidence</b> — each opening that place in the session.</p>
              <p>These are the sessions a self-improvement issue cites.</p>
            </About>
          </h4>
          <Card>
            <ul className="divide-y divide-line">
              {line.failing.map((each) => {
                const chapter = { ...SHOWN, opened: [each.chapter] };
                return (
                  <li key={each.session} className="px-3 py-2.5">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                      <Tag tone="bad">{each.class}</Tag>
                      <Link href={sessionHref(factory, each.session) + writeShown(chapter)}>session {each.session} · chapter {each.chapter}</Link>
                    </div>
                    {each.cite ? (
                      <div className="mt-1 flex min-w-0 items-baseline gap-1.5 font-mono text-[12px] text-muted">
                        <Link href={sessionHref(factory, each.session) + writeShown(each.cite.phaseId ? { ...chapter, phase: each.cite.phaseId } : chapter)}
                              className="shrink-0">seq {each.cite.seq}</Link>
                        <span className="min-w-0 truncate">{each.cite.detail}</span>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </Card>
        </section>
      ) : null}
      <p className="border-t border-line pt-3 text-xs text-muted">
        {scope}
        {" · fails on "}{line.classes.filter((each) => each.fail).map((each) => each.name).join(", ")}
        {" · passes on "}{line.classes.filter((each) => !each.fail).map((each) => each.name).join(", ")}
        {" "}
        <About title="What the scorer is">
          <p>Its <b>kind</b> — code or judge — its <b>workflow</b>, the agent it is <b>focused</b> on, and how much of the workflow it judges, as <code>asf/scorers/{line.name}/scorer.md</code> says and <code>asf check</code> resolved it.</p>
          <p>Each score is one of its <b>classes</b>: those it <b>fails on</b> are declared failing, those it <b>passes on</b> are not. A score is never a number.</p>
        </About>
      </p>
    </div>
  );
}

const shareOf = (share: number | null) => (share === null ? "—" : pct(share));

/** What a mark is: a session the scorer did not judge, one counted toward its threshold, or an older one it judged. */
const markOf = (mark: Mark) => (!mark.judged ? "not judged" : mark.counted ? "counted" : "older");

/**
 * The session strip — the one chart: the factory's last sessions, oldest
 * left, the same sessions for every scorer. A low mark is a session the
 * scorer did not judge; the counted ones stand tall under a bracket, older
 * ones short and faded. Failing is amber while below the threshold, red at it.
 * It carries the failing share over time and the progress toward the
 * threshold at once, which is why there is no other chart.
 */
function Strip({ factory, line }: { factory: string; line: ScorerView }) {
  const { strip, threshold } = line;
  const failing = BG[failingTone(line)];
  // The bracket spans the counted marks and no further — open on the left when the counted reach back past the strip.
  const first = strip.findIndex((mark) => mark.counted);
  const last = strip.findLastIndex((mark) => mark.counted);
  const further = line.counted.length > strip.filter((mark) => mark.counted).length;
  const at = (index: number) => `${(index / strip.length) * 100}%`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1">
          The factory&apos;s last {strip.length} sessions, oldest first{strip.some((mark) => !mark.judged) ? " · a low mark it did not judge" : ""}
          <About title="Reading the strip">
            <p>One mark per session of the factory, oldest on the left, the same sessions for every scorer — so one session sits at one place in every strip.</p>
            <p><b>Tall</b> marks under the bracket are the sessions counted toward the threshold; <b>short, faded</b> ones are older. A <b>low line</b> is a session this scorer did not judge: another workflow&apos;s, one not sampled, or one still running.</p>
            <p>A failing score is <b>amber</b> while the scorer is below its threshold and <b>red</b> once it is at it; grey is a passing one. A bracket open on the left: the counted sessions reach back past the strip. The <b>failing share</b> compares the sessions before the bracket with those counted. Each mark opens its session.</p>
          </About>
        </span>
        <span className="tabular-nums">failing share {shareOf(line.shares.before)} before · <b className="font-medium text-fg">{shareOf(line.shares.counted)}</b> counted</span>
      </div>
      <div className="flex h-8 items-end gap-[3px]">
        {strip.map((mark) => (
          <Link key={mark.session} href={sessionHref(factory, mark.session)} data-mark={markOf(mark)}
                title={`session ${mark.session} · ${!mark.judged ? "not judged" : `${mark.failing ? "failing" : "passing"}${mark.counted ? ", counted" : ""}`}`}
                className={cx("block flex-1 rounded-[2px]",
                              !mark.judged ? "h-1 bg-line" : mark.counted ? "h-full" : "h-1/2 opacity-60",
                              mark.judged && (mark.failing ? failing : "bg-line-strong hover:bg-muted"))} />
        ))}
      </div>
      <div className="relative h-9 text-[11px] text-muted">
        {first >= 0 ? (
          <span data-bracket="" className={cx("absolute top-0 h-1.5 border-b border-r border-muted", further ? "rounded-br-sm" : "rounded-b-sm border-l")}
                style={{ left: further ? 0 : at(first), right: at(strip.length - 1 - last) }} />
        ) : null}
        <span className="absolute top-2.5 left-0">{strip.length} sessions ago</span>
        <span className="absolute top-2.5 right-0 text-right">
          counted: the last {line.counted.length} it judged<br />
          {threshold.failures} failing of the last {threshold.ofLast} are the threshold for an issue
        </span>
      </div>
    </div>
  );
}
