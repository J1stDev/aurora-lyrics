"""Neon theme: artwork and generated rules, written into src/themes/neon.css from neon.tpl.css.

Usage: python tools/themes/gen-neon.py  (then node build.mjs)

Neon is the wall of a back-alley bar at night: dark brick, a wet floor, and a handful of glass-tube
signs: a ring with a bolt, an OPEN sign on two chains, a vertical LIVE sign, a cocktail with bubbles
rising in it, a pair of notes, and a tube framing the corner of the room. Each sign is three pictures
drawn here: the unlit glass tubes with their mounts and cables (always seen), a mask of the lit tube
and its glow, and a mask of its hot core. The two masks are filled with the album's colours by the
stylesheet, so the signs light up in whatever the cover is. CSS only moves them: flicker, the swing of
the chains, the bubbles, and the glow that breathes on every beat. The floor mirrors the signs.

The art is seeded, so every build is identical. Sign shapes are tubes bent from one piece: lines,
arcs and rounded corners, with the monoline letters drawn by `letter` below."""
import math
import os
import random

from artlib import n, stops, svg, uri

D = os.path.dirname(os.path.abspath(__file__))
PAD = 60  # room round every sign for its glow
MARTINI_BOX = "right: calc(3.1vmin + min(9.6vmin, 7.1vw)); top: 41%; width: min(14vmin, 10.4vw);"
NL, TAB = "\n", "\t"


# =============================================================================== lettering
def letter(ch, x, y, w, h):
    """One monoline capital as an SVG path, bent the way a glass-blower would: round bowls, square joins."""
    if ch == "O":
        r = w / 2
        return f"<path d='M{n(x + r)} {n(y)}H{n(x + w - r)}A{n(r)} {n(r)} 0 0 1 {n(x + w - r)} {n(y + h)}H{n(x + r)}A{n(r)} {n(r)} 0 0 1 {n(x + r)} {n(y)}Z'/>"
    if ch == "P":
        bh = h * 0.56
        r = bh / 2
        return f"<path d='M{n(x)} {n(y + h)}V{n(y)}H{n(x + w - r)}A{n(r)} {n(r)} 0 0 1 {n(x + w - r)} {n(y + bh)}H{n(x)}'/>"
    if ch == "E":
        return f"<path d='M{n(x + w)} {n(y)}H{n(x)}V{n(y + h)}H{n(x + w)}M{n(x)} {n(y + h / 2)}H{n(x + w * 0.78)}'/>"
    if ch == "N":
        return f"<path d='M{n(x)} {n(y + h)}V{n(y)}L{n(x + w)} {n(y + h)}V{n(y)}'/>"
    if ch == "L":
        return f"<path d='M{n(x)} {n(y)}V{n(y + h)}H{n(x + w)}'/>"
    if ch == "I":
        return f"<path d='M{n(x + w / 2)} {n(y)}V{n(y + h)}'/>"
    if ch == "V":
        return f"<path d='M{n(x)} {n(y)}L{n(x + w / 2)} {n(y + h)}L{n(x + w)} {n(y)}'/>"
    raise ValueError(ch)


def rrect(x, y, w, h, r):
    return f"<rect x='{n(x)}' y='{n(y)}' width='{n(w)}' height='{n(h)}' rx='{n(r)}'/>"


def arc(cx, cy, r, a0, a1):
    """An arc of a circle from angle a0 to a1 (degrees, clockwise from the right), as a path."""
    p0 = (cx + r * math.cos(math.radians(a0)), cy + r * math.sin(math.radians(a0)))
    p1 = (cx + r * math.cos(math.radians(a1)), cy + r * math.sin(math.radians(a1)))
    big = 1 if (a1 - a0) % 360 > 180 else 0
    return f"<path d='M{n(p0[0])} {n(p0[1])}A{n(r)} {n(r)} 0 {big} 1 {n(p1[0])} {n(p1[1])}'/>", p0, p1


def poly(points, closed=True):
    d = "M" + "L".join(f"{n(x)} {n(y)}" for x, y in points) + ("Z" if closed else "")
    return f"<path d='{d}'/>"


