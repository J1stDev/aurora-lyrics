"""Rain theme: artwork and generated rules, written into src/themes/rain.css from rain.tpl.css.

Usage: python tools/themes/gen-rain.py  (then node build.mjs)

Rain is a cosy room on a rainy night. A big window fills the screen: a centre pane for the lyrics and two
narrow side panes with small square lights. Outside, a city in the rain under a violet sky that glows pink
and orange over the rooftops: three depths of towers with lit windows, water tanks, spires with red lights,
neon signs in the album's colours, a hazy moon behind low clouds that drift by, lightning now and then.
Rain falls in two depths, beads of water sit on the glass and drops run down it. Inside, warm light: a string
of fairy lights along the top of the window, and on the sill a mug of tea with steam curling up, a plant, a
stack of books with a candle on it, and a cat watching the rain with its tail swishing in tempo.

Everything is vector art drawn here once (seeded, so every build is identical); the stylesheet only moves it
(transform and opacity), so it stays sharp at any size and smooth at any frame rate."""
import math
import os
import random

from artlib import n, stops, svg

D = os.path.dirname(os.path.abspath(__file__))
W, H = 1600, 900  # the city picture, in design units (16:9, it covers the screen, anchored at the bottom)


def rect(x, y, w, h, fill, extra=""):
    return f"<rect x='{n(x)}' y='{n(y)}' width='{n(w)}' height='{n(h)}' fill='{fill}'{extra}/>"


# =============================================================================== the city
WINDOW_COLOURS = [("#ffd38a", 0.55), ("#ffe7b3", 0.16), ("#ffb36b", 0.1), ("#cfe0ff", 0.12), ("#a6f0ff", 0.04), ("#ff9ad0", 0.03)]


def pick(r, table):
    t = r.random()
    for c, w in table:
        t -= w
        if t <= 0:
            return c
    return table[0][0]


