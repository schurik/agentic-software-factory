import {
  BookOpen, CircleDot, Code, ExternalLink, Eye, FlaskConical, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest,
  ListChecks, type LucideIcon, Shapes, Telescope,
} from "lucide-react";
import type { ReactNode } from "react";
import type { Mark, StageStatus } from "@/convex/model/graph";
import { cx } from "./ui";

/**
 * The marks the session page draws with (#104): one icon per stage of the
 * closed vocabulary, one glyph per status, one per kind of phase, and the
 * forge's own things — issue, pull request, branch — as links.
 *
 * Status shows three ways, and this is the third: a pill in a header
 * (ui.tsx's StatusPill), a dot in a table cell, and this icon where it leads
 * a line — a row, a stage card, a phase in the graph.
 */

const STAGES: Record<string, LucideIcon> = {
  scout: Telescope, plan: ListChecks, commit: GitCommitHorizontal, implement: Code,
  verify: FlaskConical, review: Eye, document: BookOpen, integrate: GitMerge,
};

/** A stage's icon; a stage the vocabulary gained since this cockpit was built gets a generic one. */
export function StageIcon({ name, size = 14, className }: { name: string; size?: number; className?: string }) {
  const Icon = STAGES[name] ?? Shapes;
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" className={cx("shrink-0", className)} />;
}

const TONES: Record<Mark | StageStatus, string> = {
  done: "text-ok", running: "text-accent", waiting: "text-wait", failed: "text-bad", rejected: "text-bad", pending: "text-faint",
};

/** How a phase or a stage went, as the glyph that leads its line; its word is its label. */
export function StatusIcon({ status, size = 14, className }: { status: Mark | StageStatus; size?: number; className?: string }) {
  const props = { width: size, height: size, viewBox: "0 0 16 16", role: "img", "aria-label": status,
                  className: cx("shrink-0", TONES[status], className) };
  switch (status) {
    case "done":
      return <svg {...props}><circle cx="8" cy="8" r="7" fill="currentColor" opacity=".14" /><path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
    case "running":
      return <svg {...props}><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity=".22" strokeWidth="2" /><path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="spin" style={{ transformOrigin: "8px 8px" }} /></svg>;
    case "waiting":
      return <svg {...props}><circle cx="8" cy="8" r="7" fill="currentColor" opacity=".16" /><rect x="5.5" y="5" width="1.8" height="6" rx=".6" fill="currentColor" /><rect x="8.7" y="5" width="1.8" height="6" rx=".6" fill="currentColor" /></svg>;
    case "failed":
    case "rejected":
      return <svg {...props}><circle cx="8" cy="8" r="7" fill="currentColor" opacity=".14" /><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>;
    default:
      return <svg {...props}><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2.2 2.2" /></svg>;
  }
}

/** Whether a phase was a person at a gate, code, or an agent: a diamond, brackets, a ringed dot. */
export function KindIcon({ type, className }: { type: "gate" | "code" | "agent"; className?: string }) {
  const props = { width: 12, height: 12, viewBox: "0 0 16 16", role: "img", "aria-label": type, className: cx("shrink-0 text-faint", className) };
  if (type === "gate") return <svg {...props}><path d="M8 1.5L14.5 8 8 14.5 1.5 8z" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M8 1.5L14.5 8 8 14.5z" fill="currentColor" /></svg>;
  if (type === "code") return <svg {...props}><path d="M5.5 4L2 8l3.5 4M10.5 4L14 8l-3.5 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  return <svg {...props}><circle cx="8" cy="8" r="2.4" fill="currentColor" /><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>;
}

const REFS = { issue: CircleDot, pr: GitPullRequest, branch: GitBranch } as const;
const REF_WORDS: Record<keyof typeof REFS, string> = { issue: "issue", pr: "pull request", branch: "branch" };

/**
 * A thing on the forge — an issue, a pull request, a branch — with its icon,
 * linked there when the cockpit knows where that is: `href` "" draws it
 * unlinked, as a row that is itself a link must. The icon is what tells an
 * issue's `#42` from a pull request's, so it says so to a screen reader too;
 * the text keeps the line's baseline, so one reads in a sentence as in a row.
 * Its state on the forge (open, merged…) is not something the events say, so
 * it is not coloured as one.
 */
export function ForgeRef({ kind, href, newTab = false, children }: {
  kind: keyof typeof REFS;
  href: string;
  /** Opened beside the cockpit, for a link away from work the page still holds. */
  newTab?: boolean;
  children: ReactNode;
}) {
  const Icon = REFS[kind];
  const body = (
    <>
      <Icon size={14} strokeWidth={2} role="img" aria-label={REF_WORDS[kind]} className="shrink-0 self-center text-faint" />
      <span className={cx("truncate", kind === "branch" && "font-mono")}>{children}</span>
    </>
  );
  const shape = "inline-flex min-w-0 items-baseline gap-1 whitespace-nowrap";
  if (!href) return <span className={shape}>{body}</span>;
  return <a className={cx(shape, "text-muted hover:text-fg")} href={href} {...(newTab ? { target: "_blank", rel: "noreferrer" } : {})}>{body}</a>;
}

export { ExternalLink };
