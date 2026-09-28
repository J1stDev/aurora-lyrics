"""
Usage: python tools/themes/gen-blackmetal.py  (then node build.mjs)
Black Metal theme generator: procedural SVG artwork (moon, clouds, mountains, spruce forests,
thorn ornament) and CSS layers (fog, snow), written into blackmetal.tpl.css → fx-blackmetal.css.
Everything is seeded, so the artwork is identical on every build."""
import math, os, random
from urllib.parse import quote

D = os.path.dirname(os.path.abspath(__file__))
f = lambda v: f"{v:.1f}".rstrip("0").rstrip(".")


def uri(svg):
    svg = " ".join(svg.split())
    return 'url("data:image/svg+xml,' + quote(svg, safe=" =:/,.-;'()!*") + '")'


# ---------------------------------------------------------------- spruce silhouettes
def spruce(seed, tiers=13, H=1000.0, W=400.0):
    """A spruce in tree units (tip at 0,0, base at y=H): outline path and snow-on-branch path."""
    r = random.Random(seed)
    left, right, snow_l, snow_r = [], [], [], []
    prev_l = prev_r = (0.0, 0.0)
    for i in range(1, tiers + 1):
        t = i / tiers
        y = H * (0.035 + 0.9 * t ** 1.08)
        droop = H * 0.018 * (0.5 + t)
        for side, acc, snow, prev in ((-1, left, snow_l, prev_l), (1, right, snow_r, prev_r)):
            w = W / 2 * (t ** 0.92) * r.uniform(0.82, 1.12)
            tip = (side * w, y + droop * r.uniform(0.6, 1.3))
            # needles along the lower edge of the branch, back towards the trunk
            j1 = (side * w * r.uniform(0.72, 0.8), y + droop * 0.2 + r.uniform(-4, 6))
            j2 = (side * w * r.uniform(0.58, 0.64), y + droop * 0.75 + r.uniform(-3, 5))
            j3 = (side * w * r.uniform(0.44, 0.5), y + droop * 0.1 + r.uniform(-4, 4))
            notch = (side * w * r.uniform(0.2, 0.3), y + H * 0.012)
            acc += [tip, j1, j2, j3, notch]
            # snow lies along the top of the branch, from the notch above out to the tip
            mid = ((prev[0] + tip[0]) / 2 + side * r.uniform(2, 8), (prev[1] + tip[1]) / 2 - r.uniform(2, 8))
            if r.random() < 0.62:  # patchy: not every branch holds snow
                snow.append((prev, mid, tip))
            if side < 0:
                prev_l = notch
            else:
                prev_r = notch
        prev = None
    trunk = W * 0.035
    pts = [(0, 0)] + left + [(-trunk, H * 0.95), (-trunk, H), (trunk, H), (trunk, H * 0.95)] + list(reversed(right))
    i_ = lambda v: str(round(v))
    d = "M" + " ".join(f"{i_(x)} {i_(y)}" for x, y in pts) + "Z"
    sd = " ".join(f"M{i_(a[0])} {i_(a[1])}Q{i_(m[0])} {i_(m[1])} {i_(b[0])} {i_(b[1])}" for a, m, b in snow_l + snow_r)
    return d, sd


TREES = [spruce(s) for s in (3, 17, 42)]


def tree_defs(snow_color=None, snow_width=7, snow_opacity=0.5):
    out = []
    for i, (d, sd) in enumerate(TREES):
        out.append(f"<path id='t{i}' d='{d}'/>")
        if snow_color:
            out.append(f"<path id='s{i}' d='{sd}' fill='none' stroke='{snow_color}' stroke-width='{snow_width}' stroke-linecap='round' stroke-opacity='{snow_opacity}'/>")
    return "".join(out)


def place(x, base, h, r, snow=False, fill=None):
    """<use> a random spruce so its base sits at (x, base), h tall, sometimes mirrored."""
    i = r.randrange(len(TREES))
    s = h / 1000
    sx = s * (1 if r.random() < 0.5 else -1) * r.uniform(0.85, 1.12)
    tr = f"translate({round(x)} {round(base - h)}) scale({sx:.3f} {s:.3f})"
    out = f"<use href='#t{i}' transform='{tr}'{f' fill={chr(39)}{fill}{chr(39)}' if fill else ''}/>"
    if snow:
        out += f"<use href='#s{i}' transform='{tr}'/>"
    return out


