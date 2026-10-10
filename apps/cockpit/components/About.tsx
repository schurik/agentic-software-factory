"use client";

import { Popover } from "@base-ui/react/popover";
import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { cx, menuPopup } from "./ui";

/**
 * What a term means, one (i) away: a popover that opens on hover and on a
 * click or a tap, so a phone reaches it too — the config editor's "About",
 * with a hover. Never inside a control: an accordion's row is its button, so
 * the row's words are explained on the column names above the rows instead.
 */
export function About({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <Popover.Root>
      <Popover.Trigger openOnHover delay={150} closeDelay={100} aria-label={`About: ${title}`}
                       className={cx("inline-grid size-4 shrink-0 cursor-help place-items-center rounded-full align-[-2px] text-faint hover:text-fg data-popup-open:text-accent", className)}>
        <Info size={13} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="center" collisionPadding={12} className="z-[60]">
          <Popover.Popup className={cx(menuPopup, "w-[min(22rem,calc(100vw-2rem))] p-3 text-left text-sm font-normal normal-case tracking-normal")}>
            <Popover.Title className="mb-1.5 font-semibold text-fg">{title}</Popover.Title>
            <div className="flex flex-col gap-2 leading-relaxed text-muted [&_b]:font-medium [&_b]:text-fg">{children}</div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A name with its (i): a column's, a section's. */
export function Named({ children, title, about, className }: { children: ReactNode; title: string; about: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1", className)}>
      {children}
      <About title={title}>{about}</About>
    </span>
  );
}
