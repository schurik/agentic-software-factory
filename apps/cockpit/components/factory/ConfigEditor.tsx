"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import { Form } from "@base-ui/react/form";
import { Popover } from "@base-ui/react/popover";
import { Tabs } from "@base-ui/react/tabs";
import { useAction } from "convex/react";
import { Info, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Proposed } from "@/convex/config";
import { asCommitted, branchFor, type Edited, proposalProblem, yamlProblem } from "@/convex/model/config";
import { branchHref } from "../format";
import { ForgeRef } from "../icons";
import { said } from "../said";
import { unified } from "./diff";
import { Button, buttonClass, control, cx, DiffBlock, menuPopup, Notice, Select } from "../ui";
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

/** Whether the draft of `path` holds changes not yet proposed. */
export function unsaved(drafts: Draft[], path: string | null): boolean {
  return drafts.some((draft) => draft.path === path && draft.text !== draft.original);
}

/**
 * What asking to open `path` while `shown` is open does: nothing, when it is
 * the one open; open it, when nothing would be lost; or ask first — the
 * editor holds one file's changes at a time, so opening another discards them.
 */
export function opening(drafts: Draft[], shown: string | null, path: string): "stay" | "open" | "ask" {
  if (path === shown) return "stay";
  return unsaved(drafts, shown) ? "ask" : "open";
}

/** A file as the editor's list names it: its path under `asf/`, and a dot when it has changes. */
const named = (path: string, drafts: Draft[]) => `${path.replace(/^asf\//, "")}${unsaved(drafts, path) ? " •" : ""}`;

/** Where the files come from, and what proposing them does: behind the editor's info button. */
export function ConfigAbout({ forge, repo, base, into, as, title }: {
  forge: string;
  repo: string;
  base: string;
  into: string;
  as: string;
  /** The pull request's title so far, which its branch is named for. */
  title: string;
}) {
  const who = useWho();
  return (
    <p>
      The files as <ForgeRef kind="branch" href={branchHref(forge, repo, into)}>{into}</ForgeRef> at <code>{short(base)}</code> held them. What is typed here is committed exactly — comments
      and all — as {as ? who(as) : "you"}, on <code className="break-all">{branchFor(as || "you", title)}</code>, and proposed to <code>{into}</code> as a
      pull request. The cockpit checks only that the YAML parses: the repository&apos;s CI and its branch protection decide the rest.
    </p>
  );
}

/** What the editor asks before opening `to` discards the changes to `from`. */
export function DiscardQuestion({ from, to }: { from: string; to: string }) {
  return <><code>{from}</code> has changes that are not proposed. Opening <code>{to}</code> discards them.</>;
}

/**
 * The Config tab's editor (spec #40, #58, #157), the body of its dialog: the
 * factory's config files as a nav down the left — a picker on a phone — and
 * the one open as plain text filling the rest, with the YAML check; beside
 * it, the diff the pull request will carry; and along the bottom, always in
 * view, the pull request's title, description and submit. Opening another
 * file while the open one has changes asks before discarding them. Pure, so
 * a test renders it — all but what it portals: the question it asks
 * (`DiscardQuestion`).
 */
