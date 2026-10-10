"""Rain theme: artwork and generated rules, written into src/themes/rain.css from rain.tpl.css.

Usage: python tools/themes/gen-rain.py  (then node build.mjs)

Rain is a close look at a window on a rainy night. The glass is in focus: beads of water like small lenses, drops
that run down it in fits and starts, new drops landing on it in time with the music. Beyond it, out of focus, a
city: its lights are soft discs of colour in three depths (warm windows and street lamps, signs in the album's
colours, a few big blurred lights close by), cars going by, and rain falling between the glass and the city.
Nothing is drawn but light and water.

The pictures are vector art made here once (seeded, so every build is identical); the stylesheet only moves them
(transform and opacity), so they stay sharp at any size and smooth at any frame rate. A light out of focus is a
disc with a soft edge and a brighter rim, the way a lens draws it: crisp, not smeared."""
import os
import random

from artlib import n, svg

D = os.path.dirname(os.path.abspath(__file__))
W, H = 1600, 900  # the pictures, in design units (16:9, they cover the screen)
NL = "\n"

# the city's own lights: warm windows and lamps, a few cool ones, a little rose and teal
CITY = [("#ffc477", 0.32), ("#fff0d4", 0.22), ("#ff9e5e", 0.12), ("#ff92bd", 0.1), ("#dfe7ff", 0.14), ("#7fd8ff", 0.06), ("#ffe08a", 0.04)]


def pick(r, table):
    x = r.random() * sum(w for _, w in table)
    for v, w in table:
        x -= w
        if x <= 0:
            return v
    return table[-1][0]


# =============================================================================== lights out of focus
def disc_defs(colours):
    """One radial gradient per colour: a soft edge and a brighter rim, as a lens draws a point of light."""
    out = []
    for i, c in enumerate(colours):
        out.append(
            f"<radialGradient id='g{i}'><stop offset='0' stop-color='{c}' stop-opacity='.4'/><stop offset='.6' stop-color='{c}' stop-opacity='.47'/>"
            f"<stop offset='.86' stop-color='{c}' stop-opacity='.66'/><stop offset='.95' stop-color='{c}' stop-opacity='.48'/><stop offset='1' stop-color='{c}' stop-opacity='0'/></radialGradient>"
        )
    return "".join(out)


def place(r, band):
    """Where a light sits: most along the city's middle distance, some higher up in the towers, a few at street level."""
    k = r.random()
    if band == "far":
        if k < 0.78:
            y = r.triangular(0.5, 0.92, 0.7)
        elif k < 0.9:
            y = r.uniform(0.3, 0.52)
        else:
            y = r.uniform(0.88, 1.0)
    elif band == "mid":
        y = r.triangular(0.5, 1.04, 0.8)
    else:
        y = r.triangular(0.25, 1.1, 0.85)
    return r.uniform(-0.02, 1.02) * W, y * H


def bokeh(seed, count, rmin, rmax, band, colours=None, op=(0.45, 1.0)):
    """A layer of lights out of focus. colours=None draws them white (for a mask the album's colours fill)."""
    r = random.Random(seed)
    cols = [c for c, _ in CITY] if colours is None else colours
    groups = {}
    for _ in range(count):
        x, y = place(r, band)
        if band == "near" and 0.3 < x / W < 0.7 and r.random() < 0.75:  # keep the big ones off the middle, where the words are
            x = (r.uniform(-0.04, 0.3) if r.random() < 0.5 else r.uniform(0.7, 1.04)) * W
        rad = rmin + (rmax - rmin) * r.random() ** 1.8
        c = pick(r, CITY) if colours is None else r.choice(colours)
        o = round(r.uniform(*op), 1)
        groups.setdefault((cols.index(c), o), []).append(f"<circle cx='{n(x)}' cy='{n(y)}' r='{n(rad)}'/>")
    body = "".join(f"<g fill='url(#g{k})' fill-opacity='{o}'>{''.join(v)}</g>" for (k, o), v in sorted(groups.items()))
    return svg(W, H, body, disc_defs(cols), "xMidYMid slice")


