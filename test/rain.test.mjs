import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCssColor, rainTint, rainStreet } from "../src/rain.js";

test("parseCssColor reads the forms the browser reports", () => {
	assert.deepEqual(parseCssColor("rgb(159, 194, 232)"), [159, 194, 232]);
	assert.deepEqual(parseCssColor("rgba(10, 20, 30, 0.5)"), [10, 20, 30]);
	assert.deepEqual(parseCssColor("rgb(10 20 30 / 50%)"), [10, 20, 30]);
	assert.deepEqual(parseCssColor("color(srgb 1 0.5 0)"), [255, 128, 0]);
	assert.deepEqual(parseCssColor("#9fc2e8"), [159, 194, 232]);
	assert.deepEqual(parseCssColor("#fa0"), [255, 170, 0]);
	assert.deepEqual(parseCssColor("#9fc2e8cc"), [159, 194, 232]);
	assert.equal(parseCssColor("hotpink"), null);
	assert.equal(parseCssColor(""), null);
	assert.equal(parseCssColor(undefined), null);
});

test("rainTint: a vivid accent gives two neon colours across the wheel from each other", () => {
	const t = rainTint([255, 60, 40]); // a red accent
	const [a, b] = [t.a, t.b].map((s) => s.split(",").map(Number));
	assert.ok(a[0] > a[1] && a[0] > a[2], "the first stays red");
	assert.ok(b[1] > b[0] || b[2] > b[0], "the second is not red: it sits across the wheel (cyan-ish)");
	for (const c of [...a, ...b]) assert.ok(c >= 0 && c <= 255);
});

test("rainTint: a dull accent (white, grey, nothing) falls back to pink and cyan", () => {
	const fallback = rainTint(null);
	assert.deepEqual(rainTint([255, 255, 255]), fallback);
	assert.deepEqual(rainTint([128, 128, 128]), fallback);
	const [a, b] = [fallback.a, fallback.b].map((s) => s.split(",").map(Number));
	assert.ok(a[0] > a[1], "pink");
	assert.ok(b[2] > b[0] || b[1] > b[0], "cyan");
});

test("rainStreet: the same street every time, with every light on the picture and in perspective", () => {
	const tint = rainTint(null);
	const a = rainStreet(tint);
	assert.deepEqual(a, rainStreet(tint));
	assert.ok(a.lights.length > 100 && a.blocks.length > 10);
	for (const l of a.lights) {
		assert.ok(l.r > 0 && l.a > 0 && l.a <= 1, JSON.stringify(l));
		assert.ok(l.x > -0.1 && l.x < 1.1 && l.y > 0 && l.y < 1, JSON.stringify(l));
		assert.match(l.rgb, /^\d+,\d+,\d+$/);
	}
	// the street lamps get bigger and higher up the picture as they come nearer
	const lamps = a.lights.filter((l) => l.kind === "lamp" && l.x < 0.43 && l.z < 0.34).sort((p, q) => p.z - q.z);
	for (let i = 1; i < lamps.length; i++) {
		assert.ok(lamps[i].r > lamps[i - 1].r);
		assert.ok(lamps[i].y < lamps[i - 1].y);
	}
});
