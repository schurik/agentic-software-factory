/**
 * Editing a factory's config from the cockpit, as a model (spec #40, #58):
 * what is checked before a pull request is opened, which branch it goes on,
 * what its body says, and who may open one.
 *
 * The cockpit checks YAML syntax and nothing else. What a key means is the
 * factory's to say — its own `asf check`, in the repository's CI — and a file
 * is never parsed in order to be written back: what is committed is the text
 * the person typed, so its comments are theirs to keep. Both the editor and
 * the action that opens the pull request ask `proposalProblem`, so what the
 * page blocks and what the action refuses are the same thing.
 */
import { parseDocument } from "yaml";
import { atLeast, type OpenPull, type Role } from "../forge/forge";

/** The directory a factory's config lives under: the only files the cockpit edits. */
export const CONFIG_DIR = "asf";

/** A slug is at most this long: a branch name is read in lists, and the title is in the pull request. */
const SLUG_LENGTH = 48;

/**
 * Why `path` is not a config file the cockpit edits, or null when it is: a
 * file under `asf/`, spelled the way the forge's tree lists it.
 */
export function outsideConfig(path: string): string | null {
  const parts = path.split("/");
  const plain = parts.length > 1 && parts[0] === CONFIG_DIR && parts.every((part) => part !== "" && part !== "." && part !== "..");
  return plain ? null : `${path} is not a config file: the cockpit edits only the files under \`${CONFIG_DIR}/\``;
}

/**
 * What is wrong with the YAML in `text`, the file at `path`, or null when it
 * parses: `path, line L, column C: what`. A `.yaml`/`.yml` file is one YAML
 * document, as `yaml.safe_load` takes it; a Markdown file is checked for the
 * frontmatter the factory reads off its top (`engine/frontmatter.py`);
 * anything else is not YAML. A later duplicate key wins, as it does in
 * PyYAML, rather than block a file the factory would load.
 */
export function yamlProblem(path: string, text: string): string | null {
  if (/\.ya?ml$/i.test(path)) return parsed(path, text, 0);
  if (!/\.md$/i.test(path)) return null;
  // As frontmatter.split: the block opens on the very first line and closes at the next line that is `---`.
  const lines = text.split("\n");
  if (lines[0].trim() !== "---") return null;
  const close = lines.findIndex((line, at) => at > 0 && line.trim() === "---");
  if (close === -1) return `${path}: its frontmatter opens with \`---\` and never closes`;
  return parsed(path, lines.slice(1, close).join("\n"), 1);
}

/** The first error in `text` as one YAML document, its line counted `offset` lines down the file. */
function parsed(path: string, text: string, offset: number): string | null {
  const [error] = parseDocument(text, { uniqueKeys: false, prettyErrors: false }).errors;
  if (error === undefined) return null;
  const before = text.slice(0, error.pos[0]).split("\n");
  const where = `line ${before.length + offset}, column ${before[before.length - 1].length + 1}`;
  const what = error.code === "MULTIPLE_DOCS" ? "a second YAML document begins here, and the factory reads one"
    : error.message.replace(/ at line \d+, column \d+[\s\S]*$/, "");
  return `${path}, ${where}: ${what}`;
}

/**
 * Why `files` titled `title` cannot be proposed as they stand, or null when
 * they can: nothing here asks the forge. The editor blocks its submit on it,
 * and the action refuses on it before anything is pushed.
 */
export function proposalProblem(files: { path: string; content: string }[], title: string): string | null {
  if (!title.trim()) return "a pull request needs a title";
  if (files.length === 0) return "no file was edited";
  const seen = new Set<string>();
  for (const { path, content } of files) {
    if (seen.has(path)) return `${path} is in the proposal twice`;
    seen.add(path);
    const problem = outsideConfig(path) ?? yamlProblem(path, content);
    if (problem !== null) return problem;
  }
  return null;
}

/** A file's text as the editor holds it, and whether its own line endings are CRLF. */
export type Edited = { ok: true; text: string; crlf: boolean } | { ok: false; because: string };

/**
 * `text` as a browser's editor can hold it and give back unchanged: with LF
 * line endings, which is all a textarea keeps — it turns every CR into LF. A
 * file whose endings are all CRLF is edited as LF and gets its CRLF back on
 * the way out (`asCommitted`); one that mixes them could not come back as it
 * was, and is refused.
 */
export function asEdited(text: string): Edited {
  if (!text.includes("\r")) return { ok: true, text, crlf: false };
  const lines = text.split("\r\n");
  if (lines.some((line) => /[\r\n]/.test(line))) {
    return { ok: false, because: "it mixes CRLF and LF line endings, which a browser's editor cannot keep: edit it in a checkout" };
  }
  return { ok: true, text: lines.join("\n"), crlf: true };
}

/** What the editor holds, `text`, with the line endings of the file it came from. */
export function asCommitted(text: string, crlf: boolean): string {
  return crlf ? text.replace(/\n/g, "\r\n") : text;
}

/** What every proposal's branch starts with: what tells a proposal from any other pull request. */
const PROPOSAL_BRANCH_PREFIX = "cockpit/";

/** The branch a proposal by `login` titled `title` goes on: `cockpit/<login>/<slug>`. */
export function branchFor(login: string, title: string): string {
  const slug = title.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").slice(0, SLUG_LENGTH).replace(/^-+|-+$/g, "");
  return `${PROPOSAL_BRANCH_PREFIX}${login}/${slug || "config-edit"}`;
}

/** The open pull requests among `pulls` that the Config tab proposed — from a `cockpit/` branch — newest first. */
export function proposalsOf(pulls: OpenPull[]): OpenPull[] {
  return pulls.filter((pull) => pull.head.startsWith(PROPOSAL_BRANCH_PREFIX)).sort((a, b) => b.at - a.at);
}

/** The pull request's body: the person's own words, then where it came from and what was checked. */
export function provenance({ login, into, base, paths, description }: {
  login: string;
  /** The branch it asks to merge into: the default branch. */
  into: string;
  /** The commit the editor read the files at, which the change is committed on top of. */
  base: string;
  paths: string[];
  description: string;
}): string {
  const files = paths.map((path) => `\`${path}\``).join(", ");
  return [
    ...(description.trim() ? [description.trim(), "", "---", ""] : []),
    `Proposed by @${login} from the asf cockpit's Config tab: an edit of ${files} as \`${into}\` at ${base.slice(0, 7)} held ${paths.length === 1 ? "it" : "them"}.`,
    "",
    "The cockpit checked only that the YAML parses. Whatever this repository's CI checks — `asf check`, where its CI workflow is stamped — and its branch protection decide the rest, as for any other change.",
    "",
  ].join("\n");
}

/**
 * Why the viewer may not edit the config of a repository where the forge
 * says they are `role` — null when they may. Write or higher is what the
 * forge asks of anyone who pushes a branch (spec #40); the cockpit disables
 * what the forge would refuse, and the forge is what enforces it.
 */
export function editRefusal(role: Role | null): string | null {
  if (role === null) return "the forge has not said what you may do on this repository";
  if (!atLeast(role, "write")) {
    return `editing the config needs write or higher on this repository, and the forge says you have ${role}`;
  }
  return null;
}
