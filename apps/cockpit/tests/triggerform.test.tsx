// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Asked, TriggerFormView } from "../components/trigger/Trigger";
import type { Offered } from "../convex/trigger";

// The Trigger a workflow dialog's form in a browser-shaped DOM (#156): a
// person picks a factory and a route from the shared Selects, types an issue,
// and sends it — and an issue that is not a number says so under its field
// instead of being sent.

const ROUTES: Record<string, Offered> = {
  "acme/widgets": { ok: true, queued: "asf:queued", running: "asf:running", routes: [{ label: "asf:ship", workflow: "issue" }] },
  "acme/gadgets": {
    ok: true, queued: "asf:queued", running: "asf:running",
    routes: [{ label: "asf:ship", workflow: "issue" }, { label: "asf:refine", workflow: "refine" }],
  },
};

function Harness({ onSubmit, onCancel = () => undefined }: { onSubmit: (asked: Asked) => void; onCancel?: () => void }) {
  const [asked, setAsked] = useState<Asked>({ factory: "acme/widgets", issue: "", label: "" });
  return (
    <TriggerFormView factories={Object.keys(ROUTES).sort()} routes={ROUTES[asked.factory] ?? null} asked={asked} busy={false}
                     outcome={null} as="alex" onChange={setAsked} onSubmit={() => onSubmit(asked)} onCancel={onCancel} />
  );
}

afterEach(cleanup);

describe("the trigger form, used", () => {
  it("sends the factory and route chosen, and the issue typed", async () => {
    const user = userEvent.setup();
    const sent = vi.fn();
    render(<Harness onSubmit={sent} />);

    await user.click(screen.getByRole("combobox", { name: "Factory" }));
    await user.click(await screen.findByRole("option", { name: "acme/gadgets" }));
    await user.click(screen.getByRole("combobox", { name: "Workflow" }));
    await user.click(await screen.findByRole("option", { name: "refine (asf:refine)" }));
    await user.type(screen.getByRole("textbox", { name: "Issue" }), "#42");
    await user.click(screen.getByRole("button", { name: "Trigger refine" }));

    expect(sent).toHaveBeenCalledWith({ factory: "acme/gadgets", issue: "42", label: "asf:refine" });
  });

  it("says when the issue is not a positive whole number, and sends nothing", async () => {
    const user = userEvent.setup();
    const sent = vi.fn();
    render(<Harness onSubmit={sent} />);

    await user.type(screen.getByRole("textbox", { name: "Issue" }), "4.2");
    await user.click(screen.getByRole("button", { name: "Trigger issue" }));

    await waitFor(() => expect(screen.getByText(/positive whole number/)).toBeTruthy());
    expect(sent).not.toHaveBeenCalled();
  });

  it("closes on Cancel, sending nothing", async () => {
    const user = userEvent.setup();
    const sent = vi.fn();
    const cancelled = vi.fn();
    render(<Harness onSubmit={sent} onCancel={cancelled} />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(cancelled).toHaveBeenCalledOnce();
    expect(sent).not.toHaveBeenCalled();
  });
});
