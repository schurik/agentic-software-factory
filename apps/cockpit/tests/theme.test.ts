import { describe, expect, it } from "vitest";
import { applied, BEFORE_PAINT, chosen, keep, THEME_KEY } from "../components/theme";

// The theme a viewer picks in the avatar menu (#105): remembered in their
// browser, and applied by a script in <head> that runs before the first paint,
// so a dark page never flashes light while React loads.

/** A browser as far as the script touches one. */
function browser(stored: string | null, prefersDark: boolean, { storage = true } = {}) {
  const store = new Map(stored === null ? [] : [[THEME_KEY, stored]]);
  const root = { dataset: {} as Record<string, string> };
  const localStorage = {
    getItem: (key: string) => {
      if (!storage) throw new Error("storage is blocked");
      return store.get(key) ?? null;
    },
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  const matchMedia = (query: string) => ({ matches: query === "(prefers-color-scheme: dark)" && prefersDark });
  return { store, root, localStorage, matchMedia, document: { documentElement: root } };
}

function paint(stored: string | null, prefersDark: boolean, options?: { storage?: boolean }) {
  const page = browser(stored, prefersDark, options);
  new Function("localStorage", "matchMedia", "document", BEFORE_PAINT)(page.localStorage, page.matchMedia, page.document);
  return page.root.dataset.theme;
}

describe("before the first paint", () => {
  it("applies the theme the viewer chose", () => {
    expect(paint("dark", false)).toBe("dark");
    expect(paint("light", true)).toBe("light");
  });

  it("follows the system when they chose none", () => {
    expect(paint(null, true)).toBe("dark");
    expect(paint(null, false)).toBe("light");
  });

  it("ignores a stored value it does not know, and storage it may not read", () => {
    expect(paint("sepia", true)).toBe("dark");
    expect(paint("light", true, { storage: false })).toBe("dark");
  });
});

describe("the choice", () => {
  it("is read back as it was kept, System when none is", () => {
    const page = browser(null, false);
    expect(chosen(page.localStorage)).toBe("system");
    keep(page.localStorage, "dark");
    expect(chosen(page.localStorage)).toBe("dark");
    keep(page.localStorage, "system");
    expect(page.store.has(THEME_KEY)).toBe(false);
  });

  it("resolves System by what the system prefers", () => {
    expect(applied("system", true)).toBe("dark");
    expect(applied("system", false)).toBe("light");
    expect(applied("light", true)).toBe("light");
  });
});
