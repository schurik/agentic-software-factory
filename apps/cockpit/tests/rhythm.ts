// One vertical rhythm (#154): a block — a Section, a Notice, a PageHeader —
// carries no outer margin, and the container it sits in sets the gap. A
// margin on the block adds to the container's gap instead of replacing it,
// which is how the Overview's sections once sat 64px apart instead of 32px.
// These read that off static markup, which is all a view test renders.

/** The classes of the markup's first element: a page's or a block's own. */
export function rootClasses(html: string): string[] {
  return classes(html.match(/^<[a-z][^>]*>/)?.[0] ?? "");
}

/** The classes of every `<tag>` element in the markup, in order. */
export function classesOf(html: string, tag: string): string[][] {
  return [...html.matchAll(new RegExp(`<${tag}(?=[\\s>])[^>]*>`, "g"))].map(([element]) => classes(element));
}

/** The vertical margins among `names`, at any breakpoint: what a block may not carry. */
export function verticalMargins(names: string[]): string[] {
  return names.filter((name) => /(^|:)-?m[tby]?-/.test(name));
}

function classes(element: string): string[] {
  return element.match(/\sclass="([^"]*)"/)?.[1].split(/\s+/).filter(Boolean) ?? [];
}