# =============================================================================== the three pictures of a sign
def sign_pictures(w, h, shapes, W, mounts=(), cables=(), extra_base=""):
    """(unlit glass, lit mask, core mask) of a sign. w, h: its picture; shapes: SVG elements without
    stroke attributes; W: the tube's thickness in the picture's units; mounts: [(x, y)] where standoffs hold the
    tube to the wall; cables: [(x, y, dx, dy)] supply cables that run off the picture, fading out."""
    s = "".join(shapes)
    region = f"x='0' y='0' width='{w}' height='{h}' filterUnits='userSpaceOnUse'"
    filters = (
        f"<filter id='a' {region}><feGaussianBlur stdDeviation='{n(W * 1.5)}'/></filter>"
        f"<filter id='b' {region}><feGaussianBlur stdDeviation='{n(W * 4.6)}'/></filter>"
        f"<filter id='c' {region}><feGaussianBlur stdDeviation='{n(W * 0.16, 2)}'/></filter>"
    )
    lit = svg(
        w, h,
        f"<g fill='none' stroke='#fff' stroke-linecap='round' stroke-linejoin='round'>"
        f"<g filter='url(#b)' stroke-width='{n(W * 3.4)}' opacity='.62'>{s}</g>"
        f"<g filter='url(#a)' stroke-width='{n(W * 1.9)}' opacity='.9'>{s}</g>"
        f"<g stroke-width='{n(W)}'>{s}</g></g>",
        filters,
    )
    core = svg(
        w, h,
        f"<g fill='none' stroke='#fff' stroke-linecap='round' stroke-linejoin='round' stroke-width='{n(W * 0.38, 2)}' filter='url(#c)'>{s}</g>",
        filters,
    )
    hardware = []
    for x, y in mounts:  # a standoff: a dark post with a bright rim where it holds the tube
        hardware.append(f"<circle cx='{n(x)}' cy='{n(y)}' r='{n(W * 0.78)}' fill='#0b0812'/><circle cx='{n(x)}' cy='{n(y)}' r='{n(W * 0.78)}' fill='none' stroke='#fff' stroke-opacity='.2' stroke-width='{n(W * 0.16, 2)}'/>")
    cab_defs = []
    for i, (x, y, dx, dy) in enumerate(cables):
        cab_defs.append(f"<linearGradient id='k{i}' gradientUnits='userSpaceOnUse' x1='{n(x)}' y1='{n(y)}' x2='{n(x + dx)}' y2='{n(y + dy)}'>{stops([(0, '#0a0710', 1), (0.7, '#0a0710', 0.9), (1, '#0a0710', 0)])}</linearGradient>")
        hardware.append(
            f"<path d='M{n(x)} {n(y)}q{n(dx * 0.1)} {n(dy * 0.55)} {n(dx)} {n(dy)}' fill='none' stroke='url(#k{i})' stroke-width='{n(W * 0.62)}' stroke-linecap='round'/>"
            f"<rect x='{n(x - W * 0.8)}' y='{n(y - W * 0.8)}' width='{n(W * 1.6)}' height='{n(W * 1.9)}' rx='{n(W * 0.3)}' fill='#120d1c' stroke='#fff' stroke-opacity='.14' stroke-width='{n(W * 0.12, 2)}'/>"
        )
    base = svg(
        w, h,
        f"<g fill='none' stroke-linecap='round' stroke-linejoin='round'>"
        f"<g stroke='#d4dbff' stroke-opacity='.15' stroke-width='{n(W * 1.55)}'>{s}</g>"
        f"<g stroke='#06030c' stroke-opacity='.7' stroke-width='{n(W * 0.55)}'>{s}</g>"
        f"<g transform='translate({n(-W * 0.3)} {n(-W * 0.3)})' stroke='#fff' stroke-opacity='.22' stroke-width='{n(W * 0.16, 2)}'>{s}</g></g>"
        + "".join(hardware)
        + extra_base,
        "".join(cab_defs),
    )
    return base, lit, core


# =============================================================================== the signs
def circle_mounts(cx, cy, r, count, start=0.0):
    return [(cx + r * math.cos(math.radians(start + i * 360 / count)), cy + r * math.sin(math.radians(start + i * 360 / count))) for i in range(count)]


