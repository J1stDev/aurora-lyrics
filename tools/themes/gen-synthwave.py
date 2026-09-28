"""
Usage: python tools/themes/gen-synthwave.py  (then node build.mjs)
Generate the geometry-heavy parts of the Synthwave CSS (grid, ridges, stars)."""
import math, random, os

out = []

# --- vertical grid lines: rays from the vanishing point, true perspective spacing (atan) ---
stops = []
W = 0.14  # half width of a ray in degrees
for m in range(-14, 15):
    a = 180 + math.degrees(math.atan(m * 0.42))  # 180deg = straight down
    stops.append((a, m))
stops.sort()
parts = ["transparent 0deg"]
for a, m in stops:
    parts.append(f"transparent {a - W - 0.35:.2f}deg")
    parts.append(f"var(--sw-line-soft) {a - W:.2f}deg")
    parts.append(f"var(--sw-line) {a - W:.2f}deg {a + W:.2f}deg")
    parts.append(f"var(--sw-line-soft) {a + W:.2f}deg")
    parts.append(f"transparent {a + W + 0.35:.2f}deg")
verticals = "conic-gradient(from 0deg at 50% 0%, " + ", ".join(parts) + ")"
out.append(("VERTICALS", verticals))

# --- horizontal grid lines: y = H / (1 + (k - phase) * r), phase 0..1 moves them toward you ---
R = 0.36
layers = []
for k in range(1, 15):
    pos = f"calc(100% / (1 + ({k} - var(--sw-ph)) * {R}))"
    # thicker and brighter near the viewer
    alpha = f"calc(100% / (1 + ({k} - var(--sw-ph)) * {R * 1.6}))"
    core = f"color-mix(in srgb, var(--sw-line) {alpha}, transparent)"
    soft = f"color-mix(in srgb, var(--sw-line-soft) {alpha}, transparent)"
    t = f"calc(0.6px + 2px / (1 + ({k} - var(--sw-ph)) * {R}))"
    layers.append(
        f"linear-gradient(to bottom, transparent calc({pos} - {t} - 5px), {soft} calc({pos} - {t}), {core} calc({pos} - {t}), {core} {pos}, {soft} {pos}, transparent calc({pos} + 4px))"
    )
out.append(("HORIZONTALS", ",\n\t\t".join(layers)))

# --- mountain ridges (clip-path polygons), seeded so they never change between builds ---
def ridge(seed, lo, hi, step, gap=None, valley=None):
    rnd = random.Random(seed)
    pts = ["0% 100%"]
    x = 0.0
    y = rnd.uniform(lo, hi)
    while x <= 100:
        if valley and valley[0] < x < valley[1]:
            # low rolling hills where the sun sits, so its slats stay visible
            t = (x - valley[0]) / (valley[1] - valley[0])
            y = max(y, valley[2] + (100 - valley[2]) * 0.25 * math.sin(t * math.pi * 2) ** 2)
        if gap and gap[0] < x < gap[1]:
            pts.append(f"{gap[0]:.1f}% 100%")
            pts.append(f"{gap[1]:.1f}% 100%")
            x = gap[1] + step
            continue
        pts.append(f"{x:.1f}% {y:.1f}%")
        x += rnd.uniform(step * 0.6, step * 1.4)
        y = min(hi, max(lo, y + rnd.uniform(-38, 38)))
    pts.append("100% 100%")
    return "polygon(" + ", ".join(pts) + ")"

out.append(("RIDGE_BACK", ridge(7, 8, 72, 4.2, valley=(34, 66, 78))))
out.append(("RIDGE_FRONT", ridge(21, 22, 88, 5.5, gap=(33, 67))))

# --- stars: fixed positions in the upper sky ---
rnd = random.Random(3)
stars = []
for i in range(34):
    x = rnd.uniform(2, 98)
    y = rnd.uniform(2, 58)
    s = rnd.choice([0.8, 1, 1, 1.2, 1.4, 1.7])
    a = rnd.choice([0.5, 0.6, 0.75, 0.9, 1])
    tint = rnd.choice(["255, 255, 255", "255, 220, 250", "210, 225, 255"])
    stars.append(f"radial-gradient({s}px {s}px at {x:.1f}% {y:.1f}%, rgba({tint}, {a}), transparent)")
out.append(("STARS", ",\n\t\t".join(stars)))

D = os.path.dirname(os.path.abspath(__file__))
tpl = open(os.path.join(D, "synthwave.tpl.css"), encoding="utf-8").read()
for k, v in out:
    tpl = tpl.replace("{{" + k + "}}", v)
print("ok", len(tpl))

START, END = '/* Synthwave: an outrun sunset.', '/* Zen:'

# Write the finished block straight into src/styles.css, replacing the theme's current block.
STYLES = os.path.join(D, "..", "..", "src", "styles.css")
css = open(STYLES, encoding="utf-8").read()
i = css.index(START)
j = css.index(END, i)
open(STYLES, "w", encoding="utf-8", newline=chr(10)).write(css[:i] + tpl + css[j:])
print("updated src/styles.css")
