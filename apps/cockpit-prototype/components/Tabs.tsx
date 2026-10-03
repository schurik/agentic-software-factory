"use client";
// PROTOTYPE, throwaway. Base UI Tabs, styled once: an underline on the active tab.
import { Tabs as T } from "@base-ui/react/tabs";
import type { ReactNode } from "react";
import { cx } from "./ui";

export function Tabbed({ tabs, initial, className, sticky }: {
  tabs: { value: string; label: ReactNode; body: ReactNode }[];
  initial?: string;
  className?: string;
  sticky?: boolean;
}) {
  return (
    <T.Root defaultValue={initial ?? tabs[0]?.value} className={className}>
      <T.List className={cx("relative flex gap-4 overflow-x-auto border-b border-line no-scrollbar", sticky && "sticky top-0 z-10 bg-surface")}>
        {tabs.map((t) => (
          <T.Tab
            key={t.value}
            value={t.value}
            className="h-9 shrink-0 whitespace-nowrap text-sm font-medium text-muted outline-none hover:text-fg data-active:text-fg cursor-pointer"
          >
            {t.label}
          </T.Tab>
        ))}
        <T.Indicator className="absolute bottom-0 left-0 h-0.5 w-(--active-tab-width) translate-x-(--active-tab-left) rounded-full bg-fg transition-[translate,width] duration-150" />
      </T.List>
      {tabs.map((t) => (
        <T.Panel key={t.value} value={t.value} className="pt-4 outline-none">
          {t.body}
        </T.Panel>
      ))}
    </T.Root>
  );
}
