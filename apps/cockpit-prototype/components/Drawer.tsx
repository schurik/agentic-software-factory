"use client";
// PROTOTYPE, throwaway. One right-hand drawer (a bottom sheet on a phone) for three things:
// answering a gate (from Now), a phase's detail (from the graph), a stage's phases.
// Every view is a Pane: a scrolling body, and — where there is something to do — a footer
// that stays put at the bottom, the way a dialog keeps its actions last.
import { Drawer } from "@base-ui/react/drawer";
import { ChevronDown, ChevronUp, MessageSquareQuote } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BRANCH_DIFF, GATES, NOW, OTHERS, SESSIONS, STAGE_ABOUT, type Gate, type Phase, type Session } from "@/lib/data";
import { fmtAgo, fmtClock, fmtCost, fmtDur, fmtInt, stageSecs, stageStatus } from "@/lib/model";
import { DiffView } from "./Diff";
import { BranchRef, CommitRef, IssueRef, StageIcon } from "./icons";
import { Md } from "./Md";
import { PLink, useProto, type DrawerTarget } from "./state";
import { Tabbed } from "./Tabs";
import { Button, Chevron, Kbd, KindIcon, Pill, StatusIcon, cx } from "./ui";

function useIsPhone() {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

export function findPhase(id: string): { session: Session; chapter: number; stage?: string; phase: Phase } | undefined {
  for (const session of SESSIONS) {
    for (const c of session.chapters) {
      if (c.start?.id === id) return { session, chapter: c.n, phase: c.start };
      if (c.end?.id === id) return { session, chapter: c.n, phase: c.end };
      for (const s of c.stages) {
        const phase = s.phases.find((p) => p.id === id);
        if (phase) return { session, chapter: c.n, stage: s.name, phase };
      }
    }
  }
}

const gateById = (id: string) => GATES.find((g) => g.id === id) ?? OTHERS.find((g) => g.id === id);

/** A view's body scrolls; its footer, if it has one, stays at the bottom. */
function Pane({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <>
      <div className="min-h-0 grow overflow-y-auto overscroll-contain px-5 py-5 md:px-6">{children}</div>
      {footer ? <div className="shrink-0 border-t border-line bg-surface px-5 pt-3 pb-4 md:px-6">{footer}</div> : null}
    </>
  );
}

export function SideDrawer() {
  const { drawer, close, back, open, answered } = useProto();
  const phone = useIsPhone();
  const top = drawer[drawer.length - 1];
  // Keep the last content while the drawer animates out.
  const [shown, setShown] = useState<DrawerTarget | undefined>(top);
  useEffect(() => { if (top) setShown(top); }, [top]);
  const t = top ?? shown;
  const gate = t?.type === "gate" ? gateById(t.gateId) : undefined;
  const queue = GATES.filter((g) => !answered[g.id] || g.id === gate?.id);
  const at = gate ? queue.findIndex((g) => g.id === gate.id) : -1;

  return (
    <Drawer.Root open={drawer.length > 0} onOpenChange={(o) => { if (!o) close(); }} swipeDirection={phone ? "down" : "right"}>
      <Drawer.Portal>
        <Drawer.Backdrop className="fixed inset-0 z-40 bg-black/20 transition-opacity duration-300 data-ending-style:opacity-0 data-starting-style:opacity-0 dark:bg-black/50" />
        <Drawer.Viewport className={cx("fixed inset-0 z-40 flex", phone ? "items-end" : "items-stretch justify-end")}>
          <Drawer.Popup
            className={cx(
              "flex flex-col bg-surface text-fg shadow-pop outline-none transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
              phone
                ? "h-[92dvh] w-full rounded-t-2xl border-t border-line [transform:translateY(var(--drawer-swipe-movement-y))] data-starting-style:[transform:translateY(100%)] data-ending-style:[transform:translateY(100%)]"
                : "h-full w-[min(720px,100vw)] border-l border-line [transform:translateX(var(--drawer-swipe-movement-x))] data-starting-style:[transform:translateX(100%)] data-ending-style:[transform:translateX(100%)]",
            )}
          >
            {phone ? <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line-strong" /> : null}
            {/* Same height and rule as the page header, so the two lines meet. */}
            <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4 md:px-5">
              {drawer.length > 1 ? (
                <Button variant="ghost" size="sm" onClick={back} className="-ml-2"><Chevron className="rotate-180" /> Back</Button>
              ) : null}
              {gate ? (
                <span className="flex items-center gap-2 text-sm font-medium">
                  <StageIcon name={gate.gate} size={16} className="text-wait" />
                  {gate.gate} gate <span className="font-normal text-muted">· round {gate.round}</span>
                </span>
              ) : (
                <span className="text-xs font-medium uppercase tracking-wider text-faint">{t?.type === "stage" ? "Stage" : "Phase"}</span>
              )}
              <span className="grow" />
              {gate && at >= 0 && queue.length > 1 ? (
                <span className="flex items-center gap-1 text-xs text-muted">
                  <button onClick={() => at > 0 && open({ type: "gate", gateId: queue[at - 1].id })} disabled={at === 0} className="grid size-7 place-items-center rounded-md hover:bg-surface-2 disabled:opacity-30 cursor-pointer" aria-label="Previous gate (k)"><ChevronUp size={16} /></button>
                  <button onClick={() => at < queue.length - 1 && open({ type: "gate", gateId: queue[at + 1].id })} disabled={at === queue.length - 1} className="grid size-7 place-items-center rounded-md hover:bg-surface-2 disabled:opacity-30 cursor-pointer" aria-label="Next gate (j)"><ChevronDown size={16} /></button>
                  <span className="tabular-nums">{at + 1} of {queue.length}</span>
                  <span className="mx-2 h-4 w-px bg-line" />
                </span>
              ) : null}
              <Drawer.Close className="grid size-8 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg cursor-pointer" aria-label="Close">
                <svg width="14" height="14" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              </Drawer.Close>
            </div>
            <Drawer.Content className="flex min-h-0 grow flex-col">
              {t?.type === "gate" ? <GateView gateId={t.gateId} /> : null}
              {t?.type === "phase" ? <PhaseView phaseId={t.phaseId} /> : null}
              {t?.type === "stage" ? <StageView session={t.session} chapter={t.chapter} stage={t.stage} /> : null}
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

// ── Gate ──────────────────────────────────────────────────────────────────────
//
// What is on screen depends on what the person is deciding (see GateKind in lib/data.ts):
//   plan, round 1   the plan · the issue in the reporter's words · what the scout found
//   plan, round 2+  what changed since the round they rejected, under their own note · the plan · …
//   integrate       the branch's diff · checks · the reviewer's verdict · the issue
// Agents' flags (⚑) sit above the tabs at every gate: a risk is decision material.
// Session, station and spend are not decision material; they are one click away, on the session.

const VERBS: Record<Gate["kind"], { approve: string; reject: string; note: string }> = {
  plan: { approve: "Approve plan", reject: "Reject", note: "Notes — required to reject: what should the plan change?" },
  integrate: { approve: "Open pull request", reject: "Send back", note: "Notes — required to send back: what should change before it lands?" },
};

function gateTabs(gate: Gate) {
  const tabs: { value: string; label: ReactNode; body: ReactNode }[] = [];
  const issue = gate.request ? { value: "issue", label: <>Issue {gate.ref}</>, body: <Md text={gate.request} /> } : null;
  if (gate.kind === "plan") {
    if (gate.previous) {
      tabs.push({
        value: "changes", label: <>Changes since round {gate.round - 1}</>,
        body: <DiffView files={[{ path: gate.subjectFile, before: gate.previous, after: gate.subjectBody }]} title={<>{gate.subjectFile}, round {gate.round - 1} → {gate.round}</>} />,
      });
    }
    tabs.push({ value: "plan", label: "Plan", body: <Md text={gate.subjectBody} /> });
    if (issue) tabs.push(issue);
    if (gate.findings) tabs.push({ value: "findings", label: "Scout's findings", body: <Md text={gate.findings} /> });
  } else {
    const files = BRANCH_DIFF[gate.session] ?? [];
    tabs.push({ value: "changes", label: <>Changes · {files.length} files</>, body: <DiffView files={files} title={<>{gate.branch} against main</>} /> });
    if (gate.checks) {
      tabs.push({
        value: "checks", label: "Checks",
        body: (
          <div className="flex flex-col divide-y divide-line rounded-lg border border-line text-sm">
            {gate.checks.map((c) => (
              <div key={c.name} className="flex items-center gap-3 px-3 py-2.5">
                <StatusIcon status={c.ok ? "ok" : "failed"} /><span className="font-medium">{c.name}</span><code className="min-w-0 truncate font-mono text-xs text-muted">{c.detail}</code>
              </div>
            ))}
          </div>
        ),
      });
    }
    if (gate.review) tabs.push({ value: "review", label: "Review", body: <Md text={gate.review} /> });
    if (issue) tabs.push(issue);
  }
  return tabs;
}

function GateView({ gateId }: { gateId: string }) {
  const { answered, answer, open, close } = useProto();
  const gate = gateById(gateId)!;
  const mine = GATES.includes(gate);
  const queue = GATES.filter((g) => !answered[g.id] || g.id === gateId);
  const at = queue.findIndex((g) => g.id === gateId);
  const [note, setNote] = useState("");
  const [needNote, setNeedNote] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const done = answered[gate.id];
  const verbs = VERBS[gate.kind];
  useEffect(() => { setNote(""); setNeedNote(false); }, [gateId]);

  const go = (d: number) => {
    const next = queue[at + d];
    if (next) open({ type: "gate", gateId: next.id });
  };
  const decide = (verdict: "approve" | "reject") => {
    if (verdict === "reject" && !note.trim()) { setNeedNote(true); noteRef.current?.focus(); return; }
    answer(gate.id, verdict, note.trim(), `${gate.factory}${gate.ref}`);
    const rest = GATES.filter((g) => !answered[g.id] && g.id !== gate.id);
    if (rest.length) open({ type: "gate", gateId: rest[0].id }); else close();
  };

  // j/k/a/r, as today — but not while typing a note.
  useEffect(() => {
    if (!mine || done) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("textarea, input")) return;
      if (e.key === "j") go(1);
      else if (e.key === "k") go(-1);
      else if (e.key === "a") decide("approve");
      else if (e.key === "r") decide("reject");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const lastNote = gate.earlier.at(-1);
  const footer = done ? (
    <p className="py-1 text-sm text-muted">Answered: <b className="text-fg">{done}</b>. The station picks it up from the comment on {gate.ref}.</p>
  ) : mine ? (
    <div className="flex flex-col gap-2.5">
      <textarea
        ref={noteRef}
        value={note}
        onChange={(e) => { setNote(e.target.value); setNeedNote(false); }}
        rows={2}
        placeholder={verbs.note}
        className={cx("w-full resize-none rounded-lg border bg-surface px-3 py-2 text-base outline-none placeholder:text-faint focus:border-accent focus:ring-4 focus:ring-accent-soft", needNote ? "border-bad" : "border-line-strong")}
      />
      {needNote ? <p className="-mt-1 text-sm text-bad">Say what should change — the next agent reads it as an instruction.</p> : null}
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" className="-ml-2 text-muted">Abort session</Button>
        <span className="grow" />
        <Button variant="secondary" onClick={() => decide("reject")}>{verbs.reject} <Kbd>r</Kbd></Button>
        <Button variant="primary" onClick={() => decide("approve")}>{verbs.approve} <Kbd>a</Kbd></Button>
      </div>
    </div>
  ) : (
    <p className="py-1 text-sm text-muted">Waiting on <b className="text-fg">{gate.askedOf}</b>. Only they can answer it here; anyone with write access can on the issue.</p>
  );

  return (
    <Pane footer={footer}>
      <div className="flex flex-col gap-5">
        <div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            <span>{gate.factory}</span>
            <IssueRef factory={gate.factory} n={Number(gate.ref.slice(1))} state="open" />
            <BranchRef factory={gate.factory} branch={gate.branch} />
            <PLink href={`/sessions/${gate.session}`} onClick={close} className="hover:text-fg">session <span className="font-mono">{gate.session}</span> →</PLink>
          </div>
          <Drawer.Title className="mt-2 text-xl font-semibold tracking-tight">{gate.question}</Drawer.Title>
          <p className="mt-0.5 text-base">{gate.title}</p>
          <p className="mt-1 text-sm text-muted">Waiting {fmtAgo(NOW - gate.since).replace(" ago", "")} · asked on the {gate.channel}</p>
        </div>

        {lastNote ? (
          <div className="flex gap-3 rounded-lg border border-wait/40 bg-wait-soft px-3.5 py-2.5">
            <MessageSquareQuote size={16} className="mt-0.5 shrink-0 text-wait" />
            <div className="text-sm">
              <div className="text-muted">Round {lastNote.round}: {lastNote.verdict === "reject" ? "rejected" : "approved"} by {lastNote.by === "schurik" ? "you" : lastNote.by}</div>
              <div className="text-base">“{lastNote.text}”</div>
              <div className="mt-0.5 text-xs text-muted">Check the changes below answer it.</div>
            </div>
          </div>
        ) : null}

        {gate.record.length ? (
          <ul className="flex flex-col gap-1 text-sm">
            {gate.record.map((r) => <li key={r} className="flex gap-2"><span className="text-wait">⚑</span><span>{r.replace(/^⚑ /, "")}</span></li>)}
          </ul>
        ) : null}

        <Tabbed key={gate.id} tabs={gateTabs(gate)} />
      </div>
    </Pane>
  );
}

// ── Phase ─────────────────────────────────────────────────────────────────────

function Row({ k, children }: { k: string; children: ReactNode }) {
  return <><dt className="text-muted">{k}</dt><dd className="min-w-0">{children}</dd></>;
}

function PhaseView({ phaseId }: { phaseId: string }) {
  const found = findPhase(phaseId);
  if (!found) return null;
  const { session, chapter, stage, phase: p } = found;
  const agent = p.kind === "agent";
  const tabs: { value: string; label: ReactNode; body: ReactNode }[] = [
    { value: "overview", label: "Overview", body: <PhaseOverview p={p} factory={session.factory} /> },
  ];
  if (p.artifacts?.length) tabs.push({ value: "artifacts", label: `Artifacts · ${p.artifacts.length}`, body: <Artifacts p={p} /> });
  if (p.diff?.length) tabs.push({ value: "diff", label: "Diff", body: <DiffView files={p.diff} /> });
  if (p.checks?.length || p.command) tabs.push({ value: "checks", label: "Checks", body: <Checks p={p} /> });
  if (agent) {
    tabs.push({ value: "tools", label: `Tools · ${p.tools?.length ?? 0}`, body: <Tools p={p} /> });
    tabs.push({ value: "transcript", label: <>Transcript{session.transcripts ? null : <span className="text-faint"> · off</span>}</>, body: <Transcript p={p} on={session.transcripts} /> });
    tabs.push({ value: "cost", label: "Cost", body: <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5 text-sm tabular-nums"><Row k="Model">{p.model}</Row><Row k="Tokens">{fmtInt(p.tokens ?? 0)}</Row><Row k="Cost">{fmtCost(p.cost ?? 0)}</Row><Row k="Corrections">{p.corrections ?? 0}</Row></dl> });
  }
  tabs.push({ value: "events", label: "Events", body: <Events p={p} /> });

  const waitingGate = p.status === "waiting" ? GATES.find((g) => g.session === session.id) : undefined;
  return (
    <Pane footer={waitingGate ? <AnswerLink gateId={waitingGate.id} /> : undefined}>
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-sm text-muted">
          {session.factory} · <span className="font-mono">{session.id}</span> · chapter {chapter}{stage ? <> · {stage} stage</> : <> · {p.name === "report" ? "end" : "start"}</>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Drawer.Title className="text-xl font-semibold tracking-tight">{p.gate ? `${p.gate.name} gate · round ${p.gate.round}` : p.name}</Drawer.Title>
          <Pill status={p.status}>{p.status === "ok" ? "done" : p.status}</Pill>
          {p.replayed ? <span className="rounded bg-surface-2 px-1.5 text-xs text-muted">replayed on resume</span> : null}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          <span className="flex items-center gap-1"><KindIcon kind={p.kind} />{p.kind === "agent" ? `agent · ${p.owner}` : p.kind === "gate" ? `person · ${p.owner}` : `code · ${p.owner}`}</span>
          <span className="tabular-nums">{fmtClock(p.at)}</span>
          {p.secs ? <span className="tabular-nums">{fmtDur(p.secs)}</span> : null}
          {p.cost ? <span className="tabular-nums">{fmtCost(p.cost)}</span> : null}
        </div>
      </div>
      <Tabbed key={p.id} tabs={tabs} />
    </div>
    </Pane>
  );
}

function AnswerLink({ gateId }: { gateId: string }) {
  const { open } = useProto();
  return (
    <div className="flex items-center gap-3">
      <span className="grow text-sm text-muted">This gate is waiting on you.</span>
      <Button variant="primary" onClick={() => open({ type: "gate", gateId })}>Answer it</Button>
    </div>
  );
}

function PhaseOverview({ p, factory }: { p: Phase; factory?: string }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{p.description}</p>
      {p.summary ? (
        <div>
          {p.outputType ? <div className="mb-1 font-mono text-xs text-faint">{p.outputType}</div> : null}
          <p className="text-lg">{p.summary}</p>
        </div>
      ) : p.status === "running" ? <p className="text-lg text-muted">Still running.</p> : null}
      {p.error ? <div className="rounded-lg border border-bad/40 bg-bad-soft px-3 py-2 text-sm text-bad">{p.error}</div> : null}
      {p.remark && p.kind === "gate" ? <Remark p={p} /> : null}
      {p.notes?.map((n) => (
        <div key={n.what} className="rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-sm">
          <div className="mb-0.5 text-xs font-semibold uppercase tracking-wider text-muted">⚑ {n.kind}</div>
          <div><b className="font-medium">{n.what}</b>{n.insteadOf ? <span className="text-muted"> — instead of {n.insteadOf}</span> : null}</div>
          <div className="text-muted">because {n.because}</div>
        </div>
      ))}
      {p.command ? (
        <div className="rounded-lg border border-line">
          <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 font-mono text-xs"><span className="text-faint">$</span>{p.command.argv}<span className="grow" />{p.command.exit >= 0 ? <span className={p.command.exit ? "text-bad" : "text-ok"}>exit {p.command.exit}</span> : <span className="text-accent">running</span>}</div>
          {p.command.tail ? <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed">{p.command.tail}</pre> : null}
        </div>
      ) : null}
      {p.commit?.sha && factory ? <div className="flex items-center gap-2 text-sm"><CommitRef factory={factory} sha={p.commit.sha} className="text-accent" /> {p.commit.message}</div> : null}
    </div>
  );
}

function Remark({ p }: { p: Phase }) {
  const r = p.remark!;
  return (
    <div className={cx("rounded-lg border px-3 py-2.5", r.verdict === "reject" ? "border-bad/40 bg-bad-soft" : "border-ok/30 bg-ok-soft")}>
      <div className="text-sm"><b>{r.verdict === "reject" ? "Rejected" : "Approved"}</b> by {r.by} · via the {r.channel}</div>
      {r.text ? <div className="mt-1 text-base">✎ “{r.text}”</div> : null}
      {r.text ? <div className="mt-1 text-xs text-muted">An instruction: the next agent reads it, and it wins over the plan.</div> : null}
    </div>
  );
}

function Artifacts({ p }: { p: Phase }) {
  return (
    <div className="flex flex-col gap-3">
      {p.artifacts!.map((a) => (
        <div key={a.path} className="rounded-lg border border-line">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-xs">
            <code className="font-mono text-sm">{a.path}</code>
            <span className="text-muted">{a.location === "repo" ? "in the repository" : a.role === "request" ? "handoff · the request" : "handoff"} · {a.size} B</span>
          </div>
          {a.preview ? <div className="px-4 py-3"><Md text={a.preview} /></div> : <p className="px-4 py-3 text-sm text-muted">No preview.</p>}
        </div>
      ))}
    </div>
  );
}

function Checks({ p }: { p: Phase }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      {p.checks?.map((c) => (
        <div key={c.gate} className="flex items-start gap-2">
          <StatusIcon status={c.passed ? "ok" : "failed"} className="mt-0.5" />
          <div><code className="font-mono">{c.gate}</code>{c.items.map((i) => <div key={i.item} className="text-muted">{i.item} — {i.note}</div>)}</div>
        </div>
      ))}
      {p.command ? <div className="flex items-center gap-2"><StatusIcon status={p.command.exit === 0 ? "ok" : p.command.exit < 0 ? "running" : "failed"} /><code className="font-mono">{p.command.argv}</code><span className="text-muted">{p.command.secs}s</span></div> : null}
    </div>
  );
}

function Tools({ p }: { p: Phase }) {
  if (!p.tools?.length) return <p className="text-sm text-muted">No tool calls.</p>;
  return (
    <div className="flex flex-col divide-y divide-line rounded-lg border border-line text-sm">
      {p.tools.map((t, i) => (
        <div key={i} className="flex items-center gap-2 px-3 py-1.5">
          <StatusIcon status={t.ok ? "ok" : "failed"} size={13} /><code className="font-mono">{t.tool}</code><span className="grow" /><span className="text-faint">0 ms</span>
        </div>
      ))}
    </div>
  );
}

function Transcript({ p, on }: { p: Phase; on: boolean }) {
  if (!on) {
    return (
      <div className="rounded-lg bg-surface-2 px-4 py-3 text-sm">
        <b>Transcripts are off for this factory.</b> No prompt and no tool call&apos;s arguments leave the machine; the cockpit only knows each tool&apos;s name, outcome and duration. <code className="font-mono">cockpit: {"{transcripts: true}"}</code> in <code className="font-mono">factory.yaml</code> turns them on.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="text-xs font-medium uppercase tracking-wider text-faint">Prompt · send 1</div>
      <pre className="max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{`# ${p.owner[0].toUpperCase()}${p.owner.slice(1)}\n\n## Purpose\n\n${p.description}.\n\n## This run so far\n\n1. issue · tracker · success\n2. scout · scout · success — the prompt is built in app.py …`}</pre>
      <div className="text-xs font-medium uppercase tracking-wider text-faint">Harness output</div>
      <pre className="max-h-48 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{`{"type": "tool_call", "tool": "${p.tools?.[0]?.tool ?? "read"}", "args": {"path": "app.py"}}\n{"type": "result", "text": "{\\"summary\\": \\"${p.summary ?? ""}\\"}"}`}</pre>
    </div>
  );
}

function Events({ p }: { p: Phase }) {
  const kinds = [
    "phase_started", ...(p.kind === "agent" ? ["prompt_rendered"] : []), ...(p.tools ?? []).map(() => "tool_called"),
    ...(p.kind === "agent" ? ["usage"] : []), ...(p.checks ?? []).map(() => "gate_result"),
    ...(p.outputType ? ["envelope_accepted"] : []), ...(p.artifacts ?? []).map(() => "artifact_written"),
    ...(p.commit?.sha ? ["committed"] : []), ...(p.command ? ["command_finished"] : []),
    ...(p.remark && p.kind === "gate" ? ["decision_recorded"] : []), ...(p.status === "running" || p.status === "waiting" ? [] : ["phase_ended", "journal_noted"]),
  ];
  return (
    <ol className="flex flex-col font-mono text-xs">
      {kinds.map((k, i) => (
        <li key={i} className="flex gap-3 border-b border-line py-1.5 last:border-0"><span className="w-6 text-right text-faint">{i + 1}</span>{k}</li>
      ))}
    </ol>
  );
}

// ── Stage ─────────────────────────────────────────────────────────────────────

function StageView({ session: sid, chapter: n, stage: i }: { session: string; chapter: number; stage: number }) {
  const { push } = useProto();
  const session = SESSIONS.find((s) => s.id === sid)!;
  const chapter = session.chapters.find((c) => c.n === n)!;
  const stage = chapter.stages[i];
  const st = stageStatus(stage);
  return (
    <Pane>
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-sm text-muted">{session.factory} · <span className="font-mono">{session.id}</span> · chapter {n} · {chapter.workflow} · stage {i + 1} of {chapter.stages.length}</div>
        <div className="mt-1 flex items-center gap-2">
          <StageIcon name={stage.name} size={20} className="text-muted" />
          <Drawer.Title className="text-xl font-semibold tracking-tight">{stage.name}</Drawer.Title>
          <Pill status={st}>{st === "ok" ? "done" : st === "pending" ? "not yet" : st}</Pill>
        </div>
        <p className="mt-2 text-sm text-muted">{STAGE_ABOUT[stage.name]}</p>
        {stage.gate ? <p className="mt-1 text-sm text-muted">Gate: {stage.gate}</p> : null}
      </div>
      {stage.phases.length ? (
        <div>
          <div className="mb-2 flex items-baseline gap-2 text-xs font-medium uppercase tracking-wider text-faint">
            {stage.phases.length} phase{stage.phases.length > 1 ? "s" : ""}<span className="grow" /><span className="normal-case tracking-normal tabular-nums">{fmtDur(stageSecs(stage))}</span>
          </div>
          <div className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {stage.phases.map((p) => (
              <button key={p.id} onClick={() => push({ type: "phase", session: sid, phaseId: p.id })} className="flex items-start gap-3 px-3 py-2.5 text-left hover:bg-surface-2 cursor-pointer">
                <StatusIcon status={p.status} className="mt-0.5" />
                <span className="min-w-0 grow">
                  <span className="flex items-center gap-1.5 font-medium">{p.gate ? `${p.gate.name} gate · round ${p.gate.round}` : p.name}<KindIcon kind={p.kind} /></span>
                  <span className="block text-sm text-muted">{p.remark?.text ? `✎ ${p.remark.text}` : p.summary ?? p.description}</span>
                </span>
                <span className="shrink-0 text-sm tabular-nums text-faint">{p.secs ? fmtDur(p.secs) : ""}</span>
                <Chevron className="mt-1 text-faint" />
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-line-strong px-4 py-6 text-center text-sm text-muted">Not reached yet in this chapter.</p>
      )}
    </div>
    </Pane>
  );
}

export type { Gate };
