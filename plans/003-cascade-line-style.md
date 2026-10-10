# 003 — Cascade: a line style whose words rise in one by one (lyrics timed per line, not per word, too)

- **Status**: DONE
- **Commit**: 0a546eb
- **Severity**: MEDIUM
- **Category**: Missed opportunity (coverage)
- **Estimated scope**: 6 files (`src/settings.js`, `src/overlay.js`, `src/view.js`, `src/styles.css`, `src/icons.js`, 3 theme files), ~90 lines

## Problem

All 11 word styles (Fill, Glow, Pop … Shimmer) are scoped to `.is-active.has-words`, so they only run on
lyrics with word timing. Lines that are timed but have no word timing are rendered as plain text:

```js
/* src/view.js:235-237 — current */
} else {
	main.textContent = line.text;
}
```

Most lyrics are synced only per line (most of LRCLIB, most of Musixmatch). For those songs the only text
motion is the line moving into place; the words themselves never move.

## Target

A new line style, **Cascade** ("Words rise in one by one"). It uses the stack layout: one line at a time,
centred like Cinematic. When a line becomes the current one, its words rise into place one after another,
each with a fade. The line it replaces lifts away by 0.7 em and fades.

- Words: `@keyframes aur-cascade-in { from { opacity: 0; translate: 0 0.42em; } }`, `0.7s` on
  `--aur-ease` (`cubic-bezier(0.22, 1, 0.36, 1)`). Delay `calc(min(var(--k, 0), 14) * 38ms + 70ms)`.
  The stagger is capped at 14 words so a long line is fully in after about 0.6 s.
- It runs on `.aur-wg` (the no-wrap group of one word). Lines with word timing already have these. Lines
  without word timing get them in Cascade only: `view.js` splits `line.text` on whitespace into
  `.aur-wg` spans. Each group knows its index as `--k`.
- `translate` and `opacity` only, so it stays on the compositor and composes with the per-frame word
  `transform` of the word styles (which sits on the `.aur-w` inside the group).
- The translation line and background vocals rise in last: same keyframes, delay `0.32s`.
- The old line: `transform: translateY(calc(-50% - 0.7em))`, with opacity `0.3s ease-out` and transform
  `0.6s var(--aur-ease)`.
- Reduced motion: the existing rule (`.aur-root[data-motion="reduced"] * { animation: none !important; }`)
  removes the rise, and the line simply fades.

## Repo conventions to follow

- Stack styles are listed in `STACK_ANIMS` (`src/overlay.js:33`). Their CSS follows the "Swipe / Zoom / Flip"
  blocks in `src/styles.css:749-822`: per-state `transition-duration` lists in the order opacity,
  transform, filter, color, text-shadow.
- Line style options live in `SCHEMA` → `animation` (`src/settings.js:80-113`). Card art is in
  `STYLE_ART` (`src/icons.js:78+`): 60×40 SVG, `fill: currentColor`, dim parts by `opacity`.
- DOM changes that need a re-render are decided in `LyricsView.setOptions` (`src/view.js:305`).

## Steps

1. `src/settings.js`: add `["cascade", "Cascade"]` to the `animation` options, with hint `cascade: "Words rise in one by one"`.
2. `src/overlay.js`: add `"cascade"` to `STACK_ANIMS`. Pass `lineAnim: all.animation` to `view.setOptions`.
3. `src/view.js`:
   - Store `this.lineAnim`. In `setOptions`, re-render when `(lineAnim === "cascade") !== (this.lineAnim === "cascade")`.
   - In `addWords`, give every new `.aur-wg` `style="--k:N"`, counting per line (main and background
     vocals share one counter).
   - In `render`, for a line without word timing in Cascade mode, append `.aur-wg` spans with `--k`
     instead of `textContent`, keeping the whitespace text nodes between them.
4. `src/styles.css`: add the Cascade block after the Flip block. Add it to the reduced-motion section only
   if something is not already covered.
5. Three themes paint line-synced text with `background-clip: text` on `.aur-main`
   (`src/styles.css` Synthwave, `src/themes/blackmetal.css`, `src/themes/karaoke.css`). A word that moves
   on its own layer is left out of its parent's text clip. In Cascade, those rules have to paint each
   `.aur-wg` themselves: target `:is(.aur-main:not(:has(> .aur-wg)), .aur-main > .aur-wg)` for the
   `color` / `background` / `background-clip` declarations, and keep `filter` / `text-shadow` on `.aur-main`.
6. `src/icons.js`: add `STYLE_ART.cascade`.

## Boundaries

- Do NOT change any other line style, or the word styles.
- Do NOT split words for line-synced lyrics outside Cascade: other themes paint `.aur-main` as a whole.

## Verification

- **Mechanical**: `npm test`, `node build.mjs`.
- **Feel check** (`dev/preview.html?theme=minimal&pos=9000&set=view:lyrics,animation:cascade,ambience:true`):
  - Each new line's words rise in left to right, about 38 ms apart. Nothing jumps when a line ends.
  - Seek backwards: the line you land on cascades in. There is no flash of the whole line first.
  - A song with word timing (Neon Weather in the mock) and Fill: the words cascade in, then the fill sweep runs.
  - Synthwave + Cascade on a line-synced song: the chrome text stays visible *during* the rise.
  - Reduced motion: lines just fade.
- **Done when**: every line style that splits nothing still renders exactly as before (spot-check Flow and Fade).
