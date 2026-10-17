import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const files = ["styles.css", "glass.css", ...readdirSync(join(SRC, "themes")).sort().map((f) => `themes/${f}`)];
const css = Object.fromEntries(files.map((f) => [f, readFileSync(join(SRC, f), "utf8")]));
const all = Object.values(css).join("\n");

test("generated stylesheets have no unfilled placeholders", () => {
	for (const [f, text] of Object.entries(css)) assert.doesNotMatch(text, /\{\{[A-Z_0-9]+\}\}/, f);
});

test("every animation a stylesheet names is defined", () => {
	const defined = new Set([...all.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
	const used = new Set();
	for (const m of all.matchAll(/(?:animation(?:-name)?|--(?:flick|tv|hv))\s*:\s*([^;{}]+)/g)) {
		for (const part of m[1].split(",")) {
			for (const tok of part.trim().split(/\s+/)) if (/^aur-[\w-]+$/.test(tok)) used.add(tok);
		}
	}
	for (const name of used) assert.ok(defined.has(name), `@keyframes ${name} is used but not defined`);
});

test("Neon is a tunnel of rings, one per beat, that only moves on the compositor", () => {
	const neon = css["themes/neon.css"];
	for (const v of ["aur-nt-ring", "aur-nt-gate-a", "aur-nt-gate-b", "aur-nt-beat-a", "aur-nt-bar-a", "aur-nt-sway", "aur-nt-strike-a"]) assert.match(neon, new RegExp(`@keyframes ${v}`));
	// nine rings, each a beat behind the last, on a nine-beat trip
	assert.match(neon, /animation: aur-nt-ring calc\(var\(--aur-beat, 0\.5s\) \* 9\) linear infinite/);
	for (let k = 2; k <= 9; k++) assert.match(neon, new RegExp(`nth-child\\(${k}\\) \\{ animation-delay: calc\\(var\\(--aur-beat, 0\\.5s\\) \\* -${k - 1}\\); \\}`));
	// a ring grows as 1 / distance: slowly while far, then in a rush
	const scales = [...neon.match(/@keyframes aur-nt-ring \{([^}]*\}){22}/)[0].matchAll(/scale\(([\d.]+)\)/g)].map((m) => Number(m[1]));
	assert.equal(scales.length, 22);
	for (let i = 1; i < scales.length; i++) assert.ok(scales[i] > scales[i - 1], "keeps growing");
	assert.ok(scales[0] < 0.2 && scales.at(-1) > 1.2, "from the far end to past the viewer");
	// every keyframe in the theme animates only transform / opacity / translate / scale / rotate
	for (const m of neon.matchAll(/@keyframes [\w-]+ \{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)) {
		for (const p of m[1].matchAll(/([a-z-]+)\s*:/g)) assert.ok(["transform", "opacity", "translate", "scale", "rotate"].includes(p[1]), `${p[1]} in ${m[0].slice(0, 40)}`);
	}
	assert.doesNotMatch(neon, /data:image\/png/, "no bitmaps");
});

test("Rain is rain of light on a glossy floor, and only moves on the compositor", () => {
	const rain = css["themes/rain.css"];
	for (const v of ["aur-rl-fall-far", "aur-rl-fall-mid", "aur-rl-fall-near", "aur-rl-hit", "aur-rl-strike", "aur-rl-line-a", "aur-rl-wave-a", "aur-rl-beat-a"]) assert.match(rain, new RegExp(`@keyframes ${v}`));
	// ten rings land all the time, each on its own keyframes
	for (let k = 5; k <= 14; k++) assert.match(rain, new RegExp(`@keyframes aur-rl-rip-${k} `));
	// on the beat: two drops for each step of a two-bar pattern (bar a/b x beat a/b)
	for (const bar of ["a", "b"]) for (const bt of ["a", "b"]) assert.equal(rain.split(`[data-bar="${bar}"][data-bt="${bt}"]`).length - 1, 4, `bar ${bar} beat ${bt}`);
	for (const m of rain.matchAll(/@keyframes [\w-]+ \{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)) {
		for (const p of m[1].matchAll(/([a-z-]+)\s*:/g)) assert.ok(["transform", "opacity", "translate", "scale", "rotate"].includes(p[1]), `${p[1]} in ${m[0].slice(0, 40)}`);
	}
	assert.doesNotMatch(rain, /data:image\/png/, "all of it is vector art");
});
