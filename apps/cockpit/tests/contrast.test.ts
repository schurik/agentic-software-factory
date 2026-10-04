import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The colour tokens (#105) are read off the stylesheet itself, so a token
// changed there is checked here: every colour text is drawn in clears WCAG AA
// (4.5:1) on the page and on a card, in both themes — and so does the text on
// a filled button or badge.

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

/** The `--name: #hex` tokens declared in the first block `selector` opens. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no ${selector} block in globals.css`);
  const block = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map(([, name, hex]) => [name, hex]));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = { light: tokens(":root"), dark: tokens('[data-theme="dark"]') };
const TEXT = ["fg", "muted", "faint", "accent", "ok", "wait", "bad", "merged"];
// A filled control or badge, and the token its text is drawn in.
const FILLED: [text: string, fill: string][] = [["accent-fg", "accent-strong"], ["bg", "wait"], ["bg", "bad"]];

describe.each(Object.entries(THEMES))("the %s theme", (_, theme) => {
  it.each(TEXT)("draws --%s text at AA on the page and on a card", (name) => {
    for (const ground of ["bg", "surface"]) {
      expect(theme[name], `--${name}`).toBeDefined();
      expect(contrast(theme[name], theme[ground]), `--${name} on --${ground}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(FILLED)("draws --%s on --%s at AA", (text, fill) => {
    expect(contrast(theme[text], theme[fill])).toBeGreaterThanOrEqual(4.5);
  });
});

describe("dark mode's amber and red badges", () => {
  it("carry dark text, not light", () => {
    const { bg, wait, bad } = THEMES.dark;
    expect(luminance(bg)).toBeLessThan(luminance(wait));
    expect(luminance(bg)).toBeLessThan(luminance(bad));
  });
});
