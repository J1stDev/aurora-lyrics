# How the themes are built

Notes taken from Vaporwave, which set the bar, and used again to rebuild Neon and Rain. Vaporwave looks well designed and moves smoothly for reasons that can be copied; the glass kit (`src/glass.css`) supplies the controls, and each theme supplies a world.

## What makes a theme feel designed

1. **One world, told in objects.** Vaporwave is a dusk sky with a ringed planet, cumulus, palms and a checker floor. Neon is a retro diner and arcade at night: a DINER sign over a window onto the street, arcade cabinets, a jukebox. Rain is a cosy room with a big window onto a rainy city, a cat and a candle on the sill. Nothing is abstract light; every shape is a thing that could stand in that world.
2. **The interface lives in the world.** The cover hangs in an old OS window (Vaporwave), sits in a chrome frame lit by a tube (Neon), or is a pane of misted glass (Rain). The line being sung gets a marquee lightbox with chasing bulbs (Neon), a misted pane with water beaded on its edge (Rain), a window of the terminal (Retro). The lettering takes part too: wide-set type with a pink and cyan misregistration, tube lettering that strikes on word by word.
3. **Authored art, drawn once.** The pictures come from a seeded generator, so a build is identical every time and the shapes are chosen, not noisy: clouds with lit tops and shaded undersides, signs bent from one piece of tube with their standoffs and cables, a real perspective street. The CSS only moves them.
4. **Layers at different speeds.** Far clouds 320 s a tile, near clouds 170 s, a planet bobbing for 9 s, palms swaying for 11 s; rain in two depths at 600 and 900 px per loop. Slow things behind, quicker things in front.
5. **Only the compositor moves.** `transform`, `opacity`, `translate` and `scale` on layers that were painted once. No runtime CSS filters, no repainting gradients, no backdrop blur on the scene. This is why it is smooth where a per-pixel shader at half resolution and 30 fps is not.
6. **The music drives it, with a fallback.** Loops take their length from the song's beat (`calc(var(--aur-beat, 0.6s) * 4)`) and look right without beat data; the bar and the beat flip `data-bar` and `data-bt` (a/b), a new line flips `data-lb`, and a break sets `data-gap`. `overlay.js` keeps loops in their place when the tempo arrives a moment after the theme opens (`keepPhase`), otherwise they leap.
7. **A medium over everything.** VHS scanlines, grain and a tracking glitch; a vignette and the faint sheen of a window. It ties the layers together.
8. **A tight palette.** A handful of colours, used everywhere. Where the album should show, derive three hues from `--aur-accent` (`oklch(from …)`) and paint the art through masks (below).

## The pipeline

- `tools/themes/gen-<theme>.py` draws the art and fills `tools/themes/<theme>.tpl.css`, which writes `src/themes/<theme>.css`. Run the generator, then `node build.mjs`. `artlib.py` has the shared helpers (SVG data URIs, short numbers, gradient stops). Vaporwave, Aurora and Synthwave still write into `src/styles.css`.
- The ambience has fixed slots: `.aur-fx` with `::before` and `::after`, `.aur-fx-a` to `-d` each with their own pseudo-elements, and `.aur-fx-e` with 24 children for parts that move on their own. A theme uses as many as it needs.
- Art is `url("data:…")`, so the whole extension stays one file. Keep an eye on the size: batch many polygons into one `<path>`, share gradients, round coordinates, and draw repeated things once as a `<symbol>` and place it with `<use>` (Rain's six hundred beads of water shrank from 140 KB to 54 KB that way).

## Tricks worth reusing

- **Colour from the album through a mask.** Draw a shape as a white SVG, use it as `mask-image` on an element whose `background` is a gradient of `--neon-a/b/c` or `--rn-a/b/c`. The same art takes the colours of any cover. Neon's tubes are drawn three times: the unlit glass in the room picture (always seen), and per colour a mask of the lit tubes with their glow and a mask of their cores.
- **A loop that joins.** A tile one tile taller than the screen, moved by exactly one tile. Never put static children inside a moving layer: they move with it. Use a layer's pseudo-elements only when the layer itself stays still.
- **A floor that mirrors.** An object's picture holds its own reflection: the object is a `<g id>`, drawn again below its foot with `<use … transform='translate(0 2·foot) scale(1 -1)'>` under a mask that fades it out (the cabinets and the jukebox in Neon). The stylesheet stands the object on the room's floor line with `bottom: calc(var(--floor) - height × (picture below the foot))`.
- **Pictures that line up.** Rain's city is 16:9 and covers the screen, anchored at the bottom: `--stw: max(100vw, 177.78vh)` gives the city and its neon and twinkling windows the same mapping on any window shape. The things in the room are anchored to the screen instead (the sill along the bottom, objects in `vmin`), so they never get cropped.
- **Moving parts share their object's frame.** The candle's flame, the steam over the mug and the cat's tail are pictures of their own drawn in the same viewBox as the object, placed in the same box, and turned about a pivot given as `transform-origin` in percent of that box.
- **One-shot effects on every line or bar.** Two identical keyframes swapped on `data-lb="a"` and `"b"` restart the animation each time.
- **Per-theme vinyl.** `glass.css` forces `--cover-r: 50%` for the Vinyl layout; a theme's own `--cover-r` would otherwise square the record.

## Checking a look

`node dev/serve.mjs`, then `dev/preview.html?loop&theme=neon&pos=30000&set=view:split,ambience:true`. Editing a look setting turns the ambience off, so put `ambience:true` last in `set=`. The browser pane does not run animations while it is hidden, and its first screenshot of a heavy page can time out: take it twice. Try every layout (`view:` lyrics, split, vinyl, captions, stage, mirror, poster) and a narrow window.

## What did not work

Two Rain designs were turned down before the cosy room: a photographic one (a WebGL renderer, then a fogged bitmap with a sharp vector street showing through a wiped patch). Mixing a soft photo look with crisp vector art read as blurry and muddy, and a night scene kept dark to be realistic read as murky. A world that is clearly illustrated, crisp at any size and lit in rich colour reads as designed.
