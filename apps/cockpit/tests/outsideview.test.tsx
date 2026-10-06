import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Me } from "../components/Header";
import { SetupCallbackView, SetupView } from "../components/Setup";
import { SignInCallbackView, SignInView } from "../components/SignInPage";
import { type Approval, ApprovalView, type Asked } from "../components/Stations";

// The pages a person reaches before, or outside, the three places (#122):
// setting up the GitHub App and its callback, sign-in and its callback, and
// approving a station. Each says what it says today, rendered to static
// markup with no backend, and draws in the shared primitives of
// components/ui.tsx, not the few classes they kept until this moved them.

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

/** The classes these pages drew in before #122: none of them is defined any more. */
const OLD = ["card", "button", "muted", "small", "error", "notice", "facts", "steps", "form"];
const oldClasses = (markup: string) =>
  [...markup.matchAll(/class="([^"]*)"/g)].flatMap(([, classes]) => classes.split(" ")).filter((name) => OLD.includes(name));

const forge: Me["forge"] = { host: "github.com", ready: false, app: null };
const app = { slug: "acme-cockpit", installUrl: "https://github.com/apps/acme-cockpit/installations/new" };
const reachable = { url: "https://cockpit.acme.dev/forge/webhook", deliverable: true };
const begin = async () => {};

describe("setting up the GitHub App", () => {
  const setup = (props: Partial<Parameters<typeof SetupView>[0]> = {}) =>
    renderToStaticMarkup(<SetupView mode="team" forge={forge} webhook={reachable} onBegin={begin} {...props} />);

  it("is not needed by a local cockpit, which says why", () => {
    const local = setup({ mode: "local" });
    expect(text(local)).toContain("A local cockpit needs no setup: it asks the forge with your own gh auth token");
    expect(local).not.toContain("Continue to GitHub");
  });

  it("names its three steps, the command that prints a setup code, and the fields GitHub's form needs", () => {
    const page = setup();
    expect(page).toMatch(/<h1[^>]*>Set up the GitHub App<\/h1>/);
    expect(page).toContain("docker compose exec app ./convex.sh run setup:code");
    expect([...page.matchAll(/<li[^>]*>/g)]).toHaveLength(3);
    expect(text(page)).toContain("with its sign-in and its webhook pointed at this cockpit");
    for (const label of ["Setup code", "GitHub host", "Organization"]) expect(page).toContain(`>${label}</span>`);
    expect(page).toContain('value="github.com"');
    expect(page).toMatch(/<button type="submit"[^>]*>Continue to GitHub<\/button>/);
  });

  it("warns that registering again replaces the App, and offers to install it instead", () => {
    const page = setup({ forge: { ...forge, ready: true, app } });
    expect(text(page)).toContain("acme-cockpit is registered on github.com. Registering again replaces it and signs everyone out.");
    expect(page).toContain(`href="${app.installUrl}"`);
  });

  it("says a cockpit GitHub cannot reach is registered without a webhook, and how to have one", () => {
    const page = setup({ webhook: { url: "http://localhost:3211/forge/webhook", deliverable: false } });
    expect(text(page)).toContain("GitHub cannot deliver webhooks to http://localhost:3211/forge/webhook");
    expect(text(page)).toContain("registered without a webhook");
    expect(text(page)).toContain("with its sign-in pointed at this cockpit");
  });

  it("draws in the shared primitives", () => {
    for (const page of [setup(), setup({ mode: "local" }), setup({ forge: { ...forge, ready: true, app }, webhook: { ...reachable, deliverable: false } })]) {
      expect(oldClasses(page)).toEqual([]);
    }
  });
});

describe("coming back from GitHub with the App", () => {
  const back = (props: Parameters<typeof SetupCallbackView>[0]) => renderToStaticMarkup(<SetupCallbackView {...props} />);

  it("says what it is doing while it keeps the App's key", () => {
    expect(text(back({ app: null, problem: "" }))).toBe("Keeping the App's key and secrets…");
  });

  it("names the App it registered, and the one step left: installing it", () => {
    const page = back({ app, problem: "" });
    expect(page).toMatch(/<h1[^>]*>acme-cockpit is registered<\/h1>/);
    expect(page).toMatch(new RegExp(`<a[^>]*href="${app.installUrl}"[^>]*><span[^>]*>Install acme-cockpit</span></a>`));
    expect(page).toMatch(/<a[^>]*href="\/"[^>]*>sign in<\/a>/);
  });

  it("says why the App was not registered, and leads back to setup", () => {
    const page = back({ app: null, problem: "That setup code was used already." });
    expect(page).toMatch(/<h1[^>]*>The App was not registered<\/h1>/);
    expect(page).toContain("That setup code was used already.");
    expect(page).toMatch(/<a[^>]*href="\/setup"[^>]*>Back to setup<\/a>/);
  });

  it("draws in the shared primitives", () => {
    for (const page of [back({ app, problem: "" }), back({ app: null, problem: "no" }), back({ app: null, problem: "" })]) {
      expect(oldClasses(page)).toEqual([]);
    }
  });
});