def streak_tile(seed, count, alpha, lmin, lmax, wmin, wmax, tile, slant=0.12, colour="#d6dcff"):
    """A tile of rain streaks that joins up at every edge, grouped by look so the data stays short."""
    r = random.Random(seed)
    groups = {}
    for _ in range(count):
        x, y = r.uniform(0, tile), r.uniform(0, tile)
        ln = r.uniform(lmin, lmax)
        w = round(r.uniform(wmin, wmax), 1)
        o = round(r.uniform(0.4, 1) * alpha, 2)
        dx = -ln * slant
        for ox in (0, -tile, tile):
            for oy in (0, -tile, tile):
                xa, ya = x + ox, y + oy
                if max(xa, xa + dx) < -6 or min(xa, xa + dx) > tile + 6 or ya + ln < -6 or ya > tile + 6:
                    continue
                groups.setdefault((w, o), []).append(f"M{n(xa)} {n(ya)}l{n(dx)} {n(ln)}")
    body = "".join(f"<path d='{''.join(v)}' stroke-width='{k[0]}' stroke-opacity='{k[1]}'/>" for k, v in groups.items())
    return svg(tile, tile, f"<g stroke='{colour}' stroke-linecap='round' fill='none'>{body}</g>", "", "none")


# =============================================================================== water on the glass
# A bead of water is a small lens: it shows the city upside down, so its top holds the warm light of the streets and
# its bottom the dark sky; light gathers along its lower edge, and a bright spot sits up left. Drawn at unit size.
DROP_DEFS = (
    "<linearGradient id='d' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#ffd6a0' stop-opacity='.62'/><stop offset='.38' stop-color='#f3b4d4' stop-opacity='.3'/>"
    "<stop offset='.66' stop-color='#7d78d0' stop-opacity='.16'/><stop offset='1' stop-color='#120d2c' stop-opacity='.6'/></linearGradient>"
    "<linearGradient id='e' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#ffb2d8' stop-opacity='.6'/><stop offset='.38' stop-color='#c3b0ff' stop-opacity='.3'/>"
    "<stop offset='.66' stop-color='#6f7fd8' stop-opacity='.16'/><stop offset='1' stop-color='#100c2a' stop-opacity='.6'/></linearGradient>"
)
_BEAD = (
    "<ellipse rx='1' ry='1' fill='url(#{g})'/>"
    "<path d='M.94 .18A.96 .96 0 0 1 -.62 .74' fill='none' stroke='#f2f4ff' stroke-opacity='.6' stroke-width='.1' stroke-linecap='round'/>"
    "<ellipse rx='1' ry='1' fill='none' stroke='#0b0920' stroke-opacity='.32' stroke-width='.07'/>"
    "<ellipse cx='-.38' cy='-.44' rx='.24' ry='.16' fill='#fff' fill-opacity='.95' transform='rotate(-24 -.38 -.44)'/>"
)
DROP_SYMBOLS = (
    f"<symbol id='a' overflow='visible'>{_BEAD.format(g='d')}</symbol>"
    f"<symbol id='b' overflow='visible'>{_BEAD.format(g='e')}</symbol>"
    "<symbol id='c' overflow='visible'><ellipse rx='1' ry='1' fill='url(#d)'/><ellipse cx='-.3' cy='-.36' rx='.42' ry='.3' fill='#fff' fill-opacity='.9'/></symbol>"
)


