import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Header, type Me, placeOf, viewerMenu } from "../components/Header";

// The header every page sits under (#105): the brand, the three places with
// the one you are in underlined, and the avatar menu that holds who you are,
// which cockpit this is, the theme, and Sign out where there is one.

const forge = { host: "github.com", ready: true, app: null };
const alex = { login: "alex", name: "Alex Doe", avatarUrl: "https://avatars.example/alex.png", reachKnown: true };
const TEAM: Me = { mode: "team", forge, viewer: alex };
const LOCAL: Me = { mode: "local", forge, viewer: { ...alex, avatarUrl: "" } };

const html = (me: Me | undefined, path = "/", waiting = 0) =>
  renderToStaticMarkup(<Header me={me} path={path} waiting={waiting} onSignOut={() => {}} onRun={() => {}} />);
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("the places", () => {
  it("are Now, Sessions and Factories, and nothing else", () => {
    const nav = html(TEAM).match(/<nav[^>]*>(.*?)<\/nav>/)![1];
    expect([...nav.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([^<]+)/g)].map(([, href, label]) => `${label} ${href}`))
      .toEqual(["Now /", "Sessions /sessions", "Factories /factories"]);
  });

  it("mark the one the page is in", () => {
    expect(placeOf("/")).toBe("now");
    expect(placeOf("/sessions/acme/widgets/a9f259f0")).toBe("sessions");
    expect(placeOf("/factories/acme/widgets")).toBe("factories");
    // Stations and Cost left the nav, and are no place in it.
    expect(placeOf("/stations")).toBeNull();
    expect(placeOf("/cost")).toBeNull();
    expect(html(TEAM, "/sessions").match(/<a[^>]*aria-current="page"[^>]*>([^<]+)/)![1]).toBe("Sessions");
    expect(html(TEAM, "/cost")).not.toContain('aria-current="page"');
  });

  it("carry on Now the count of gates waiting on the viewer, from any page, and nothing at zero (#115)", () => {
    const now = (markup: string) => markup.match(/<nav[^>]*><a[^>]*href="\/"[^>]*>(.*?)<\/a>/)![1];
    expect(text(now(html(TEAM, "/sessions", 3)))).toBe("Now 3");
    expect(now(html(TEAM, "/sessions", 3))).toContain('aria-label="3 gates waiting on you"');
    expect(text(now(html(TEAM, "/sessions", 0)))).toBe("Now");
  });

  it("are not offered to someone a team cockpit does not know yet", () => {
    expect(html({ ...TEAM, viewer: null })).not.toContain("<nav");
    expect(html(undefined)).not.toContain("<nav");
  });
});

describe("Run a prompt", () => {
  it("is on every page, phone included, for anyone the cockpit knows (#108)", () => {
    for (const path of ["/", "/sessions", "/factories/acme/widgets", "/sessions/acme/widgets/a9f259f0", "/stations"]) {
      // The words give way to the icon on a phone; its name stays.
      expect(html(TEAM, path)).toMatch(/<button[^>]*aria-label="Run a prompt"[^>]*>.*<span class="hidden sm:inline">Run a prompt<\/span><\/button>/);
    }
    expect(html(LOCAL)).toContain('aria-label="Run a prompt"');
  });

  it("is not offered to someone a team cockpit does not know yet", () => {
    expect(html({ ...TEAM, viewer: null })).not.toContain("Run a prompt");
    expect(html(undefined)).not.toContain("Run a prompt");
  });
});

describe("the brand", () => {
  it("says local under it only in a local cockpit", () => {
    expect(text(html(LOCAL))).toContain("cockpit local");
    expect(text(html(TEAM))).not.toContain("local");
  });
});

describe("the avatar", () => {
  it("is the forge's picture, else the login's initial", () => {
    expect(html(TEAM)).toMatch(/<img[^>]*src="https:\/\/avatars.example\/alex.png"/);
    const initial = html(LOCAL);
    expect(initial).not.toContain("<img");
    expect(initial).toMatch(/aria-label="Signed in as alex"[^>]*>A</);
  });
});

describe("the avatar menu", () => {
  it("names the viewer and the kind of cockpit", () => {
    expect(viewerMenu(TEAM)).toEqual({ login: "alex", kind: "Team cockpit · signed in with GitHub", signOut: true });
    expect(viewerMenu(LOCAL)).toEqual({ login: "alex", kind: "Local cockpit · your own forge token", signOut: false });
  });

  it("offers Sign out only in a team cockpit", () => {
    expect(viewerMenu(LOCAL).signOut).toBe(false);
    expect(viewerMenu({ ...TEAM, forge: { ...forge, host: "ghe.acme.dev" } }).kind).toBe("Team cockpit · signed in with ghe.acme.dev");
  });

  it("says when a local cockpit has no one to be", () => {
    expect(viewerMenu({ ...LOCAL, viewer: null })).toEqual({ login: "", kind: "Local cockpit · no forge token yet", signOut: false });
  });
});
