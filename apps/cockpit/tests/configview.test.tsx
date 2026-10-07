import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfigEditorView, type Draft, proposedFile, unsaved } from "../components/factory/ConfigEditor";
import { ConfigTab } from "../components/factory/ConfigTab";
import { unified } from "../components/factory/diff";
import type { Page } from "../components/factory/view";
import type { Look } from "../convex/factory";
import { ViewerLogin } from "../components/viewer";
import { editRefusal } from "../convex/model/config";

// The Config tab's editor, rendered to static markup with no backend (spec
// #40, #58): disabled with the reason wherever the forge would refuse the
// push, a diff preview of what the pull request will carry, and a submit that
// YAML which does not parse blocks, with the parse error.

const BASE = "b".repeat(40);
const FORGE = "https://github.com";
const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const YAML = "# the budget\nlimits:\n  max_cost_usd: 2.5   # per session\n";

function page(fields: Partial<Page> = {}): Page {
  return {
    repo: "acme/widgets", onForge: true, private: false, defaultBranch: "main", role: "write", edit: null,
    check: null, stations: [], ...fields,
  };
}

const LOOK: Look = {
  ok: true, tip: BASE, files: ["asf/factory.yaml", "asf/agents/planner/agent.md"], distances: {}, proposals: [],
};

// Rendered for alex, the viewer the pull request goes up as.
function editor(drafts: Draft[], given: Partial<Parameters<typeof ConfigEditorView>[0]> = {}): string {
  return renderToStaticMarkup(
    <ViewerLogin.Provider value="alex">
      <ConfigEditorView forge="https://github.com" repo="acme/widgets" base={BASE} into="main" as="alex" drafts={drafts} shown={drafts[0]?.path ?? null} loading={null}
                        files={drafts.map((draft) => draft.path)} switchingTo={null} onAnswer={() => undefined}
                        asked={{ title: "Raise the budget", description: "" }} busy={false} outcome={null}
                        onText={() => undefined} onOpen={() => undefined} onDiscard={() => undefined}
                        onChange={() => undefined} onSubmit={() => undefined} {...given} />
    </ViewerLogin.Provider>);
}

describe("the Config tab's Edit config", () => {
  it("is one action, not a list of the files it edits", () => {
    const html = renderToStaticMarkup(
      <ConfigTab page={page()} look={LOOK} drifts={new Map()} forge={FORGE} now={NOW} onEdit={() => undefined} />);

    expect(html.match(/<button[^>]*>Edit config<\/button>/g)?.length).toBe(1);
    expect(html).not.toMatch(/<button[^>]*>Edit<\/button>/);
    expect(html).not.toContain("asf/agents/planner/agent.md");
    expect(html).not.toContain(' disabled=""');
  });

  it("cannot be used without write access, and says why", () => {
    const because = editRefusal("triage")!;
    const html = renderToStaticMarkup(
      <ConfigTab page={page({ edit: because })} look={LOOK} drifts={new Map()} forge={FORGE} now={NOW}
                 onEdit={() => undefined} />);

    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Edit config<\/button>/);
    expect(html).toContain(because);
  });

  it("cannot be used while the forge shows no file to edit", () => {
    const html = renderToStaticMarkup(
      <ConfigTab page={page()} look={{ ...LOOK, files: [] }} drifts={new Map()} forge={FORGE} now={NOW} onEdit={() => undefined} />);

    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Edit config<\/button>/);
  });
});

describe("the editor's files", () => {
  const FILES = ["asf/agents/planner/agent.md", "asf/factory.yaml"];
  const changed: Draft = { path: "asf/factory.yaml", original: YAML, crlf: false, text: YAML.replace("2.5", "5") };

  it("are a nav down the side, and a picker on a phone, the one open marked", () => {
    const html = editor([changed], { files: FILES });

    const nav = html.slice(html.indexOf("<nav"), html.indexOf("</nav>"));
    expect(nav).toContain('aria-label="Files"');
    expect(nav.match(/<button/g)?.length).toBe(2);
    expect(nav).toMatch(/<button[^>]*aria-current="true"[^>]*>.*?factory\.yaml/);
    expect(nav).not.toMatch(/<button[^>]*aria-current="true"[^>]*>.*?agent\.md/);
    expect(html).toMatch(/<select[^>]*>.*<option value="asf\/agents\/planner\/agent.md">.*<option value="asf\/factory.yaml" selected="">/s);
  });

  it("mark the one with changes not yet proposed", () => {
    const html = editor([changed, { path: "asf/agents/planner/agent.md", original: "x\n", crlf: false, text: "x\n" }], { files: FILES });

    expect(html).toMatch(/factory\.yaml<\/code><span aria-hidden="true"[^>]*>•<\/span><span class="sr-only">changed<\/span>/);
    expect(html).not.toMatch(/agent\.md<\/code><span aria-hidden="true"/);
  });

  it("ask before switching discards a file's changes", () => {
    const html = editor([changed], { files: FILES, switchingTo: "asf/agents/planner/agent.md" });

    expect(html).toMatch(/role="alertdialog"/);
    expect(html).toMatch(/<code>asf\/factory\.yaml<\/code> has changes that are not proposed\. Discard them and open <code>asf\/agents\/planner\/agent\.md<\/code>\?/);
    expect(html).toMatch(/<button[^>]*>Discard and open<\/button>/);
    expect(html).toMatch(/<button[^>]*>Keep editing<\/button>/);
    expect(editor([changed], { files: FILES })).not.toContain("alertdialog");
  });

  it("switch at once when nothing would be lost, and ask when something would", () => {
    expect(unsaved([changed], "asf/factory.yaml")).toBe(true);
    expect(unsaved([{ ...changed, text: changed.original }], "asf/factory.yaml")).toBe(false);
    expect(unsaved([changed], "asf/agents/planner/agent.md")).toBe(false);
    expect(unsaved([], null)).toBe(false);
  });
});

