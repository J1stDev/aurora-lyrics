import { test } from "node:test";
import assert from "node:assert/strict";

async function freshSettings(saved = {}) {
	const mem = new Map([["aurora-lyrics:settings", JSON.stringify(saved)]]);
	globalThis.Spicetify = { LocalStorage: { get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, v), remove: (k) => mem.delete(k) } };
	const mod = await import(`../src/settings.js?fresh=${Math.random()}`);
	return { ...mod, saved: () => JSON.parse(mem.get("aurora-lyrics:settings")) };
}

test("defaults match the Aurora theme", async () => {
	const { settings } = await freshSettings();
	assert.equal(settings.currentTheme(), "aurora");
});

test("accent: album or #rrggbb only", async () => {
	const { settings } = await freshSettings();
	settings.set("accent", "#7AA2FF");
	assert.equal(settings.get("accent"), "#7aa2ff");
	settings.set("accent", "red");
	assert.equal(settings.get("accent"), "album");
});

test("applying a theme sets its look, keeps a custom look, and Custom restores it", async () => {
	const { settings, THEMES, themeLook, saved } = await freshSettings({ font: "inter", glow: "radiant", fontSize: 72 });
	assert.equal(settings.currentTheme(), null);

	const events = [];
	const off = settings.subscribe((k) => events.push(k));
	settings.applyTheme("karaoke");
	off();
	const want = themeLook(THEMES.find((t) => t.id === "karaoke"));
	for (const [k, v] of Object.entries(want)) assert.equal(settings.get(k), v, k);
	assert.equal(settings.currentTheme(), "karaoke");
	assert.equal(settings.get("fontSize"), 72, "size is not part of a theme");
	assert.ok(events.includes("view") && !events.includes("*"), "one event per changed key");
	assert.equal(saved().customLook.font, "inter");

	settings.applyTheme("neon"); // switching between themes must not overwrite the saved look
	assert.equal(settings.get("customLook").glow, "radiant");

	settings.applyTheme("custom");
	assert.equal(settings.get("font"), "inter");
	assert.equal(settings.get("glow"), "radiant");
	assert.equal(settings.currentTheme(), null);
});

test("every theme only uses valid settings values", async () => {
	const { settings, THEMES, themeLook } = await freshSettings();
	for (const t of THEMES) {
		settings.applyTheme(t.id);
		assert.equal(settings.currentTheme(), t.id, `${t.id} survives validation`);
		assert.deepEqual(Object.fromEntries(Object.keys(themeLook(t)).map((k) => [k, settings.get(k)])), themeLook(t));
	}
});

test("theme ambience follows the last theme picked and survives tweaks", async () => {
	const { settings } = await freshSettings({ font: "inter" }); // a custom look
	assert.equal(settings.get("themeFx"), "aurora");
	settings.applyTheme("retro");
	assert.equal(settings.get("themeFx"), "retro");
	settings.set("fontSize", 70); // not part of the look
	settings.set("glow", "radiant"); // part of the look: now Custom, ambience stays
	assert.equal(settings.currentTheme(), null);
	assert.equal(settings.get("themeFx"), "retro");
	settings.applyTheme("zen");
	settings.applyTheme("custom"); // back to the look saved before Zen (the tweaked Retro)
	assert.equal(settings.get("glow"), "radiant");
	assert.equal(settings.get("themeFx"), "retro");
});

test("custom background and mini style settings validate", async () => {
	const { settings } = await freshSettings({ customBg: { kind: "video", name: "loop.mp4", size: 1234, extra: "x" }, bgStyle: "custom", miniStyle: "bar" });
	assert.deepEqual(settings.get("customBg"), { kind: "video", name: "loop.mp4", size: 1234 });
	assert.equal(settings.get("bgStyle"), "custom");
	assert.equal(settings.get("miniStyle"), "bar");
	settings.set("customBg", { kind: "pdf", name: "x" });
	assert.equal(settings.get("customBg"), null);
	settings.set("miniStyle", "nope");
	assert.equal(settings.get("miniStyle"), "glass");
});
