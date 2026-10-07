import type { FunctionReturnType } from "convex/server";
import { Fragment, type ReactNode } from "react";
import type { api } from "@/convex/_generated/api";
import type { Look } from "@/convex/factory";
import { FACTORY_FILE } from "@/convex/forge/forge";
import type { Budget, DescribedWorkflow, Settings } from "@/convex/model/description";
import type { Drift } from "@/convex/model/drift";
import type { Purged } from "@/convex/retention";
import { formatAgoAt, formatDuration, plural } from "../format";
import { ForgeRef, StageIcon } from "../icons";
import { Purge } from "../Purge";
import { Button, Card, Facts, LinkButton, Loading, Notice, Pre, StatusPill, Tag } from "../ui";
import { useWho } from "../viewer";
import { budgetWords, type Check, type FactoryTab, type Page, short } from "./view";

/** One line of a factory's purge audit (`retention.purges`). */
export type PurgeLine = NonNullable<FunctionReturnType<typeof api.retention.purges>>[number];

/**
 * The Config tab (#121): the factory's settings, grouped by what each decides
 * — its check, the forge and tracker, where work comes from, people at gates,
 * how work lands, and limits and data — as its own `asf check --json`
 * described them on the default branch, every default resolved by the
 * factory's code: the cockpit never parses factory.yaml. Above them, "Edit
 * config": the files under `asf/` there, each edited as text into a pull
 * request in the writer's name, and the proposals still open. Pure: the
 * page's query, the forge look, the drifts and the editor come in as props.
 */
export function ConfigTab({ page, look, drifts, forge, now, onEdit, editor, purges, onPurge, onTab }: {
  page: Page;
  look: Look | null;
  drifts: Map<string, Drift>;
  /** The forge's web origin, e.g. https://github.com. */
  forge: string;
  now: number;
  /** Open `path` in the editor. Without it the files are listed only. */
  onEdit?: (path: string) => void;
  /** The editor, when a file is open in it. */
  editor?: ReactNode;
  /** Every purge of the factory's bodies, newest first. */
  purges?: PurgeLine[] | null;
  /** Purge every session's bodies, for why: offered to an admin, and done for an owner of the account. */
  onPurge?: (reason: string) => Promise<Purged>;
  /** Open another of the factory's tabs: where drift and the workflows are shown whole. */
  onTab?: (tab: FactoryTab) => void;
}) {
  const { check } = page;
  const settings = check?.description.settings ?? null;
  const workflows = check?.description.workflows ?? [];
  return (
    <div className="grid gap-6">
      <Edit page={page} look={look} forge={forge} now={now} onEdit={onEdit} />
      {editor}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <CheckGroup check={check} now={now} onTab={onTab} />
        {settings === null ? <NotDescribed check={check} /> : (
          <>
            <ForgeGroup settings={settings} forge={forge} />
            <IntakeGroup settings={settings} />
            <GatesGroup settings={settings} workflows={workflows} />
            <LandingGroup settings={settings} />
          </>
        )}
        <LimitsGroup page={page} settings={settings} budget={check?.description.budget ?? null} drifts={drifts} now={now}
                     purges={purges} onPurge={onPurge} onTab={onTab} />
      </div>
    </div>
  );
}

/** One group of settings: what it decides, as its title, on a card. */
function Group({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <Card className="p-4 sm:p-5">
      <section>
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2>{title}</h2>
          {right ? <div className="ml-auto">{right}</div> : null}
        </div>
        {children}
      </section>
    </Card>
  );
}

/** Label and value rows, in order. */
function Rows({ rows, className }: { rows: [string, ReactNode][]; className?: string }) {
  return (
    <Facts className={className ?? "text-sm"}>
      {rows.map(([label, value]) => <Fragment key={label}><dt>{label}</dt><dd>{value}</dd></Fragment>)}
    </Facts>
  );
}

/** Names, as the viewer reads them — "you" for their own — or what an empty list means. */
function names(logins: string[], who: (login: string) => string, none: string): string {
  return logins.length ? logins.map(who).join(", ") : none;
}

