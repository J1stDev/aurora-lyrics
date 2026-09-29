"""Vaporwave, Ocean and Rain theme ambience: vector artwork (seeded, so every build is identical)
written into the three theme blocks of src/styles.css.

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


# =============================================================================== VAPORWAVE
def vw_sun():
    """A pastel sun with a wireframe globe over it."""
    W = H = 800
    c, r = 400, 380
    lines = []
    for k in range(-3, 4):  # latitudes
        y = c + k * r / 4
        half = math.sqrt(max(r * r - (k * r / 4) ** 2, 0))
        ry = 26 + abs(k) * 4
        lines.append(f"<path d='M{c - half:.1f} {y:.1f}A{half:.1f} {ry} 0 0 0 {c + half:.1f} {y:.1f}'/>")
    for m in range(1, 6):  # meridians
        rx = r * m / 6
        lines.append(f"<ellipse cx='{c}' cy='{c}' rx='{rx:.1f}' ry='{r}'/>")
    lines.append(f"<circle cx='{c}' cy='{c}' r='{r}'/>")
    defs = (
        "<linearGradient id='s' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#fff2a0'/><stop offset='.4' stop-color='#ff9ad0'/><stop offset='1' stop-color='#9a63ff'/></linearGradient>"
        "<radialGradient id='h'><stop offset='.62' stop-color='#ff8ee0' stop-opacity='.35'/><stop offset='1' stop-color='#ff8ee0' stop-opacity='0'/></radialGradient>"
    )
    body = (
        f"<circle cx='{c}' cy='{c}' r='400' fill='url(#h)'/>"
        f"<circle cx='{c}' cy='{c}' r='{r}' fill='url(#s)'/>"
        f"<g fill='none' stroke='#7ff4ff' stroke-opacity='.5' stroke-width='2.2'>{''.join(lines)}</g>"
    )
    return svg(W, H, body, defs)


def vw_floor():
    """A checkerboard floor in perspective; the horizon is the top edge."""
    W, H = 1600, 400
    rows, cols = 14, 20
    vx = W / 2

    def x_at(i, y):
        xb = vx + (i - cols / 2) * 200
        return vx + (xb - vx) * (y / H)

    ys = [H * (k / rows) ** 2.3 for k in range(rows + 1)]
    cells = {0: [], 1: []}
    for k in range(rows):
        for i in range(cols):
            cells[(i + k) % 2].append(
                f"M{x_at(i, ys[k]):.0f} {ys[k]:.0f}L{x_at(i + 1, ys[k]):.0f} {ys[k]:.0f} {x_at(i + 1, ys[k + 1]):.0f} {ys[k + 1]:.0f} {x_at(i, ys[k + 1]):.0f} {ys[k + 1]:.0f}Z"
            )
    defs = "<linearGradient id='f' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#ffb8ec' stop-opacity='.95'/><stop offset='.18' stop-color='#ff8ee0' stop-opacity='.45'/><stop offset='.55' stop-color='#2a0f6b' stop-opacity='0'/></linearGradient>"
    body = (
        f"<path d='{''.join(cells[0])}' fill='#2a0f6b' fill-opacity='.9'/><path d='{''.join(cells[1])}' fill='#ff5fc4' fill-opacity='.62'/>"
        f"<rect width='{W}' height='{H}' fill='url(#f)'/>"
    )
    return svg(W, H, body, defs)


def vw_objects():
    """A floating marble column, a wireframe pyramid, a cube, a ring and a triangle."""
    W, H = 1600, 900
    parts = []
    cx, top, bot, w = 165, 200, 620, 64
    flutes = "".join(
        f"<path d='M{cx - w / 2 + 6 + i * (w - 12) / 5:.1f} {top + 34}V{bot - 30}' stroke='#9a86d8' stroke-opacity='.55' stroke-width='2.4'/>" for i in range(6)
    )
    parts.append(
        f"<g transform='rotate(-9 {cx} {(top + bot) / 2})'>"
        f"<rect x='{cx - w / 2 - 22}' y='{top - 6}' width='{w + 44}' height='18' rx='3' fill='url(#m)'/>"
        f"<rect x='{cx - w / 2 - 12}' y='{top + 12}' width='{w + 24}' height='16' rx='3' fill='url(#m)'/>"
        f"<rect x='{cx - w / 2}' y='{top + 28}' width='{w}' height='{bot - top - 56}' fill='url(#m)'/>{flutes}"
        f"<rect x='{cx - w / 2 - 12}' y='{bot - 28}' width='{w + 24}' height='16' rx='3' fill='url(#m)'/>"
        f"<rect x='{cx - w / 2 - 22}' y='{bot - 12}' width='{w + 44}' height='18' rx='3' fill='url(#m)'/></g>"
    )
    px, py, s = 1340, 330, 130
    a, b, c_, d = (px - s, py + s * 0.5), (px + s, py + s * 0.5), (px + s * 0.35, py + s * 0.95), (px, py - s)
    parts.append(
        f"<path d='M{pts([a, d, c_])}Z' fill='#ff71ce' fill-opacity='.28'/>"
        f"<g fill='none' stroke='#7ff4ff' stroke-width='3' stroke-linejoin='round' stroke-opacity='.85'>"
        f"<path d='M{pts([a, d, b, c_])}Z'/><path d='M{pts([d, c_])}'/><path d='M{pts([a, c_])}' stroke-opacity='.4' stroke-dasharray='6 8'/></g>"
    )
    qx, qy, q = 1190, 560, 46
    parts.append(
        f"<g fill='none' stroke='#ff9ee6' stroke-width='2.6' stroke-linejoin='round'>"
        f"<path d='M{pts([(qx, qy), (qx + q, qy), (qx + q, qy + q), (qx, qy + q)])}Z'/>"
        f"<path d='M{pts([(qx + 22, qy - 20), (qx + q + 22, qy - 20), (qx + q + 22, qy + q - 20), (qx + 22, qy + q - 20)])}Z' stroke-opacity='.6'/>"
        f"<path d='M{pts([(qx, qy), (qx + 22, qy - 20)])}M{pts([(qx + q, qy), (qx + q + 22, qy - 20)])}M{pts([(qx + q, qy + q), (qx + q + 22, qy + q - 20)])}M{pts([(qx, qy + q), (qx + 22, qy + q - 20)])}'/></g>"
    )
    parts.append("<g fill='none' stroke='#7ff4ff' stroke-width='3' stroke-opacity='.7'><ellipse cx='470' cy='300' rx='56' ry='18' transform='rotate(-22 470 300)'/></g>")
    parts.append(f"<path d='M{pts([(1450, 610), (1500, 700), (1400, 700)])}Z' fill='none' stroke='#ffe86a' stroke-width='3' stroke-opacity='.8'/>")
    defs = "<linearGradient id='m' x1='0' y1='0' x2='1' y2='0'><stop offset='0' stop-color='#c9bdf5'/><stop offset='.45' stop-color='#fff'/><stop offset='1' stop-color='#a08de0'/></linearGradient>"
    return svg(W, H, "".join(parts), defs, "xMidYMid slice")


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
        wd = (16 - 9 * t) * scale
        left.append((x - dy / n * wd / 2, y + dx / n * wd / 2))
        right.append((x + dy / n * wd / 2, y - dx / n * wd / 2))
    out = [f"<path d='M{pts(left + right[::-1])}Z'/>"]
    for k in range(fronds):
        a = math.radians(-180 + (k + 0.5) * 180 / fronds + r.uniform(-8, 8))
        ln = r.uniform(150, 230) * scale
        ex, ey = tip[0] + math.cos(a) * ln, tip[1] + math.sin(a) * ln * 0.55 + ln * 0.5 * abs(math.cos(a))
        mx, my = tip[0] + math.cos(a) * ln * 0.55, tip[1] + math.sin(a) * ln * 0.75 - 26 * scale
        wd = 20 * scale
        out.append(f"<path d='M{tip[0]:.1f} {tip[1]:.1f}Q{mx:.1f} {my - wd:.1f} {ex:.1f} {ey:.1f}Q{mx:.1f} {my + wd:.1f} {tip[0]:.1f} {tip[1]:.1f}Z'/>")
    return "".join(out)


def vw_palms():
    W, H = 1600, 900
    body = (
        "<g fill='#12052e'>"
        + palm(60, 900, 520, 70, 9, 5)
        + palm(210, 900, 330, -30, 8, 8, 0.7)
        + palm(1560, 900, 560, -70, 9, 13)
        + palm(1420, 900, 320, 40, 7, 21, 0.65)
        + "</g>"
    )
    return svg(W, H, body, "", "xMidYMax slice")


def vw_sparkles():
    r = random.Random(4)
    W, H = 1600, 900
    body = []
    for _ in range(22):
        x, y = r.uniform(30, 1570), r.uniform(20, 520)
        s = r.uniform(5, 15)
        col = r.choice(["#ffffff", "#ffe0f6", "#c8faff"])
        body.append(
            f"<path d='M{x:.0f} {y - s:.0f}Q{x:.0f} {y:.0f} {x + s:.0f} {y:.0f}Q{x:.0f} {y:.0f} {x:.0f} {y + s:.0f}Q{x:.0f} {y:.0f} {x - s:.0f} {y:.0f}Q{x:.0f} {y:.0f} {x:.0f} {y - s:.0f}Z' fill='{col}' fill-opacity='{r.uniform(.5, 1):.2f}'/>"
        )
    return svg(W, H, "".join(body), "", "xMidYMid slice")


# =============================================================================== OCEAN
def oc_beams(seed, n, opacity):
    r = random.Random(seed)
    W, H = 2000, 1000
    polys = []
    for _ in range(n):
        x = r.uniform(0, W)
        top_w = r.uniform(14, 60)
        lean = r.uniform(-90, 260)
        bot_w = top_w + r.uniform(60, 220)
        o = r.uniform(0.35, 1) * opacity
        polys.append(f"<path d='M{x:.0f} 0L{x + top_w:.0f} 0 {x + top_w + lean + bot_w:.0f} {H} {x + lean:.0f} {H}Z' fill-opacity='{o:.2f}'/>")
    defs = "<linearGradient id='b' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#e9fdff'/><stop offset='.35' stop-color='#9be6ff' stop-opacity='.55'/><stop offset='1' stop-color='#3aa8e0' stop-opacity='0'/></linearGradient>"
    return svg(W, H, f"<g fill='url(#b)'>{''.join(polys)}</g>", defs)


def oc_kelp(seed, strands, tone, height, maxw, W=2000, H=1000, sand=False):
    r = random.Random(seed)
    out = []
    for i in range(strands):
        x0 = (i + r.uniform(0.1, 0.9)) * W / strands
        hh = height * r.uniform(0.55, 1)
        amp = r.uniform(20, 60)
        fr = r.uniform(1.4, 3.2)
        ph = r.uniform(0, 6.3)
        w0 = r.uniform(maxw * 0.5, maxw)
        left, right = [], []
        for k in range(29):
            t = k / 28
            y = H - hh * t
            x = x0 + amp * math.sin(t * fr * math.pi + ph) * t
            wd = w0 * (1 - t) ** 0.7 + 1.5
            left.append((x - wd / 2, y))
            right.append((x + wd / 2, y))
        out.append(f"<path d='M{pts(left + right[::-1])}Z'/>")
        for _ in range(r.randint(2, 4)):
            t = r.uniform(0.25, 0.85)
            y = H - hh * t
            x = x0 + amp * math.sin(t * fr * math.pi + ph) * t
            sd = r.choice((-1, 1))
            ln = r.uniform(50, 110)
            out.append(f"<path d='M{x:.1f} {y:.1f}Q{x + sd * ln * 0.5:.1f} {y - ln * 0.55:.1f} {x + sd * ln * 0.25:.1f} {y - ln:.1f}Q{x + sd * ln * 0.12:.1f} {y - ln * 0.4:.1f} {x:.1f} {y:.1f}Z'/>")
    extra = ""
    if sand:
        s = [(0, H)]
        for k in range(0, W + 41, 40):
            s.append((k, H - 40 - 26 * math.sin(k / 210 + seed) - 14 * math.sin(k / 71)))
        s.append((W, H))
        extra = f"<path d='M{pts(s)}Z' fill='#0a2a3a'/>"
    return svg(W, H, f"<g fill='{tone}'>{''.join(out)}</g>{extra}", "", "xMidYMax slice")


def oc_bubbles(seed, n, tile_w, tile_h, rmin, rmax):
    r = random.Random(seed)
    defs = (
        "<radialGradient id='q' cx='.5' cy='.5' r='.5'><stop offset='.6' stop-color='#bfeeff' stop-opacity='.03'/><stop offset='.9' stop-color='#d8f6ff' stop-opacity='.42'/><stop offset='1' stop-color='#fff' stop-opacity='.7'/></radialGradient>"
        "<radialGradient id='g' cx='.5' cy='.5' r='.5'><stop offset='0' stop-color='#fff' stop-opacity='.95'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></radialGradient>"
    )
    body = []
    for _ in range(n):
        x, y = r.uniform(20, tile_w - 20), r.uniform(20, tile_h - 20)
        rad = r.uniform(rmin, rmax)
        body.append(f"<circle cx='{x:.0f}' cy='{y:.0f}' r='{rad:.1f}' fill='url(#q)'/>")
        hx, hy = x - rad * 0.32, y - rad * 0.36
        body.append(f"<ellipse cx='{hx:.1f}' cy='{hy:.1f}' rx='{rad * 0.22:.1f}' ry='{rad * 0.14:.1f}' fill='url(#g)' transform='rotate(-35 {hx:.1f} {hy:.1f})'/>")
    return svg(tile_w, tile_h, "".join(body), defs, "xMinYMin slice")


def oc_fish():
    r = random.Random(17)
    W, H = 1200, 300
    out = []
    for _ in range(16):
        x, y = r.uniform(120, W - 160), r.uniform(30, H - 30)
        L = r.uniform(58, 92)
        out.append(
            f"<path d='M{x:.0f} {y:.0f}Q{x + L * 0.45:.0f} {y - L * 0.32:.0f} {x + L:.0f} {y:.0f}Q{x + L * 0.45:.0f} {y + L * 0.32:.0f} {x:.0f} {y:.0f}Z"
            f"M{x:.0f} {y:.0f}L{x - L * 0.38:.0f} {y - L * 0.26:.0f} {x - L * 0.38:.0f} {y + L * 0.26:.0f}Z'/>"
        )
    return svg(W, H, f"<g fill='#03203a' fill-opacity='.62'>{''.join(out)}</g>", "", "xMidYMid meet")


def oc_surface():
    W, H = 2400, 200
    top = [(x, 64 + 22 * math.sin(2 * math.pi * 6 * x / W) + 9 * math.sin(2 * math.pi * 17 * x / W)) for x in range(0, W + 1, 8)]  # periodic, so the tile joins up
    defs = "<linearGradient id='w' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#eaffff' stop-opacity='.55'/><stop offset='1' stop-color='#7fe0ff' stop-opacity='0'/></linearGradient>"
    body = (
        f"<path d='M0 0H{W}V{top[-1][1]:.0f}L{pts(top[::-1])}Z' fill='url(#w)'/>"
        f"<path d='M{pts(top)}' fill='none' stroke='#f2ffff' stroke-opacity='.7' stroke-width='4'/>"
    )
    return svg(W, H, body, defs)


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
    "VW_SUN": vw_sun(), "VW_FLOOR": vw_floor(), "VW_OBJECTS": vw_objects(), "VW_PALMS": vw_palms(), "VW_SPARKLES": vw_sparkles(),
    "OC_BEAMS_A": oc_beams(6, 9, 0.55), "OC_BEAMS_B": oc_beams(12, 7, 0.35), "OC_SURFACE": oc_surface(), "OC_FISH": oc_fish(),
    "OC_KELP_NEAR": oc_kelp(3, 15, "#04222f", 620, 46, sand=True), "OC_KELP_FAR": oc_kelp(9, 20, "#0b4256", 500, 34),
    "OC_BUBBLES": oc_bubbles(2, 20, 700, 900, 6, 22), "OC_BUBBLES_S": oc_bubbles(5, 30, 500, 700, 2.5, 7),
    "RAIN_SKYLINE": rain_skyline(), "RAIN_BOKEH": rain_bokeh(), "RAIN_CARS_W": rain_cars(5, "255,236,190", 4), "RAIN_CARS_R": rain_cars(8, "255,70,60", 4),
    "RAIN_STREAKS": rain_streaks(19, 40, 0.2, 40, 90, 1.2, 730), "RAIN_STREAKS_B": rain_streaks(7, 22, 0.32, 70, 150, 1.9, 1000),
    "RAIN_DROPS_A": rain_drops(31, 140), "RAIN_DROPS_B": rain_drops(37, 140), "RAIN_HEAD": rain_head(),
    "RAIN_RUNNERS": rain_runners(), "RAIN_KEYFRAMES": rain_keyframes(), "RAIN_MIST": MIST, "RAIN_MIST_SIZES": MIST_SIZES,
}

STYLES = os.path.join(D, "..", "..", "src", "styles.css")
css = open(STYLES, encoding="utf-8").read()
# the three blocks sit together, right before the beat-sync section
BEAT = css.index("/* ============================================================== beat sync")
first = css.find("/* Vaporwave: a pastel")
if first != -1:
    css = css[:first] + css[BEAT:]
    BEAT = first
blocks = []
for name in ("vaporwave", "ocean", "rain"):
    tpl = open(os.path.join(D, name + ".tpl.css"), encoding="utf-8").read()
    for k, v in VALUES.items():
        tpl = tpl.replace("{{" + k + "}}", v)
    assert "{{" not in tpl, name
    blocks.append(tpl.rstrip() + "\n\n")
    print(name, len(tpl))
css = css[:BEAT] + "".join(blocks) + css[BEAT:]
open(STYLES, "w", encoding="utf-8", newline=chr(10)).write(css)
print("updated src/styles.css")
