"""Vaporwave and Ocean theme ambience: artwork and generated rules (seeded, so every build is
identical) written into the two theme blocks of src/styles.css.

Usage: python tools/themes/gen-dream.py  (then node build.mjs)

Vaporwave is a pastel dream: a gradient sky with drifting clouds and a ringed planet, a checkerboard
floor that rolls toward you in tempo, palms on the horizon, a spectrum window and glinting stars,
all under a VHS overlay; the cover becomes an old OS window. Ocean is a dive that lasts one song:
caustics and soft light shafts near the surface, a manta ray and a school of fish passing,
marine snow, bubbles and glowing jellyfish that fade in as the water darkens.

Each theme has a template (*.tpl.css) with {{PLACEHOLDER}} values."""
import math, os, random
from urllib.parse import quote

D = os.path.dirname(os.path.abspath(__file__))


def uri(svg_text):
    svg_text = " ".join(svg_text.split())
    return 'url("data:image/svg+xml,' + quote(svg_text, safe=" =:/,.-;'()!*") + '")'


def svg(w, h, body, defs="", par="none"):
    d = f"<defs>{defs}</defs>" if defs else ""
    return uri(f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {w} {h}' preserveAspectRatio='{par}'>{d}{body}</svg>")


def pts(points):
    return " ".join(f"{round(x, 1)} {round(y, 1)}" for x, y in points)


def stops(spec):
    """[(offset, colour, opacity)] as gradient stops."""
    return "".join(f"<stop offset='{o}' stop-color='{c}'" + (f" stop-opacity='{a}'" if a != 1 else "") + "/>" for o, c, a in spec)


# =============================================================================== VAPORWAVE
def vw_clouds(seed, n, top, bottom, alpha, wmin, wmax, hmin, hmax, ymin, ymax, W=1600, H=400):
    """Flat-bottomed cumulus, lit from above, with a shaded underside. The tile wraps: clouds near an
    edge are drawn again on the other side, so CSS can scroll it by exactly one tile."""
    r = random.Random(seed)
    defs, out = [], []
    for i in range(n):
        cx = (i + r.uniform(0.15, 0.85)) * W / n
        w, h = r.uniform(wmin, wmax), r.uniform(hmin, hmax)
        base = r.uniform(ymin, ymax)
        puffs = []
        k = r.randint(5, 8)
        for j in range(k):
            t = (j + 0.5) / k
            rad = h * (0.3 + 0.66 * math.sin(math.pi * t) ** 0.85) * r.uniform(0.82, 1.12)
            puffs.append((-w / 2 + w * t, -rad * 0.62, rad))
        defs.append(f"<linearGradient id='g{i}' gradientUnits='userSpaceOnUse' x1='0' y1='{base - h * 1.5:.0f}' x2='0' y2='{base:.0f}'>{stops([(0, top, 1), (1, bottom, 1)])}</linearGradient>")
        defs.append(f"<clipPath id='u{i}'>" + "".join(f"<circle cx='{px:.0f}' cy='{py:.0f}' r='{pr:.0f}'/>" for px, py, pr in puffs) + "</clipPath>")
        shapes = "".join(f"<circle cx='{px:.0f}' cy='{py:.0f}' r='{pr:.0f}'/>" for px, py, pr in puffs)
        shade = f"<rect x='{-w:.0f}' y='{-h * 0.36:.0f}' width='{w * 2:.0f}' height='{h:.0f}' fill='#5b2aa8' fill-opacity='.32' clip-path='url(#u{i})'/>"
        cloud = f"<g clip-path='url(#f{i})'><g fill='url(#g{i})'>{shapes}</g>{shade}</g>"
        defs.append(f"<clipPath id='f{i}'><rect x='{-w:.0f}' y='{-h * 2:.0f}' width='{w * 2:.0f}' height='{h * 2:.0f}'/></clipPath>")
        for dx in (0, -W, W):
            if dx and not (cx - w / 2 + dx < W and cx + w / 2 + dx > 0):
                continue
            out.append(f"<g transform='translate({cx + dx:.0f} {base:.0f})'>{cloud}</g>")
    return svg(W, H, f"<g fill-opacity='{alpha}' opacity='{alpha}'>{''.join(out)}</g>", "".join(defs), "none")


def vw_planet():
    """A ringed planet: the back of the ring, the planet with its bands, then the front of the ring."""
    W, H = 480, 320
    cx, cy, r = 240, 166, 104
    rx, ry = 216, 46
    defs = (
        f"<linearGradient id='p' x1='0' y1='0' x2='1' y2='1'>{stops([(0, '#fff0a8', 1), (0.42, '#ff9fd4', 1), (1, '#8d6bff', 1)])}</linearGradient>"
        f"<linearGradient id='g'>{stops([(0, '#5ff2ff', 1), (0.5, '#ff7ed2', 1), (1, '#b48cff', 1)])}</linearGradient>"
        f"<radialGradient id='h' cx='.3' cy='.28' r='.6'>{stops([(0, '#fff', 0.7), (1, '#fff', 0)])}</radialGradient>"
        f"<radialGradient id='s' cx='.72' cy='.74' r='.72'>{stops([(0, '#2a0f6b', 0), (0.55, '#2a0f6b', 0.1), (1, '#2a0f6b', 0.55)])}</radialGradient>"
        f"<clipPath id='c'><circle cx='{cx}' cy='{cy}' r='{r}'/></clipPath>"
    )
    bands = "".join(
        f"<path d='M{cx - r} {cy + dy}Q{cx} {cy + dy + bulge} {cx + r} {cy + dy}' fill='none' stroke='{col}' stroke-opacity='{op}' stroke-width='{w}'/>"
        for dy, bulge, col, op, w in ((-52, 14, '#fff', 0.22, 9), (-22, 20, '#7a4bd8', 0.2, 14), (10, 24, '#fff', 0.16, 8), (40, 22, '#7a4bd8', 0.22, 16), (74, 14, '#fff', 0.14, 7))
    )
    ring = f"rotate(-16 {cx} {cy})"
    body = (
        f"<g transform='{ring}'><ellipse cx='{cx}' cy='{cy}' rx='{rx}' ry='{ry}' fill='none' stroke='url(#g)' stroke-width='15' stroke-opacity='.85'/></g>"
        f"<circle cx='{cx}' cy='{cy}' r='{r}' fill='url(#p)'/><g clip-path='url(#c)'>{bands}</g>"
        f"<circle cx='{cx}' cy='{cy}' r='{r}' fill='url(#s)'/><circle cx='{cx}' cy='{cy}' r='{r}' fill='url(#h)'/>"
        f"<g transform='{ring}'><path d='M{cx - rx} {cy}A{rx} {ry} 0 0 0 {cx + rx} {cy}' fill='none' stroke='url(#g)' stroke-width='15'/>"
        f"<path d='M{cx - rx + 10} {cy + 3}A{rx - 10} {ry - 5} 0 0 0 {cx + rx - 10} {cy + 3}' fill='none' stroke='#fff' stroke-opacity='.35' stroke-width='2'/></g>"
    )
    return svg(W, H, body, defs, "xMidYMid meet")


def palm(cx, base_y, height, lean, fronds, seed, scale=1.0):
    r = random.Random(seed)
    tip = (cx + lean, base_y - height)
    ctrl = (cx + lean * 0.1, base_y - height * 0.6)

    def bez(t):
        u = 1 - t
        return (u * u * cx + 2 * u * t * ctrl[0] + t * t * tip[0], u * u * base_y + 2 * u * t * ctrl[1] + t * t * tip[1])

    left, right = [], []
    for k in range(21):
        t = k / 20
        x, y = bez(t)
        x2, y2 = bez(min(t + 0.01, 1))
        x1, y1 = bez(max(t - 0.01, 0))
        dx, dy = x2 - x1, y2 - y1
        n = math.hypot(dx, dy) or 1
        wd = (14 - 8 * t) * scale
        left.append((x - dy / n * wd / 2, y + dx / n * wd / 2))
        right.append((x + dy / n * wd / 2, y - dx / n * wd / 2))
    out = [f"<path d='M{pts(left + right[::-1])}Z'/>"]
    for k in range(fronds):
        a = math.radians(-180 + (k + 0.5) * 180 / fronds + r.uniform(-8, 8))
        ln = r.uniform(130, 200) * scale
        ex, ey = tip[0] + math.cos(a) * ln, tip[1] + math.sin(a) * ln * 0.55 + ln * 0.5 * abs(math.cos(a))
        mx, my = tip[0] + math.cos(a) * ln * 0.55, tip[1] + math.sin(a) * ln * 0.75 - 24 * scale
        wd = 17 * scale
        out.append(f"<path d='M{tip[0]:.1f} {tip[1]:.1f}Q{mx:.1f} {my - wd:.1f} {ex:.1f} {ey:.1f}Q{mx:.1f} {my + wd:.1f} {tip[0]:.1f} {tip[1]:.1f}Z'/>")
    return "".join(out)


def vw_palms():
    """Four palms on the horizon, two at each edge, in a deep violet."""
    W, H = 1600, 360
    body = (
        "<g fill='#1b0a44'>"
        + palm(40, H, 300, 36, 9, 5)
        + palm(118, H, 205, -22, 8, 8, 0.72)
        + palm(1562, H, 310, -46, 9, 13)
        + palm(1484, H, 210, 26, 8, 21, 0.7)
        + "</g>"
    )
    return svg(W, H, body, "", "xMidYMax slice")


def vw_noise():
    """Film grain: white specks in a seamless 240px tile."""
    defs = (
        "<filter id='n' x='0' y='0' width='240' height='240' filterUnits='userSpaceOnUse'>"
        "<feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' seed='4' stitchTiles='stitch'/>"
        "<feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  1.9 0 0 0 -.78'/></filter>"
    )
    return svg(240, 240, "<rect width='240' height='240' filter='url(#n)'/>", defs, "none")


def vw_bars():
    """The twelve bars of the spectrum window: each has its own height, tempo (a multiple of the beat)
    and phase. Like a level meter, the middle of the spectrum is tallest."""
    r = random.Random(17)
    rules, variants = [], 4
    for k in range(12):
        pk = max(0.3, 1 - abs(k - 4.5) * 0.09 + r.uniform(-0.12, 0.08))
        m = r.choice((1, 1, 2, 2, 3))
        v = r.randrange(variants)
        rules.append(
            f".aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child({k + 1}) "
            f"{{ --k: {k}; --pk: {pk:.2f}; animation: aur-vw-eq-{v} calc(var(--aur-beat, 0.6s) * {m}) ease-in-out {-r.uniform(0, 3):.2f}s infinite; }}"
        )
    frames = []
    for v in range(variants):
        body = "\n".join(f"\t{int(i * 100 / 7)}% {{ scale: 1 calc(var(--pk) * {r.uniform(0.2, 1):.2f}); }}" for i in range(8))
        frames.append(f"@keyframes aur-vw-eq-{v} {{\n{body}\n}}")
    return "\n".join(rules), "\n".join(frames)


def vw_sparkles():
    """Eleven stars in the sky (children 14 to 24 of the last layer): where, how big, how fast."""
    r = random.Random(41)
    rules = []
    for k in range(11):
        x, y = r.uniform(4, 96), r.uniform(5, 52)
        s = r.uniform(1.4, 3.4)
        rules.append(
            f".aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child({k + 14}) "
            f"{{ --x: {x:.1f}%; --y: {y:.1f}%; --s: {s:.2f}vmin; --d: {r.uniform(2.2, 5):.1f}s; --dl: {-r.uniform(0, 5):.1f}s; }}"
        )
    return "\n".join(rules)


# =============================================================================== OCEAN
def oc_caustics(seed):
    """The web of light on things just under the surface: noise, pushed to thin bright ridges. It tiles."""
    defs = (
        "<filter id='c' x='0' y='0' width='640' height='640' filterUnits='userSpaceOnUse'>"
        f"<feTurbulence type='fractalNoise' baseFrequency='.011 .016' numOctaves='3' seed='{seed}' stitchTiles='stitch'/>"
        "<feColorMatrix values='0 0 0 0 .78  0 0 0 0 1  0 0 0 0 1  1 0 0 0 0'/>"
        "<feComponentTransfer><feFuncA type='table' tableValues='0 0 0 0 .1 .55 1 .55 .1 0 0 0 0'/></feComponentTransfer></filter>"
    )
    return svg(640, 640, "<rect width='640' height='640' filter='url(#c)'/>", defs, "none")


def oc_surface():
    """The underside of the surface: three wavy bright lines, fading downward. Periodic, so it tiles."""
    W, H = 2400, 240
    defs = f"<linearGradient id='w' x1='0' y1='0' x2='0' y2='1'>{stops([(0, '#f2ffff', 0.9), (0.5, '#9be8ff', 0.28), (1, '#5fd0ff', 0)])}</linearGradient>"
    body = []
    for k, (amp, f1, f2, ph, op, sw) in enumerate(((24, 6, 17, 0.0, 0.9, 5), (16, 8, 21, 1.7, 0.55, 3.5), (12, 5, 13, 3.1, 0.35, 2.5))):
        y0 = 56 + k * 34
        top = [(x, y0 + amp * math.sin(math.tau * f1 * x / W + ph) + amp * 0.36 * math.sin(math.tau * f2 * x / W + ph * 2)) for x in range(0, W + 1, 8)]
        if k == 0:
            body.append(f"<path d='M0 0H{W}V{top[-1][1]:.0f}L{pts(top[::-1])}Z' fill='url(#w)'/>")
        body.append(f"<path d='M{pts(top)}' fill='none' stroke='#f2ffff' stroke-opacity='{op}' stroke-width='{sw}'/>")
    return svg(W, H, "".join(body), defs, "none")


def oc_rays(seed, n, alpha, W=1600, H=1000, blur=13):
    """Soft shafts of sunlight: tapered quads from the surface, blurred once when drawn."""
    r = random.Random(seed)
    quads = []
    for _ in range(n):
        x = r.uniform(-100, W - 100)
        top_w = r.uniform(40, 120)
        lean = r.uniform(-120, 300)
        bot_w = top_w + r.uniform(160, 420)
        quads.append(f"<path d='M{x:.0f} 0L{x + top_w:.0f} 0 {x + top_w + lean + bot_w:.0f} {H} {x + lean:.0f} {H}Z' fill-opacity='{r.uniform(0.35, 1) * alpha:.2f}'/>")
    defs = (
        f"<linearGradient id='b' x1='0' y1='0' x2='0' y2='1'>{stops([(0, '#f2ffff', 1), (0.3, '#a6ecff', 0.6), (0.7, '#56c8ff', 0.2), (1, '#3aa8e0', 0)])}</linearGradient>"
        f"<filter id='f' x='-10%' y='-10%' width='120%' height='120%'><feGaussianBlur stdDeviation='{blur}'/></filter>"
    )
    return svg(W, H, f"<g fill='url(#b)' filter='url(#f)'>{''.join(quads)}</g>", defs, "none")


def oc_snow(seed, n, tile, rmin, rmax, alpha, soft):
    """Marine snow: specks of drifting matter in a seamless tile (soft = out-of-focus discs)."""
    r = random.Random(seed)
    defs = f"<radialGradient id='d'>{stops([(0, '#e8fbff', 1), (1, '#e8fbff', 0)])}</radialGradient>"
    out = []
    for _ in range(n):
        x, y = r.uniform(0, tile), r.uniform(0, tile)
        rad = r.uniform(rmin, rmax)
        op = r.uniform(0.35, 1) * alpha
        for dx in (0, -tile, tile):
            for dy in (0, -tile, tile):
                if -rad < x + dx < tile + rad and -rad < y + dy < tile + rad:
                    out.append(f"<circle cx='{x + dx:.1f}' cy='{y + dy:.1f}' r='{rad:.1f}' " + (f"fill='url(#d)' fill-opacity='{op:.2f}'/>" if soft else f"fill='#e8fbff' fill-opacity='{op:.2f}'/>"))
    return svg(tile, tile, "".join(out), defs, "none")


def oc_bubbles(seed, n, tile, rmin, rmax):
    """Bubbles in a seamless tile: a clear body, a bright rim and a glint."""
    r = random.Random(seed)
    defs = (
        f"<radialGradient id='q'>{stops([(0.55, '#bfeeff', 0.02), (0.88, '#d8f6ff', 0.4), (1, '#fff', 0.75)])}</radialGradient>"
        f"<radialGradient id='g'>{stops([(0, '#fff', 0.95), (1, '#fff', 0)])}</radialGradient>"
    )
    out = []
    for _ in range(n):
        x, y = r.uniform(0, tile), r.uniform(0, tile)
        rad = r.uniform(rmin, rmax)
        for dx in (0, -tile, tile):
            for dy in (0, -tile, tile):
                if -rad < x + dx < tile + rad and -rad < y + dy < tile + rad:
                    cx, cy = x + dx, y + dy
                    out.append(f"<circle cx='{cx:.1f}' cy='{cy:.1f}' r='{rad:.1f}' fill='url(#q)'/>")
                    out.append(f"<ellipse cx='{cx - rad * 0.32:.1f}' cy='{cy - rad * 0.36:.1f}' rx='{rad * 0.22:.1f}' ry='{rad * 0.14:.1f}' fill='url(#g)' transform='rotate(-35 {cx - rad * 0.32:.1f} {cy - rad * 0.36:.1f})'/>")
    return svg(tile, tile, "".join(out), defs, "none")


def oc_manta():
    """A manta ray seen from below, silhouetted against the light, swimming right: a swept diamond of
    wings, two cephalic lobes and a long thin tail."""
    W, H = 720, 300
    # the body runs along the x axis with the nose at the right; the wings sweep back to points
    outline = (
        "M600 150C570 120 470 74 350 40C320 32 290 20 262 8C268 50 244 96 206 122C196 130 190 140 186 150"
        "C190 160 196 170 206 178C244 204 268 250 262 292C290 280 320 268 350 260C470 226 570 180 600 150Z"
    )
    defs = (
        f"<linearGradient id='b' x1='0' y1='0' x2='1' y2='0'>{stops([(0, '#051f38', 1), (0.55, '#0a3a62', 1), (1, '#0b4573', 1)])}</linearGradient>"
        f"<radialGradient id='v' cx='.6' cy='.5' r='.5'>{stops([(0, '#6fb4de', 0.45), (1, '#6fb4de', 0)])}</radialGradient>"
    )
    body = (
        "<path d='M186 150C120 150 70 146 14 136' fill='none' stroke='#051f38' stroke-width='6' stroke-linecap='round'/>"
        f"<path d='{outline}' fill='url(#b)'/>"
        # the two cephalic lobes that funnel plankton into the mouth
        "<path d='M600 148C620 142 640 140 656 146C640 146 620 152 604 154Z' fill='#051f38'/>"
        "<path d='M600 152C620 158 640 160 656 154C640 154 620 148 604 146Z' fill='#051f38'/>"
        # a paler patch on the belly, and the gill slits
        "<ellipse cx='400' cy='150' rx='150' ry='50' fill='url(#v)'/>"
        "<g fill='none' stroke='#8fd0f2' stroke-opacity='.25' stroke-width='2.5' stroke-linecap='round'><path d='M330 132q10 8 0 16M352 130q10 10 0 20M374 130q10 10 0 20'/><path d='M330 168q10 -8 0 -16M352 170q10 -10 0 -20M374 170q10 -10 0 -20'/></g>"
    )
    return svg(W, H, body, defs, "xMidYMid meet")


def oc_school():
    """A school of small fish, packed loosely into a swirl, swimming right."""
    r = random.Random(17)
    W, H = 900, 300
    out = []
    for _ in range(20):
        t = r.uniform(0, math.tau)
        rad = r.uniform(0, 1) ** 0.6
        x, y = W / 2 + math.cos(t) * rad * 360, H / 2 + math.sin(t) * rad * 100
        L = r.uniform(40, 66)
        out.append(
            f"<path d='M{x:.0f} {y:.0f}Q{x + L * 0.45:.0f} {y - L * 0.3:.0f} {x + L:.0f} {y:.0f}Q{x + L * 0.45:.0f} {y + L * 0.3:.0f} {x:.0f} {y:.0f}Z"
            f"M{x:.0f} {y:.0f}L{x - L * 0.36:.0f} {y - L * 0.25:.0f} {x - L * 0.36:.0f} {y + L * 0.25:.0f}Z'/>"
        )
    return svg(W, H, f"<g fill='#03294a' fill-opacity='.7'>{''.join(out)}</g>", "", "xMidYMid meet")


JELLY_COLOURS = {
    "a": ("#5ff4ff", "#2c9dff", "#b6fbff"),  # cyan
    "b": ("#ff7ad9", "#a05bff", "#ffc9f0"),  # magenta
    "c": ("#9d8bff", "#4a5bff", "#d5ceff"),  # violet
}


def oc_jelly_bell(key):
    """The bell of a jellyfish (200x130): a glowing dome with a scalloped rim, and a halo."""
    c1, c2, c3 = JELLY_COLOURS[key]
    defs = (
        f"<radialGradient id='h' cx='.5' cy='.5' r='.5'>{stops([(0, c1, 0.42), (0.55, c2, 0.16), (1, c2, 0)])}</radialGradient>"
        f"<radialGradient id='b' cx='.5' cy='.85' r='.95'>{stops([(0, c3, 0.5), (0.55, c1, 0.34), (1, c2, 0.55)])}</radialGradient>"
    )
    bell = "M22 108C22 44 58 12 100 12C142 12 178 44 178 108C164 102 152 114 138 106C128 120 112 118 100 108C88 118 72 120 62 106C48 114 36 102 22 108Z"
    body = (
        "<ellipse cx='100' cy='70' rx='100' ry='66' fill='url(#h)'/>"
        f"<path d='{bell}' fill='url(#b)' stroke='{c3}' stroke-opacity='.75' stroke-width='2.5'/>"
        f"<path d='M46 96C48 58 70 32 100 30C130 32 152 58 154 96' fill='none' stroke='{c3}' stroke-opacity='.4' stroke-width='2'/>"
        f"<path d='M74 92C76 66 88 52 100 52C112 52 124 66 126 92' fill='none' stroke='{c3}' stroke-opacity='.5' stroke-width='3'/>"
        f"<ellipse cx='100' cy='88' rx='16' ry='10' fill='{c3}' fill-opacity='.55'/>"
        f"<ellipse cx='72' cy='40' rx='16' ry='6' fill='#fff' fill-opacity='.4' transform='rotate(-28 72 40)'/>"
    )
    return svg(200, 130, body, defs, "xMidYMin meet")


def oc_jelly_tentacles(key, seed):
    """The tentacles and oral arms (200x240): fine wavy threads and two ribbons."""
    c1, c2, c3 = JELLY_COLOURS[key]
    r = random.Random(seed)
    out = []
    for i in range(8):
        x0 = 36 + i * 18
        ln = r.uniform(140, 230)
        a = r.uniform(6, 14)
        ph = r.uniform(0, 6)
        pts_ = []
        for k in range(10):
            t = k / 9
            pts_.append((x0 + a * math.sin(t * 5 + ph) * (0.4 + t), t * ln))
        out.append(f"<path d='M{pts(pts_)}' fill='none' stroke='{c1}' stroke-opacity='{r.uniform(0.35, 0.65):.2f}' stroke-width='{r.uniform(1.6, 2.6):.1f}' stroke-linecap='round'/>")
    for x0, ph in ((82, 0.6), (118, 2.4)):
        left, right = [], []
        for k in range(16):
            t = k / 15
            x = x0 + 10 * math.sin(t * 4.2 + ph)
            w = 7 * (1 - t) + 1
            left.append((x - w, t * 170))
            right.append((x + w, t * 170))
        out.append(f"<path d='M{pts(left + right[::-1])}Z' fill='{c3}' fill-opacity='.4'/>")
    return svg(200, 240, "".join(out), "", "xMidYMin meet")


def oc_jellies():
    """The jellyfish images (defined once, as custom properties) and eight jellyfish (the first eight
    children of the last layer): where, how big, how fast they drift up, how quickly they pulse (a
    multiple of the beat), their sway and their colour."""
    r = random.Random(9)
    defs = []
    for key in "abc":
        defs.append(f"--bell-{key}: {oc_jelly_bell(key)};")
        for v in range(2):
            defs.append(f"--tent-{key}{v}: {oc_jelly_tentacles(key, ord(key) * 3 + v)};")
    nl = chr(10)
    rules = [".aur-root[data-fx=\"ocean\"] {" + nl + chr(9) + (nl + chr(9)).join(defs) + nl + "}"]
    keys = "abcabcab"
    for k in range(8):
        key = keys[k]
        x = 5 + k * 11.5 + r.uniform(-3, 3)
        w = r.uniform(9, 16)
        dur = r.uniform(70, 120)
        rules.append(
            f".aur-root[data-fx=\"ocean\"] .aur-fx-e > i:nth-child({k + 1}) "
            f"{{ --x: {x:.1f}%; --w: {w:.1f}vmin; --dur: {dur:.0f}s; --dl: {-r.uniform(0, dur):.0f}s; --m: {r.choice((4, 5, 6))}; --sway: {r.uniform(3, 7):.1f}s; "
            f"--bell: var(--bell-{key}); --tent: var(--tent-{key}{k % 2}); }}"
        )
    return nl.join(rules)


VALUES = {
    "VW_CLOUDS_FAR": vw_clouds(6, 9, "#cdbbff", "#ffb6e8", 0.8, 200, 380, 50, 90, 250, 380),
    "VW_CLOUDS_NEAR": vw_clouds(12, 6, "#ffe4f6", "#ff9fd0", 0.93, 320, 560, 80, 140, 300, 390),
    "VW_PLANET": vw_planet(),
    "VW_PALMS": vw_palms(),
    "VW_NOISE": vw_noise(),
    "OC_CAUSTICS": oc_caustics(8),
    "OC_SURFACE": oc_surface(),
    "OC_RAYS_A": oc_rays(6, 7, 1.0, blur=10),
    "OC_RAYS_B": oc_rays(12, 5, 0.75, blur=16),
    "OC_SNOW_FAR": oc_snow(3, 90, 700, 0.6, 1.5, 0.7, False),
    "OC_SNOW_NEAR": oc_snow(5, 22, 800, 3, 7, 0.4, True),
    "OC_MANTA": oc_manta(),
    "OC_SCHOOL": oc_school(),
    "OC_BUBBLES": oc_bubbles(2, 18, 700, 6, 22),
    "OC_BUBBLES_S": oc_bubbles(5, 28, 500, 2.5, 7),
}
VW_BARS, VW_BAR_FRAMES = vw_bars()
VALUES["VW_BARS"], VALUES["VW_BAR_FRAMES"], VALUES["VW_SPARKLES"] = VW_BARS, VW_BAR_FRAMES, vw_sparkles()
VALUES["OC_JELLIES"] = oc_jellies()

STYLES = os.path.join(D, "..", "..", "src", "styles.css")
css = open(STYLES, encoding="utf-8").read()


def splice(css, name, starts, end):
    """Replace a theme's block (from its opening comment, old or new, to the next theme's)."""
    tpl = open(os.path.join(D, name + ".tpl.css"), encoding="utf-8").read()
    for k, v in VALUES.items():
        tpl = tpl.replace("{{" + k + "}}", v)
    assert "{{" not in tpl, name
    i = min(css.index(s) for s in starts if s in css)
    j = css.index(end, i)
    print(name, len(tpl))
    return css[:i] + tpl.rstrip() + "\n\n" + css[j:]


# The old beat-sync rules for these two themes (they target layers that no longer exist); the new
# ones live in the templates.
a, b = css.find("/* Vaporwave: the sun swells on the bar"), css.find("/* Rain: the city lights flash on the bar")
if a != -1 and b != -1 and a < b:
    css = css[:a] + css[b:]

css = splice(css, "vaporwave", ["/* Vaporwave: a pastel dusk", "/* Vaporwave: a pastel dream"], "/* Ocean: a dive that lasts one song")
css = splice(css, "ocean", ["/* Ocean: a dive that lasts one song"], "/* Rain: a night window")
open(STYLES, "w", encoding="utf-8", newline=chr(10)).write(css)
print("updated src/styles.css")
