#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow"]
# ///
"""Draw the cockpit's icon set from one geometry: `uv run scripts/icons.py`.

The mark is "Blueprint": a sawtooth factory roof drawn in outline on a drafting
grid, the factory as a plan that is stamped into a repository. Colours are the
cockpit's own (`app/globals.css`). It comes in two drawings, because a shape
that holds at 512 px turns to mush at 16:

- the MARK, on a 512 grid, with the grid behind it: the app icons;
- the GLYPH, on a 32 grid, no grid behind it, its 2-unit outline centred on odd
  coordinates so the line lands on whole pixels at both 32 and 16: the favicon.

Every file below is written by this script and never edited by hand. Change
the geometry here and run it again; the output is committed so a build needs
no Python. The files in `app/` are Next's metadata conventions (it links them
itself); the manifest's PNGs live in `public/`, which `app/manifest.ts` names.
"""

from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw

ACCENT = "#2f5bd3"
PAPER = "#fbfbfa"
GRID_OPACITY = 0.18


@dataclass(frozen=True)
class Drawing:
    grid: int  # the viewBox side
    radius: int  # the tile's corner radius
    roof: tuple  # the factory outline, closed
    stroke: float
    lines: tuple = ()  # drafting-grid positions, both axes
    line_width: float = 0


MARK = Drawing(
    grid=512, radius=112, stroke=28,
    roof=((112, 376), (112, 256), (208, 136), (208, 256), (304, 136), (304, 256), (400, 136),
          (400, 376)),
    lines=(64, 128, 192, 256, 320, 384, 448), line_width=4,
)
GLYPH = Drawing(
    grid=32, radius=7, stroke=2,
    roof=((7, 25), (7, 15), (13, 7), (13, 15), (19, 7), (19, 15), (25, 7), (25, 25)),
)

SUPERSAMPLE = 8
COCKPIT = Path(__file__).resolve().parent.parent


def grid_span(d: Drawing, rounded: bool) -> tuple[float, float]:
    """Where a grid line starts and ends: inside the tile's rounded corners, or edge to edge."""
    inset = 24 if rounded else 0
    return inset, d.grid - inset


def svg(d: Drawing) -> str:
    shapes = [f'<rect width="{d.grid}" height="{d.grid}" rx="{d.radius}" fill="{ACCENT}"/>']
    if d.lines:
        a, b = grid_span(d, rounded=True)
        path = "".join(f"M{p} {a}V{b}M{a} {p}H{b}" for p in d.lines)
        shapes.append(f'<path d="{path}" fill="none" stroke="{PAPER}" '
                      f'stroke-width="{d.line_width}" opacity="{GRID_OPACITY}"/>')
    roof = "".join(f"{'M' if i == 0 else 'L'}{x} {y}" for i, (x, y) in enumerate(d.roof))
    shapes.append(f'<path d="{roof}Z" fill="none" stroke="{PAPER}" stroke-width="{d.stroke}" '
                  'stroke-linejoin="round"/>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {d.grid} {d.grid}">'
            + "".join(shapes) + "</svg>\n")


def png(size: int, d: Drawing, *, rounded: bool, scale: float = 1.0) -> Image.Image:
    """Draw at SUPERSAMPLE times the size and scale down: Pillow's shapes are aliased.

    `scale` shrinks the art about the centre, tile and grid excepted (for the maskable icon).
    """
    big = size * SUPERSAMPLE
    k = big / d.grid
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(image).rounded_rectangle(
        (0, 0, big - 1, big - 1), radius=d.radius * k if rounded else 0, fill=ACCENT)

    if d.lines:
        layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(layer)
        a, b = grid_span(d, rounded)
        ink = (*Image.new("RGB", (1, 1), PAPER).getpixel((0, 0)), round(255 * GRID_OPACITY))
        for p in d.lines:
            draw.line([(p * k, a * k), (p * k, b * k)], fill=ink, width=round(d.line_width * k))
            draw.line([(a * k, p * k), (b * k, p * k)], fill=ink, width=round(d.line_width * k))
        image = Image.alpha_composite(image, layer)

    # A round-joined outline: every edge as a thick line, every vertex as a disc.
    centre = d.grid / 2
    points = [((x - centre) * scale + centre, (y - centre) * scale + centre) for x, y in d.roof]
    points = [(x * k, y * k) for x, y in points]
    width, r = d.stroke * scale * k, d.stroke * scale * k / 2
    draw = ImageDraw.Draw(image)
    for (x0, y0), (x1, y1) in zip(points, points[1:] + points[:1]):
        draw.line([(x0, y0), (x1, y1)], fill=PAPER, width=round(width))
    for x, y in points:
        draw.ellipse((x - r, y - r, x + r, y + r), fill=PAPER)
    return image.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    app, public = COCKPIT / "app", COCKPIT / "public"
    public.mkdir(exist_ok=True)

    (app / "icon.svg").write_text(svg(GLYPH))
    (COCKPIT / "scripts" / "mark.svg").write_text(svg(MARK))

    favicon = [png(s, GLYPH, rounded=True) for s in (16, 32, 48)]
    favicon[-1].save(app / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)],
                     append_images=favicon[:-1])

    # iOS rounds the corners itself and shows transparency as black: square and opaque.
    png(180, MARK, rounded=False).convert("RGB").save(app / "apple-icon.png")
    png(192, MARK, rounded=True).save(public / "icon-192.png")
    png(512, MARK, rounded=True).save(public / "icon-512.png")
    # Android crops a maskable icon to its own shape and keeps only the centre
    # 80% circle, 204.8 px out: full size the outline reaches 201, at 0.9 it reaches 181.
    png(512, MARK, rounded=False, scale=0.9).save(public / "icon-maskable-512.png")


if __name__ == "__main__":
    main()
