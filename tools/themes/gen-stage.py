"""Karaoke and Neon theme ambience: artwork and generated rules (seeded, so every build is
identical) written into the two theme blocks of src/styles.css.

Usage: python tools/themes/gen-stage.py  (then node build.mjs)

Karaoke is a KTV stage: two laser fans, a disco ball, light spots drifting over the wall, a
mirror floor and two towers of equaliser bars either side of the cover. Neon is a brick wall lit
by three neon signs (their colours come from CSS, so they follow the album): the signs are masks,
one thick for the coloured tube and one thin for its hot core.

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


# =============================================================================== KARAOKE
def ktv_facets():
    """The disco ball's mirror tiles: two identical halves side by side, so it can scroll forever."""
    r = random.Random(14)
    half, rows, cols, cell = 320, 16, 16, 20
    shades = ["#2b3266", "#3a4380", "#4d579a", "#6a76b8", "#8d99d6", "#bcc6f4", "#eef1ff", "#ff9ad0", "#7fe6ff"]
    weights = [3, 4, 4, 3, 2, 1.2, 0.7, 0.5, 0.5]
    groups = {s: [] for s in shades}
    for i in range(cols):
        for j in range(rows):
            groups[r.choices(shades, weights)[0]].append((i, j))
    body = []
    for s, cells in groups.items():
        d = "".join(f"M{i * cell + 1} {j * cell + 1}h{cell - 2}v{cell - 2}h{-(cell - 2)}z" for i, j in cells)
        body.append(f"<path d='{d}' fill='{s}'/>")
    one = "".join(body)
    return svg(half * 2, half, f"<rect width='{half * 2}' height='{half}' fill='#070a22'/>{one}<g transform='translate({half} 0)'>{one}</g>", "", "none")


def star(cx, cy, s, fill, op):
    """A four-point sparkle: long thin points and a pinched waist."""
    k = s * 0.13
    return (
        f"<path d='M{cx:.1f} {cy - s:.1f}L{cx + k:.1f} {cy - k:.1f} {cx + s:.1f} {cy:.1f} {cx + k:.1f} {cy + k:.1f} {cx:.1f} {cy + s:.1f} {cx - k:.1f} {cy + k:.1f} {cx - s:.1f} {cy:.1f} {cx - k:.1f} {cy - k:.1f}Z' fill='{fill}' fill-opacity='{op}'/>"
    )


def ktv_flares():
    """Glints thrown off the ball: three arrangements side by side (each 200x200, centred on the
    ball); CSS shows them one after another."""
    r = random.Random(3)
    defs = "<radialGradient id='g'><stop offset='0' stop-color='#fff' stop-opacity='.9'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></radialGradient>"
    out = []
    for frame in range(3):
        n = 7 - frame
        for k in range(n):
            a = (k / n) * math.tau + r.uniform(-0.35, 0.35) + frame * 0.6
            rad = r.uniform(70, 97)
            x, y = 200 * frame + 100 + math.cos(a) * rad, 100 + math.sin(a) * rad
            s = r.uniform(9, 20)
            out.append(f"<circle cx='{x:.1f}' cy='{y:.1f}' r='{s * 0.9:.1f}' fill='url(#g)'/>")
            out.append(star(x, y, s * 1.6, r.choice(["#fff", "#ffd6ee", "#c9f6ff"]), r.uniform(0.7, 1)))
    return svg(600, 200, "".join(out), defs, "xMidYMid meet")


def ktv_spots():
    """Soft squares and dots of light, as the ball throws them across the wall (a 600x400 tile)."""
    r = random.Random(29)
    defs = (
        "<radialGradient id='w'><stop offset='0' stop-color='#fff' stop-opacity='.55'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></radialGradient>"
        "<radialGradient id='p'><stop offset='0' stop-color='#ff7cc0' stop-opacity='.5'/><stop offset='1' stop-color='#ff7cc0' stop-opacity='0'/></radialGradient>"
        "<radialGradient id='c'><stop offset='0' stop-color='#6fe3ff' stop-opacity='.5'/><stop offset='1' stop-color='#6fe3ff' stop-opacity='0'/></radialGradient>"
        "<radialGradient id='v'><stop offset='0' stop-color='#b48cff' stop-opacity='.5'/><stop offset='1' stop-color='#b48cff' stop-opacity='0'/></radialGradient>"
    )
    out = []
    for _ in range(22):
        x, y = r.uniform(0, 600), r.uniform(0, 400)
        rad = r.uniform(6, 15)
        g = r.choice("wwpcv")
        out.append(f"<circle cx='{x:.0f}' cy='{y:.0f}' r='{rad:.1f}' fill='url(#{g})'/>")
    return svg(600, 400, "".join(out), defs, "none")


