"""Neon theme: artwork and generated rules, written into src/themes/neon.css from neon.tpl.css.

Usage: python tools/themes/gen-neon.py  (then node build.mjs)

Neon is a retro diner and arcade at night. Teal walls with a pink cove light under the ceiling, a chrome
band and a cherry-red wainscot, a black-and-white checkered floor in perspective that shines. In the middle
of the back wall a big window onto a night street (a lamp, a bar across the road, cars going by), the
venetian blind half up and an OPEN sign hanging in it; above it a DINER sign bent from glass tube, and a
neon coffee cup beside it. Two arcade cabinets glow on the left, their screens playing; a jukebox on the
right with its arch of coloured light and bubbles rising in its tubes; a chrome wall clock that keeps time.
The neon takes three hues from the album, flickers, and swells with the beat.

The art is vector, drawn here once (seeded, so every build is identical); the stylesheet only moves it
(transform and opacity). Tubes are drawn three times: the unlit glass with its mounts (in the room), a mask of
the lit tube and its glow, and a mask of its hot core; the masks are filled with the album's colours."""
import math
import os
import random

from artlib import n, stops, svg

D = os.path.dirname(os.path.abspath(__file__))
W, H = 1600, 900  # the room, in design units: 16:9, it covers the screen, anchored at the bottom
FLOOR = 648  # where the wall meets the floor
HORIZON = 300  # the eye's height, for the floor's perspective
NL, TAB = "\n", "\t"


def rect(x, y, w, h, fill, extra=""):
    return f"<rect x='{n(x)}' y='{n(y)}' width='{n(w)}' height='{n(h)}' fill='{fill}'{extra}/>"


def quad(pts):
    return "M" + "L".join(f"{n(x)} {n(y)}" for x, y in pts) + "Z"


# =============================================================================== tube lettering
def letter(ch, x, y, w, h):
    """One monoline capital as an SVG path, bent the way a glass-blower would: round bowls, square joins."""
    if ch == "O":
        r = w / 2
        return f"<path d='M{n(x + r)} {n(y)}H{n(x + w - r)}A{n(r)} {n(r)} 0 0 1 {n(x + w - r)} {n(y + h)}H{n(x + r)}A{n(r)} {n(r)} 0 0 1 {n(x + r)} {n(y)}Z'/>"
    if ch == "P":
        bh = h * 0.56
        r = bh / 2
        return f"<path d='M{n(x)} {n(y + h)}V{n(y)}H{n(x + w - r)}A{n(r)} {n(r)} 0 0 1 {n(x + w - r)} {n(y + bh)}H{n(x)}'/>"
    if ch == "R":
        bh = h * 0.56
        r = bh / 2
        return f"<path d='M{n(x)} {n(y + h)}V{n(y)}H{n(x + w - r)}A{n(r)} {n(r)} 0 0 1 {n(x + w - r)} {n(y + bh)}H{n(x)}M{n(x + w * 0.42)} {n(y + bh)}L{n(x + w)} {n(y + h)}'/>"
    if ch == "D":
        r = min(w * 0.62, h / 2)
        return f"<path d='M{n(x)} {n(y)}H{n(x + w - r)}A{n(r)} {n(r)} 0 0 1 {n(x + w)} {n(y + r)}V{n(y + h - r)}A{n(r)} {n(r)} 0 0 1 {n(x + w - r)} {n(y + h)}H{n(x)}Z'/>"
    if ch == "E":
        return f"<path d='M{n(x + w)} {n(y)}H{n(x)}V{n(y + h)}H{n(x + w)}M{n(x)} {n(y + h / 2)}H{n(x + w * 0.78)}'/>"
    if ch == "N":
        return f"<path d='M{n(x)} {n(y + h)}V{n(y)}L{n(x + w)} {n(y + h)}V{n(y)}'/>"
    if ch == "I":
        return f"<path d='M{n(x + w / 2)} {n(y)}V{n(y + h)}'/>"
    raise ValueError(ch)


def word(text, cx, y, h, widths, gap):
    total = sum(widths[c] for c in text) + gap * (len(text) - 1)
    x = cx - total / 2
    out = []
    for c in text:
        out.append(letter(c, x, y, widths[c], h))
        x += widths[c] + gap
    return "".join(out), cx - total / 2, cx + total / 2


def star(cx, cy, r):
    pts = []
    for k in range(8):
        rr = r if k % 2 == 0 else r * 0.38
        a = math.radians(-90 + k * 45)
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    return f"<path d='{quad(pts)}'/>"


