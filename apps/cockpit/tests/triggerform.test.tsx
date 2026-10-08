// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Asked, TriggerFormView } from "../components/trigger/Trigger";

// The trigger form in a browser-shaped DOM (#156): a person picks a route
// from the shared Select, types an issue, and sends it — and an issue that is
// not a number says so under its field instead of being sent.

const ROUTES = {
  ok: true as const, queued: "asf:queued", running: "asf:running",
  routes: [{ label: "asf:ship", workflow: "issue" }, { label: "asf:refine", workflow: "refine" }],
};

function Harness({ onSubmit }: { onSubmit: (asked: Asked) => void }) {
  const [asked, setAsked] = useState<Asked>({ issue: "", label: "" });
  return (
    <TriggerFormView factory="acme/widgets" routes={ROUTES} asked={asked} busy={false} outcome={null} as="alex"
                     onChange={setAsked} onSubmit={() => onSubmit(asked)} />
  );
}

afterEach(cleanup);

describe("the trigger form, used", () => {
  it("sends the route chosen and the issue typed", async () => {
    const user = userEvent.setup();
    const sent = vi.fn();
    render(<Harness onSubmit={sent} />);

    expect(document.querySelector("select")).toBeNull();
    await user.click(screen.getByRole("combobox", { name: "Workflow" }));
    await user.click(await screen.findByRole("option", { name: "refine (asf:refine)" }));
    await user.type(screen.getByRole("textbox", { name: "Issue" }), "#42");
    await user.click(screen.getByRole("button", { name: "Trigger refine" }));

    expect(sent).toHaveBeenCalledWith({ issue: "42", label: "asf:refine" });
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
});
