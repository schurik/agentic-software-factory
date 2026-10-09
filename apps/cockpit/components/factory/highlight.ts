/**
 * The config editor's highlighting (#157): a file's text cut into spans,
 * each of a kind the editor colours. The spans are drawn under the textarea,
 * glyph for glyph, so they never change the text — every span, in order, is
 * the file exactly as given — and a file that cannot be cut is one plain span.
 *
 * YAML (and JSON, which YAML reads) is cut by the `yaml` package's own lexer,
 * the parser the YAML check uses, so what is coloured a key is what the check
 * reads as one. Markdown's frontmatter is YAML; the rest of a Markdown file,
 * TOML and a sample's `KEY=value` lines are cut a line at a time.
 */
import { CST, Lexer } from "yaml";

/** What a span is, which decides its colour; null for text drawn as it is. */
export type Kind = "key" | "string" | "literal" | "comment" | "punct" | "meta" | "heading" | "code" | null;

export interface Span {
  text: string;
  kind: Kind;
}

/** `text`, the file at `path`, as spans. */
export function highlight(path: string, text: string): Span[] {
  const spans = /\.(ya?ml|json)$/i.test(path) ? yaml(text)
    : /\.md$/i.test(path) ? markdown(text)
      : /\.toml$/i.test(path) ? lines(text, toml)
        : /\.sample$/i.test(path) ? lines(text, sample)
          : [{ text, kind: null }];
  // What is drawn under the textarea must be the text itself: anything else is drawn plain.
  return spans.map((span) => span.text).join("") === text ? merged(spans) : [{ text, kind: null }];
}

/** Adjacent spans of one kind as one, and no empty ones. */
function merged(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    if (!span.text) continue;
    const last = out[out.length - 1];
    if (last && last.kind === span.kind && span.kind === null) last.text += span.text;
    else out.push({ ...span });
  }
  return out;
}

/** A plain scalar that YAML reads as a number, a boolean or null. */
const LITERAL = /^(true|false|null|~|[-+]?(\d[\d_]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?|0x[0-9a-f]+|0o[0-7]+|[-+]?\.inf|\.nan)$/i;

/** The lexer's markers: they say what comes next, and are not in the text. */
const MARKERS = new Set(["doc-mode", "flow-error-end", "scalar"]);

const PUNCT = new Set([
  "map-value-ind", "seq-item-ind", "explicit-key-ind", "flow-map-start", "flow-map-end", "flow-seq-start", "flow-seq-end",
  "comma", "block-scalar-header", "doc-start", "doc-end",
]);

function yaml(text: string): Span[] {
  const lexemes = [...new Lexer().lex(text)].map((source) => ({ source, type: CST.tokenType(source) }));
  const spans: Span[] = [];
  /** Whether the lexeme after `at` that is not a marker or a space is the `:` that makes a key. */
  const keyed = (at: number) => {
    for (let next = at + 1; next < lexemes.length; next += 1) {
      const { type } = lexemes[next];
      if (type === "space" || (type !== null && MARKERS.has(type))) continue;
      return type === "map-value-ind";
    }
    return false;
  };
  let block = false;
  for (let at = 0; at < lexemes.length; at += 1) {
    const { source, type } = lexemes[at];
    if (type !== null && MARKERS.has(type) && source.length === 1) {
      // A scalar's marker: the lexeme after it is the scalar, whatever it looks like — a block scalar's body included.
      if (type === "scalar" && at + 1 < lexemes.length) {
        const value = lexemes[++at].source;
        spans.push({ text: value, kind: block ? "string" : keyed(at) ? "key" : LITERAL.test(value) ? "literal" : "string" });
        block = false;
      }
      continue;
    }
    if (type === "block-scalar-header") block = true;
    else if (type !== "space" && type !== "newline" && type !== "comment") block = false;
    spans.push({ text: source, kind: kindOf(type, () => keyed(at)) });
  }
  return spans;
}

function kindOf(type: CST.TokenType | null, keyed: () => boolean): Kind {
  if (type === "comment") return "comment";
  if (type === "single-quoted-scalar" || type === "double-quoted-scalar") return keyed() ? "key" : "string";
  if (type === "anchor" || type === "alias" || type === "tag" || type === "directive-line") return "meta";
  return type !== null && PUNCT.has(type) ? "punct" : null;
}

/** Each line of `text` cut by `cut`, the newlines between them plain. */
function lines(text: string, cut: (line: string) => Span[]): Span[] {
  return text.split("\n").flatMap((line, at) => (at === 0 ? cut(line) : [{ text: "\n", kind: null }, ...cut(line)]));
}

/** A Markdown file: frontmatter as YAML, as the factory reads it off the top (`engine/frontmatter.py`); then its lines. */
function markdown(text: string): Span[] {
  const all = text.split("\n");
  const close = all[0]?.trim() === "---" ? all.findIndex((line, at) => at > 0 && line.trim() === "---") : -1;
  const spans: Span[] = [];
  let body = all;
  if (close > 0) {
    spans.push({ text: all[0], kind: "punct" }, { text: "\n", kind: null });
    spans.push(...yaml(all.slice(1, close).map((line) => `${line}\n`).join("")));
    spans.push({ text: all[close], kind: "punct" });
    body = all.slice(close + 1);
    if (body.length) spans.push({ text: "\n", kind: null });
  }
  let fenced = false;
  body.forEach((line, at) => {
    if (at > 0) spans.push({ text: "\n", kind: null });
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      spans.push({ text: line, kind: "punct" });
    } else if (fenced) spans.push({ text: line, kind: "code" });
    else spans.push(...prose(line));
  });
  return spans;
}

