import { Fragment, type ReactNode } from "react";
import type { DescribedWorkflow } from "@/convex/model/description";
import { budgetWords, type Check } from "./view";

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

/**
 * One workflow's About: purpose, trigger, its stages as a compact chain —
 * who plays each, where it may stop for a person — and the agents with what
 * they may touch. Everything comes from the factory's own self-description.
 */
export function WorkflowAbout({ workflow, onRun, run }: {
  workflow: DescribedWorkflow;
  onRun?: () => void;
  /** The run form, open in place under its heading, when Run was pressed here. */
  run?: ReactNode;
}) {
  return (
    <section className="workflow" id={`workflow-${workflow.name}`}>
      <div className="ch-head">
        <h2>{workflow.name}</h2>
        <span className="tag">{workflow.input}</span>
        <span className="grow" />
        {workflow.input === "prompt" && onRun ? (
          <button type="button" className="button small" aria-expanded={run !== undefined} onClick={onRun}>
            {run !== undefined ? "Close" : "Run"}
          </button>
        ) : null}
      </div>
      {run !== undefined ? <div className="run-here">{run}</div> : null}
      <p>{workflow.description}</p>
      <p className="muted small">Started by {triggerWords(workflow)}.</p>
      <ol className="chain" aria-label="stages">
        {workflow.stages.map((step, at) => (
          <Fragment key={`${step.stage}-${at}`}>
            {at > 0 ? <li className="arrow" aria-hidden="true">→</li> : null}
            <li className={`stage stage-${step.kind}`}>
              <strong>{step.stage}</strong>
              {step.agents.length ? <span className="small">{step.agents.join(", ")}</span> : <span className="small muted">code</span>}
              {step.gate ? <GateTag workflow={workflow} name={step.gate} /> : null}
            </li>
          </Fragment>
        ))}
      </ol>
      {workflow.agents.length ? (
        <table className="table small">
          <thead><tr><th>agent</th><th>model</th><th>tools</th><th>writes</th></tr></thead>
          <tbody>
            {workflow.agents.map((agent) => (
              <tr key={agent.name}>
                <td><strong>{agent.name}</strong>{agent.purpose ? <div className="muted">{agent.purpose}</div> : null}</td>
                <td>{agent.harness} · {agent.model}{agent.thinking ? ` · ${agent.thinking}` : ""}</td>
                <td>{agent.tools === null ? "every tool" : agent.tools.join(", ") || "none"}</td>
                <td>{agent.writes === null ? "anything not protected" : agent.writes.length ? agent.writes.join(", ") : "read-only"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {workflow.warnings.map((warning) => <p key={warning} className="notice small">{warning}</p>)}
    </section>
  );
}

function GateTag({ workflow, name }: { workflow: DescribedWorkflow; name: string }) {
  const gate = workflow.gates.find((each) => each.name === name);
  if (gate === undefined) return null;
  const words = gate.kind === "questions" ? `asks: ${gate.name}` : `gate: ${gate.name} · ${gate.on ? "on" : "off"}`;
  return <span className={`tag${gate.on ? " tag-wait" : ""}`}>{words}</span>;
}

/**
 * The Workflows tab: every workflow the factory's last check on its default
 * branch described, the configured per-session budget, and — for a factory
 * with no CI workflow — why there is nothing to show yet.
 */
export function WorkflowsTab({ check, onRun, running = null, runner }: {
  check: Check | null;
  onRun?: (workflow: string) => void;
  /** The workflow whose run form is open, if any. */
  running?: string | null;
  /** The run form for a workflow: the live one on the page, anything in a test. */
  runner?: (workflow: string) => ReactNode;
}) {
  if (check === null) {
    return (
      <div className="notice">
        <p><strong>Unchecked.</strong> This factory has not described itself to the cockpit yet, so there is no workflow to show.</p>
        <p className="small">
          The cockpit never reads workflow files: it shows what the factory&apos;s own <code>asf check --json</code> says. Stamp the
          optional CI workflow (<code>install.py --ci</code>) and set <code>vars.ASF_COCKPIT_URL</code> and{" "}
          <code>secrets.ASF_COCKPIT_TOKEN</code>; its next run on the default branch fills this in.
        </p>
      </div>
    );
  }
  const { description } = check;
  return (
    <>
      <p className="muted small">
        As described by <code>asf check --json</code> on <code>{check.ref || "?"}</code> at <code>{check.head.slice(0, 7)}</code>.
        Budget: {budgetWords(description.budget)}.
      </p>
      {description.problems.map((problem) => (
        <div key={problem.workflow} className="notice">
          <strong>{problem.workflow}</strong> does not load, so a run of it is refused:
          <pre className="small">{problem.error}</pre>
        </div>
      ))}
      {description.workflows.map((workflow) => (
        <WorkflowAbout key={workflow.name} workflow={workflow} onRun={onRun && (() => onRun(workflow.name))}
                       run={running === workflow.name && runner ? runner(workflow.name) : undefined} />
      ))}
    </>
  );
}
