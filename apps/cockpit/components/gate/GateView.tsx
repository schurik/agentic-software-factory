"use client";

import { ChevronDown, ChevronUp, MessageSquareQuote } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { Answer } from "@/convex/model/answer";
import { type Question, stationWords } from "@/convex/model/inbox";
import { DiffView } from "../diff/DiffView";
import { DrawerFrame } from "../Drawer";
import { formatAgo, formatDuration, sessionHref } from "../format";
import { ForgeRef, StageIcon, StatusIcon } from "../icons";
import { workItem } from "../inbox/InboxList";
import { keyed } from "../inbox/keys";
import { isMarkdown, Markdown } from "../Markdown";
import { channelWords } from "../session/words";
import { Button, buttonClass, control, cx, followInPlace, type Go, Kbd, Pre, Tabs } from "../ui";
import { useWho } from "../viewer";
import { decide, verbsOf } from "./answer";

export type Gate = NonNullable<FunctionReturnType<typeof api.inbox.gate>>;
export type Read = FunctionReturnType<typeof api.inbox.subject>;

/** Where a gate sits among the ones the viewer can answer: "n of m", and the gates either side. */
export interface Step {
  at: number;
  of: number;
  previous: Go | null;
  next: Go | null;
}

/**
 * Why the answer cannot be given here and now, or null when it can: the row's
 * own reason first, then the subject — nobody approves what they cannot see,
 * nor what is not what the factory asked about.
 */
export function unanswerable(gate: Gate, read: Read | null): string | null {
  if (gate.row.blocked) return gate.row.blocked;
  if (read === null) return "reading the subject from the forge…";
  if (!read.ok) return `the subject cannot be shown: ${read.because}`;
  if (read.current === false) {
    return `digest changed: what ${read.headSha.slice(0, 7)} holds is not what the factory asked about, ` +
      "so an answer would be refused";
  }
  return null;
}

/**
 * Where the answer lands, said before it is given: nothing done here is
 * invisible on the forge — and an answer with no work item to land on is a
 * command to the station, which says whether it is listening.
 */
export function lands(gate: Gate, now: number, who: (login: string) => string = (login) => login): { text: string; url: string; then: string } {
  const { row, forge } = gate;
  const as = gate.as ? who(gate.as) : "you";
  if (row.via === "command") {
    return { text: `Sends a command to ${row.station} as ${as}`, url: "",
             then: `${stationWords(row, now)}, and records it as your decision` };
  }
  const url = row.issueUrl || (forge && row.issueNumber ? `${forge}/${row.factory}/issues/${row.issueNumber}` : "");
  return { text: `Posts a comment on issue #${row.issueNumber} as ${as}`, url,
           then: "the factory's answers watcher picks it up" };
}

type Tab = "plan" | "changes" | "subject" | "questions" | "checks" | "review" | "issue" | "findings";

/**
 * The tabs a gate opens into, by its kind (#113) — each only where there is
 * something in it, the first being what the person decides on: a plan gate's
 * plan, the issue in the reporter's words and the scout's findings; an
 * integrate gate's changes, checks, review and issue; a question round's
 * questions; and any other gate's subject.
 */
function tabsFor(gate: Gate): { id: Tab; label: string }[] {
  const { row, material } = gate;
  const issue = material.issue ? [{ id: "issue" as const, label: row.issueNumber ? `Issue #${row.issueNumber}` : "Issue" }] : [];
  if (row.kind === "questions") return [{ id: "questions", label: "Questions" }, ...issue];
  if (row.gate === "plan") {
    return [{ id: "plan", label: "Plan" }, ...issue,
            ...(material.findings ? [{ id: "findings" as const, label: "Scout's findings" }] : [])];
  }
  if (row.gate === "integrate") {
    return [{ id: "changes", label: "Changes" },
            ...(material.checks.length ? [{ id: "checks" as const, label: "Checks" }] : []),
            ...(material.review ? [{ id: "review" as const, label: "Review" }] : []), ...issue];
  }
  return [{ id: "subject", label: "Subject" }, ...issue];
}

/**
 * A gate in the drawer (#113): what it asks, about which session, how long it
 * has waited and where; the round before's verdict and note; every flag an
 * agent filed; the tabs for its kind; and a footer that answers it — or says
 * it was answered, or whom it waits on. Holds only what is being typed;
 * `onAnswer` posts it, and `a`, `r`, `j` and `k` work from the keyboard,
 * never while typing. Pure apart from that: a test renders it as it first paints.
 */
