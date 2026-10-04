import type { FunctionReturnType } from "convex/server";
import type { ReactNode } from "react";
import type { api } from "@/convex/_generated/api";
import type { Look } from "@/convex/factory";
import type { Drift } from "@/convex/model/drift";
import type { Purged } from "@/convex/retention";
import { formatAgo, formatTime } from "../format";
import { Purge } from "../Purge";
import { Button, Loading, Notice, Pre, Section, StatusPill, Table, Tag } from "../ui";
import { useWho } from "../viewer";
import { type Page, short } from "./view";

/** One line of a factory's purge audit (`retention.purges`). */
export type PurgeLine = NonNullable<FunctionReturnType<typeof api.retention.purges>>[number];

/**
 * The Config tab: the factory's config as the default branch holds it (the
 * files under `asf/`, linked to the forge, each with an Edit that a writer
 * may press and anyone else sees disabled with the reason), the editor when
 * one is open, what the last `asf check --json` there said, and each
 * station's drift from it. Pure: the page's query, the forge look, the drifts
 * and the editor come in as props.
 */
export function ConfigTab({ page, look, drifts, forge, now, onEdit, editor, purges, onPurge }: {
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
}) {
  const who = useWho();
  const { check } = page;
  const tip = look?.ok ? look.tip : null;
  return (
    <>
      <Section title="Files">
        <p className="mb-3 text-sm text-muted">
          The default branch is the factory&apos;s config{page.defaultBranch ? <> — <code>{page.defaultBranch}</code></> : null}
          {tip ? <> at <code>{short(tip)}</code></> : null}. A change to it is a pull request, checked in the repository&apos;s CI.
        </p>
        {look === null ? <Loading what="Asking the forge…" />
          : !look.ok ? <Notice className="text-sm">{look.because}</Notice>
            : look.files === null ? <p className="text-muted">The forge does not show this factory&apos;s files.</p>
              : (
                <>
                  <ul className="overflow-hidden rounded-xl border border-line bg-surface text-sm shadow-card">
                    {look.files.map((path) => (
                      <li key={path} className="flex items-center gap-3 border-b border-line px-3.5 py-2 last:border-b-0">
                        <a href={`${forge}/${page.repo}/blob/${tip}/${path}`} className="min-w-0 grow"><code>{path}</code></a>
                        {onEdit ? (
                          <Button size="sm" disabled={page.edit !== null} title={page.edit ?? undefined} onClick={() => onEdit(path)}>Edit</Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {onEdit && page.edit !== null ? <p className="mt-2 text-sm text-muted">Editing is disabled: {page.edit}.</p> : null}
                </>
              )}
      </Section>

      {editor}

      <Section title="asf check">
        {check === null ? (
          <Notice tone="none" className="text-sm">
            <strong>Unchecked</strong> — no CI workflow has pushed this factory&apos;s self-description, so nothing has said whether
            its workflows load. That is not a failure: the CI workflow is optional (<code>install.py --ci</code>).
          </Notice>
        ) : (
          <>
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
              <StatusPill status={check.ok ? "passed" : "failed"}>{check.ok ? "passing" : "failing"}</StatusPill>
              <span>
                on <code>{check.ref || "?"}</code> at <code>{short(check.head)}</code>, pushed by <code>{check.station}</code>{" "}
                {formatAgo(new Date(check.at).toISOString(), now)}
                {check.description.skillVersion ? <> · skill {check.description.skillVersion}</> : <> · stamped before 1.1</>}
              </span>
            </p>
            {check.description.newer ? (
              <Notice className="text-sm">
                This description is format {check.description.format}, newer than this cockpit reads: upgrade the cockpit to see all of it.
              </Notice>
            ) : null}
            <ul className="mt-3 grid gap-1.5 text-sm">
              {check.description.workflows.map((workflow) => (
                <li key={workflow.name}>
                  <span className="text-ok" aria-label="loads">✓</span> {workflow.name}: {workflow.stages.map((step) => step.stage).join(" → ")}
                  {workflow.warnings.map((warning) => <div key={warning} className="pl-4 text-muted">~ {warning}</div>)}
                </li>
              ))}
              {check.description.problems.map((problem) => (
                <li key={problem.workflow}>
                  <span className="text-bad" aria-label="does not load">✗</span> {problem.workflow}
                  <Pre className="mt-1">{problem.error}</Pre>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section title="Stations">
        {page.stations.length === 0 ? <p className="text-sm text-muted">No station has reported where its checkout stands yet.</p> : (
          <Table className="text-sm">
            <thead><tr><th>station</th><th>owner</th><th>last seen</th><th>commit</th><th>drift</th></tr></thead>
            <tbody>
              {page.stations.map((row) => {
                const drifted = drifts.get(row.station) ?? { badges: [], drifted: false };
                return (
                  <tr key={row.station}>
                    <td><code>{row.name}</code></td>
                    <td>{who(row.owner) || "—"}</td>
                    <td className="whitespace-nowrap">{row.seenAt ? formatAgo(new Date(row.seenAt).toISOString(), now) : "never polled"}</td>
                    <td>{row.head ? <code>{short(row.head)}</code> : "—"}</td>
                    <td>
                      {drifted.badges.length === 0 ? <span className="text-ok">current</span>
                        : <span className="flex flex-wrap gap-1">{drifted.badges.map((badge) => (
                          <Tag key={badge} tone={drifted.drifted ? "wait" : "none"}>{badge}</Tag>
                        ))}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Section>

      <Section title="Retention">
        <p className="mb-3 text-sm text-muted">
          A session&apos;s events are kept for good. A transcript ages out once its session has been finished as long as the
          cockpit allows — <code>cockpit.transcript_retention_days</code> in <code>asf/factory.yaml</code> can only shorten
          that — and the bodies of every session can be purged, with a line below saying who did it, when and why.
        </p>
        {purges && purges.length ? (
          <Table className="text-sm">
            <thead><tr><th>when</th><th>what</th><th>by</th><th>why</th></tr></thead>
            <tbody>
              {purges.map((line) => (
                <tr key={`${line.at}-${line.session}`}>
                  <td className="whitespace-nowrap">{formatTime(new Date(line.at).toISOString(), now)}</td>
                  <td>{line.session ? <>session <code>{line.session}</code></> : "every session"}</td>
                  <td>{line.via === "deployment" ? "the deployment's CLI" : who(line.by)}</td>
                  <td>{line.reason}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : <p className="text-sm text-muted">Nothing has been purged.</p>}
        {page.role === "admin" && onPurge ? (
          <Purge label="Purge every session's bodies" onPurge={onPurge}
                 explains={`Removes every artifact's content, every command's output and every transcript of ${page.repo} from this cockpit, for every session. It takes an owner of ${page.repo.split("/")[0]}; the events, the cost and the audit line stay.`} />
        ) : null}
      </Section>
    </>
  );
}
