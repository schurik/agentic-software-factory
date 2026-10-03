"use client";
// PROTOTYPE, throwaway. The header (brand + mode · three places · Run a prompt · the viewer's
// avatar), the variant switcher, the drawer and the toast — everything that sits around a page.
// The header is flat: the page's own background, one hairline, the active place underlined on it.
import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import { Select } from "@base-ui/react/select";
import { Check, ChevronsUpDown, Monitor, Moon, Play, Sun, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { FACTORIES, GATES, MODE, VIEWER } from "@/lib/data";
import { SideDrawer } from "./Drawer";
import { PLink, useProto, VARIANTS } from "./state";
import { Button, cx, menuItem, menuLabel, menuPopup } from "./ui";

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="7" fill="#2f5bd3" />
      <path d="M7 25L7 15L13 7L13 15L19 7L19 15L25 7L25 25Z" fill="none" stroke="#fbfbfa" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

type Theme = "system" | "light" | "dark";

/** The remembered theme, else the system's — applied to <html> and kept in step with the OS. */
function useTheme(): [Theme, (t: Theme) => void] {
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
  return [theme, set];
}

const THEME_ICON: Record<Theme, typeof Monitor> = { system: Monitor, light: Sun, dark: Moon };

/** Who is looking, in which mode, and the theme: one avatar instead of three controls. */
function AvatarMenu() {
  const [theme, setTheme] = useTheme();
  return (
    <Menu.Root>
      <Menu.Trigger className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent ring-offset-2 ring-offset-bg hover:ring-2 hover:ring-line-strong data-popup-open:ring-2 data-popup-open:ring-accent cursor-pointer" aria-label={`Signed in as ${VIEWER}`}>
        {VIEWER[0].toUpperCase()}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} align="end" className="z-50">
          <Menu.Popup className={menuPopup}>
            <div className="px-2.5 pt-2 pb-2">
              <div className="font-medium">{VIEWER}</div>
              <div className="text-xs text-muted">{MODE === "local" ? "Local cockpit · your own forge token" : "Team cockpit · signed in with GitHub"}</div>
            </div>
            <Menu.Separator className="my-1 h-px bg-line" />
            <Menu.RadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
              <Menu.GroupLabel className={menuLabel}>Theme</Menu.GroupLabel>
              {(["system", "light", "dark"] as Theme[]).map((t) => {
                const Icon = THEME_ICON[t];
                return (
                  <Menu.RadioItem key={t} value={t} closeOnClick={false} className={menuItem}>
                    <Icon size={14} className="text-muted" />
                    <span className="grow capitalize">{t}</span>
                    <Menu.RadioItemIndicator><Check size={14} className="text-accent" /></Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                );
              })}
            </Menu.RadioGroup>
            {MODE === "team" ? (
              <>
                <Menu.Separator className="my-1 h-px bg-line" />
                <Menu.Item className={menuItem}>Sign out</Menu.Item>
              </>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function Pick({ label, items, value, onChange }: { label: string; items: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <Select.Root items={items.map((i) => ({ label: i, value: i }))} value={value} onValueChange={(v) => onChange(v as string)}>
      <div className="flex flex-col gap-1">
        <Select.Label className="text-sm text-muted">{label}</Select.Label>
        <Select.Trigger className="flex h-9 items-center justify-between gap-2 rounded-md border border-line-strong bg-surface px-3 text-base hover:bg-surface-2 data-popup-open:border-accent cursor-pointer">
          <Select.Value />
          <Select.Icon><ChevronsUpDown size={14} className="text-muted" /></Select.Icon>
        </Select.Trigger>
      </div>
      <Select.Portal>
        <Select.Positioner sideOffset={4} className="z-50">
          <Select.Popup className={cx(menuPopup, "min-w-[var(--anchor-width)]")}>
            <Select.List>
              {items.map((i) => (
                <Select.Item key={i} value={i} className={menuItem}>
                  <Select.ItemText className="grow">{i}</Select.ItemText>
                  <Select.ItemIndicator><Check size={14} className="text-accent" /></Select.ItemIndicator>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

function RunPrompt() {
  const [factory, setFactory] = useState(FACTORIES[0].name);
  const [workflow, setWorkflow] = useState("quick");
  const [prompt, setPrompt] = useState("");
  return (
    <Dialog.Root onOpenChange={(o) => { if (!o) setPrompt(""); }}>
      <Dialog.Trigger render={<Button variant="secondary" size="sm" aria-label="Run a prompt" />}>
        <Play size={12} fill="currentColor" />
        <span className="hidden sm:inline">Run a prompt</span>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/25 transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0 dark:bg-black/60" />
        <Dialog.Popup className="fixed z-50 top-[12vh] left-1/2 w-[min(520px,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-line bg-surface p-5 shadow-pop transition-all data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
          <div className="flex items-start gap-3">
            <div className="grow">
              <Dialog.Title className="text-lg font-semibold">Run a prompt</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted">An online station of the factory starts a session from it.</Dialog.Description>
            </div>
            <Dialog.Close className="-mt-1 -mr-1 grid size-8 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg cursor-pointer" aria-label="Close"><X size={16} /></Dialog.Close>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Pick label="Factory" items={FACTORIES.map((f) => f.name)} value={factory} onChange={setFactory} />
            <Pick label="Workflow" items={["quick", "sdlc", "ship"]} value={workflow} onChange={setWorkflow} />
          </div>
          <label className="mt-3 flex flex-col gap-1">
            <span className="text-sm text-muted">Prompt</span>
            <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should change?" className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2 outline-none placeholder:text-faint focus:border-accent focus:ring-4 focus:ring-accent-soft" />
          </label>
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close render={<Button variant="ghost" />}>Cancel</Dialog.Close>
            <Dialog.Close render={<Button variant="primary" disabled={!prompt.trim()} />}>Run</Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The active place is marked by a rule sitting on the header's own bottom line. */
function Nav() {
  const path = usePathname();
  const { answered } = useProto();
  const waiting = GATES.filter((g) => !answered[g.id]).length;
  const items = [
    { href: "/", label: "Now", on: path === "/", count: waiting },
    { href: "/sessions", label: "Sessions", on: path.startsWith("/sessions"), count: 0 },
    { href: "/factories", label: "Factories", on: path.startsWith("/factories"), count: 0 },
  ];
  return (
    <nav className="flex h-full items-stretch gap-1 sm:gap-3">
      {items.map((i) => (
        <PLink
          key={i.href}
          href={i.href}
          aria-current={i.on ? "page" : undefined}
          className={cx(
            "relative flex items-center gap-1.5 px-1.5 text-sm font-medium sm:text-base",
            "after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full",
            i.on ? "text-fg after:bg-accent" : "text-muted hover:text-fg",
          )}
        >
          {i.label}
          {i.count ? (
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-wait-soft px-1 text-[10px] leading-none font-semibold text-wait tabular-nums" aria-label={`${i.count} gates wait on you`}>{i.count}</span>
          ) : null}
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
      <header className="sticky top-0 z-30 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-3 px-4 md:gap-6 md:px-6">
          <PLink href="/" className="flex shrink-0 items-center gap-2">
            <Logo />
            <span className="hidden flex-col leading-none sm:flex">
              <span className="font-semibold tracking-tight">cockpit</span>
              {/* Only a local cockpit says so; a team one is the default and says nothing. */}
              {MODE === "local" ? <span className="mt-0.5 text-[10px] font-medium uppercase tracking-wider text-muted">local</span> : null}
            </span>
          </PLink>
          <Nav />
          <span className="grow" />
          <RunPrompt />
          <AvatarMenu />
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
