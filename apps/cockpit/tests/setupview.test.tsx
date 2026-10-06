import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SetupCodeRoute } from "../components/Setup";

// Where /setup says to print a setup code (#142): by whatever runs a function
// on the deployment the page's backend is, never from the cockpit's source.

describe("the setup code's route", () => {
  it("is the compose file's container on a self-hosted backend", () => {
    const html = renderToStaticMarkup(<SetupCodeRoute dashboard={null} />);
    expect(html).toContain("docker compose exec app ./convex.sh run setup:code");
    expect(html).not.toContain("dashboard");
  });

  it("is the Convex dashboard's Functions page, or npx convex run, on Convex Cloud", () => {
    const html = renderToStaticMarkup(<SetupCodeRoute dashboard="https://dashboard.convex.dev/d/happy-otter-123/functions" />);
    expect(html).toContain('href="https://dashboard.convex.dev/d/happy-otter-123/functions"');
    expect(html).toContain("npx convex run setup:code");
    expect(html).not.toContain("docker compose");
  });
});
