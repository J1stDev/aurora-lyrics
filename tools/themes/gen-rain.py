"""Rain theme: artwork and generated rules, written into src/themes/rain.css from rain.tpl.css.

Usage: python tools/themes/gen-rain.py  (then node build.mjs)   [needs numpy]

Rain is a night street in the rain, seen from a high window. The street is a real one-point perspective
scene (a camera, a wide avenue, rows of buildings with lit windows, lamps, traffic lights, wet road)
that is drawn twice from the same model:

  * sharp, as vector art: the street as you would see it through a clean pane;
  * fogged, as a small soft picture: the same street through condensation, every light a bokeh disc.

The stylesheet lays the fogged picture over the sharp one and cuts a hole in it where the line being
sung is, so the line sits in a patch of glass that has just been wiped. Water beads and running drops
sit on the fog (the beads are drawn here with the colours of the street refracted in them), rain falls in
three depths, cars drive along the avenue (CSS scales a pair of lights about the vanishing point, which
is exactly how a car in perspective moves), and lightning now and then lights the clouds.

The art is seeded, so every build is identical."""
import math
import os
import random

import numpy as np

from artlib import blur_disc, blur_gauss, n, png_uri, stops, svg, to_u8, uri

D = os.path.dirname(os.path.abspath(__file__))

W, H = 1600, 900  # the picture, in design units
CX, HY, F = 800.0, 500.0, 900.0  # vanishing point x, horizon y, focal length
HC = 8.0  # the eye is this far above the road
ROAD, WALK, FACE = 13.0, 17.0, 17.0  # half widths: road, sidewalk, and the wall of the buildings
K = 0.24  # the fogged picture's scale: 384 x 216
SC = K / 0.3  # sizes below were chosen at 0.3


def proj(x, y, z):
    """World (x right, y up from the eye, z away) to picture coordinates."""
    return CX + F * x / z, HY - F * y / z


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def fog_at(z):
    return 1 - math.exp(-z / 260.0)


def rgb(c):
    return f"rgb({int(c[0])},{int(c[1])},{int(c[2])})"


def seg(q):
    """A polygon as a short path segment: absolute start, then steps. A small, upright one is a plain rectangle."""
    xs, ys = [p[0] for p in q], [p[1] for p in q]
    if max(ys) - min(ys) < 3.5:
        x0, y0 = min(xs), min(ys)
        return f"M{n(x0)} {n(y0)}h{n(max(xs) - x0)}v{n(max(ys) - y0)}h{n(x0 - max(xs))}z"
    out = [f"M{n(q[0][0])} {n(q[0][1])}"]
    for (ax, ay), (bx, by) in zip(q, q[1:]):
        out.append(f"l{n(bx - ax)} {n(by - ay)}")
    return "".join(out) + "z"


