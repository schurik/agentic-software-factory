// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupView } from "../components/Setup";

// The setup page's form in a browser-shaped DOM (#256): an account that has
// an App already — for another cockpit, or this one on another machine —
// takes it on instead of registering a second one GitHub would refuse by
// name, or that would have to be installed again.

const PAGES = "https://cockpit.acme.dev";
const KEY = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----\n";

function page(onAdopt = vi.fn(async () => {})) {
  render(
    <SetupView mode="team" forge={{ host: "github.com", ready: false, app: null }}
               webhook={{ url: "https://site.cockpit.acme.dev/forge/webhook", deliverable: true }}
               deployment={{ site: "https://site.cockpit.acme.dev", cloud: null }} appUrl={PAGES}
               onBegin={async () => {}} onAdopt={onAdopt} />,
  );
  return onAdopt;
}

afterEach(cleanup);

describe("taking on an App the account already has, used", () => {
  it("is reached from where GitHub would refuse the name, and sends what that App's settings page hands over", async () => {
    const user = userEvent.setup();
    const sent = page();

    await user.click(screen.getByRole("button", { name: "use that one" }));
    // The one thing to add on GitHub, which no API can: this cockpit's callback URL.
    expect(screen.getByText(`${PAGES}/auth/callback`)).toBeTruthy();
    await user.type(screen.getByRole("textbox", { name: "Setup code" }), "asf_setup_1");
    await user.type(screen.getByRole("textbox", { name: "App ID" }), " 123456 ");
    await user.type(screen.getByLabelText("Client secret"), "s3cret");
    await user.click(screen.getByRole("textbox", { name: "Private key" }));
    await user.paste(KEY);
    await user.click(screen.getByRole("button", { name: "Use this App" }));

    expect(sent).toHaveBeenCalledWith({
      code: "asf_setup_1", host: "github.com", appId: " 123456 ", clientSecret: "s3cret", privateKey: KEY,
    });
  });

  it("reads the private key from the .pem file GitHub downloaded", async () => {
    const user = userEvent.setup();
    page();
    await user.click(screen.getByRole("button", { name: "Use an App you already have" }));

    await user.upload(screen.getByLabelText("Or pick the .pem file"), new File([KEY], "acme.2026-11-08.private-key.pem"));

    expect((screen.getByRole("textbox", { name: "Private key" }) as HTMLTextAreaElement).value).toBe(KEY);
  });

  it("says why the App was not taken on, and lets it be sent again", async () => {
    const user = userEvent.setup();
    const sent = page(vi.fn(async () => {
      throw new Error("github.com did not take App 4242's ID and private key (401)");
    }));
    await user.click(screen.getByRole("button", { name: "Use an App you already have" }));
    await user.type(screen.getByRole("textbox", { name: "Setup code" }), "asf_setup_1");
    await user.type(screen.getByRole("textbox", { name: "App ID" }), "4242");
    await user.type(screen.getByLabelText("Client secret"), "s3cret");
    await user.type(screen.getByRole("textbox", { name: "Private key" }), "key");

    await user.click(screen.getByRole("button", { name: "Use this App" }));

    expect((await screen.findByRole("alert")).textContent).toContain("did not take App 4242's ID and private key (401)");
    expect((screen.getByRole("button", { name: "Use this App" }) as HTMLButtonElement).disabled).toBe(false);
    expect(sent).toHaveBeenCalledTimes(1);
  });
});
