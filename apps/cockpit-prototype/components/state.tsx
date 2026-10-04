"use client";
// PROTOTYPE, throwaway. In-memory state only: which graph variant, what the drawer shows,
// which gates were "answered" (nothing is sent anywhere), and a toast that says so.
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useState, type ComponentProps, type ReactNode } from "react";

export const VARIANTS = [
  { key: "A", name: "Well" },
  { key: "B", name: "Tint" },
  { key: "C", name: "Edge" },
  { key: "D", name: "Ink" },
] as const;
export type Variant = (typeof VARIANTS)[number]["key"];

export type DrawerTarget =
  | { type: "phase"; session: string; phaseId: string }
  | { type: "stage"; session: string; chapter: number; stage: number }
  | { type: "gate"; gateId: string };

interface State {
  variant: Variant;
  setVariant: (v: Variant) => void;
  drawer: DrawerTarget[];
  open: (t: DrawerTarget) => void;
  push: (t: DrawerTarget) => void;
  back: () => void;
  close: () => void;
  /** The one Run-a-prompt dialog, opened from the header or from a workflow, with what is chosen. */
  run: { open: boolean; factory?: string; workflow?: string };
  openRun: (preset: { factory?: string; workflow?: string }) => void;
  closeRun: () => void;
  answered: Record<string, "approve" | "reject">;
  answer: (gateId: string, verdict: "approve" | "reject", note: string, where: string) => void;
  /** Say what a prototype action would have done; nothing is ever sent. */
  openToast: (message: string) => void;
  toast: string | null;
}

const Ctx = createContext<State | null>(null);

export function useProto(): State {
  const s = useContext(Ctx);
  if (!s) throw new Error("outside Provider");
  return s;
}

export function Provider({ children }: { children: ReactNode }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = params.get("variant");
  const variant: Variant = VARIANTS.some((v) => v.key === raw) ? (raw as Variant) : "A";
  const [drawer, setDrawer] = useState<DrawerTarget[]>([]);
  const [answered, setAnswered] = useState<Record<string, "approve" | "reject">>({});
  const [toast, setToast] = useState<string | null>(null);
  const [run, setRun] = useState<State["run"]>({ open: false });

  const setVariant = useCallback((v: Variant) => {
    const next = new URLSearchParams(params.toString());
    next.set("variant", v);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }, [params, pathname, router]);

  const openToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const answer = useCallback((gateId: string, verdict: "approve" | "reject", note: string, where: string) => {
    setAnswered((a) => ({ ...a, [gateId]: verdict }));
    setToast(`${verdict === "approve" ? "Approved" : "Rejected"} — would post as a comment on ${where}${note ? ` with “${note}”` : ""}. Prototype: nothing was sent.`);
    window.setTimeout(() => setToast(null), 4200);
  }, []);

  const value = useMemo<State>(() => ({
    variant, setVariant, drawer,
    open: (t) => setDrawer([t]),
    push: (t) => setDrawer((d) => [...d, t]),
    back: () => setDrawer((d) => d.slice(0, -1)),
    close: () => setDrawer([]),
    run,
    openRun: (preset) => setRun({ open: true, ...preset }),
    closeRun: () => setRun((r) => ({ ...r, open: false })),
    answered, answer, openToast, toast,
  }), [variant, setVariant, drawer, run, answered, answer, openToast, toast]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useToast = () => ({ openToast: useProto().openToast });

/** A link that keeps `?variant=` so the chosen graph survives navigation. */
export function PLink({ href, ...rest }: ComponentProps<typeof Link> & { href: string }) {
  const params = useSearchParams();
  const v = params.get("variant");
  const sep = href.includes("?") ? "&" : "?";
  return <Link {...rest} href={v ? `${href}${sep}variant=${v}` : href} />;
}