export function ConfigEditorView({
  forge, repo, into, as, files, drafts, shown, loading, switchingTo, asked, busy, outcome,
  onText, onOpen, onAnswer, onDiscard, onChange, onSubmit,
}: {
  /** The forge's web origin and the factory's repository on it, which the pull request is linked on. */
  forge: string;
  repo: string;
  /** The default branch the pull request asks to merge into. */
  into: string;
  /** Whose name the pull request goes up under: the viewer's login. */
  as: string;
  /** Every file the cockpit edits (`editable`), as the forge listed them. */
  files: string[];
  drafts: Draft[];
  /** The path of the draft shown in the editor. */
  shown: string | null;
  /** A file being read from the forge, or one that could not be, and why. */
  loading: { path: string; because: string | null } | null;
  /** The file asked to be opened while the one shown has changes: whether to discard them is being asked. */
  switchingTo: string | null;
  asked: Asked;
  busy: boolean;
  outcome: Proposed | null;
  onText: (path: string, text: string) => void;
  /** Open `path`: the caller asks first when that would discard changes (`opening`). */
  onOpen: (path: string) => void;
  /** The answer to `switchingTo`: discard the changes and open it, or keep editing. */
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
  const tab = "relative -mb-px shrink-0 border-b-2 border-transparent px-2.5 py-2 text-sm font-medium whitespace-nowrap text-muted hover:text-fg data-active:border-accent data-active:text-fg";
  return (
    <>
      <div className="flex min-h-0 grow">
        <nav aria-label="Files" className="hidden w-64 shrink-0 overflow-y-auto border-r border-line p-2 md:block">
          <ul className="grid gap-0.5">
            {files.map((path) => (
              <li key={path}>
                <button type="button" aria-current={path === shown ? "true" : undefined} onClick={() => onOpen(path)}
                        className={cx("flex w-full items-baseline gap-1.5 rounded-md px-2.5 py-1.5 text-left text-sm break-all",
                                      path === shown ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg")}>
                  <code>{path.replace(/^asf\//, "")}</code>
                  {unsaved(drafts, path) ? <><span aria-hidden="true" className="text-accent">•</span><span className="sr-only">changed</span></> : null}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <Tabs.Root defaultValue="edit" className="flex min-w-0 grow flex-col">
          <div className="shrink-0 px-4 pt-3 sm:px-5 md:hidden">
            <Select label="File" items={files} value={shown ?? ""} labelOf={(path) => named(path, drafts)} onChange={onOpen} />
          </div>
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 sm:px-5">
            <Tabs.List aria-label="The file, or what the pull request changes" className="flex gap-1">
              <Tabs.Tab value="edit" className={tab}>Edit</Tabs.Tab>
              <Tabs.Tab value="diff" className={tab}>Changes{changed.length ? ` (${changed.length})` : ""}</Tabs.Tab>
            </Tabs.List>
            {current !== null && current.text !== current.original ? (
              <Button variant="ghost" size="sm" className="ml-auto" onClick={() => onDiscard(current.path)}>Discard these changes</Button>
            ) : null}
          </div>

          <Tabs.Panel value="edit" className="flex min-h-0 grow flex-col p-4 data-hidden:hidden sm:px-5">
            {loading !== null ? (
              loading.because === null ? <p className="text-sm text-muted">Reading <code>{loading.path}</code> from the forge…</p>
                : <Notice className="my-0 text-sm">Cannot edit <code>{loading.path}</code>: {loading.because}.</Notice>
            ) : null}
            {current !== null ? (
              <Field.Root name="text" invalid={problem !== null} className="flex min-h-0 grow flex-col gap-2">
                <Field.Label className="sr-only">{current.path}</Field.Label>
                <Field.Control value={current.text} onValueChange={(text) => onText(current.path, text)}
                               render={<textarea spellCheck={false} />}
                               className={cx(control, "min-h-48 w-full min-w-0 grow resize-none overflow-auto font-mono text-sm [overflow-wrap:normal] [tab-size:2] whitespace-pre data-invalid:border-bad")} />
                {problem ? (
                  <Field.Error match role="alert" className="shrink-0 text-sm text-bad">The YAML does not parse — {problem}</Field.Error>
                ) : null}
              </Field.Root>
            ) : null}
          </Tabs.Panel>
          <Tabs.Panel value="diff" keepMounted className="min-h-0 grow overflow-y-auto p-4 data-hidden:hidden sm:px-5">
            {changed.length === 0 ? <p className="text-sm text-muted">Nothing changed yet.</p> : (
              <div className="grid gap-2">
                {changed.map((draft) => <DiffBlock key={draft.path} text={unified(draft.path, draft.original, draft.text)} />)}
              </div>
            )}
          </Tabs.Panel>
        </Tabs.Root>
      </div>

      <Form className="shrink-0 border-t border-line bg-surface px-4 py-3 sm:px-5"
            onFormSubmit={() => { if (because === null && !busy) onSubmit(); }}>
        {outcome?.ok ? (
          <Notice tone="ok" className="mt-0 text-sm">
            Opened <ForgeRef kind="pr" href={outcome.url} newTab>#{outcome.number}</ForgeRef> from <ForgeRef kind="branch" href={branchHref(forge, repo, outcome.branch)}>{outcome.branch}</ForgeRef>: the
            repository&apos;s CI checks it, and its branch protection governs the merge.
          </Notice>
        ) : outcome ? <Notice tone="bad" className="mt-0 text-sm">Not opened: {outcome.because}.</Notice> : null}
        <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] md:items-end">
          <Field.Root name="title" className="grid min-w-0 gap-1">
            <Field.Label className="text-sm font-medium">Title</Field.Label>
            <Field.Control value={asked.title} placeholder="config: raise the per-session budget" className={cx(control, "h-9 min-w-0")}
                           onValueChange={(title) => onChange({ ...asked, title })} />
          </Field.Root>
          <Field.Root name="description" className="grid min-w-0 gap-1">
            <Field.Label className="text-sm font-medium">Description <span className="font-normal text-muted">— optional</span></Field.Label>
            <Field.Control value={asked.description} render={<textarea rows={1} />}
                           placeholder="The pull request's body, above where it came from"
                           className={cx(control, "min-h-9 min-w-0 resize-y")}
                           onValueChange={(description) => onChange({ ...asked, description })} />
          </Field.Root>
          <Button type="submit" variant="primary" disabled={because !== null || busy}>
            {busy ? "Opening…" : `Open pull request as ${by}`}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted">
          On <code className="break-all">{branchFor(as || "you", asked.title)}</code> into <code>{into}</code>
          {because !== null && changed.length > 0 ? <> · not yet: {because}</> : null}
        </p>
      </Form>

      <AlertDialog.Root open={switchingTo !== null && current !== null} onOpenChange={(opened) => { if (!opened) onAnswer(false); }}>
        <AlertDialog.Portal>
          <AlertDialog.Backdrop forceRender className="fixed inset-0 z-[60] bg-black/25 dark:bg-black/60" />
          <AlertDialog.Popup className="fixed top-[20dvh] left-1/2 z-[70] w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-line bg-surface p-5 shadow-pop">
            <AlertDialog.Title className="text-lg font-semibold">Discard your changes?</AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm break-words">
              {current !== null && switchingTo !== null ? <DiscardQuestion from={current.path} to={switchingTo} /> : null}
            </AlertDialog.Description>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <AlertDialog.Close className={buttonClass("secondary", "sm")}>Keep editing</AlertDialog.Close>
              <Button variant="danger" size="sm" onClick={() => onAnswer(true)}>Discard and open</Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
}

/**
 * The editor for one factory, as a dialog that covers the screen. Each file
 * is read from the forge at `base` when first opened, and kept as a draft
 * until the pull request is opened or the change discarded. It lives as long
 * as the page does, so closing the dialog loses nothing: opened again, it is
 * where it was left.
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
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
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

  const retype = (path: string, text: (draft: Draft) => string) =>
    setDrafts((now) => now.map((draft) => (draft.path === path ? { ...draft, text: text(draft) } : draft)));
  const discard = (path: string) => retype(path, (draft) => draft.original);
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
  const icon = "grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg data-popup-open:bg-surface-2";
  return (
    <Dialog.Root open={open} onOpenChange={(opened) => { if (!opened) { setSwitchingTo(null); onClose(); } }}>
      <Dialog.Portal>
        <Dialog.Popup className={cx(
          "fixed inset-0 z-50 flex flex-col bg-surface transition-opacity duration-150",
          "data-ending-style:opacity-0 data-starting-style:opacity-0",
        )}>
          <div className="flex shrink-0 items-center gap-1 border-b border-line px-4 py-2.5 sm:px-5">
            <Dialog.Title className="mr-1 text-lg font-semibold">Edit config</Dialog.Title>
            <Popover.Root>
              <Popover.Trigger aria-label="About editing the config" className={icon}>
                <Info size={16} aria-hidden="true" />
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Positioner sideOffset={6} align="start" className="z-[60]">
                  <Popover.Popup className={cx(menuPopup, "w-[min(28rem,calc(100vw-2rem))] p-3 text-sm")}>
                    <ConfigAbout forge={forge} repo={factory} base={base} into={into} as={as} title={asked.title} />
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>
            <Dialog.Close aria-label="Close" className={cx(icon, "-mr-1 ml-auto")}>
              <X size={16} aria-hidden="true" />
            </Dialog.Close>
          </div>
          <ConfigEditorView forge={forge} repo={factory} into={into} as={as} files={files} drafts={drafts} shown={file}
                            loading={loading} switchingTo={switchingTo} asked={asked} busy={busy} outcome={outcome} onSubmit={() => void submit()}
                            onOpen={(path) => {
                              const next = opening(drafts, file, path);
                              if (next === "ask") setSwitchingTo(path);
                              else if (next === "open") { setSwitchingTo(null); onFile(path); }
                            }}
                            onAnswer={(discarding) => {
                              if (discarding && switchingTo !== null) { discard(file); onFile(switchingTo); }
                              setSwitchingTo(null);
                            }}
                            onText={(path, text) => { retype(path, () => text); setOutcome(null); }}
                            onDiscard={discard}
                            onChange={(next) => { setAsked(next); setOutcome(null); }} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
