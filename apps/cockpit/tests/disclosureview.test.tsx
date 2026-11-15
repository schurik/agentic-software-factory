// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { PhaseTabs } from "../components/session/PhaseTabs";
import type { Phase } from "../convex/model/graph";
import type { PhaseDetail } from "../convex/model/phase";
import type { Row } from "../convex/model/session";

// A disclosure in the cockpit, clicked in a browser-shaped DOM (#286): a
// row's arrow on a phase's Events tab opens onto the event as it was sent,
// formatted, and closes again. The native <details> it replaces opened
// nothing in the drawer, whose swipe took the press; happy-dom has no swipe,
// so what this file proves is the disclosure, and the guard below that no
// <details> comes back.

/** A phase with nothing on its other tabs: under happy-dom vite will not load the golden corpus. */
const BARE = {
  kind: "code", commits: [], artifacts: [], checks: [], rejections: [], commands: [], toolCalls: 0, transcripts: false,
} as unknown as PhaseDetail;

const ROWS: Row[] = [{
  seq: 24, ts: "2026-11-15T09:30:00.000Z", kind: "phase_started", v: 1, unreadBecause: null,
  detail: "implement started · agent builder · stage 1 of its chapter",
  raw: '{"phase_id":"1d795115_24_implement","agent":"builder","attempt":1,"ok":true}',
}];

const sources = import.meta.glob(["../components/**/*.tsx", "../app/**/*.tsx"],
                                 { eager: true, query: "?raw", import: "default" }) as Record<string, string>;

afterEach(cleanup);

describe("an event's row on the Events tab", () => {
  it("opens on a click to the event as it was sent, its JSON formatted, and closes on the next", async () => {
    const user = userEvent.setup();
    render(<PhaseTabs item={{} as Phase} detail={BARE} where={{ factory: "acme/widgets", session: "1d795115", forge: "" }}
                      tab="events" loaded={{ events: ROWS }} />);
    const arrow = screen.getByRole("button", { name: /implement started · agent builder/ });
    const payload = screen.getByRole("row", { name: /implement started/ }).querySelector("pre")!;
    // Shut, it is still in the page, as a <details> keeps it: hidden until found, so the browser's find reaches it.
    const hidden = () => payload.closest("[hidden]")?.getAttribute("hidden") ?? null;
    expect(arrow.getAttribute("aria-expanded")).toBe("false");
    expect(hidden()).toBe("until-found");

    await user.click(arrow);
    expect(arrow.getAttribute("aria-expanded")).toBe("true");
    expect(hidden()).toBeNull();
    expect(payload.textContent).toBe([
      "{",
      '  "phase_id": "1d795115_24_implement",',
      '  "agent": "builder",',
      '  "attempt": 1,',
      '  "ok": true',
      "}",
    ].join("\n"));

    await user.click(arrow);
    expect(arrow.getAttribute("aria-expanded")).toBe("false");
    expect(hidden()).toBe("until-found");
  });
});

describe("every disclosure in the cockpit", () => {
  it("is base-ui's Collapsible, never a native <details>, whose click the drawer's swipe takes", () => {
    // Drawn, that is: prose that names one, in backquotes, is not one.
    expect(Object.entries(sources).filter(([, source]) => /(?<!`)<details\b/.test(source)).map(([path]) => path)).toEqual([]);
  });
});
