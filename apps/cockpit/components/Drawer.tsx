"use client";

import { Drawer as Base } from "@base-ui/react/drawer";
import { ChevronLeft, X } from "lucide-react";
import { type ReactNode, useState, useSyncExternalStore } from "react";
import { followInPlace } from "./graph/StageGraph";
import { buttonClass, cx } from "./ui";

/**
 * The one drawer (#104): everything deeper than a page — a stage, a phase,
 * and later a gate — opens in it. From the right on a desktop, up to 720px
 * wide; a bottom sheet at 92% of the screen's height on a phone (767px and
 * below), where it is swiped down to close.
 *
 * What it shows is the address's (the page's `Shown`), so a link opens
 * exactly that drawer, and Back and Close are links too. The shell is Base
 * UI's, and draws nothing until it is open in a browser; what it holds is
 * `DrawerFrame`, which a test renders on its own.
 */

/** The shell's look: the sheet under `md`, the panel from it. Written out whole: Tailwind only generates what it reads. */
export const DRAWER_LOOK = {
  viewport: "fixed inset-0 z-40 flex items-end md:items-stretch md:justify-end",
  popup: cx(
    "flex flex-col bg-surface text-fg shadow-pop outline-none transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
    "max-md:h-[92dvh] max-md:w-full max-md:rounded-t-2xl max-md:border-t max-md:border-line",
    "max-md:[transform:translateY(var(--drawer-swipe-movement-y))] max-md:data-starting-style:[transform:translateY(100%)] max-md:data-ending-style:[transform:translateY(100%)]",
    "md:h-full md:w-[min(720px,100vw)] md:border-l md:border-line",
    "md:[transform:translateX(var(--drawer-swipe-movement-x))] md:data-starting-style:[transform:translateX(100%)] md:data-ending-style:[transform:translateX(100%)]",
  ),
};

const PHONE = "(max-width: 767px)";

/** Whether the screen is a phone's: which way the drawer is swiped shut. */
function usePhone(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const query = window.matchMedia(PHONE);
      query.addEventListener("change", changed);
      return () => query.removeEventListener("change", changed);
    },
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

/** The shell. `label` names it to a screen reader, as the frame's top bar names it on screen. */
export function Drawer({ open, label, onClose, children }: { open: boolean; label: string; onClose: () => void; children: ReactNode }) {
  const phone = usePhone();
  // What it held, kept while it slides away: closing empties the address before the animation ends.
  const [kept, setKept] = useState<ReactNode>(children);
  if (open && kept !== children) setKept(children);
  return (
    <Base.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }} swipeDirection={phone ? "down" : "right"}>
      <Base.Portal>
        <Base.Backdrop className="fixed inset-0 z-40 bg-black/20 transition-opacity duration-300 data-ending-style:opacity-0 data-starting-style:opacity-0 dark:bg-black/50" />
        <Base.Viewport className={DRAWER_LOOK.viewport}>
          <Base.Popup className={DRAWER_LOOK.popup}>
            <Base.Title className="sr-only">{label}</Base.Title>
            {open ? children : kept}
          </Base.Popup>
        </Base.Viewport>
      </Base.Portal>
    </Base.Root>
  );
}

/** Where a control of the drawer goes: an address to link to, and what following it does in place. */
export interface Go {
  href: string;
  onClick: () => void;
}

/**
 * A view of the drawer: a top bar — Back when views are stacked, the view's
 * icon, name and what it is, and Close — over a body that scrolls, and a
 * footer pinned under it where the view has one.
 */
export function DrawerFrame({ icon, title, what, back, close, footer, children }: {
  icon: ReactNode;
  title: ReactNode;
  /** What kind of view it is: "stage", "phase". */
  what: string;
  back: Go | null;
  close: Go;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div data-drawer={what} className="flex min-h-0 grow flex-col">
      <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-line-strong md:hidden" />
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4 md:px-5">
        {back ? (
          <a href={back.href} onClick={followInPlace(back.onClick)} className={cx(buttonClass("ghost", "sm"), "-ml-2")}>
            <ChevronLeft size={14} aria-hidden="true" /> Back
          </a>
        ) : null}
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-medium">
          {icon}
          <span className="truncate">{title}</span>
          <span className="font-normal text-muted">{what}</span>
        </h2>
        <span className="grow" />
        <a href={close.href} onClick={followInPlace(close.onClick)} aria-label="Close" className={cx(buttonClass("ghost", "sm"), "text-muted")}>
          <X size={14} aria-hidden="true" />
        </a>
      </div>
      <div className="min-h-0 grow overflow-y-auto overscroll-contain px-5 py-5 md:px-6">{children}</div>
      {footer ? <div className="shrink-0 border-t border-line bg-surface px-5 pt-3 pb-4 md:px-6">{footer}</div> : null}
    </div>
  );
}
