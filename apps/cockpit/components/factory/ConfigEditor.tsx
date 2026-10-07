"use client";

import { Dialog } from "@base-ui/react/dialog";
import { useAction } from "convex/react";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Proposed } from "@/convex/config";
import { asCommitted, branchFor, type Edited, proposalProblem, yamlProblem } from "@/convex/model/config";
import { branchHref } from "../format";
import { ForgeRef } from "../icons";
import { said } from "../said";
import { unified } from "./diff";
import { Button, control, cx, DiffBlock, Field, Notice } from "../ui";
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
 * Whether the draft of `path` holds changes not yet proposed. The editor
 * holds one file's changes at a time, so opening another file then would
 * discard them: it asks first.
 */
export function unsaved(drafts: Draft[], path: string | null): boolean {
  return drafts.some((draft) => draft.path === path && draft.text !== draft.original);
}

/** A file as the editor's list names it: its path under `asf/`. */
const named = (path: string) => path.replace(/^asf\//, "");

/**
 * The Config tab's editor (spec #40, #58, #157), the body of its dialog: the
 * factory's config files as a nav down the left — a picker on a phone — the
 * one open as plain text, the YAML check, a diff preview of what the pull
 * request will carry, and the pull request's title. Opening another file
 * while the open one has changes asks before discarding them. Pure, so a
 * test renders it.
 */
export function ConfigEditorView({
  forge, repo, base, into, as, files, drafts, shown, loading, asking, asked, busy, outcome,
  onText, onOpen, onAnswer, onDiscard, onChange, onSubmit,
}: {
  /** The forge's web origin and the factory's repository on it, which the branches are linked on. */
  forge: string;
  repo: string;
  /** The commit the files were read at, which the change is committed on top of. */
  base: string;
  /** The default branch the pull request asks to merge into. */
  into: string;
  /** Whose name the pull request goes up under: the viewer's login. */
  as: string;
  /** Every file the cockpit edits (`editable`), as the forge listed them at `base`. */
  files: string[];
  drafts: Draft[];
  /** The path of the draft shown in the editor. */
  shown: string | null;
  /** A file being read from the forge, or one that could not be, and why. */
  loading: { path: string; because: string | null } | null;
  /** The file asked to be opened while the one shown has changes: whether to discard them is being asked. */
  asking: string | null;
  asked: Asked;
  busy: boolean;
  outcome: Proposed | null;
  onText: (path: string, text: string) => void;
  /** Open `path`: the caller asks first when that would discard changes (`unsaved`). */
  onOpen: (path: string) => void;
  /** The answer to `asking`: discard the changes and open it, or keep editing. */
  onAnswer: (discard: boolean) => void;
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
    <div className="flex min-h-0 grow flex-col md:flex-row">
      <nav aria-label="Files" className="hidden shrink-0 overflow-y-auto border-r border-line p-2 md:block md:w-64">
        <ul className="grid gap-0.5">
          {files.map((path) => (
            <li key={path}>
              <button type="button" aria-current={path === shown ? "true" : undefined} onClick={() => onOpen(path)}
                      className={cx("flex w-full items-baseline gap-1.5 rounded-md px-2.5 py-1.5 text-left text-sm break-all",
                                    path === shown ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg")}>
                <code>{named(path)}</code>{unsaved(drafts, path) ? <><span aria-hidden="true" className="text-accent">•</span><span className="sr-only">changed</span></> : null}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="min-w-0 grow overflow-y-auto p-4 sm:p-5">
        <Field label="File" className="mb-4 md:hidden">
          <select value={shown ?? ""} className={cx(control, "w-full min-w-0")} onChange={(event) => onOpen(event.target.value)}>
            {files.map((path) => <option key={path} value={path}>{named(path)}{unsaved(drafts, path) ? " •" : ""}</option>)}
          </select>
        </Field>
        <p className="text-sm text-muted">
          The files as <ForgeRef kind="branch" href={branchHref(forge, repo, into)}>{into}</ForgeRef> at <code>{short(base)}</code> held them. What is typed here is committed exactly — comments
          and all — as {by}, on <code className="break-all">{branchFor(as || "you", asked.title)}</code>, and proposed to <code>{into}</code> as a
          pull request. The cockpit checks only that the YAML parses: the repository&apos;s CI and its branch protection decide the rest.
        </p>
        {asking !== null && current !== null ? (
          <Notice role="alertdialog" aria-label="Discard the changes?" className="text-sm">
            <p className="break-words">
              <code>{current.path}</code> has changes that are not proposed. Discard them and open <code>{asking}</code>?
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="danger" size="sm" onClick={() => onAnswer(true)}>Discard and open</Button>
              <Button size="sm" onClick={() => onAnswer(false)}>Keep editing</Button>
            </div>
          </Notice>
        ) : null}
        {loading !== null ? (
          loading.because === null ? <p className="mt-3 text-sm text-muted">Reading <code>{loading.path}</code> from the forge…</p>
            : <Notice className="text-sm">Cannot edit <code>{loading.path}</code>: {loading.because}.</Notice>
        ) : null}
        {current !== null ? (
          <div className="mt-4 grid gap-2">
            <Field label={<code className="break-all">{current.path}</code>}>
              <textarea spellCheck={false} value={current.text} rows={Math.min(40, current.text.split("\n").length + 2)}
                        className={cx(control, "w-full min-w-0 overflow-x-auto font-mono text-sm [overflow-wrap:normal] [tab-size:2] whitespace-pre")}
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
            <input value={asked.title} placeholder="config: raise the per-session budget" className={cx(control, "min-w-0")}
                   onChange={(event) => onChange({ ...asked, title: event.target.value })} />
          </Field>
          <Field label="Description" hint="optional — it opens the pull request's body, above where it says it came from">
            <textarea value={asked.description} rows={3} className={cx(control, "min-w-0")} onChange={(event) => onChange({ ...asked, description: event.target.value })} />
          </Field>
          <Button type="submit" variant="primary" className="justify-self-start" disabled={because !== null || busy}>
            {busy ? "Opening…" : `Open pull request as ${by}`}
          </Button>
          {because !== null && changed.length > 0 ? <p className="text-sm text-muted">Not yet: {because}.</p> : null}
        </form>
        {outcome?.ok ? (
          <Notice tone="ok" className="text-sm">
            Opened <ForgeRef kind="pr" href={outcome.url} newTab>#{outcome.number}</ForgeRef> from <ForgeRef kind="branch" href={branchHref(forge, repo, outcome.branch)}>{outcome.branch}</ForgeRef>: the
            repository&apos;s CI checks it, and its branch protection governs the merge.
          </Notice>
        ) : outcome ? <Notice tone="bad" className="text-sm">Not opened: {outcome.because}.</Notice> : null}
      </div>
    </div>
  );
}

/**
 * The editor for one factory, as a dialog: large on a desktop, the whole
 * screen on a phone. Each file is read from the forge at `base` when first
 * opened, and kept as a draft until the pull request is opened or the change
 * discarded. It lives as long as the page does, so closing the dialog loses
 * nothing: opened again, it is where it was left.
 */
export function ConfigEditor({ forge, factory, base, into, as, files, file, signIn, open, onFile, onClose }: {
  /** The forge's web origin, e.g. https://github.com. */
  forge: string;
  factory: string;
  base: string;
  into: string;
  as: string;
  /** Every file the cockpit edits, as the factory's look listed them. */
  files: string[];
  /** The file open in the editor. */
  file: string;
  signIn: string | undefined;
  /** Whether the dialog is open. */
  open: boolean;
  onFile: (path: string) => void;
  onClose: () => void;
}) {
  const read = useAction(api.config.read);
  const propose = useAction(api.config.propose);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [failed, setFailed] = useState<{ path: string; because: string } | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [asked, setAsked] = useState<Asked>({ title: "", description: "" });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Proposed | null>(null);
  const held = drafts.some((draft) => draft.path === file);

  useEffect(() => {
    if (held) return;
    let current = true;
    const opened = (got: Edited) => {
      if (!current) return;
      if (got.ok) setDrafts((now) => [...now, { path: file, original: got.text, text: got.text, crlf: got.crlf }]);
      else setFailed({ path: file, because: got.because });
    };
    read({ factory, path: file, ref: base, signIn }).then(opened, (error: unknown) => opened({ ok: false, because: said(error) }));
    return () => { current = false; };
  }, [read, factory, file, base, signIn, held]);

  const discard = (path: string) => setDrafts((now) => now.map((draft) => (draft.path === path ? { ...draft, text: draft.original } : draft)));
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
  const loading = held ? null : failed?.path === file ? failed : { path: file, because: null };
  return (
    <Dialog.Root open={open} onOpenChange={(opened) => { if (!opened) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className={cx(
          "fixed inset-0 z-40 bg-black/25 transition-opacity dark:bg-black/60",
          "data-ending-style:opacity-0 data-starting-style:opacity-0",
        )} />
        <Dialog.Popup className={cx(
          "fixed inset-0 z-50 flex flex-col bg-surface transition-[scale,opacity] duration-150",
          "md:inset-auto md:top-[5dvh] md:left-1/2 md:h-[90dvh] md:w-[min(1100px,calc(100vw-2rem))] md:-translate-x-1/2",
          "md:rounded-xl md:border md:border-line md:shadow-pop",
          "data-ending-style:opacity-0 data-starting-style:opacity-0 md:data-ending-style:scale-95 md:data-starting-style:scale-95",
        )}>
          <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3 sm:px-5">
            <Dialog.Title className="grow text-lg font-semibold">Edit config</Dialog.Title>
            <Dialog.Close aria-label="Close"
                          className="-mr-1 grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg">
              <X size={16} aria-hidden="true" />
            </Dialog.Close>
          </div>
          <ConfigEditorView forge={forge} repo={factory} base={base} into={into} as={as} files={files} drafts={drafts} shown={file}
                            loading={loading} asking={asking} asked={asked} busy={busy} outcome={outcome} onSubmit={() => void submit()}
                            onOpen={(path) => {
                              if (path === file) return;
                              if (unsaved(drafts, file)) setAsking(path);
                              else { setAsking(null); onFile(path); }
                            }}
                            onAnswer={(discarding) => {
                              if (discarding && asking !== null) { discard(file); onFile(asking); }
                              setAsking(null);
                            }}
                            onText={(path, text) => {
                              setDrafts((now) => now.map((draft) => (draft.path === path ? { ...draft, text } : draft)));
                              setOutcome(null);
                            }}
                            onDiscard={discard}
                            onChange={(next) => { setAsked(next); setOutcome(null); }} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
