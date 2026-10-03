"use client";
// PROTOTYPE, throwaway. The header (three places + Run a prompt + theme), the variant switcher,
// the drawer and the toast — everything that sits around a page.
import { Dialog } from "@base-ui/react/dialog";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { FACTORIES, VIEWER } from "@/lib/data";
import { SideDrawer } from "./Drawer";
import { PLink, useProto, VARIANTS } from "./state";
import { Button, cx } from "./ui";

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" fill="#2f5bd3" />
      <path d="M7 25L7 15L13 7L13 15L19 7L19 15L25 7L25 25Z" fill="none" stroke="#fbfbfa" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

type Theme = "system" | "light" | "dark";

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    try { setTheme((localStorage.getItem("theme") as Theme) || "system"); } catch {}
  }, []);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = theme === "system" ? (mq.matches ? "dark" : "light") : theme;
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);
  const set = (t: Theme) => {
    setTheme(t);
    try { if (t === "system") localStorage.removeItem("theme"); else localStorage.setItem("theme", t); } catch {}
  };
  const icons: Record<Theme, ReactNode> = {
    system: <path d="M2.5 3.5h11v7h-11zM6 13.5h4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />,
    light: <><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></>,
    dark: <path d="M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />,
  };
  return (
    <div className="flex shrink-0 rounded-md border border-line p-0.5" role="radiogroup" aria-label="Theme">
      {(["system", "light", "dark"] as Theme[]).map((t) => (
        <button key={t} role="radio" aria-checked={theme === t} aria-label={t} onClick={() => set(t)}
          className={cx("grid size-6 place-items-center rounded cursor-pointer", theme === t ? "bg-surface-3 text-fg" : "text-faint hover:text-fg")}>
          <svg width="14" height="14" viewBox="0 0 16 16">{icons[t]}</svg>
        </button>
      ))}
    </div>
  );
}

function RunPrompt() {
  return (
    <Dialog.Root>
      <Dialog.Trigger render={<Button variant="secondary" size="sm" />}>
        <svg width="12" height="12" viewBox="0 0 16 16"><path d="M4 2.5l9 5.5-9 5.5z" fill="currentColor" /></svg>
        <span className="hidden sm:inline">Run a prompt</span>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/25 transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0 dark:bg-black/60" />
        <Dialog.Popup className="fixed z-50 top-[12vh] left-1/2 w-[min(520px,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-line bg-surface p-5 shadow-pop transition-all data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
          <Dialog.Title className="text-lg font-semibold">Run a prompt</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted">An online station of the factory starts a session from it.</Dialog.Description>
          <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <label className="flex flex-col gap-1"><span className="text-muted">Factory</span>
              <select className="h-9 rounded-md border border-line-strong bg-surface px-2">{FACTORIES.map((f) => <option key={f.name}>{f.name}</option>)}</select>
            </label>
            <label className="flex flex-col gap-1"><span className="text-muted">Workflow</span>
              <select className="h-9 rounded-md border border-line-strong bg-surface px-2"><option>quick</option><option>sdlc</option><option>ship</option></select>
            </label>
          </div>
          <textarea rows={4} placeholder="What should change?" className="mt-3 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 outline-none focus:border-accent focus:ring-4 focus:ring-accent-soft" />
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close render={<Button variant="ghost" />}>Cancel</Dialog.Close>
            <Dialog.Close render={<Button variant="primary" />}>Run</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Nav() {
  const path = usePathname();
  const items = [
    { href: "/", label: "Now", on: path === "/" },
    { href: "/sessions", label: "Sessions", on: path.startsWith("/sessions") },
    { href: "/factories", label: "Factories", on: path.startsWith("/factories") },
  ];
  return (
    <nav className="flex items-center gap-0.5">
      {items.map((i) => (
        <PLink key={i.href} href={i.href} className={cx("rounded-md px-2 py-1 text-sm font-medium sm:px-2.5 sm:text-base", i.on ? "bg-surface-2 text-fg" : "text-muted hover:text-fg")}>
          {i.label}
        </PLink>
      ))}
    </nav>
  );
}

function Switcher() {
  const { variant, setVariant } = useProto();
  const i = VARIANTS.findIndex((v) => v.key === variant);
  const go = (d: number) => setVariant(VARIANTS[(i + d + VARIANTS.length) % VARIANTS.length].key);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (process.env.NODE_ENV === "production") return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-full bg-[#111] px-1.5 py-1.5 text-white shadow-[0_8px_30px_rgba(0,0,0,0.35)] ring-1 ring-white/10" style={{ fontFamily: "ui-monospace, monospace" }}>
      <button onClick={() => go(-1)} className="grid size-7 place-items-center rounded-full hover:bg-white/15 cursor-pointer" aria-label="Previous variant">←</button>
      <span className="px-2 text-xs whitespace-nowrap"><span className="text-white/50">graph</span> {variant} · {VARIANTS[i].name}</span>
      <button onClick={() => go(1)} className="grid size-7 place-items-center rounded-full hover:bg-white/15 cursor-pointer" aria-label="Next variant">→</button>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { toast } = useProto();
  return (
    <>
      <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-2 px-4 md:gap-3 md:px-6">
          <PLink href="/" className="flex items-center gap-2 font-semibold tracking-tight"><Logo /><span className="hidden sm:inline">cockpit</span></PLink>
          <Nav />
          <span className="grow" />
          <RunPrompt />
          <ThemeToggle />
          <span className="hidden h-7 items-center rounded-full bg-surface-2 px-2.5 text-xs text-muted md:flex">{VIEWER}</span>
        </div>
      </header>
      <main className="mx-auto max-w-[1280px] px-4 pt-6 pb-28 md:px-6 md:pt-8">{children}</main>
      <SideDrawer />
      {toast ? (
        <div className="fixed bottom-16 left-1/2 z-50 w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-line bg-surface px-4 py-3 text-sm shadow-pop">{toast}</div>
      ) : null}
      <Switcher />
    </>
  );
}
