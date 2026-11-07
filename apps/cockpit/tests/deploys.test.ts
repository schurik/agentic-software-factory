import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { type Build, buildFromEnv } from "../convex/model/build";
import { fakeForge } from "./forge";
import { cockpit, signIn, team } from "./helpers";

// The cockpit's own deploys (deploys.ts): `docker/start.sh` records the build
// its image carries once the functions are pushed, and the footer lists them.
// A deploy is a new image starting here; the same one starting again is a
// restart, and a build CI did not make says nothing worth recording.

const NOW = Date.parse("2026-11-07T12:00:00.000Z");

const MAIN: Build = {
  ref: "main", version: "1.3.0", commit: "a".repeat(40), builtAt: "2026-11-07T11:50:00Z", number: "42",
  runUrl: "https://github.com/acme/asf/actions/runs/1", source: "https://github.com/acme/asf",
};
const NEXT: Build = { ...MAIN, commit: "b".repeat(40), builtAt: "2026-11-07T13:10:00Z", number: "43" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("COCKPIT_MODE", "local");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("recording a deploy", () => {
  it("adds a row for a new build, none for the same image started again, and lists the newest first", async () => {
    const t = cockpit();
    expect(await t.mutation(internal.deploys.record, { build: MAIN })).toBe("recorded");
    vi.setSystemTime(NOW + 60_000);
    expect(await t.mutation(internal.deploys.record, { build: MAIN })).toBe("restarted");
    vi.setSystemTime(NOW + 3600_000);
    expect(await t.mutation(internal.deploys.record, { build: NEXT })).toBe("recorded");

    expect(await t.query(api.deploys.recent, {})).toEqual([
      { build: NEXT, at: NOW + 3600_000 },
      { build: MAIN, at: NOW },
    ]);
  });

  it("records a rollback to an older build as a deploy of its own", async () => {
    const t = cockpit();
    await t.mutation(internal.deploys.record, { build: MAIN });
    vi.setSystemTime(NOW + 60_000);
    await t.mutation(internal.deploys.record, { build: NEXT });
    vi.setSystemTime(NOW + 120_000);
    expect(await t.mutation(internal.deploys.record, { build: MAIN })).toBe("recorded");
    expect((await t.query(api.deploys.recent, {})).map(({ build }) => build.number)).toEqual(["42", "43", "42"]);
  });

  it("records nothing for a local build", async () => {
    const t = cockpit();
    expect(await t.mutation(internal.deploys.record, { build: buildFromEnv({}) })).toBe("local");
    expect(await t.query(api.deploys.recent, {})).toEqual([]);
  });
});

describe("who sees them", () => {
  it("on a team's cockpit, only someone signed in", async () => {
    const forge = fakeForge();
    forge.person("alex");
    const t = cockpit();
    await team(t, forge);
    await t.mutation(internal.deploys.record, { build: MAIN });
    expect(await t.query(api.deploys.recent, {})).toEqual([]);
    const held = await signIn(t, forge, "alex");
    expect(await t.query(api.deploys.recent, { signIn: held })).toHaveLength(1);
  });
});

describe("the build an image carries", () => {
  it("is read from its COCKPIT_BUILD_* variables, the source without a trailing slash", () => {
    expect(buildFromEnv({
      COCKPIT_BUILD_REF: "main", COCKPIT_BUILD_VERSION: "1.3.0", COCKPIT_BUILD_COMMIT: MAIN.commit,
      COCKPIT_BUILD_TIME: MAIN.builtAt, COCKPIT_BUILD_NUMBER: "42", COCKPIT_BUILD_RUN_URL: MAIN.runUrl,
      COCKPIT_BUILD_SOURCE: "https://github.com/acme/asf/",
    })).toEqual(MAIN);
  });
});
