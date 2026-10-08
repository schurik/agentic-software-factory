import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TabPanel, Tabs } from "../components/ui";

// Every tab bar in the cockpit is base-ui's Tabs (#155), drawn once in
// components/ui.tsx: the arrow keys, the roles and the links between a tab and
// its panel are the library's, and the underline is its Indicator — never a
// tab's own border pulled over the row's by a negative margin, which made
// every row scroll vertically by a pixel.

const sources = import.meta.glob(["../components/**/*.tsx", "../app/**/*.tsx"],
                                 { eager: true, query: "?raw", import: "default" }) as Record<string, string>;

function tabs(selected: "one" | "two" = "two") {
  return renderToStaticMarkup(
    <Tabs label="Things" selected={selected} onSelect={() => {}} end={<a href="/elsewhere">Elsewhere</a>}
          pinned={<button type="button">Discard</button>}
          tabs={[{ id: "one", label: "One" }, { id: "two", label: "Two" }]}>
      <TabPanel value="one" keepMounted>first</TabPanel>
      <TabPanel value="two" keepMounted>second</TabPanel>
    </Tabs>,
  );
}

/** The element `html` opens at `at`, through its matching close: what it holds. */
function element(html: string, at: number): string {
  const tags = /<(\/?)div\b[^>]*>/g;
  tags.lastIndex = at;
  for (let depth = 0, tag; (tag = tags.exec(html)); ) {
    depth += tag[1] ? -1 : 1;
    if (depth === 0) return html.slice(at, tags.lastIndex);
  }
  return html.slice(at);
}

describe("Tabs", () => {
  it("is base-ui's: a labelled tablist, its selected tab underlined by the Indicator, over the panels", () => {
    const html = tabs();
    expect(html).toMatch(/role="tablist" aria-label="Things"/);
    const [one, two] = [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map(([tag]) => tag);
    expect(one).toContain('aria-selected="false"');
    expect(two).toContain('aria-selected="true"');
    expect(two).toContain("data-active");
    // The Indicator sits inside the tablist, and is placed once the tabs are measured — in the browser.
    const list = html.slice(html.indexOf('role="tablist"'), html.indexOf("</div>"));
    expect(list).toMatch(/<span[^>]*role="presentation"[^>]*class="absolute bottom-0[^"]*w-\(--active-tab-width\)[^"]*bg-accent/);
    // A panel kept mounted is hidden, and inert, while another tab is selected.
    expect(html).toMatch(/<div[^>]*hidden=""[^>]*role="tabpanel"[^>]*>first</);
    expect(html).toMatch(/<div(?![^>]*hidden)[^>]*role="tabpanel"[^>]*>second</);
    expect(tabs("one")).toMatch(/<div(?![^>]*hidden)[^>]*role="tabpanel"[^>]*>first</);
  });

  it("scrolls sideways, with no scrollbar, and no tab overflows the row", () => {
    const html = tabs();
    expect(html).toMatch(/class="[^"]*overflow-x-auto[^"]*no-scrollbar|class="[^"]*no-scrollbar[^"]*overflow-x-auto/);
    expect(html).not.toMatch(/-m[by]-/);
    expect(html).not.toContain("border-b-2");
    expect(html).toContain('href="/elsewhere"');
  });

  it("scrolls `end` with the tabs, and keeps `pinned` in view beside them", () => {
    const html = tabs();
    const scroller = element(html, html.lastIndexOf("<div", html.search(/class="[^"]*overflow-x-auto/)));
    expect(scroller).toContain('role="tablist"');
    expect(scroller).toContain(">Elsewhere</a>");
    expect(scroller).not.toContain(">Discard</button>");
    expect(html).toContain(">Discard</button>");
  });

  it("is the only tab bar: nothing else draws a tab, a tablist or a tabpanel by hand", () => {
    const drawn = Object.entries(sources)
      .filter(([, source]) => /role=["{]+["'`]?tab(list|panel)?["'`]/.test(source))
      .map(([path]) => path);
    expect(drawn).toEqual([]);
    // A panel's id is base-ui's to give: one given by hand is not the one its tab's aria-controls names.
    expect(Object.entries(sources).filter(([, source]) => /<TabPanel\b[^>]*\sid=/.test(source)).map(([path]) => path)).toEqual([]);
    expect(Object.entries(sources).filter(([, source]) => source.includes('from "@base-ui/react/tabs"')).map(([path]) => path))
      .toEqual(["../components/ui.tsx"]);
  });
});
