"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { Answer } from "@/convex/model/answer";
import { type Question, stationWords } from "@/convex/model/inbox";
import { formatCost, formatTokens, sessionHref } from "../format";
import { Button, Card, control, cx, DiffBlock, Facts, Kbd, Pre, Tag } from "../ui";
import { useWho } from "../viewer";
import { keyed } from "./keys";
import { asks, workItem } from "./InboxList";

export type Gate = NonNullable<FunctionReturnType<typeof api.inbox.gate>>;
export type Read = FunctionReturnType<typeof api.inbox.subject>;

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

/**
 * The answer half of the inbox, in the order a person decides in (spec #40):
 * what it asks, the subject, earlier rounds, the journal, where the answer
 * lands and whether the subject is current — then the verdicts, and cost,
 * station and session last. Holds only what is being typed;
 * `onAnswer` posts it. `a` and `r` answer from the keyboard.
 */
export function AnswerView({ gate, read, now, posting, problem, onAnswer }: {
  gate: Gate;
  read: Read | null;
  now: number;
  posting: boolean;
  problem: string;
  onAnswer: (answer: Answer) => void;
}) {
  const { row } = gate;
  const who = useWho();
  const questions = row.kind === "questions";
  const [notes, setNotes] = useState("");
  const [answers, setAnswers] = useState<string[]>(() => gate.questions.map(() => ""));
  const [hint, setHint] = useState("");
  const notesBox = useRef<HTMLTextAreaElement>(null);
  const cannot = unanswerable(gate, read);
  const off = cannot !== null || posting;
  // A station may take one kind of answer and not the other: `answer` and `abort` are opted in apart.
  const refusedFor = (verdict: Answer["verdict"]) => (verdict === "abort" ? row.refused?.abort : row.refused?.answer) ?? null;
  const offFor = (verdict: Answer["verdict"]) => off || refusedFor(verdict) !== null;

  const give = (verdict: Answer["verdict"]) => {
    if (offFor(verdict)) return;
    if (verdict === "reject" && !notes.trim()) {
      setHint("A reject needs notes: they are what the agent revises from.");
      notesBox.current?.focus();
      return;
    }
    if (verdict === "abort" && !window.confirm(`Abort ${row.session}? The run ends as failed, and its worktree is kept.`)) return;
    setHint("");
    onAnswer({ verdict, notes, answers: verdict === "answer" ? answers : [] });
  };

  // The latest `give` for the key handler, without re-subscribing on every keystroke.
  const latest = useRef(give);
  useEffect(() => {
    latest.current = give;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = keyed(event);
      if (key === "approve") {
        event.preventDefault();
        latest.current("approve");
      } else if (key === "reject" && !questions) {
        event.preventDefault();
        if (notesBox.current?.value.trim()) latest.current("reject");
        else notesBox.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [questions]);

  const landing = lands(gate, now, who);
  const refusedOne = refusedFor("answer") ?? refusedFor("abort");
  return (
    <Card className="min-w-0 p-4 sm:p-5">
      <article>
        <div className="text-sm text-muted">{row.factory} · {workItem(row)}</div>
        <h2 className="mt-1 flex flex-wrap items-center gap-2 text-xl">
          {questions ? `${asks(row)} before the ${row.gate}` : `Approve the ${row.gate}?`}
          {row.round > 1 ? <Tag>round {row.round}</Tag> : null}
        </h2>
        {row.summary ? <p className="mt-2">{row.summary}</p> : null}
        {gate.notes ? <p className="mt-1 text-sm text-muted">The agent&apos;s notes: {gate.notes}</p> : null}

        <section aria-label="Subject" className="mt-4 grid gap-3">
          {questions ? (
            gate.questions.map((question, at) => (
              <QuestionCard key={at} question={question} answer={answers[at] ?? ""} disabled={off}
                            onChange={(text) => setAnswers((all) => all.map((each, i) => (i === at ? text : each)))} />
            ))
          ) : (
            <Subject read={read} />
          )}
        </section>

        {gate.earlier.length ? (
          <section className="mt-5">
            <h4 className="mb-1.5">Earlier rounds</h4>
            {gate.earlier.map((earlier) => (
              <p key={earlier.round} className="text-sm">
                Round {earlier.round}: <strong>{earlier.verdict}</strong> by {who(earlier.by)}
                {earlier.notes ? <> — “{earlier.notes}”</> : null}
              </p>
            ))}
          </section>
        ) : null}

        <details className="mt-5 text-sm">
          <summary className="text-muted">On the record — the journal the next agent reads</summary>
          {gate.journal ? <Pre className="mt-2">{gate.journal}</Pre> : <p className="mt-2 text-muted">Nothing closed yet.</p>}
        </details>

        <div className={cx("mt-5 border-l-[3px] py-1 pl-3 text-sm", cannot ? "border-wait text-fg" : "border-line-strong text-muted")}>
          {cannot ? <>Cannot be answered here: {cannot}.</> : (
            <>{landing.url ? <a href={landing.url} target="_blank" rel="noreferrer">{landing.text}</a> : landing.text}
              ; {landing.then}.</>
          )}
          {!cannot && refusedOne ? <div>Not all of it: {refusedOne}.</div> : null}
          {row.note ? <div>{row.note}.</div> : null}
          <div><Digest gate={gate} read={read} /></div>
        </div>

        <textarea ref={notesBox} value={notes} disabled={off} rows={3} className={cx(control, "mt-4 w-full")}
                  placeholder={questions ? "anything else (optional)" : "notes: required to reject — what should change"}
                  onChange={(event) => setNotes(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") give(questions ? "answer" : "reject");
                  }} />
        <div className="mt-3 flex flex-wrap gap-2">
          {questions ? (
            <>
              <Button variant="primary" disabled={offFor("answer")} onClick={() => give("answer")}>Send answers</Button>
              <Button disabled={offFor("approve")} onClick={() => give("approve")}>
                Take all recommendations <Kbd>a</Kbd>
              </Button>
            </>
          ) : (
            <>
              <Button variant="primary" disabled={offFor("approve")} onClick={() => give("approve")}>Approve <Kbd>a</Kbd></Button>
              <Button variant="danger" disabled={offFor("reject")} onClick={() => give("reject")}>Reject <Kbd>r</Kbd></Button>
            </>
          )}
          <Button variant="ghost" disabled={offFor("abort")} onClick={() => give("abort")}>Abort run</Button>
        </div>
        {hint ? <p className="mt-2 text-sm text-bad">{hint}</p> : null}
        {problem ? <p className="mt-2 text-sm text-bad">Not {row.via === "command" ? "sent" : "posted"}: {problem}.</p> : null}

        <Facts className="mt-6 border-t border-line pt-4 text-sm">
          <dt>Session</dt><dd><Link href={sessionHref(row.factory, row.session)}><code>{row.session}</code></Link> · {row.workflow}</dd>
          <dt>Station</dt><dd>{row.station || "—"}</dd>
          <dt>Cost</dt><dd>{formatCost(gate.cost)}{gate.tokens ? ` · ${formatTokens(gate.tokens)}` : ""}</dd>
        </Facts>
      </article>
    </Card>
  );
}

function Subject({ read }: { read: Read | null }) {
  if (read === null) return <p className="text-muted">Reading the subject from the forge…</p>;
  if (!read.ok) return <p className="text-muted">Not shown: {read.because}.</p>;
  return (
    <>
      {read.files.map((file) => (
        <figure key={file.path} className="grid gap-1">
          <figcaption className="text-sm"><code>{file.path}</code> <span className="text-muted">at {read.headSha.slice(0, 7)}</span>
            {file.truncated ? <span className="text-muted"> · cut at the cap</span> : null}</figcaption>
          {file.binary ? <p className="text-muted">Not text: nothing to show.</p> : <Pre>{file.content}</Pre>}
        </figure>
      ))}
      {read.diff !== null ? (
        <figure className="grid gap-1">
          <figcaption className="text-sm">The diff <span className="text-muted">up to {read.headSha.slice(0, 7)}</span></figcaption>
          <DiffBlock text={read.diff} />
        </figure>
      ) : null}
    </>
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

function Digest({ gate, read }: { gate: Gate; read: Read | null }) {
  const digest = <code>{gate.subjectDigest.slice(0, 12) || "—"}</code>;
  if (read === null || !read.ok) return <>digest {digest}</>;
  if (read.current === null) return <>digest {digest}, checked by the factory when it hears the answer</>;
  return read.current
    ? <>digest {digest} <Tag tone="ok">current</Tag></>
    : <>digest {digest} <Tag tone="bad">changed</Tag></>;
}
