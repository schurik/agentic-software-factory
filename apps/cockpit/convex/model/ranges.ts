/**
 * A long list, cut into key ranges that together cover every key there is.
 *
 * What the forge lists (a team's repositories, a person's reach) replaces
 * what is stored, and a team may have thousands: more than one transaction
 * should hold. So the list is sorted by key and reconciled a range at a time.
 * Each range is (`after`, `upTo`] — the last one open-ended — and a mutation
 * given one makes the stored rows in that range exactly `items`: whatever it
 * finds there and was not given, is gone from the forge. So a range never
 * holds a key twice.
 */
export interface KeyRange<T> {
  after: string;
  upTo: string | null;
  items: T[];
}

export const RANGE = 200;

export function ranges<T>(items: T[], keyOf: (item: T) => string, size = RANGE): KeyRange<T>[] {
  // One item a key: a paged listing names something twice when the pages shift under it.
  const byKey = new Map(items.map((item) => [keyOf(item), item]));
  const sorted = [...byKey].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, item]) => item);
  const found: KeyRange<T>[] = [];
  let after = "";
  // An empty list is still one range: the one that says nothing is left.
  for (let start = 0; start < sorted.length || found.length === 0; start += size) {
    const slice = sorted.slice(start, start + size);
    const upTo = start + size >= sorted.length ? null : keyOf(slice[slice.length - 1]);
    found.push({ after, upTo, items: slice });
    if (upTo !== null) after = upTo;
  }
  return found;
}
