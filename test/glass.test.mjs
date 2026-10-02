import { test } from "node:test";
import assert from "node:assert/strict";
import { GLASS_SIZES, glassMapUri } from "../src/glass.js";
import { neonPalette, oklchToRgb, rgbToOklch, hasScene, cssToRgb } from "../src/scenes.js";
import { NEON_FRAG } from "../src/scene-neon.js";
import { SCENE_VERT, SCENE_HEAD } from "../src/scene-glsl.js";

const inRange = (v) => v.every((x) => Number.isFinite(x) && x >= 0 && x <= 1);
const wrap = (d) => ((d + 540) % 360) - 180;

test("refraction rims never fold over (shift x power stays under the rim width)", () => {
	for (const [id, { rim, shift, power }] of Object.entries(GLASS_SIZES)) {
		assert.ok((shift * power) / rim <= 0.85, `${id}: ${(shift * power) / rim}`);
	}
});

test("refraction maps are resolution-independent SVG images with one varying channel", () => {
	for (const axis of ["x", "y"]) {
		const uri = glassMapUri(axis, 24, 1.7);
		assert.ok(uri.startsWith("data:image/svg+xml,"));
		const svg = decodeURIComponent(uri.slice("data:image/svg+xml,".length));
		assert.match(svg, /width='100%' height='100%'/);
		const stops = [...svg.matchAll(/stop-color='rgb\((\d+),(\d+),(\d+)\)'/g)].map((m) => m.slice(1).map(Number));
		assert.ok(stops.length >= 18, "a gradient on each of two sides");
		const fixed = axis === "x" ? [1, 2] : [0, 2]; // the channels that stay neutral
		for (const s of stops) for (const i of fixed) assert.equal(s[i], 128);
		const varying = stops.map((s) => s[axis === "x" ? 0 : 1]);
		assert.ok(Math.min(...varying) < 20 && Math.max(...varying) > 235, "the shift runs both ways");
	}
});

test("OKLCH round trip", () => {
	for (const rgb of [[255, 60, 60], [20, 200, 120], [90, 120, 255], [240, 240, 240], [12, 12, 14]]) {
		const [L, C, h] = rgbToOklch(rgb);
		const back = oklchToRgb(L, C, h).map((v) => Math.round(v * 255));
		back.forEach((v, i) => assert.ok(Math.abs(v - rgb[i]) <= 1, `${rgb} → ${back}`));
	}
});

test("a colourless accent has no hue, like CSS's none", () => {
	assert.equal(rgbToOklch([128, 128, 128])[2], 0);
});

test("out-of-gamut colours lose chroma but keep their hue", () => {
	const rgb = oklchToRgb(0.8, 0.4, 140); // far outside sRGB
	assert.ok(inRange(rgb));
	const [, c, h] = rgbToOklch(rgb.map((v) => v * 255));
	assert.ok(c < 0.4 && Math.abs(h - 140) < 6, `${c} ${h}`);
});

test("neon palette: valid colours, hues round the wheel from the accent", () => {
	for (const accent of [[255, 90, 40], [40, 200, 255], [120, 255, 120], [255, 255, 255], [0, 0, 0], null]) {
		const p = neonPalette(accent, [30, 20, 70]);
		for (const k of ["uA", "uB", "uC", "uBase"]) assert.ok(inRange(p[k]), `${k} for ${accent}`);
	}
	const hue = (rgb) => rgbToOklch(rgb.map((v) => v * 255))[2];
	const p = neonPalette([255, 90, 40], null);
	const h0 = hue(p.uA);
	assert.ok(Math.abs(wrap(hue(p.uB) - h0 - 150)) < 10);
	assert.ok(Math.abs(wrap(hue(p.uC) - h0 + 40)) < 10);
	// a colourless accent gives the same hot pink as the stylesheet's oklch(from … 0.74 0.22 h)
	const grey = neonPalette([128, 128, 128], null);
	assert.ok(Math.abs(wrap(hue(grey.uA))) < 10);
});

test("scenes: only themes with a shader have one", () => {
	assert.equal(hasScene("neon"), true);
	assert.equal(hasScene("rain"), false); // Rain has its own renderer
	assert.equal(hasScene("toString"), false);
});

test("scene shaders are well-formed GLSL ES 3.00 sources", () => {
	assert.ok(SCENE_VERT.startsWith("#version 300 es"));
	assert.ok(NEON_FRAG.startsWith("#version 300 es"));
	assert.equal(NEON_FRAG.split("#version").length - 1, 1, "one version line");
	assert.ok(NEON_FRAG.includes(SCENE_HEAD));
	assert.match(NEON_FRAG, /void main\(\)/);
	assert.doesNotMatch(NEON_FRAG, /\$\{/);
	// every uniform the engine sets is declared by the head
	for (const u of ["uRes", "uTime", "uA", "uB", "uC", "uBase", "uBeat", "uBar", "uLine", "uLineId", "uGap", "uSong", "uText", "uMeta"]) {
		assert.ok(new RegExp(`uniform [a-z0-9]+ ${u};`).test(SCENE_HEAD), u);
	}
});

test("cssToRgb reads plain colours without a browser", () => {
	assert.deepEqual(cssToRgb("#ff8800"), [255, 136, 0]);
	assert.deepEqual(cssToRgb(" rgb(1, 2, 3)"), [1, 2, 3]);
	assert.equal(cssToRgb(""), null);
	assert.equal(cssToRgb("not a colour"), null); // no canvas here: null, not a throw
});
