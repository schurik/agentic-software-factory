import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { type Asked, TriggerFormView } from "../components/trigger/Trigger";
import { notAnIssue, refusal } from "../convex/model/trigger";

// The Trigger a workflow dialog's body, rendered to static markup with no
// backend: the factory and its route, the issue, and what pressing Trigger
// does (spec #40) — or, on a factory the forge would refuse the label on,
// why nothing can be triggered there. The header's button opens it on any
// factory, so the form is where that is said (#156).

const ROUTES = {
  ok: true as const, queued: "asf:queued", running: "asf:running",
  routes: [{ label: "asf:ship", workflow: "issue" }, { label: "asf:refine", workflow: "refine" }],
};

const asked = (given: Partial<Asked> = {}): Asked => ({ factory: "acme/widgets", issue: "", label: "", ...given });

function form(shown: Asked, given: Partial<Parameters<typeof TriggerFormView>[0]> = {}): string {
  return renderToStaticMarkup(
    <TriggerFormView factories={["acme/gadgets", "acme/widgets"]} routes={ROUTES} asked={shown} busy={false} problem="" as="alex"
                     onChange={() => undefined} onSubmit={() => undefined} onCancel={() => undefined} {...given} />);
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const submit = (html: string) => html.match(/<button type="submit"[^>]*>[^<]*<\/button>/)![0];

describe("the trigger form", () => {
  it("is the factory and workflow, the issue, then Cancel and Trigger", () => {
    const html = form(asked({ issue: "42", label: "asf:refine" }));
    expect(text(html)).toMatch(/Factory acme\/widgets .*Workflow refine \(asf:refine\) .*Issue .*Cancel Trigger refine/);
    expect(html).not.toContain("<select");
  });

  it("says which labels it adds, as whom, and that the watcher starts the run", () => {
    const html = form(asked({ issue: "42", label: "asf:refine" }));
    expect(html).toContain("Adds <code>asf:refine</code> and <code>asf:queued</code> to the issue as alex");
    expect(submit(html)).not.toContain(' disabled=""');
  });

  it("waits for an issue number before it can be sent", () => {
    expect(submit(form(asked()))).toContain(' disabled=""');
  });

  it("takes an issue as a positive whole number", () => {
    expect(notAnIssue("42")).toBeNull();
    for (const typed of ["", "0", "-3", "4.2", "1e3", "abc"]) expect(notAnIssue(typed)).toMatch(/positive whole number/);
  });

  it("says it is reading the factory's routes while it is", () => {
    const html = form(asked({ issue: "42" }), { routes: null });
    expect(html).toContain("Reading acme/widgets&#x27;s route labels from the forge…");
    expect(submit(html)).toContain(' disabled=""');
  });

  it("says why nothing can be triggered on a factory, and still offers the others", () => {
    for (const because of [refusal("read")!, "the forge defines no route label this factory made: run `asf labels --create`"]) {
      const html = form(asked({ issue: "42" }), { routes: { ok: false, because } });
      expect(text(html)).toContain(`Nothing can be triggered on acme/widgets from here: ${because}.`);
      expect(submit(html)).toContain(' disabled=""');
      expect(html).toMatch(/aria-label="Factory"|>Factory</);
    }
  });

  it("says when the viewer can read no factory to trigger", () => {
    expect(form(asked({ factory: "" }), { factories: [], routes: null })).toContain("You can read no factory on the forge yet.");
    expect(form(asked({ factory: "" }), { routes: null })).not.toContain("Reading");
  });

  it("says why the forge refused it, and nothing until it has", () => {
    expect(form(asked({ issue: "43" }), { problem: "#43 is closed" })).toContain("Not triggered: #43 is closed.");
    expect(form(asked({ issue: "43" }))).not.toContain("Not triggered");
  });
});