class City:
    """Builds the skyline: buildings painted in order, their lit windows batched by colour (buildings in a layer stand side
    by side, so a layer's windows can all be drawn after its buildings)."""

    def __init__(self, seed):
        self.r = random.Random(seed)
        self.out = []
        self.defs = []
        self.signs = []  # neon in the album's colours: SVG elements for the mask
        self.boards = []  # the dark boards those signs are mounted on (drawn in the city)
        self.twinkle = []  # windows that come and go (drawn dark here, lit by the stylesheet)

    def layer(self, top_at, wmin, wmax, base, body, side, rim, win, roof_odds, sign_odds=0.0, haze=None):
        r = self.r
        x = -30.0
        windows = {}
        while x < W + 30:
            w = r.uniform(wmin, wmax)
            top = top_at(x + w / 2) + r.uniform(-28, 28)
            self.out.append(rect(x, top, w, base - top, body))
            if side:
                self.out.append(rect(x + w * 0.8, top, w * 0.2, base - top, side))
            self.out.append(rect(x, top, w, 1.8, rim, " fill-opacity='.35'"))
            roof = r.random()
            cx = x + w / 2
            if roof < roof_odds * 0.3:  # stepped crown
                w1, h1 = w * 0.68, r.uniform(16, 34)
                w2, h2 = w * 0.36, r.uniform(12, 24)
                self.out.append(rect(cx - w1 / 2, top - h1, w1, h1, body) + rect(cx - w1 / 2, top - h1, w1, 1.6, rim, " fill-opacity='.35'"))
                self.out.append(rect(cx - w2 / 2, top - h1 - h2, w2, h2, body) + rect(cx - w2 / 2, top - h1 - h2, w2, 1.6, rim, " fill-opacity='.35'"))
                if win and r.random() < 0.7:
                    self.out.append(f"<circle cx='{n(cx)}' cy='{n(top - h1 - h2 - 3)}' r='2.4' fill='#ff4f63'/>")
            elif roof < roof_odds * 0.55:  # spire with an aircraft light
                sh = r.uniform(50, 110)
                self.out.append(f"<path d='M{n(cx - 5)} {n(top)}L{n(cx)} {n(top - sh)}L{n(cx + 5)} {n(top)}Z' fill='{body}'/>")
                self.out.append(f"<circle cx='{n(cx)}' cy='{n(top - sh - 2)}' r='2.6' fill='#ff4f63'/>")
            elif roof < roof_odds * 0.8 and w > 40:  # a water tank on legs
                tx = x + r.uniform(0.2, 0.6) * w
                self.out.append(rect(tx + 3, top - 12, 2.5, 12, body) + rect(tx + 19, top - 12, 2.5, 12, body))
                self.out.append(f"<rect x='{n(tx)}' y='{n(top - 36)}' width='25' height='25' rx='3' fill='{body}'/>")
                self.out.append(f"<path d='M{n(tx - 2)} {n(top - 36)}L{n(tx + 12.5)} {n(top - 48)}L{n(tx + 27)} {n(top - 36)}Z' fill='{body}'/>")
                self.out.append(rect(tx, top - 36, 25, 1.4, rim, " fill-opacity='.3'"))
            elif roof < roof_odds:  # an antenna
                ah = r.uniform(24, 60)
                self.out.append(rect(cx - 1, top - ah, 2, ah, body))
            if win:
                ww, wh, sx, sy, p = win
                cols = int((w * 0.8 - 6) // sx)
                rows = int((base - top - 16) // sy)
                x0 = x + (w * 0.8 - cols * sx) / 2 + (sx - ww) / 2
                for i in range(cols):
                    for j in range(min(rows, 60)):
                        wx, wy = x0 + i * sx, top + 10 + j * sy
                        if wy > base - 10:
                            break
                        t = r.random()
                        if t < p:
                            windows.setdefault(pick(r, WINDOW_COLOURS), []).append(f"M{n(wx)} {n(wy)}h{n(ww)}v{n(wh)}h{n(-ww)}z")
                        elif t < p + 0.02 and sign_odds > 0:
                            self.twinkle.append(f"M{n(wx)} {n(wy)}h{n(ww)}v{n(wh)}h{n(-ww)}z")
            if sign_odds and r.random() < sign_odds and w > 70:
                self.sign(x, w, top)
            x += w + r.uniform(-4, 6)
        for c, segs in windows.items():
            self.out.append(f"<path d='{''.join(segs)}' fill='{c}'/>")
        if haze:
            g = f"h{len(self.defs)}"
            self.defs.append(f"<linearGradient id='{g}' x1='0' y1='0' x2='0' y2='1'>{stops([(0, haze, 0), (0.55, haze, 0.18), (1, haze, 0.62)])}</linearGradient>")
            self.out.append(f"<rect x='0' y='{n(top_at(800) - 260)}' width='{W}' height='{n(base - top_at(800) + 260)}' fill='url(#{g})'/>")

    def sign(self, x, w, top):
        """A neon sign on a building: a tall blade, a box on the roof or a ring. The board is drawn dark in the city; the tube goes in
        the mask that the album's colours fill."""
        r = self.r
        kind = r.choice(("blade", "blade", "roof", "ring"))
        if kind == "blade":
            sx, sy, sw, sh = x + r.uniform(6, w * 0.4), top + r.uniform(30, 90), 24, r.uniform(84, 130)
            self.boards.append(f"<rect x='{n(sx - 3)}' y='{n(sy - 3)}' width='{n(sw + 6)}' height='{n(sh + 6)}' rx='4' fill='#0a0b1d'/>")
            bars = "".join(f"<path d='M{n(sx + 6)} {n(sy + 12 + k * (sh - 24) / 3)}h12'/>" for k in range(4))
            self.signs.append(f"<rect x='{n(sx)}' y='{n(sy)}' width='{sw}' height='{n(sh)}' rx='4'/>{bars}")
        elif kind == "roof":
            sw, sh = w * 0.78, 30
            sx, sy = x + (w - sw) / 2, top - sh - 10
            self.boards.append(rect(sx + 6, sy + sh, 2.5, 10, "#0a0b1d") + rect(sx + sw - 8, sy + sh, 2.5, 10, "#0a0b1d"))
            self.boards.append(f"<rect x='{n(sx - 3)}' y='{n(sy - 3)}' width='{n(sw + 6)}' height='{n(sh + 6)}' rx='6' fill='#0a0b1d'/>")
            strokes = "".join(f"<path d='M{n(sx + 10 + k * (sw - 20) / 5)} {n(sy + 7)}v10'/>" for k in range(6))
            self.signs.append(f"<rect x='{n(sx)}' y='{n(sy)}' width='{n(sw)}' height='{sh}' rx='6'/>{strokes}")
        else:
            cx, cy, rr = x + w * 0.4, top + r.uniform(40, 110), 20
            self.boards.append(f"<circle cx='{n(cx)}' cy='{n(cy)}' r='{rr + 4}' fill='#0a0b1d'/>")
            self.signs.append(f"<circle cx='{n(cx)}' cy='{n(cy)}' r='{rr}'/><path d='M{n(cx - 6)} {n(cy)}h12'/>")


def valley(lo, hi, power=1.4):
    """A skyline that is low in the middle (where the words are) and tall at the sides."""
    return lambda x: lo - (lo - hi) * (min(1.0, abs(x - W / 2) / (W / 2)) ** power)


def city_art():
    c = City(4)
    c.layer(valley(600, 470, 1.2), 26, 62, 900, "#3b356f", None, "#f3b7c8", (3, 4, 7, 9, 0.32), 0.5, haze="#8c4f86")
    c.layer(valley(650, 380, 1.3), 40, 92, 900, "#272658", "#201f4c", "#e7a7d0", (4, 6, 9, 12, 0.36), 0.6, 0.3, haze="#5a3a78")
    c.layer(valley(720, 200, 1.15), 74, 168, 900, "#16173a", "#101130", "#c9b6ff", (6, 9, 13, 17, 0.42), 0.72, 0.6)
    # rain haze over the middle of the city, where the words are
    c.defs.append("<radialGradient id='hz'><stop offset='0' stop-color='#2c2460' stop-opacity='.55'/><stop offset='.6' stop-color='#2c2460' stop-opacity='.3'/><stop offset='1' stop-color='#2c2460' stop-opacity='0'/></radialGradient>")
    body = "".join(c.out) + "".join(c.boards) + "<ellipse cx='800' cy='600' rx='640' ry='300' fill='url(#hz)'/>"
    city = svg(W, H, body, "".join(c.defs), "xMidYMax slice")
    glow_defs = f"<filter id='g' x='0' y='0' width='{W}' height='{H}' filterUnits='userSpaceOnUse'><feGaussianBlur stdDeviation='6'/></filter>"
    tubes = "".join(c.signs)
    signs = svg(W, H, f"<g fill='none' stroke='#fff' stroke-width='3.6' stroke-linecap='round' stroke-linejoin='round'><g filter='url(#g)' stroke-width='12' opacity='.9'>{tubes}</g>{tubes}</g>", glow_defs, "xMidYMax slice")
    twinkle = svg(W, H, f"<path d='{''.join(c.twinkle)}' fill='#fff'/>", "", "xMidYMax slice")
    return city, signs, twinkle, len(c.signs), len(c.twinkle)


# =============================================================================== clouds (a tile that wraps)
def clouds(seed, count, top, bottom, under, alpha, wmin, wmax, hmin, hmax, ymin, ymax, TW=1600, TH=420):
    """Heavy rain clouds: flat-bottomed puffs, lit on top by the moon and underneath by the city's glow."""
    r = random.Random(seed)
    defs, out = [], []
    for i in range(count):
        cx = (i + r.uniform(0.15, 0.85)) * TW / count
        w, h = r.uniform(wmin, wmax), r.uniform(hmin, hmax)
        base = r.uniform(ymin, ymax)
        k = r.randint(6, 9)
        puffs = []
        for j in range(k):
            t = (j + 0.5) / k
            rad = h * (0.32 + 0.64 * math.sin(math.pi * t) ** 0.8) * r.uniform(0.8, 1.15)
            puffs.append((-w / 2 + w * t, -rad * 0.6, rad))
        shapes = "".join(f"<circle cx='{n(px)}' cy='{n(py)}' r='{n(pr)}'/>" for px, py, pr in puffs)
        defs.append(f"<linearGradient id='g{i}' gradientUnits='userSpaceOnUse' x1='0' y1='{n(-h * 1.6)}' x2='0' y2='0'>{stops([(0, top, 1), (0.75, bottom, 1), (1, under, 1)])}</linearGradient>")
        defs.append(f"<clipPath id='f{i}'><rect x='{n(-w)}' y='{n(-h * 2)}' width='{n(w * 2)}' height='{n(h * 2)}'/></clipPath>")
        cloud = f"<g clip-path='url(#f{i})'><g fill='url(#g{i})'>{shapes}</g></g>"
        for dx in (0, -TW, TW):
            if dx and not (cx - w / 2 + dx < TW and cx + w / 2 + dx > 0):
                continue
            out.append(f"<g transform='translate({n(cx + dx)} {n(base)})'>{cloud}</g>")
    return svg(TW, TH, f"<g opacity='{alpha}'>{''.join(out)}</g>", "".join(defs), "none")


# =============================================================================== rain
def streak_tile(seed, count, alpha, lmin, lmax, wmin, wmax, tile, slant=0.1, colour="#b9c9ff"):
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
DROP_DEFS = (
    "<radialGradient id='d' cx='.42' cy='.36' r='.7'><stop offset='0' stop-color='#d8e4ff' stop-opacity='.16'/><stop offset='.62' stop-color='#9fb2ff' stop-opacity='.1'/>"
    "<stop offset='.86' stop-color='#0b0e2a' stop-opacity='.42'/><stop offset='1' stop-color='#e4ecff' stop-opacity='.55'/></radialGradient>"
    "<radialGradient id='w'><stop offset='0' stop-color='#ffe0b0' stop-opacity='.6'/><stop offset='1' stop-color='#ffb36b' stop-opacity='0'/></radialGradient>"
    "<radialGradient id='p'><stop offset='0' stop-color='#ff9ad0' stop-opacity='.5'/><stop offset='1' stop-color='#ff9ad0' stop-opacity='0'/></radialGradient>"
)


# a bead of water at unit size, as a symbol: a lens with a dark rim at the bottom, the light it gathers glowing low inside it,
# and a bright spot up left (two tints: warm and pink); and a tiny one that is only a glint
DROP_SYMBOLS = (
    "<symbol id='a' overflow='visible'><ellipse rx='1' ry='1' fill='url(#d)'/><ellipse cx='.08' cy='.32' rx='.55' ry='.4' fill='url(#w)'/>"
    "<path d='M-.86 .2A1 1 0 0 0 .86 .2' fill='none' stroke='#05061a' stroke-opacity='.4' stroke-width='.16'/><ellipse cx='-.34' cy='-.4' rx='.26' ry='.18' fill='#fff' fill-opacity='.9'/></symbol>"
    "<symbol id='b' overflow='visible'><ellipse rx='1' ry='1' fill='url(#d)'/><ellipse cx='.08' cy='.32' rx='.55' ry='.4' fill='url(#p)'/>"
    "<path d='M-.86 .2A1 1 0 0 0 .86 .2' fill='none' stroke='#05061a' stroke-opacity='.4' stroke-width='.16'/><ellipse cx='-.34' cy='-.4' rx='.26' ry='.18' fill='#fff' fill-opacity='.9'/></symbol>"
    "<symbol id='c' overflow='visible'><ellipse rx='1' ry='1' fill='url(#d)'/><ellipse cx='-.3' cy='-.36' rx='.42' ry='.32' fill='#fff' fill-opacity='.85'/></symbol>"
)


def glass_drops(seed=21):
    r = random.Random(seed)
    out = []
    for count, lo, hi in ((420, 0.9, 2.0), (150, 2.2, 4.4), (44, 4.6, 8.5), (10, 9, 14)):
        for _ in range(count):
            x = r.uniform(0, W)
            y = H * (r.random() ** 0.75) if r.random() < 0.6 else r.uniform(0, H)
            rx = r.uniform(lo, hi)
            ry = rx * r.uniform(1.0, 1.25)
            if hi > 4 and r.random() < 0.35:  # the clear track it left as it slid down
                ln = r.uniform(30, 140)
                out.append(f"<path d='M{n(x)} {n(y - ry - ln)}V{n(y - ry * 0.6)}' stroke='#cfe0ff' stroke-opacity='.18' stroke-width='{n(rx * 0.5, 1)}' stroke-linecap='round'/>")
            sym = "c" if rx < 2.2 else ("a" if r.random() < 0.6 else "b")
            out.append(f"<use href='#{sym}' transform='translate({n(x)} {n(y)})scale({n(rx, 2)} {n(ry, 2)})'/>")
    return svg(W, H, "".join(out), DROP_DEFS + DROP_SYMBOLS, "xMidYMid slice")


def runner_head():
    """A running drop: rounder below, drawn out to a point above."""
    body = (
        "<path d='M20 2C25 16 37 26 37 38C37 48 29 54 20 54C11 54 3 48 3 38C3 26 15 16 20 2Z' fill='url(#d)'/>"
        "<ellipse cx='21' cy='44' rx='10' ry='7' fill='url(#w)'/>"
        "<path d='M5 40A15 15 0 0 0 35 40' fill='none' stroke='#05061a' stroke-opacity='.4' stroke-width='2.4'/>"
        "<ellipse cx='14' cy='30' rx='3.6' ry='6.5' fill='#fff' fill-opacity='.85' transform='rotate(14 14 30)'/>"
    )
    return svg(40, 56, body, DROP_DEFS, "xMidYMid meet")


def runner_rules(first, count):
    r = random.Random(77)
    rules = []
    for i in range(count):
        x = 5 + (i + r.uniform(0.1, 0.9)) * 90 / count
        y = r.uniform(4, 52)
        dy = (100 - y) + r.uniform(2, 10)
        s = r.uniform(1.5, 2.6)
        dur = r.uniform(22, 44)
        rules.append(
            f".aur-root[data-fx=\"rain\"] .aur-fx-e > i:nth-child({first + i}) {{ --x: {x:.1f}%; --y: {y:.1f}vh; --dy: {dy:.1f}vh; --s: {s:.2f}vmin; "
            f"--dur: {dur:.1f}s; --delay: {-r.uniform(0, dur):.1f}s; --hv: aur-rn-head-{i % 3 + 1}; --tv: aur-rn-trail-{i % 3 + 1}; }}"
        )
    return "\n".join(rules)


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
        out.append(f"@keyframes aur-rn-head-{v} {{\n" + "\n".join(head) + "\n}")
        out.append(f"@keyframes aur-rn-trail-{v} {{\n" + "\n".join(trl) + "\n}")
    return "\n".join(out)


# =============================================================================== the lightning bolt
def bolt():
    r = random.Random(9)
    pts = [(120.0, 0.0)]
    x, y = 120.0, 0.0
    while y < 380:
        y += r.uniform(22, 46)
        x += r.uniform(-34, 34)
        pts.append((x, y))
    branch = [pts[4]]
    bx, by = pts[4]
    for _ in range(4):
        by += r.uniform(20, 36)
        bx += r.uniform(10, 34)
        branch.append((bx, by))
    d = "M" + "L".join(f"{n(px)} {n(py)}" for px, py in pts)
    d2 = "M" + "L".join(f"{n(px)} {n(py)}" for px, py in branch)
    defs = "<filter id='g' x='-50%' y='-10%' width='200%' height='120%'><feGaussianBlur stdDeviation='7'/></filter>"
    body = (
        f"<g fill='none' stroke-linecap='round' stroke-linejoin='round'>"
        f"<g filter='url(#g)' stroke='#b9a8ff' stroke-width='14' opacity='.8'><path d='{d}'/><path d='{d2}'/></g>"
        f"<g stroke='#fff' stroke-width='3.2'><path d='{d}'/></g><g stroke='#fff' stroke-width='1.8'><path d='{d2}'/></g></g>"
    )
    return svg(240, 400, body, defs, "xMidYMin meet")


# =============================================================================== inside: the things on the sill
def books_candle():
    """A stack of three books with a candle on top (the flame is a picture of its own, same frame)."""
    defs = (
        "<linearGradient id='c' x1='0' x2='1'><stop offset='0' stop-color='#fff4dc'/><stop offset='.55' stop-color='#f0dfbc'/><stop offset='1' stop-color='#c9ae80'/></linearGradient>"
        "<linearGradient id='s' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#fff' stop-opacity='.18'/><stop offset='1' stop-color='#000' stop-opacity='.25'/></linearGradient>"
    )
    books = ["<ellipse cx='110' cy='255' rx='104' ry='6' fill='#000' fill-opacity='.35'/>"]
    for (x0, x1, y0, y1, col, band) in ((16, 204, 212, 254, "#7a3540", "#d4ad5a"), (28, 196, 178, 212, "#2c6467", "#e2c27a"), (42, 182, 150, 178, "#c4913b", "#5a3a1c")):
        books.append(f"<rect x='{x0}' y='{y0}' width='{x1 - x0}' height='{y1 - y0}' rx='5' fill='{col}'/>")
        books.append(f"<rect x='{x0}' y='{y0}' width='{x1 - x0}' height='{y1 - y0}' rx='5' fill='url(#s)'/>")
        books.append(rect(x0 + 12, y0 + 4, 4, y1 - y0 - 8, band) + rect(x1 - 16, y0 + 4, 4, y1 - y0 - 8, band))
        books.append(f"<rect x='{(x0 + x1) / 2 - 30}' y='{y0 + (y1 - y0) / 2 - 5}' width='60' height='10' rx='2' fill='{band}' fill-opacity='.85'/>")
        books.append(f"<rect x='{x0 + 3}' y='{y0}' width='{x1 - x0 - 6}' height='2' fill='#fff' fill-opacity='.25'/>")
    candle = (
        "<rect x='90' y='70' width='40' height='80' rx='4' fill='url(#c)'/>"
        "<ellipse cx='110' cy='71' rx='20' ry='5' fill='#fff8ea'/>"
        "<path d='M93 72C93 84 97 86 97 94C97 100 101 100 101 94L101 76Z' fill='#fff1d6'/>"
        "<path d='M120 73C121 80 124 82 124 88C124 92 127 92 127 88L127 74Z' fill='#fff1d6'/>"
        "<path d='M110 70V58' stroke='#2b1c12' stroke-width='2.4' stroke-linecap='round'/>"
    )
    return svg(220, 260, "".join(books) + candle, defs, "xMidYMax meet")


def flame():
    defs = (
        "<radialGradient id='f' cx='.5' cy='.7' r='.6'><stop offset='0' stop-color='#fff'/><stop offset='.35' stop-color='#ffe9a8'/><stop offset='.75' stop-color='#ff9a3c' stop-opacity='.9'/><stop offset='1' stop-color='#ff6a2a' stop-opacity='0'/></radialGradient>"
        "<radialGradient id='h'><stop offset='0' stop-color='#ffc070' stop-opacity='.55'/><stop offset='.45' stop-color='#ff9a4a' stop-opacity='.18'/><stop offset='1' stop-color='#ff9a4a' stop-opacity='0'/></radialGradient>"
    )
    body = "<circle cx='110' cy='44' r='46' fill='url(#h)'/><path d='M110 14C121 30 126 44 119 55C115 61 105 61 101 55C94 44 99 30 110 14Z' fill='url(#f)'/><ellipse cx='110' cy='54' rx='4' ry='6' fill='#6a9cff' fill-opacity='.55'/>"
    return svg(220, 260, body, defs, "xMidYMax meet")


def mug():
    defs = (
        "<linearGradient id='m' x1='0' x2='1'><stop offset='0' stop-color='#f6ead6'/><stop offset='.45' stop-color='#e7d3b4'/><stop offset='1' stop-color='#b49a76'/></linearGradient>"
        "<linearGradient id='b' x1='0' x2='1'><stop offset='0' stop-color='#3f6f93'/><stop offset='1' stop-color='#2a4b66'/></linearGradient>"
    )
    body = (
        "<ellipse cx='74' cy='216' rx='50' ry='6' fill='#000' fill-opacity='.3'/>"
        "<path d='M114 150C146 148 148 196 112 198' fill='none' stroke='#c7ad86' stroke-width='10' stroke-linecap='round'/>"
        "<path d='M30 128H118L112 206Q111 216 101 216H47Q37 216 36 206Z' fill='url(#m)'/>"
        "<path d='M33 160H115L114 176H34Z' fill='url(#b)'/>"
        "<rect x='42' y='134' width='5' height='70' rx='2.5' fill='#fff' fill-opacity='.5'/>"
        "<ellipse cx='74' cy='128' rx='44' ry='8' fill='#f9f0e2'/>"
        "<ellipse cx='74' cy='129.5' rx='37' ry='5.5' fill='#6a3e22'/>"
        "<ellipse cx='66' cy='128.5' rx='12' ry='1.6' fill='#fff' fill-opacity='.25'/>"
    )
    return svg(160, 220, body, defs, "xMidYMax meet")


def steam(variant):
    xs = (0, 16)[variant]
    d = (f"M{70 + xs} 120C{54 + xs} 100 {88 + xs} 86 {70 + xs} 66C{56 + xs} 50 {84 + xs} 38 {72 + xs} 18", f"M{70 + xs} 122C{90 + xs} 104 {58 + xs} 88 {76 + xs} 70C{92 + xs} 54 {62 + xs} 40 {74 + xs} 22")[variant]
    defs = f"<linearGradient id='s' gradientUnits='userSpaceOnUse' x1='0' y1='124' x2='0' y2='14'>{stops([(0, '#fff', 0.0), (0.25, '#fff', 0.55), (1, '#fff', 0)])}</linearGradient>"
    return svg(160, 220, f"<path d='{d}' fill='none' stroke='url(#s)' stroke-width='7' stroke-linecap='round'/>", defs, "xMidYMax meet")


def plant():
    r = random.Random(3)
    defs = "<linearGradient id='p' x1='0' x2='1'><stop offset='0' stop-color='#d9845a'/><stop offset='.6' stop-color='#b65f3c'/><stop offset='1' stop-color='#8c4428'/></linearGradient>"
    leaves = []
    stems = []

    def leaf(bx, by, size, ang, col):
        a = math.radians(ang)
        ca, sa = math.cos(a), math.sin(a)

        def p(u, v):  # leaf space: the base at 0,0, the tip at 0,-1
            return bx + (u * ca - v * sa) * size, by + (u * sa + v * ca) * size

        pts = [p(0, 0), p(-0.62, -0.18), p(-0.58, -0.82), p(0, -1.02), p(0.58, -0.82), p(0.62, -0.18)]
        d = (
            f"M{n(pts[0][0])} {n(pts[0][1])}C{n(pts[1][0])} {n(pts[1][1])} {n(pts[2][0])} {n(pts[2][1])} {n(pts[3][0])} {n(pts[3][1])}"
            f"C{n(pts[4][0])} {n(pts[4][1])} {n(pts[5][0])} {n(pts[5][1])} {n(pts[0][0])} {n(pts[0][1])}Z"
        )
        m0, m1 = p(0, -0.05), p(0, -0.9)
        leaves.append(f"<path d='{d}' fill='{col}' stroke='#b9f2c4' stroke-opacity='.35' stroke-width='1.4'/>")
        leaves.append(f"<path d='M{n(m0[0])} {n(m0[1])}L{n(m1[0])} {n(m1[1])}' stroke='#c9f5cf' stroke-opacity='.4' stroke-width='1.6' stroke-linecap='round'/>")

    greens = ("#4c9a5a", "#3b8049", "#63b16b", "#2f6a3c", "#58a862")
    spec = [(-58, 150, 46, -42), (-30, 104, 50, -18), (6, 86, 54, 4), (40, 112, 48, 26), (66, 150, 44, 48), (-20, 170, 36, -60), (30, 176, 34, 70), (-74, 196, 30, -80), (86, 210, 30, 96)]
    for i, (dx, dy, size, ang) in enumerate(spec):
        bx, by = 130 + dx, 50 + dy + 40
        stems.append(f"<path d='M130 262Q{n(130 + dx * 0.4)} {n(by + 40)} {n(bx)} {n(by)}' fill='none' stroke='#3c6b3e' stroke-width='3.2' stroke-linecap='round'/>")
        leaf(bx, by, size, ang, greens[i % len(greens)])
    vine = "<path d='M168 258C196 262 204 292 212 330' fill='none' stroke='#3c6b3e' stroke-width='2.6' stroke-linecap='round'/>"
    for (x, y, s, a) in ((186, 270, 18, 120), (202, 296, 16, 150), (210, 322, 14, 170)):
        leaf(x, y, s, a, greens[r.randrange(len(greens))])
    pot = (
        "<ellipse cx='130' cy='334' rx='56' ry='6' fill='#000' fill-opacity='.3'/>"
        "<path d='M88 266H172L162 334H98Z' fill='url(#p)'/>"
        "<rect x='80' y='252' width='100' height='18' rx='5' fill='#de8a5f'/>"
        "<rect x='80' y='252' width='100' height='3' rx='1.5' fill='#fff' fill-opacity='.3'/>"
        "<ellipse cx='130' cy='256' rx='46' ry='5' fill='#3a2417'/>"
    )
    return svg(260, 340, "".join(stems) + vine + pot + "".join(leaves), defs, "xMidYMax meet")


CAT = "M120 292C58 292 46 236 58 196C68 162 90 146 112 146L98 140C80 130 76 112 80 98L80 52L104 76C114 72 126 72 136 76L160 52L160 98C164 112 160 130 142 140L128 146C150 146 172 162 182 196C194 236 182 292 120 292Z"


def cat():
    body = (
        "<ellipse cx='122' cy='294' rx='70' ry='6' fill='#000' fill-opacity='.35'/>"
        f"<path d='{CAT}' fill='#aebcff' transform='translate(0 -3)'/>"
        f"<path d='{CAT}' fill='#ffb27a' fill-opacity='.85' transform='translate(-3 1)'/>"
        f"<path d='{CAT}' fill='#16172c'/>"
    )
    return svg(240, 300, body, "", "xMidYMax meet")


def cat_tail():
    d = "M172 282C216 288 230 252 214 226C206 212 208 198 218 190"
    body = (
        f"<path d='{d}' fill='none' stroke='#aebcff' stroke-width='16' stroke-linecap='round' transform='translate(0 -2.5)'/>"
        f"<path d='{d}' fill='none' stroke='#16172c' stroke-width='16' stroke-linecap='round'/>"
    )
    return svg(240, 300, body, "", "xMidYMax meet")


# =============================================================================== fairy lights along the top of the window
def fairy_lights():
    r = random.Random(8)
    hooks = [-20, 380, 800, 1220, 1620]
    wire, bulbs, glow = [], [], []
    cols = ("#ffd38a", "#ffb36b", "#ffe7b3", "#ffc58a")
    k = 0
    for a, b in zip(hooks, hooks[1:]):
        sag = r.uniform(46, 62)
        mx = (a + b) / 2
        wire.append(f"M{a} 26Q{n(mx)} {n(26 + sag * 2)} {b} 26")
        for t in [i / 9 for i in range(1, 9)]:
            x = (1 - t) ** 2 * a + 2 * (1 - t) * t * mx + t * t * b
            y = (1 - t) ** 2 * 26 + 2 * (1 - t) * t * (26 + sag * 2) + t * t * 26
            c = cols[k % len(cols)]
            k += 1
            bulbs.append(f"<rect x='{n(x - 2.4)}' y='{n(y)}' width='4.8' height='5' rx='1' fill='#2a2a33'/><ellipse cx='{n(x)}' cy='{n(y + 11)}' rx='5' ry='7' fill='{c}'/><ellipse cx='{n(x - 1.5)}' cy='{n(y + 9)}' rx='1.6' ry='2.6' fill='#fff' fill-opacity='.8'/>")
            glow.append((x, y + 11))
    lights = svg(W, 160, f"<path d='{''.join(wire)}' fill='none' stroke='#1b1b24' stroke-width='2.2'/>{''.join(bulbs)}", "", "xMidYMin slice")
    gdefs = "<radialGradient id='g'><stop offset='0' stop-color='#ffcf8a' stop-opacity='.75'/><stop offset='.3' stop-color='#ffb36b' stop-opacity='.28'/><stop offset='1' stop-color='#ffb36b' stop-opacity='0'/></radialGradient>"
    glows = svg(W, 160, "".join(f"<circle cx='{n(x)}' cy='{n(y)}' r='34' fill='url(#g)'/>" for x, y in glow), gdefs, "xMidYMin slice")
    return lights, glows


# =============================================================================== the rules
def build():
    city, signs, twinkle, nsigns, ntw = city_art()
    lights, glows = fairy_lights()
    values = {
        "RN_CITY": city,
        "RN_SIGNS": signs,
        "RN_TWINKLE": twinkle,
        "RN_CLOUDS_FAR": clouds(6, 8, "#6a5aa8", "#3a3480", "#c96a8c", 0.9, 220, 420, 46, 86, 150, 300),
        "RN_CLOUDS_NEAR": clouds(12, 6, "#4d4590", "#2a2766", "#d0708a", 0.95, 360, 620, 70, 120, 220, 400),
        "RN_RAIN_FAR": streak_tile(19, 80, 0.32, 30, 70, 0.8, 1.3, 600),
        "RN_RAIN_NEAR": streak_tile(7, 34, 0.5, 90, 190, 1.2, 2.2, 900),
        "RN_DROPS": glass_drops(),
        "RN_HEAD": runner_head(),
        "RN_RUNNERS": runner_rules(4, 8),
        "RN_RUNNER_FRAMES": runner_frames(),
        "RN_BOLT": bolt(),
        "RN_BOOKS": books_candle(),
        "RN_FLAME": flame(),
        "RN_MUG": mug(),
        "RN_STEAM_A": steam(0),
        "RN_STEAM_B": steam(1),
        "RN_PLANT": plant(),
        "RN_CAT": cat(),
        "RN_TAIL": cat_tail(),
        "RN_LIGHTS": lights,
        "RN_GLOWS": glows,
    }
    return values, dict(signs=nsigns, twinkle=ntw)


def main():
    values, info = build()
    tpl = open(os.path.join(D, "rain.tpl.css"), encoding="utf-8").read()
    for k, v in values.items():
        tpl = tpl.replace("{{" + k + "}}", v)
    assert "{{" not in tpl, "unfilled placeholder"
    out = os.path.join(D, "..", "..", "src", "themes", "rain.css")
    open(out, "w", encoding="utf-8", newline="\n").write(tpl)
    print("rain.css", len(tpl), "bytes;", info, {k: len(v) for k, v in values.items() if len(v) > 4000})


if __name__ == "__main__":
    main()
