import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCssColor } from "../src/scenes.js";

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
