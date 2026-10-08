// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Purge } from "../components/Purge";
import { More } from "../components/session/SessionView";
import type { Purged } from "../convex/retention";

// Purging a session's bodies from the session page's ⋯ menu, in a
// browser-shaped DOM (#171): a purge that went through closes its dialog —
// the page then says who purged which phase's bodies — and one that did not
// keeps it open, saying why, so the viewer can read it and try again. The
// Config tab's inline purge has nothing to close and reports in place.

/** Opens the purge dialog from the ⋯ menu, gives a reason and confirms. */
async function purgeFromMenu(onPurge: (reason: string) => Promise<Purged>) {
  const user = userEvent.setup();
  render(<More page={{ session: "a9f259f0", mayPurge: true }} onPurge={onPurge} />);
  await user.click(screen.getByRole("button", { name: "More" }));
  await user.click(await screen.findByRole("menuitem", { name: /Purge session/ }));
  await user.type(await screen.findByRole("textbox", { name: "Why" }), "a token in a prompt");
  await user.click(screen.getByRole("button", { name: "Purge bodies" }));
}

const dialog = () => screen.queryByRole("dialog");

afterEach(cleanup);

describe("the session page's purge dialog", () => {
  it("closes once the purge is done", async () => {
    const onPurge = vi.fn(() => Promise.resolve<Purged>({ ok: true }));
    await purgeFromMenu(onPurge);

    expect(onPurge).toHaveBeenCalledWith("a token in a prompt");
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it("stays open, saying why, when the purge is refused", async () => {
    await purgeFromMenu(() => Promise.resolve<Purged>({ ok: false, because: "only an admin of acme/widgets may purge" }));

    await waitFor(() => expect(screen.getByText("Not purged: only an admin of acme/widgets may purge")).toBeTruthy());
    expect(dialog()).not.toBeNull();
    expect((screen.getByRole("button", { name: "Purge bodies" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("stays open, saying what went wrong, when the purge fails", async () => {
    await purgeFromMenu(() => Promise.reject(new Error("the backend is unreachable")));

    await waitFor(() => expect(screen.getByText("Not purged: the backend is unreachable")).toBeTruthy());
    expect(dialog()).not.toBeNull();
  });
});

describe("the Config tab's inline purge", () => {
  it("reports a purge that went through in place", async () => {
    const user = userEvent.setup();
    render(<Purge label="Purge every session's bodies" explains="Removes them all." onPurge={() => Promise.resolve<Purged>({ ok: true })} />);

    await user.click(screen.getByText("Purge every session's bodies…"));
    await user.type(screen.getByRole("textbox", { name: "Why" }), "a key in a prompt");
    await user.click(screen.getByRole("button", { name: "Purge every session's bodies" }));

    await waitFor(() => expect(screen.getByText(/Purging: the bodies are going now/)).toBeTruthy());
  });
});
