import { test } from "node:test";
import assert from "node:assert/strict";

// share.js only touches the DOM inside functions, so it imports fine in Node.
const { wrapText } = await import("../src/share.js");
const ctx = { measureText: (s) => ({ width: Array.from(s).length * 10 }) }; // 10px per character

test("wrapText breaks on spaces within the width", () => {
	assert.deepEqual(wrapText(ctx, "the quick brown fox jumps", 110), ["the quick", "brown fox", "jumps"]);
});

test("wrapText splits text without spaces (CJK) per character", () => {
	assert.deepEqual(wrapText(ctx, "春眠不覺曉處處聞啼鳥", 40), ["春眠不覺", "曉處處聞", "啼鳥"]);
});

test("wrapText breaks a single over-long word", () => {
	assert.deepEqual(wrapText(ctx, "supercalifragilistic yes", 80), ["supercal", "ifragili", "stic yes"]);
});

test("mini lyrics position is validated on load", async () => {
	const mem = new Map([["aurora-lyrics:settings", JSON.stringify({ miniPos: { x: 1.7, y: 0.25 } })]]);
	globalThis.Spicetify = { LocalStorage: { get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, v), remove: (k) => mem.delete(k) } };
	const { settings } = await import(`../src/settings.js?fresh=${Math.random()}`);
	assert.deepEqual(settings.get("miniPos"), { x: 1, y: 0.25 });
	assert.equal(settings.get("miniLyrics"), false);
	mem.set("aurora-lyrics:settings", JSON.stringify({ miniPos: { x: "a" } }));
	const again = await import(`../src/settings.js?fresh=${Math.random()}`);
	assert.equal(again.settings.get("miniPos"), null);
});

test("describeQueueItem reads both queue shapes and skips delimiters", async () => {
	const { describeQueueItem } = await import("../src/player.js");
	assert.equal(describeQueueItem({ contextTrack: { uri: "spotify:delimiter", metadata: {} } }), null);
	assert.deepEqual(describeQueueItem({ contextTrack: { uri: "spotify:track:a", metadata: { title: "A", artist_name: "X", image_url: "spotify:image:ab" } } }), {
		uri: "spotify:track:a",
		title: "A",
		artist: "X",
		image: "https://i.scdn.co/image/ab",
	});
	assert.deepEqual(describeQueueItem({ uri: "spotify:track:b", name: "B", artists: [{ name: "Y" }, { name: "Z" }], album: { images: [{ url: "https://i/s", width: 64 }, { url: "https://i/l", width: 640 }] } }), {
		uri: "spotify:track:b",
		title: "B",
		artist: "Y, Z",
		image: "https://i/l",
	});
});
