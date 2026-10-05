import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiffRead, DiffView } from "../components/diff/DiffView";
import { filesOf } from "../components/diff/files";

// A diff as the forge prints it (`application/vnd.github.diff`), drawn the way
// a browser first paints it. diffs.test.ts says where the text comes from;
// this says what a person reads of it.

const DIFF = [
  "diff --git a/app.py b/app.py",
  "index 1111111..2222222 100644",
  "--- a/app.py",
  "+++ b/app.py",
  "@@ -1,4 +1,4 @@",
  " import os",
  "-ok = 0",
  "+ok = 1",
  " ",
  " def health():",
  "@@ -20 +20,3 @@ def health():",
  "     return ok",
  "+",
  "+# done",
  "diff --git a/docs/plan.md b/docs/plan.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/docs/plan.md",
  "@@ -0,0 +1,2 @@",
  "+# Plan",
  "+Register /health in app.py, and a test that calls it over the wire with a timeout.",
  "diff --git a/old.txt b/old.txt",
  "deleted file mode 100644",
  "--- a/old.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-gone",
  "diff --git a/logo.png b/logo.png",
  "new file mode 100644",
  "Binary files /dev/null and b/logo.png differ",
  "diff --git a/src/x.py b/src/y.py",
  "similarity index 100%",
  "rename from src/x.py",
  "rename to src/y.py",
  "",
].join("\n");

function read(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
}

/** One file's block, by its path. */
function file(markup: string, path: string): string {
  const from = markup.indexOf(`data-file="${path}"`);
  if (from === -1) throw new Error(`no file ${path} drawn`);
  const next = markup.indexOf("data-file=", from + 1);
  return markup.slice(markup.lastIndexOf("<", from), next === -1 ? undefined : markup.lastIndexOf("<", next));
}

describe("the forge's diff, read into files", () => {
  it("names each file once, says what became of it, and counts its lines", () => {
    expect(filesOf(DIFF).map(({ path, from, change, binary, added, removed }) => ({ path, from, change, binary, added, removed })))
      .toEqual([
        { path: "app.py", from: null, change: "modified", binary: false, added: 3, removed: 1 },
        { path: "docs/plan.md", from: null, change: "added", binary: false, added: 2, removed: 0 },
        { path: "old.txt", from: null, change: "deleted", binary: false, added: 0, removed: 1 },
        { path: "logo.png", from: null, change: "added", binary: true, added: 0, removed: 0 },
        { path: "src/y.py", from: "src/x.py", change: "renamed", binary: false, added: 0, removed: 0 },
      ]);
  });

  it("numbers each line on the side it is on, from the hunk's header", () => {
    const [app] = filesOf(DIFF);
    expect(app.hunks.map((hunk) => hunk.header)).toEqual(["@@ -1,4 +1,4 @@", "@@ -20 +20,3 @@"]);
    expect(app.hunks[1].lines.map(({ sign, old, now }) => [sign, old, now])).toEqual([
      [" ", 20, 20], ["+", null, 21], ["+", null, 22],
    ]);
  });

  it("keeps a new file's header as git writes it, from line 0", () => {
    expect(filesOf(DIFF)[1].hunks[0].header).toBe("@@ -0,0 +1,2 @@");
    expect(filesOf(DIFF)[2].hunks[0].header).toBe("@@ -1 +0,0 @@");
  });

  it("is nothing for an empty diff", () => {
    expect(filesOf("")).toEqual([]);
  });
});

