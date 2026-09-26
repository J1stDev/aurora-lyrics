import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLRC, parsePlain, parseLyricsText, findLineIndex, toLRC, looksSynced, hasContent } from "../src/lrc.js";

test("standard LRC: timestamps in all common precisions", () => {
	const l = parseLRC("[00:01.5]a\n[00:02.25]b\n[00:03.125]c\n[00:04]d\n[00:05:50]e");
	assert.deepEqual(
		l.lines.map((x) => [x.time, x.text]),
		[
			[1500, "a"],
			[2250, "b"],
			[3125, "c"],
			[4000, "d"],
			[5500, "e"],
		],
	);
	assert.equal(l.synced, true);
	assert.equal(l.hasWords, false);
});

test("metadata tags are extracted, not shown", () => {
	const l = parseLRC("[ti:Song]\n[ar:Artist]\n[al:Album]\n[by:Me]\n[length: 03:20]\n[00:01.00]line");
	assert.equal(l.meta.ti, "Song");
	assert.equal(l.meta.ar, "Artist");
	assert.equal(l.meta.al, "Album");
	assert.equal(l.meta.by, "Me");
	assert.equal(l.lines.length, 1);
});

test("[offset:] positive = lyrics earlier", () => {
	const l = parseLRC("[offset:+500]\n[00:02.00]x\n[00:04.00]y");
	assert.deepEqual(
		l.lines.map((x) => x.time),
		[1500, 3500],
	);
	const neg = parseLRC("[offset:-250]\n[00:02.00]x");
	assert.equal(neg.lines[0].time, 2250);
});

test("multiple timestamps per line are expanded and sorted", () => {
	const l = parseLRC("[00:10.00][00:30.00]chorus\n[00:20.00]verse");
	assert.deepEqual(
		l.lines.filter((x) => !x.gap).map((x) => [x.time, x.text]),
		[
			[10000, "chorus"],
			[20000, "verse"],
			[30000, "chorus"],
		],
	);
});

test("end times: next line start, last line uses duration", () => {
	const l = parseLRC("[00:01.00]a\n[00:03.00]b", { duration: 10000 });
	assert.deepEqual(
		l.lines.map((x) => x.end),
		[3000, 10000],
	);
});

test("intro gap is inserted when first line starts late; short gaps dropped; long gaps kept", () => {
	const l = parseLRC("[00:10.00]a\n[00:12.00]\n[00:13.00]b\n[00:20.00]\n[00:30.00]c", { duration: 40000 });
	assert.deepEqual(
		l.lines.map((x) => (x.gap ? `gap@${x.time}` : x.text)),
		["gap@0", "a", "b", "gap@20000", "c"],
	);
});

test("enhanced LRC word timing", () => {
	const l = parseLRC("[00:01.00]<00:01.00>Hello <00:01.50>big <00:02.00>world<00:02.80>\n[00:04.00]next");
	const [line] = l.lines;
	assert.equal(l.hasWords, true);
	assert.equal(line.text, "Hello big world");
	assert.deepEqual(
		line.words.map((w) => [w.time, w.end, w.text]),
		[
			[1000, 1500, "Hello "],
			[1500, 2000, "big "],
			[2000, 2800, "world"],
		],
	);
	assert.equal(l.lines[1].words, null);
});

test("enhanced LRC without trailing tag ends last word at line end", () => {
	const l = parseLRC("[00:01.00]<00:01.00>a <00:01.50>b\n[00:03.00]c");
	assert.equal(l.lines[0].words[1].end, 3000);
});

test("A2 voice prefix is stripped", () => {
	const l = parseLRC("[00:01.00]v1: <00:01.00>Hi <00:01.40>there");
	assert.equal(l.lines[0].text, "Hi there");
});

test("plain text: stanzas preserved, metadata removed, not synced", () => {
	const l = parseLyricsText("[ti:X]\n\nLine one\nLine two\n\n\nLine three\n\n");
	assert.equal(l.synced, false);
	assert.equal(l.meta.ti, "X");
	assert.deepEqual(
		l.lines.map((x) => (x.gap ? "—" : x.text)),
		["Line one", "Line two", "—", "Line three"],
	);
});

test("plain text keeps section labels like [Chorus: Name]", () => {
	const l = parsePlain("[Chorus: Someone]\nla la");
	assert.equal(l.lines[0].text, "[Chorus: Someone]");
});

test("looksSynced / hasContent", () => {
	assert.equal(looksSynced("[ar:x]\nhello"), false);
	assert.equal(looksSynced("[ar:x]\n[00:01.00]hello"), true);
	assert.equal(hasContent(parseLRC("[00:01.00]")), false);
	assert.equal(hasContent(parseLRC("[00:01.00]hi")), true);
});

test("findLineIndex binary search", () => {
	const lines = [{ time: 0 }, { time: 1000 }, { time: 2000 }, { time: 5000 }];
	assert.equal(findLineIndex(lines, -1), -1);
	assert.equal(findLineIndex(lines, 0), 0);
	assert.equal(findLineIndex(lines, 1999), 1);
	assert.equal(findLineIndex(lines, 2000), 2);
	assert.equal(findLineIndex(lines, 99999), 3);
	assert.equal(findLineIndex([], 5), -1);
});

test("toLRC round-trips synced + word lyrics", () => {
	const src = "[00:01.00]<00:01.00>Hello <00:01.50>world<00:02.00>\n[00:04.00]plain line\n[00:06.00]x";
	const a = parseLRC(src, { duration: 9000 });
	const b = parseLRC(toLRC(a), { duration: 9000 });
	assert.deepEqual(b.lines, a.lines);
});

test("toLRC formats minute boundaries correctly", () => {
	const out = toLRC({ synced: true, lines: [{ time: 59999, text: "x", words: null }] });
	assert.equal(out, "[01:00.00]x");
});
