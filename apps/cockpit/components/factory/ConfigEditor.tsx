"use client";

import { Collapsible } from "@base-ui/react/collapsible";
import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import { Form } from "@base-ui/react/form";
import { Popover } from "@base-ui/react/popover";
import { useAction } from "convex/react";
import { ChevronRight, File, FileCode, FileText, Folder, FolderOpen, Info, X } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Proposed } from "@/convex/config";
import { asCommitted, branchFor, type Edited, proposalProblem, yamlProblem } from "@/convex/model/config";
import { branchHref } from "../format";
import { ForgeRef } from "../icons";
import { said } from "../said";
import { unified } from "./diff";
import { highlight, type Kind } from "./highlight";
import { type TreeNode, treeOf } from "./tree";
import { DiffView } from "../diff/DiffView";
import { Button, control, cx, menuPopup, Notice, Select, TabPanel, Tabs } from "../ui";
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
 * The files the editor shows a tab for, after Changes: each with changes, in
 * the order they were opened, and the one open — a file opened and left
 * unchanged gives its tab up to the next one opened.
 */
export function tabbed(drafts: Draft[], shown: string | null): string[] {
  const paths = drafts.filter((draft) => draft.path === shown || draft.text !== draft.original).map((draft) => draft.path);
  return shown === null || paths.includes(shown) ? paths : [...paths, shown];
}

