import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BuildDetails, deployedAt, footerLine } from "../components/Footer";
import { type Build, buildFromEnv } from "../convex/model/build";

// The footer, bottom right under every page: which build serves it, and when
// that build was deployed here; opened, the build in full and the deploys
// before it.

const NOW = Date.parse("2026-11-07T15:00:00.000Z");
const HOUR = 3600_000;

const MAIN: Build = {
  ref: "main", version: "1.3.0", commit: "a1b2c3d".padEnd(40, "0"), builtAt: "2026-11-07T11:50:00Z", number: "42",
  runUrl: "https://github.com/acme/asf/actions/runs/1", source: "https://github.com/acme/asf",
};
const RELEASE: Build = { ...MAIN, ref: "v1.3.0", commit: "f00ba44".padEnd(40, "0"), number: "7" };
const DEPLOYS = [{ build: MAIN, at: NOW - 3 * HOUR }, { build: RELEASE, at: NOW - 30 * HOUR }];

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const html = (build: Build, deploys = DEPLOYS) => renderToStaticMarkup(<BuildDetails build={build} deploys={deploys} now={NOW} />);

describe("the footer's line", () => {
  it("names the ref, the short commit and the run, and how long ago it was deployed here", () => {
    expect(footerLine(MAIN, deployedAt(MAIN, DEPLOYS), NOW)).toBe("main · a1b2c3d · #42 · deployed 3h ago");
  });

  it("leaves the deploy out when this deployment did not record it", () => {
    expect(footerLine(MAIN, deployedAt(MAIN, []), NOW)).toBe("main · a1b2c3d · #42");
  });

  it("says a build CI did not make is a local one", () => {
    expect(footerLine(buildFromEnv({}), null, NOW)).toBe("local build");
  });
});

describe("opened", () => {
  it("links the commit and the run, and says which release main follows", () => {
    const markup = html(MAIN);
    expect(markup).toContain(`href="https://github.com/acme/asf/commit/${MAIN.commit}"`);
    expect(markup).toContain('href="https://github.com/acme/asf/actions/runs/1"');
    expect(text(markup)).toContain("Built from main Release after 1.3.0 Commit a1b2c3d Build #42");
  });

  it("names a release's own build by its version", () => {
    expect(text(html(RELEASE))).toContain("Built from v1.3.0 Release 1.3.0");
  });

  it("lists the deploys newest first, and marks the one serving", () => {
    expect(text(html(MAIN))).toContain("Deploys main · a1b2c3d · #42 serving 3h ago v1.3.0 · f00ba44 · #7 1d ago");
  });

  it("says what a local build cannot", () => {
    expect(text(html(buildFromEnv({}), []))).toContain("A local build");
    expect(text(html(buildFromEnv({}), []))).not.toContain("Deploys");
  });
});
