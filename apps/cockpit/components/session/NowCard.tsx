import type { ReactNode } from "react";
import { EXPENSIVE } from "@/convex/model/attention";
import type { Budget } from "@/convex/model/description";
import { isLive, type Summary, until } from "@/convex/model/session";
import type { Story } from "@/convex/model/story";
import { formatDollars, formatDuration, inboxHref, prNumber, secondsBetween } from "../format";
import { buttonClass, Card, cx, followInPlace } from "../ui";
import { useWho } from "../viewer";
import type { OpenPhase } from "../graph/StageGraph";
import { waitsOn } from "./action";
import { channelWords, phaseName } from "./words";

const EDGE: Record<string, string> = {
  running: "border-l-accent", waiting: "border-l-wait", fail: "border-l-bad", success: "border-l-ok",
};

/**
 * Where the session is, in one sentence, with what it has spent against its
 * ceiling and how long it has been going (or took). When a gate waits on the
 * viewer it is where answering starts; when the session failed, it links the
 * latest failure's phase.
 */
export function NowCard({ factory, session, summary, story, budget, now, viewer, openPhase, className }: {
  factory: string; session: string; summary: Summary; story: Story; budget: Budget | null; now: number;
  viewer: string | null; openPhase: OpenPhase; className?: string;
}) {
  const who = useWho();
  const { now: here } = story;
  const { mine, on } = waitsOn(summary, viewer);
  let sentence: ReactNode;
  let next: ReactNode = null;
  if (summary.status === "running") {
    sentence = here.phase ? (
      <><b className="font-semibold">{who(here.phase.owner) || here.phase.name}</b> is working on{" "}
        <b className="font-semibold">{phaseName({ name: here.phase.name })}</b> in {here.chapter}</>
    ) : <>Running {here.chapter}</>;
  } else if (summary.status === "waiting" && !here.waiting) {
    sentence = <>Waiting</>;
  } else if (summary.status === "waiting" && here.waiting) {
    const whom = mine ? (viewer ? "you" : "a person") : on.map(who).join(", ") || "a person";
    sentence = (
      <>Waiting on {whom}: the <b className="font-semibold">{here.waiting.gate} {here.waiting.kind === "questions" ? "questions" : "gate"}</b>,
        round {here.waiting.round}, asked on {channelWords(here.waiting.channel, here.waiting.issueNumber)}</>
    );
    if (mine) next = <a className={cx(buttonClass("primary"), "mt-3")} href={inboxHref(factory, session)}>Answer in the inbox</a>;
  } else if (summary.status === "fail") {
    const failed = here.failed;
    const name = failed ? phaseName({ name: failed.name }) : "";
    sentence = failed ? <>Failed in <b className="font-semibold">{name}</b>{failed.error ? `: ${failed.error}` : ""}</> : <>Failed</>;
    if (failed) {
      const { href, onClick } = openPhase(failed.phaseId);
      next = (
        <a className="mt-1 inline-block text-sm" href={href} onClick={followInPlace(onClick)}>
          See {name}’s output →
        </a>
      );
    }
  } else if (summary.status === "success") {
    sentence = summary.prUrl ? <>All work landed in <a href={summary.prUrl}>pull request #{prNumber(summary.prUrl)}</a></> : <>Finished</>;
  } else {
    sentence = <>Nothing has started yet</>;
  }
  const live = isLive(summary);
  const took = secondsBetween(summary.startedAt, until(summary, now));
  return (
    <section data-now="" className={className}>
      <Card className={cx("flex flex-col gap-4 border-l-[3px] px-5 py-4 md:flex-row md:items-center", EDGE[summary.status] ?? "border-l-line-strong")}>
        <div className="min-w-0 grow">
          <div className="text-xs font-medium tracking-wider text-faint uppercase">Now</div>
          <p className="mt-0.5 text-lg">{sentence}</p>
          {next}
        </div>
        <div className="flex shrink-0 gap-6 text-right tabular-nums">
          <Spend spent={summary.totalCost} ceiling={budget?.maxCostUsd ?? 0} />
          {took === null ? null : (
            <div>
              <div className="text-lg font-semibold">{formatDuration(took)}</div>
              <div className="text-xs text-faint">{live ? "elapsed" : "took"}</div>
            </div>
          )}
        </div>
      </Card>
    </section>
  );
}

/**
 * What the session spent — list-price equivalent — against the per-session
 * ceiling its factory enforces, gauged: the accent, amber from 80%, red at the
 * ceiling. Without a ceiling there is nothing to gauge it against.
 */
function Spend({ spent, ceiling }: { spent: number; ceiling: number }) {
  const amount = formatDollars(spent);
  if (!ceiling) {
    return <div><div className="text-lg font-semibold">{amount}</div><div className="text-xs text-faint">spent</div></div>;
  }
  const share = spent / ceiling;
  const percent = Math.round(share * 100);
  const tone = share >= 1 ? "bg-bad" : share >= EXPENSIVE ? "bg-wait" : "bg-accent";
  return (
    <div className="w-28">
      <div className={cx("text-lg font-semibold", share >= 1 ? "text-bad" : share >= EXPENSIVE && "text-wait")}>{amount}</div>
      <div role="meter" aria-label="Spend against the session's ceiling" aria-valuemin={0} aria-valuemax={100}
           aria-valuenow={Math.min(percent, 100)} className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div className={cx("h-full rounded-full", tone)} style={{ width: `${Math.min(100, share * 100)}%` }} />
      </div>
      <div className="mt-1 text-xs text-faint">{percent}% of {formatDollars(ceiling)}</div>
    </div>
  );
}