def ktv_fan(center, n, step, c1, c2):
    """A fan of laser rays from one point (the top of the element): each is a bright core inside a
    faint halo. Angles are conic angles, 0 = up, 180 = down."""
    stops = ["transparent 0deg"]
    for i in range(n):
        a = center + (i - (n - 1) / 2) * step
        col = c1 if i % 2 == 0 else c2
        stops += [
            f"transparent {a - 2.6:.2f}deg",
            f"color-mix(in oklab, {col} 9%, transparent) {a - 0.7:.2f}deg",
            f"color-mix(in oklab, {col} 85%, transparent) {a - 0.14:.2f}deg",
            f"#fff {a:.2f}deg",
            f"color-mix(in oklab, {col} 85%, transparent) {a + 0.14:.2f}deg",
            f"color-mix(in oklab, {col} 9%, transparent) {a + 0.7:.2f}deg",
            f"transparent {a + 2.6:.2f}deg",
        ]
    stops.append("transparent 360deg")
    return "conic-gradient(from 0deg at 50% 0%,\n\t\t\t" + ",\n\t\t\t".join(stops) + ")"


def ktv_bars():
    """Twenty-four equaliser bars, twelve either side of the cover, counted outward from it. Each
    has its own height, tempo (a multiple of the beat) and phase."""
    r = random.Random(7)
    rules, variants = [], 4
    for side, first in ((-1, 0), (1, 12)):
        for k in range(12):
            # taller near the cover, like a level meter that peaks in the middle of the spectrum
            pk = max(0.34, 1 - k * 0.055 + r.uniform(-0.12, 0.08))
            m = r.choice((1, 1, 2, 2, 3, 4))
            delay = -r.uniform(0, 3)
            v = r.randrange(variants)
            rules.append(
                f".aur-root[data-fx=\"karaoke\"] .aur-fx-e > i:nth-child({first + k + 1}) "
                f"{{ --side: {side}; --k: {k}; --pk: {pk:.2f}; animation: aur-ktv-eq-{v} calc(var(--aur-beat, 0.5s) * {m}) ease-in-out {delay:.2f}s infinite; }}"
            )
    frames = []
    for v in range(variants):
        stops = [r.uniform(0.18, 1) for _ in range(8)]
        body = "\n".join(f"\t{int(i * 100 / 7)}% {{ scale: 1 calc(var(--pk) * {s:.2f}); }}" for i, s in enumerate(stops))
        frames.append(f"@keyframes aur-ktv-eq-{v} {{\n{body}\n}}")
    return "\n".join(rules), "\n".join(frames)


