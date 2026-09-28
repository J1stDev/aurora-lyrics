"""Aurora theme ambience: northern-light curtains, a starfield and a low horizon, generated as
vector art (seeded, so every build is identical) and written into the Aurora block of
src/styles.css.

Usage: python tools/themes/gen-aurora.py  (then node build.mjs)

A curtain is ~100 slanted slices laid side by side along a wavy lower edge. Each slice is filled
with a pattern of vertical rays (coloured by one gradient over the whole sky: green low, teal,
then violet and magenta high) and faded by its own mask, so every slice is brightest just above
its lower edge and dissolves upwards, the way real aurora rays do. A soft, unrayed body sits
behind the rays. Colours are baked in: CSS only moves and fades the images."""
import math, os, random
from urllib.parse import quote

D = os.path.dirname(os.path.abspath(__file__))
W, H = 2400, 1000


def uri(svg):
    svg = " ".join(svg.split())
    return 'url("data:image/svg+xml,' + quote(svg, safe=" =:/,.-;'()!*") + '")'


def smooth_noise(seed, n, knots=9):
    """n values in 0..1, smooth (cosine-interpolated random knots)."""
    r = random.Random(seed)
    ks = [r.random() for _ in range(knots + 1)]
    out = []
    for i in range(n):
        t = i / (n - 1) * knots
        k = int(t)
        f = t - k
        f = (1 - math.cos(f * math.pi)) / 2
        a, b = ks[k], ks[min(k + 1, knots)]
        out.append(a + (b - a) * f)
    return out


def curtain(seed, base, amp, height, slices=100, ray_seed=None, body=True, colors=None):
    r = random.Random(seed)
    ph = [r.uniform(0, 6.3) for _ in range(3)]
    lam = [r.uniform(900, 1500), r.uniform(420, 700), r.uniform(200, 320)]
    edge = lambda x: base + amp * (0.62 * math.sin(2 * math.pi * x / lam[0] + ph[0]) + 0.28 * math.sin(2 * math.pi * x / lam[1] + ph[1]) + 0.1 * math.sin(2 * math.pi * x / lam[2] + ph[2]))
    hs = smooth_noise(seed + 1, slices + 1, 7)
    br = smooth_noise(seed + 2, slices + 1, 11)
    w = W / slices
    parts, top_pts, bot_pts = [], [], []
    for i in range(slices + 1):
        x = i * w
        y = edge(x)
        h = height * (0.55 + 0.45 * hs[i])
        bot_pts.append((x, y))
        top_pts.append((x, y - h))
    for i in range(slices):
        (x0, y0), (x1, y1) = bot_pts[i], bot_pts[i + 1]
        t0, t1 = top_pts[i][1], top_pts[i + 1][1]
        b = 0.22 + 0.78 * br[i] ** 1.6
        parts.append(f"<path d='M{round(x0)} {round(y0)}L{round(x1 + 1)} {round(y1)} {round(x1 + 1)} {round(t1)} {round(x0)} {round(t0)}Z' opacity='{b:.2f}' mask='url(#f)'/>")
    # soft rays: each one bright in the middle and transparent at its edges, used as a mask
    rr = random.Random(ray_seed if ray_seed is not None else seed + 7)
    rays = []
    x = 0.0
    while x < 1200:
        rw = rr.choice((rr.uniform(4, 10), rr.uniform(8, 22), rr.uniform(16, 40)))
        rays.append(f"<rect x='{round(x)}' width='{round(rw)}' height='{H}' opacity='{rr.uniform(0.55, 1):.2f}'/>")
        x += rw * rr.uniform(0.9, 2.1)
    c = colors or ["#e4fff4", "#57ffbd", "#26e6b4", "#7f70ff", "#c455ff"]
    lo = max(y for _, y in bot_pts)
    hi = min(y for _, y in top_pts)
    stops = [(lo, c[0]), (lo - (lo - hi) * 0.1, c[1]), (lo - (lo - hi) * 0.36, c[2]), (lo - (lo - hi) * 0.7, c[3]), (hi, c[4])]
    grad = "".join(f"<stop offset='{(y / H):.3f}' stop-color='{col}'/>" for y, col in sorted(stops))
    glow = "<use href='#sl' opacity='.17'/>" if body else ""
    # the hem: the lower edge of a curtain is its brightest part, a continuous line of light
    hem = ""
    if body:
        segs = []
        for k in range(0, len(bot_pts) - 1):
            (x0, y0), (x1, y1) = bot_pts[k], bot_pts[k + 1]
            b = 0.22 + 0.78 * br[k] ** 1.6
            segs.append(f"<path d='M{round(x0)} {round(y0 - 8)}L{round(x1 + 1)} {round(y1 - 8)}' opacity='{b:.2f}'/>")
        hem = (
            f"<defs><g id='hm'>{''.join(segs)}</g></defs>"
            f"<g fill='none' stroke='{c[1]}' stroke-linecap='round'>"
            "<use href='#hm' stroke-width='40' opacity='.06'/><use href='#hm' stroke-width='14' opacity='.12'/></g>"
        )
    return uri(
        f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {W} {H}' preserveAspectRatio='none'><defs>"
        f"<linearGradient id='c' gradientUnits='userSpaceOnUse' x1='0' y1='0' x2='0' y2='{H}'>{grad}</linearGradient>"
        "<linearGradient id='g' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#000'/><stop offset='.4' stop-color='#fff' stop-opacity='.14'/><stop offset='.7' stop-color='#fff' stop-opacity='.55'/><stop offset='.86' stop-color='#fff'/><stop offset='.93' stop-color='#fff' stop-opacity='.85'/><stop offset='1' stop-color='#000'/></linearGradient>"
        "<mask id='f' maskContentUnits='objectBoundingBox'><rect width='1' height='1' fill='url(#g)'/></mask>"
        "<linearGradient id='s'><stop offset='0' stop-color='#000'/><stop offset='.5' stop-color='#fff'/><stop offset='1' stop-color='#000'/></linearGradient>"
        f"<pattern id='r' width='1200' height='{H}' patternUnits='userSpaceOnUse'><g fill='url(#s)'>{''.join(rays)}</g></pattern>"
        f"<mask id='rm' maskUnits='userSpaceOnUse' x='0' y='0' width='{W}' height='{H}'><rect width='{W}' height='{H}' fill='url(#r)'/></mask>"
        f"<g id='sl' fill='url(#c)'>{''.join(parts)}</g>"
        "</defs>"
        + glow
        + f"<g mask='url(#rm)'><use href='#sl'/></g>"
        + hem
        + "</svg>"
    )