def build_signs():
    signs = []

    def add(id, role, w, h, shapes, T, box_vmin, css, anim, delay=0.0, mounts=(), cables=(), extra_base=""):
        """T: the tube thickness in vmin; box_vmin: the picture's width in vmin (so the thickness is the same on any screen)."""
        W = T * w / box_vmin
        base, lit, core = sign_pictures(w, h, shapes, W, mounts, cables, extra_base)
        signs.append(dict(id=id, role=role, w=w, h=h, base=base, lit=lit, core=core, css=css, anim=anim, delay=delay))

    # ---- the ring and the bolt: a halo with lightning in it, at the top right
    S = 540
    cx = cy = S / 2
    rings = []
    mnt = []
    cab = []
    for r in (172, 140):
        shape, p0, p1 = arc(cx, cy, r, 284, 256 + 360)
        rings.append(shape)
        mnt += circle_mounts(cx, cy, r, 7, 310)
        cab += [(p0[0], p0[1], 8, -70), (p1[0], p1[1], -10, -70)]
    add("ring", "a", S, S, rings, 0.78, 62, "right: -8vmin; top: -13vmin; width: min(62vmin, 46vw);", "hum", 0.0, mnt, cab)
    k = 0.6
    bolt = [(262, 56), (172, 212), (226, 212), (160, 364), (298, 170), (240, 170), (306, 56)]
    bolt = [(cx + (x - 210) * k, cy + (y - 210) * k) for x, y in bolt]
    add("bolt", "b", S, S, [poly(bolt)], 0.78, 62, "right: -8vmin; top: -13vmin; width: min(62vmin, 46vw);", "flick", 1.3, [bolt[0], bolt[3], bolt[5]], [])

    # ---- OPEN, hanging by two chains from the top edge of the screen
    w, h = 640, 330
    fx, fy, fw, fh = 60, 112, 520, 168
    frame = [rrect(fx, fy, fw, fh, 46)]
    letters = [("O", 66), ("P", 62), ("E", 56), ("N", 68)]
    gap = 30
    total = sum(lw for _, lw in letters) + gap * (len(letters) - 1)
    x = fx + (fw - total) / 2
    lh = 86
    ly = fy + (fh - lh) / 2
    oen, p_only = [], []
    for ch, lw in letters:
        (p_only if ch == "P" else oen).append(letter(ch, x, ly, lw, lh))
        x += lw + gap
    chains = []
    for cxn in (170, 470):
        for j in range(8):
            yy = 6 + j * 13.2
            chains.append(f"<rect x='{n(cxn - 4.2)}' y='{n(yy)}' width='8.4' height='17' rx='4.2' fill='none' stroke='#9aa0b8' stroke-opacity='.55' stroke-width='2.2'/>")
    place = "left: calc(50% - min(18vmin, 13.3vw)); top: -3vmin; width: min(36vmin, 26.6vw); transform-origin: 50% 0; animation: aur-nn-swing 7.5s ease-in-out -2.2s infinite alternate;"
    add("open_frame", "c", w, h, frame, 0.6, 36, place, "hum", 0.7, [(fx + 70, fy), (fx + fw - 70, fy), (fx + 70, fy + fh), (fx + fw - 70, fy + fh)], [(fx + fw - 40, fy + fh, 0, 70)], "".join(chains))
    add("open_oen", "a", w, h, oen, 0.6, 36, place, "hum", 0.2)
    add("open_p", "a", w, h, p_only, 0.6, 36, place, "dead", 0.0)

    # ---- LIVE, a tall sign down the right edge
    w, h = 230, 640
    fx, fy, fw, fh = 60, 60, 110, 520
    lets = [("L", 52), ("I", 12), ("V", 62), ("E", 52)]
    lh = 66
    gap = 38
    tot = len(lets) * lh + gap * (len(lets) - 1)
    y = fy + (fh - tot) / 2
    ll = []
    for ch, lw in lets:
        ll.append(letter(ch, fx + (fw - lw) / 2, y, lw, lh))
        y += lh + gap
    place = "right: 1.6vmin; top: 33%; width: min(9.6vmin, 7.1vw);"
    add("live_frame", "c", w, h, [rrect(fx, fy, fw, fh, 42)], 0.5, 9.6, place, "flick", 2.1, [(fx, fy + 90), (fx + fw, fy + 90), (fx, fy + fh - 90), (fx + fw, fy + fh - 90)], [(fx + fw / 2, fy + fh, 0, 70)])
    add("live_letters", "b", w, h, ll, 0.5, 9.6, place, "hum", 1.0)

    # ---- the cocktail: glass, drink and olive in three colours
    w, h = 360, 480
    bowl = [poly([(70, 100), (290, 100), (180, 262)]), "<path d='M180 262V384M116 404H244'/>"]
    liquid = ["<path d='M104 152H256'/>"]
    olive = ["<circle cx='205' cy='133' r='15'/>", "<path d='M170 188L252 62'/>"]
    place = MARTINI_BOX
    add("martini_glass", "c", w, h, bowl, 0.5, 14, place, "hum", 0.4, [(70, 100), (290, 100), (180, 262), (180, 330)], [(180, 404, 0, 70)])
    add("martini_drink", "b", w, h, liquid, 0.5, 14, place, "hum", 0.9)
    add("martini_olive", "a", w, h, olive, 0.5, 14, place, "flick", 3.2)

    # ---- a pair of beamed notes at the top
    w, h = 400, 420
    notes = [
        "<ellipse cx='130' cy='338' rx='42' ry='29' transform='rotate(-24 130 338)'/>",
        "<ellipse cx='290' cy='298' rx='42' ry='29' transform='rotate(-24 290 298)'/>",
        "<path d='M168 326V122L328 82V286M168 168L328 128'/>",
    ]
    place = "left: 25%; top: -0.5vmin; width: min(11vmin, 8.1vw);"
    add("notes", "b", w, h, notes, 0.45, 11, place, "dead", 2.6, [(168, 122), (328, 82)], [(168, 122, -60, -90)])
    return signs