def glass_drops(seed=31):
    r = random.Random(seed)
    tracks, beads = [], []
    for count, lo, hi in ((230, 0.9, 2.0), (90, 2.2, 4.2), (24, 4.6, 8.0), (6, 9.0, 13.0)):
        for _ in range(count):
            x = r.uniform(0, W)
            y = H * (r.random() ** 0.8) if r.random() < 0.55 else r.uniform(0, H)
            rx = r.uniform(lo, hi)
            ry = rx * r.uniform(1.0, 1.2)
            if lo > 4 and r.random() < 0.4:  # the clear track it left as it slid here
                ln = r.uniform(30, 150)
                tracks.append(f"M{n(x)} {n(y - ry - ln)}V{n(y - ry * 0.6)}")
            sym = "c" if rx < 2.1 else ("a" if r.random() < 0.65 else "b")
            beads.append(f"<use href='#{sym}' transform='translate({n(x)} {n(y)})scale({n(rx, 2)} {n(ry, 2)})'/>")
    track = f"<path d='{''.join(tracks)}' stroke='#e2e8ff' stroke-opacity='.13' stroke-width='3.2' stroke-linecap='round' fill='none'/>"
    return svg(W, H, track + "".join(beads), DROP_DEFS + DROP_SYMBOLS, "xMidYMid slice")


def runner_head():
    """A running drop: rounder below, drawn out to a point above."""
    body = (
        "<path d='M20 2C25 16 37 26 37 38C37 48 29 54 20 54C11 54 3 48 3 38C3 26 15 16 20 2Z' fill='url(#d)'/>"
        "<path d='M35.5 40A15.5 15.5 0 0 1 8 49' fill='none' stroke='#f2f4ff' stroke-opacity='.6' stroke-width='1.8' stroke-linecap='round'/>"
        "<path d='M20 2C25 16 37 26 37 38C37 48 29 54 20 54C11 54 3 48 3 38C3 26 15 16 20 2Z' fill='none' stroke='#0b0920' stroke-opacity='.3' stroke-width='1.2'/>"
        "<ellipse cx='14' cy='30' rx='3.4' ry='6.2' fill='#fff' fill-opacity='.92' transform='rotate(14 14 30)'/>"
    )
    return svg(40, 56, body, DROP_DEFS, "xMidYMid meet")


def bead():
    """A drop that has just landed: a round bead."""
    return svg(40, 40, f"<g transform='translate(20 20)scale(18)'>{_BEAD.format(g='d')}</g>", DROP_DEFS, "xMidYMid meet")


def runner_rules(first, count):
    r = random.Random(77)
    rules = []
    for i in range(count):
        x = 4 + (i + r.uniform(0.1, 0.9)) * 92 / count
        y = r.uniform(2, 46)
        dy = (100 - y) + r.uniform(2, 10)
        s = r.uniform(1.5, 2.5)
        dur = r.uniform(20, 40)
        rules.append(
            f".aur-root[data-fx=\"rain\"] .aur-fx-e > i:nth-child({first + i}) {{ --x: {x:.1f}%; --y: {y:.1f}vh; --dy: {dy:.1f}vh; --s: {s:.2f}vmin; "
            f"--dur: {dur:.1f}s; --delay: {-r.uniform(0, dur):.1f}s; --hv: aur-rn-head-{i % 3 + 1}; --tv: aur-rn-trail-{i % 3 + 1}; }}"
        )
    return NL.join(rules)


