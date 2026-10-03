# How the themes are built

Notes taken from Vaporwave, which set the bar, and used again to rebuild Neon and Rain. Vaporwave looks well designed and moves smoothly for reasons that can be copied; the glass kit (`src/glass.css`) supplies the controls, and each theme supplies a world.

## What makes a theme feel designed

1. **One world, told in objects.** Vaporwave is a dusk sky with a ringed planet, cumulus, palms and a checker floor. Neon is the brick wall of a back-alley bar with glass-tube signs. Rain is a wide avenue seen through a fogged window. Nothing is abstract light; every shape is a thing that could stand in that world.
2. **The interface lives in the world.** The cover hangs in an old OS window (Vaporwave), is held in a tube frame bolted to the wall (Neon), or is a pane of misted glass (Rain). The line being sung gets a sign (Neon), a wiped patch of glass (Rain), a window of the terminal (Retro). The lettering takes part too: wide-set type with a pink and cyan misregistration, tube lettering that strikes on word by word.
3. **Authored art, drawn once.** The pictures come from a seeded generator, so a build is identical every time and the shapes are chosen, not noisy: clouds with lit tops and shaded undersides, signs bent from one piece of tube with their standoffs and cables, a real perspective street. The CSS only moves them.
4. **Layers at different speeds.** Far clouds 320 s a tile, near clouds 170 s, a planet bobbing for 9 s, palms swaying for 11 s; rain in three depths at 640, 800 and 1100 px per loop. Slow things behind, quicker things in front.
5. **Only the compositor moves.** `transform`, `opacity`, `translate` and `scale` on layers that were painted once. No runtime CSS filters, no repainting gradients, no backdrop blur on the scene. This is why it is smooth where a per-pixel shader at half resolution and 30 fps is not.
6. **The music drives it, with a fallback.** Loops take their length from the song's beat (`calc(var(--aur-beat, 0.6s) * 4)`) and look right without beat data; the bar and the beat flip `data-bar` and `data-bt` (a/b), a new line flips `data-lb`, and a break sets `data-gap`. `overlay.js` keeps loops in their place when the tempo arrives a moment after the theme opens (`keepPhase`), otherwise they leap.
7. **A medium over everything.** VHS scanlines, grain and a tracking glitch; a vignette and the faint sheen of a window. It ties the layers together.
8. **A tight palette.** A handful of colours, used everywhere. Where the album should show, derive three hues from `--aur-accent` (`oklch(from …)`) and paint the art through masks (below).

## The pipeline

- `tools/themes/gen-<theme>.py` draws the art and fills `tools/themes/<theme>.tpl.css`, which writes `src/themes/<theme>.css`. Run the generator, then `node build.mjs`. `artlib.py` has the shared helpers (SVG data URIs, a PNG writer on numpy alone, blurs). Vaporwave, Aurora and Synthwave still write into `src/styles.css`.
- The ambience has fixed slots: `.aur-fx` with `::before` and `::after`, `.aur-fx-a` to `-d` each with their own pseudo-elements, and `.aur-fx-e` with 24 children for parts that move on their own. A theme uses as many as it needs.
- Art is `url("data:…")`, so the whole extension stays one file. Keep an eye on the size: batch many polygons into one `<path>`, share gradients, round coordinates, quantise the colours of small bitmaps (`quantise` in gen-rain.py makes the beads about a third smaller), and put soft pictures in small bitmaps that the browser scales up.

## Tricks worth reusing

- **Colour from the album through a mask.** Draw a shape as a white SVG, use it as `mask-image` on an element whose `background` is a gradient of `--neon-a/b/c` or `--rn-a/b/c`. The same art takes the colours of any cover. Neon's signs are three pictures: the unlit glass (always seen), a mask of the lit tube with its glow, and a mask of its core.
- **A loop that joins.** A tile one tile taller than the screen, moved by exactly one tile. Never put static children inside a moving layer: they move with it. Use a layer's pseudo-elements only when the layer itself stays still.
- **Perspective motion without 3D.** A car is a pair of lights in an element scaled about the vanishing point (`transform-origin` there). The keyframes follow 1/z so it speeds up as it comes near.
- **A floor that mirrors.** `-webkit-box-reflect: below -64% linear-gradient(…)` on a container that holds the signs; with the container full height and a negative offset the mirror sits at the floor line.
- **Pictures that line up.** The Rain picture is 16:9 and covers the screen, anchored at the bottom: `--stw: max(100vw, 177.78vh)` and `--u: calc(var(--stw) / 1600)` give every layer the same mapping, so a car, a drop and the avenue agree on any window shape.
- **A hole where the line is.** `view.js` tells an element (`opts.mirror`) where the pane is (`--rx --ry --rw --rh --rf`). Those are registered custom properties (`@property … <length>`), so a `transition` on them makes the numbers glide, and a `clip-path: inset(… round …)` built from them shows the sharp street in a pill that follows the pane.
- **One-shot effects on every line or bar.** Two identical keyframes swapped on `data-lb="a"` and `"b"` restart the animation each time.
- **Per-theme vinyl.** `glass.css` forces `--cover-r: 50%` for the Vinyl layout; a theme's own `--cover-r` would otherwise square the record.

## Checking a look

`node dev/serve.mjs`, then `dev/preview.html?loop&theme=neon&pos=30000&set=view:split,ambience:true`. Editing a look setting turns the ambience off, so put `ambience:true` last in `set=`. The browser pane does not run animations while it is hidden, and its first screenshot of a heavy page can time out: take it twice. Try every layout (`view:` lyrics, split, vinyl, captions, stage, mirror, poster) and a narrow window.