# ---------------------------------------------------------------- moon
moon = uri(
    """<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'>
<defs>
<radialGradient id='g' cx='43%' cy='40%' r='64%'><stop offset='0' stop-color='#f6f8fa'/><stop offset='.62' stop-color='#dfe6ec'/><stop offset='1' stop-color='#a9b7c3'/></radialGradient>
<radialGradient id='sh' cx='30%' cy='70%' r='75%'><stop offset='.55' stop-color='#1b232b' stop-opacity='0'/><stop offset='1' stop-color='#1b232b' stop-opacity='.55'/></radialGradient>
<filter id='m' x='0' y='0' width='100%' height='100%'><feTurbulence type='fractalNoise' baseFrequency='.03' numOctaves='4' seed='9'/><feColorMatrix values='0 0 0 0 .42 0 0 0 0 .47 0 0 0 0 .53 -2.7 0 0 0 1.55'/></filter>
<filter id='n' x='0' y='0' width='100%' height='100%'><feTurbulence type='fractalNoise' baseFrequency='.5' numOctaves='2' seed='2'/><feColorMatrix values='0 0 0 0 .3 0 0 0 0 .34 0 0 0 0 .38 -1.4 0 0 0 .9'/></filter>
<clipPath id='c'><circle cx='100' cy='100' r='98'/></clipPath>
</defs>
<circle cx='100' cy='100' r='98' fill='url(#g)'/>
<g clip-path='url(#c)'>
<rect width='200' height='200' filter='url(#m)' opacity='.62'/>
<rect width='200' height='200' filter='url(#n)' opacity='.25'/>
<g fill='none' stroke='#7e8b97' stroke-opacity='.4' stroke-width='1.4'><circle cx='128' cy='142' r='9'/><circle cx='62' cy='58' r='5'/><circle cx='150' cy='76' r='4'/><circle cx='88' cy='160' r='3.5'/></g>
<g fill='#f7f9fb' fill-opacity='.5'><circle cx='129' cy='140' r='2.2'/><circle cx='61' cy='56' r='1.2'/></g>
<circle cx='100' cy='100' r='98' fill='url(#sh)'/>
</g>
</svg>"""
)

# ---------------------------------------------------------------- clouds (lit on the moon side)
r = random.Random(71)
MX, MY = 1800, 218  # the moon in cloud coordinates (the cloud layer spans -6%..106% and the top 78%)
cl = []
for band, (n, y0, y1, rx, ry, op) in enumerate(((16, 110, 250, (140, 430), (14, 38), (0.35, 0.6)), (22, 330, 540, (200, 520), (50, 130), (0.45, 0.75)), (14, 560, 720, (260, 600), (60, 120), (0.5, 0.8)))):
    for _ in range(n):
        x = r.uniform(-200, 2600)
        y = r.uniform(y0, y1)
        a, b = r.uniform(*rx), r.uniform(*ry)
        cl.append(f"<ellipse cx='{f(x)}' cy='{f(y)}' rx='{f(a)}' ry='{f(b)}' fill='url(#d)' opacity='{r.uniform(*op):.2f}'/>")
        dist = math.hypot(x - MX, (y - MY) * 1.6)
        if dist < 900:  # moonlit edge: a lighter crescent offset towards the moon
            k = (1 - dist / 900) ** 1.3
            dx, dy = (MX - x), (MY - y)
            n_ = math.hypot(dx, dy) or 1
            cl.append(f"<ellipse cx='{f(x + dx / n_ * b * 0.5)}' cy='{f(y + dy / n_ * b * 0.55)}' rx='{f(a * 0.85)}' ry='{f(b * 0.55)}' fill='url(#l)' opacity='{0.85 * k:.2f}'/>")