describe("the editor", () => {
  it("previews the diff the pull request will carry, and opens it as the viewer", () => {
    const html = editor([{ path: "asf/factory.yaml", original: YAML, crlf: false, text: YAML.replace("2.5", "5") }]);

    expect(html).toContain("<textarea");
    expect(html).toMatch(/<span data-line="del"[^>]*>-  max_cost_usd: 2.5   # per session\n<\/span>/);
    expect(html).toMatch(/<span data-line="add"[^>]*>\+  max_cost_usd: 5   # per session\n<\/span>/);
    expect(html).not.toMatch(/<span data-line="(add|del)"[^>]*>(\+\+\+|---) /);       // the file's own header lines are no change
    expect(html).toContain("cockpit/alex/raise-the-budget");
    expect(html).toMatch(new RegExp(`href="https://github.com/acme/widgets/tree/main"[^>]*><svg [^>]*aria-label="branch".*?main</span></a> at <code>${BASE.slice(0, 7)}</code>`));
    // The viewer's own login reads "you"; the branch keeps the login it is named by.
    expect(html).toContain("comments and all — as you, on");
    expect(html).toMatch(/<button type="submit"[^>]*>Open pull request as you<\/button>/);
    expect(html).not.toMatch(/<button type="submit"[^>]* disabled=""/);
  });

  it("blocks submission with the parse error while the YAML does not parse", () => {
    const html = editor([{ path: "asf/factory.yaml", original: YAML, crlf: false, text: "limits:\n  max_cost_usd: [5\n" }]);

    expect(html).toMatch(/asf\/factory\.yaml, line \d+, column \d+: /);
    expect(html).toMatch(/<button type="submit"[^>]*disabled=""/);
  });

  it("has nothing to submit until something changed, or without a title", () => {
    const unchanged = editor([{ path: "asf/factory.yaml", original: YAML, crlf: false, text: YAML }]);
    expect(unchanged).toContain("Nothing changed yet");
    expect(unchanged).toMatch(/<button type="submit"[^>]*disabled=""/);

    const untitled = editor([{ path: "asf/factory.yaml", original: YAML, crlf: false, text: `${YAML}# more\n` }],
                            { asked: { title: "", description: "" } });
    expect(untitled).toMatch(/<button type="submit"[^>]*disabled=""/);
  });

  it("proposes a CRLF file in its own line endings, though the editor holds it as LF", () => {
    const draft = { path: "asf/factory.yaml", original: YAML, text: YAML.replace("2.5", "5"), crlf: true };
    expect(proposedFile(draft)).toEqual({ path: "asf/factory.yaml", content: YAML.replace("2.5", "5").replace(/\n/g, "\r\n") });
    expect(proposedFile({ ...draft, crlf: false }).content).toBe(draft.text);
  });

  it("links the pull request it opened, or says why it did not", () => {
    expect(editor([], {
      outcome: { ok: true, number: 7, url: "https://github.com/acme/widgets/pull/7", branch: "cockpit/alex/raise-the-budget",
                 paths: ["asf/factory.yaml"] },
    })).toMatch(/<a [^>]*href="https:\/\/github.com\/acme\/widgets\/pull\/7" target="_blank" rel="noreferrer"><svg [^>]*aria-label="pull request".*?#7<\/span><\/a> from <a [^>]*href="https:\/\/github.com\/acme\/widgets\/tree\/cockpit\/alex\/raise-the-budget"/);
    expect(editor([], { outcome: { ok: false, because: "the forge answered 403" } }))
      .toContain("Not opened: the forge answered 403.");
  });
});

describe("the diff preview", () => {
  it("is a unified diff of the changed lines, with three lines of context", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", ""].join("\n");
    const after = before.replace("e\n", "E\n");

    expect(unified("asf/x.yaml", before, after)).toBe([
      "--- a/asf/x.yaml", "+++ b/asf/x.yaml", "@@ -2,7 +2,7 @@", " b", " c", " d", "-e", "+E", " f", " g", " h", "",
    ].join("\n"));
  });

  it("is empty when nothing changed, and says when the last line lost its newline", () => {
    expect(unified("asf/x.yaml", "a\n", "a\n")).toBe("");
    expect(unified("asf/x.yaml", "a\n", "a")).toBe(
      ["--- a/asf/x.yaml", "+++ b/asf/x.yaml", "@@ -1 +1 @@", "-a", "+a", "\\ No newline at end of file", ""].join("\n"));
  });
});
