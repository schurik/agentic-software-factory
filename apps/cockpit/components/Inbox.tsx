"use client";

import { useAction, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Answer } from "@/convex/model/answer";
import type { Row } from "@/convex/model/inbox";
import { useClock } from "./clock";
import { AnswerView, type Read } from "./inbox/AnswerView";
import { InboxList, keyOf } from "./inbox/InboxList";
import { keyed } from "./inbox/keys";
import { said } from "./Shell";
import { useSignIn } from "./signIn";

/**
 * The home page: every gate the viewer is permitted to answer, across every
 * factory, a list on the left and the open one's answer view on the right.
 * Both are live queries, so a gate that opens appears and one the factory
 * acted on goes, with nothing to reload.
 */
export function Inbox({ open }: { open?: string }) {
  const signIn = useSignIn();
  const inbox = useQuery(api.inbox.list, { signIn });
  const now = useClock();
  const [selected, setSelected] = useState<string | null>(open ?? null);
  const [posted, setPosted] = useState<{ what: string; url: string; to: string } | null>(null);
  const rows = useMemo(() => inbox?.rows ?? [], [inbox]);
  const current = rows.find((row) => keyOf(row) === selected) ?? rows[0] ?? null;
  const at = current ? rows.indexOf(current) : -1;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = keyed(event);
      if (key !== "next" && key !== "previous") return;
      const next = rows[Math.min(Math.max(at + (key === "next" ? 1 : -1), 0), rows.length - 1)];
      if (next) {
        event.preventDefault();
        setSelected(keyOf(next));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, at]);

  if (inbox === undefined) return <p className="muted">Loading…</p>;
  if (rows.length === 0) {
    return (
      <>
        <h1>Inbox</h1>
        <p className="muted">Nothing is waiting on you. A gate any factory you can see suspends at, and that you may answer, appears here.</p>
      </>
    );
  }
  const answered = (row: Row, url: string) => {
    setPosted({ what: `${row.gate} round ${row.round} of ${row.factory}`, url, to: row.station });
    // On to the next wait that can still be answered; the one just answered stays, saying so.
    const after = [...rows.slice(at + 1), ...rows.slice(0, at)].find((each) => each.blocked === null);
    if (after) setSelected(keyOf(after));
  };
  return (
    <>
      <div className="inbox-head">
        <h1>Inbox</h1>
        <span className="muted small">{rows.length} waiting · <kbd>j</kbd>/<kbd>k</kbd> next/previous · <kbd>a</kbd> approve · <kbd>r</kbd> reject</span>
      </div>
      {posted?.url ? (
        <p className="notice small">
          Answered {posted.what}: <a href={posted.url} target="_blank" rel="noreferrer">the comment</a>. It goes on
          when the factory&apos;s answers watcher picks it up.
        </p>
      ) : posted ? (
        <p className="notice small">
          Answered {posted.what}: sent to {posted.to}. It goes on once the station records it as your decision.
        </p>
      ) : null}
      <div className="inbox">
        <InboxList rows={rows} selected={current && keyOf(current)} now={now} onSelect={setSelected} />
        {current ? <Answering key={keyOf(current)} row={current} signIn={signIn} now={now} onAnswered={answered} /> : null}
      </div>
    </>
  );
}

/** One wait's answer view, with the subject read from the forge as it opens and the answer posted from it. */
function Answering({ row, signIn, now, onAnswered }: {
  row: Row;
  signIn: string | undefined;
  now: number;
  onAnswered: (row: Row, url: string) => void;
}) {
  const where = { factory: row.factory, session: row.session, signIn };
  const gate = useQuery(api.inbox.gate, where);
  const readSubject = useAction(api.inbox.subject);
  const answer = useAction(api.inbox.answer);
  const [read, setRead] = useState<Read | null>(null);
  const [posting, setPosting] = useState(false);
  const [problem, setProblem] = useState("");
  const digest = gate?.subjectDigest;

  useEffect(() => {
    if (digest === undefined) return;
    let current = true;
    readSubject({ factory: row.factory, session: row.session, signIn }).then(
      (got) => { if (current) setRead(got); },
      (error: unknown) => { if (current) setRead({ ok: false, because: said(error) }); });
    return () => { current = false; };
  }, [readSubject, row.factory, row.session, signIn, digest]);

  if (gate === undefined) return <p className="muted">Loading…</p>;
  if (gate === null) return <p className="notice">This wait is no longer one you may answer.</p>;
  const give = async (given: Answer) => {
    setPosting(true);
    setProblem("");
    try {
      const result = await answer({ ...where, gate: gate.row.gate, round: gate.row.round, digest: gate.subjectDigest, ...given });
      if (result.ok) onAnswered(row, result.url);
      else setProblem(result.because);
    } catch (error) {
      setProblem(said(error));
    } finally {
      setPosting(false);
    }
  };
  return <AnswerView gate={gate} read={read} now={now} posting={posting} problem={problem} onAnswer={(given) => void give(given)} />;
}
