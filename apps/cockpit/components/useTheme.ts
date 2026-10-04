"use client";

import { useEffect, useSyncExternalStore } from "react";
import { applied, browserStorage, chosen, DARK, keep, prefersDark, type Theme, THEME_KEY } from "./theme";

// Said when this tab changes the theme; the `storage` event says it for another tab.
const CHANGED = "cockpit-theme";

function subscribe(changed: () => void): () => void {
  const onStorage = (event: StorageEvent) => { if (event.key === THEME_KEY) changed(); };
  window.addEventListener(CHANGED, changed);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGED, changed);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * The viewer's theme: kept in their browser, applied to <html> and — on
 * System — kept in step with the OS. The first paint already has it, from
 * the script in app/layout.tsx; this keeps it as the viewer changes it.
 */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, () => chosen(browserStorage()), () => "system" as Theme);
  useEffect(() => {
    const system = window.matchMedia(DARK);
    const apply = () => { document.documentElement.dataset.theme = applied(theme, prefersDark()); };
    apply();
    system.addEventListener("change", apply);
    return () => system.removeEventListener("change", apply);
  }, [theme]);
  const set = (next: Theme) => {
    keep(browserStorage(), next);
    window.dispatchEvent(new Event(CHANGED));
  };
  return [theme, set];
}
