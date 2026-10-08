import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Crumbs, Notice, PageHeader, Section } from "../components/ui";
import { rootClasses, verticalMargins } from "./rhythm";

// One vertical rhythm (#154): the blocks every page is made of carry no outer
// margin, so the space between two of them is their container's gap and
// nothing else — whatever the container, a flex column, a grid or a card.

describe("a block of a page", () => {
  it("is a Section with no margin of its own", () => {
    const html = renderToStaticMarkup(<Section title="Spend" right={<span>this week</span>}><p>$3</p></Section>);

    expect(html.startsWith("<section")).toBe(true);
    expect(verticalMargins(rootClasses(html))).toEqual([]);
  });

  it("is a Notice with no margin of its own, in any tone", () => {
    for (const tone of ["wait", "bad", "ok", "none"] as const) {
      expect(verticalMargins(rootClasses(renderToStaticMarkup(<Notice tone={tone}>Nothing is waiting.</Notice>)))).toEqual([]);
    }
  });

  it("is a PageHeader with no margin of its own, with crumbs or without", () => {
    const bare = renderToStaticMarkup(<PageHeader title="Now" />);
    const full = renderToStaticMarkup(
      <PageHeader crumbs={<Crumbs trail={[{ label: "Factories", href: "/factories" }]} here="acme/widgets" />}
                  title="acme/widgets" sub="main at 1a2b3c4">
        <button type="button">Trigger…</button>
      </PageHeader>,
    );

    expect(bare.startsWith("<header")).toBe(true);
    expect(verticalMargins(rootClasses(bare))).toEqual([]);
    expect(verticalMargins(rootClasses(full))).toEqual([]);
  });
});