export function GateView({ gate, read, now, posting, problem, onAnswer, tab, onTab, close, step }: {
  gate: Gate;
  read: Read | null;
  now: number;
  posting: boolean;
  problem: string;
  onAnswer: (answer: Answer) => void;
  /** The tab the address has open; the first for the gate's kind when it names none of its own. */
  tab: string | null;
  onTab: (tab: string) => void;
  close: Go;
  step: Step | null;
}) {
  const { row, material } = gate;
  const who = useWho();
  const verbs = verbsOf(row);
  const questions = row.kind === "questions";
  const [notes, setNotes] = useState("");
  const [answers, setAnswers] = useState<string[]>(() => gate.questions.map(() => ""));
  const [hint, setHint] = useState("");
  const notesBox = useRef<HTMLTextAreaElement>(null);
  const answering = gate.mine && gate.answered === null;
  const cannot = unanswerable(gate, read);
  const off = cannot !== null || posting;
  // A station may take one kind of answer and not the other: `answer` and `abort` are opted in apart.
  const refusedFor = (verdict: Answer["verdict"]) => (verdict === "abort" ? row.refused?.abort : row.refused?.answer) ?? null;
  const offFor = (verdict: Answer["verdict"]) => off || refusedFor(verdict) !== null;

  const give = (verdict: Answer["verdict"]) => {
    if (!answering || offFor(verdict)) return;
    const decided = decide(verdict, notes, answers);
    if ("hint" in decided) {
      setHint(decided.hint);
      notesBox.current?.focus();
      return;
    }
    if (verdict === "abort" && !window.confirm(`Abort ${row.session}? The run ends as failed, and its worktree is kept.`)) return;
    setHint("");
    onAnswer(decided.answer);
  };

  // The latest `give` and step for the key handler, without re-subscribing on every keystroke.
  const latest = useRef({ give, step });
  useEffect(() => {
    latest.current = { give, step };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = keyed(event);
      const to = key === "next" ? latest.current.step?.next : key === "previous" ? latest.current.step?.previous : null;
      if (to) {
        event.preventDefault();
        to.onClick();
      } else if (key === "approve") {
        event.preventDefault();
        latest.current.give("approve");
      } else if (key === "reject" && !questions) {
        event.preventDefault();
        latest.current.give("reject");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [questions]);

  const tabs = tabsFor(gate);
  const shown = tabs.find((each) => each.id === tab)?.id ?? tabs[0].id;
  const asked = channelWords(row.channel, row.issueNumber);
  const before = row.round > 1 ? gate.earlier.at(-1) : undefined;
  const landing = lands(gate, now, who);
  const refusedOne = refusedFor("answer") ?? refusedFor("abort");

  const footer = !gate.mine ? (
    <p className="py-1 text-sm text-muted">{sentence(row.blocked ?? `waiting on ${gate.waitsOn.map(who).join(", ")}`)}</p>
  ) : gate.answered ? (
    <p className="py-1 text-sm text-muted">
      Answered: <b className="text-fg">{gate.answered.verdict}</b> by {who(gate.answered.by)}.{" "}
      {gate.answered.url ? <>The station picks it up from <a href={gate.answered.url} target="_blank" rel="noreferrer">the comment</a> on {asked}.</>
        : row.via === "command" ? <>{sentence(stationWords(row, now))}.</>
        : <>The run goes on when the factory next looks.</>}
    </p>
  ) : (
    <div className="flex flex-col gap-2.5">
      <textarea ref={notesBox} value={notes} disabled={off} rows={2} placeholder={verbs.placeholder}
                className={cx(control, "w-full resize-none", hint && "border-bad")}
                onChange={(event) => { setNotes(event.target.value); setHint(""); }}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") give(questions ? "answer" : "reject");
                }} />
      {hint ? <p className="-mt-1 text-sm text-bad">{hint}</p> : null}
      {/* Primary first: a phone stacks them so, full width; from md the row reads Abort … Reject, Approve. */}
      <div className="flex flex-col gap-2 md:flex-row-reverse md:items-center">
        {questions ? (
          <>
            <Button variant="primary" className="max-md:w-full" disabled={offFor("answer")} onClick={() => give("answer")}>{verbs.approve}</Button>
            <Button className="max-md:w-full" disabled={offFor("approve")} onClick={() => give("approve")}>Take all recommendations <Kbd>a</Kbd></Button>
          </>
        ) : (
          <>
            <Button variant="primary" className="max-md:w-full" disabled={offFor("approve")} onClick={() => give("approve")}>{verbs.approve} <Kbd>a</Kbd></Button>
            <Button className="max-md:w-full" disabled={offFor("reject")} onClick={() => give("reject")}>{verbs.reject} <Kbd>r</Kbd></Button>
          </>
        )}
        <Button variant="ghost" size="sm" className="text-muted max-md:self-center md:mr-auto md:-ml-2" disabled={offFor("abort")}
                onClick={() => give("abort")}>Abort session</Button>
      </div>
      {problem ? <p className="text-sm text-bad">Not {row.via === "command" ? "sent" : "posted"}: {problem}.</p> : null}
      <div className="text-xs text-muted">
        {cannot ? <>Cannot be answered here: {cannot}.</> : (
          <>{landing.url ? <a href={landing.url} target="_blank" rel="noreferrer">{landing.text}</a> : landing.text}; {landing.then}.</>
        )}
        {!cannot && refusedOne ? <> Not all of it: {refusedOne}.</> : null}
        {row.note ? <> {sentence(row.note)}</> : null}
      </div>
    </div>
  );

  return (
    <DrawerFrame icon={<StageIcon name={row.gate} size={16} className="text-wait" />} kind="gate"
                 title={`${row.gate} ${questions ? "questions" : "gate"}`} what={`· round ${row.round}`}
                 back={null} close={close} bar={step && step.of > 1 ? <Stepper step={step} /> : null} footer={footer}>
      <div className="flex flex-col gap-5">
        <div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            <span>{row.factory}</span>
            {row.issueNumber ? <ForgeRef kind="issue" href={landing.url}>#{row.issueNumber}</ForgeRef> : null}
            <a className="text-muted hover:text-fg" href={sessionHref(row.factory, row.session)}>session <code>{row.session}</code> →</a>
          </div>
          <h3 className="mt-2 text-xl font-semibold tracking-tight">{verbs.question}</h3>
          <p className="mt-0.5">{gate.title || workItem(row)}</p>
          <p className="mt-1 text-sm text-muted">Waiting {formatAgo(row.since, now).replace(/ ago$/, "")} · asked on {asked}</p>
          {row.summary ? <p className="mt-2 text-sm">{row.summary}</p> : null}
        </div>

        {before ? (
          <div className="flex gap-3 rounded-lg border border-wait/40 bg-wait-soft px-3.5 py-2.5">
            <MessageSquareQuote size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-wait" />
            <div className="text-sm">
              <div className="text-muted">Round {before.round}: {VERDICTS[before.verdict] ?? before.verdict} by {who(before.by)}</div>
              {before.notes ? <div className="text-base">“{before.notes}”</div> : null}
            </div>
          </div>
        ) : null}

        {material.flags.length ? (
          <ul aria-label="Flags" className="flex flex-col gap-1.5 text-sm">
            {material.flags.map((flag, at) => (
              <li key={at} className="flex gap-2">
                <span aria-hidden="true" className="text-wait">⚑</span>
                <span>
                  <b className="font-medium">{flag.kind}</b> · {flag.what}
                  {flag.because ? <> — {flag.because}</> : null}
                  {flag.insteadOf ? <> (instead of {flag.insteadOf})</> : null}
                  <span className="text-muted"> · {who(flag.by)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        <div>
          <Tabs label="Gate" selected={shown} onSelect={onTab} tabs={tabs} />
          <div role="tabpanel" className="pt-4">
            {shown === "questions" ? (
              <div className="grid gap-3">
                {gate.questions.map((question, at) => (
                  <QuestionCard key={at} question={question} answer={answers[at] ?? ""} disabled={off || !answering}
                                onChange={(text) => setAnswers((all) => all.map((each, i) => (i === at ? text : each)))} />
                ))}
              </div>
            ) : shown === "issue" ? <Doc doc={material.issue} />
              : shown === "findings" ? <Doc doc={material.findings} />
              : shown === "review" ? (
                <div className="flex flex-col gap-3">
                  {material.review?.summary ? <p className="text-sm text-muted">{material.review.summary}</p> : null}
                  <Doc doc={material.review?.doc ?? null} />
                </div>
              ) : shown === "checks" ? <Checks checks={material.checks} />
              : <Subject gate={gate} read={read} what={shown === "plan" ? "the plan" : shown === "changes" ? "the changes" : "the subject"} />}
          </div>
        </div>
      </div>
    </DrawerFrame>
  );
}

const VERDICTS: Record<string, string> = { reject: "rejected", approve: "approved", answer: "answered", abort: "aborted" };

/** A clause as a sentence: its first letter up, a full stop after it. */
const sentence = (clause: string) => `${clause.charAt(0).toUpperCase()}${clause.slice(1).replace(/\.?$/, ".")}`;

/** The top bar's "n of m", with the gates either side: what `j` and `k` go to. */
function Stepper({ step }: { step: Step }) {
  const arrow = (to: Go | null, label: string, icon: ReactNode) => (to ? (
    <a href={to.href} onClick={followInPlace(to.onClick)} aria-label={label} className={cx(buttonClass("ghost", "sm"), "px-1.5")}>{icon}</a>
  ) : (
    <span aria-hidden="true" className={cx(buttonClass("ghost", "sm"), "px-1.5 opacity-30")}>{icon}</span>
  ));
  return (
    <span className="flex items-center gap-0.5 text-xs text-muted">
      {arrow(step.previous, "Previous gate (k)", <ChevronUp size={16} aria-hidden="true" />)}
      {arrow(step.next, "Next gate (j)", <ChevronDown size={16} aria-hidden="true" />)}
      <span className="px-1 tabular-nums">{step.at} of {step.of}</span>
      <span aria-hidden="true" className="mx-1.5 h-4 w-px bg-line" />
    </span>
  );
}

/**
 * The subject as the forge holds it at the commit the question was asked
 * about: its files — markdown rendered, anything else as written — and, for a
 * subject that is the session's own diff, the forge's comparison.
 */
function Subject({ gate, read, what }: { gate: Gate; read: Read | null; what: string }) {
  if (read === null) return <p className="text-sm text-muted">Reading {what} from the forge…</p>;
  if (!read.ok) return <p className="text-sm text-muted">Not shown: {read.because}.</p>;
  const at = read.headSha.slice(0, 7);
  return (
    <div className="flex flex-col gap-4">
      {read.files.map((file) => (
        <figure key={file.path} className="flex flex-col gap-2">
          <figcaption className="text-xs text-muted"><code>{file.path}</code> at {at}{file.truncated ? " · cut at the cap" : ""}</figcaption>
          {file.binary ? <p className="text-sm text-muted">Not text: nothing to show.</p>
            : isMarkdown(file.path) ? <Markdown text={file.content} /> : <Pre>{file.content}</Pre>}
        </figure>
      ))}
      {read.diff !== null ? (
        <DiffView text={read.diff} title={<>the branch against {gate.subject.baseCommit.slice(0, 7) || "its base"}, up to {at}</>} />
      ) : null}
    </div>
  );
}

/** A file the session carried, rendered as markdown: the issue, the findings, the review. */
function Doc({ doc }: { doc: Gate["material"]["issue"] }) {
  if (doc === null) return <p className="text-sm text-muted">Nothing was written.</p>;
  if (doc.pruned) return <p className="text-sm text-muted"><code>{doc.path}</code> was purged from this cockpit.</p>;
  return (
    <div className="flex flex-col gap-2">
      <Markdown text={doc.content} />
      {doc.truncated ? <p className="text-xs text-muted">Cut at the factory&apos;s cap: the rest is in <code>{doc.path}</code>.</p> : null}
    </div>
  );
}

/** What the latest verify ran, each command passed or failed. */
function Checks({ checks }: { checks: Gate["material"]["checks"] }) {
  return (
    <ul className="flex flex-col divide-y divide-line rounded-lg border border-line text-sm">
      {checks.map((check, at) => (
        <li key={at} className="flex items-center gap-3 px-3 py-2.5">
          <StatusIcon status={check.ok ? "done" : "failed"} />
          <span className="font-medium">{check.name}</span>
          <code className="min-w-0 grow truncate text-xs text-muted">{check.argv.join(" ")}</code>
          <span className="shrink-0 text-faint tabular-nums">{check.ok ? "" : `exit ${check.exitCode} · `}{formatDuration(check.seconds)}</span>
        </li>
      ))}
    </ul>
  );
}

function QuestionCard({ question, answer, disabled, onChange }: {
  question: Question;
  answer: string;
  disabled: boolean;
  onChange: (text: string) => void;
}) {
  const recommended = question.options.find((option) => option.recommended);
  return (
    <div className="grid gap-1 rounded-lg border border-line p-3">
      <div className="text-sm text-muted">{question.topic}{question.blocking ? "" : " · nice to have"}</div>
      <strong className="font-medium">{question.question}</strong>
      {question.why ? <div className="text-sm text-muted">{question.why}</div> : null}
      <ol className="my-1 list-decimal pl-5 text-sm">
        {question.options.map((option, at) => (
          <li key={at}>
            {option.answer}{option.recommended ? <em> — recommended</em> : null}
            {option.because ? <span className="text-muted"> · {option.because}</span> : null}
          </li>
        ))}
      </ol>
      <textarea value={answer} disabled={disabled} rows={2} className={cx(control, "w-full")} onChange={(event) => onChange(event.target.value)}
                placeholder={recommended ? `leave empty to take “${recommended.answer}”` : "your answer"} />
    </div>
  );
}
