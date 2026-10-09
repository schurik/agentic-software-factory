/**
 * Run a prompt, as the header's one dialog (#108) — what it decides, apart
 * from how it is drawn, so a test can ask it.
 */

/**
 * The factory the page is about, which the dialog opens on: a factory page's,
 * a session's, or the one a sessions list is filtered to. None anywhere else.
 */
export function factoryInView(path: string, search: string): string | null {
  const [place, owner, repo] = path.split("/").slice(1);
  if ((place === "factories" || place === "sessions") && owner && repo) {
    try {
      return `${decodeURIComponent(owner)}/${decodeURIComponent(repo)}`;
    } catch {
      return null;       // the header is on every page: an address that does not decode names no factory, and breaks nothing
    }
  }
  if (path === "/sessions") return new URLSearchParams(search).get("factory") || null;
  return null;
}

/** The dialog: whether it is open, and what is chosen and typed in it. */
export interface RunDialogState {
  open: boolean;
  factory: string;
  /** The workflow asked for; what runs is `workflowOf` it, against the factory's prompt workflows. */
  workflow: string;
  prompt: string;
}

export type RunDialogAction =
  | { type: "open"; factory: string; workflow?: string }
  | { type: "factory"; factory: string }
  | { type: "workflow"; workflow: string }
  | { type: "prompt"; prompt: string }
  | { type: "close" };

export const CLOSED: RunDialogState = { open: false, factory: "", workflow: "", prompt: "" };

/** What each thing a person does to the dialog leaves it as. Closing forgets the prompt: a reopened dialog never runs a stale one. */
export function runDialog(state: RunDialogState, action: RunDialogAction): RunDialogState {
  switch (action.type) {
    case "open":
      return { open: true, factory: action.factory, workflow: action.workflow ?? "", prompt: "" };
    case "factory":
      return { ...state, factory: action.factory };
    case "workflow":
      return { ...state, workflow: action.workflow };
    case "prompt":
      return { ...state, prompt: action.prompt };
    case "close":
      return { ...state, open: false, prompt: "" };
  }
}

/**
 * The workflow a run would start: one of the chosen factory's prompt
 * workflows — the one asked for, else its first — so a workflow picked on
 * another factory never runs on this one.
 */
export function workflowOf(asked: string, offered: string[]): string {
  return offered.includes(asked) ? asked : offered[0] ?? "";
}

/** The search parameter that opens the dialog on page load: its value names a factory to choose, or is empty for the one in view. */
export const RUN_PARAM = "run";

/**
 * Where the retired `/run` page sends a person (#108): back to the page of
 * this cockpit they came from — Now, from anywhere else — with the dialog
 * open, on the factory an old `/run?factory=` link named. `referer` is the
 * request's, `host` the cockpit's own.
 */
export function runRedirect(referer: string | null, host: string | null, factory: string): string {
  let back = new URL("/", "http://cockpit");
  try {
    const from = referer ? new URL(referer) : null;
    if (from !== null && host !== null && from.host === host && from.pathname !== "/run") back = from;
  } catch {
    // Not a URL: nowhere to go back to.
  }
  back.searchParams.set(RUN_PARAM, factory);
  return `${back.pathname}${back.search}`;
}
