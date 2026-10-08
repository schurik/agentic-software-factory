import { describe, expect, it } from "vitest";
import { highlight, type Span } from "../components/factory/highlight";

// The config editor's highlighting (#157): the text cut into spans, each of a
// kind the editor colours. It is drawn under the textarea, glyph for glyph, so
// the one thing it may never do is change the text: every span, in order, is
// the file exactly as it was given.

/** The spans of one kind, as text. */
const of = (spans: Span[], kind: Span["kind"]) => spans.filter((span) => span.kind === kind).map((span) => span.text);

const FACTORY = [
  "# The factory's config.",
  "defaults:",
  "  harness: claude_code   # which harness",
  "limits:",
  "  max_cost_usd: 2.5",
  "  strict: true",
  "routes:",
  '  - "asf:ship"',
  "  - &anchor plain words",
  "  - *anchor",
  "flow: {k: v, \"quoted key\": 1}",
  "body: |",
  "  kept as written",
  "",
].join("\n");

describe("highlighting", () => {
  it("never changes the text: the spans are the file, in order", () => {
    for (const [path, text] of [
      ["asf/factory.yaml", FACTORY],
      ["asf/agents/planner/agent.md", "---\nmodel: sonnet\n---\n# Plan\n\n- one `two`\n```\ncode: x\n```\n> quoted\n"],
      ["asf/pyproject.toml", "# c\n[tool.asf]\nname = \"x\"\nn = 3\n"],
      ["asf/env.sample", "# Keys\nexport ANTHROPIC_API_KEY=\nMODE=local\n"],
      ["asf/data.json", '{"a": [1, true, null], "b": "c"}\n'],
      ["asf/notes.txt", "just words\n"],
      ["asf/factory.yaml", "a: [1\nb: \"unclosed\n\t- odd: : :\n"],
    ]) {
      expect(highlight(path, text).map((span) => span.text).join(""), path).toBe(text);
    }
  });

  it("tells a YAML file's keys, values, numbers, comments, indicators and anchors apart", () => {
    const spans = highlight("asf/factory.yaml", FACTORY);

    expect(of(spans, "key")).toEqual(["defaults", "harness", "limits", "max_cost_usd", "strict", "routes", "flow", "k", '"quoted key"', "body"]);
    expect(of(spans, "string")).toEqual(["claude_code", '"asf:ship"', "plain words", "v", "  kept as written\n"]);
    expect(of(spans, "literal")).toEqual(["2.5", "true", "1"]);
    expect(of(spans, "comment")).toEqual(["# The factory's config.", "# which harness"]);
    expect(of(spans, "meta")).toEqual(["&anchor", "*anchor"]);
    expect(of(spans, "punct")).toContain("|");
  });

  it("reads JSON as the YAML it is", () => {
    const spans = highlight("asf/data.json", '{"a": [1, true, null], "b": "c"}\n');
    expect(of(spans, "key")).toEqual(['"a"', '"b"']);
    expect(of(spans, "literal")).toEqual(["1", "true", "null"]);
    expect(of(spans, "string")).toEqual(['"c"']);
  });

  it("highlights a Markdown file's frontmatter as YAML, and its headings, lists, code and quotes", () => {
    const spans = highlight("asf/agents/planner/agent.md",
                            "---\nmodel: sonnet\n---\n# Plan\n\n- one `two`\n```\ncode: x\n```\n> quoted\n");

    expect(of(spans, "key")).toEqual(["model"]);
    expect(of(spans, "string")).toEqual(["sonnet"]);
    expect(of(spans, "heading")).toEqual(["# Plan"]);
    expect(of(spans, "code")).toEqual(["`two`", "code: x"]);
    expect(of(spans, "punct")).toEqual(["---", ":", "---", "-", "```", "```"]);
    expect(of(spans, "comment")).toEqual(["> quoted"]);
  });

  it("highlights TOML's tables, keys and values, and a sample's variables", () => {
    const toml = highlight("asf/pyproject.toml", "# c\n[tool.asf]\nname = \"x\"\nn = 3\n");
    expect(of(toml, "comment")).toEqual(["# c"]);
    expect(of(toml, "heading")).toEqual(["[tool.asf]"]);
    expect(of(toml, "key")).toEqual(["name", "n"]);
    expect(of(toml, "string")).toEqual(['"x"']);
    expect(of(toml, "literal")).toEqual(["3"]);

    const sample = highlight("asf/env.sample", "# Keys\nexport ANTHROPIC_API_KEY=\nMODE=local\n");
    expect(of(sample, "comment")).toEqual(["# Keys"]);
    expect(of(sample, "meta")).toEqual(["export "]);
    expect(of(sample, "key")).toEqual(["ANTHROPIC_API_KEY", "MODE"]);
    expect(of(sample, "string")).toEqual(["local"]);
  });

  it("leaves plain text plain", () => {
    expect(highlight("asf/notes.txt", "just words\n")).toEqual([{ text: "just words\n", kind: null }]);
  });
});