clouds = uri(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2400 1000' preserveAspectRatio='none'><defs>"
    "<radialGradient id='d'><stop offset='0' stop-color='#1d252c' stop-opacity='.95'/><stop offset='.55' stop-color='#1a2128' stop-opacity='.55'/><stop offset='1' stop-color='#161c22' stop-opacity='0'/></radialGradient>"
    "<radialGradient id='l'><stop offset='0' stop-color='#b3c2ce' stop-opacity='.5'/><stop offset='.6' stop-color='#8e9eab' stop-opacity='.18'/><stop offset='1' stop-color='#8e9eab' stop-opacity='0'/></radialGradient>"
    "</defs>" + "".join(cl) + "</svg>"
)


# ---------------------------------------------------------------- mountains
def midpoint(seed, n_levels, y_left, y_right, amp, rough):
    r = random.Random(seed)
    pts = [y_left, y_right]
    a = amp
    for _ in range(n_levels):
        nxt = []
        for i in range(len(pts) - 1):
            nxt += [pts[i], (pts[i] + pts[i + 1]) / 2 + r.uniform(-a, a)]
        nxt.append(pts[-1])
        pts = nxt
        a *= rough
    return pts


VW, VH = 2400, 600


def range_path(ys, envelope):
    n = len(ys)
    xs = [i * VW / (n - 1) for i in range(n)]
    ys = [VH - (VH - y) * envelope(x / VW) for x, y in zip(xs, ys)]
    return xs, ys


def env_main(u):
    # tall at the flanks, a low saddle in the middle where the lyrics are
    return 0.34 + 0.66 * (math.exp(-((u - 0.2) / 0.16) ** 2) * 1.0 + math.exp(-((u - 0.8) / 0.15) ** 2) * 0.95 + math.exp(-((u - 0.5) / 0.3) ** 2) * 0.12)


far_ys = midpoint(5, 7, 260, 300, 150, 0.56)
xs_f, ys_f = range_path(far_ys, lambda u: 0.7 + 0.3 * math.sin(u * math.pi * 3.1 + 1) ** 2)
main_ys = midpoint(12, 7, 120, 170, 210, 0.58)
xs_m, ys_m = range_path(main_ys, env_main)


def poly(xs, ys):
    return f"M0 {VH}L" + " ".join(f"{round(x)} {round(y)}" for x, y in zip(xs, ys)) + f" {VW} {VH}Z"


# rock gullies and snow streaks running down from the peaks, following the slope
r = random.Random(33)
gullies, streaks = [], []
for i in range(4, len(ys_m) - 4):
    if ys_m[i] == min(ys_m[i - 4 : i + 5]) and ys_m[i] < VH * 0.62:  # a prominent peak
        for k in range(r.randint(4, 7)):
            side = -1 if k % 2 else 1
            x = xs_m[i] + side * r.uniform(4, 40)
            y = ys_m[i] + r.uniform(10, 40)
            d = f"M{round(x)} {round(y)}L"
            for _ in range(r.randint(3, 6)):
                x += side * r.uniform(4, 11)
                y += r.uniform(8, 18)
                d += f" {round(x)} {round(y)}"
            (gullies if k % 3 else streaks).append(d)
lit = []
for i in range(len(ys_m) - 1):
    if ys_m[i + 1] > ys_m[i] + 0.5 and ys_m[i] < VH * 0.7:
        lit.append(f"M{round(xs_m[i])} {round(ys_m[i])}L{round(xs_m[i + 1])} {round(ys_m[i + 1])}")