def runner_frames():
    """Stop-and-go slides: a drop crawls, stalls where the glass is dry, then breaks free."""
    shapes = {
        1: [(0, 0), (5, 0.05), (13, 0.08), (24, 0.3), (35, 0.33), (50, 0.62), (58, 0.63), (74, 0.9), (84, 1.0)],
        2: [(0, 0), (8, 0.02), (20, 0.16), (27, 0.17), (33, 0.45), (48, 0.5), (55, 0.82), (62, 0.83), (80, 1.0)],
        3: [(0, 0), (4, 0.04), (9, 0.24), (17, 0.26), (30, 0.4), (40, 0.42), (46, 0.66), (66, 0.72), (72, 0.95), (82, 1.0)],
    }
    wob = [0, 0.1, -0.08, 0.14, -0.05, 0.12, -0.1, 0.06, 0, 0.08]
    out = []
    for v, steps in shapes.items():
        head, trl = [], []
        for k, (t, f) in enumerate(steps):
            wb = wob[k % len(wob)] * (1 if v != 2 else -1)
            extra = " scale: 0.3;" if t == 0 else (" scale: 1;" if k == 1 else "")
            op = " opacity: 0;" if t == 0 else (" opacity: 1;" if k == 1 else "")
            head.append(f"\t{t}% {{ translate: {wb}vmin calc(var(--dy) * {f});{extra}{op} }}")
            trl.append(f"\t{t}% {{ scale: 1 {f};{op} }}")
        last = steps[-1][0]
        head.append(f"\t{last + 6}% {{ translate: 0 var(--dy); opacity: 1; }}\n\t{last + 12}%, 100% {{ translate: 0 var(--dy); opacity: 0; }}")
        trl.append(f"\t{last + 6}% {{ scale: 1 1; opacity: 1; }}\n\t{last + 12}%, 100% {{ scale: 1 1; opacity: 0; }}")
        out.append(f"@keyframes aur-rn-head-{v} {{\n" + NL.join(head) + "\n}")
        out.append(f"@keyframes aur-rn-trail-{v} {{\n" + NL.join(trl) + "\n}")
    return NL.join(out)


def landing_rules(first, count):
    """Drops that land on the glass. Each comes back after a whole number of beats (5 to 13, all different), so they
    land in time with the song but never all together."""
    r = random.Random(5)
    beats = [5, 7, 9, 11, 6, 8, 10, 13][:count]
    rules = []
    for i, k in enumerate(beats):
        x = r.uniform(4, 96)
        y = r.uniform(6, 90)
        if 22 < x < 78 and 30 < y < 62:  # not right behind the words
            y = r.choice((r.uniform(6, 26), r.uniform(66, 90)))
        s = r.uniform(1.1, 2.1)
        rules.append(
            f".aur-root[data-fx=\"rain\"] .aur-fx-e > i:nth-child({first + i}) {{ left: {x:.1f}%; top: {y:.1f}%; --s: {s:.2f}vmin; "
            f"animation-duration: calc(var(--aur-beat, 0.6s) * {k}); animation-delay: calc(var(--aur-beat, 0.6s) * {-r.uniform(0, k):.2f}); }}"
        )
    return NL.join(rules)


def build():
    return {
        "RN_FAR": bokeh(3, 150, 5, 15, "far", op=(0.5, 1.0)),
        "RN_FAR_SIGNS": bokeh(8, 24, 7, 17, "far", colours=["#fff"], op=(0.5, 1.0)),
        "RN_MID": bokeh(14, 20, 24, 46, "mid", op=(0.22, 0.55)),
        "RN_NEAR": bokeh(29, 6, 90, 150, "near", op=(0.12, 0.26)),
        "RN_RAIN": streak_tile(19, 70, 0.34, 40, 110, 0.9, 1.6, 600),
        "RN_DROPS": glass_drops(),
        "RN_HEAD": runner_head(),
        "RN_BEAD": bead(),
        "RN_RUNNERS": runner_rules(2, 8),
        "RN_RUNNER_FRAMES": runner_frames(),
        "RN_LANDING": landing_rules(10, 8),
    }


def main():
    values = build()
    tpl = open(os.path.join(D, "rain.tpl.css"), encoding="utf-8").read()
    for k, v in values.items():
        tpl = tpl.replace("{{" + k + "}}", v)
    assert "{{" not in tpl, "unfilled placeholder"
    out = os.path.join(D, "..", "..", "src", "themes", "rain.css")
    open(out, "w", encoding="utf-8", newline="\n").write(tpl)
    print("rain.css", len(tpl), "bytes;", {k: len(v) for k, v in values.items() if len(v) > 4000})


if __name__ == "__main__":
    main()
