import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { type Asked, notAnIssue, TriggerButton, TriggerFormView } from "../components/trigger/Trigger";
import { buttonClass } from "../components/ui";

// The trigger on a factory's page, rendered to static markup with no
// backend: a button that is disabled, with the reason, wherever the forge
// would refuse the label (spec #40), and a form that says what pressing it does.

const ROUTES = {
  ok: true as const, queued: "asf:queued", running: "asf:running",
  routes: [{ label: "asf:ship", workflow: "issue" }, { label: "asf:refine", workflow: "refine" }],
};

function form(asked: Asked, given: Partial<Parameters<typeof TriggerFormView>[0]> = {}): string {
  return renderToStaticMarkup(
    <TriggerFormView factory="acme/widgets" routes={ROUTES} asked={asked} busy={false} outcome={null} as="alex"
                     onChange={() => undefined} onSubmit={() => undefined} {...given} />);
}

describe("the trigger button", () => {
  it("is disabled below triage, saying why", () => {
    const html = renderToStaticMarkup(<TriggerButton role="read" open={false} onToggle={() => undefined} />);
    expect(html).toMatch(/<button[^>]*disabled=""/);
    expect(html).toContain("triggering needs triage or higher on this repository, and the forge says you have read");
  });

  it("is enabled from triage up", () => {
    const html = renderToStaticMarkup(<TriggerButton role="triage" open={false} onToggle={() => undefined} />);
    expect(html).not.toContain(' disabled=""');
  });

  it("is a primary action, like every other one in the cockpit (#156)", () => {
    const html = renderToStaticMarkup(<TriggerButton role="triage" open={false} onToggle={() => undefined} />);
    expect(html).toContain(`class="${buttonClass("primary", "sm")}"`);
  });
});

describe("the trigger form", () => {
  it("says which labels it adds, as whom, and that the watcher starts the run", () => {
    const html = form({ issue: "42", label: "asf:refine" });
    expect(html).toContain("Adds <code>asf:refine</code> and <code>asf:queued</code> to the issue as alex");
    expect(html).toContain("Trigger refine");
    expect(html).not.toContain(' disabled=""');
  });

  it("picks the workflow with the shared Select, never a native one (#156)", () => {
    const html = form({ issue: "42", label: "asf:refine" });
    expect(html).not.toContain("<select");
    expect(html).toMatch(/role="combobox"[^>]*>.*refine \(asf:refine\)/);
  });

  it("takes an issue as a positive whole number", () => {
    expect(notAnIssue("42")).toBeNull();
    for (const typed of ["", "0", "-3", "4.2", "1e3", "abc"]) expect(notAnIssue(typed)).toMatch(/positive whole number/);
  });

  it("waits for an issue number before it can be sent", () => {
    expect(form({ issue: "", label: "" })).toMatch(/<button type="submit"[^>]*disabled=""/);
  });

  it("says why nothing can be triggered on a repository the factory never labelled", () => {
    const html = form({ issue: "", label: "" }, {
      routes: { ok: false, because: "the forge defines no route label this factory made: run `asf labels --create`" },
    });
    expect(html).toContain("Nothing can be triggered on acme/widgets from here");
    expect(html).not.toContain("<form");
  });

  it("links the issue it labelled, or says why it did not", () => {
    expect(form({ issue: "42", label: "" }, {
      outcome: { ok: true, workflow: "issue", title: "health check broken", url: "https://github.com/acme/widgets/issues/42" },
    })).toMatch(/<a [^>]*href="https:\/\/github.com\/acme\/widgets\/issues\/42" target="_blank" rel="noreferrer"><svg [^>]*aria-label="issue open".*?#42 health check broken<\/span><\/a>: issue starts when the factory&#x27;s issues watcher next polls/);
    expect(form({ issue: "43", label: "" }, { outcome: { ok: false, because: "#43 is closed" } }))
      .toContain("Not triggered: #43 is closed.");
  });
});