mountains = uri(
    f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {VW} {VH}' preserveAspectRatio='none'><defs>"
    "<linearGradient id='fr' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#4c5864'/><stop offset='.45' stop-color='#2b343d'/><stop offset='1' stop-color='#1a2026'/></linearGradient>"
    "<linearGradient id='mr' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#e2e9ef'/><stop offset='.1' stop-color='#b4c2cd'/><stop offset='.24' stop-color='#5a6671'/><stop offset='.42' stop-color='#28313a'/><stop offset='1' stop-color='#0d1115'/></linearGradient>"
    "<linearGradient id='hz' x1='0' y1='0' x2='0' y2='1'><stop offset='.45' stop-color='#9fb0bf' stop-opacity='0'/><stop offset='1' stop-color='#9fb0bf' stop-opacity='.22'/></linearGradient>"
    f"<path id='f' d='{poly(xs_f, ys_f)}'/><path id='m' d='{poly(xs_m, ys_m)}'/>"
    "</defs>"
    "<use href='#f' fill='url(#fr)' opacity='.85'/><use href='#f' fill='url(#hz)'/><use href='#m' fill='url(#mr)'/>"
    f"<path d='{' '.join(gullies)}' fill='none' stroke='#0c1014' stroke-opacity='.32' stroke-width='1.3' stroke-linejoin='round' vector-effect='non-scaling-stroke'/>"
    f"<path d='{' '.join(streaks)}' fill='none' stroke='#e6edf2' stroke-opacity='.22' stroke-width='1.1' stroke-linejoin='round' vector-effect='non-scaling-stroke'/>"
    f"<path d='{' '.join(lit)}' fill='none' stroke='#eef3f7' stroke-opacity='.55' stroke-width='1.3' stroke-linecap='round' vector-effect='non-scaling-stroke'/>"
    "<use href='#m' fill='url(#hz)'/>"
    "</svg>"
)

# ---------------------------------------------------------------- forests
r = random.Random(8)
TW, TH = 2400, 700
# far treeline: at that distance a spiky silhouette reads as forest (one path, not many trees)
fp = ["M0 700L0 520"]
x = 0.0
while x < TW:
    x += r.uniform(13, 26)
    h = r.uniform(45, 115)
    w = h * r.uniform(0.2, 0.27)
    base = 520 + r.uniform(-8, 3)
    fp.append(f"{round(x - w)} {round(base)} {round(x)} {round(base - h)} {round(x + w)} {round(base)}")
fp.append(f"{TW} 520 {TW} 700Z")
far_row = "<path d='" + " ".join(fp) + "'/>"
mid_row = ""
for i in range(46):
    x = 60 + i * 2280 / 45 + r.uniform(-18, 18)
    u = abs(x / TW - 0.5) * 2
    h = r.uniform(170, 330) * (0.62 + 0.5 * u)
    mid_row += place(x, TH + r.uniform(0, 12), h, r, snow=True)
forest_tile = uri(
    f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {TW} {TH}'><defs>"
    + tree_defs("#8f9daa", 6, 0.3)
    + "<linearGradient id='fg' x1='0' y1='0' x2='0' y2='700' gradientUnits='userSpaceOnUse'><stop offset='.55' stop-color='#46525c'/><stop offset='.8' stop-color='#303a43'/></linearGradient>"
    "<linearGradient id='mg' x1='0' y1='0' x2='0' y2='700' gradientUnits='userSpaceOnUse'><stop offset='.45' stop-color='#26303a'/><stop offset='1' stop-color='#0d1115'/></linearGradient>"
    "</defs>"
    f"<g fill='url(#fg)'>{far_row}</g>"
    f"<rect y='515' width='{TW}' height='{TH - 515}' fill='#2a333c' opacity='.9'/>"
    f"<g fill='url(#mg)'>{mid_row}</g>"
    "</svg>"
)


def cluster(seed, side):
    r = random.Random(seed)
    W, H = 900, 1400
    out = ""
    specs = [(r.uniform(-40, 160), r.uniform(1150, 1390)), (r.uniform(230, 360), r.uniform(900, 1080)), (r.uniform(420, 540), r.uniform(640, 820)), (r.uniform(600, 700), r.uniform(430, 560)), (r.uniform(740, 820), r.uniform(260, 360))]
    for x, h in specs:
        x = x if side == "l" else W - x
        out += place(x, H + 10, h, r, snow=True)
    return uri(
        f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 {W} {H}'><defs>"
        + tree_defs("#c9d4dd", 5, 0.36)
        + f"</defs><g fill='#030405'>{out}</g></svg>"
    )


near_left, near_right = cluster(90, "l"), cluster(91, "r")

# ---------------------------------------------------------------- thorn ornament under the current line
r = random.Random(13)
th = []
for side in (-1, 1):
    for i in range(9):
        x = 300 + side * (38 + i * 27 + r.uniform(-4, 4))
        s = 1 - i / 11
        up = -1 if i % 2 == 0 else 1
        th.append(f"M{f(x - side * 7 * s)} 20 L{f(x + side * 9 * s)} {f(20 + up * 13 * s)} L{f(x + side * 1.5)} 20Z")
