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

test("shareText joins lines and credits the song", async () => {
	const { shareText } = await import("../src/share.js");
	assert.equal(shareText(["Line one", "Line two"], "Song", "Artist"), "Line one\nLine two\n— Song · Artist");
	assert.equal(shareText(["Solo"], "", ""), "Solo");
});

test("clipTimeline: relative times, lines end where the next one starts, 15 s cap", async () => {
	const { clipTimeline, CLIP_MAX_MS } = await import("../src/share.js");
	const lines = [
		{ time: 10000, end: 20000, text: "a b", words: [{ time: 10000, end: 10500, text: "a " }, { time: 10500, end: 19000, text: "b" }] },
		{ time: 12000, end: 14000, text: "c", words: null },
	];
	const { blocks, duration } = clipTimeline(lines, true);
	assert.equal(blocks[0].time, 700);
	assert.equal(blocks[0].end, 2700, "cut at the next line");
	assert.equal(blocks[0].words[1].end, 2700);
	assert.equal(blocks[1].time, 2700);
	assert.equal(duration, 4700 + 1400);
	const long = clipTimeline([{ time: 0, end: 60000, text: "x" }, { time: 30000, end: 60000, text: "y" }], true);
	assert.equal(long.duration, CLIP_MAX_MS);
	const plain = clipTimeline([{ time: null, text: "x" }, { time: null, text: "y" }], false);
	assert.equal(plain.blocks[1].time, 700 + 2600);
});

test("sungFraction sweeps by characters through word timing", async () => {
	const { sungFraction } = await import("../src/share.js");
	const b = { time: 0, end: 2000, words: [{ time: 0, end: 1000, text: "ab" }, { time: 1000, end: 2000, text: "cd" }] };
	assert.equal(sungFraction(b, 0), 0);
	assert.equal(sungFraction(b, 500), 0.25);
	assert.equal(sungFraction(b, 1000), 0.5);
	assert.equal(sungFraction(b, 2500), 1);
	assert.equal(sungFraction({ time: 0, end: 1000, words: null }, 250), 0.25);
});
