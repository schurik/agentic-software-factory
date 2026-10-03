// PROTOTYPE, throwaway. Icons (lucide) for the closed stage vocabulary, and the forge's own
// things — issue, pull request, branch, commit — linked, and coloured by state the way the
// forge colours them: open green, merged purple, closed red, draft grey.
import {
  BookOpen, CircleCheck, CircleDot, Code, ExternalLink, Eye, FlaskConical, GitBranch, GitCommitHorizontal,
  GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, ListChecks, Telescope, type LucideIcon,
} from "lucide-react";
import { FORGE, type IssueState, type PrState } from "@/lib/data";
import { cx } from "./ui";

export const STAGE_ICON: Record<string, LucideIcon> = {
  scout: Telescope,
  plan: ListChecks,
  commit: GitCommitHorizontal,
  implement: Code,
  verify: FlaskConical,
  review: Eye,
  document: BookOpen,
  integrate: GitMerge,
};

export function StageIcon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  const Icon = STAGE_ICON[name] ?? Code;
  return <Icon size={size} strokeWidth={1.75} className={cx("shrink-0", className)} aria-label={name} />;
}

const issueTone: Record<IssueState, string> = { open: "text-ok", closed: "text-merged" };
const prTone: Record<PrState, string> = { open: "text-ok", draft: "text-faint", merged: "text-merged", closed: "text-bad" };
const prIcon: Record<PrState, LucideIcon> = { open: GitPullRequest, draft: GitPullRequestDraft, merged: GitMerge, closed: GitPullRequestClosed };

export const issueUrl = (factory: string, n: number) => `${FORGE}/${factory}/issues/${n}`;
export const prUrl = (factory: string, n: number) => `${FORGE}/${factory}/pull/${n}`;
export const branchUrl = (factory: string, branch: string) => `${FORGE}/${factory}/tree/${branch}`;
export const commitUrl = (factory: string, sha: string) => `${FORGE}/${factory}/commit/${sha}`;

function Chip({ href, icon, children, className, plain }: { href?: string; icon: React.ReactNode; children: React.ReactNode; className?: string; plain?: boolean }) {
  const cls = cx("inline-flex min-w-0 items-center gap-1 whitespace-nowrap", !plain && "hover:underline underline-offset-2", className);
  const body = <>{icon}<span className="truncate">{children}</span></>;
  return href && !plain ? <a href={href} target="_blank" rel="noreferrer" className={cls} onClick={(e) => e.stopPropagation()}>{body}</a> : <span className={cls}>{body}</span>;
}

/** `plain` drops the link — for use inside something that is already a link. */
export function IssueRef({ factory, n, state, plain, className }: { factory: string; n: number; state: IssueState; plain?: boolean; className?: string }) {
  const Icon = state === "closed" ? CircleCheck : CircleDot;
  return <Chip plain={plain} href={issueUrl(factory, n)} className={className} icon={<Icon size={14} strokeWidth={2} className={issueTone[state]} aria-label={`issue ${state}`} />}>#{n}</Chip>;
}

export function PrRef({ factory, n, state, plain, className }: { factory: string; n: number; state: PrState; plain?: boolean; className?: string }) {
  const Icon = prIcon[state];
  return <Chip plain={plain} href={prUrl(factory, n)} className={className} icon={<Icon size={14} strokeWidth={2} className={prTone[state]} aria-label={`pull request ${state}`} />}>#{n}</Chip>;
}

export function BranchRef({ factory, branch, plain, className }: { factory: string; branch: string; plain?: boolean; className?: string }) {
  return <Chip plain={plain} href={branchUrl(factory, branch)} className={cx("font-mono", className)} icon={<GitBranch size={14} strokeWidth={2} className="text-faint" />}>{branch}</Chip>;
}

export function CommitRef({ factory, sha, className }: { factory: string; sha: string; className?: string }) {
  return <Chip href={commitUrl(factory, sha)} className={cx("font-mono", className)} icon={<GitCommitHorizontal size={14} strokeWidth={2} className="text-faint" />}>{sha.slice(0, 7)}</Chip>;
}

export function PrStateBadge({ state }: { state: PrState }) {
  const Icon = prIcon[state];
  const bg: Record<PrState, string> = { open: "bg-ok text-white", draft: "bg-faint text-white", merged: "bg-merged text-white", closed: "bg-bad text-white" };
  return <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", bg[state])}><Icon size={12} strokeWidth={2.25} />{state}</span>;
}

export { ExternalLink };
