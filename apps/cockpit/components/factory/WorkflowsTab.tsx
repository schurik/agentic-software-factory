import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRight, Play } from "lucide-react";
import Link from "next/link";
import type { DescribedGate, DescribedWorkflow } from "@/convex/model/description";
import type { GateFigures, WorkflowLine } from "@/convex/model/overview";
import { recordOf, type StageFigures, type StageRecord } from "@/convex/model/workflows";
import { formatCost, formatDuration, plural } from "../format";
import { WorkflowGraph } from "../graph/StageGraph";
import { StatusIcon } from "../icons";
import { Button, Card, cx, Notice, Pre, Table, Tag } from "../ui";
import { budgetWords, type Check, type StationRow, watchedBy } from "./view";

/** How a run of the workflow starts, in the words a person would use. */
export function triggerWords(workflow: DescribedWorkflow): string {
  if (workflow.input === "issue") {
    if (!workflow.trigger.labels.length) return "an issue, by number: `asf run` only — no route label names it";
    const labels = workflow.trigger.labels.map((label) => `\`${label}\``).join(" or ");
    return `an issue labelled \`asf:queued\` + ${labels}${workflow.trigger.watched ? "" : " — the issues watcher is off"}`;
  }
  if (workflow.input === "pr") {
    return workflow.trigger.watched ? "review threads on one of the factory's pull requests, by the review watcher"
      : "a pull request, by number: `asf run` only — the review watcher launches another workflow";
  }
  return "a prompt: `asf run`, or Run a prompt here";
}

const START: Record<string, string> = { issue: "an issue", pr: "a pull request", prompt: "a prompt" };

/** What the Workflows tab says of the last 30 days: each workflow's line, and its stages' figures. */
export interface WorkflowsRecord {
  /** More happened than the cockpit sums at once, and nothing was. */
  cut: boolean;
  workflows: WorkflowLine[];
  stages: StageFigures[];
}

/**
 * One workflow (#120): what it takes and how it starts — its trigger labels,
 * and how many stations online watch for it, in amber when none do — what it
 * does, its last 30 days with a link to the factory's sessions, `asf check`'s
 * warnings, and its shape as the session page's stage graph, each stage
 * annotated with its agents, its record and its gate; then its agents, folded.
 * The description is the factory's own; the record comes from the per-phase
 * rows (`record`, undefined while it loads).
 */
export function WorkflowCard({ workflow, factory, stations, now, record, onRun }: {
  workflow: DescribedWorkflow;
  factory: string;
  stations: StationRow[];
  now: number;
  record?: WorkflowsRecord;
  /** Open the header's Run a prompt dialog on this workflow. */
  onRun?: () => void;
}) {
  const watching = watchedBy(workflow, stations, now);
  const line = record?.workflows.find((each) => each.workflow === workflow.name);
  const figures = recordOf(workflow.name, workflow.stages.map((step) => step.stage), record?.stages ?? []);
  return (
    <Card className="p-4 sm:p-5" id={`workflow-${workflow.name}`}>
      <section aria-label={workflow.name}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2>{workflow.name}</h2>
          <Tag>{workflow.input}</Tag>
          {workflow.trigger.labels.map((label) => (
            <code key={label} className="rounded-md border border-line px-1.5 py-0.5 text-xs text-muted">{label}</code>
          ))}
          {watching === null ? null : watching ? (
            <span className="text-xs text-muted">watched by {plural(watching, "online station")}</span>
          ) : <span className="text-xs font-medium text-wait">no online station watches for it</span>}
          <span className="grow" />
          {workflow.input === "prompt" && onRun ? (
            <Button size="sm" variant="primary" aria-haspopup="dialog" aria-label={`Run ${workflow.name}`} onClick={onRun}>
              <Play size={12} fill="currentColor" aria-hidden="true" />Run
            </Button>
          ) : null}
        </div>
        <p className="mt-2">{workflow.description}</p>
        <p className="mt-1 text-sm text-muted">Started by {triggerWords(workflow)}.</p>
        {record === undefined ? null : (
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="text-muted">Last 30 days</span>
            {line ? (
              <span className="tabular-nums">
                {plural(line.sessions, "session")} · {line.done} done
                {line.failed ? <span className="text-bad"> · {line.failed} failed</span> : null}
                {" "}· median {line.finish === null ? "—" : formatDuration(line.finish)} · {formatCost(line.cost)}
              </span>
            ) : <span className="text-muted">{record.cut ? "more ran than the cockpit counts at once" : "no runs"}</span>}
            <Link href={`/sessions?factory=${encodeURIComponent(factory)}`} className="no-underline hover:underline">Sessions →</Link>
          </p>
        )}
        {workflow.warnings.map((warning) => (
          <Notice key={warning} className="mt-3 text-sm"><strong className="font-medium">asf check warns:</strong> {warning}</Notice>
        ))}
        <div className="mt-4">
          <WorkflowGraph start={START[workflow.input] ?? workflow.input} stages={workflow.stages.map((step, index) => ({
            name: step.stage,
            children: (
              <>
                <span className="text-xs whitespace-nowrap text-muted">{step.agents.length ? step.agents.join(", ") : "code"}</span>
                {figures[index] ? <Figures stage={figures[index]} /> : null}
                {step.gate ? <Gate gate={workflow.gates.find((each) => each.name === step.gate)} name={step.gate} answered={figures[index]?.gate} /> : null}
              </>
            ),
          }))} />
        </div>
        <Agents workflow={workflow} />
      </section>
    </Card>
  );
}

