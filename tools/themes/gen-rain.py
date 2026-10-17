"""Rain theme: rain of light, written into src/themes/rain.css from rain.tpl.css.

Usage: python tools/themes/gen-rain.py  (then node build.mjs)

A dark night and a glossy black floor. Rain falls as streaks of light in the album's colours, in three depths:
far off it is fine and slow and meets the floor at the horizon, close by it is long, bright and fast, with a
white-hot head. The floor mirrors it. Where drops land, thin rings of light spread over the floor; on every beat
bright drops strike in a pattern that repeats every two bars, like a drum part; a wave of light runs across the
floor on every bar, a ring opens under the words on every new line, and the rain grows heavier when the song does.

This script draws the rain (white masks the stylesheet fills with the album's colours, each a tile that wraps on
every side so a layer can fall forever by moving one tile) and writes the rules for the ripples: where each lands,
how big it is for its distance, and when. Only transforms and opacities move."""
import os
import random

from artlib import n, svg

D = os.path.dirname(os.path.abspath(__file__))
NL = "\n"

HORIZON = 62  # % of the screen height: where the far rain meets the floor
GROUND = {"far": 62, "mid": 76, "near": 95}  # where each depth's rain meets the floor
# each depth: tile size (px), streak count, length and width range (px), opacity range
RAIN = {
    "far": (520, 130, (22, 46), (0.9, 1.3), (0.3, 0.6)),
    "mid": (720, 54, (54, 110), (1.4, 2.1), (0.45, 0.8)),
    "near": (960, 17, (150, 290), (2.4, 3.6), (0.65, 1.0)),
}
COLOURS = ["var(--rl-a)", "var(--rl-b)", "var(--rl-c)"]

# A streak at unit size, falling: its head at y=0, its tail fading up to y=-1. A soft glow four times as wide sits
# behind a fine core; the head is a short bright segment drawn on its own for the white-hot layer.
DEFS = (
    "<linearGradient id='w' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#fff' stop-opacity='0'/><stop offset='.7' stop-color='#fff' stop-opacity='.12'/><stop offset='1' stop-color='#fff' stop-opacity='.34'/></linearGradient>"
    "<linearGradient id='c' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#fff' stop-opacity='0'/><stop offset='.55' stop-color='#fff' stop-opacity='.38'/><stop offset='.93' stop-color='#fff' stop-opacity='.96'/><stop offset='1' stop-color='#fff'/></linearGradient>"
    "<symbol id='s' overflow='visible'><rect x='-2' y='-1' width='4' height='1' fill='url(#w)'/><rect x='-.5' y='-1' width='1' height='1' fill='url(#c)'/></symbol>"
    "<symbol id='h' overflow='visible'><rect x='-.5' y='-.14' width='1' height='.14' fill='url(#c)'/></symbol>"
)


def streaks(depth):
    """The streaks of one depth: [(x, head y, length, width, opacity)], seeded."""
    tile, count, (lmin, lmax), (wmin, wmax), (amin, amax) = RAIN[depth]
    r = random.Random({"far": 4, "mid": 11, "near": 23}[depth])
    return [(r.uniform(0, tile), r.uniform(0, tile), r.uniform(lmin, lmax), r.uniform(wmin, wmax), round(r.uniform(amin, amax) * 4) / 4) for _ in range(count)]


def rain_tile(depth, heads=False):
    """A tile of falling streaks that wraps on every side, as a white mask."""
    tile = RAIN[depth][0]
    groups = {}
    for x, y, ln, w, a in streaks(depth):
        for ox in (0, -tile, tile):
            for oy in (0, -tile, tile):
                xa, ya = x + ox, y + oy
                if xa < -8 or xa > tile + 8 or ya < -2 or ya - ln > tile + 2:
                    continue
                groups.setdefault(a, []).append(f"<use href='#{'h' if heads else 's'}' transform='translate({n(xa)} {n(ya)})scale({n(w, 2)} {n(ln)})'/>")
    body = "".join(f"<g opacity='{a:g}'>{''.join(v)}</g>" for a, v in sorted(groups.items()))
    return svg(tile, tile, body, DEFS, "none")


def ripple_size(y):
    """A ring on the floor at y (% of the screen): wider and rounder the nearer it is (the floor is seen at a slant)."""
    k = (y - HORIZON) / (100 - HORIZON)  # 0 at the horizon, 1 at the bottom of the screen
    w = 4 + 22 * k ** 1.1  # vmin
    return w, max(1.1, w * (0.13 + 0.17 * k))


