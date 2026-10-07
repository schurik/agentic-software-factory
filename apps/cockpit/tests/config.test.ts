import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import {
  asCommitted, asEdited, branchFor, editRefusal, proposalProblem, provenance, yamlProblem,
} from "../convex/model/config";
import { fakeForge, type FakeForge, localMode, type Role } from "./forge";
import { catchUp, cockpit, type Cockpit, signIn, team } from "./helpers";

// A config edit becomes a pull request opened AS THE VIEWER (spec #40, #58):
// the real files under `asf/`, edited as text in the Config tab, committed on
// top of the commit the editor read them at, on a `cockpit/<login>/<slug>`
// branch, with a body that says where it came from. The cockpit checks YAML
// syntax and nothing else — it never re-serialises a file, so its comments
// are the person's to keep. The repository's CI checks the rest, and branch
// protection governs the merge. Enabled for write or higher, which is what
// the forge asks of anyone who pushes a branch; the forge is what enforces it.

const BASE = "b".repeat(40);
const FACTORY_YAML = [
  "# The factory's config. Comments are the operator's: nothing may eat them.",
  "defaults:",
  "  harness: claude_code   # which harness every agent runs on",
  "limits:",
  "  max_cost_usd: 2.5",
  "",
].join("\n");
const AGENT_MD = "---\nmodel: sonnet\ntools: [read, edit]\n---\nYou plan.\n";

/** The budget raised, every comment where it was. */
const EDITED = FACTORY_YAML.replace("max_cost_usd: 2.5", "max_cost_usd: 5   # raised for the migration");

/** acme/widgets with a factory committed on its default branch. */
function committed(forge: FakeForge): void {
  forge.commit("acme/widgets", BASE, {
    "asf/factory.yaml": FACTORY_YAML,
    "asf/agents/planner/agent.md": AGENT_MD,
    "asf/workflows/sdlc/workflow.yaml": "name: sdlc\nstages: [plan]\n",
    "README.md": "# widgets\n",
  });
}

/** A team cockpit on acme/widgets, alex holding `role` there. */
async function teamWith(forge: FakeForge, role: Role): Promise<{ t: Cockpit; alex: string }> {
  forge.person("alex");
  forge.repo("acme/widgets", { factory: true, roles: { alex: role } });
  committed(forge);
  const t = cockpit();
  await team(t, forge);
  forge.install("acme");
  await catchUp(t);
  return { t, alex: await signIn(t, forge, "alex") };
}

