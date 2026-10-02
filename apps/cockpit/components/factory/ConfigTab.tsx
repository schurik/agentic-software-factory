import type { FunctionReturnType } from "convex/server";
import type { ReactNode } from "react";
import type { api } from "@/convex/_generated/api";
import type { Look } from "@/convex/factory";
import type { Drift } from "@/convex/model/drift";
import type { Purged } from "@/convex/retention";
import { formatAgo, formatTime } from "../format";
import { Purge } from "../Purge";
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
  const { check } = page;
  const tip = look?.ok ? look.tip : null;
  return (
    <>
      <section>
        <h2>Files</h2>
        <p className="muted small">
          The default branch is the factory&apos;s config{page.defaultBranch ? <> — <code>{page.defaultBranch}</code></> : null}
          {tip ? <> at <code>{short(tip)}</code></> : null}. A change to it is a pull request, checked in the repository&apos;s CI.
        </p>
        {look === null ? <p className="muted">Asking the forge…</p>
          : !look.ok ? <p className="notice small">{look.because}</p>
            : look.files === null ? <p className="muted">The forge does not show this factory&apos;s files.</p>
              : (
                <>
                  <ul className="files small">
                    {look.files.map((path) => (
                      <li key={path}>
                        <a href={`${forge}/${page.repo}/blob/${tip}/${path}`}><code>{path}</code></a>
                        {onEdit ? (
                          <> <button type="button" className="button quiet" disabled={page.edit !== null}
                                     title={page.edit ?? undefined} onClick={() => onEdit(path)}>Edit</button></>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {onEdit && page.edit !== null ? <p className="muted small">Editing is disabled: {page.edit}.</p> : null}
                </>
              )}
      </section>

      {editor}

      <section>
        <h2>asf check</h2>
        {check === null ? (
          <p className="notice small">
            <strong>Unchecked</strong> — no CI workflow has pushed this factory&apos;s self-description, so nothing has said whether
            its workflows load. That is not a failure: the CI workflow is optional (<code>install.py --ci</code>).
          </p>
        ) : (
          <>
            <p className="small">
              <span className={`status status-${check.ok ? "success" : "fail"}`}>{check.ok ? "passing" : "failing"}</span>{" "}
              on <code>{check.ref || "?"}</code> at <code>{short(check.head)}</code>, pushed by <code>{check.station}</code>{" "}
              {formatAgo(new Date(check.at).toISOString(), now)}
              {check.description.skillVersion ? <> · skill {check.description.skillVersion}</> : <> · stamped before 1.1</>}
            </p>
            {check.description.newer ? (
              <p className="notice small">
                This description is format {check.description.format}, newer than this cockpit reads: upgrade the cockpit to see all of it.
              </p>
            ) : null}
            <ul className="checked small">
              {check.description.workflows.map((workflow) => (
                <li key={workflow.name}>
                  <span className="status-success">✓</span> {workflow.name}: {workflow.stages.map((step) => step.stage).join(" → ")}
                  {workflow.warnings.map((warning) => <div key={warning} className="muted">~ {warning}</div>)}
                </li>
              ))}
              {check.description.problems.map((problem) => (
                <li key={problem.workflow}>
                  <span className="status-fail">✗</span> {problem.workflow}
                  <pre>{problem.error}</pre>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section>
        <h2>Stations</h2>
        {page.stations.length === 0 ? <p className="muted small">No station has reported where its checkout stands yet.</p> : (
          <table className="table small">
            <thead><tr><th>station</th><th>owner</th><th>last seen</th><th>commit</th><th>drift</th></tr></thead>
            <tbody>
              {page.stations.map((row) => {
                const drifted = drifts.get(row.station) ?? { badges: [], drifted: false };
                return (
                  <tr key={row.station}>
                    <td><code>{row.name}</code></td>
                    <td>{row.owner || "—"}</td>
                    <td>{row.seenAt ? formatAgo(new Date(row.seenAt).toISOString(), now) : "never polled"}</td>
                    <td>{row.head ? <code>{short(row.head)}</code> : "—"}</td>
                    <td>
                      {drifted.badges.length === 0 ? <span className="status-success">current</span>
                        : drifted.badges.map((badge) => (
                          <span key={badge} className={`tag${drifted.drifted ? " tag-wait" : ""}`}>{badge}</span>
                        ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Retention</h2>
        <p className="muted small">
          A session&apos;s events are kept for good. A transcript ages out once its session has been finished as long as the
          cockpit allows — <code>cockpit.transcript_retention_days</code> in <code>asf/factory.yaml</code> can only shorten
          that — and the bodies of every session can be purged, with a line below saying who did it, when and why.
        </p>
        {purges && purges.length ? (
          <table className="table small">
            <thead><tr><th>when</th><th>what</th><th>by</th><th>why</th></tr></thead>
            <tbody>
              {purges.map((line) => (
                <tr key={`${line.at}-${line.session}`}>
                  <td>{formatTime(new Date(line.at).toISOString())}</td>
                  <td>{line.session ? <>session <code>{line.session}</code></> : "every session"}</td>
                  <td>{line.via === "deployment" ? "the deployment's CLI" : line.by}</td>
                  <td>{line.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted small">Nothing has been purged.</p>}
        {page.role === "admin" && onPurge ? (
          <Purge label="Purge every session's bodies" onPurge={onPurge}
                 explains={`Removes every artifact's content, every command's output and every transcript of ${page.repo} from this cockpit, for every session. It takes an owner of ${page.repo.split("/")[0]}; the events, the cost and the audit line stay.`} />
        ) : null}
      </section>
    </>
  );
}