# =============================================================================== NEON
def neon_bricks():
    """A dark brick wall, running bond: warm greys with a lit top edge, a shaded bottom, mortar."""
    r = random.Random(5)
    W, H = 320, 192
    bw, bh, mortar = 64, 24, 3
    out = [f"<rect width='{W}' height='{H}' fill='#0b0910'/>"]
    base = [(30, 22, 30), (36, 26, 34), (26, 22, 32), (40, 27, 30), (32, 24, 36), (24, 20, 28)]
    for row in range(H // bh):
        off = (bw // 2) if row % 2 else 0
        for col in range(-1, W // bw + 1):
            x = col * bw + off - (bw if off else 0) + (bw if off else 0)
            x = col * bw + off
            y = row * bh
            c = r.choice(base)
            j = r.randint(-5, 5)
            fill = f"rgb({c[0] + j},{c[1] + j},{c[2] + j})"
            out.append(f"<rect x='{x + mortar / 2:.1f}' y='{y + mortar / 2:.1f}' width='{bw - mortar}' height='{bh - mortar}' rx='1.5' fill='{fill}'/>")
            # a lit top edge and a shaded bottom edge
            out.append(f"<rect x='{x + mortar / 2:.1f}' y='{y + mortar / 2:.1f}' width='{bw - mortar}' height='2' fill='#fff' fill-opacity='.07'/>")
            out.append(f"<rect x='{x + mortar / 2:.1f}' y='{y + bh - mortar / 2 - 3:.1f}' width='{bw - mortar}' height='3' fill='#000' fill-opacity='.28'/>")
            for _ in range(r.randint(0, 2)):  # chips and stains
                cx, cy = x + r.uniform(6, bw - 6), y + r.uniform(5, bh - 5)
                out.append(f"<ellipse cx='{cx:.0f}' cy='{cy:.0f}' rx='{r.uniform(2, 6):.1f}' ry='{r.uniform(1, 3):.1f}' fill='#000' fill-opacity='{r.uniform(.1, .3):.2f}'/>")
    return svg(W, H, "".join(out), "", "none")


def tube(paths, w):
    """Paths as a mask: opaque stroke of width w."""
    return svg(400, 400, f"<path d='{paths}' fill='none' stroke='#000' stroke-width='{w}' stroke-linecap='round' stroke-linejoin='round'/>", "", "xMidYMid meet")


def arc(cx, cy, r, a0, a1):
    """An arc from angle a0 to a1 degrees, clockwise (angles from the +x axis, y down)."""
    p0 = (cx + r * math.cos(math.radians(a0)), cy + r * math.sin(math.radians(a0)))
    p1 = (cx + r * math.cos(math.radians(a1)), cy + r * math.sin(math.radians(a1)))
    large = 1 if (a1 - a0) % 360 > 180 else 0
    return f"M{p0[0]:.1f} {p0[1]:.1f}A{r} {r} 0 {large} 1 {p1[0]:.1f} {p1[1]:.1f}"


RING = (
    arc(200, 200, 170, 236, 196 + 360)  # outer ring, open at the lower left
    + arc(200, 200, 132, 20, 330 + 0)  # inner ring, open at the upper right
    + "M200 178v44M178 200h44"  # a small cross in the middle
)
NOTE = (
    "M104 296a44 31 -20 1 0 1 0.1zM266 262a44 31 -20 1 0 1 0.1z"  # the two note heads
    "M146 284V112M308 250V78"  # stems
    "M146 112L308 78M146 156L308 122"  # the beam
)
BOLT = "M248 22L108 214H190L138 380L300 160H214Z"
STARS = (
    "M90 60V140M50 100H130M112 78L68 122M112 122L68 78"
    "M300 250V300M275 275H325"
)


VALUES = {}
VALUES["KTV_FACETS"] = ktv_facets()
VALUES["KTV_FLARES"] = ktv_flares()
VALUES["KTV_SPOTS"] = ktv_spots()
VALUES["KTV_FAN_L"] = ktv_fan(136, 7, 9.5, "var(--ktv-a)", "var(--ktv-b)")
VALUES["KTV_FAN_R"] = ktv_fan(224, 7, 9.5, "var(--ktv-b)", "var(--ktv-c)")
VALUES["KTV_BARS"], VALUES["KTV_BAR_FRAMES"] = ktv_bars()
VALUES["NEON_BRICKS"] = neon_bricks()
VALUES["NEON_RING_TUBE"], VALUES["NEON_RING_CORE"] = tube(RING, 15), tube(RING, 5)
VALUES["NEON_NOTE_TUBE"], VALUES["NEON_NOTE_CORE"] = tube(NOTE, 15), tube(NOTE, 5)
VALUES["NEON_BOLT_TUBE"], VALUES["NEON_BOLT_CORE"] = tube(BOLT, 15), tube(BOLT, 5)
VALUES["NEON_STARS_TUBE"], VALUES["NEON_STARS_CORE"] = tube(STARS, 13), tube(STARS, 4.5)

STYLES = os.path.join(D, "..", "..", "src", "styles.css")
css = open(STYLES, encoding="utf-8").read()


def splice(css, name, starts, end):
    """Replace a theme's block (from its opening comment, which may be the old or the new one,
    to the next theme's) with the filled-in template."""
    tpl = open(os.path.join(D, name + ".tpl.css"), encoding="utf-8").read()
    for k, v in VALUES.items():
        tpl = tpl.replace("{{" + k + "}}", v)
    assert "{{" not in tpl, name
    i = min(css.index(s) for s in starts if s in css)
    j = css.index(end, i)
    print(name, len(tpl))
    return css[:i] + tpl.rstrip() + "\n\n" + css[j:]


# The old beat-sync rules for these two themes (they target layers that no longer exist); the
# new ones live in the templates.
a, b = css.find("/* Neon: the wet floor pulses on the beat"), css.find("/* Retro: the scanlines blip on the beat")
if a != -1 and b != -1 and a < b:
    css = css[:a] + css[b:]

# each theme's block runs from its opening comment to the next theme's
css = splice(css, "neon", ["/* Neon: a neon sign", "/* Neon: a brick wall"], "/* Minimal: an editorial page")
css = splice(css, "karaoke", ["/* Karaoke: a karaoke system (KTV)", "/* Karaoke: a KTV stage"], "/* Gothic: candlelight")
open(STYLES, "w", encoding="utf-8", newline=chr(10)).write(css)
print("updated src/styles.css")
