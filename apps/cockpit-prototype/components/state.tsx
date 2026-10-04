"use client";
// PROTOTYPE, throwaway. In-memory state only: what the drawer shows,
// which gates were "answered" (nothing is sent anywhere), and a toast that says so.
import Link from "next/link";
import { createContext, useCallback, useContext, useMemo, useState, type ComponentProps, type ReactNode } from "react";

export type DrawerTarget =
  | { type: "phase"; session: string; phaseId: string }
  | { type: "stage"; session: string; chapter: number; stage: number }
  | { type: "gate"; gateId: string };

interface State {
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
  const [drawer, setDrawer] = useState<DrawerTarget[]>([]);
  const [answered, setAnswered] = useState<Record<string, "approve" | "reject">>({});
  const [toast, setToast] = useState<string | null>(null);
  const [run, setRun] = useState<State["run"]>({ open: false });

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
    drawer,
    open: (t) => setDrawer([t]),
    push: (t) => setDrawer((d) => [...d, t]),
    back: () => setDrawer((d) => d.slice(0, -1)),
    close: () => setDrawer([]),
    run,
    openRun: (preset) => setRun({ open: true, ...preset }),
    closeRun: () => setRun((r) => ({ ...r, open: false })),
    answered, answer, openToast, toast,
  }), [drawer, run, answered, answer, openToast, toast]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useToast = () => ({ openToast: useProto().openToast });

/** The prototype's link: Next's, kept as one name so every link reads the same. */
export function PLink(props: ComponentProps<typeof Link> & { href: string }) {
  return <Link {...props} />;
}
