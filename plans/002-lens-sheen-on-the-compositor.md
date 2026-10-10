# 002 — Sweep the lens sheen with translate, not background-position

- **Status**: DONE
- **Commit**: 0a546eb
- **Severity**: MEDIUM
- **Category**: Performance
- **Estimated scope**: 5 files (`src/glass.css`, `src/themes/lounge.css`, `blackmetal.css`, `gothic.css`, `retro.css`), ~40 lines

## Problem

On every new line a band of light crosses the lens. It moves by animating `background-position-x`, so the
sheen layer is repainted on every frame of a 1.5 s sweep:

```css
/* src/glass.css:100-107 — current */
.aur-lens-sheen {
	overflow: hidden;
	background: linear-gradient(104deg, transparent 34%, rgba(255, 255, 255, 0.2) 47%, rgba(255, 255, 255, 0.05) 55%, transparent 68%) 160% 0 / 240% 100% no-repeat;
}
.aur-root[data-lb="a"] .aur-lens-sheen { animation: aur-lens-sweep-a 1.5s cubic-bezier(0.3, 0.6, 0.3, 1); }
.aur-root[data-lb="b"] .aur-lens-sheen { animation: aur-lens-sweep-b 1.5s cubic-bezier(0.3, 0.6, 0.3, 1); }
@keyframes aur-lens-sweep-a { from { background-position-x: 160%; } to { background-position-x: -60%; } }
@keyframes aur-lens-sweep-b { from { background-position-x: 160%; } to { background-position-x: -60%; } }
```

Retro has its own scan (`background-position-y`, `src/themes/retro.css:124-131`) with the same cost.

## Target

Paint the band once on a `::before` that is 240 % as wide as the sheen, and move it with `translate`. The
values below reproduce the old path exactly: the image's left edge goes from −2.24 W to +0.84 W, which is
−93.33 % to +35 % of its own width.

```css
.aur-lens-sheen { overflow: hidden; }
.aur-lens-sheen::before {
	content: "";
	position: absolute;
	top: 0;
	bottom: 0;
	left: 0;
	width: 240%;
	background: linear-gradient(104deg, transparent 34%, var(--g-sheen, rgba(255, 255, 255, 0.2)) 47%, var(--g-sheen-tail, rgba(255, 255, 255, 0.05)) 55%, transparent 68%);
	translate: -93.33% 0;
}
.aur-root[data-lb="a"] .aur-lens-sheen::before { animation: aur-lens-sweep-a 1.5s cubic-bezier(0.3, 0.6, 0.3, 1); }
.aur-root[data-lb="b"] .aur-lens-sheen::before { animation: aur-lens-sweep-b 1.5s cubic-bezier(0.3, 0.6, 0.3, 1); }
@keyframes aur-lens-sweep-a { from { translate: -93.33% 0; } to { translate: 35% 0; } }
@keyframes aur-lens-sweep-b { from { translate: -93.33% 0; } to { translate: 35% 0; } }
```

Themes that tinted the band set `--g-sheen` / `--g-sheen-tail` instead of the background. Gothic's lattice
stays on the sheen element itself and hides the band. Retro's scan becomes a `::before` that is 260 % tall,
moved from `translate: 0 98.46%` to `0 -98.46%` (the same path as `background-position-y: -160%` → `160%`).

## Steps

1. `src/glass.css`: replace the block above. Change `.aur-root[data-motion="reduced"] .aur-lens-sheen { animation: none; }`
   to target `.aur-lens-sheen::before`.
2. `src/themes/lounge.css:42` → `.aur-root[data-look="lounge"] .aur-lens-sheen { --g-sheen: rgba(255, 232, 190, 0.26); --g-sheen-tail: rgba(255, 200, 130, 0.06); }`
3. `src/themes/blackmetal.css:63` → `.aur-root[data-look="blackmetal"] .aur-lens-sheen { --g-sheen: rgba(235, 246, 255, 0.24); --g-sheen-tail: rgba(235, 246, 255, 0.05); }`
4. `src/themes/gothic.css`: add `.aur-root[data-look="gothic"] .aur-lens-sheen::before { display: none; }`.
5. `src/themes/retro.css:124-131`: move the scan to `::before` as described, with keyframes on `translate`.
   Keep `0.9s linear` and the `[data-motion="full"]` gating.

## Boundaries

- Do NOT change the lens shape, the pane or the rim.
- Neon is being rebuilt; leave its sheen rule for that work.

## Verification

- **Mechanical**: `npm test` passes (it checks that every animation named is defined). `node build.mjs` builds.
- **Feel check**: on Minimal, Lounge, Black Metal and Retro, a new line sends the same sweep across the lens
  as before (same direction, speed and tint). Gothic shows its lattice with no sweep. In DevTools, Rendering ›
  Paint flashing: the lens does not flash green while the band crosses it.
- **Done when**: `grep -n "background-position" src/glass.css src/themes/retro.css` finds no keyframes.
