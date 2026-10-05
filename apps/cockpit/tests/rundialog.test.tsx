import { describe, expect, it } from "vitest";
import { CLOSED, factoryInView, runDialog, runRedirect, workflowOf } from "../components/run/dialog";

// Run a prompt is one dialog, owned by the header (#108): it opens on every
// page with the factory in view chosen, offers only that factory's prompt
// workflows, never runs an empty prompt, and forgets the prompt on close.

describe("the factory in view", () => {
  it("is a factory page's, a session's, or the one a sessions list is filtered to", () => {
    expect(factoryInView("/factories/acme/widgets", "")).toBe("acme/widgets");
    expect(factoryInView("/sessions/acme/widgets/a9f259f0", "")).toBe("acme/widgets");
    expect(factoryInView("/sessions", "?factory=acme%2Fwidgets")).toBe("acme/widgets");
    expect(factoryInView("/factories/acme%20co/wid%2Dgets", "")).toBe("acme co/wid-gets");
  });

  it("is none anywhere else", () => {
    expect(factoryInView("/", "")).toBeNull();
    expect(factoryInView("/factories", "")).toBeNull();
    expect(factoryInView("/sessions", "")).toBeNull();
    expect(factoryInView("/stations", "?factory=acme/widgets")).toBeNull();
  });

  it("is none, rather than an error on every page, for a path that does not decode", () => {
    expect(factoryInView("/factories/acme/%E0%A4%A", "")).toBeNull();
  });
});

describe("the dialog's state", () => {
  const opened = runDialog(CLOSED, { type: "open", factory: "acme/widgets" });

  it("opens on the factory it is given, with no workflow picked and nothing typed", () => {
    expect(opened).toEqual({ open: true, factory: "acme/widgets", workflow: "", prompt: "" });
    expect(runDialog(CLOSED, { type: "open", factory: "acme/widgets", workflow: "quick" }).workflow).toBe("quick");
  });

  it("forgets the prompt when it closes, so it never reopens on a stale one", () => {
    const typed = runDialog(opened, { type: "prompt", prompt: "add a health check" });
    const closed = runDialog(typed, { type: "close" });
    expect(closed.open).toBe(false);
    expect(closed.prompt).toBe("");
    expect(runDialog(closed, { type: "open", factory: "acme/widgets" }).prompt).toBe("");
  });

  it("keeps the factory and workflow a person picks", () => {
    const picked = runDialog(runDialog(opened, { type: "factory", factory: "acme/gadgets" }), { type: "workflow", workflow: "do" });
    expect(picked).toMatchObject({ factory: "acme/gadgets", workflow: "do" });
  });
});

describe("the workflow the dialog runs", () => {
  it("is one of the chosen factory's prompt workflows: the one asked for, else its first", () => {
    expect(workflowOf("do", ["quick", "do"])).toBe("do");
    expect(workflowOf("", ["quick", "do"])).toBe("quick");
    // Asked for on another factory, which this one does not have.
    expect(workflowOf("nightly", ["quick", "do"])).toBe("quick");
    expect(workflowOf("quick", [])).toBe("");
  });
});

describe("the retired /run page", () => {
  it("sends a person back where they came from, with the dialog open", () => {
    expect(runRedirect("https://cockpit.acme.dev/sessions?factory=acme%2Fwidgets", "cockpit.acme.dev", ""))
      .toBe("/sessions?factory=acme%2Fwidgets&run=");
    expect(runRedirect("http://localhost:3000/stations", "localhost:3000", "")).toBe("/stations?run=");
  });

  it("opens the dialog on the factory an old link names", () => {
    expect(runRedirect("http://localhost:3000/factories/acme/widgets", "localhost:3000", "acme/gadgets"))
      .toBe("/factories/acme/widgets?run=acme%2Fgadgets");
    expect(runRedirect(null, "localhost:3000", "acme/gadgets")).toBe("/?run=acme%2Fgadgets");
  });

  it("goes to Now from anywhere else: another site, no referrer, or /run itself", () => {
    expect(runRedirect("https://elsewhere.example/factories/acme/widgets", "cockpit.acme.dev", "")).toBe("/?run=");
    expect(runRedirect(null, null, "")).toBe("/?run=");
    expect(runRedirect("http://localhost:3000/run?factory=x/y", "localhost:3000", "")).toBe("/?run=");
    expect(runRedirect("not a url", "localhost:3000", "")).toBe("/?run=");
  });
});
