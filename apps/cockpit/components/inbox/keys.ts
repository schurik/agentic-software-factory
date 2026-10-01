/**
 * The inbox's keyboard flow: `j`/`k` (or the arrows) move through the list,
 * `a` approves — at a question round, takes every recommendation — and `r`
 * opens the notes a reject needs. A key typed into a field is the person's
 * text, and a key held with a modifier is the browser's.
 */
export type Keyed = "next" | "previous" | "approve" | "reject";

/**
 * What `keyed` reads off a key press: a `KeyboardEvent` as it is. Pass the
 * event itself — its fields are getters on its prototype, so a copy made by
 * spreading it (`{ ...event }`) has none of them.
 */
export interface Press {
  key: string;
  target: EventTarget | { tagName?: string; isContentEditable?: boolean } | null;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

const KEYS: Record<string, Keyed> = {
  j: "next", ArrowDown: "next", k: "previous", ArrowUp: "previous", a: "approve", r: "reject",
};

export function keyed({ key, target, metaKey, ctrlKey, altKey }: Press): Keyed | null {
  if (metaKey || ctrlKey || altKey) return null;
  const into = (target ?? {}) as { tagName?: string; isContentEditable?: boolean };
  const tag = into.tagName?.toUpperCase() ?? "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || into.isContentEditable) return null;
  return KEYS[key] ?? null;
}