# =============================================================================== the model, drawn twice
class Dual:
    """Draws the same things into an SVG (sharp) and into float pictures (fogged).

    `st`: what is solid (sky, buildings), painted in order; `lit`: windows, added up; `bok`: big lights
    (lamps, signs, reflections), added up and later blurred into discs. All at scale K."""

    def __init__(self):
        self.svg = []
        self.defs = []
        h, w = int(H * K), int(W * K)
        self.st = np.zeros((h, w, 3))
        self.lit = np.zeros((h, w, 3))
        self.bok = np.zeros((h, w, 3))
        self.gid = 0
        self.cache = {}
        yy, xx = np.mgrid[0:h, 0:w]
        self.xx, self.yy = xx + 0.5, yy + 0.5

    def _gid(self):
        self.gid += 1
        return f"g{self.gid}"

    # ---- solids
    def _mask(self, pts):
        """(slices, mask) of a convex polygon at scale K."""
        p = [(x * K, y * K) for x, y in pts]
        x0, x1 = int(max(0, min(q[0] for q in p) - 1)), int(min(self.st.shape[1], max(q[0] for q in p) + 2))
        y0, y1 = int(max(0, min(q[1] for q in p) - 1)), int(min(self.st.shape[0], max(q[1] for q in p) + 2))
        if x1 <= x0 or y1 <= y0:
            return None
        X, Y = self.xx[y0:y1, x0:x1], self.yy[y0:y1, x0:x1]
        inside = np.ones(X.shape, bool)
        area = sum(p[i][0] * p[(i + 1) % len(p)][1] - p[(i + 1) % len(p)][0] * p[i][1] for i in range(len(p)))
        sign = 1 if area > 0 else -1
        for i in range(len(p)):
            ax, ay = p[i]
            bx, by = p[(i + 1) % len(p)]
            inside &= sign * ((bx - ax) * (Y - ay) - (by - ay) * (X - ax)) >= -0.35
        return (slice(y0, y1), slice(x0, x1)), inside

    def quad(self, pts, col, a=1.0):
        self.svg.append(f"<path d='M{'L'.join(f'{n(x)} {n(y)}' for x, y in pts)}Z' fill='{rgb(col)}'" + (f" fill-opacity='{n(a, 2)}'" if a < 1 else "") + "/>")
        m = self._mask(pts)
        if m is None:
            return
        sl, inside = m
        mm = inside[..., None] * a
        self.st[sl] = self.st[sl] * (1 - mm) + np.array(col) / 255.0 * mm

    def batch(self, quads, col, a=1.0):
        """Many polygons of one colour as a single path (and painted into the picture one by one)."""
        if not quads:
            return
        self.svg.append(f"<path d='{''.join(seg(q) for q in quads)}' fill='{rgb(col)}'" + (f" fill-opacity='{n(a, 2)}'" if a < 1 else "") + "/>")
        for q in quads:
            m = self._mask(q)
            if m is None:
                continue
            sl, inside = m
            mm = inside[..., None] * a
            self.st[sl] = self.st[sl] * (1 - mm) + np.array(col) / 255.0 * mm

    def rect_grad(self, x0, y0, x1, y1, top, bottom, a=1.0):
        """A vertical gradient fill over a rectangle (sky, glows)."""
        g = self._gid()
        self.defs.append(f"<linearGradient id='{g}' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='{rgb(top)}'/><stop offset='1' stop-color='{rgb(bottom)}'/></linearGradient>")
        self.svg.append(f"<rect x='{n(x0)}' y='{n(y0)}' width='{n(x1 - x0)}' height='{n(y1 - y0)}' fill='url(#{g})'" + (f" fill-opacity='{n(a, 2)}'" if a < 1 else "") + "/>")
        a0, a1 = int(y0 * K), int(min(y1 * K, self.st.shape[0]))
        b0, b1 = int(x0 * K), int(min(x1 * K, self.st.shape[1]))
        t = np.linspace(0, 1, max(1, a1 - a0))[:, None, None]
        col = (np.array(top) * (1 - t) + np.array(bottom) * t) / 255.0
        self.st[a0:a1, b0:b1] = self.st[a0:a1, b0:b1] * (1 - a) + col * a

    # ---- lights
    def glow(self, x, y, r, col, a=1.0, sx=1.0, sy=1.0):
        """A soft pool of light in the sharp picture only (the fogged picture gets its own energy from `lamp`)."""
        key = ("glow", tuple(int(c) // 8 * 8 for c in col), round(a * 10))
        g = self.cache.get(key)
        if g is None:
            g = self.cache[key] = self._gid()
            a = round(a * 10) / 10
            self.defs.append(f"<radialGradient id='{g}'><stop offset='0' stop-color='{rgb(col)}' stop-opacity='{n(a, 2)}'/><stop offset='.45' stop-color='{rgb(col)}' stop-opacity='{n(a * 0.34, 2)}'/><stop offset='1' stop-color='{rgb(col)}' stop-opacity='0'/></radialGradient>")
        self.svg.append(f"<ellipse cx='{n(x)}' cy='{n(y)}' rx='{n(r * sx)}' ry='{n(r * sy)}' fill='url(#{g})'/>")

    def splat(self, buf, x, y, col, energy):
        i, j = int(y * K), int(x * K)
        if 0 <= i < buf.shape[0] and 0 <= j < buf.shape[1]:
            buf[i, j] += np.array(col) / 255.0 * energy

    def lamp(self, x, y, r, col, power=1.0, halo=2.4):
        """A bright light with a halo: a disc and a glow in the sharp picture, an energy splat for the bokeh."""
        self.glow(x, y, r * halo, col, 0.55 * min(1, power))
        self.svg.append(f"<circle cx='{n(x)}' cy='{n(y)}' r='{n(max(r, 0.8), 2)}' fill='{rgb(mix(col, (255, 255, 255), 0.55))}'/>")
        self.splat(self.bok, x, y, col, min(power * (r * K) ** 2 * 3.2 + 0.05 * power, 3.2))

    def window(self, quad, col, a):
        """A lit window: its light goes into the small-lights picture (a big one as an area, a small one as a point)."""
        w = max(q[0] for q in quad) - min(q[0] for q in quad)
        h = max(q[1] for q in quad) - min(q[1] for q in quad)
        if w * K >= 2.5 and h * K >= 2.5:
            m = self._mask(quad)
            if m is not None:
                sl, inside = m
                self.lit[sl] += inside[..., None] * np.array(col) / 255.0 * a * 0.34
            return
        cx = sum(q[0] for q in quad) / 4
        cy = sum(q[1] for q in quad) / 4
        self.splat(self.lit, cx, cy, col, w * h * K * K * a * 0.34)

    def streak(self, x, y0, y1, w, col, a):
        """A reflection in the wet road: a soft smear, brightest where the light stands and fading away downwards."""
        key = ("streak", tuple(int(c) // 8 * 8 for c in col), round(a * 20))
        g = self.cache.get(key)
        if g is None:
            g = self.cache[key] = self._gid()
            a = round(a * 20) / 20
            self.defs.append(f"<radialGradient id='{g}' cx='.5' cy='0' r='1' fx='.5' fy='0'><stop offset='0' stop-color='{rgb(col)}' stop-opacity='{n(a, 2)}'/><stop offset='.5' stop-color='{rgb(col)}' stop-opacity='{n(a * 0.34, 2)}'/><stop offset='1' stop-color='{rgb(col)}' stop-opacity='0'/></radialGradient>")
        self.svg.append(f"<ellipse cx='{n(x)}' cy='{n(y0 + (y1 - y0) / 2)}' rx='{n(w * 0.8, 1)}' ry='{n((y1 - y0) / 2)}' fill='url(#{g})'/>")
        steps = max(2, int((y1 - y0) * K / 1.2))
        for s in range(steps):
            t = s / steps
            self.splat(self.bok, x, y0 + (y1 - y0) * t, col, a * (1 - t) ** 1.6 * w * K * 0.5 * (y1 - y0) * K / steps * 0.5)


# =============================================================================== the street
SKY_TOP, SKY_MID, SKY_LOW = (3, 5, 13), (11, 17, 36), (52, 40, 66)
HAZE = (66, 52, 82)
WINDOWS = [((255, 197, 122), 0.5), ((255, 226, 168), 0.16), ((166, 204, 255), 0.15), ((255, 128, 190), 0.05), ((142, 255, 196), 0.05), ((255, 150, 88), 0.04), ((120, 190, 255), 0.05)]
SIGNS = [(255, 90, 150), (90, 220, 255), (255, 200, 90), (120, 255, 190), (255, 110, 70), (170, 130, 255)]


def pick_window(r):
    t = r.random()
    for c, w in WINDOWS:
        t -= w
        if t <= 0:
            return c
    return WINDOWS[0][0]


def build_street(seed=11):
    r = random.Random(seed)
    d = Dual()
    neon = []  # [(picture quad, glow radius)] the sign boards the album's colours go into
    yb = -HC

    def board(q, sc, fg, size, strength, shop=False):
        """A lit sign. Some are the album's colours (drawn dark here, lit by the stylesheet); the rest keep a colour of their own."""
        cx, cy = sum(p[0] for p in q) / len(q), sum(p[1] for p in q) / len(q)
        wq = max(p[0] for p in q) - min(p[0] for p in q)
        hq = max(p[1] for p in q) - min(p[1] for p in q)
        if len(neon) < 11 and fg < 0.55 and r.random() < 0.5:
            d.quad(q, (13, 15, 30), 0.96)
            neon.append((q, max(wq, hq, 12)))
            return
        d.quad(q, mix(sc, (10, 10, 20), 0.35 * fg), 0.92 - 0.4 * fg)
        d.glow(cx, cy, max(wq, 14) * size, sc, strength * (1 - fg))
        d.splat(d.bok, cx, cy, sc, min(wq * hq * K * K * 0.5 + 0.2, 2.2))

    # ---- the sky, and the glow of the city at the end of the avenue
    d.rect_grad(0, 0, W, HY + 40, SKY_TOP, SKY_LOW)
    d.rect_grad(0, 0, W, 330, SKY_TOP, SKY_MID, 0.55)
    g = d._gid()
    d.defs.append(f"<radialGradient id='{g}' cx='.5' cy='.5' r='.5'><stop offset='0' stop-color='rgb(255,152,92)' stop-opacity='.62'/><stop offset='.4' stop-color='rgb(226,104,98)' stop-opacity='.26'/><stop offset='1' stop-color='rgb(150,70,120)' stop-opacity='0'/></radialGradient>")
    d.svg.append(f"<ellipse cx='{CX}' cy='{HY - 20}' rx='520' ry='250' fill='url(#{g})'/>")
    yy, xx = d.yy / K, d.xx / K
    glow = np.exp(-(((xx - CX) / 520) ** 2 + ((yy - (HY - 20)) / 250) ** 2) * 2.2)
    d.st += glow[..., None] * np.array([255, 152, 92]) / 255.0 * 0.5
    for _ in range(10):  # low clouds, lit from below by the city
        cx, cy = r.uniform(-100, W + 100), r.uniform(60, 420)
        rx, ry = r.uniform(200, 460), r.uniform(18, 46)
        lit = 0.1 + 0.2 * max(0, (cy - 120) / 300)
        col = mix((24, 24, 48), (128, 78, 90), min(1, lit * 3))
        g = d._gid()
        d.defs.append(f"<radialGradient id='{g}'><stop offset='0' stop-color='{rgb(col)}' stop-opacity='.5'/><stop offset='1' stop-color='{rgb(col)}' stop-opacity='0'/></radialGradient>")
        d.svg.append(f"<ellipse cx='{n(cx)}' cy='{n(cy)}' rx='{n(rx)}' ry='{n(ry)}' fill='url(#{g})'/>")
        cloud = np.exp(-(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2) * 2.0)
        d.st += cloud[..., None] * np.array(col) / 255.0 * 0.45

    # ---- the far end: towers on the horizon
    far_windows = {}
    for i in range(54):
        x = r.uniform(-95, 95)
        z = r.uniform(420, 540)
        hgt = r.uniform(10, 74) * (1.2 - abs(x) / 150)
        X0, Y0 = proj(x - 3.5, yb, z)
        X1, Y1 = proj(x + 3.5, hgt + yb, z)
        d.quad([(X0, Y1), (X1, Y1), (X1, Y0 + 2), (X0, Y0 + 2)], mix((26, 28, 50), HAZE, 0.62))
        for _ in range(int(hgt / 5)):
            wx, wy = r.uniform(x - 3, x + 3), r.uniform(yb + 1, hgt + yb - 1)
            X, Y = proj(wx, wy, z)
            if r.random() < 0.55:
                c = pick_window(r)
                far_windows.setdefault(c, []).append(f"M{n(X)} {n(Y)}h1.6v2h-1.6z")
                d.splat(d.lit, X, Y, c, 0.3)
    for c, segs in far_windows.items():
        d.svg.append(f"<path d='{''.join(segs)}' fill='{rgb(c)}' fill-opacity='.55'/>")
    for x, z, hgt in ((-22, 470, 64), (31, 500, 70), (6, 440, 56)):  # aircraft beacons on the tallest
        X, Y = proj(x, hgt + yb + 1, z)
        d.lamp(X, Y, 1.7, (255, 64, 54), 1.2, 4)

    # ---- the ground
    Y_far = HY + F * HC / 600
    d.quad([proj(-WALK, yb, 560), proj(WALK, yb, 560), (W + 600, H + 200), (-600, H + 200)], (16, 17, 31))
    d.rect_grad(0, Y_far, W, H, (62, 46, 72), (10, 12, 24), 0.8)
    for sx in (-1, 1):
        d.quad([proj(sx * ROAD, yb, 560), proj(sx * WALK, yb, 560), proj(sx * WALK, yb, 17), proj(sx * ROAD, yb, 17)], (26, 26, 42))
    for z0_, z1_ in ((26, 60), (60, 110), (110, 190), (190, 320), (320, 520)):
        qs = []
        for z in np.arange(z0_, z1_, 13.0):
            for lx in (-4.4, 0.0, 4.4):
                qs.append([proj(lx - 0.18, yb, z), proj(lx + 0.18, yb, z), proj(lx + 0.18, yb, z + 5), proj(lx - 0.18, yb, z + 5)])
        d.batch(qs, mix((92, 92, 120), (46, 42, 70), fog_at((z0_ + z1_) / 2)), 0.5)

    # ---- the buildings, far to near on both sides; a cross street at z 96 to 110
    rows = {}
    for sx in (-1, 1):
        z = 15.0 if sx < 0 else 17.0
        row = []
        while z < 440:
            L = r.uniform(14, 30) * (1 + z / 420)
            if z < 110 and z + L > 96:
                z = 110.0
                continue
            gap = r.choice((0, 0, 0, 0, 3.5))
            hgt = r.uniform(26, 50) * (1 + 0.25 * r.random()) + (r.uniform(30, 64) if r.random() < 0.14 else 0)
            row.append((z, z + L, hgt))
            z += L + gap
        rows[sx] = row
    allb = [(z0, z1, hgt, sx) for sx, row in rows.items() for z0, z1, hgt in row]
    allb.sort(key=lambda b: -b[0])
    for z0, z1, hgt, sx in allb:
        zc = (z0 + z1) / 2
        fg = fog_at(zc)
        tone = r.random()
        base = mix((12, 14, 30), (26, 20, 38), tone) if r.random() < 0.7 else mix((10, 18, 32), (16, 28, 44), tone)
        face = mix(base, HAZE, fg * 0.9)
        shade = mix(face, (5, 6, 14), 0.4)
        depth = r.uniform(20, 40)
        xa, xb = sx * FACE, sx * (FACE + depth)
        tiers = [(xa, yb, hgt + yb)]
        if hgt > 44:  # a setback: the tower steps back from the avenue
            h1 = hgt * r.uniform(0.45, 0.65)
            tiers = [(xa, yb, yb + h1), (sx * (FACE + 4.2), yb + h1 - 0.1, hgt + yb)]
        for xw, y0, y1 in tiers:
            d.quad([proj(xw, y0, z0), proj(xb, y0, z0), proj(xb, y1, z0), proj(xw, y1, z0)], shade)
            d.quad([proj(xw, y0, z0), proj(xw, y0, z1), proj(xw, y1, z1), proj(xw, y1, z0)], face)
            if r.random() < 0.6:  # a ledge on every few floors
                d.batch([[proj(xw, ly, z0), proj(xw, ly, z1), proj(xw, ly + 0.45, z1), proj(xw, ly + 0.45, z0)] for ly in np.arange(y0 + 10, y1, 9.2)], mix(face, (140, 120, 150), 0.18))
            d.quad([proj(xw, y1 - 0.5, z0), proj(xw, y1 - 0.5, z1), proj(xw, y1, z1), proj(xw, y1, z0)], mix(face, (170, 120, 120), 0.2))  # the sky's glow along the parapet
            # windows on the wall
            cols_n = max(2, int((z1 - z0) / 3.0))
            rows_n = int((y1 - y0 - 5.6) / 3.7)
            buckets = {}
            for ci in range(cols_n):
                zz = z0 + (ci + 0.5) * (z1 - z0) / cols_n
                for ri in range(rows_n):
                    if r.random() > 0.38:
                        continue
                    yy0 = y0 + 5.6 + ri * 3.7
                    q = [proj(xw, yy0, zz - 0.7), proj(xw, yy0, zz + 0.7), proj(xw, yy0 + 2.0, zz + 0.7), proj(xw, yy0 + 2.0, zz - 0.7)]
                    if abs(q[0][1] - q[3][1]) < 1.2 and r.random() < 0.45:
                        continue
                    c = pick_window(r)
                    a = (0.95 - 0.55 * fg) * r.uniform(0.6, 1.0)
                    if zc < 150 or r.random() < (0.55 if zc < 260 else 0.3):  # a far window is a speck: draw only some in the sharp picture (all of them light the fog)
                        buckets.setdefault((c, round(a, 1)), []).append(q)
                    d.window(q, c, a)
            for (c, a), qs in buckets.items():
                d.svg.append(f"<path d='{''.join(seg(q) for q in qs)}' fill='{rgb(c)}' fill-opacity='{n(a, 1)}'/>")
            # windows on the front (toward us)
            fb = {}
            for ci in range(3):
                for ri in range(max(0, int((y1 - y0 - 5.6) / 3.7))):
                    if r.random() > 0.3:
                        continue
                    xx0 = xw + sx * (3 + ci * 7)
                    yy0 = y0 + 5.6 + ri * 3.7
                    q = [proj(xx0, yy0, z0), proj(xx0 + sx * 1.5, yy0, z0), proj(xx0 + sx * 1.5, yy0 + 2.0, z0), proj(xx0, yy0 + 2.0, z0)]
                    c = pick_window(r)
                    a = (0.8 - 0.5 * fg) * r.uniform(0.6, 1.0)
                    fb.setdefault((c, round(a, 1)), []).append(q)
                    d.window(q, c, a)
            for (c, a), qs in fb.items():
                d.svg.append(f"<path d='{''.join(seg(q) for q in qs)}' fill='{rgb(c)}' fill-opacity='{n(a, 1)}'/>")
        # a big lit board on some of the nearer towers
        if 30 < zc < 150 and hgt > 40 and r.random() < 0.55:
            zs0, zs1 = z0 + 2, min(z1 - 2, z0 + 11)
            by0 = yb + hgt * r.uniform(0.38, 0.55)
            qb = [proj(xa, by0, zs0), proj(xa, by0, zs1), proj(xa, by0 + 6.5, zs1), proj(xa, by0 + 6.5, zs0)]
            d.quad([proj(xa, by0 - 0.3, zs0 - 0.3), proj(xa, by0 - 0.3, zs1 + 0.3), proj(xa, by0 + 6.8, zs1 + 0.3), proj(xa, by0 + 6.8, zs0 - 0.3)], (6, 7, 16))
            board(qb, r.choice(SIGNS), fg, 1.3, 0.38, False)
        # shops at street level: a long lit window and a sign over it
        if 50 < z0 < 280 and r.random() < 0.85:
            zs0, zs1 = z0 + 1.2, z1 - 1.2
            c = r.choice(((255, 204, 132), (255, 182, 112), (214, 232, 255), (255, 226, 168), (255, 160, 120)))
            q = [proj(xa, yb + 0.4, zs0), proj(xa, yb + 0.4, zs1), proj(xa, yb + 3.9, zs1), proj(xa, yb + 3.9, zs0)]
            a = (0.85 - 0.5 * fg) * (0.45 if z0 < 46 else 1.0)
            d.quad(q, c, a)
            d.window(q, c, a)
            qs = [proj(xa, yb + 4.3, zs0 + 1), proj(xa, yb + 4.3, zs1 - 1), proj(xa, yb + 5.4, zs1 - 1), proj(xa, yb + 5.4, zs0 + 1)]
            board(qs, r.choice(SIGNS), fg, 1.2, 0.5, True)
            wq = abs(qs[1][0] - qs[0][0])
            gx, gy = (q[0][0] + q[1][0]) / 2, proj(sx * (FACE - 2), yb, zs0)[1]
            if 24 < zc < 190:
                d.streak(gx - sx * 4, gy, min(H + 10, gy + 150), wq * 0.7 + 4, c, 0.3 * (1 - fg))
        # a blade sign sticking out over the sidewalk
        if 24 < zc < 220 and r.random() < 0.5:
            zs = z0 + r.uniform(2, max(2.5, z1 - z0 - 2))
            xs0, xs1 = sx * (FACE - 0.4), sx * (FACE - 3.2)
            ys0 = yb + r.uniform(5.5, 9)
            qs = [proj(xs0, ys0, zs), proj(xs1, ys0, zs), proj(xs1, ys0 + 5.2, zs), proj(xs0, ys0 + 5.2, zs)]
            board(qs, r.choice(SIGNS), fg, 2.2, 0.42, False)

    # ---- parked cars along the kerb, dark, with the lamps on their roofs
    for sx in (-1, 1):
        z = 24.0 + r.uniform(0, 8)
        while z < 230:
            if 92 < z < 112:
                z = 112
            xc = sx * (ROAD - 1.9)
            body = (12, 13, 26)
            d.quad([proj(xc - 1.8, yb, z), proj(xc + 1.8, yb, z), proj(xc + 1.7, yb + 2.2, z), proj(xc - 1.7, yb + 2.2, z)], body)
            d.quad([proj(xc - 1.5, yb + 2.2, z), proj(xc + 1.5, yb + 2.2, z), proj(xc + 1.3, yb + 3.0, z), proj(xc - 1.3, yb + 3.0, z)], body)
            d.quad([proj(xc - 1.3, yb + 3.0, z), proj(xc + 1.3, yb + 3.0, z), proj(xc + 1.3, yb + 3.12, z), proj(xc - 1.3, yb + 3.12, z)], (120, 100, 130), 0.5)
            for lx in (-1.35, 1.35):
                X, Y = proj(xc + lx, yb + 1.3, z)
                if r.random() < 0.75:
                    d.lamp(X, Y, max(0.9, 0.22 * F / z), (255, 40, 36), 0.9 * (1 - fog_at(z)), 3.8)
            z += r.uniform(9, 22)

    # ---- lamps and traffic lights, each with its mark in the wet road
    for sx in (-1, 1):
        for k in range(18):
            z = 30 + k * (13 + k * 0.9)
            if z > 360:
                break
            X, Y = proj(sx * (ROAD + 0.8), 1.0, z)
            Xg, Yg = proj(sx * (ROAD + 0.8), yb, z)
            fg = fog_at(z)
            col = (255, 190, 112)
            d.svg.append(f"<path d='M{n(Xg - 0.45 * F / z)} {n(Yg)}L{n(Xg + 0.45 * F / z)} {n(Yg)}L{n(X + 0.2 * F / z)} {n(Y)}L{n(X - 0.2 * F / z)} {n(Y)}Z' fill='{rgb(mix((8, 9, 20), HAZE, fg))}'/>")
            d.lamp(X - sx * 0.7 * F / z, Y, max(1.1, 0.5 * F / z), col, 1.6 * (1 - 0.5 * fg), 5.5)
            d.streak(X - sx * 0.7 * F / z, Yg + 1, min(H + 20, Yg + (Yg - Y) * 1.05), max(3.5, 1.4 * F / z), col, 0.42 * (1 - 0.5 * fg))
    for z, x, col in ((38, -5.5, (255, 54, 48)), (38, 5.5, (255, 54, 48)), (86, -5.5, (60, 255, 140)), (86, 5.5, (60, 255, 140)), (150, -5.5, (255, 190, 60)), (150, 5.5, (255, 190, 60)), (240, 0, (255, 54, 48))):
        X, Y = proj(x, 3.4, z)
        Xg, Yg = proj(x, yb, z)
        d.lamp(X, Y, max(1.3, 0.45 * F / z), col, 1.8, 4.6)
        d.streak(X, Yg + 1, min(H + 20, Yg + (Yg - Y) * 1.0), max(4, 1.6 * F / z), col, 0.4)
    return d, neon


def finish_fog(d):
    """The street as it looks through condensation: a soft picture (480 x 270)."""
    st = blur_gauss(d.st, 2.0 * SC)
    lit = blur_gauss(d.lit, 1.8 * SC)
    bok = blur_disc(d.bok, 6.5 * SC)
    img = st + lit * 2.4 + bok * 4.2
    # condensation: a milky veil, thicker towards the bottom of the glass, thinner in patches
    h, w = img.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    rng = np.random.default_rng(3)
    patches = blur_gauss(rng.random((h, w, 1)), 12 * SC)
    patches = (patches - patches.min()) / (patches.max() - patches.min() + 1e-6)
    veil = 0.07 + 0.09 * (yy / h)[..., None] + 0.05 * patches
    img = img * (1 - veil) + np.array([0.46, 0.54, 0.7]) * veil * 0.55
    img = img * (0.85 + 0.15 * np.clip((1 - np.hypot((xx / w - 0.5) * 1.1, (yy / h - 0.5) * 1.3)), 0, 1)[..., None])
    return 1.0 - np.exp(-img * 1.2)  # a soft shoulder: the brightest lights stay discs of colour, not white clip


def finish_mid(d):
    """The street as a drop of water sees it: softer than the sharp picture, much sharper than the fog."""
    return np.clip(blur_gauss(d.st, 0.9 * SC) + blur_gauss(d.lit, 0.8 * SC) * 2.4 + blur_disc(d.bok, 2.2 * SC) * 4.2, 0, 2.0)


# =============================================================================== the neon boards (the album's colours)
def neon_masks(neon):
    """Two masks of the boards that take the album's colours: sharp (the boards and their glow) and fogged (soft discs)."""
    defs = (
        "<radialGradient id='o'><stop offset='0' stop-color='#fff' stop-opacity='.95'/><stop offset='.5' stop-color='#fff' stop-opacity='.3'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></radialGradient>"
        "<radialGradient id='b'><stop offset='0' stop-color='#fff' stop-opacity='.85'/><stop offset='.72' stop-color='#fff' stop-opacity='.7'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></radialGradient>"
    )
    sharp, fog = [], []
    for q, size in neon:
        cx, cy = sum(p[0] for p in q) / len(q), sum(p[1] for p in q) / len(q)
        sharp.append(f"<ellipse cx='{n(cx)}' cy='{n(cy)}' rx='{n(size * 1.5)}' ry='{n(size * 1.1)}' fill='url(#o)'/>")
        sharp.append(f"<path d='{seg(q)}' fill='#fff' fill-opacity='.92'/>")
        fog.append(f"<circle cx='{n(cx)}' cy='{n(cy)}' r='{n(max(26, size * 0.9))}' fill='url(#b)'/>")
    return svg(W, H, "".join(sharp), defs, "xMidYMax slice"), svg(W, H, "".join(fog), defs, "xMidYMax slice")


# =============================================================================== water on the glass
DS = 0.8  # the scale of the picture of drops


def bilinear(img, x, y):
    h, w = img.shape[:2]
    x = np.clip(x - 0.5, 0, w - 1.001)
    y = np.clip(y - 0.5, 0, h - 1.001)
    x0, y0 = x.astype(int), y.astype(int)
    fx, fy = (x - x0)[..., None], (y - y0)[..., None]
    return img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x0 + 1] * fx * (1 - fy) + img[y0 + 1, x0] * (1 - fx) * fy + img[y0 + 1, x0 + 1] * fx * fy


def smooth(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def bead(canvas, mid, cx, cy, rx, ry, big=True, scale=DS, alpha=0.96):
    """One drop: a lens that shows the street upside down (the part of the picture `mid` it can see), dark at its lower rim,
    bright at its upper rim, with a spot of light on it. Composited, premultiplied, into `canvas` (h, w, 4)."""
    h, w = canvas.shape[:2]
    x0, x1 = int(max(0, math.floor((cx - rx - 1.5) * scale))), int(min(w, math.ceil((cx + rx + 1.5) * scale)))
    y0, y1 = int(max(0, math.floor((cy - ry - 1.5) * scale))), int(min(h, math.ceil((cy + ry + 1.5) * scale)))
    if x1 <= x0 or y1 <= y0:
        return
    X = (np.arange(x0, x1) + 0.5) / scale
    Y = (np.arange(y0, y1) + 0.5) / scale
    X, Y = np.meshgrid(X, Y)
    px, py = (X - cx) / rx, (Y - cy) / ry
    rho2 = px * px + py * py
    rho = np.sqrt(rho2)
    edge = np.clip((1.0 - rho) / (0.16 if big else 0.4), 0, 1)
    if edge.max() <= 0:
        return
    s1, s2 = 330.0, 250.0
    k = 0.45 + 0.55 * rho2
    col = bilinear(mid, (cx - px * s1 * k) * K, (cy - py * s2 * k) * K) * 1.15 + 0.012
    nx, ny = px / (rho + 1e-6), py / (rho + 1e-6)
    ring = smooth(0.6, 0.97, rho)
    col = col * (1 - ring * (0.3 + 0.5 * np.clip(ny, 0, 1)))[..., None]
    col = col + (ring * np.clip(-0.55 * nx - 0.75 * ny, 0, 1) * 0.42)[..., None]
    caustic = smooth(0.3, 0.85, rho) * np.clip(0.55 * nx + 0.8 * ny, 0, 1)
    col = col + caustic[..., None] * (0.18 + 0.5 * col.mean(axis=2, keepdims=True))
    spec = np.exp(-(((px + 0.38) / 0.2) ** 2 + ((py + 0.46) / 0.13) ** 2))
    col = col + spec[..., None] * 0.95
    a = (edge * alpha)[..., None]
    sl = (slice(y0, y1), slice(x0, x1))
    c = np.clip(col, 0, 1)
    canvas[sl][..., :3] = c * a + canvas[sl][..., :3] * (1 - a)
    canvas[sl][..., 3:] = a + canvas[sl][..., 3:] * (1 - a)


def trail(canvas, cx, cy, ry, length, width, strength=0.2):
    """The clear track a drop leaves as it slides: a thin faint line above it."""
    h, w = canvas.shape[:2]
    x0, x1 = int(max(0, (cx - width * 3) * DS)), int(min(w, (cx + width * 3) * DS))
    y0, y1 = int(max(0, (cy - ry - length) * DS)), int(min(h, (cy - ry * 0.4) * DS))
    if x1 <= x0 or y1 <= y0:
        return
    X = (np.arange(x0, x1) + 0.5) / DS
    Y = (np.arange(y0, y1) + 0.5) / DS
    X, Y = np.meshgrid(X, Y)
    across = np.exp(-(((X - cx) / width) ** 2))
    along = smooth(cy - ry - length, cy - ry, Y)
    a = (across * along * strength)[..., None]
    sl = (slice(y0, y1), slice(x0, x1))
    canvas[sl][..., :3] = np.array([0.74, 0.82, 0.93]) * a + canvas[sl][..., :3] * (1 - a)
    canvas[sl][..., 3:] = a + canvas[sl][..., 3:] * (1 - a)


def quantise(img, bits=5, abits=4):
    """Fewer levels per channel: the same picture, but zlib can squeeze it much further."""
    out = img.copy()
    q = 2 ** bits - 1
    out[..., :3] = np.round(out[..., :3] * q) / q
    qa = 2 ** abits - 1
    out[..., 3] = np.round(out[..., 3] * qa) / qa
    return out


def render_drops(mid, seed=21):
    """The beads of water on the glass, as a transparent picture (premultiplied while drawing)."""
    rng = np.random.default_rng(seed)
    h, w = int(H * DS), int(W * DS)
    cv = np.zeros((h, w, 4), np.float32)
    centres = rng.uniform([100, 200], [W - 100, H - 50], (7, 2))

    def where(n_):
        out = []
        for i in range(n_):
            if rng.random() < 0.5:
                x, y = rng.uniform(0, W), H * rng.beta(1.25, 1.0)
            else:
                c = centres[rng.integers(len(centres))]
                x, y = c[0] + rng.normal(0, 110), c[1] + rng.normal(0, 90)
            out.append((float(np.clip(x, 0, W)), float(np.clip(y, 0, H))))
        return out

    # the mist: very fine beads over everything
    for x, y in where(1500):
        r_ = rng.uniform(0.7, 1.45)
        bead(cv, mid, x, y, r_, r_ * rng.uniform(1.0, 1.2), False, alpha=0.5)
    # small, medium and large beads
    for n_, lo, hi, big in ((150, 1.9, 4.0, False), (52, 4.2, 8.5, True), (13, 9.0, 16.0, True)):
        for x, y in where(n_):
            rx = rng.uniform(lo, hi)
            ry = rx * rng.uniform(1.0, 1.22)
            if big and rng.random() < 0.45:
                trail(cv, x, y, ry, rng.uniform(30, 150) * (rx / 8) ** 0.4, rng.uniform(1.0, 1.9))
            bead(cv, mid, x, y, rx, ry, big)
    a = cv[..., 3:4]
    rgb_ = np.where(a > 1e-4, cv[..., :3] / np.maximum(a, 1e-4), 0)
    return np.concatenate([rgb_, a], axis=2)


def head_sprite(mid, seed, w=48, h=64):
    """A running drop's head, a little taller than wide, as a picture of its own."""
    cv = np.zeros((h, w, 4), np.float32)
    s = 1.0
    bead_scale = DS
    # draw at scale 1 into a small canvas: bead() works in design units times `scale`, so use scale 1 and the sprite's own size
    bead(cv, mid, w / 2, h * 0.5, w * 0.42, h * 0.43, True, 1.0, 0.97)
    a = cv[..., 3:4]
    rgb_ = np.where(a > 1e-4, cv[..., :3] / np.maximum(a, 1e-4), 0)
    return np.concatenate([rgb_, a], axis=2)


# =============================================================================== rain, cars, ripples
def streak_tile(seed, count, alpha, lmin, lmax, wmin, wmax, tile, slant=0.12, colour="#c4d8f4"):
    """A tile of rain streaks that joins up at the edges, grouped by look so the data stays short."""
    r = random.Random(seed)
    groups = {}
    for _ in range(count):
        x, y = r.uniform(0, tile), r.uniform(0, tile)
        ln = r.uniform(lmin, lmax)
        w = round(r.uniform(wmin, wmax), 1)
        o = round(r.uniform(0.35, 1) * alpha, 2)
        dx = -ln * slant
        for ox in (0, -tile, tile):
            for oy in (0, -tile, tile):
                xa, ya = x + ox, y + oy
                if max(xa, xa + dx) < -6 or min(xa, xa + dx) > tile + 6 or ya + ln < -6 or ya > tile + 6:
                    continue
                groups.setdefault((w, o), []).append(f"M{n(xa)} {n(ya)}l{n(dx)} {n(ln)}")
    body = "".join(f"<path d='{''.join(v)}' stroke-width='{k[0]}' stroke-opacity='{k[1]}'/>" for k, v in groups.items())
    return svg(tile, tile, f"<g stroke='{colour}' stroke-linecap='round' fill='none'>{body}</g>", "", "none")


def ripple_tile(seed, count):
    """Rings spreading in the puddles of the road: in the picture's lower part."""
    r = random.Random(seed)
    out = []
    for _ in range(count):
        t = r.random() ** 0.8
        y = 560 + t * 330
        x = r.uniform(120, W - 120) if r.random() < 0.3 else CX + r.gauss(0, 330 + 230 * t)
        k = 0.4 + 1.9 * t
        rx = r.uniform(7, 24) * k
        out.append(f"<ellipse cx='{n(x)}' cy='{n(y)}' rx='{n(rx)}' ry='{n(rx * 0.26)}' stroke-opacity='{n(0.1 + 0.3 * (1 - t) + 0.12, 2)}'/>")
        if r.random() < 0.6:
            out.append(f"<ellipse cx='{n(x)}' cy='{n(y)}' rx='{n(rx * 0.55)}' ry='{n(rx * 0.14)}' stroke-opacity='{n(0.1 + 0.3 * (1 - t) + 0.12, 2)}'/>")
    return svg(W, H, f"<g fill='none' stroke='#cfe0ff' stroke-width='1.1'>{''.join(out)}</g>", "", "xMidYMax slice")


APPROACH = [0, 0.2, 0.4, 0.6, 0.8, 0.9, 0.95, 0.98, 1.0]


def car_art(kind, lane):
    """A pair of lights on the road at z = 22 (the nearest the car comes), with their reflections in the wet road and, for a car
    coming toward us, the headlights' wash on the road. Returns (css image, left, top, width, height, origin x, origin y) in picture units."""
    yb = -HC
    z = 22.0
    xl, yl = proj(lane - 1.5, yb + 0.9, z)
    xr, yr = proj(lane + 1.5, yb + 0.9, z)
    head = kind == "approach"
    col = (255, 238, 196) if head else (255, 52, 46)
    halo, core = (34, 6.5) if head else (24, 5.0)
    L, R = xl - 70, xr + 70
    T, B = yl - 60, min(H, yl + 150)
    w, h = R - L, B - T
    defs = (
        f"<radialGradient id='h'><stop offset='0' stop-color='{rgb(col)}' stop-opacity='.85'/><stop offset='.35' stop-color='{rgb(col)}' stop-opacity='.32'/><stop offset='1' stop-color='{rgb(col)}' stop-opacity='0'/></radialGradient>"
        f"<radialGradient id='r' cx='.5' cy='0' r='1' fx='.5' fy='0'><stop offset='0' stop-color='{rgb(col)}' stop-opacity='.5'/><stop offset='.5' stop-color='{rgb(col)}' stop-opacity='.16'/><stop offset='1' stop-color='{rgb(col)}' stop-opacity='0'/></radialGradient>"
        f"<radialGradient id='w' cx='.5' cy='0' r='1' fx='.5' fy='0'><stop offset='0' stop-color='{rgb(col)}' stop-opacity='.22'/><stop offset='1' stop-color='{rgb(col)}' stop-opacity='0'/></radialGradient>"
    )
    body = []
    if head:
        body.append(f"<ellipse cx='{n((xl + xr) / 2 - L)}' cy='{n(yl + 20 - T)}' rx='{n((xr - xl) * 0.9)}' ry='{n(B - yl - 10)}' fill='url(#w)'/>")
    for x, y in ((xl, yl), (xr, yr)):
        body.append(f"<ellipse cx='{n(x - L)}' cy='{n(y + 8 - T + (B - y - 8) / 2)}' rx='{n(halo * 0.5)}' ry='{n((B - y - 8) / 2)}' fill='url(#r)'/>")
        body.append(f"<circle cx='{n(x - L)}' cy='{n(y - T)}' r='{n(halo)}' fill='url(#h)'/>")
        body.append(f"<circle cx='{n(x - L)}' cy='{n(y - T)}' r='{n(core)}' fill='{rgb(mix(col, (255, 255, 255), 0.7))}'/>")
    img = svg(round(w), round(h), "".join(body), defs, "none")
    return img, L, T, w, h, CX - L, HY - T


def car_frames():
    out = []
    zs = [300 - 278 * t for t in APPROACH]
    app = ["\t0% { transform: scale(0.073); opacity: 0; }", "\t4% { transform: scale(0.076); opacity: 1; }"]
    for t, z in zip(APPROACH[1:], zs[1:]):
        app.append(f"\t{n(t * 100)}% {{ transform: scale({n(22 / z, 3)}); opacity: {1 if t < 0.97 else (0.7 if t < 1 else 0)}; }}")
    out.append("@keyframes aur-rn-approach {\n" + "\n".join(app) + "\n}")
    rec = ["\t0% { transform: scale(1); opacity: 0; }", "\t3% { transform: scale(0.93); opacity: 1; }"]
    for t in APPROACH[1:]:
        z = 22 + 278 * t
        rec.append(f"\t{n(t * 100)}% {{ transform: scale({n(22 / z, 3)}); opacity: {n(max(0, 1 - max(0, t - 0.75) * 4), 2)}; }}")
    out.append("@keyframes aur-rn-recede {\n" + "\n".join(rec) + "\n}")
    return "\n".join(out)


# the cars: (kind, lane, seconds for the whole avenue, how far through it at the start)
CARS = [("approach", 2.6, 15, 0.1), ("approach", 6.6, 20, 0.6), ("approach", 2.6, 17, 0.8), ("approach", 6.6, 22, 0.25), ("recede", -2.6, 16, 0.3), ("recede", -6.6, 21, 0.7), ("recede", -2.6, 18, 0.05), ("recede", -6.6, 14, 0.5)]


def car_rules():
    rules = []
    for i, (kind, lane, dur, phase) in enumerate(CARS, start=1):
        img, L, T, w, h, ox, oy = car_art(kind, lane)
        rules.append(
            f".aur-root[data-fx=\"rain\"] .aur-fx-e > i:nth-child({i}) {{ left: calc({n(L)} * var(--u)); top: calc({n(T)} * var(--u)); width: calc({n(w)} * var(--u)); height: calc({n(h)} * var(--u)); "
            f"transform-origin: calc({n(ox)} * var(--u)) calc({n(oy)} * var(--u)); background: {img} 0 0 / 100% 100% no-repeat; "
            f"animation: aur-rn-{kind} {dur}s linear {-dur * phase:.1f}s infinite; }}"
        )
    return "\n".join(rules)


def runner_rules(count, first):
    """Where each running drop starts, how far it goes, how big, how fast (picture units: calc(n * var(--u)))."""
    r = random.Random(77)
    rules = []
    variant_of = (1, 2, 3, 2, 1, 3, 2, 1, 3, 1, 2, 3)
    for i in range(count):
        x = 4 + (i + r.uniform(0.1, 0.9)) * 92 / count
        y = r.uniform(30, 520)
        dy = (H - y) + r.uniform(30, 110)
        s = r.uniform(11, 20)
        dur = r.uniform(24, 48)
        delay = -r.uniform(0, dur)
        v = variant_of[i % len(variant_of)]
        rules.append(
            f".aur-root[data-fx=\"rain\"] .aur-fx-e > i:nth-child({first + i}) {{ --x: {x:.1f}%; --y: calc({y:.0f} * var(--u)); --dy: calc({dy:.0f} * var(--u)); --s: calc({s:.1f} * var(--u)); "
            f"--dur: {dur:.1f}s; --delay: {delay:.1f}s; --hv: aur-rn-head-{v}; --tv: aur-rn-trail-{v}; --sp: var(--head-{v}); }}"
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
            head.append(f"\t{t}% {{ translate: calc({wb} * var(--s)) calc(var(--dy) * {f});{extra}{op} }}")
            trl.append(f"\t{t}% {{ scale: 1 {f};{op} }}")
        last_t, last_f = steps[-1]
        head.append(f"\t{last_t + 6}% {{ translate: 0 var(--dy); opacity: 1; }}\n\t{last_t + 12}%, 100% {{ translate: 0 var(--dy); opacity: 0; }}")
        trl.append(f"\t{last_t + 6}% {{ scale: 1 1; opacity: 1; }}\n\t{last_t + 12}%, 100% {{ scale: 1 1; opacity: 0; }}")
        out.append(f"@keyframes aur-rn-head-{v} {{\n" + "\n".join(head) + "\n}")
        out.append(f"@keyframes aur-rn-trail-{v} {{\n" + "\n".join(trl) + "\n}")
    return "\n".join(out)


def mist_tiles():
    """Fine mist on the glass: tiny beads in three prime-sized tiles, so it never visibly repeats."""
    r = random.Random(61)
    layers, sizes = [], []
    for tile, count, rad, a in ((173, 9, 0.8, 0.5), (211, 8, 1.1, 0.42), (137, 6, 1.5, 0.36)):
        for _ in range(count):
            layers.append(f"radial-gradient({rad}px {rad}px at {r.randint(4, tile - 4)}px {r.randint(4, tile - 4)}px, rgba(214, 230, 255, {a}), transparent)")
            sizes.append(f"{tile}px {tile}px")
    return ",\n\t\t".join(layers), ", ".join(sizes)


# =============================================================================== the rules
def build():
    d, neon = build_street()
    fog = finish_fog(d)
    mid = finish_mid(d)
    sharp = svg(W, H, "".join(d.svg), "".join(d.defs), "xMidYMax slice")
    neon_sharp, neon_fog = neon_masks(neon)
    drops = render_drops(mid)
    mist, mist_sizes = mist_tiles()
    values = {
        "RN_SHARP": sharp,
        "RN_FOG": png_uri(to_u8(fog)),
        "RN_NEON_SHARP": neon_sharp,
        "RN_NEON_FOG": neon_fog,
        "RN_DROPS": png_uri(to_u8(quantise(drops))),
        "RN_MIST": mist,
        "RN_MIST_SIZES": mist_sizes,
        "RN_STREAKS_FAR": streak_tile(19, 70, 0.22, 36, 80, 0.8, 1.3, 640),
        "RN_STREAKS_MID": streak_tile(7, 46, 0.34, 70, 150, 1.0, 1.8, 800),
        "RN_STREAKS_NEAR": streak_tile(3, 26, 0.5, 120, 260, 1.4, 2.6, 1100),
        "RN_RIPPLES_A": ripple_tile(5, 34),
        "RN_RIPPLES_B": ripple_tile(6, 34),
        "RN_CARS": car_rules(),
        "RN_CAR_FRAMES": car_frames(),
        "RN_RUNNERS": runner_rules(12, len(CARS) + 1),
        "RN_RUNNER_FRAMES": runner_frames(),
        "RN_RUNNER_FIRST": str(len(CARS) + 1),
        "RN_RUNNER_LAST": str(len(CARS) + 12),
    }
    for v in (1, 2, 3):
        values[f"RN_HEAD_{v}"] = png_uri(to_u8(quantise(head_sprite(mid, v))))
    return values, dict(sharp=sharp, fog=values["RN_FOG"], drops=values["RN_DROPS"], neon=len(neon))


def main():
    values, info = build()
    tpl = open(os.path.join(D, "rain.tpl.css"), encoding="utf-8").read() if os.path.exists(os.path.join(D, "rain.tpl.css")) else ""
    if "{{RN_SHARP}}" in tpl:
        for k, v in values.items():
            tpl = tpl.replace("{{" + k + "}}", v)
        assert "{{" not in tpl, "unfilled placeholder"
        out = os.path.join(D, "..", "..", "src", "themes", "rain.css")
        open(out, "w", encoding="utf-8", newline="\n").write(tpl)
        print("rain.css", len(tpl), "bytes")
    html = (
        "<!doctype html><meta charset=utf-8><style>body{margin:0;background:#222;display:flex;flex-direction:column}"
        ".p{width:100vw;aspect-ratio:16/9;background-position:center;background-size:cover}"
        f".a{{background-image:{values['RN_SHARP']}}}.b{{background-image:{values['RN_FOG']}}}.c{{background-image:{values['RN_FOG']},{values['RN_DROPS']}}}"
        ".c{background-image:" + values["RN_DROPS"] + "," + values["RN_FOG"] + "}</style><div class='p a'></div><div class='p b'></div><div class='p c'></div>"
    )
    os.makedirs(os.path.join(D, "..", "..", "dev", "_art"), exist_ok=True)
    open(os.path.join(D, "..", "..", "dev", "_art", "rain.html"), "w", encoding="utf-8").write(html)
    print("sharp", len(info["sharp"]), "fog", len(info["fog"]), "drops", len(info["drops"]), "neon boards", info["neon"])
    print({k: len(v) for k, v in values.items()})


if __name__ == "__main__":
    main()