thorn = uri(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 600 40'><g fill='#eef3f6'>"
    "<path d='M20 20 Q160 18.4 300 17.6 Q440 18.4 580 20 Q440 21.6 300 22.4 Q160 21.6 20 20Z'/>"
    + "".join(f"<path d='{p}'/>" for p in th)
    + "<path d='M300 1 L304 16 L300 20 L296 16Z M300 39 L304 24 L300 20 L296 24Z M285 20 L296 17.5 L300 20 L296 22.5Z M315 20 L304 17.5 L300 20 L304 22.5Z'/>"
    "<path d='M300 20 L310 8 L303 18Z M300 20 L290 8 L297 18Z M300 20 L310 32 L303 22Z M300 20 L290 32 L297 22Z' opacity='.7'/>"
    "</g></svg>"
)

# ---------------------------------------------------------------- photocopy specks (dark, sparse) for the lettering
specks = uri(
    "<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='x'><feTurbulence type='fractalNoise' baseFrequency='1.05' numOctaves='1' seed='4' stitchTiles='stitch'/>"
    "<feColorMatrix values='0 0 0 0 .06 0 0 0 0 .07 0 0 0 0 .09 3.4 0 0 0 -2.35'/></filter><rect width='100%' height='100%' filter='url(#x)'/></svg>"
)


# ---------------------------------------------------------------- CSS: fog and snow layers
def fog(seed, n, ys, rx, ry, a):
    r = random.Random(seed)
    return ",\n\t\t".join(
        f"radial-gradient({r.uniform(*rx):.0f}% {r.uniform(*ry):.0f}% at {r.uniform(-5, 105):.0f}% {r.uniform(*ys):.0f}%, rgba(186, 199, 211, {r.uniform(*a):.3f}), transparent 70%)" for _ in range(n)
    )


def snow(seed, n, size, tile, alpha, soft=False):
    r = random.Random(seed)
    g = []
    for _ in range(n):
        s = r.uniform(*size)
        a = r.uniform(*alpha)
        stop = "transparent" if not soft else "transparent 100%"
        mid = f", rgba(235, 242, 248, {a * 0.35:.2f}) 45%" if soft else ""
        g.append(f"radial-gradient({s:.1f}px {s:.1f}px at {r.uniform(0, tile):.0f}px {r.uniform(0, tile):.0f}px, rgba(235, 242, 248, {a:.2f}){mid}, {stop})")
    return ",\n\t\t".join(g)


VALUES = {
    "MOON": moon,
    "CLOUDS": clouds,
    "MOUNTAINS": mountains,
    "FOREST": forest_tile,
    "NEAR_L": near_left,
    "NEAR_R": near_right,
    "THORN": thorn,
    "SPECKS": specks,
    "FOG_BAND": fog(4, 12, (30, 80), (14, 30), (10, 22), (0.07, 0.15)),
    "FOG_GROUND": fog(9, 9, (55, 100), (18, 34), (18, 34), (0.05, 0.11)),
    "SNOW_FAR": snow(8, 16, (0.8, 1.4), 320, (0.3, 0.6)),
    "SNOW_MID": snow(5, 11, (1.5, 2.4), 320, (0.5, 0.85)),
    "SNOW_NEAR": snow(6, 5, (5, 9), 520, (0.35, 0.55), soft=True),
}
tpl = open(os.path.join(D, "blackmetal.tpl.css"), encoding="utf-8").read()
for k, v in VALUES.items():
    tpl = tpl.replace("{{" + k + "}}", v)
assert "{{" not in tpl
print("ok", len(tpl), {k: len(v) for k, v in VALUES.items()})

START, END = '/* Black Metal: ', '/* Lounge:'

# Write the finished block straight into src/styles.css, replacing the theme's current block.
STYLES = os.path.join(D, "..", "..", "src", "styles.css")
css = open(STYLES, encoding="utf-8").read()
i = css.index(START)
j = css.index(END, i)
open(STYLES, "w", encoding="utf-8", newline=chr(10)).write(css[:i] + tpl + css[j:])
print("updated src/styles.css")
