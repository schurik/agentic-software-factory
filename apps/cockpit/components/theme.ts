/**
 * The theme the viewer picks in the avatar menu: System, Light or Dark. It is
 * remembered in their own browser — a preference of this screen, not of the
 * person, so it never reaches the backend — and applied as `data-theme` on
 * <html>, which is all the stylesheet's tokens switch on (app/globals.css).
 */
export type Theme = "system" | "light" | "dark";

export const THEMES: Theme[] = ["system", "light", "dark"];

export const THEME_KEY = "theme";

const DARK = "(prefers-color-scheme: dark)";

/** What a stored value is as a choice: System for nothing, or for anything else it does not know. */
function asTheme(value: string | null): Theme {
  return value === "light" || value === "dark" ? value : "system";
}

/** The browser's storage as far as the theme touches it; reading it may throw when site data is blocked. */
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

/** The page's own storage, or null where the browser blocks site data and merely naming it throws. */
export function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function chosen(storage: Storage | null): Theme {
  try {
    return asTheme(storage?.getItem(THEME_KEY) ?? null);
  } catch {
    return "system";
  }
}

export function keep(storage: Storage | null, theme: Theme): void {
  try {
    if (theme === "system") storage?.removeItem(THEME_KEY);
    else storage?.setItem(THEME_KEY, theme);
  } catch {
    // Not remembered, but applied for as long as the page is open.
  }
}

/** The theme actually drawn: a choice of System is whatever the system prefers. */
export function applied(theme: Theme, prefersDark: boolean): "light" | "dark" {
  return theme === "system" ? (prefersDark ? "dark" : "light") : theme;
}

export function prefersDark(): boolean {
  return window.matchMedia(DARK).matches;
}

/**
 * The same decision as `applied(chosen(…))`, as a script for <head>: it runs
 * before the body is painted, so a dark page never flashes light while the
 * app loads. Kept to what a browser has before any of the app's code.
 */
export const BEFORE_PAINT =
  `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)})}catch(e){}` +
  `document.documentElement.dataset.theme=t==="light"||t==="dark"?t:matchMedia(${JSON.stringify(DARK)}).matches?"dark":"light";`;
