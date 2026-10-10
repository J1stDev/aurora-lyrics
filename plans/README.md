# Animation plans

Written by an animation audit (lyric text motion, the glass lens, and the Neon and Rain ambience) at commit
`0a546eb`. Each plan stands on its own.

| # | Plan | Severity | Status |
|---|------|----------|--------|
| 001 | [Glide the lyric lens with transforms, not width/height](001-lens-glide-on-the-compositor.md) | HIGH | IN PROGRESS (quiver fixed; FLIP waits for a measurement) |
| 002 | [Sweep the lens sheen with translate](002-lens-sheen-on-the-compositor.md) | MEDIUM | DONE |
| 003 | [Cascade line style](003-cascade-line-style.md) | MEDIUM | DONE |
| 004 | [Reveal word style](004-reveal-word-style.md) | LOW | DONE |
| 005 | [Glitch word style](005-glitch-word-style.md) | LOW | DONE |

## Order

1. **002** first: small, self-contained, and it touches the same lens as 001.
2. **003**, **004**, **005**: independent of each other. 004 adds `data-t` to word spans; nothing else depends on it.
3. **001** last. It changes how every glass theme's lens moves, so it needs a measured before/after (frame times
   with the browser pane visible) and a look at each glass theme mid-glide.

## Not findings (by design)

- `ease-in` on the *leaving* line in Swipe, Zoom and Flip (`src/styles.css:749-822`): documented ("the old line
  leaves quickly, the new one arrives slowly and a beat later"). The eye is on the arriving line.
- Line moves of ~1 s (`--aur-move`): this is the lyric choreography, not UI chrome.
- Reduced motion: handled (`src/styles.css:1791-1807`). The theme ambience pauses with the animated background.

## Also noted (fixed by the Neon and Rain remakes, both done)

- `src/themes/rain.css:454` blurs the whole current line `7px → 0` for 1.5 s on every line (`filter` animation).
- `src/settings.js:207,220` theme hints still describe the old designs.
