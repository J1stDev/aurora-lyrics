"""Neon theme: a tunnel of neon light, written into src/themes/neon.css from neon.tpl.css.

Usage: python tools/themes/gen-neon.py  (then node build.mjs)

You fly down a dark tunnel built from rings of glass tube. A ring passes you on every beat, in the album's
three colours; rails run along the corners and lines along the floor towards a glow at the far end. The rings
are plain CSS boxes (a tube is a border and its glows), crisp at any size and in any window shape, so this
script draws nothing but the rails. What it works out is how a ring moves: one flying towards you at a steady
speed grows as 1 / distance, slowly while it is far and then in a rush, and the keyframes sample that curve.
"""
import os

from artlib import n, svg

D = os.path.dirname(os.path.abspath(__file__))
NL = "\n"

VP = (50.0, 46.0)  # the vanishing point, % of the screen (a little above the middle)
BOX = (5.0, 6.0, 95.0, 94.0)  # a ring at scale 1: its box on the screen, % (left, top, right, bottom)
S_FAR, S_NEAR = 0.18, 1.32  # a ring's scale as it comes out of the dark, and once it is past you
FADE_IN = 0.42  # the share of its trip a ring spends coming out of the dark


def ring_keyframes():
    """Scale and opacity of a ring over its trip, sampled densely where it rushes."""
    a = 1 / S_FAR
    b = a - 1 / S_NEAR
    ts = [0, 0.08, 0.16, 0.24, 0.32, 0.4, 0.48, 0.56, 0.63, 0.7, 0.76, 0.81, 0.855, 0.89, 0.915, 0.935, 0.952, 0.966, 0.978, 0.988, 0.996, 1]
    rows = []
    for t in ts:
        s = 1 / (a - b * t)
        f = min(1.0, t / FADE_IN)
        op = 0.0 if t >= 1 else f * f * (3 - 2 * f)  # out of the dark, smoothly; gone once it is past
        rows.append(f"\t{n(t * 100, 1)}% {{ transform: scale({s:.4f}); opacity: {op:.3f}; }}")
    return NL.join(rows)


def rails():
    """The corner rails and the floor lines, as a white mask: each line a soft glow and a fine core, fading out
    towards the far end. The picture is stretched to the screen, the strokes keep their width."""
    w = h = 1000
    vx, vy = VP[0] * 10, VP[1] * 10
    l, t, r, b = (v * 10 for v in BOX)

    def ray(x, y):  # from the vanishing point through (x, y), on past the edge of the screen
        k = 1.7
        return f"M{n(vx)} {n(vy)}L{n(vx + (x - vx) * k)} {n(vy + (y - vy) * k)}"

    corners = "".join(ray(x, y) for x, y in ((l, t), (r, t), (l, b), (r, b)))
    floor = "".join(ray(l + (r - l) * i / 8, b) for i in range(1, 8))
    defs = (
        f"<radialGradient id='f' gradientUnits='userSpaceOnUse' cx='{n(vx)}' cy='{n(vy)}' r='640'>"
        "<stop offset='0' stop-color='#fff' stop-opacity='0'/><stop offset='.14' stop-color='#fff' stop-opacity='0'/>"
        "<stop offset='.42' stop-color='#fff' stop-opacity='.45'/><stop offset='1' stop-color='#fff'/></radialGradient>"
    )
    line = lambda d, width, op: f"<path d='{d}' fill='none' stroke='url(#f)' stroke-width='{width}' stroke-opacity='{op}' stroke-linecap='round' vector-effect='non-scaling-stroke'/>"
    body = line(corners, 9, 0.12) + line(corners, 1.8, 0.9) + line(floor, 7, 0.08) + line(floor, 1.2, 0.55)
    return svg(w, h, body, defs)


def build():
    return {
        "NT_RING_KEYS": ring_keyframes(),
        "NT_RAILS": rails(),
        # the vanishing point inside a ring's own box, where it grows from
        "NT_ORIGIN": f"{(VP[0] - BOX[0]) / (BOX[2] - BOX[0]) * 100:.2f}% {(VP[1] - BOX[1]) / (BOX[3] - BOX[1]) * 100:.2f}%",
        "NT_INSET": f"{BOX[1]:g}% {100 - BOX[2]:g}% {100 - BOX[3]:g}% {BOX[0]:g}%",
        "NT_VP": f"{VP[0]:g}% {VP[1]:g}%",
        "NT_VP_X": f"{VP[0]:g}%",
        "NT_VP_Y": f"{VP[1]:g}%",
    }


def main():
    values = build()
    tpl = open(os.path.join(D, "neon.tpl.css"), encoding="utf-8").read()
    for k, v in values.items():
        tpl = tpl.replace("{{" + k + "}}", v)
    assert "{{" not in tpl, "unfilled placeholder"
    out = os.path.join(D, "..", "..", "src", "themes", "neon.css")
    open(out, "w", encoding="utf-8", newline="\n").write(tpl)
    print("neon.css", len(tpl), "bytes")


if __name__ == "__main__":
    main()
