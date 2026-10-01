"use client";

import { useAction } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Opened, Proposed } from "@/convex/config";
import { branchFor, yamlProblem } from "@/convex/model/config";
import { said } from "../Shell";
import { unified } from "./diff";
import { short } from "./view";

/** A config file being edited: its text as the base commit holds it, and as it is now. */
export interface Draft {
  path: string;
  original: string;
  text: string;
}

/** What the pull request is called, and what the person says of it. */
export interface Asked {
  title: string;
  description: string;
}

/** What is wrong with `draft` as it stands: YAML that does not parse. */
function problemOf(draft: Draft): string | null {
  return yamlProblem(draft.path, draft.text);
}

/**
 * Why nothing can be proposed yet, or null when the pull request can be
 * opened: something changed, every changed file's YAML parses, and it has a
 * title. The action that opens it refuses the same things.
 */
export function blocked(drafts: Draft[], asked: Asked): string | null {
  const changed = drafts.filter((draft) => draft.text !== draft.original);
  if (changed.length === 0) return "Nothing changed yet.";
  const problem = changed.map(problemOf).find((each) => each !== null);
  if (problem) return `The YAML does not parse — ${problem}`;
  return asked.title.trim() ? null : "A pull request needs a title.";
}

/**
 * The Config tab's editor (spec #40, #58): the files being edited, each as
 * plain text, the YAML check, a diff preview of every changed file — what the
 * pull request will carry — and the pull request's title. Pure, so a test
 * renders it.
 */
export function ConfigEditorView({
  base, into, as, drafts, open, loading, asked, busy, outcome, onText, onOpen, onDiscard, onChange, onSubmit,
}: {
  /** The commit the files were read at, which the change is committed on top of. */
  base: string;
  /** The default branch the pull request asks to merge into. */
  into: string;
  /** Whose name the pull request goes up under: the viewer's login. */
  as: string;
  drafts: Draft[];
  /** The path of the draft shown in the editor. */
  open: string | null;
  /** A file being read from the forge, or one that could not be, and why. */
  loading: { path: string; because: string | null } | null;
  asked: Asked;
  busy: boolean;
  outcome: Proposed | null;
  onText: (path: string, text: string) => void;
  onOpen: (path: string) => void;
  onDiscard: (path: string) => void;
  onChange: (asked: Asked) => void;
  onSubmit: () => void;
}) {
  const current = drafts.find((draft) => draft.path === open) ?? null;
  const changed = drafts.filter((draft) => draft.text !== draft.original);
  const because = blocked(drafts, asked);
  const problem = current && problemOf(current);
  return (
    <section className="config-editor">
      <h2>Edit</h2>
      <p className="muted small">
        The files as <code>{into}</code> at <code>{short(base)}</code> held them. What is typed here is committed exactly — comments
        and all — as {as || "you"}, on <code>{branchFor(as || "you", asked.title)}</code>, and proposed to <code>{into}</code> as a
        pull request. The cockpit checks only that the YAML parses: the repository&apos;s CI and its branch protection decide the rest.
      </p>
      {drafts.length > 1 ? (
        <div className="tabs" role="tablist">
          {drafts.map((draft) => (
            <button key={draft.path} type="button" role="tab" aria-selected={draft.path === open} onClick={() => onOpen(draft.path)}>
              <code>{draft.path}</code>{draft.text !== draft.original ? " •" : ""}
            </button>
          ))}
        </div>
      ) : null}
      {loading !== null ? (
        loading.because === null ? <p className="muted small">Reading <code>{loading.path}</code> from the forge…</p>
          : <p className="notice small">Cannot edit <code>{loading.path}</code>: {loading.because}.</p>
      ) : null}
      {current !== null ? (
        <div className="draft">
          <label className="small">
            <code>{current.path}</code>
            <textarea className="code" spellCheck={false} value={current.text} rows={Math.min(40, current.text.split("\n").length + 2)}
                      onChange={(event) => onText(current.path, event.target.value)} />
          </label>
          {problem ? <p className="notice small" role="alert">The YAML does not parse — {problem}</p> : null}
          {current.text !== current.original ? (
            <button type="button" className="button quiet" onClick={() => onDiscard(current.path)}>Discard these changes</button>
          ) : null}
        </div>
      ) : null}

      <h3>Diff</h3>
      {changed.length === 0 ? <p className="muted small">Nothing changed yet.</p> : changed.map((draft) => (
        <pre key={draft.path} className="diff">{unified(draft.path, draft.original, draft.text).replace(/\n$/, "").split("\n").map((line, at) => (
          <span key={at} className={/^\+(?!\+\+ )/.test(line) ? "add" : /^-(?!-- )/.test(line) ? "del" : undefined}>{line}{"\n"}</span>
        ))}</pre>
      ))}

      <form className="form" onSubmit={(event) => { event.preventDefault(); if (because === null && !busy) onSubmit(); }}>
        <label>
          Title
          <input value={asked.title} placeholder="config: raise the per-session budget"
                 onChange={(event) => onChange({ ...asked, title: event.target.value })} />
        </label>
        <label>
          Description <small>optional — it opens the pull request&apos;s body, above where it says it came from</small>
          <textarea value={asked.description} onChange={(event) => onChange({ ...asked, description: event.target.value })} />
        </label>
        <button type="submit" className="button" disabled={because !== null || busy}>
          {busy ? "Opening…" : `Open pull request as ${as || "you"}`}
        </button>
        {because !== null && changed.length > 0 ? <small>{because}</small> : null}
      </form>
      {outcome?.ok ? (
        <p className="notice small">
          Opened <a href={outcome.url} target="_blank" rel="noreferrer">#{outcome.number}</a> from <code>{outcome.branch}</code>: the
          repository&apos;s CI checks it, and its branch protection governs the merge.
        </p>
      ) : outcome ? <p className="notice small">Not opened: {outcome.because}.</p> : null}
    </section>
  );
}