def ripples(first, count):
    """Rings where drops land, all the time: each element lands three times a cycle, in three places, at its own pace."""
    r = random.Random(42)
    rules, frames = [], []
    for i in range(count):
        el = first + i
        band = ("far", "mid", "near")[i % 3]
        lo, hi = {"far": (HORIZON + 0.8, 67), "mid": (67, 76), "near": (76, 90)}[band]
        spots = []
        for _ in range(3):
            y = r.uniform(lo, hi)
            spots.append((r.uniform(3, 97), y))
        ys = [y for _, y in spots]
        w, h = ripple_size(sum(ys) / 3)
        dur = r.uniform(1.9, 3.3)
        rules.append(
            f".aur-root[data-fx=\"rain\"] .aur-fx-e > i:nth-child({el}) {{ --rc: {COLOURS[i % 3]}; width: {w:.1f}vmin; height: {h:.2f}vmin; "
            f"margin: {-h / 2:.2f}vmin 0 0 {-w / 2:.1f}vmin; animation: aur-rl-rip-{el} {dur:.2f}s linear {-r.uniform(0, dur):.2f}s infinite; }}"
        )
        third = 100 / 3
        life = third * r.uniform(0.62, 0.8)
        rows = []
        for k, (x, y) in enumerate(spots):
            s = k * third
            pos = f"translate({x:.1f}vw, {y:.1f}vh)"
            # spreads fast and slows down, fading as it goes
            for f, sc, op in ((0, 0.06, 0), (0.02, 0.2, 0.95), (0.12, 0.44, 0.9), (0.35, 0.73, 0.6), (0.65, 0.9, 0.28), (1, 1, 0)):
                rows.append(f"\t{s + f * life:.2f}% {{ transform: {pos} scale({sc}); opacity: {op}; }}")
        rows.append(f"\t100% {{ transform: translate({spots[0][0]:.1f}vw, {spots[0][1]:.1f}vh) scale(0.06); opacity: 0; }}")
        frames.append(f"@keyframes aur-rl-rip-{el} {{\n" + NL.join(rows) + "\n}")
    return NL.join(rules), NL.join(frames)


def hits(first):
    """Bright drops that strike on the beat: two for each beat of a two-bar pattern (bar a/b x beat a/b), each with a
    ring and the streak of the drop collapsing into it. Without beat data they fall at their own pace instead."""
    r = random.Random(8)
    combos = [("a", "a"), ("a", "b"), ("b", "a"), ("b", "b")]
    rules = []
    el = first
    for bar, bt in combos:
        for side in (0, 1):
            x = r.uniform(8, 46) if side == 0 else r.uniform(54, 92)
            y = r.uniform(74, 90)
            w, h = ripple_size(y)
            w, h = w * 1.35, h * 1.35
            rules.append(
                f".aur-root[data-fx=\"rain\"] .aur-fx-e > i:nth-child({el}) {{ --rc: {COLOURS[(el + side) % 3]}; left: {x:.1f}vw; top: {y:.1f}vh; width: {w:.1f}vmin; height: {h:.2f}vmin; "
                f"margin: {-h / 2:.2f}vmin 0 0 {-w / 2:.1f}vmin; --hd: {-r.uniform(0, 3):.2f}s; --hl: {r.uniform(1.9, 3.4):.2f}s; }}"
            )
            sel = f".aur-root[data-fx=\"rain\"][data-bganim=\"on\"] .aur-bg[data-bar=\"{bar}\"][data-bt=\"{bt}\"] .aur-fx-e > i:nth-child({el})"
            rules.append(f"{sel}::before {{ animation: aur-rl-hit calc(var(--aur-beat, 0.5s) * 0.95) linear; }}")
            rules.append(f"{sel}::after {{ animation: aur-rl-strike calc(var(--aur-beat, 0.5s) * 0.95) linear; }}")
            el += 1
    return NL.join(rules)


def build():
    rip_rules, rip_frames = ripples(5, 10)
    return {
        "RL_FAR": rain_tile("far"),
        "RL_MID": rain_tile("mid"),
        "RL_NEAR": rain_tile("near"),
        "RL_NEAR_HEADS": rain_tile("near", heads=True),
        "RL_FAR_TILE": f"{RAIN['far'][0]}px",
        "RL_MID_TILE": f"{RAIN['mid'][0]}px",
        "RL_NEAR_TILE": f"{RAIN['near'][0]}px",
        "RL_HORIZON": f"{HORIZON}%",
        "RL_GROUND_MID": f"{GROUND['mid']}%",
        "RL_GROUND_NEAR": f"{GROUND['near']}%",
        "RL_RIPPLES": rip_rules,
        "RL_RIPPLE_FRAMES": rip_frames,
        "RL_HITS": hits(15),
    }


def main():
    values = build()
    tpl = open(os.path.join(D, "rain.tpl.css"), encoding="utf-8").read()
    for k, v in values.items():
        tpl = tpl.replace("{{" + k + "}}", v)
    assert "{{" not in tpl, "unfilled placeholder"
    out = os.path.join(D, "..", "..", "src", "themes", "rain.css")
    open(out, "w", encoding="utf-8", newline="\n").write(tpl)
    print("rain.css", len(tpl), "bytes;", {k: len(v) for k, v in values.items() if len(v) > 3000})


if __name__ == "__main__":
    main()