# =============================================================================== tubes: glass, lit, core
def tube_parts(shapes, T):
    """For SVG shapes without stroke attributes: (unlit glass, lit tube with its glow, hot core) as SVG groups, tube width T."""
    s = "".join(shapes)
    glass = (
        f"<g fill='none' stroke-linecap='round' stroke-linejoin='round'>"
        f"<g stroke='#d4e6ff' stroke-opacity='.18' stroke-width='{n(T * 1.6)}'>{s}</g>"
        f"<g stroke='#071016' stroke-opacity='.6' stroke-width='{n(T * 0.55)}'>{s}</g>"
        f"<g transform='translate({n(-T * 0.3)} {n(-T * 0.3)})' stroke='#fff' stroke-opacity='.25' stroke-width='{n(T * 0.16, 2)}'>{s}</g></g>"
    )
    lit = (
        f"<g fill='none' stroke='#fff' stroke-linecap='round' stroke-linejoin='round'>"
        f"<g filter='url(#gb)' stroke-width='{n(T * 3.6)}' opacity='.6'>{s}</g>"
        f"<g filter='url(#ga)' stroke-width='{n(T * 2)}' opacity='.9'>{s}</g>"
        f"<g stroke-width='{n(T)}'>{s}</g></g>"
    )
    core = f"<g fill='none' stroke='#fff' stroke-linecap='round' stroke-linejoin='round' stroke-width='{n(T * 0.38, 2)}'>{s}</g>"
    return glass, lit, core


def glow_filters(T):
    region = f"x='0' y='0' width='{W}' height='{H}' filterUnits='userSpaceOnUse'"
    return f"<filter id='ga' {region}><feGaussianBlur stdDeviation='{n(T * 1.4)}'/></filter><filter id='gb' {region}><feGaussianBlur stdDeviation='{n(T * 4.4)}'/></filter>"


def mounts(points, T):
    return "".join(f"<circle cx='{n(x)}' cy='{n(y)}' r='{n(T * 0.8)}' fill='#0b141a'/><circle cx='{n(x)}' cy='{n(y)}' r='{n(T * 0.8)}' fill='none' stroke='#fff' stroke-opacity='.25' stroke-width='1'/>" for x, y in points)


# =============================================================================== the room
WIN = (540, 150, 1060, 520)  # the window's glass: x0, y0, x1, y1


def floor_tiles():
    """The checkered floor in one-point perspective: rows by depth, columns converging on the middle of the window."""
    f = (FLOOR - HORIZON) * 10.0  # the wall stands at depth 10
    light, dark = [], []
    rows = []
    z = 10.0
    while True:
        y0 = HORIZON + f / z
        z1 = z - 0.25
        y1 = HORIZON + f / z1
        rows.append((z, z1, y0, min(y1, H + 40)))
        if y1 > H:
            break
        z = z1
    for ri, (za, zb, ya, yb) in enumerate(rows):
        for ci in range(-14, 14):
            xa, xb = ci * 0.25, (ci + 1) * 0.25
            pts = [(800 + f * xa / za, ya), (800 + f * xb / za, ya), (800 + f * xb / zb, yb), (800 + f * xa / zb, yb)]
            if max(p[0] for p in pts) < -20 or min(p[0] for p in pts) > W + 20:
                continue
            (light if (ri + ci) % 2 == 0 else dark).append(quad(pts))
    return "".join(light), "".join(dark)


