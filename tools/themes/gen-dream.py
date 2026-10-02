"""Vaporwave theme ambience: artwork and generated rules (seeded, so every build is identical)
written into the Vaporwave block of src/styles.css.

Usage: python tools/themes/gen-dream.py  (then node build.mjs)

Vaporwave is a pastel dream: a gradient sky with drifting clouds and a ringed planet, a checkerboard
floor that rolls toward you in tempo, palms on the horizon, a spectrum window and glinting stars,
all under a VHS overlay; the cover becomes an old OS window.

The theme has a template (*.tpl.css) with {{PLACEHOLDER}} values."""
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


VALUES = {
    "VW_CLOUDS_FAR": vw_clouds(6, 9, "#cdbbff", "#ffb6e8", 0.8, 200, 380, 50, 90, 250, 380),
    "VW_CLOUDS_NEAR": vw_clouds(12, 6, "#ffe4f6", "#ff9fd0", 0.93, 320, 560, 80, 140, 300, 390),
    "VW_PLANET": vw_planet(),
    "VW_PALMS": vw_palms(),
    "VW_NOISE": vw_noise(),
}
VW_BARS, VW_BAR_FRAMES = vw_bars()
VALUES["VW_BARS"], VALUES["VW_BAR_FRAMES"], VALUES["VW_SPARKLES"] = VW_BARS, VW_BAR_FRAMES, vw_sparkles()

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

css = splice(css, "vaporwave", ["/* Vaporwave: a pastel dusk", "/* Vaporwave: a pastel dream"], "/* Rain: a night window")
open(STYLES, "w", encoding="utf-8", newline=chr(10)).write(css)
print("updated src/styles.css")
