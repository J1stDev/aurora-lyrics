"""Rain theme ambience: vector artwork (seeded, so every build is identical) written into the
theme block of src/styles.css. (Vaporwave and Ocean are in gen-dream.py.)

Usage: python tools/themes/gen-scenes.py  (then node build.mjs)

Each theme has a template (*.tpl.css) with {{PLACEHOLDER}} values; the images are SVG data URIs,
drawn once. CSS only moves and fades them (stepped transforms and opacity)."""
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


# =============================================================================== RAIN
def rain_skyline():
    """An out-of-focus city at night: towers with lit windows, blurred once when drawn."""
    r = random.Random(52)
    W, H = 1600, 900
    out = []
    wins = {c: [] for c in ("255,205,130", "255,190,110", "255,230,170", "170,210,255")}
    x = -20.0
    while x < W + 20:
        bw = r.uniform(50, 130)
        bh = r.uniform(120, 420) * (0.6 + 0.4 * math.sin(x / 300 + 1) ** 2)
        shade = r.choice(("#0c1424", "#101a2e", "#0a101d", "#131d33"))
        out.append(f"<rect x='{x:.0f}' y='{H - bh:.0f}' width='{bw:.0f}' height='{bh:.0f}' fill='{shade}'/>")
        cols, rows = int(bw // 14), int(bh // 20)
        for i in range(cols):
            for j in range(rows):
                if r.random() < 0.16:
                    wins[r.choice(list(wins))].append(f"M{x + 6 + i * 14:.0f} {H - bh + 8 + j * 20:.0f}h7v9h-7z")
        x += bw + r.uniform(-6, 10)
    for c, d in wins.items():
        out.append(f"<path d='{''.join(d)}' fill='rgb({c})' fill-opacity='.7'/>")
    # a few red aircraft lights on the tallest towers
    for _ in range(4):
        out.append(f"<circle cx='{r.uniform(80, W - 80):.0f}' cy='{r.uniform(440, 560):.0f}' r='5' fill='#ff4a3d'/>")
    defs = "<filter id='b' x='-5%' y='-5%' width='110%' height='110%'><feGaussianBlur stdDeviation='6'/></filter>"
    return svg(W, H, f"<g filter='url(#b)'>{''.join(out)}</g>", defs, "xMidYMax slice")


def rain_bokeh():
    """Big soft discs of city light: the glass is focused on the rain, not the street."""
    r = random.Random(23)
    W, H = 1600, 900
    cols = ["255,190,110", "255,160,90", "255,210,150", "120,190,240", "255,120,120", "190,240,230", "255,235,190"]
    out = []
    for _ in range(34):
        x, y = r.uniform(20, W - 20), r.uniform(400, H - 40)
        rad = r.uniform(12, 44)
        out.append(f"<circle cx='{x:.0f}' cy='{y:.0f}' r='{rad:.0f}' fill='rgb({r.choice(cols)})' fill-opacity='{r.uniform(0.12, 0.36):.2f}' filter='url(#b)'/>")
    defs = "<filter id='b' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='8'/></filter>"
    return svg(W, H, "".join(out), defs, "xMidYMid slice")


def rain_cars(seed, colour, pairs):
    """Pairs of lights (headlights or tail lights) as a strip; CSS drives it across the street."""
    r = random.Random(seed)
    W, H = 1600, 300
    out = []
    for _ in range(pairs):
        x, y = r.uniform(60, W - 60), r.uniform(70, 230)
        gap = r.uniform(34, 60)
        rad = r.uniform(9, 17)
        for dx in (0, gap):
            out.append(f"<circle cx='{x + dx:.0f}' cy='{y:.0f}' r='{rad:.0f}' fill='rgb({colour})' fill-opacity='.55' filter='url(#b)'/>")
            out.append(f"<circle cx='{x + dx:.0f}' cy='{y:.0f}' r='{rad * 0.35:.0f}' fill='#fff' fill-opacity='.5' filter='url(#c)'/>")
    defs = (
        "<filter id='b' x='-100%' y='-100%' width='300%' height='300%'><feGaussianBlur stdDeviation='6'/></filter>"
        "<filter id='c' x='-100%' y='-100%' width='300%' height='300%'><feGaussianBlur stdDeviation='2'/></filter>"
    )
    return svg(W, H, "".join(out), defs, "none")


def rain_drops(seed, count):
    """Beads of water on the glass: a dark lower rim, a bright upper edge, a sharp highlight and
    the warm or cool city light refracted upside down inside."""
    r = random.Random(seed)
    W, H = 1600, 900
    defs = (
        "<radialGradient id='d' cx='.5' cy='.6' r='.55'><stop offset='0' stop-color='#a9c8e8' stop-opacity='.16'/><stop offset='.7' stop-color='#070c16' stop-opacity='.34'/><stop offset='.92' stop-color='#dbeaff' stop-opacity='.32'/><stop offset='1' stop-color='#eef5ff' stop-opacity='.7'/></radialGradient>"
        "<radialGradient id='s' cx='.5' cy='.5' r='.5'><stop offset='0' stop-color='#fff' stop-opacity='.95'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></radialGradient>"
        "<radialGradient id='w' cx='.5' cy='.5' r='.5'><stop offset='0' stop-color='#ffc46e' stop-opacity='.5'/><stop offset='1' stop-color='#ffc46e' stop-opacity='0'/></radialGradient>"
        "<radialGradient id='k' cx='.5' cy='.5' r='.5'><stop offset='0' stop-color='#78b6ff' stop-opacity='.42'/><stop offset='1' stop-color='#78b6ff' stop-opacity='0'/></radialGradient>"
    )
    body, warm, cool, spec = [], [], [], []
    for _ in range(count):
        x, y = r.uniform(0, W), r.uniform(0, H)
        rx = r.choice((r.uniform(1.6, 3.4), r.uniform(2.6, 6), r.uniform(4, 9), r.uniform(7, 13)))
        ry = rx * r.uniform(1.02, 1.32)
        body.append(f"<ellipse cx='{x:.0f}' cy='{y:.0f}' rx='{rx:.1f}' ry='{ry:.1f}'/>")
        if rx > 3.2:
            (warm if r.random() < 0.55 else cool).append(f"<ellipse cx='{x:.0f}' cy='{y + ry * 0.3:.0f}' rx='{rx * 0.55:.1f}' ry='{ry * 0.5:.1f}'/>")
        spec.append(f"<ellipse cx='{x - rx * 0.3:.1f}' cy='{y - ry * 0.44:.1f}' rx='{rx * 0.3:.1f}' ry='{ry * 0.18:.1f}'/>")
    out = [f"<g fill='url(#d)'>{''.join(body)}</g><g fill='url(#w)'>{''.join(warm)}</g><g fill='url(#k)'>{''.join(cool)}</g><g fill='url(#s)'>{''.join(spec)}</g>"]
    return svg(W, H, "".join(out), defs, "xMidYMid slice")


def rain_head():
    """A running drop: rounder below, drawn out to a point above."""
    defs = (
        "<radialGradient id='d' cx='.5' cy='.62' r='.55'><stop offset='0' stop-color='#b6d2f0' stop-opacity='.22'/><stop offset='.68' stop-color='#070c16' stop-opacity='.4'/><stop offset='.92' stop-color='#dbeaff' stop-opacity='.4'/><stop offset='1' stop-color='#f2f8ff' stop-opacity='.85'/></radialGradient>"
        "<radialGradient id='s' cx='.5' cy='.5' r='.5'><stop offset='0' stop-color='#fff'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></radialGradient>"
        "<radialGradient id='w' cx='.5' cy='.5' r='.5'><stop offset='0' stop-color='#ffc46e' stop-opacity='.55'/><stop offset='1' stop-color='#ffc46e' stop-opacity='0'/></radialGradient>"
    )
    body = (
        "<path d='M20 1C25 15 38 25 38 37C38 47 30 53 20 53C10 53 2 47 2 37C2 25 15 15 20 1Z' fill='url(#d)'/>"
        "<ellipse cx='20' cy='42' rx='9' ry='8' fill='url(#w)'/>"
        "<ellipse cx='13' cy='30' rx='4' ry='7' fill='url(#s)' transform='rotate(14 13 30)' fill-opacity='.9'/>"
        "<ellipse cx='27' cy='46' rx='3' ry='1.6' fill='url(#s)' fill-opacity='.55'/>"
    )
    return svg(40, 54, body, defs, "xMidYMid meet")


def rain_streaks(seed, n, alpha, lmin, lmax, wmax, tile=1000):
    r = random.Random(seed)
    W = H = tile
    out = []
    for _ in range(n):
        x, y = r.uniform(-20, W + 20), r.uniform(0, H)
        ln = r.uniform(lmin, lmax)
        w = r.uniform(1, wmax)
        o = r.uniform(0.4, 1) * alpha
        for oy in (0, -H, H):  # wrapped copies so the tile joins up at the top and bottom
            out.append(f"<path d='M{x:.0f} {y + oy:.0f}l{-ln * 0.14:.1f} {ln:.0f}' stroke-width='{w:.1f}' stroke-opacity='{o:.2f}'/>")
    return svg(W, H, f"<g stroke='#bcd4f2' stroke-linecap='round' fill='none'>{''.join(out)}</g>", "", "xMinYMin slice")


def rain_mist():
    """Fine mist on the glass: tiny beads in three prime-sized tiles, so it never visibly repeats."""
    r = random.Random(61)
    layers, sizes = [], []
    for tile, count, rad, a in ((173, 9, 0.8, 0.5), (211, 8, 1.1, 0.42), (137, 6, 1.5, 0.36)):
        for _ in range(count):
            layers.append(f"radial-gradient({rad}px {rad}px at {r.randint(4, tile - 4)}px {r.randint(4, tile - 4)}px, rgba(214, 230, 255, {a}), transparent)")
            sizes.append(f"{tile}px {tile}px")
    return ",\n\t\t".join(layers), ", ".join(sizes)


def rain_runners():
    """Per-runner rules: where each running drop starts, how far it goes, how big, how fast."""
    r = random.Random(77)
    rules = []
    variant_of = (1, 2, 3, 2, 1, 3, 2, 1, 3, 1, 2, 3)
    for i in range(12):
        x = 5 + (i + r.uniform(0.1, 0.9)) * 90 / 12
        y = r.uniform(2, 62)
        dy = (100 - y) + r.uniform(4, 12)
        s = r.uniform(2.2, 3.8)
        dur = r.uniform(24, 48)
        delay = -r.uniform(0, dur)
        v = variant_of[i]
        rules.append(
            f".aur-root[data-fx=\"rain\"] .aur-fx-e > i:nth-child({i + 1}) {{ --x: {x:.1f}%; --y: {y:.1f}vh; --dy: {dy:.1f}vh; --s: {s:.2f}vmin; "
            f"--dur: {dur:.1f}s; --delay: {delay:.1f}s; --hv: aur-rn-head-{v}; --tv: aur-rn-trail-{v}; }}"
        )
    return "\n".join(rules)


def rain_keyframes():
    """Stop-and-go slides: a drop crawls, stalls where the glass is dry, then breaks free."""
    shapes = {
        1: [(0, 0), (5, 0.05), (13, 0.08), (24, 0.3), (35, 0.33), (50, 0.62), (58, 0.63), (74, 0.9), (84, 1.0)],
        2: [(0, 0), (8, 0.02), (20, 0.16), (27, 0.17), (33, 0.45), (48, 0.5), (55, 0.82), (62, 0.83), (80, 1.0)],
        3: [(0, 0), (4, 0.04), (9, 0.24), (17, 0.26), (30, 0.4), (40, 0.42), (46, 0.66), (66, 0.72), (72, 0.95), (82, 1.0)],
    }
    wob = [0, 0.1, -0.08, 0.14, -0.05, 0.12, -0.1, 0.06, 0, 0.08]
    out = []
    for v, steps in shapes.items():
        head, trail = [], []
        for k, (t, f) in enumerate(steps):
            w = wob[k % len(wob)] * (1 if v != 2 else -1)
            extra = " scale: 0.3;" if t == 0 else (" scale: 1;" if k == 1 else "")
            op = " opacity: 0;" if t == 0 else (" opacity: 1;" if k == 1 else "")
            head.append(f"\t{t}% {{ translate: {w}vmin calc(var(--dy) * {f});{extra}{op} }}")
            trail.append(f"\t{t}% {{ scale: 1 {f};{op} }}")
        last_t, last_f = steps[-1]
        head.append(f"\t{last_t + 6}% {{ translate: 0 var(--dy); opacity: 1; }}\n\t{last_t + 12}%, 100% {{ translate: 0 var(--dy); opacity: 0; }}")
        trail.append(f"\t{last_t + 6}% {{ scale: 1 1; opacity: 1; }}\n\t{last_t + 12}%, 100% {{ scale: 1 1; opacity: 0; }}")
        out.append(f"@keyframes aur-rn-head-{v} {{\n" + "\n".join(head) + "\n}")
        out.append(f"@keyframes aur-rn-trail-{v} {{\n" + "\n".join(trail) + "\n}")
    return "\n".join(out)


MIST, MIST_SIZES = rain_mist()


VALUES = {
    "RAIN_SKYLINE": rain_skyline(), "RAIN_BOKEH": rain_bokeh(), "RAIN_CARS_W": rain_cars(5, "255,236,190", 4), "RAIN_CARS_R": rain_cars(8, "255,70,60", 4),
    "RAIN_STREAKS": rain_streaks(19, 40, 0.2, 40, 90, 1.2, 730), "RAIN_STREAKS_B": rain_streaks(7, 22, 0.32, 70, 150, 1.9, 1000),
    "RAIN_DROPS_A": rain_drops(31, 140), "RAIN_DROPS_B": rain_drops(37, 140), "RAIN_HEAD": rain_head(),
    "RAIN_RUNNERS": rain_runners(), "RAIN_KEYFRAMES": rain_keyframes(), "RAIN_MIST": MIST, "RAIN_MIST_SIZES": MIST_SIZES,
}

STYLES = os.path.join(D, "..", "..", "src", "styles.css")
css = open(STYLES, encoding="utf-8").read()
# the block sits right before the beat-sync section
BEAT = css.index("/* ============================================================== beat sync")
first = css.find("/* Rain: a night window")
if first != -1:
    css = css[:first] + css[BEAT:]
    BEAT = first
blocks = []
for name in ("rain",):
    tpl = open(os.path.join(D, name + ".tpl.css"), encoding="utf-8").read()
    for k, v in VALUES.items():
        tpl = tpl.replace("{{" + k + "}}", v)
    assert "{{" not in tpl, name
    blocks.append(tpl.rstrip() + "\n\n")
    print(name, len(tpl))
css = css[:BEAT] + "".join(blocks) + css[BEAT:]
open(STYLES, "w", encoding="utf-8", newline=chr(10)).write(css)
print("updated src/styles.css")