# =============================================================================== the brick wall
def brick_wall(seed=7):
    """A tile of brick: (colour picture, relief mask). The mask is bright on the faces of the bricks and dim in the joints,
    so coloured light laid over it lights the bricks, not the mortar."""
    r = random.Random(seed)
    TW, TH = 256, 192
    bw, bh, mortar = 64, 24, 3.5
    rows = TH // bh
    col, relief = [], []
    for j in range(rows):
        off = (bw / 2) if j % 2 else 0
        for i in range(-1, TW // bw + 1):
            x = i * bw + off
            y = j * bh
            tone = r.uniform(-1, 1)
            lum = 24 + tone * 6
            rr, gg, bb = lum * 1.05, lum * 0.92, lum * 1.25 + 4
            if r.random() < 0.08:
                rr, gg, bb = rr * 0.7, gg * 0.7, bb * 0.7
            fill = f"rgb({int(rr)},{int(gg)},{int(bb)})"
            bx, by, bww, bhh = x + mortar / 2, y + mortar / 2, bw - mortar, bh - mortar
            col.append(f"<rect x='{n(bx)}' y='{n(by)}' width='{n(bww)}' height='{n(bhh)}' rx='1.6' fill='{fill}'/>")
            col.append(f"<rect x='{n(bx)}' y='{n(by)}' width='{n(bww)}' height='1.3' fill='#fff' fill-opacity='.05'/>")
            col.append(f"<rect x='{n(bx)}' y='{n(by + bhh - 1.6)}' width='{n(bww)}' height='1.6' fill='#000' fill-opacity='.22'/>")
            a = 0.62 + 0.38 * (tone + 1) / 2
            relief.append(f"<rect x='{n(bx)}' y='{n(by)}' width='{n(bww)}' height='{n(bhh)}' rx='1.6' fill='#fff' fill-opacity='{n(a, 2)}'/>")
    grain = (
        "<filter id='g' x='0' y='0' width='100%' height='100%'><feTurbulence type='fractalNoise' baseFrequency='.62' numOctaves='2' seed='3' stitchTiles='stitch'/>"
        "<feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.3 .78'/></filter>"
        "<filter id='h' x='0' y='0' width='100%' height='100%'><feTurbulence type='fractalNoise' baseFrequency='.5' numOctaves='2' seed='9' stitchTiles='stitch'/>"
        "<feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .9 -.2'/></filter>"
    )
    colour = svg(TW, TH, f"<rect width='{TW}' height='{TH}' fill='#110c1b'/>{''.join(col)}<rect width='{TW}' height='{TH}' filter='url(#g)' opacity='.5'/>", grain, "none")
    mask = svg(TW, TH, f"<rect width='{TW}' height='{TH}' fill='#fff' fill-opacity='.14'/>{''.join(relief)}<rect width='{TW}' height='{TH}' filter='url(#h)' opacity='.35'/>", grain, "none")
    return colour, mask, TW / TH


def bubbles():
    """A tile of bubbles that rises and wraps: 14 x 9 vmin at ten units to the vmin."""
    r = random.Random(5)
    W, H = 140, 90
    out = []
    for _ in range(9):
        x, y, rad = r.uniform(12, W - 12), r.uniform(0, H), r.uniform(2.6, 6.4)
        for oy in (0, -H, H):
            out.append(f"<circle cx='{n(x)}' cy='{n(y + oy)}' r='{n(rad)}'/>")
    body = f"<g fill='#fff' fill-opacity='.18' stroke='#fff' stroke-width='1.6'>{''.join(out)}</g>"
    return svg(W, H, body, "", "none")


def eq_masks(seed=12, bars=49):
    """Three layers of a row of tubes standing on the floor line (every third tube belongs to a layer). Each layer is a mask; the
    stylesheet scales a layer up and down in tempo, and three layers with their own tempos make a dancing equaliser."""
    r = random.Random(seed)
    W_, H_ = 400, 100
    layers = [[] for _ in range(3)]
    for i in range(bars):
        x = 4 + i * 7.9
        h = r.uniform(34, 100)
        layers[i % 3].append((x, h))
    out = []
    for lay in layers:
        tubes = "".join(f"<rect x='{n(x - 2.2)}' y='{n(H_ - h)}' width='4.4' height='{n(h)}' rx='2.2'/>" for x, h in lay)
        defs = f"<filter id='b' x='0' y='0' width='{W_}' height='{H_}' filterUnits='userSpaceOnUse'><feGaussianBlur stdDeviation='3.4'/></filter>"
        out.append(svg(W_, H_, f"<g fill='#fff'><g filter='url(#b)' opacity='.7'>{tubes}</g>{tubes}</g>", defs, "none"))
    return out


# =============================================================================== the rules
ANIMS = {
    "hum": ("aur-nn-hum", 7.3),
    "flick": ("aur-nn-flick", 11.0),
    "dead": ("aur-nn-dead", 9.0),
}


def sign_rules(signs):
    rules, kids = [], []
    for i, s in enumerate(signs, start=1):
        sel = f".aur-root[data-fx=\"neon\"] .aur-fx-e > i:nth-child({i})"
        name, dur = ANIMS[s["anim"]]
        css = s["css"]
        rules.append(
            f"{sel} {{ {css} aspect-ratio: {s['w']} / {s['h']}; --c: var(--neon-{s['role']}); --flick: {name}; --dur: {dur}s; --dl: {-s['delay']:.1f}s; --sd: {0.18 * i:.2f}s; "
            f"background-image: {s['base']}; --lit: {s['lit']}; --core: {s['core']}; }}"
        )
    return "\n".join(rules)


def eq_rules(first):
    out = []
    r = random.Random(3)
    for k, mask in enumerate(eq_masks()):
        keys = NL.join(f"{TAB}{int(i * 100 / 5)}% {{ scale: 1 {r.uniform(0.28, 1):.2f}; }}" for i in range(6))
        out.append(
            f".aur-root[data-fx=\"neon\"] .aur-fx-e > i:nth-child({first + k}) {{ --m: {mask}; animation: aur-nn-eq-{k} calc(var(--aur-beat, 0.6s) * {(1, 2, 3)[k]}) ease-in-out {-r.uniform(0, 2):.2f}s infinite alternate; }}{NL}"
            f"@keyframes aur-nn-eq-{k} {{{NL}{keys}{NL}}}"
        )
    return NL.join(out)


def build():
    signs = build_signs()
    colour, relief, ratio = brick_wall()
    values = {
        "NN_BRICK": colour,
        "NN_RELIEF": relief,
        "NN_SIGNS": sign_rules(signs),
        "NN_SIGN_COUNT": str(len(signs)),
        "NN_BUBBLES_N": str(len(signs) + 1),
        "NN_MARTINI_BOX": MARTINI_BOX,
        "NN_BUBBLES": bubbles(),
        "NN_EQ_FIRST": str(len(signs) + 2),
        "NN_EQ_LAST": str(len(signs) + 4),
        "NN_EQ_RULES": eq_rules(len(signs) + 2),
    }
    return values, signs


def main():
    values, signs = build()
    tpl = open(os.path.join(D, "neon.tpl.css"), encoding="utf-8").read()
    for k, v in values.items():
        tpl = tpl.replace("{{" + k + "}}", v)
    assert "{{" not in tpl, "unfilled placeholder"
    out = os.path.join(D, "..", "..", "src", "themes", "neon.css")
    open(out, "w", encoding="utf-8", newline="\n").write(tpl)
    print("neon.css", len(tpl), "bytes,", len(signs), "signs")


if __name__ == "__main__":
    main()