/**
 * The editor for one factory: each file the Config tab asks to edit is read
 * from the forge at `base` when first opened, and kept as a draft until the
 * pull request is opened or the change discarded.
 */
export function ConfigEditor({ factory, base, into, as, open, signIn, onOpen }: {
  factory: string;
  base: string;
  into: string;
  as: string;
  open: string;
  signIn: string | undefined;
  onOpen: (path: string) => void;
}) {
  const read = useAction(api.config.read);
  const propose = useAction(api.config.propose);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [failed, setFailed] = useState<{ path: string; because: string } | null>(null);
  const [asked, setAsked] = useState<Asked>({ title: "", description: "" });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Proposed | null>(null);
  const held = drafts.some((draft) => draft.path === open);

  useEffect(() => {
    if (held) return;
    let current = true;
    const opened = (got: Opened) => {
      if (!current) return;
      if (got.ok) setDrafts((now) => [...now, { path: open, original: got.text, text: got.text }]);
      else setFailed({ path: open, because: got.because });
    };
    read({ factory, path: open, ref: base, signIn }).then(opened, (error: unknown) => opened({ ok: false, because: said(error) }));
    return () => { current = false; };
  }, [read, factory, open, base, signIn, held]);

  const submit = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      const changed = drafts.filter((draft) => draft.text !== draft.original);
      const proposed = await propose({
        factory, base, title: asked.title, description: asked.description, signIn,
        files: changed.map(({ path, text }) => ({ path, content: text })),
      });
      setOutcome(proposed);
      // Proposed: the drafts are the pull request's now, and the editor starts again from what `base` holds.
      if (proposed.ok) {
        setDrafts([]);
        setAsked({ title: "", description: "" });
      }
    } catch (error) {
      setOutcome({ ok: false, because: said(error) });
    } finally {
      setBusy(false);
    }
  };
  const loading = held ? null : failed?.path === open ? failed : { path: open, because: null };
  return (
    <ConfigEditorView base={base} into={into} as={as} drafts={drafts} open={open} loading={loading} asked={asked} busy={busy}
                      outcome={outcome} onOpen={onOpen} onSubmit={() => void submit()}
                      onText={(path, text) => {
                        setDrafts((now) => now.map((draft) => (draft.path === path ? { ...draft, text } : draft)));
                        setOutcome(null);
                      }}
                      onDiscard={(path) => setDrafts((now) => now.map((draft) => (draft.path === path ? { ...draft, text: draft.original } : draft)))}
                      onChange={(next) => { setAsked(next); setOutcome(null); }} />
  );
}
