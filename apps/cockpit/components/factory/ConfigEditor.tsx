"use client";

import { useAction } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Proposed } from "@/convex/config";
import { asCommitted, branchFor, type Edited, proposalProblem, yamlProblem } from "@/convex/model/config";
import { said } from "../said";
import { unified } from "./diff";
import { Button, Card, control, cx, DiffBlock, Field, Notice, Section, Tabs } from "../ui";
import { useWho } from "../viewer";
import { short } from "./view";

/**
 * A config file being edited: its text as the base commit holds it, and as it
 * is now — both with LF line endings, which is all a textarea keeps — and
 * whether the file's own are CRLF, which it gets back when it is proposed.
 */
export interface Draft {
  path: string;
  original: string;
  text: string;
  crlf: boolean;
}

/** What a draft proposes: the file's whole new text, in its own line endings. */
export function proposedFile(draft: Draft): { path: string; content: string } {
  return { path: draft.path, content: asCommitted(draft.text, draft.crlf) };
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
 * opened: something changed, and what changed passes `proposalProblem` —
 * which the action that opens it refuses on too.
 */
export function blocked(drafts: Draft[], asked: Asked): string | null {
  const changed = drafts.filter((draft) => draft.text !== draft.original);
  if (changed.length === 0) return "nothing changed yet";
  return proposalProblem(changed.map(proposedFile), asked.title);
}

/**
 * The Config tab's editor (spec #40, #58): the files being edited, each as
 * plain text, the YAML check, a diff preview of every changed file — what the
 * pull request will carry — and the pull request's title. Pure, so a test
 * renders it.
 */
export function ConfigEditorView({
  base, into, as, drafts, shown, loading, asked, busy, outcome, onText, onOpen, onDiscard, onChange, onSubmit,
}: {
  /** The commit the files were read at, which the change is committed on top of. */
  base: string;
  /** The default branch the pull request asks to merge into. */
  into: string;
  /** Whose name the pull request goes up under: the viewer's login. */
  as: string;
  drafts: Draft[];
  /** The path of the draft shown in the editor. */
  shown: string | null;
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
  const who = useWho();
  const by = as ? who(as) : "you";
  const current = drafts.find((draft) => draft.path === shown) ?? null;
  const changed = drafts.filter((draft) => draft.text !== draft.original);
  const because = blocked(drafts, asked);
  const problem = current && problemOf(current);
  return (
    <Section title="Edit">
      <Card className="p-4 sm:p-5">
        <p className="text-sm text-muted">
          The files as <code>{into}</code> at <code>{short(base)}</code> held them. What is typed here is committed exactly — comments
          and all — as {by}, on <code>{branchFor(as || "you", asked.title)}</code>, and proposed to <code>{into}</code> as a
          pull request. The cockpit checks only that the YAML parses: the repository&apos;s CI and its branch protection decide the rest.
        </p>
        {drafts.length > 1 ? (
          <Tabs label="Files being edited" className="mt-4" selected={shown ?? ""} onSelect={onOpen}
                tabs={drafts.map((draft) => ({ id: draft.path, label: <><code>{draft.path}</code>{draft.text !== draft.original ? " •" : ""}</> }))} />
        ) : null}
        {loading !== null ? (
          loading.because === null ? <p className="mt-3 text-sm text-muted">Reading <code>{loading.path}</code> from the forge…</p>
            : <Notice className="text-sm">Cannot edit <code>{loading.path}</code>: {loading.because}.</Notice>
        ) : null}
        {current !== null ? (
          <div className="mt-4 grid gap-2">
            <Field label={<code>{current.path}</code>}>
              <textarea spellCheck={false} value={current.text} rows={Math.min(40, current.text.split("\n").length + 2)}
                        className={cx(control, "w-full overflow-x-auto font-mono text-sm [overflow-wrap:normal] [tab-size:2] whitespace-pre")}
                        onChange={(event) => onText(current.path, event.target.value)} />
            </Field>
            {problem ? <Notice tone="bad" className="text-sm" role="alert">The YAML does not parse — {problem}</Notice> : null}
            {current.text !== current.original ? (
              <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => onDiscard(current.path)}>Discard these changes</Button>
            ) : null}
          </div>
        ) : null}

        <h4 className="mt-6 mb-2">Diff</h4>
        {changed.length === 0 ? <p className="text-sm text-muted">Nothing changed yet.</p> : (
          <div className="grid gap-2">
            {changed.map((draft) => <DiffBlock key={draft.path} text={unified(draft.path, draft.original, draft.text)} />)}
          </div>
        )}

        <form className="mt-6 grid max-w-2xl gap-3" onSubmit={(event) => { event.preventDefault(); if (because === null && !busy) onSubmit(); }}>
          <Field label="Title">
            <input value={asked.title} placeholder="config: raise the per-session budget" className={control}
                   onChange={(event) => onChange({ ...asked, title: event.target.value })} />
          </Field>
          <Field label="Description" hint="optional — it opens the pull request's body, above where it says it came from">
            <textarea value={asked.description} rows={3} className={control} onChange={(event) => onChange({ ...asked, description: event.target.value })} />
          </Field>
          <Button type="submit" variant="primary" className="justify-self-start" disabled={because !== null || busy}>
            {busy ? "Opening…" : `Open pull request as ${by}`}
          </Button>
          {because !== null && changed.length > 0 ? <p className="text-sm text-muted">Not yet: {because}.</p> : null}
        </form>
        {outcome?.ok ? (
          <Notice tone="ok" className="text-sm">
            Opened <a href={outcome.url} target="_blank" rel="noreferrer">#{outcome.number}</a> from <code>{outcome.branch}</code>: the
            repository&apos;s CI checks it, and its branch protection governs the merge.
          </Notice>
        ) : outcome ? <Notice tone="bad" className="text-sm">Not opened: {outcome.because}.</Notice> : null}
      </Card>
    </Section>
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
    const opened = (got: Edited) => {
      if (!current) return;
      if (got.ok) setDrafts((now) => [...now, { path: open, original: got.text, text: got.text, crlf: got.crlf }]);
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
        files: changed.map(proposedFile),
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
    <ConfigEditorView base={base} into={into} as={as} drafts={drafts} shown={open} loading={loading} asked={asked} busy={busy}
                      outcome={outcome} onOpen={onOpen} onSubmit={() => void submit()}
                      onText={(path, text) => {
                        setDrafts((now) => now.map((draft) => (draft.path === path ? { ...draft, text } : draft)));
                        setOutcome(null);
                      }}
                      onDiscard={(path) => setDrafts((now) => now.map((draft) => (draft.path === path ? { ...draft, text: draft.original } : draft)))}
                      onChange={(next) => { setAsked(next); setOutcome(null); }} />
  );
}