const proposing = (given: Partial<{ files: { path: string; content: string }[]; title: string; description: string }> = {}) => ({
  factory: "acme/widgets",
  base: BASE,
  files: given.files ?? [{ path: "asf/factory.yaml", content: EDITED }],
  title: given.title ?? "Raise the budget",
  ...(given.description === undefined ? {} : { description: given.description }),
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ── the model ────────────────────────────────────────────────────────────────

describe("the YAML check", () => {
  it("passes YAML that parses, comments and all, and says nothing of what it means", () => {
    expect(yamlProblem("asf/factory.yaml", FACTORY_YAML)).toBeNull();
    expect(yamlProblem("asf/factory.yaml", "no_such_key: [1, 2]\n")).toBeNull();
    // PyYAML, which the factory reads with, lets a later key win: so does the check.
    expect(yamlProblem("asf/factory.yaml", "a: 1\na: 2\n")).toBeNull();
  });

  it("names the file, the line and the column of what does not parse", () => {
    expect(yamlProblem("asf/factory.yaml", "defaults:\n  harness: claude_code\n limits: [1, 2\n"))
      .toMatch(/^asf\/factory\.yaml, line \d+, column \d+: /);
    expect(yamlProblem("asf/workflows/sdlc/workflow.yaml", "name: sdlc\nstages: a: b\n"))
      .toBe("asf/workflows/sdlc/workflow.yaml, line 2, column 9: Nested mappings are not allowed in compact mappings");
    expect(yamlProblem("asf/factory.yaml", "---\na: 1\n---\nb: 2\n")).toMatch(/^asf\/factory\.yaml, line 3, column 1: /);
  });

  it("checks a Markdown file's frontmatter, counting lines from the top of the file", () => {
    expect(yamlProblem("asf/agents/planner/agent.md", AGENT_MD)).toBeNull();
    expect(yamlProblem("asf/workflows/sdlc/tasks/plan.md", "# Plan\n\nNo frontmatter: prose only.\n")).toBeNull();
    expect(yamlProblem("asf/agents/planner/agent.md", "---\nmodel: sonnet\ntools: [read\n---\nYou plan.\n"))
      .toMatch(/^asf\/agents\/planner\/agent\.md, line 3, column \d+: /);
    expect(yamlProblem("asf/agents/planner/agent.md", "---\nmodel: sonnet\nYou plan.\n"))
      .toBe("asf/agents/planner/agent.md: its frontmatter opens with `---` and never closes");
  });

  it("leaves a file that is not YAML alone", () => {
    expect(yamlProblem("asf/cockpit/min-version", "a: b: c")).toBeNull();
  });
});

describe("a file's line endings", () => {
  it("are LF in the editor, and the file's own again when it is committed", () => {
    expect(asEdited(FACTORY_YAML)).toEqual({ ok: true, text: FACTORY_YAML, crlf: false });
    const windows = FACTORY_YAML.replace(/\n/g, "\r\n");
    const edited = asEdited(windows);
    expect(edited).toEqual({ ok: true, text: FACTORY_YAML, crlf: true });
    expect(asCommitted(EDITED, true)).toBe(EDITED.replace(/\n/g, "\r\n"));
    expect(asCommitted(EDITED, false)).toBe(EDITED);
  });

  it("refuse a file a browser's editor could not give back as it was", () => {
    // A textarea turns every CR into LF: a file that mixes them would come back rewritten.
    expect(asEdited("a: 1\r\nb: 2\n")).toEqual({ ok: false, because: expect.stringContaining("mixes") });
    expect(asEdited("a: 1\rb: 2\r")).toEqual({ ok: false, because: expect.stringContaining("mixes") });
  });
});

describe("what blocks a proposal before the forge is asked", () => {
  it("is the first of: no title, no file, a file twice, outside asf/, YAML that does not parse", () => {
    const file = { path: "asf/factory.yaml", content: EDITED };
    expect(proposalProblem([file], "Raise the budget")).toBeNull();
    expect(proposalProblem([file], "  ")).toBe("a pull request needs a title");
    expect(proposalProblem([], "Raise the budget")).toBe("no file was edited");
    expect(proposalProblem([file, file], "Raise the budget")).toBe("asf/factory.yaml is in the proposal twice");
    expect(proposalProblem([{ path: "README.md", content: "" }], "x")).toMatch(/only the files under `asf\/`/);
    expect(proposalProblem([{ path: "asf/factory.yaml", content: "a: [1\n" }], "x")).toMatch(/^asf\/factory\.yaml, line /);
  });
});

describe("the branch a proposal goes on", () => {
  it("is cockpit/<login>/<slug>, the slug made of the title", () => {
    expect(branchFor("alex", "Raise the budget!")).toBe("cockpit/alex/raise-the-budget");
    expect(branchFor("Alex-B", "  config: édit   asf/factory.yaml  ")).toBe("cockpit/Alex-B/config-edit-asf-factory-yaml");
    expect(branchFor("alex", "!!!")).toBe("cockpit/alex/config-edit");
    expect(branchFor("alex", "x".repeat(200)).length).toBeLessThanOrEqual("cockpit/alex/".length + 48);
  });
});

describe("the pull request's body", () => {
  it("says who proposed it, from where, on what, and what was and was not checked", () => {
    const body = provenance({
      login: "alex", into: "main", base: BASE, paths: ["asf/factory.yaml"], description: "For the migration.",
    });

    expect(body).toMatch(/^For the migration\.\n/);
    expect(body).toContain("@alex");
    expect(body).toContain("Config tab");
    expect(body).toContain(`\`main\` at ${BASE.slice(0, 7)}`);
    expect(body).toContain("`asf/factory.yaml`");
    expect(body).toMatch(/YAML parses/);
  });
});

describe("why editing is disabled", () => {
  it("names the role it needs and the one the viewer has", () => {
    expect(editRefusal("triage")).toBe("editing the config needs write or higher on this repository, and the forge says you have triage");
    expect(editRefusal(null)).toBe("the forge has not said what you may do on this repository");
    for (const role of ["write", "maintain", "admin"] as const) expect(editRefusal(role)).toBeNull();
  });
});

// ── against the forge ────────────────────────────────────────────────────────

describe("proposing a config edit", () => {
  it("opens a pull request as the viewer, with the exact bytes edited", async () => {
    const forge = fakeForge();
    const { t, alex } = await teamWith(forge, "write");

    const opened = await t.action(api.config.propose, { ...proposing({ description: "For the migration." }), signIn: alex });

    expect(opened).toEqual({
      ok: true, number: expect.any(Number), url: expect.stringMatching(/^https:\/\/github\.com\/acme\/widgets\/pull\/\d+$/),
      branch: "cockpit/alex/raise-the-budget", paths: ["asf/factory.yaml"],
    });
    const [pull] = forge.pulls("acme/widgets");
    // On the person's own user access token: the pull request, and its commit, are theirs.
    expect(pull).toMatchObject({
      title: "Raise the budget", head: "cockpit/alex/raise-the-budget", base: "main", author: "alex", via: "user",
    });
    expect(pull.body).toBe(provenance({
      login: "alex", into: "main", base: BASE, paths: ["asf/factory.yaml"], description: "For the migration.",
    }));
    const head = forge.commitOf("acme/widgets", pull.head)!;
    expect(head).toMatchObject({ author: "alex", via: "user", parents: [BASE] });
    // Byte for byte what was typed — comments included — and nothing else touched.
    expect(forge.at("acme/widgets", pull.head, "asf/factory.yaml")).toBe(EDITED);
    expect(forge.at("acme/widgets", pull.head, "asf/agents/planner/agent.md")).toBe(AGENT_MD);
    expect(forge.at("acme/widgets", pull.head, "README.md")).toBe("# widgets\n");
  });

  it("carries several files in one commit, and leaves out the ones that did not change", async () => {
    const forge = fakeForge();
    const { t, alex } = await teamWith(forge, "maintain");
    const agent = AGENT_MD.replace("model: sonnet", "model: opus");

    const opened = await t.action(api.config.propose, {
      ...proposing({ files: [
        { path: "asf/agents/planner/agent.md", content: agent },
        { path: "asf/factory.yaml", content: EDITED },
        { path: "asf/workflows/sdlc/workflow.yaml", content: "name: sdlc\nstages: [plan]\n" },
      ] }),
      signIn: alex,
    });

    expect(opened).toMatchObject({ ok: true, paths: ["asf/agents/planner/agent.md", "asf/factory.yaml"] });
    const [pull] = forge.pulls("acme/widgets");
    expect(forge.at("acme/widgets", pull.head, "asf/agents/planner/agent.md")).toBe(agent);
    expect(forge.at("acme/widgets", pull.head, "asf/factory.yaml")).toBe(EDITED);
  });

  it("opens it with the person's own token in a local cockpit", async () => {
    const forge = fakeForge();
    localMode(forge, forge.person("alex"));
    forge.repo("acme/widgets", { factory: true, roles: { alex: "admin" } });
    committed(forge);
    const t = cockpit();
    await catchUp(t);

    expect(await t.action(api.config.propose, proposing())).toMatchObject({ ok: true, branch: "cockpit/alex/raise-the-budget" });
    expect(forge.pulls("acme/widgets")).toEqual([expect.objectContaining({ author: "alex", via: "person" })]);
  });

  it("is refused below write in a local cockpit too, whose token may reach what it cannot push to", async () => {
    const forge = fakeForge();
    localMode(forge, forge.person("alex"));
    forge.repo("acme/widgets", { factory: true, roles: { alex: "read" } });
    committed(forge);
    const t = cockpit();
    await catchUp(t);

    expect((await t.query(api.factory.page, { factory: "acme/widgets" }))!.edit).toBe(editRefusal("read"));
    expect(await t.action(api.config.propose, proposing())).toEqual({ ok: false, because: editRefusal("read") });
    expect(forge.pulls("acme/widgets")).toEqual([]);
  });

  it("takes the next free branch when the slug is taken", async () => {
    const forge = fakeForge();
    const { t, alex } = await teamWith(forge, "write");
    forge.branch("acme/widgets", "cockpit/alex/raise-the-budget", BASE);
    forge.branch("acme/widgets", "cockpit/alex/raise-the-budget-2", BASE);

    expect(await t.action(api.config.propose, { ...proposing(), signIn: alex }))
      .toMatchObject({ ok: true, branch: "cockpit/alex/raise-the-budget-3" });
  });

  it("is refused with the parse error when the YAML does not parse, and nothing reaches the forge", async () => {
    const forge = fakeForge();
    const { t, alex } = await teamWith(forge, "write");
    const mark = forge.requests.length;

    const refused = await t.action(api.config.propose, {
      ...proposing({ files: [{ path: "asf/factory.yaml", content: "defaults:\n  harness: [claude_code\n" }] }), signIn: alex,
    });

    expect(refused).toEqual({ ok: false, because: expect.stringMatching(/^asf\/factory\.yaml, line \d+, column \d+: /) });
    expect(forge.since(mark)).toEqual([]);
    expect(forge.pulls("acme/widgets")).toEqual([]);
  });

  it("is refused below write, saying so, and nothing is pushed", async () => {
    const forge = fakeForge();
    const { t, alex } = await teamWith(forge, "triage");

    expect(await t.action(api.config.propose, { ...proposing(), signIn: alex }))
      .toEqual({ ok: false, because: editRefusal("triage") });
    expect(forge.pulls("acme/widgets")).toEqual([]);
    expect(forge.branches("acme/widgets")).toEqual([]);
  });

  it.each([
    ["a file outside asf/", proposing({ files: [{ path: "README.md", content: "# gone\n" }] }), "only the files under `asf/`"],
    ["a path that climbs out", proposing({ files: [{ path: "asf/../README.md", content: "x\n" }] }), "only the files under `asf/`"],
    ["a file the base does not hold", proposing({ files: [{ path: "asf/new.yaml", content: "a: 1\n" }] }), "asf/new.yaml is not"],
    ["the same file twice", proposing({ files: [{ path: "asf/factory.yaml", content: EDITED }, { path: "asf/factory.yaml", content: EDITED }] }), "twice"],
    ["no change at all", proposing({ files: [{ path: "asf/factory.yaml", content: FACTORY_YAML }] }), "nothing changed"],
    ["no title", proposing({ title: "   " }), "a title"],
    ["no files", proposing({ files: [] }), "no file"],
  ])("refuses %s before anything is pushed", async (_, given, because) => {
    const forge = fakeForge();
    const { t, alex } = await teamWith(forge, "admin");

    expect(await t.action(api.config.propose, { ...given, signIn: alex }))
      .toEqual({ ok: false, because: expect.stringContaining(because) });
    expect(forge.pulls("acme/widgets")).toEqual([]);
    expect(forge.branches("acme/widgets")).toEqual([]);
  });

  it("says what the forge said when it refuses the push", async () => {
    const forge = fakeForge();
    const { t, alex } = await teamWith(forge, "write");
    forge.grant("acme/widgets", "alex", "read");           // since the mirror last asked

    const refused = await t.action(api.config.propose, { ...proposing(), signIn: alex });

    expect(refused).toEqual({ ok: false, because: expect.stringContaining("403") });
    expect(forge.pulls("acme/widgets")).toEqual([]);
  });

  it("is refused to a viewer who is not signed in", async () => {
    const forge = fakeForge();
    const { t } = await teamWith(forge, "admin");
    expect(await t.action(api.config.propose, proposing())).toEqual({ ok: false, because: "sign in to edit the config" });
  });
});

describe("reading a file to edit", () => {
  it("is its text at the commit asked for", async () => {
    const forge = fakeForge();
    const { t, alex } = await teamWith(forge, "read");

    expect(await t.action(api.config.read, { factory: "acme/widgets", path: "asf/factory.yaml", ref: BASE, signIn: alex }))
      .toEqual({ ok: true, text: FACTORY_YAML, crlf: false });
    expect(await t.action(api.config.read, { factory: "acme/widgets", path: "README.md", ref: BASE, signIn: alex }))
      .toEqual({ ok: false, because: expect.stringContaining("only the files under `asf/`") });
    expect(await t.action(api.config.read, { factory: "acme/widgets", path: "asf/factory.yaml", ref: BASE }))
      .toEqual({ ok: false, because: "no such factory among the ones you can read" });
  });
});

describe("a file with CRLF line endings", () => {
  it("is edited as LF and proposed with its own line endings again, every untouched line as it was", async () => {
    const forge = fakeForge();
    forge.person("alex");
    forge.repo("acme/widgets", { factory: true, roles: { alex: "write" } });
    const windows = FACTORY_YAML.replace(/\n/g, "\r\n");
    forge.commit("acme/widgets", BASE, { "asf/factory.yaml": windows });
    const t = cockpit();
    await team(t, forge);
    forge.install("acme");
    await catchUp(t);
    const alex = await signIn(t, forge, "alex");

    const read = await t.action(api.config.read, { factory: "acme/widgets", path: "asf/factory.yaml", ref: BASE, signIn: alex });
    expect(read).toEqual({ ok: true, text: FACTORY_YAML, crlf: true });
    const content = asCommitted(EDITED, true);
    expect(await t.action(api.config.propose, { ...proposing({ files: [{ path: "asf/factory.yaml", content }] }), signIn: alex }))
      .toMatchObject({ ok: true });
    expect(forge.at("acme/widgets", forge.pulls("acme/widgets")[0].head, "asf/factory.yaml")).toBe(EDITED.replace(/\n/g, "\r\n"));
  });
});

describe("the Factory page says whether the viewer may edit", () => {
  it.each([
    ["write", null],
    ["triage", editRefusal("triage")],
  ] as const)("for %s", async (role, because) => {
    const forge = fakeForge();
    const { t, alex } = await teamWith(forge, role);
    expect((await t.query(api.factory.page, { factory: "acme/widgets", signIn: alex }))!.edit).toBe(because);
  });
});

describe("the Config tab's open proposals", () => {
  it("are the open pull requests from a cockpit/ branch, as the factory's look finds them", async () => {
    const forge = fakeForge();
    const { t, alex } = await teamWith(forge, "write");
    const opened = await t.action(api.config.propose, { ...proposing(), signIn: alex });
    const closed = await t.action(api.config.propose, { ...proposing({ title: "Lower it again" }), signIn: alex });
    if (!opened.ok || !closed.ok) throw new Error("not proposed");
    forge.issue("acme/widgets", closed.number, { title: "Lower it again", state: "closed", pull: true });
    // Someone's own pull request is no proposal of the Config tab's.
    forge.branch("acme/widgets", "feature/faster", BASE);
    forge.pull("acme/widgets", { head: "feature/faster", title: "Go faster", author: "sam" });

    const looked = await t.action(api.factory.look, { factory: "acme/widgets", signIn: alex });

    expect(looked.ok && looked.proposals).toEqual([{
      number: opened.number, title: "Raise the budget", url: opened.url, head: "cockpit/alex/raise-the-budget",
      author: "alex", at: expect.any(Number), draft: false,
    }]);
  });

  it("are read with the person's own token in a local cockpit", async () => {
    const forge = fakeForge();
    localMode(forge, forge.person("alex"));
    forge.repo("acme/widgets", { factory: true, roles: { alex: "admin" } });
    committed(forge);
    const t = cockpit();
    await catchUp(t);
    await t.action(api.config.propose, proposing());

    const looked = await t.action(api.factory.look, { factory: "acme/widgets" });

    expect(looked.ok && looked.proposals.map((proposal) => proposal.head)).toEqual(["cockpit/alex/raise-the-budget"]);
  });
});
