"""Helpers shared by the theme art generators (gen-neon.py, gen-rain.py): SVG data URIs and number formatting.

The art is drawn once, with seeded random numbers, so every build is identical; the CSS only moves it
(transform and opacity)."""
from urllib.parse import quote


# ------------------------------------------------------------------------------------ SVG
def uri(svg_text):
    """An SVG document as a CSS url("data:...")."""
    svg_text = " ".join(svg_text.split())
    return 'url("data:image/svg+xml,' + quote(svg_text, safe=" =:/,.-;'()!*") + '")'


def svg(w, h, body, defs="", par="none"):
    d = f"<defs>{defs}</defs>" if defs else ""
    return uri(f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {w} {h}' preserveAspectRatio='{par}'>{d}{body}</svg>")


def n(v, digits=1):
    """A short number for path data."""
    s = f"{v:.{digits}f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def stops(spec):
    """[(offset, colour, opacity)] as gradient stops."""
    return "".join(f"<stop offset='{o}' stop-color='{c}'" + (f" stop-opacity='{a}'" if a != 1 else "") + "/>" for o, c, a in spec)
