"""Render the storefront icon as a raster PNG.

The plugin market's catalogue accepts only GitHub-hosted raster images for a
storefront tile (SVG is refused), so the same mark as `icon.svg` is drawn here:
a rounded blue tile, a white cloud, and a downward arrow into it.

    python assets/make-icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 256
SCALE = 4  # draw large, then downsample for clean edges
BLUE_TOP = (79, 143, 247)
BLUE_BOTTOM = (43, 98, 214)
ARROW = (31, 79, 176)
WHITE = (255, 255, 255)


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def main():
    size = SIZE * SCALE
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # Rounded tile with a vertical gradient, masked by the rounded rectangle.
    gradient = Image.new("RGBA", (size, size))
    pen = ImageDraw.Draw(gradient)
    for y in range(size):
        pen.line([(0, y), (size, y)], fill=lerp(BLUE_TOP, BLUE_BOTTOM, y / size) + (255,))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)
    image.paste(gradient, (0, 0), mask)

    draw = ImageDraw.Draw(image)

    # The cloud: three overlapping discs on a flat base, as in the SVG path.
    unit = size / 64
    cloud = WHITE + (242,)
    draw.ellipse([22 * unit, 21 * unit, 40 * unit, 39 * unit], fill=cloud)
    draw.ellipse([33 * unit, 26 * unit, 46 * unit, 39 * unit], fill=cloud)
    draw.rounded_rectangle([20 * unit, 28 * unit, 45 * unit, 39 * unit], radius=5 * unit, fill=cloud)

    # The arrow pointing down into the cloud.
    stroke = 3.4 * unit
    draw.line([32 * unit, 41 * unit, 32 * unit, 52 * unit], fill=ARROW, width=round(stroke))
    draw.line([26.5 * unit, 46 * unit, 32 * unit, 52 * unit], fill=ARROW, width=round(stroke))
    draw.line([37.5 * unit, 46 * unit, 32 * unit, 52 * unit], fill=ARROW, width=round(stroke))

    # The two white ticks either side, as in the SVG.
    tick = 3 * unit
    draw.line([18 * unit, 46 * unit, 24 * unit, 46 * unit], fill=WHITE + (230,), width=round(tick))
    draw.line([40 * unit, 46 * unit, 46 * unit, 46 * unit], fill=WHITE + (230,), width=round(tick))

    out = Path(__file__).with_name("icon-256.png")
    image.resize((SIZE, SIZE), Image.LANCZOS).save(out)
    print(f"wrote {out} ({out.stat().st_size} bytes, {SIZE}x{SIZE})")


if __name__ == "__main__":
    main()