/** One line of Markdown prose: a heading, a quote, or a list item's marker and its inline code. */
function prose(line: string): Span[] {
  if (/^#{1,6}(\s|$)/.test(line)) return [{ text: line, kind: "heading" }];
  if (/^\s*>/.test(line)) return [{ text: line, kind: "comment" }];
  const item = /^(\s*)([-*+]|\d+[.)])(\s.*)$/.exec(line);
  if (item) return [{ text: item[1], kind: null }, { text: item[2], kind: "punct" }, ...inline(item[3])];
  return inline(line);
}

/** Inline code spans, `like this`, in a line of prose. */
function inline(text: string): Span[] {
  return text.split(/(`[^`\n]+`)/).map((part, at) => ({ text: part, kind: at % 2 === 1 ? "code" : null }));
}

/** A TOML line: a comment, a `[table]`, or `key = value`. */
function toml(line: string): Span[] {
  if (/^\s*#/.test(line)) return [{ text: line, kind: "comment" }];
  if (/^\s*\[/.test(line)) return [{ text: line, kind: "heading" }];
  const pair = /^(\s*)([^=\s][^=]*?)(\s*=\s*)(.*)$/.exec(line);
  if (!pair) return [{ text: line, kind: null }];
  const [, indent, key, equals, value] = pair;
  const kind: Kind = /^["']/.test(value) ? "string" : LITERAL.test(value.trim()) || /^\d{4}-\d\d-\d\d/.test(value) ? "literal" : null;
  return [{ text: indent, kind: null }, { text: key, kind: "key" }, { text: equals, kind: "punct" }, { text: value, kind }];
}

/** A sample's line: a comment, or `KEY=value`, `export` before it or not. */
function sample(line: string): Span[] {
  if (/^\s*#/.test(line)) return [{ text: line, kind: "comment" }];
  const pair = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)(=)(.*)$/.exec(line);
  if (!pair) return [{ text: line, kind: null }];
  const [, indent, exported = "", key, equals, value] = pair;
  return [
    { text: indent, kind: null }, { text: exported, kind: "meta" }, { text: key, kind: "key" },
    { text: equals, kind: "punct" }, { text: value, kind: "string" },
  ];
}