A = curtain(4, base=770, amp=110, height=520)
A_SHIMMER = curtain(4, base=770, amp=110, height=520, ray_seed=99, body=False)
B = curtain(19, base=520, amp=90, height=360, slices=80, colors=["#b8fff0", "#3fe6c8", "#2aa6d8", "#8467ff", "#d05cff"])

# ---------------------------------------------------------------- horizon: distant hills with spruce tips
r = random.Random(3)
HW, HH = 2400, 200
pts = [(0, HH)]
x = 0.0
y = 120.0
while x < HW:
    x += r.uniform(10, 24)
    y = min(170, max(80, y + r.uniform(-9, 9)))
    if r.random() < 0.55:
        h = r.uniform(18, 62)
        wv = h * r.uniform(0.22, 0.3)
        pts += [(x - wv, y), (x, y - h), (x + wv, y)]
    else:
        pts.append((x, y))
pts.append((HW, HH))
horizon = uri(
    f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {HW} {HH}' preserveAspectRatio='none'>"
    "<linearGradient id='h' x1='0' y1='0' x2='0' y2='1'><stop offset='.35' stop-color='#0a1418'/><stop offset='1' stop-color='#040709'/></linearGradient>"
    f"<path d='M{' '.join(f'{round(px)} {round(py)}' for px, py in pts)}Z' fill='url(#h)'/></svg>"
)

# ---------------------------------------------------------------- stars
r = random.Random(11)
stars = ",\n\t\t".join(
    f"radial-gradient({s}px {s}px at {r.uniform(1, 99):.1f}% {r.uniform(1, 70):.1f}%, rgba({t}, {r.uniform(0.45, 0.95):.2f}), transparent)"
    for s, t in ((r.choice([0.8, 1, 1, 1.2, 1.5]), r.choice(["255, 255, 255", "220, 235, 255", "235, 255, 245"])) for _ in range(40))
)

VALUES = {"CURTAIN_A": A, "CURTAIN_A2": A_SHIMMER, "CURTAIN_B": B, "HORIZON": horizon, "STARS": stars}
tpl = open(os.path.join(D, "aurora.tpl.css"), encoding="utf-8").read()
for k, v in VALUES.items():
    tpl = tpl.replace("{{" + k + "}}", v)
assert "{{" not in tpl
print("ok", len(tpl), {k: len(v) for k, v in VALUES.items()})

# Write the finished block straight into src/styles.css, replacing the theme's current block.
START, END = "/* Aurora: ", "/* Neon: a neon"
STYLES = os.path.join(D, "..", "..", "src", "styles.css")
css = open(STYLES, encoding="utf-8").read()
i = css.index(START)
j = css.index(END, i)
open(STYLES, "w", encoding="utf-8", newline=chr(10)).write(css[:i] + tpl + css[j:])
print("updated src/styles.css")