describe("the viewer", () => {
  const unified = renderToStaticMarkup(<DiffView text={DIFF} title="asf/a9f259f0 against main" />);

  it("opens on a summary line: what is compared, how many files, and the lines added and removed", () => {
    expect(read(unified)).toMatch(/^ ?asf\/a9f259f0 against main · 5 files changed \+5 −2 /);
  });

  it("is unified until split, and offers the switch only where there is room for two columns", () => {
    expect(unified).toMatch(/<button[^>]*aria-pressed="true"[^>]*>.*?Unified/);
    expect(unified).toMatch(/<button[^>]*aria-pressed="false"[^>]*>.*?Split/);
    expect(unified).toMatch(/<div[^>]*class="[^"]*max-md:hidden[^"]*"[^>]*>(?:(?!<\/div>).)*Unified/);
  });

  it("draws each file collapsible and open, with what became of it and its lines added and removed", () => {
    expect(unified.match(/<button[^>]*aria-expanded="true"/g)).toHaveLength(5);
    expect(read(file(unified, "docs/plan.md"))).toMatch(/docs\/plan\.md new \+2 −0/);
    expect(read(file(unified, "app.py"))).toMatch(/app\.py \+3 −1/);
    expect(read(file(unified, "old.txt"))).toMatch(/old\.txt deleted \+0 −1/);
    expect(read(file(unified, "src/y.py"))).toMatch(/src\/x\.py → src\/y\.py renamed/);
    expect(read(file(unified, "logo.png"))).toContain("A binary file: nothing to show.");
  });

  it("draws each hunk under its header, each line with its old and new numbers", () => {
    const app = file(unified, "app.py");
    expect(read(app)).toContain("@@ -20 +20,3 @@");
    expect(app).toMatch(/data-line="del"[^>]*><span data-n="old"[^>]*>2<\/span><span data-n="new"[^>]*><\/span>/);
    expect(app).toMatch(/data-line="add"[^>]*><span data-n="old"[^>]*><\/span><span data-n="new"[^>]*>2<\/span>/);
    expect(app).toMatch(/data-line="ctx"[^>]*><span data-n="old"[^>]*>20<\/span><span data-n="new"[^>]*>20<\/span>/);
  });

  it("marks the words that changed inside a changed line", () => {
    const app = file(unified, "app.py");
    expect(app).toMatch(/<span data-word="del"[^>]*>0<\/span>/);
    expect(app).toMatch(/<span data-word="add"[^>]*>1<\/span>/);
    // A line added with nothing removed for it has no words to mark: it is all new.
    expect(file(unified, "docs/plan.md")).not.toContain("data-word");
  });

  it("wraps prose, and keeps code in its columns, scrolling", () => {
    expect(file(unified, "docs/plan.md")).toContain("whitespace-pre-wrap");
    expect(file(unified, "docs/plan.md")).not.toMatch(/whitespace-pre(?!-wrap)/);
    expect(file(unified, "app.py")).toMatch(/whitespace-pre(?!-wrap)/);
    expect(file(unified, "app.py")).toContain("overflow-x-auto");
  });

  it("puts what was removed on the left and what was added on the right, split", () => {
    const whole = renderToStaticMarkup(<DiffView text={DIFF} defaultSplit />);
    expect(whole).toMatch(/<button[^>]*aria-pressed="true"[^>]*>.*?Split/);
    const split = file(whole, "app.py");
    // One row: the old line, then the new one beside it.
    expect(split).toMatch(/data-side="old" data-line="del"(?:(?!data-side).)*ok = (?:(?!data-side).)*data-side="new" data-line="add"/);
  });
});

describe("a diff read from the forge", () => {
  const title = "asf/a9f259f0 against main";

  it("says it is being read until it is", () => {
    expect(read(renderToStaticMarkup(<DiffRead got={null} title={title} />))).toContain("Reading the diff from the forge…");
  });

  it("says it cannot read the diff, and why, instead of showing nothing", () => {
    const got = { ok: false as const, because: "this cockpit has no forge credential to read it with" };
    expect(read(renderToStaticMarkup(<DiffRead got={got} title={title} />)))
      .toMatch(/asf\/a9f259f0 against main .*Cannot read the diff: this cockpit has no forge credential to read it with\./);
  });

  it("says when there is nothing in it", () => {
    expect(read(renderToStaticMarkup(<DiffRead got={{ ok: true, diff: "" }} title={title} />))).toContain("No changes.");
  });
});
