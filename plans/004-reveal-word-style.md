# 004 — Reveal: words rise out of a mask at their baseline as they're sung

- **Status**: DONE
- **Commit**: 0a546eb
- **Severity**: LOW (additive)
- **Category**: Missed opportunity
- **Estimated scope**: 4 files (`src/settings.js`, `src/view.js`, `src/styles.css`, `src/icons.js`), ~50 lines

## Problem

The word styles light words in place (Fill, Glow, Karaoke …) or move them a little (Rise, Bounce). None of them
uses a mask, the reveal Apple Music made familiar. The user asked for one.

## Target

Word style **Reveal** ("Rises out of a mask"). Driven by the word's progress (`--aur-wp`, written every frame by
`view.js`), so it follows the vocal and never restarts:

- An upcoming word is a ghost: `color-mix(in srgb, var(--aur-hi) 26%, transparent)`.
- As it is sung, a bright copy of the word (`::after { content: attr(data-t) }`) rises **1em** into place.
  It is clipped at the bottom of the word's own slot, so it appears out of a mask. The ghost fades as the
  copy arrives.
- The rise plays over the first ~38 % of the word (`--r: clamp(0, var(--e) * 2.6, 1)`), eased out cubically:
  `--rv: calc(1 - (1 - var(--r)) * (1 - var(--r)) * (1 - var(--r)))`.
- The clip stays put while the copy moves: `translate: 0 var(--drop)` together with
  `clip-path: inset(-0.6em -0.5em calc(var(--drop) - 0.12em) -0.5em)`, where `--drop: calc((1 - var(--rv)) * 1em)`.
- A held word (`.is-long`) swells a little at its middle:
  `transform: translateY(calc(-0.05em * var(--hop))) scale(calc(1 + 0.05 * var(--hop)))`.
- Lines without word timing: the whole `.aur-main` rises out of a mask once, when the line starts:
  `@keyframes aur-reveal-line { from { translate: 0 1em; clip-path: inset(-0.6em -1em 0.94em -1em); } to { translate: 0 0; clip-path: inset(-0.6em -1em -0.12em -1em); } }`,
  `0.75s var(--aur-ease)`.
- Words are never split into letters in this style (letters would lose their kerning and drift off the copy).

## Repo conventions to follow

- Word styles: `src/styles.css:326-483`, one block per style, scoped
  `.aur-root[data-words="on"][data-wordanim="<id>"] .is-active.has-words …`. `--e` (smoothstep progress)
  and `--hop` (0 → 1 → 0) are already defined.
- Words that are split into letters are decided by `SPLIT_WORD_ANIMS` (`src/view.js:29`). Add a
  `WHOLE_WORD_ANIMS` set beside it.

## Steps

1. `src/view.js`: give every word span `data-t` = its text (`m[2]`). Add `WHOLE_WORD_ANIMS = new Set(["reveal"])`.
   `split` becomes false for those. Re-render in `setOptions` when the split mode changes
   (letters / auto / whole).
2. `src/settings.js`: `["reveal", "Reveal"]`, hint `reveal: "Rises out of a mask"`.
3. `src/styles.css`: the Reveal block. Add `[data-wordanim="reveal"]` to the `:not(...)` list of the long-held
   letter rule at `src/styles.css:386`, so that rule never applies (there are no letters anyway).
4. `src/icons.js`: `STYLE_ART.reveal`.

## Boundaries

- Do NOT change other word styles. Do NOT add JS per frame: everything derives from `--aur-wp`.

## Verification

- **Mechanical**: `npm test`, `node build.mjs`.
- **Feel check** (`dev/preview.html?theme=minimal&pos=9000&set=view:lyrics,wordAnim:reveal,ambience:true`):
  - Each word rises out of its own slot as it starts. No part of the bright copy shows below the slot.
  - A sung word is pixel-identical to plain text (no doubled edges). Zoom the screenshot to check.
  - Album-gradient text colour and duet colours carry into the copy.
  - Seek inside a line: words already sung are simply bright, and the current word is part-way up.
  - Reduced motion: words still light up, without movement (the existing `.aur-w { transform: none !important }`
    rule). Check that the copy does not hang below the slot. In reduced motion `--drop` should be 0, so
    give reduced motion its own rule.
- **Done when**: the style is selectable, its card art shows, and words never show doubled glyphs once sung.
