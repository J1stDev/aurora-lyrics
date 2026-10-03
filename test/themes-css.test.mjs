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

test("Neon and Rain are drawn by their stylesheets, with every layer they rely on", () => {
	const neon = css["themes/neon.css"];
	assert.match(neon, /\.aur-fx-e > i:nth-child\(-n \+ 11\)/, "the signs");
	assert.match(neon, /-webkit-box-reflect/, "the mirrored floor");
	assert.equal((neon.match(/--lit: url\(/g) || []).length, 11, "a lit mask for each sign");
	const rain = css["themes/rain.css"];
	assert.match(rain, /\.aur-fx-e > i:nth-child\(22\) \{ background-image: url\("data:image\/svg\+xml/, "the cat");
	for (const v of ["aur-rn-fall-far", "aur-rn-fall-near", "aur-rn-drift", "aur-rn-tail", "aur-rn-steam", "aur-rn-flicker", "aur-rn-bolt"]) assert.match(rain, new RegExp(`@keyframes ${v}`));
	assert.doesNotMatch(rain, /data:image\/png/, "all of it is vector art");
});