def street_view():
    """What is outside the window: a night street, the far side of it, a lamp, a bar with a pink light."""
    r = random.Random(11)
    x0, y0, x1, y1 = WIN
    out = [
        f"<rect x='{x0}' y='{y0}' width='{x1 - x0}' height='{y1 - y0}' fill='url(#sky)'/>",
    ]
    # the buildings across the street
    x = x0 - 10
    wins = []
    while x < x1:
        w = r.uniform(50, 110)
        top = r.uniform(250, 360)
        out.append(rect(x, top, w, 470 - top, "#0e1330"))
        out.append(rect(x, top, w, 1.5, "#8a7cd6", " fill-opacity='.35'"))
        for i in range(int((w - 10) // 14)):
            for j in range(int((470 - top - 20) // 18)):
                if r.random() < 0.3:
                    wins.append(f"M{n(x + 7 + i * 14)} {n(top + 12 + j * 18)}h7v9h-7z")
        x += w + r.uniform(0, 8)
    out.append(f"<path d='{''.join(wins)}' fill='#ffcf86' fill-opacity='.85'/>")
    # the bar across the road, its window glowing pink
    out.append(rect(860, 400, 150, 70, "#151a3a") + rect(874, 414, 122, 44, "#ff6fb4", " fill-opacity='.55'"))
    out.append("<ellipse cx='935' cy='436' rx='110' ry='50' fill='url(#pk)'/>")
    # the street and the far kerb, wet
    out.append(rect(x0, 470, x1 - x0, y1 - 470, "#0b0d22"))
    out.append(rect(x0, 470, x1 - x0, 2, "#5a5d9a", " fill-opacity='.5'"))
    out.append("<ellipse cx='935' cy='496' rx='70' ry='14' fill='url(#pk)' opacity='.8'/>")
    # a street lamp
    out.append(rect(651, 300, 4, 172, "#090b1c") + "<path d='M653 300q14-14 34-10' fill='none' stroke='#090b1c' stroke-width='4'/>")
    out.append("<circle cx='688' cy='296' r='60' fill='url(#lamp)'/><ellipse cx='688' cy='296' rx='8' ry='5' fill='#fff2cf'/>")
    out.append("<ellipse cx='688' cy='500' rx='26' ry='16' fill='url(#lamp)' opacity='.7'/>")
    # the blind, half up: slats, a bar and a cord
    for k in range(8):
        yy = y0 + k * 7
        out.append(rect(x0, yy, x1 - x0, 6, "#efe6d2" if k % 2 == 0 else "#e2d7c0") + rect(x0, yy + 5, x1 - x0, 1, "#8f8370", " fill-opacity='.6'"))
    out.append(rect(x0, y0 + 56, x1 - x0, 8, "#cbbd9f") + "<path d='M1010 214V292' stroke='#cbbd9f' stroke-width='2'/><circle cx='1010' cy='295' r='4' fill='#cbbd9f'/>")
    # reflections in the glass
    out.append(f"<path d='M{x0 + 40} {y1}L{x0 + 150} {y0 + 64}H{x0 + 190}L{x0 + 80} {y1}Z' fill='#fff' fill-opacity='.05'/>")
    out.append(f"<path d='M{x0 + 230} {y1}L{x0 + 330} {y0 + 64}H{x0 + 345}L{x0 + 245} {y1}Z' fill='#fff' fill-opacity='.04'/>")
    return "".join(out)


def room_and_signs():
    """The room (one picture, with the unlit glass of every sign in it) and, per colour, the masks of lit tubes and cores."""
    defs = (
        "<linearGradient id='wall' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#0c2732'/><stop offset='.5' stop-color='#15465a'/><stop offset='1' stop-color='#1d5b6e'/></linearGradient>"
        "<linearGradient id='cove' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#ff6fb8' stop-opacity='.42'/><stop offset='1' stop-color='#ff6fb8' stop-opacity='0'/></linearGradient>"
        "<linearGradient id='chrome' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#f6f9fb'/><stop offset='.35' stop-color='#9aa7b2'/><stop offset='.6' stop-color='#e8edf1'/><stop offset='1' stop-color='#5f6b76'/></linearGradient>"
        "<linearGradient id='red' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#b8303f'/><stop offset='1' stop-color='#701626'/></linearGradient>"
        "<linearGradient id='sky' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#0a0e2c'/><stop offset='.6' stop-color='#241a4c'/><stop offset='1' stop-color='#3a2152'/></linearGradient>"
        "<linearGradient id='gloss' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#05121a' stop-opacity='.55'/><stop offset='.5' stop-color='#05121a' stop-opacity='.15'/><stop offset='1' stop-color='#05121a' stop-opacity='.35'/></linearGradient>"
        "<radialGradient id='pk'><stop offset='0' stop-color='#ff7ac0' stop-opacity='.55'/><stop offset='1' stop-color='#ff7ac0' stop-opacity='0'/></radialGradient>"
        "<radialGradient id='lamp'><stop offset='0' stop-color='#ffd99a' stop-opacity='.7'/><stop offset='.35' stop-color='#ffb86a' stop-opacity='.22'/><stop offset='1' stop-color='#ffb86a' stop-opacity='0'/></radialGradient>"
        "<linearGradient id='beam' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#ffd99a' stop-opacity='.16'/><stop offset='1' stop-color='#ffd99a' stop-opacity='0'/></linearGradient>"
        "<radialGradient id='win' cx='.5' cy='0' r='1'><stop offset='0' stop-color='#7d6be0' stop-opacity='.38'/><stop offset='1' stop-color='#7d6be0' stop-opacity='0'/></radialGradient>"
        f"<clipPath id='glass'><rect x='{WIN[0]}' y='{WIN[1]}' width='{WIN[2] - WIN[0]}' height='{WIN[3] - WIN[1]}'/></clipPath>"
    )
    room = []
    # the wall, a faint stripe of wallpaper, the cove light under the ceiling
    room.append(rect(0, 0, W, 590, "url(#wall)"))
    room.append(f"<path d='{''.join(f'M{x} 40h18v540h-18z' for x in range(0, W, 64))}' fill='#fff' fill-opacity='.025'/>")
    room.append(rect(0, 0, W, 38, "#08171f") + rect(0, 38, W, 150, "url(#cove)") + rect(0, 36, W, 3, "#ffd2ea", " fill-opacity='.8'"))
    # the chrome band, the wainscot, the baseboard
    room.append(rect(0, 578, W, 20, "url(#chrome)"))
    room.append(rect(0, 598, W, 50, "url(#red)"))
    room.append(f"<path d='{''.join(f'M{x} 604h2v40h-2z' for x in range(28, W, 56))}' fill='#4a0b16' fill-opacity='.8'/>")
    room.append(f"<path d='{''.join(f'M{x + 2} 604h1v40h-1z' for x in range(28, W, 56))}' fill='#ff9aa6' fill-opacity='.25'/>")
    room.append(rect(0, 640, W, 8, "#2b2f36") + rect(0, 640, W, 1.5, "#dfe5ea", " fill-opacity='.6'"))
    # the floor: checker in perspective, a gloss over it, the window's light on it
    light, dark = floor_tiles()
    room.append(f"<path d='{light}' fill='#8f8a82'/><path d='{dark}' fill='#10121a'/>")
    room.append(rect(0, FLOOR, W, H - FLOOR, "url(#gloss)"))
    room.append(f"<ellipse cx='800' cy='{FLOOR + 6}' rx='420' ry='200' fill='url(#win)'/>")
    # pendant lamps hanging from the ceiling, chrome domes with warm light under them
    for px in (250, 1350):
        room.append(f"<path d='M{px} 38V112' stroke='#0b1418' stroke-width='3'/>")
        room.append(f"<ellipse cx='{px}' cy='170' rx='120' ry='80' fill='url(#lamp)' opacity='.8'/>")
        room.append(f"<path d='M{px - 40} 142Q{px - 38} 110 {px} 108Q{px + 38} 110 {px + 40} 142Z' fill='url(#chrome)'/>")
        room.append(f"<ellipse cx='{px}' cy='142' rx='40' ry='6' fill='#ffe3a8'/>")
        room.append(f"<path d='M{px - 36} 146L{px - 120} 560H{px + 120}L{px + 36} 146Z' fill='url(#beam)'/>")
    # the menu board between the cabinets and the window
    mx, my = 372, 214
    room.append(f"<rect x='{mx - 8}' y='{my - 8}' width='156' height='236' rx='8' fill='url(#chrome)'/>")
    room.append(f"<rect x='{mx}' y='{my}' width='140' height='220' rx='4' fill='#14211e'/>")
    room.append(f"<rect x='{mx + 30}' y='{my + 16}' width='80' height='14' rx='3' fill='#ffd36b' fill-opacity='.85'/>")
    rows = "".join(f"<path d='M{mx + 14} {my + 50 + k * 22}h{70 + (k * 17) % 30}' stroke='#e9efe9' stroke-opacity='.6' stroke-width='3' stroke-linecap='round'/><path d='M{mx + 104} {my + 50 + k * 22}h22' stroke='#ffb36b' stroke-opacity='.8' stroke-width='3' stroke-linecap='round'/>" for k in range(7))
    room.append(rows)
    # the window: chrome frame, the street outside, a sill
    x0, y0, x1, y1 = WIN
    room.append(f"<rect x='{x0 - 14}' y='{y0 - 14}' width='{x1 - x0 + 28}' height='{y1 - y0 + 28}' rx='14' fill='url(#chrome)'/>")
    room.append(f"<g clip-path='url(#glass)'>{street_view()}</g>")
    room.append(f"<rect x='{x0}' y='{y0}' width='{x1 - x0}' height='{y1 - y0}' fill='none' stroke='#05080f' stroke-opacity='.6' stroke-width='3'/>")
    room.append(f"<rect x='{x0 - 26}' y='{y1 + 12}' width='{x1 - x0 + 52}' height='10' rx='3' fill='url(#chrome)'/>")

    # ---- the signs. Group a: DINER and OPEN; group b: the frame round DINER and the coffee cup; group c: stars and steam
    T = 7.5
    widths = {"D": 50, "I": 14, "N": 56, "E": 46, "R": 52, "O": 40, "P": 34}
    diner, dx0, dx1 = word("DINER", 800, 52, 64, widths, 30)
    frame = f"<rect x='{n(dx0 - 40)}' y='30' width='{n(dx1 - dx0 + 80)}' height='108' rx='34'/>"
    stars = star(dx0 - 78, 84, 20) + star(dx1 + 78, 84, 20)
    # OPEN hangs in the window on two chains
    T2 = 4.2
    opn, ox0, ox1 = word("OPEN", 972, 448, 34, {"O": 26, "P": 22, "E": 20, "N": 24}, 10)
    opn_frame = f"<rect x='{n(ox0 - 14)}' y='436' width='{n(ox1 - ox0 + 28)}' height='58' rx='14'/>"
    # the coffee cup, steaming
    cx, cy = 1210, 340
    cup = (
        f"<path d='M{cx - 54} {cy - 30}H{cx + 54}L{cx + 42} {cy + 40}Q{cx + 38} {cy + 56} {cx + 22} {cy + 56}H{cx - 22}Q{cx - 38} {cy + 56} {cx - 42} {cy + 40}Z'/>"
        f"<path d='M{cx + 52} {cy - 16}C{cx + 92} {cy - 18} {cx + 88} {cy + 30} {cx + 44} {cy + 26}'/>"
        f"<path d='M{cx - 80} {cy + 70}H{cx + 80}'/>"
    )
    steam = "".join(f"<path d='M{cx + dx} {cy - 44}c-14-16 14-26 0-44c-12-15 10-24 2-38'/>" for dx in (-26, 0, 26))
    groups = {"a": [diner, opn], "b": [frame, opn_frame, cup], "c": [stars, steam]}
    widths_t = {"a": [T, T2], "b": [T, T2, T], "c": [T, T * 0.8]}
    masks = {}
    for g, shapes in groups.items():
        lit_parts, core_parts = [], []
        for shp, tw in zip(shapes, widths_t[g]):
            glass, lit, core = tube_parts([shp], tw)
            room.append(glass)
            lit_parts.append(lit)
            core_parts.append(core)
        masks[g] = (svg(W, H, "".join(lit_parts), glow_filters(T), "xMidYMax slice"), svg(W, H, "".join(core_parts), "", "xMidYMax slice"))
    room.append(mounts([(dx0 - 40, 50), (dx1 + 40, 50), (dx0 - 40, 118), (dx1 + 40, 118)], T))
    room.append(f"<path d='M{n(ox0 - 4)} 436L{n(ox0 + 20)} {y0 + 64}M{n(ox1 + 4)} 436L{n(ox1 - 20)} {y0 + 64}' stroke='#c9ced6' stroke-width='1.6' stroke-dasharray='3 2'/>")
    return svg(W, H, "".join(room), defs, "xMidYMax slice"), masks


# =============================================================================== the arcade cabinets (left)
INVADER = ["..X.....X..", "...X...X...", "..XXXXXXX..", ".XX.XXX.XX.", "XXXXXXXXXXX", "X.XXXXXXX.X", "X.X.....X.X", "...XX.XX..."]


def pixels(rows, x, y, s, fill):
    d = "".join(f"M{n(x + i * s)} {n(y + j * s)}h{n(s)}v{n(s)}h{n(-s)}z" for j, row in enumerate(rows) for i, c in enumerate(row) if c == "X")
    return f"<path d='{d}' fill='{fill}'/>"


CAB_W, CAB_H, CAB_BASE = 440, 680, 620  # the picture of the two cabinets; they stand on y = CAB_BASE, their reflection below
SCREENS = [(42, 176, 172, 284), (262, 176, 392, 284)]  # x0, y0, x1, y1 of each screen


def cabinet(x, side, accent, accent2):
    """One cabinet seen from the front, 200 wide, standing on CAB_BASE."""
    b = CAB_BASE
    out = [
        # the side panels, seen edge-on, with their stripes
        f"<path d='M{x} 40H{x + 200}V{b}H{x}Z' fill='{side}'/>",
        f"<path d='M{x + 4} 44H{x + 196}V{b}H{x + 4}Z' fill='#0d0b18'/>",
        rect(x, 40, 10, b - 40, accent) + rect(x + 190, 40, 10, b - 40, accent2),
        # the marquee, lit
        f"<rect x='{x + 14}' y='52' width='172' height='62' rx='6' fill='url(#mq{accent[1:]})'/>",
        pixels(INVADER, x + 34, 64, 4, "#1a0c2c") + pixels(INVADER, x + 122, 64, 4, "#1a0c2c"),
        rect(x + 14, 98, 172, 6, "#1a0c2c", " fill-opacity='.5'"),
        # the screen's bezel
        f"<path d='M{x + 18} 124H{x + 182}L{x + 176} 300H{x + 24}Z' fill='#06050c'/>",
        # the control panel, sloping out toward us
        f"<path d='M{x + 6} 318H{x + 194}L{x + 200} 372H{x}Z' fill='{side}'/>",
        f"<path d='M{x + 10} 322H{x + 190}L{x + 194} 366H{x + 6}Z' fill='#191428'/>",
        rect(x + 54, 330, 4, 18, "#cfd3dc") + f"<circle cx='{x + 56}' cy='330' r='8' fill='#ff3d5a'/><circle cx='{x + 53}' cy='327' r='2.5' fill='#fff' fill-opacity='.7'/>",
        "".join(f"<circle cx='{x + 110 + k * 22}' cy='{344 - (k % 2) * 6}' r='7' fill='{c}'/>" for k, c in enumerate(("#ffd23f", "#3fd4ff", "#ff5fd0"))),
        # the coin door: two slots glowing red
        rect(x + 66, 410, 68, 80, "#1b1828") + rect(x + 70, 414, 60, 72, "#26213a"),
        rect(x + 80, 428, 12, 22, "#ff3b4e") + rect(x + 108, 428, 12, 22, "#ff3b4e"),
        rect(x + 84, 434, 4, 10, "#2a0006") + rect(x + 112, 434, 4, 10, "#2a0006"),
        # the kick plate
        rect(x, b - 26, 200, 26, "#0a0912") + rect(x, b - 26, 200, 2, accent, " fill-opacity='.6'"),
    ]
    return "".join(out)


def cabinets():
    defs = (
        "<linearGradient id='mqff4fd8' x1='0' x2='0' y1='0' y2='1'><stop offset='0' stop-color='#ffd1f3'/><stop offset='.5' stop-color='#ff7fe0'/><stop offset='1' stop-color='#c43fd0'/></linearGradient>"
        "<linearGradient id='mq3fe0ff' x1='0' x2='0' y1='0' y2='1'><stop offset='0' stop-color='#d4fbff'/><stop offset='.5' stop-color='#6fe6ff'/><stop offset='1' stop-color='#2a9bd6'/></linearGradient>"
        f"<linearGradient id='fade' x1='0' y1='{CAB_BASE}' x2='0' y2='{CAB_H}' gradientUnits='userSpaceOnUse'><stop offset='0' stop-color='#fff' stop-opacity='.32'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></linearGradient>"
        f"<mask id='rf'><rect x='0' y='{CAB_BASE}' width='{CAB_W}' height='{CAB_H - CAB_BASE}' fill='url(#fade)'/></mask>"
    )
    body = cabinet(14, "#3b1a52", "#ff4fd8", "#7a3cff") + cabinet(234, "#123d52", "#3fe0ff", "#2b7bff")
    screens = "".join(f"<rect x='{x0}' y='{y0}' width='{x1 - x0}' height='{y1 - y0}' rx='10' fill='#05070a'/>" for x0, y0, x1, y1 in SCREENS)
    group = f"<g id='c'>{body}{screens}</g>"
    reflection = f"<g mask='url(#rf)'><use href='#c' transform='translate(0 {2 * CAB_BASE}) scale(1 -1)'/></g>"
    return svg(CAB_W, CAB_H, group + reflection, defs, "xMidYMax meet")


def marquee_glow():
    defs = "<radialGradient id='g'><stop offset='0' stop-color='#fff' stop-opacity='.65'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></radialGradient>"
    body = "<ellipse cx='114' cy='83' rx='130' ry='70' fill='#ff6fe0' fill-opacity='.0'/>" + "".join(
        f"<ellipse cx='{cx}' cy='83' rx='120' ry='62' fill='url(#g)' opacity='.6'/>" for cx in (114, 334)
    )
    return svg(CAB_W, CAB_H, body, defs, "xMidYMax meet")


def invaders_tile():
    """A formation of invaders, three rows, in their colours (moves on the first screen)."""
    out = []
    for row, col in enumerate(("#ff5fd0", "#3fe0ff", "#7dff6a")):
        for k in range(5):
            out.append(pixels(INVADER, 8 + k * 30, 8 + row * 24, 2, col))
    out.append(pixels(["..X..", ".XXX.", "XXXXX"], 70, 92, 3, "#7dff6a"))
    return svg(170, 110, "".join(out), "", "xMidYMid meet")


def stars_tile():
    r = random.Random(4)
    out = []
    for _ in range(40):
        x, y = r.uniform(0, 130), r.uniform(0, 108)
        s = r.choice((1, 1, 1.6, 2.2))
        out.append(f"<rect x='{n(x)}' y='{n(y)}' width='{s}' height='{s}' fill='#fff' fill-opacity='{n(r.uniform(0.4, 1), 2)}'/>")
    return svg(130, 108, "".join(out), "", "none")


def ship():
    return svg(130, 108, pixels(["...X...", "..XXX..", ".XXXXX.", "XX.X.XX", "X.....X"], 54, 84, 3, "#3fe0ff") + pixels(["X"], 63, 66, 2, "#fff") + pixels(["X"], 63, 50, 2, "#fff"), "", "none")


# =============================================================================== the jukebox (right)
JB_W, JB_H, JB_BASE = 340, 700, 640


def jukebox():
    b = JB_BASE
    defs = (
        "<linearGradient id='wood' x1='0' x2='1'><stop offset='0' stop-color='#4a2416'/><stop offset='.5' stop-color='#8a4a2a'/><stop offset='1' stop-color='#3e1d12'/></linearGradient>"
        "<linearGradient id='chrome' x1='0' x2='1'><stop offset='0' stop-color='#6e7a86'/><stop offset='.4' stop-color='#f3f6f9'/><stop offset='.6' stop-color='#b9c3cc'/><stop offset='1' stop-color='#5d6873'/></linearGradient>"
        "<linearGradient id='grille' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#d9a85a'/><stop offset='1' stop-color='#8c5d24'/></linearGradient>"
        "<pattern id='mesh' width='8' height='8' patternUnits='userSpaceOnUse'><rect width='8' height='8' fill='#5b3a17'/><circle cx='4' cy='4' r='2.2' fill='#e5b56a'/></pattern>"
        f"<linearGradient id='fade' x1='0' y1='{b}' x2='0' y2='{JB_H}' gradientUnits='userSpaceOnUse'><stop offset='0' stop-color='#fff' stop-opacity='.3'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></linearGradient>"
        f"<mask id='rf'><rect x='0' y='{b}' width='{JB_W}' height='{JB_H - b}' fill='url(#fade)'/></mask>"
    )
    cx = JB_W / 2
    parts = [
        # the body: a wooden cabinet with a round top
        f"<path d='M30 {b}V230A140 140 0 0 1 310 230V{b}Z' fill='url(#wood)'/>",
        # the arch of light (unlit colour: the lit colour layers lie over it)
        f"<path d='M44 {b - 40}V232A126 126 0 0 1 296 232V{b - 40}' fill='none' stroke='#ffd9a0' stroke-opacity='.25' stroke-width='26'/>",
        f"<path d='M44 {b - 40}V232A126 126 0 0 1 296 232V{b - 40}' fill='none' stroke='url(#chrome)' stroke-width='4' transform='translate(0 0)'/>",
        # the window onto the record
        f"<path d='M80 330V236A90 90 0 0 1 260 236V330Z' fill='#120a14'/>",
        f"<path d='M80 330V236A90 90 0 0 1 260 236V330Z' fill='none' stroke='url(#chrome)' stroke-width='5'/>",
        f"<ellipse cx='{cx}' cy='292' rx='70' ry='20' fill='#050407'/><ellipse cx='{cx}' cy='292' rx='60' ry='16' fill='none' stroke='#2a2430' stroke-width='2'/>",
        f"<ellipse cx='{cx}' cy='292' rx='18' ry='6' fill='#e8463c'/><ellipse cx='{cx}' cy='292' rx='3' ry='1.5' fill='#fff'/>",
        f"<path d='M{cx + 46} 250L{cx + 20} 284' stroke='url(#chrome)' stroke-width='6' stroke-linecap='round'/>",
        f"<path d='M100 238Q170 196 240 238' fill='none' stroke='#fff' stroke-opacity='.18' stroke-width='6'/>",
        # the selector buttons
        f"<rect x='78' y='344' width='184' height='54' rx='8' fill='url(#chrome)'/>",
        "".join(f"<rect x='{88 + k * 17}' y='354' width='12' height='16' rx='2' fill='#f4ead2'/><rect x='{88 + k * 17}' y='374' width='12' height='16' rx='2' fill='#f4ead2'/>" for k in range(10)),
        # the speaker grille
        f"<rect x='76' y='414' width='188' height='150' rx='16' fill='url(#mesh)'/>",
        f"<rect x='76' y='414' width='188' height='150' rx='16' fill='none' stroke='url(#grille)' stroke-width='6'/>",
        f"<path d='M{cx} 420V558M100 489H240' stroke='url(#grille)' stroke-width='5'/>",
        # the base
        f"<rect x='24' y='{b - 22}' width='292' height='22' rx='4' fill='url(#chrome)'/>",
    ]
    group = f"<g id='j'>{''.join(parts)}</g>"
    reflection = f"<g mask='url(#rf)'><use href='#j' transform='translate(0 {2 * b}) scale(1 -1)'/></g>"
    return svg(JB_W, JB_H, group + reflection, defs, "xMidYMax meet")


def jukebox_lights(cols):
    """The arch of coloured light and the bubble tubes, lit: one layer in one set of colours (two of them crossfade)."""
    b = JB_BASE
    g = f"<linearGradient id='l' x1='0' y1='0' x2='0' y2='1'>{stops([(o, c, 1) for o, c in cols])}</linearGradient>"
    defs = g + f"<filter id='b' x='0' y='0' width='{JB_W}' height='{JB_H}' filterUnits='userSpaceOnUse'><feGaussianBlur stdDeviation='9'/></filter>"
    arch = f"M44 {b - 40}V232A126 126 0 0 1 296 232V{b - 40}"
    body = (
        f"<path d='{arch}' fill='none' stroke='url(#l)' stroke-width='34' filter='url(#b)' opacity='.75'/>"
        f"<path d='{arch}' fill='none' stroke='url(#l)' stroke-width='22'/>"
        f"<path d='{arch}' fill='none' stroke='#fff' stroke-opacity='.55' stroke-width='5'/>"
    )
    return svg(JB_W, JB_H, body, defs, "xMidYMax meet")


def bubbles_mask():
    b = JB_BASE
    arch = f"M44 {b - 40}V232A126 126 0 0 1 296 232V{b - 40}"
    return svg(JB_W, JB_H, f"<path d='{arch}' fill='none' stroke='#fff' stroke-width='18'/>", "", "xMidYMax meet")


def bubbles_tile():
    r = random.Random(6)
    out = []
    for _ in range(14):
        x, y, rr = r.uniform(0, 340), r.uniform(0, 120), r.uniform(2, 4.5)
        for oy in (0, -120, 120):
            out.append(f"<circle cx='{n(x)}' cy='{n(y + oy)}' r='{n(rr)}'/>")
    return svg(340, 120, f"<g fill='#fff' fill-opacity='.35' stroke='#fff' stroke-width='1.2'>{''.join(out)}</g>", "", "none")


# =============================================================================== the clock (on the wall, right)
def clock_face():
    defs = (
        "<linearGradient id='c' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#f6f9fb'/><stop offset='.5' stop-color='#8d98a3'/><stop offset='1' stop-color='#e4e9ee'/></linearGradient>"
        "<radialGradient id='f' cx='.45' cy='.4' r='.7'><stop offset='0' stop-color='#fffaf0'/><stop offset='1' stop-color='#e7dcc6'/></radialGradient>"
    )
    ticks = "".join(
        f"<path d='M{n(100 + 70 * math.cos(math.radians(a)))} {n(100 + 70 * math.sin(math.radians(a)))}L{n(100 + (58 if a % 90 == 0 else 63) * math.cos(math.radians(a)))} {n(100 + (58 if a % 90 == 0 else 63) * math.sin(math.radians(a)))}' stroke='#2b2a33' stroke-width='{5 if a % 90 == 0 else 2.5}' stroke-linecap='round'/>"
        for a in range(0, 360, 30)
    )
    body = (
        "<circle cx='100' cy='100' r='96' fill='#ff5fb6' fill-opacity='.18'/>"
        "<circle cx='100' cy='100' r='88' fill='url(#c)'/><circle cx='100' cy='100' r='78' fill='url(#f)'/>"
        + ticks
        + "<path d='M86 128h28' stroke='#d6334b' stroke-width='3' stroke-linecap='round'/>"
        "<path d='M100 100L64 82' stroke='#1d1c24' stroke-width='6' stroke-linecap='round'/>"
    )
    return svg(200, 200, body, defs, "xMidYMid meet")


def clock_hand(length, width, colour, tail=10):
    return svg(200, 200, f"<path d='M100 {100 + tail}V{100 - length}' stroke='{colour}' stroke-width='{width}' stroke-linecap='round'/><circle cx='100' cy='100' r='{width + 2}' fill='{colour}'/>", "", "xMidYMid meet")


# =============================================================================== the rules
def pct(v, total):
    return f"{v * 100 / total:.2f}%"


def build():
    room, masks = room_and_signs()
    values = {
        "NN_ROOM": room,
        "NN_LIT_A": masks["a"][0], "NN_CORE_A": masks["a"][1],
        "NN_LIT_B": masks["b"][0], "NN_CORE_B": masks["b"][1],
        "NN_LIT_C": masks["c"][0], "NN_CORE_C": masks["c"][1],
        "NN_CABINETS": cabinets(),
        "NN_MARQUEE": marquee_glow(),
        "NN_INVADERS": invaders_tile(),
        "NN_STARS": stars_tile(),
        "NN_SHIP": ship(),
        "NN_JUKEBOX": jukebox(),
        "NN_JUKE_A": jukebox_lights([(0, "#ff4f6d"), (0.3, "#ffb03b"), (0.6, "#ffe066"), (1, "#5fe08a")]),
        "NN_JUKE_B": jukebox_lights([(0, "#5fd8ff"), (0.35, "#b36bff"), (0.7, "#ff5fd0"), (1, "#ff9a5f")]),
        "NN_BUBBLE_MASK": bubbles_mask(),
        "NN_BUBBLES": bubbles_tile(),
        "NN_CLOCK": clock_face(),
        "NN_MINUTE": clock_hand(62, 4.5, "#1d1c24"),
        "NN_SECOND": clock_hand(68, 2, "#e0334f", 16),
    }
    # the screens' places in the cabinets' picture, as percentages of its box (inset: top right bottom left)
    for i, (x0, y0, x1, y1) in enumerate(SCREENS, start=1):
        values[f"NN_SCREEN{i}_INSET"] = f"{pct(y0, CAB_H)} {pct(CAB_W - x1, CAB_W)} {pct(CAB_H - y1, CAB_H)} {pct(x0, CAB_W)}"
        values[f"NN_SCREEN{i}_BOX"] = f"left: {pct(x0, CAB_W)}; top: {pct(y0, CAB_H)}; width: {pct(x1 - x0, CAB_W)}; height: {pct(y1 - y0, CAB_H)};"
        values[f"NN_SCREEN{i}_H"] = pct(y1 - y0, CAB_H)
    values["NN_CAB_FOOT"] = f"{(CAB_H - CAB_BASE) / CAB_H:.4f}"
    values["NN_JB_FOOT"] = f"{(JB_H - JB_BASE) / JB_H:.4f}"
    values["NN_FLOOR_FROM_BOTTOM"] = f"{(H - FLOOR) / H * 9 / 16:.4f}"
    return values


def main():
    values = build()
    tpl = open(os.path.join(D, "neon.tpl.css"), encoding="utf-8").read()
    for k, v in values.items():
        tpl = tpl.replace("{{" + k + "}}", v)
    assert "{{" not in tpl, "unfilled placeholder"
    out = os.path.join(D, "..", "..", "src", "themes", "neon.css")
    open(out, "w", encoding="utf-8", newline="\n").write(tpl)
    print("neon.css", len(tpl), "bytes;", {k: len(v) for k, v in values.items() if len(v) > 5000})


if __name__ == "__main__":
    main()
