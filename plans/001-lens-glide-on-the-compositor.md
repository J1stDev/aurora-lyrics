# 001 — Glide the lyric lens with transforms, not width/height

- **Status**: IN PROGRESS: the quiver no longer moves the pane (placed with `translate`); the FLIP waits for a frame-time measurement
- **Commit**: 0a546eb
- **Severity**: HIGH
- **Category**: Performance (plus a Physicality bug in the same rule)
- **Estimated scope**: 2 files (`src/glass.css`, `src/view.js`), ~40 lines

## Problem

The lens is the pane of glass behind the line being sung, in every glass theme. On every new line it moves
to the new line and changes size over 0.9 s. It does this by transitioning the layout properties `width` and
`height`:

```css
/* src/glass.css:66 — current */
.aur-lens {
	width: var(--lw, 0px);
	height: var(--lh, 0px);
	transform: translate3d(var(--lx, 0px), var(--ly, 0px), 0);
	transition: transform 0.9s var(--g-ease, ease), width 0.9s var(--g-ease, ease), height 0.9s var(--g-ease, ease);
}
```

While the size changes, every frame needs layout and a repaint of the pane. The pane is the most expensive
thing on screen: a `backdrop-filter` that runs two SVG displacement maps (`url(#aur-rf-l)`, built in
`src/glass.js`) and a 22 px blur, plus box-shadows up to 60 px. The displacement maps are `feImage`s drawn
at the element's size, so they have to be drawn again at every new size. All of that happens on the main
thread just as the lines themselves start moving. The "Glass refraction (turn off if the lyrics stutter)"
setting exists because of this kind of stutter.

There is also a second bug in the same element. The quiver as the pane settles animates the `scale` property:

```css
/* src/glass.css:119-122 — current */
.aur-root[data-glass="on"][data-motion="full"][data-lb="a"] .aur-lens { animation: aur-lens-jelly-a 0.95s cubic-bezier(0.3, 0.7, 0.3, 1); }
@keyframes aur-lens-jelly-a { 0% { scale: 1; } 26% { scale: 1.016 0.958; } 56% { scale: 0.993 1.024; } 100% { scale: 1; } }
```

The individual `scale` property is applied *outside* the `transform` list
(matrix = origin · translate · rotate · scale · transform · −origin). That means it scales the
`translate3d(--lx, --ly)` offset as well. At 26 % the pane jumps 4.2 % of `--ly` upwards: about 12 px at
720p and 23 px at 1440p. The quiver is meant to be a squash in place, not a jump.

## Target

- Place the lens with the `translate` property (not `transform`). The jelly `scale` then squashes it about
  its own centre.
- Set the new width and height **instantly**. Make the change look smooth with a FLIP: on the frame of the
  change, put the pane back where it appears now and at the size it appears now, using `--fx/--fy` (offset)
  and `--fsx/--fsy` (scale). Then transition `translate` and `transform` back to identity. Only the
  compositor animates; the filter maps are drawn once per line, at the new size.

```css
/* target, src/glass.css */
.aur-lens {
	width: var(--lw, 0px);
	height: var(--lh, 0px);
	translate: calc(var(--lx, 0px) + var(--fx, 0px)) calc(var(--ly, 0px) + var(--fy, 0px));
	transform: scale(var(--fsx, 1), var(--fsy, 1)); /* FLIP size, about the centre (the pane is centred on the text box) */
	transition: translate 0.9s var(--g-ease, ease), transform 0.9s var(--g-ease, ease);
}
```

FLIP math, in `placeLens` (`src/view.js:479`). The pane is the text box grown by padding `p` (left and right)
and `q` (top and bottom). The padding is in em of `--lf`: read it as
`parseFloat(getComputedStyle(pane).left) * -1` / `top * -1` from the `.aur-lens-pane` child.
1. Read where the pane appears now: `old = lens.getBoundingClientRect()` gives the text box under the
   current, possibly mid-flight, transform. The current scale is `s = old.width / currentLw`. So the
   pane's centre is `(old.left + old.width / 2, old.top + old.height / 2)` and its size is
   `(old.width + 2·p·sx, old.height + 2·q·sy)`.
2. Add `is-snap` (`transition: none`), write the new `--lx --ly --lw --lh`, and also write
   `--fx = oldCentreX − newCentreX`, `--fy = …`, `--fsx = oldPaneW / newPaneW`, `--fsy = …`. All of these
   are in overlay coordinates. The new centre is `x + w/2` and `y + h/2` of the new text box.
3. `void lens.offsetWidth` (this flushes the inverted state, so nothing jumps). Remove `is-snap`. Set
   `--fx: 0px; --fy: 0px; --fsx: 1; --fsy: 1`. The transition runs.

Durations, the curve (`--g-ease: cubic-bezier(0.34, 1.32, 0.52, 1)`) and the jelly keyframes stay as they are.

## Repo conventions to follow

- Lens geometry is written only in `LyricsView.placeLens` (`src/view.js:479-504`). The "snap" pattern
  (add `is-snap`, write, `void lens.offsetWidth`, remove) is already there. Reuse it.
- Reduced motion: `.aur-root[data-motion="reduced"] .aur-lens { transition: none; }` already applies. In
  reduced motion, skip the FLIP and just write the final values.

## Steps

1. `src/glass.css`: replace the `transform`/`transition` lines of `.aur-lens` with the target above.
   Leave `.aur-lens.is-snap { transition: none; }` as it is.
2. `src/view.js` `placeLens`: when the pane is not snapping, measure, invert and play as in the FLIP math.
   When it snaps (`instant`, or the lens was hidden), write `--fx/--fy` = `0px` and `--fsx/--fsy` = `1`
   together with the new values.
3. Make sure nothing else writes `transform` on `.aur-lens`. `grep -n "aur-lens\b" src/themes/*.css`
   should show no theme setting `transform` on `.aur-lens` itself.

## Boundaries

- Do NOT change the jelly keyframes, the durations, the curve, or anything inside the lens (`.aur-lens > i`).
- Do NOT touch the lens's children or the theme files.
- If `placeLens` no longer matches the code quoted above, STOP and report.

## Verification

- **Mechanical**: `npm test` passes. `node build.mjs` builds.
- **Feel check** (preview: `node dev/serve.mjs`, then `dev/preview.html?theme=minimal&pos=9000&set=view:lyrics,ambience:true`,
  with the browser pane visible):
  - The lens glides and resizes from line to line exactly as before. Watch for a jump on the first frame
    (wrong inversion) and a jump at the end (wrong final size).
  - Change lines quickly (click two lines in a row): the second glide starts from where the pane *is*, not
    from where it was going.
  - The quiver now squashes in place. The pane no longer bobs up and down by 10–20 px.
  - Rounded corners stretch a little during a big size change. Check Retro (its labels sit on the rim) and
    Gothic (the lattice). If a theme looks wrong, note it rather than patching the theme.
  - Measure: record frame times (rAF deltas) over 9 s of playback with several line changes, before and
    after. The share of frames over 20 ms should fall, or at least not rise.
- **Done when**: the lens moves only through `translate` and `transform`, and the Animations panel shows no
  `width`/`height` transitions on `.aur-lens`.
