// PROTOTYPE, throwaway. The few primitives every page shares: status marks, buttons, cards.
import type { ComponentProps, ReactNode } from "react";
import type { PhaseStatus, Kind } from "@/lib/data";
import type { StageStatus } from "@/lib/model";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

type S = PhaseStatus | StageStatus | "done";

const tone: Record<string, string> = {
  ok: "text-ok", done: "text-ok", running: "text-accent", waiting: "text-wait", failed: "text-bad", rejected: "text-bad", pending: "text-faint",
};

/** One glyph per status — the only place status is drawn, so it reads the same everywhere. */
export function StatusIcon({ status, size = 14, className }: { status: S; size?: number; className?: string }) {
  const c = cx(tone[status], className);
  const p = { width: size, height: size, viewBox: "0 0 16 16", className: c, "aria-label": status } as const;
  switch (status) {
    case "ok":
    case "done":
      return <svg {...p}><circle cx="8" cy="8" r="7" fill="currentColor" opacity=".14" /><path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
    case "running":
      return <svg {...p}><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity=".22" strokeWidth="2" /><path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="spin" style={{ transformOrigin: "8px 8px" }} /></svg>;
    case "waiting":
      return <svg {...p}><circle cx="8" cy="8" r="7" fill="currentColor" opacity=".16" /><rect x="5.5" y="5" width="1.8" height="6" rx=".6" fill="currentColor" /><rect x="8.7" y="5" width="1.8" height="6" rx=".6" fill="currentColor" /></svg>;
    case "failed":
    case "rejected":
      return <svg {...p}><circle cx="8" cy="8" r="7" fill="currentColor" opacity=".14" /><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>;
    default:
      return <svg {...p}><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2.2 2.2" /></svg>;
  }
}

export function KindIcon({ kind, className }: { kind: Kind; className?: string }) {
  const p = { width: 12, height: 12, viewBox: "0 0 16 16", className: cx("text-faint shrink-0", className) };
  if (kind === "gate") return <svg {...p} aria-label="gate"><path d="M8 1.5L14.5 8 8 14.5 1.5 8z" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M8 1.5L14.5 8 8 14.5z" fill="currentColor" /></svg>;
  if (kind === "code") return <svg {...p} aria-label="code"><path d="M5.5 4L2 8l3.5 4M10.5 4L14 8l-3.5 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  return <svg {...p} aria-label="agent"><circle cx="8" cy="8" r="2.4" fill="currentColor" /><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>;
}

const pillTone: Record<string, string> = {
  done: "bg-ok-soft text-ok", ok: "bg-ok-soft text-ok", running: "bg-accent-soft text-accent", waiting: "bg-wait-soft text-wait",
  failed: "bg-bad-soft text-bad", rejected: "bg-bad-soft text-bad", pending: "bg-surface-2 text-muted",
};

export function Pill({ status, children }: { status: S; children?: ReactNode }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", pillTone[status])}>
      <span className="size-1.5 rounded-full bg-current" />
      {children ?? status}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line-strong bg-surface px-1 font-mono text-[11px] leading-none text-muted">{children}</kbd>;
}

type Btn = ComponentProps<"button"> & { variant?: "primary" | "secondary" | "ghost" | "danger" | "approve"; size?: "sm" | "md" };

export function Button({ variant = "secondary", size = "md", className, ...rest }: Btn) {
  return (
    <button
      {...rest}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors disabled:opacity-50 disabled:pointer-events-none cursor-pointer",
        size === "sm" ? "h-7 px-2.5 text-sm" : "h-9 px-3.5 text-base",
        variant === "primary" && "bg-accent text-accent-fg hover:brightness-110 shadow-card",
        variant === "approve" && "bg-ok text-white hover:brightness-110 shadow-card",
        variant === "secondary" && "border border-line-strong bg-surface text-fg hover:bg-surface-2 shadow-card",
        variant === "ghost" && "text-muted hover:bg-surface-2 hover:text-fg",
        variant === "danger" && "border border-line-strong bg-surface text-bad hover:bg-bad-soft",
        className,
      )}
    />
  );
}

export function Card({ className, children, ...rest }: ComponentProps<"div">) {
  return <div {...rest} className={cx("rounded-xl border border-line bg-surface shadow-card", className)}>{children}</div>;
}

export function SectionTitle({ children, count, right }: { children: ReactNode; count?: number; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline gap-2">
      <h2 className="text-lg font-semibold tracking-tight">{children}</h2>
      {count !== undefined ? <span className="text-sm text-faint tabular-nums">{count}</span> : null}
      <span className="grow" />
      {right}
    </div>
  );
}

export function Chevron({ open, className }: { open?: boolean; className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" className={cx("shrink-0 transition-transform", open && "rotate-90", className)}>
      <path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