/**
 * Edit config: where the config is and what changing it means, the files
 * under `asf/` linked to the forge — "Edit config" opens factory.yaml, and
 * each file has its own Edit — and the pull requests proposed here still open.
 */
function Edit({ page, look, forge, now, onEdit }: {
  page: Page;
  look: Look | null;
  forge: string;
  now: number;
  onEdit?: (path: string) => void;
}) {
  const who = useWho();
  const tip = look?.ok ? look.tip : null;
  const files = look?.ok ? look.files : null;
  const first = files?.includes(FACTORY_FILE) ? FACTORY_FILE : files?.[0];
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <p className="min-w-0 grow text-sm">
          The factory&apos;s config is <code>asf/</code> on the default branch
          {page.defaultBranch ? <>, <ForgeRef kind="branch" href={forge ? `${forge}/${page.repo}/tree/${page.defaultBranch}` : ""}>{page.defaultBranch}</ForgeRef></> : null}{tip ? <> at <code>{short(tip)}</code></> : null}.
          A change to it is a pull request, checked in the repository&apos;s CI.
        </p>
        {onEdit ? (
          <Button variant="primary" size="sm" className="self-start" disabled={page.edit !== null || first === undefined}
                  title={page.edit ?? undefined} onClick={() => first && onEdit(first)}>Edit config</Button>
        ) : null}
      </div>
      {onEdit && page.edit !== null ? <p className="mt-2 text-sm text-muted">Editing is disabled: {page.edit}.</p> : null}

      {look === null ? <div className="mt-3 text-sm"><Loading what="Asking the forge…" /></div>
        : !look.ok ? <Notice className="text-sm">{look.because}</Notice>
          : (
            <>
              <h3 className="mt-4 mb-1.5 text-sm font-medium text-muted">Open proposals</h3>
              {look.proposals.length === 0 ? <p className="text-sm text-muted">No config edit proposed here is open.</p> : (
                <ul className="grid gap-1 text-sm">
                  {look.proposals.map((proposal) => (
                    <li key={proposal.number}>
                      <ForgeRef kind="pr" href={proposal.url} newTab>#{proposal.number} {proposal.title}</ForgeRef>
                      <span className="text-muted"> · by {who(proposal.author)} {formatAgoAt(proposal.at, now)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <h3 className="mt-4 mb-1.5 text-sm font-medium text-muted">Files</h3>
              {files === null ? <p className="text-sm text-muted">The forge does not show this factory&apos;s files.</p> : (
                <ul className="overflow-hidden rounded-lg border border-line text-sm">
                  {files.map((path) => (
                    <li key={path} className="flex items-center gap-3 border-b border-line px-3.5 py-2 last:border-b-0">
                      <a href={`${forge}/${page.repo}/blob/${tip}/${path}`} className="min-w-0 grow break-all"><code>{path}</code></a>
                      {onEdit ? (
                        <Button size="sm" disabled={page.edit !== null} title={page.edit ?? undefined} onClick={() => onEdit(path)}>Edit</Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
    </Card>
  );
}

/** What the last `asf check` on the default branch said: per workflow, loads (✓), loads with warnings (!) or does not (✗). */
function CheckGroup({ check, now, onTab }: { check: Check | null; now: number; onTab?: (tab: FactoryTab) => void }) {
  if (check === null) {
    return (
      <Group title="Check" right={<StatusPill status="none">unchecked</StatusPill>}>
        <p className="text-sm">
          <strong>Unchecked</strong> — no CI workflow has pushed this factory&apos;s self-description, so nothing has said whether
          its workflows load. That is not a failure: the CI workflow is optional (<code>install.py --ci</code>).
        </p>
      </Group>
    );
  }
  const { description } = check;
  return (
    <Group title="Check" right={<StatusPill status={check.ok ? "passed" : "failed"}>{check.ok ? "passing" : "failing"}</StatusPill>}>
      <p className="text-sm text-muted">
        <code>asf check</code> on <code>{check.ref || "?"}</code> at <code>{short(check.head)}</code>, pushed by{" "}
        <code>{check.station}</code> {formatAgoAt(check.at, now)}
        {description.skillVersion ? <> · skill {description.skillVersion}</> : <> · stamped before 1.1</>}
      </p>
      {description.newer ? (
        <Notice className="text-sm">
          This description is format {description.format}, newer than this cockpit reads: upgrade the cockpit to see all of it.
        </Notice>
      ) : null}
      <ul className="mt-3 grid gap-1.5 text-sm">
        {description.problems.map((problem) => (
          <li key={problem.workflow}>
            <span className="font-medium text-bad" aria-label="does not load">✗</span> <strong className="font-medium">{problem.workflow}</strong>
            <Pre className="mt-1">{problem.error}</Pre>
          </li>
        ))}
        {description.workflows.map((workflow) => (
          <li key={workflow.name}>
            {workflow.warnings.length ? <span className="font-medium text-wait" aria-label="loads, with warnings">!</span>
              : <span className="text-ok" aria-label="loads">✓</span>} {workflow.name}
            {workflow.warnings.map((warning) => <div key={warning} className="pl-4 text-muted">{warning}</div>)}
          </li>
        ))}
      </ul>
      {onTab ? <LinkButton className="mt-3 text-sm" onClick={() => onTab("workflows")}>See the workflows →</LinkButton> : null}
    </Group>
  );
}

/** What stands in for the settings a self-description did not carry: before format 2, or none at all. */
function NotDescribed({ check }: { check: Check | null }) {
  return (
    <Group title="Settings">
      <p className="text-sm">
        <strong>Not described.</strong>{" "}
        {check === null ? <>The factory&apos;s settings arrive with its self-description, which no CI workflow has pushed yet.</>
          : <>This factory&apos;s self-description is format {check.description.format}, written before a factory described its
            settings. Its next check on a release that describes them fills them in.</>}
      </p>
      <p className="mt-2 text-sm text-muted">The cockpit never reads <code>{FACTORY_FILE}</code> itself: only what the factory says of it.</p>
    </Group>
  );
}

/** The forge the factory works on, the tracker its work comes through, and the labels it writes there. */
function ForgeGroup({ settings, forge }: { settings: Settings; forge: string }) {
  const { intake, forge: tracker } = settings;
  const project = (name: string) => (name ? <code>{name}</code> : "unresolved — not set, and no origin remote to read it from");
  return (
    <Group title="Forge and tracker">
      <Rows rows={[
        ["Forge", <>GitHub · <code>{new URL(forge).host}</code></>],
        ["Issues", intake.issues ? <>GitHub Issues of {project(tracker.project)}</> : "not watched"],
        ["Reviews", intake.reviews.watched
          ? <>pull requests of {project(tracker.reviewProject)}, answered by <strong className="font-medium">{intake.reviews.workflow}</strong></>
          : "not watched"],
        ["Labels it writes", (
          <span key="labels" className="flex flex-wrap gap-x-3 gap-y-1">
            {LABELS.map(([state, key]) => (tracker.labels[key] ? (
              <span key={key}><span className="text-muted">{state}</span> <code>{tracker.labels[key]}</code></span>
            ) : null))}
          </span>
        )],
      ]} />
    </Group>
  );
}

/** Each label the factory writes, by what it marks. */
const LABELS: [string, keyof Settings["forge"]["labels"]][] = [
  ["queued", "queued"], ["running", "running"], ["done", "done"], ["failed", "failed"],
  ["refined", "refined"], ["review failed", "prFailed"],
];

/** Which labels start which workflow, whose work is taken, how much at once — and reviews and prompts. */
function IntakeGroup({ settings }: { settings: Settings }) {
  const who = useWho();
  const { intake } = settings;
  const { reviews } = intake;
  const routes = Object.entries(intake.routes);
  return (
    <Group title="Where work comes from">
      <h3 className="mb-1.5 text-sm font-medium text-muted">Issues, by label{intake.issues ? "" : " — not watched"}</h3>
      {routes.length === 0 ? <p className="text-sm text-muted">No route: a labelled issue starts nothing.</p> : (
        <ul className="grid gap-1 text-sm">
          {routes.map(([label, workflow]) => (
            <li key={label} className="flex flex-wrap items-center gap-2">
              <Tag><code>{label}</code></Tag><span className="text-faint" aria-label="starts">→</span><span>{workflow}</span>
            </li>
          ))}
        </ul>
      )}
      <Rows className="mt-3 text-sm" rows={[
        ["Queued as", <code key="queued">{intake.queuedLabel}</code>],
        ["Trusted authors", names(intake.trustedAuthors, who, "anyone whose issue gets labelled")],
        ["At once", plural(intake.maxConcurrent, "issue run")],
        ["Reviews", reviews.watched ? reviewWords(settings) : "not watched"],
        ...(reviews.watched ? [
          ["Trusted reviewers", names(reviews.trustedReviewers, who, "anyone who can review")],
          ["Never work", reviews.ignoreAuthors.length ? `review comments by ${reviews.ignoreAuthors.join(", ")}` : "every review comment can be"],
        ] as [string, ReactNode][] : []),
        ["Prompts", intake.promptWorkflows.join(", ") || "no workflow takes a prompt"],
      ]} />
    </Group>
  );
}

/** What the review watcher does with a review: replies, resolves, how much at once, and what ends it. */
function reviewWords({ intake: { reviews } }: Settings): string {
  const replies = reviews.replyToThreads ? "replies in the thread" : "no replies in the thread";
  const resolves = reviews.resolveThreads ? ", resolves what it addressed" : "";
  const reaped = reviews.reapMerged ? "; a merged or closed one ends its session" : "";
  return `${replies}${resolves}; up to ${plural(reviews.maxThreads, "thread")} a run, ${reviews.maxConcurrent} at once${reaped}`;
}

/**
 * Which gates ask a person, as factory.yaml switches them — and where a
 * workflow switches its own the other way — what every other gate does, and
 * how a person is asked.
 */
function GatesGroup({ settings, workflows }: { settings: Settings; workflows: DescribedWorkflow[] }) {
  const { hitl } = settings;
  const asks = (on: boolean) => (on ? "asks a person" : "passes by policy");
  return (
    <Group title="People at gates">
      <ul className="grid gap-1 text-sm">
        {Object.entries(hitl.gates).map(([gate, on]) => {
          const otherwise = workflows.filter((workflow) => workflow.gates.some((each) => each.name === gate && each.kind === "gate" && each.on !== on));
          return (
            <li key={gate} className="flex flex-wrap items-center gap-x-2">
              <StageIcon name={gate} className="text-muted" />
              <strong className="font-medium">{gate}</strong>
              <span className={on ? "text-wait" : "text-muted"}>{asks(on)}</span>
              {otherwise.length ? <span className="text-muted">— {on ? "off" : "on"} in {otherwise.map((workflow) => workflow.name).join(", ")}</span> : null}
            </li>
          );
        })}
        <li className="text-muted">Every other gate {asks(hitl.default)}.</li>
      </ul>
      <Rows className="mt-3 text-sm" rows={[
        ["Attended", hitl.waitSeconds ? `asks in place for ${formatDuration(hitl.waitSeconds)}, then suspends` : "suspends at once"],
        ["Unattended", hitl.whenUnattended === "auto" ? "passes on its own" : "suspends, and asks on the work item"],
        ["Rounds", hitl.maxRounds ? `at most ${hitl.maxRounds}` : "until the person approves or aborts"],
        ["Notifies", hitl.notifyCommand.length ? <code key="notify">{hitl.notifyCommand.join(" ")}</code>
          : "runs no command"],
      ]} />
    </Group>
  );
}

/** How a run's work gets back: as what, on which branch, from where, and in which worktree. */
function LandingGroup({ settings }: { settings: Settings }) {
  const { landing } = settings;
  const as = (mode: string) => (mode === "merge" ? "a merge into the base branch"
    : landing.openPr ? "a pull request, opened by the factory" : "a pushed branch; a person opens the pull request");
  return (
    <Group title="How work lands">
      <Rows rows={[
        ["Prompt runs", as(landing.mode)],
        ["Issue runs", as(landing.issueMode)],
        ["Review runs", "on the pull request under review"],
        ["Branches", <><code key="branch">{landing.branchPrefix}&lt;session&gt;</code> on <code>{landing.remote}</code></>],
        ["Based on", landing.baseRef ? <code key="base">{landing.baseRef}</code> : "the branch each station's checkout has out"],
        ["Published", landing.publish === "on_create"
          ? "from the session's first moment, so a gate's subject can be read here"
          : "when it is integrated — until then, a gate's subject is on the station only"],
        ["Worktrees", landing.worktrees
          ? <><code key="dir">{landing.worktreeDir}/</code>, {landing.keepOnSuccess ? "kept after success" : "removed after a clean success, kept otherwise for resume"}</>
          : "none — a session runs in the station's checkout itself"],
      ]} />
    </Group>
  );
}

/**
 * What a session may spend, what of it leaves the machine and how long the
 * cockpit keeps it, what the cockpit may ask a station to do — and, measured
 * here, which stations run another config, and every purge of the bodies.
 */
function LimitsGroup({ page, settings, budget, drifts, now, purges, onPurge, onTab }: {
  page: Page;
  settings: Settings | null;
  budget: Budget | null;
  drifts: Map<string, Drift>;
  now: number;
  purges?: PurgeLine[] | null;
  onPurge?: (reason: string) => Promise<Purged>;
  onTab?: (tab: FactoryTab) => void;
}) {
  const who = useWho();
  const drifted = [...drifts.values()].filter((each) => each.drifted).length;
  const limits = settings?.limits;
  const drift = drifted ? `${plural(drifted, "station")} on another config`
    : page.stations.length ? `every station runs ${page.defaultBranch ?? "the default branch"}'s config` : "no station has reported yet";
  return (
    <Group title="Limits and data">
      <Rows rows={[
        ...(budget ? [["Budget", budgetWords(budget)] as [string, ReactNode]] : []),
        ...(limits ? [
          ["Transcripts", !limits.transcripts ? "off — no prompt or tool argument leaves the machine"
            : limits.transcriptRetentionDays ? `kept, and aged out ${plural(limits.transcriptRetentionDays, "day")} after a session finishes`
              : "kept as long as this cockpit allows"],
          ["The cockpit may send", limits.commands.join(", ") || "nothing"],
        ] as [string, ReactNode][] : []),
        ["Drift", drifted && onTab ? (
          <LinkButton key="drift" className="text-left font-medium text-wait" onClick={() => onTab("stations")}>{drift} → Stations</LinkButton>
        ) : drift],
        ["Purged", purges?.length ? (
          <ul key="purged" className="grid gap-1">
            {purges.map((line) => (
              <li key={`${line.at}-${line.session}`}>
                {line.session ? <>session <code>{line.session}</code></> : "every session"}, by{" "}
                {line.via === "deployment" ? "the deployment's CLI" : who(line.by)} {formatAgoAt(line.at, now)}: {line.reason}
              </li>
            ))}
          </ul>
        ) : "nothing"],
      ]} />
      <p className="mt-3 text-sm text-muted">
        A session&apos;s events are kept for good. A transcript ages out once its session has been finished as long as the cockpit
        allows — <code>cockpit.transcript_retention_days</code> can only shorten that — and the bodies of every session can be purged.
      </p>
      {page.role === "admin" && onPurge ? (
        <Purge label="Purge every session's bodies" onPurge={onPurge}
               explains={`Removes every artifact's content, every command's output and every transcript of ${page.repo} from this cockpit, for every session. It takes an owner of ${page.repo.split("/")[0]}; the events, the cost and the audit line stay.`} />
      ) : null}
    </Group>
  );
}