/** A file as the editor names it: its path under `asf/`. */
const named = (path: string) => path.replace(/^asf\//, "");

/** The small blue dot on a file with changes, which a screen reader reads as "changed". */
function Dot({ className }: { className?: string }) {
  return <><span aria-hidden="true" className={cx(className, "size-1.5 shrink-0 rounded-full bg-accent")} /><span className="sr-only">changed</span></>;
}

/** How far a row of the tree is indented: a level is twelve pixels. */
const indent = (depth: number) => 8 + depth * 12;

/** A file's icon, by what it is written in. */
function FileIcon({ path }: { path: string }) {
  const Icon = /\.(md|txt)$/i.test(path) ? FileText : /\.(ya?ml|json|toml)$/i.test(path) ? FileCode : File;
  return <Icon size={14} aria-hidden="true" className="shrink-0 text-faint" />;
}

/**
 * The files as a tree, grouped by folder as a file explorer shows them
 * (`treeOf`): each folder collapsible, every one open to begin with; the
 * file open marked, and a blue dot on each file with changes and on every
 * folder it is in, so a collapsed folder still says it holds one.
 */
function FileTree({ nodes, depth, drafts, shown, onOpen }: {
  nodes: TreeNode[];
  depth: number;
  drafts: Draft[];
  shown: string | null;
  onOpen: (path: string) => void;
}) {
  const rowClass = "flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm";
  return (
    <ul className="grid gap-px">
      {nodes.map((node) => (
        <li key={node.path}>
          {node.kind === "folder" ? (
            <Collapsible.Root defaultOpen>
              <Collapsible.Trigger data-folder={node.path} title={node.path} style={{ paddingLeft: indent(depth) }}
                                   className={cx(rowClass, "group text-muted hover:bg-surface-3 hover:text-fg")}>
                <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-faint transition-transform duration-150 group-data-panel-open:rotate-90" />
                <Folder size={14} aria-hidden="true" className="shrink-0 group-data-panel-open:hidden" />
                <FolderOpen size={14} aria-hidden="true" className="hidden shrink-0 group-data-panel-open:block" />
                <span className="truncate">{node.name}</span>
                {drafts.some((draft) => draft.path.startsWith(`${node.path}/`) && draft.text !== draft.original) ? <Dot className="ml-auto" /> : null}
              </Collapsible.Trigger>
              <Collapsible.Panel>
                <FileTree nodes={node.children} depth={depth + 1} drafts={drafts} shown={shown} onOpen={onOpen} />
              </Collapsible.Panel>
            </Collapsible.Root>
          ) : (
            // A file's icon sits under its folder's, past the chevron's width and the gap after it.
            <button type="button" data-file={node.path} title={node.path} aria-current={node.path === shown ? "true" : undefined}
                    onClick={() => onOpen(node.path)} style={{ paddingLeft: indent(depth) + 20 }}
                    className={cx(rowClass, node.path === shown ? "bg-surface text-fg shadow-card" : "text-muted hover:bg-surface-3 hover:text-fg")}>
              <FileIcon path={node.path} />
              <span className="truncate">{node.name}</span>
              {unsaved(drafts, node.path) ? <Dot className="ml-auto" /> : null}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

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

/** How wide the file list may be, in pixels, and how wide it starts. */
const NAV = { start: 256, min: 160, max: 560 } as const;
/** Where this browser remembers the width the person gave the file list. */
const NAV_KEY = "asf.cockpit.configEditor.nav";

/** The file list's width, as this browser last left it: storage may be blocked, so a read or write may fail, and then it is not remembered. */
function useNavWidth(): [number, (width: number) => void] {
  const [width, setWidth] = useState<number>(() => {
    try {
      const stored = Number(window.localStorage.getItem(NAV_KEY));
      return stored >= NAV.min && stored <= NAV.max ? stored : NAV.start;
    } catch {
      return NAV.start;
    }
  });
  const resize = (next: number) => {
    const clamped = Math.round(Math.min(NAV.max, Math.max(NAV.min, next)));
    setWidth(clamped);
    try { window.localStorage.setItem(NAV_KEY, String(clamped)); } catch { /* not remembered */ }
  };
  return [width, resize];
}

/**
 * The line between the file list and the editor, which widens the list: dragged, or with the arrow
 * keys once focused; a double click puts it back.
 */
function Splitter({ width, onResize }: { width: number; onResize: (width: number) => void }) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const keys: Record<string, number> = { ArrowLeft: -16, ArrowRight: 16, Home: NAV.min - width, End: NAV.max - width };
  return (
    <div role="separator" aria-orientation="vertical" aria-label="Resize the file list" aria-valuenow={width}
         aria-valuemin={NAV.min} aria-valuemax={NAV.max} tabIndex={0}
         className="relative z-10 hidden w-px shrink-0 cursor-col-resize touch-none bg-line outline-none select-none hover:bg-accent focus-visible:bg-accent md:block"
         onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
           event.preventDefault();
           event.currentTarget.setPointerCapture(event.pointerId);
           drag.current = { x: event.clientX, width };
         }}
         onPointerMove={(event) => { if (drag.current) onResize(drag.current.width + event.clientX - drag.current.x); }}
         onPointerUp={() => { drag.current = null; }}
         onPointerCancel={() => { drag.current = null; }}
         onDoubleClick={() => onResize(NAV.start)}
         onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
           if (!(event.key in keys)) return;
           event.preventDefault();
           onResize(width + keys[event.key]);
         }}>
      {/* What the pointer can catch is wider than the line it draws. */}
      <span aria-hidden="true" className="absolute inset-y-0 -right-1.5 -left-1.5" />
    </div>
  );
}

/** The colour each kind of span is drawn in: the cockpit's text tokens, each AA on a surface. */
const INK: Record<Exclude<Kind, null>, string> = {
  key: "text-accent", string: "text-ok", literal: "text-wait", comment: "text-muted", punct: "text-faint",
  meta: "text-merged", heading: "text-accent", code: "text-merged",
};

/**
 * The file being edited: a textarea, its text transparent and its caret not,
 * over the same text highlighted (`highlight`) — the same font, the same
 * padding, no wrapping, moved as the textarea scrolls — so what is typed is
 * still a textarea's, byte for byte, and only what is drawn is coloured.
 */
function Editor({ path, text, onText }: { path: string; text: string; onText: (text: string) => void }) {
  const under = useRef<HTMLElement>(null);
  const spans = useMemo(() => highlight(path, text), [path, text]);
  const page = "px-4 py-3 font-mono text-sm [overflow-wrap:normal] [tab-size:2] whitespace-pre sm:px-5";
  return (
    <div className="relative min-h-48 grow overflow-hidden bg-surface">
      <pre aria-hidden="true" className="pointer-events-none absolute inset-0 m-0 overflow-hidden">
        <code ref={under} className={cx("block text-fg", page)}>
          {spans.map((span, at) => (span.kind ? <span key={at} className={INK[span.kind]}>{span.text}</span> : span.text))}
        </code>
      </pre>
      <Field.Control value={text} onValueChange={onText} render={<textarea spellCheck={false} />}
                     onScroll={(event) => {
                       const { scrollLeft, scrollTop } = event.currentTarget;
                       if (under.current) under.current.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
                     }}
                     className={cx("scrollbar-rest absolute inset-0 resize-none overflow-auto bg-transparent text-transparent caret-fg outline-none selection:bg-accent-soft", page)} />
    </div>
  );
}

/**
 * The Config tab's editor (spec #40, #58, #157), the body of its dialog: the
 * factory's config files as a tree down the left, grouped by folder — a
 * picker on a phone — a blue dot on each with changes; beside it, Changes, the diff of every
 * changed file the pull request will carry — drawn as the cockpit draws
 * every diff (`DiffView`), each file collapsible, unified or split — then a tab for each file edited,
 * the one open as highlighted text filling the rest, with the YAML check; and
 * under it, always in view, the pull request's title, description and
 * submit. Pure, so a test renders it.
 */
export function ConfigEditorView({
  forge, repo, into, as, files, drafts, shown, showing, loading, asked, busy, outcome,
  onText, onOpen, onShow, onDiscard, onChange, onSubmit,
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
  /** The path of the file open in the editor. */
  shown: string | null;
  /** Whether Changes is the tab in front, or the file open. */
  showing: "changes" | "file";
  /** A file being read from the forge, or one that could not be, and why. */
  loading: { path: string; because: string | null } | null;
  asked: Asked;
  busy: boolean;
  outcome: Proposed | null;
  onText: (path: string, text: string) => void;
  /** Open `path` in the editor, in front. */
  onOpen: (path: string) => void;
  /** Bring Changes to the front. */
  onShow: () => void;
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
  const [navWidth, setNavWidth] = useNavWidth();
  const tree = useMemo(() => treeOf(files), [files]);
  const front = showing === "changes" || shown === null ? "changes" : shown;
  return (
    <div className="flex min-h-0 grow">
      <nav aria-label="Files" style={{ width: navWidth }} className="scrollbar-rest hidden shrink-0 overflow-y-auto bg-bg p-2 md:block">
        <FileTree nodes={tree} depth={0} drafts={drafts} shown={shown} onOpen={onOpen} />
      </nav>
      <Splitter width={navWidth} onResize={setNavWidth} />

      <div className="flex min-w-0 grow flex-col">
        <div className="shrink-0 bg-bg px-4 pt-3 sm:px-5 md:hidden">
          <Select label="File" items={files} value={shown ?? ""} labelOf={(path) => `${named(path)}${unsaved(drafts, path) ? " •" : ""}`}
                  onChange={onOpen} />
        </div>
        <Tabs label="What the pull request changes, and the files being edited" selected={front}
              onSelect={(value) => (value === "changes" ? onShow() : onOpen(value))}
              tabs={[
                { id: "changes", label: `Changes${changed.length ? ` (${changed.length})` : ""}` },
                ...tabbed(drafts, shown).map((path) => ({
                  id: path,
                  label: <span className="inline-flex items-center gap-1.5"><code>{named(path)}</code>{unsaved(drafts, path) ? <Dot /> : null}</span>,
                })),
              ]}
              end={front !== "changes" && current !== null && current.text !== current.original ? (
                <Button variant="ghost" size="sm" onClick={() => onDiscard(current.path)}>Discard these changes</Button>
              ) : null}
              className="flex min-h-0 grow flex-col" barClassName="shrink-0 bg-bg px-4 sm:px-5">
          <TabPanel value="changes" keepMounted className="scrollbar-rest min-h-0 grow overflow-y-auto bg-surface p-4 data-hidden:hidden sm:px-5">
            {changed.length === 0 ? <p className="text-sm text-muted">Nothing changed yet.</p>
              : <DiffView text={changed.map((draft) => unified(draft.path, draft.original, draft.text)).join("")} />}
          </TabPanel>
          {shown !== null ? (
            <TabPanel value={shown} className="flex min-h-0 grow flex-col bg-surface data-hidden:hidden">
              {loading !== null ? (
                <div className="p-4 sm:px-5">
                  {loading.because === null ? <p className="text-sm text-muted">Reading <code>{loading.path}</code> from the forge…</p>
                    : <Notice className="text-sm">Cannot edit <code>{loading.path}</code>: {loading.because}.</Notice>}
                </div>
              ) : null}
              {current !== null ? (
                <Field.Root name="text" invalid={problem !== null} className="flex min-h-0 grow flex-col">
                  <Field.Label className="sr-only">{current.path}</Field.Label>
                  {/* The page itself, edge to edge: no box around it, so the file has every pixel the dialog can give. */}
                  <Editor key={current.path} path={current.path} text={current.text} onText={(text) => onText(current.path, text)} />
                  {problem ? (
                    <Field.Error match role="alert" className="shrink-0 border-t border-line bg-bad-soft px-4 py-2 text-sm text-bad sm:px-5">
                      The YAML does not parse — {problem}
                    </Field.Error>
                  ) : null}
                </Field.Root>
              ) : null}
            </TabPanel>
          ) : null}
        </Tabs>

        <Form className="grid shrink-0 gap-3 border-t border-line bg-bg px-4 py-3 sm:px-5"
              onFormSubmit={() => { if (because === null && !busy) onSubmit(); }}>
          {outcome?.ok ? (
            <Notice tone="ok" className="text-sm">
              Opened <ForgeRef kind="pr" href={outcome.url} state="open" newTab>#{outcome.number}</ForgeRef> from <ForgeRef kind="branch" href={branchHref(forge, repo, outcome.branch)}>{outcome.branch}</ForgeRef>: the
              repository&apos;s CI checks it, and its branch protection governs the merge.
            </Notice>
          ) : outcome ? <Notice tone="bad" className="text-sm">Not opened: {outcome.because}.</Notice> : null}
          <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] lg:items-end">
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
      </div>
    </div>
  );
}

/**
 * The editor for one factory, as a dialog that covers the screen. Each file
 * is read from the forge at `base` when first opened, and kept as a draft
 * until the pull request is opened or the change discarded: every changed
 * file goes into the one pull request. It lives as long
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
  const [showing, setShowing] = useState<"changes" | "file">("file");
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
    <Dialog.Root open={open} onOpenChange={(opened) => { if (!opened) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Popup className={cx(
          "fixed inset-0 z-50 flex flex-col bg-bg transition-opacity duration-150",
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
                            showing={showing} loading={loading} asked={asked} busy={busy} outcome={outcome} onSubmit={() => void submit()}
                            onOpen={(path) => { setShowing("file"); onFile(path); }}
                            onShow={() => setShowing("changes")}
                            onText={(path, text) => { retype(path, () => text); setOutcome(null); }}
                            onDiscard={discard}
                            onChange={(next) => { setAsked(next); setOutcome(null); }} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
