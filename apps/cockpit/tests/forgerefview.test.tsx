import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ForgeRef } from "../components/icons";
import type { ItemState } from "../convex/forge/forge";

// An issue's and a pull request's icon says where it stands on the forge
// (#151), in the forge's own colours: open green, merged purple, closed red,
// a draft grey — and a closed issue purple, as the forge has it. Each tone is
// a token with a light and a dark value (globals.css). One whose state the
// cockpit does not know is drawn as before: the kind's icon, in no state.

/** The icon a reference to `#42` is drawn with: what it says it is, and its classes. */
function icon(kind: "issue" | "pr", state: ItemState | null): { label: string; classes: string[] } {
  const markup = renderToStaticMarkup(<ForgeRef kind={kind} href="" state={state}>#42</ForgeRef>);
  const svg = /<svg[^>]*>/.exec(markup)![0];
  return { label: /aria-label="([^"]*)"/.exec(svg)![1], classes: /class="([^"]*)"/.exec(svg)![1].split(" ") };
}

describe("a work item's icon", () => {
  it.each([
    ["issue open", "issue", "open", "lucide-circle-dot", "text-ok"],
    ["issue closed", "issue", "closed", "lucide-circle-check", "text-merged"],
    ["pull request open", "pr", "open", "lucide-git-pull-request", "text-ok"],
    ["pull request draft", "pr", "draft", "lucide-git-pull-request-draft", "text-faint"],
    ["pull request merged", "pr", "merged", "lucide-git-merge", "text-merged"],
    ["pull request closed", "pr", "closed", "lucide-git-pull-request-closed", "text-bad"],
  ] as const)("draws a(n) %s as the forge does", (label, kind, state, glyph, tone) => {
    const drawn = icon(kind, state);
    expect(drawn.label).toBe(label);
    expect(drawn.classes).toEqual(expect.arrayContaining([glyph, tone]));
  });

  it.each([
    ["issue", "issue", "lucide-circle-dot"],
    ["pull request", "pr", "lucide-git-pull-request"],
  ] as const)("draws a(n) %s whose state is not known as before, in no state's tone", (label, kind, glyph) => {
    const drawn = icon(kind, null);
    expect(drawn.label).toBe(label);
    expect(drawn.classes).toEqual(expect.arrayContaining([glyph, "text-faint"]));
  });
});