describe("signing in", () => {
  const wall = (given: Me["forge"]) => renderToStaticMarkup(<SignInView forge={given} onSignIn={begin} />);

  it("sends a team cockpit with no App yet to set one up", () => {
    const page = wall(forge);
    expect(page).toMatch(/<h1[^>]*>This cockpit has no GitHub App yet<\/h1>/);
    expect(page).toMatch(/<a[^>]*href="\/setup"[^>]*>Set up the GitHub App<\/a>/);
    expect(page).not.toContain("Sign in with");
  });

  it("signs in with the forge the App is on, by its name", () => {
    const page = wall({ ...forge, ready: true, app });
    expect(page).toMatch(/<h1[^>]*>Sign in<\/h1>/);
    expect(text(page)).toContain("You are who github.com says you are, and you see here what you can read there.");
    expect(page).toMatch(/<button[^>]*><span[^>]*>Sign in with GitHub<\/span><\/button>/);
    expect(wall({ host: "git.acme.dev", ready: true, app })).toMatch(/<button[^>]*><span[^>]*>Sign in with git.acme.dev<\/span><\/button>/);
  });

  it("says what it is doing while the forge's code is traded, and why it failed when it did", () => {
    expect(text(renderToStaticMarkup(<SignInCallbackView problem="" />))).toBe("Signing you in…");
    const failed = renderToStaticMarkup(<SignInCallbackView problem="The forge sent no code back." />);
    expect(failed).toMatch(/<h1[^>]*>Not signed in<\/h1>/);
    expect(failed).toContain("The forge sent no code back.");
    expect(failed).toMatch(/<a[^>]*href="\/"[^>]*>Try again<\/a>/);
  });

  it("draws in the shared primitives", () => {
    for (const page of [wall(forge), wall({ ...forge, ready: true, app }), renderToStaticMarkup(<SignInCallbackView problem="no" />)]) {
      expect(oldClasses(page)).toEqual([]);
    }
  });
});

describe("approving a station", () => {
  const asked: NonNullable<Asked> = {
    code: "ABCD-EF23", factory: "acme/widgets", name: "alex-laptop", kind: "machine", station: "st_1a2b",
    expiresAt: 0, approved: false, because: null,
  };
  const approval = (props: Partial<Approval> = {}) => renderToStaticMarkup(
    <ApprovalView code="ABCD-EF23" asked={asked} outcome={null} onCode={() => {}} onApprove={() => {}} {...props} />,
  );
  const approve = (markup: string) => markup.match(/<button[^>]*>(Approve|Approved)<\/button>/)?.[0] ?? "";

  it("asks for the code asf station register printed, and looks it up", () => {
    const empty = approval({ code: "", asked: undefined });
    expect(empty).toMatch(/<h1[^>]*>Approve a station<\/h1>/);
    expect(empty).toContain('placeholder="ABCD-EF23"');
    expect(text(empty)).toContain("Enter the code asf station register printed.");
    expect(text(approval({ asked: undefined }))).toContain("Looking…");
  });

  it("says when no station waits on the code", () => {
    expect(text(approval({ asked: null }))).toContain("No station is waiting on that code: it may have expired. Run asf station register again.");
    expect(approve(approval({ asked: null }))).toBe("");
  });

  it("shows which station of which factory is asking, and what approving it means", () => {
    const page = approval();
    expect(text(page)).toContain("Station alex-laptop (machine, st_1a2b)");
    expect(text(page)).toContain("Factory acme/widgets");
    expect(text(page)).toContain("Approving makes this station yours");
    expect(approve(page)).not.toContain('disabled=""');
  });

  it("says why the viewer may not approve it, and does not let them", () => {
    const page = approval({ asked: { ...asked, because: "Only someone who can write to acme/widgets may approve its stations." } });
    expect(text(page)).toContain("Only someone who can write to acme/widgets may approve its stations.");
    expect(approve(page)).toContain('disabled=""');
    expect(approve(approval({ asked: { ...asked, approved: true } }))).toMatch(/disabled=""[^>]*>Approved</);
  });

  it("says what was done once it is approved, and leads to its factory's stations", () => {
    const page = approval({ asked: null, outcome: { ok: true, text: "Approved: the station picks up its token on its next poll.", factory: "acme/widgets" } });
    expect(text(page)).toContain("Approved: the station picks up its token on its next poll. Its factory's stations");
    expect(page).toMatch(/<a[^>]*href="\/factories\/acme\/widgets\?tab=stations"[^>]*>Its factory&#x27;s stations<\/a>/);
    expect(text(page)).not.toContain("No station is waiting");
  });

  it("says why approving failed, under the station it was for", () => {
    const page = approval({ outcome: { ok: false, text: "That code has run out." } });
    expect(text(page)).toContain("Factory acme/widgets");
    expect(text(page)).toContain("That code has run out.");
  });

  it("draws in the shared primitives", () => {
    for (const page of [approval(), approval({ code: "", asked: undefined }), approval({ asked: null }),
                        approval({ asked: { ...asked, because: "no" }, outcome: { ok: false, text: "no" } })]) {
      expect(oldClasses(page)).toEqual([]);
    }
  });
});
