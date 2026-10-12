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
// A diff's lines: their text and line numbers on an added or removed line, and the words marked in one.
const DIFF: [text: string, ground: string][] = [
  ["fg", "add-bg"], ["muted", "add-bg"], ["fg", "del-bg"], ["muted", "del-bg"], ["fg", "add-word"], ["fg", "del-word"],
];

/**
 * The `--name: color-mix(in oklab, #hex N%, transparent)` washes in the first block `selector`
 * opens, as their colour and how much of it there is: mixed with transparent, a wash is its colour
 * at that opacity.
 */
function washes(selector: string): Record<string, [hex: string, alpha: number]> {
  const start = css.indexOf(`${selector} {`);
  const block = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*color-mix\(in oklab,\s*(#[0-9a-f]{6})\s+([\d.]+)%,\s*transparent\)\s*;/gi)]
    .map(([, name, hex, percent]) => [name, [hex, Number(percent) / 100]]));
}

/** `hex` at `alpha` over `ground`, as the browser paints it. */
function over([hex, alpha]: [string, number], ground: string): string {
  const channel = (color: string, at: number) => parseInt(color.slice(at, at + 2), 16);
  return `#${[1, 3, 5].map((at) => Math.round(channel(hex, at) * alpha + channel(ground, at) * (1 - alpha))
    .toString(16).padStart(2, "0")).join("")}`;
}

const WASHES = { light: washes(":root"), dark: washes('[data-theme="dark"]') };
// A status pill (and the Now count, the avatar, a danger button's hover): its word in the status
// colour on that colour's own wash. The pill sits on a card, on the page, or in a row a pointer has
// lit — so the wash is over --surface, --bg or --surface-2.
const PILLS: [text: string, wash: string][] = [["ok", "ok-soft"], ["wait", "wait-soft"], ["bad", "bad-soft"], ["accent", "accent-soft"]];

describe.each(Object.entries(THEMES))("the %s theme", (themeName, theme) => {
  it.each(PILLS)("draws a pill's --%s on --%s at AA, wherever the pill sits", (text, wash) => {
    const washed = WASHES[themeName as keyof typeof WASHES][wash];
    expect(washed, `--${wash}`).toBeDefined();
    for (const ground of ["bg", "surface", "surface-2"]) {
      expect(contrast(theme[text], over(washed, theme[ground])), `--${text} on --${wash} over --${ground}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(TEXT)("draws --%s text at AA on the page and on a card", (name) => {
    for (const ground of ["bg", "surface"]) {
      expect(theme[name], `--${name}`).toBeDefined();
      expect(contrast(theme[name], theme[ground]), `--${name} on --${ground}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(FILLED)("draws --%s on --%s at AA", (text, fill) => {
    expect(contrast(theme[text], theme[fill])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(DIFF)("draws a diff's --%s on --%s at AA", (text, ground) => {
    expect(contrast(theme[text], theme[ground])).toBeGreaterThanOrEqual(4.5);
  });
});

// A benchmark's variants (#199) are categorical series: marks and fills, never text. A mark
// clears WCAG's 3:1 for graphics on the page and on a card, and the two stay apart for a reader
// with protanopia, deuteranopia or tritanopia — OKLab ΔE×100 of 8 or more under the Machado, Oliveira &
// Fernandes (2009) simulation at full severity — and 15 for everyone else: a variant is told by
// its place and its colour at once, never by a colour one reader cannot see. Nor is it ever read
// as a status: each series stays 12 from ok, wait and bad — not 15, which no orange clears in the
// light theme, between its red and its amber.
const SERIES = ["series-1", "series-2"];
const MACHADO: Record<string, number[][]> = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};

/** `hex` in linear RGB, as a reader with `vision` sees it. */
function seen(hex: string, vision: string | null): number[] {
  const rgb = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  if (vision === null) return rgb;
  return MACHADO[vision].map((row) => Math.max(0, Math.min(1, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])));
}

function oklab([r, g, b]: number[]): number[] {
  const [l, m, s] = [
    0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b,
    0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
    0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b,
  ].map(Math.cbrt);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
          0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** How far apart two colours look, OKLab ΔE×100, to a reader with `vision` (null: full colour vision). */
function apart(a: string, b: string, vision: string | null): number {
  const [x, y] = [oklab(seen(a, vision)), oklab(seen(b, vision))];
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

describe.each(Object.entries(THEMES))("the %s theme's variant series", (_, theme) => {
  it.each(SERIES)("draws a --%s mark at 3:1 on the page and on a card", (name) => {
    for (const ground of ["bg", "surface"]) {
      expect(theme[name], `--${name}`).toBeDefined();
      expect(contrast(theme[name], theme[ground]), `--${name} on --${ground}`).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(["protan", "deutan", "tritan"])("keeps the two apart for %sopia", (vision) => {
    expect(apart(theme["series-1"], theme["series-2"], vision)).toBeGreaterThanOrEqual(8);
  });

  it("keeps the two apart for full colour vision", () => {
    expect(apart(theme["series-1"], theme["series-2"], null)).toBeGreaterThanOrEqual(15);
  });

  it.each(["ok", "wait", "bad"])("never draws a variant in a status colour: each series is apart from --%s", (status) => {
    for (const name of SERIES) expect(apart(theme[name], theme[status], null), `--${name} against --${status}`).toBeGreaterThanOrEqual(12);
  });
});

describe("dark mode's amber and red badges", () => {
  it("carry dark text, not light", () => {
    const { bg, wait, bad } = THEMES.dark;
    expect(luminance(bg)).toBeLessThan(luminance(wait));
    expect(luminance(bg)).toBeLessThan(luminance(bad));
  });
});
