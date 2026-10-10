# 005 — Glitch: each word lands with a red/cyan jolt, then settles clean

- **Status**: DONE
- **Commit**: 0a546eb
- **Severity**: LOW (additive)
- **Category**: Missed opportunity
- **Estimated scope**: 3 files (`src/settings.js`, `src/styles.css`, `src/icons.js`), ~35 lines

## Problem

There is no hard-edged, digital word style. Neon flickers softly; the other styles are soft. The user asked
for a glitch.

## Target

Word style **Glitch** ("Lands with a jolt"):

- Upcoming words are dim (`--aur-dim`). A word lights fast as it starts: `--lit: clamp(0, var(--e) * 6, 1)`.
- When a word becomes the current one (`.aur-w.now`), a one-shot, **stepped** animation runs:
  `aur-glitch 0.36s steps(1, end)`. For four frames the word shows red and cyan copies (text-shadow),
  slips sideways (`translate`) and loses a band (`clip-path: inset()`). Then it settles clean.

```css
@keyframes aur-glitch {
	0% { translate: -0.06em 0; text-shadow: 0.08em 0 rgba(255, 46, 99, 0.9), -0.08em 0 rgba(40, 232, 255, 0.9); clip-path: inset(0 -0.2em 52% -0.2em); }
	16% { translate: 0.07em 0; text-shadow: -0.06em 0 rgba(255, 46, 99, 0.85), 0.06em 0 rgba(40, 232, 255, 0.85); clip-path: inset(38% -0.2em 0 -0.2em); }
	34% { translate: -0.03em 0; text-shadow: 0.04em 0 rgba(255, 46, 99, 0.7), -0.04em 0 rgba(40, 232, 255, 0.7); clip-path: inset(-0.2em -0.2em 18% -0.2em); }
	52% { translate: 0.015em 0; text-shadow: -0.02em 0 rgba(255, 46, 99, 0.5), 0.02em 0 rgba(40, 232, 255, 0.5); clip-path: none; }
	70%, 100% { translate: 0 0; text-shadow: none; clip-path: none; }
}
```

- Lines without word timing get the same jolt on the whole `.aur-main` once, when the line starts.
- Reduced motion: the global rule removes the animation, and the colour change remains.

## Repo conventions to follow

- The Neon word style already runs a one-shot on `.aur-w.now` (`src/styles.css:437`). Copy its scoping.
- `translate` is not used by any other word rule, so it composes with the per-frame `transform`.

## Steps

1. `src/settings.js`: `["glitch", "Glitch"]`, hint `glitch: "Lands with a jolt"`.
2. `src/styles.css`: the Glitch block, after Shimmer.
3. `src/icons.js`: `STYLE_ART.glitch`.

## Boundaries

- Do NOT make it loop or run on sung words: one jolt per word, then clean.
- Do NOT use `filter` in the keyframes (it would repaint the glow every step).

## Verification

- **Mechanical**: `npm test` (every animation named is defined), `node build.mjs`.
- **Feel check**: `dev/preview.html?theme=minimal&pos=9000&set=view:lyrics,wordAnim:glitch,ambience:true`.
  Each word snaps through a few broken frames and is clean within about 0.25 s. Fast words never look
  permanently broken. Letters of a held word (`.has-chars`) jolt together with their word.
- **Done when**: selectable, card art present, no residual offset or colour fringe on sung words.