/** A stage's last 30 days on its card: the median time and cost of a chapter's go at it, and — in colour, with words — the slowest and its failures. */
function Figures({ stage }: { stage: StageRecord }) {
  return (
    <span className="flex flex-col gap-0.5 border-t border-line pt-1 text-[11px] whitespace-nowrap text-muted tabular-nums">
      {stage.time === null ? null : (
        <span>{formatDuration(stage.time)}{stage.cost ? ` · ${formatCost(stage.cost)}` : ""} <span className="text-faint">median</span></span>
      )}
      {stage.slowest ? <span className="font-medium text-wait">slowest stage</span> : null}
      {stage.failures ? (
        <span className="flex items-center gap-1 font-medium text-bad"><StatusIcon status="failed" size={11} />{plural(stage.failures, "failure")}</span>
      ) : null}
    </span>
  );
}

/** The gate a stage places: whether it asks a person, and — when one was asked — how often they rejected and how long they took. */
function Gate({ gate, name, answered }: { gate?: DescribedGate; name: string; answered?: GateFigures }) {
  const asks = gate?.on ?? false;
  return (
    <>
      <span className={cx("w-fit rounded px-1.5 py-px text-[11px] font-medium whitespace-nowrap", asks ? "bg-wait-soft text-wait" : "bg-surface-2 text-muted")}>
        {name} {gate?.kind === "questions" ? "questions" : "gate"} · {asks ? "asks a person" : "passes by policy"}
      </span>
      {answered?.rounds ? (
        <span className="text-[11px] whitespace-nowrap text-muted tabular-nums">
          {answered.rejected} of {plural(answered.rounds, "round")} rejected · wait {formatDuration(answered.wait)}
        </span>
      ) : null}
    </>
  );
}

/** The workflow's agents, folded: where each runs and how hard it thinks, its tools, and what it may write. */
function Agents({ workflow }: { workflow: DescribedWorkflow }) {
  if (!workflow.agents.length) return null;
  return (
    <Collapsible.Root className="mt-2 border-t border-line pt-3">
      <Collapsible.Trigger className="group flex items-center gap-1.5 text-left text-sm text-muted hover:text-fg">
        <ChevronRight size={14} aria-hidden="true" className="transition-transform duration-200 group-data-panel-open:rotate-90" />
        {plural(workflow.agents.length, "agent")}: {workflow.agents.map((agent) => agent.name).join(", ")}
      </Collapsible.Trigger>
      <Collapsible.Panel keepMounted className="overflow-hidden">
        <Table className="mt-3 text-sm">
          <thead><tr><th>agent</th><th>runs on</th><th>tools</th><th>may write — the boundary</th></tr></thead>
          <tbody>
            {workflow.agents.map((agent) => (
              <tr key={agent.name} className="align-top">
                <td><strong className="font-medium">{agent.name}</strong>{agent.purpose ? <div className="text-xs text-muted">{agent.purpose}</div> : null}</td>
                <td className="whitespace-nowrap">{agent.harness}<div className="text-xs text-muted">{agent.model}{agent.thinking ? ` · thinking ${agent.thinking}` : ""}</div></td>
                <td>{agent.tools === null ? "every tool" : agent.tools.join(", ") || "none"}</td>
                <td>{agent.writes === null ? "anything not protected" : agent.writes.length ? agent.writes.join(", ") : "nothing — read-only"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="mt-2 text-xs text-muted">The factory diffs the repository after every agent call and rolls back any change outside what it may write.</p>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/**
 * The Workflows tab (#120): the workflows `asf check` refused first, each
 * with its error, then every workflow the factory's last check on its default
 * branch described, as a card each; and — for a factory with no CI workflow —
 * why there is nothing to show yet. Pure: the record of the last 30 days and
 * the page's clock come in.
 */
export function WorkflowsTab({ check, factory, stations, now, record, onRun }: {
  check: Check | null;
  factory: string;
  stations: StationRow[];
  now: number;
  record?: WorkflowsRecord;
  /** Open the header's Run a prompt dialog on a prompt workflow. */
  onRun?: (workflow: string) => void;
}) {
  if (check === null) {
    return (
      <Notice tone="none">
        <p><strong>Unchecked.</strong> This factory has not described itself to the cockpit yet, so there is no workflow to show.</p>
        <p className="mt-1 text-sm">
          The cockpit never reads workflow files: it shows what the factory&apos;s own <code>asf check --json</code> says. Stamp the
          optional CI workflow (<code>install.py --ci</code>) and set <code>vars.ASF_COCKPIT_URL</code> and{" "}
          <code>secrets.ASF_COCKPIT_TOKEN</code>; its next run on the default branch fills this in.
        </p>
      </Notice>
    );
  }
  const { description } = check;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        As described by <code>asf check --json</code> on <code>{check.ref || "?"}</code> at <code>{check.head.slice(0, 7)}</code>.
        Budget: {budgetWords(description.budget)}. Figures on a stage are the last 30 days&apos;: times, costs and waits
        are medians.
      </p>
      {description.problems.map((problem) => (
        <Card key={problem.workflow} className="border-l-[3px] border-l-bad p-4 sm:p-5">
          <section aria-label={problem.workflow}>
            <div className="flex flex-wrap items-center gap-2">
              <StatusIcon status="failed" />
              <h2>{problem.workflow}</h2>
              <span className="text-sm text-muted">does not load, so a run of it is refused</span>
            </div>
            <Pre className="mt-3">{problem.error}</Pre>
          </section>
        </Card>
      ))}
      {description.workflows.map((workflow) => (
        <WorkflowCard key={workflow.name} workflow={workflow} factory={factory} stations={stations} now={now} record={record}
                      onRun={onRun && (() => onRun(workflow.name))} />
      ))}
    </div>
  );
}
