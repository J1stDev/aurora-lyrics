import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTTML, parseClock, parseYrc, fromMusixmatch, alignWordsToText, isNeteaseCredit } from "../src/formats.js";
import { estimateWords, parseLRC, syllables } from "../src/lrc.js";
import { pickNeteaseSong, mxmMatches } from "../src/sources.js";
import { sameSong, artistMatches } from "../src/util.js";
import { DEFAULTS, PROVIDER_INFO } from "../src/settings.js";

const mainLines = (l) => l.lines.filter((x) => !x.gap);

test("parseClock handles TTML time forms", () => {
	assert.equal(parseClock("00:01.500"), 1500);
	assert.equal(parseClock("1:02:03.5"), 3723500);
	assert.equal(parseClock("12.25"), 12250);
	assert.equal(parseClock("3.5s"), 3500);
	assert.equal(parseClock("1250ms"), 1250);
	assert.equal(parseClock(""), null);
});

test("TTML: word spans, syllables without spaces, entities and background vocals", () => {
	const ttml = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div>
		<p begin="00:01.000" end="00:04.000"><span begin="00:01.000" end="00:01.500">Rock</span> <span begin="00:01.500" end="00:01.800">&amp;</span> <span begin="00:02.000" end="00:02.300">ro</span><span begin="00:02.300" end="00:03.000">ll</span><span ttm:role="x-bg"><span begin="00:03.000" end="00:03.500">(yeah</span> <span begin="00:03.500" end="00:04.000">yeah)</span></span></p>
		<p begin="00:05.000" end="00:07.000"><span begin="00:05.000" end="00:07.000">Next</span></p>
	</div></body></tt>`;
	const l = parseTTML(ttml, 10000);
	assert.equal(l.synced, true);
	assert.equal(l.hasWords, true);
	const [first, second] = mainLines(l);
	assert.equal(first.text, "Rock & roll");
	assert.deepEqual(
		first.words.map((w) => w.text),
		["Rock ", "& ", "ro", "ll"],
	);
	assert.equal(first.bg.text, "yeah yeah");
	assert.deepEqual(
		first.bg.words.map((w) => [w.time, w.text.trim()]),
		[
			[3000, "yeah"],
			[3500, "yeah"],
		],
	);
	assert.equal(second.text, "Next");
});

test("TTML without timing becomes plain text", () => {
	const l = parseTTML("<tt><body><div><p>One</p><p>Two</p></div></body></tt>");
	assert.equal(l.synced, false);
	assert.deepEqual(
		l.lines.map((x) => x.text),
		["One", "Two"],
	);
});

test("YRC: word timing, credit lines and JSON lines skipped", () => {
	const l = parseYrc('{"t":0,"c":[]}\n[0,900](0,900,0)作曲 : someone\n[1000,2000](1000,500,0)Hi (1500,500,0)there\n[4000,1000](4000,1000,0)bye', 6000);
	const lines = mainLines(l);
	assert.deepEqual(
		lines.map((x) => x.text),
		["Hi there", "bye"],
	);
	assert.deepEqual(
		lines[0].words.map((w) => [w.time, w.end, w.text]),
		[
			[1000, 1500, "Hi "],
			[1500, 2000, "there"],
		],
	);
	assert.equal(isNeteaseCredit("制作人 : x"), true);
	assert.equal(isNeteaseCredit("Hello: world"), false);
});

test("alignWordsToText leaves already-spaced words alone", () => {
	const words = [{ text: "a " }, { text: "b" }];
	assert.equal(alignWordsToText(words, "a b"), words);
	assert.deepEqual(words.map((w) => w.text), ["a ", "b"]);
});

test("Musixmatch: falls back from richsync → subtitles → plain; instrumental/404", () => {
	const ok = (body) => ({ message: { header: { status_code: 200 }, body } });
	const matcher = (track = {}) => ({ "matcher.track.get": ok({ track }) });
	const subs = fromMusixmatch({ ...matcher(), "track.subtitles.get": ok({ subtitle_list: [{ subtitle: { subtitle_body: JSON.stringify([{ text: "line", time: { total: 1.5 } }]) } }] }) }, 5000);
	assert.equal(subs.status, "found");
	assert.equal(mainLines(subs.lyrics)[0].time, 1500);
	// Desktop API: subtitle_body is LRC text, not JSON.
	const lrc = fromMusixmatch({ ...matcher(), "track.subtitles.get": ok({ subtitle_list: [{ subtitle: { subtitle_body: "[00:12.00]first\n[00:16.50]second\n" } }] }) }, 30000);
	assert.equal(lrc.status, "found");
	assert.equal(lrc.lyrics.synced, true);
	assert.deepEqual(
		mainLines(lrc.lyrics).map((x) => x.time),
		[12000, 16500],
	);
	const plain = fromMusixmatch({ ...matcher(), "track.lyrics.get": ok({ lyrics: { lyrics_body: "a\nb\n\n******* This Lyrics is NOT for Commercial use *******\n(1409)" } }) });
	assert.deepEqual(
		plain.lyrics.lines.map((x) => x.text),
		["a", "b"],
	);
	assert.equal(fromMusixmatch(matcher({ instrumental: 1 })).instrumental, true);
	assert.equal(fromMusixmatch({ "matcher.track.get": { message: { header: { status_code: 404 } } } }).status, "notfound");
	assert.equal(fromMusixmatch({ "matcher.track.get": { message: { header: { status_code: 401, hint: "renew" } } } }).status, "auth");
});

test("pickNeteaseSong requires duration within 3s and a name match", () => {
	const t = { title: "Song", artist: "Band", album: "LP", duration: 180000 };
	const songs = [
		{ id: 1, name: "Song", artists: [{ name: "Band" }], duration: 240000 },
		{ id: 2, name: "Song (Live)", artists: [{ name: "Other" }], duration: 180500 },
		{ id: 3, name: "Song", artists: [{ name: "Band" }], duration: 181000 },
	];
	assert.equal(pickNeteaseSong(songs, t).id, 3);
	assert.equal(pickNeteaseSong([songs[1]], t), null);
	// Same title + duration but a different artist (e.g. a cover in another language): rejected
	// unless the duration is almost identical (artist names are often written differently).
	assert.equal(pickNeteaseSong([{ id: 9, name: "Song", artists: [{ name: "Cover" }], duration: 182500 }], t), null);
	assert.equal(pickNeteaseSong([{ id: 10, name: "Song", artists: [{ name: "バンド" }], duration: 180300 }], t).id, 10);
});

test("estimateWords spreads a line's time across its words", () => {
	const l = estimateWords(parseLRC("[00:01.00]one two three\n[00:04.00]next", { duration: 8000 }));
	assert.equal(l.estimated, true);
	const words = mainLines(l)[0].words;
	assert.equal(words.length, 3);
	assert.equal(words[0].time, 1000);
	assert.ok(words[2].end <= 4000);
	assert.ok(words[1].time > words[0].time && words[2].time > words[1].time);
	// CJK without spaces splits per character.
	const cjk = estimateWords(parseLRC("[00:01.00]你好世界\n[00:04.00]x", { duration: 6000 }));
	assert.equal(mainLines(cjk)[0].words.length, 4);
});

test("syllables: rough counts across scripts", () => {
	assert.equal(syllables("love"), 1);
	assert.equal(syllables("moved"), 1);
	assert.equal(syllables("wanted"), 2);
	assert.equal(syllables("beautiful,"), 3);
	assert.equal(syllables("little"), 2);
	assert.equal(syllables("corazón"), 3);
	assert.equal(syllables("любовь"), 2);
	assert.equal(syllables("사랑해"), 3);
	assert.equal(syllables("きょう"), 2);
	assert.equal(syllables("hmm"), 1);
});

test("estimateWords: syllable weighting, song pace, breath after commas, held last word", () => {
	// Tight lines set a fast pace; a long line (instrumental tail) must not crawl to its end.
	const lrc = [
		"[00:01.00]I can see it in your eyes tonight", // 9 syllables in 2.5 s
		"[00:03.50]Every word you say is a lie", // 8 in 2.5 s
		"[00:06.00]Running out of time to find you", // 8 in 2.5 s
		"[00:08.50]Hold on, strength", // 3 syllables, 11.5 s slot
		"[00:20.00]end",
	].join("\n");
	const l = mainLines(estimateWords(parseLRC(lrc, { duration: 30000 })));
	const [a, , , d] = l;
	// Longer words get more time than one-syllable ones.
	const eyes = a.words.find((w) => w.text.startsWith("eyes"));
	const tonight = a.words.find((w) => w.text.startsWith("tonight"));
	assert.ok(tonight.end - tonight.time > eyes.end - eyes.time);
	// Short line in a long slot finishes within a couple of seconds.
	assert.ok(d.words.at(-1).end - d.time < 3000, `sung over ${d.words.at(-1).end - d.time} ms`);
	// A breath after "on," leaves a gap before the next word.
	assert.ok(d.words[2].time > d.words[1].end);
	// Words stay in order and inside their line.
	for (const line of l) {
		for (let i = 0; i < line.words.length; i++) {
			const w = line.words[i];
			assert.ok(w.end >= w.time && w.time >= line.time && w.end <= line.end);
			if (i) assert.ok(w.time >= line.words[i - 1].end);
		}
	}
});

test("settings: provider defaults cover every provider once", () => {
	assert.deepEqual(
		DEFAULTS.providers.map((p) => p.id),
		PROVIDER_INFO.map((p) => p.id),
	);
});

test("sameSong / artistMatches / mxmMatches", () => {
	const t = { title: "Blinding Lights - 2020 Remaster", artist: "The Weeknd", duration: 200040 };
	assert.equal(sameSong(t, { title: "Blinding Lights", artists: ["The Weeknd"], durationMs: 201000 }), true);
	assert.equal(sameSong(t, { title: "Blinding Lights", artists: ["Cover Band"], durationMs: 200000 }), false);
	assert.equal(sameSong(t, { title: "Blinding Lights", artists: ["The Weeknd"], durationMs: 260000 }), false);
	assert.equal(artistMatches("Dua Lipa, DaBaby", ["DaBaby & Dua Lipa"]), true);
	assert.equal(artistMatches("A", ["AB"]), false);
	assert.equal(mxmMatches(t, { track_name: "NOKIA", artist_name: "Drake", track_length: 241 }), false);
	assert.equal(mxmMatches(t, { track_name: "Blinding Lights", artist_name: "The Weeknd", track_length: 200 }), true);
});

test("artistMatches handles localized NetEase artist names", () => {
	assert.equal(artistMatches("BTS", ["BTS (防弹少年团)"]), true);
	assert.equal(artistMatches("BTS", ["BTSX Tribute"]), false);
});

test("Paxsenix Apple Music JSON: syllables, spaces, background vocals, duet side", async () => {
	const { fromPaxsenixApple } = await import("../src/formats.js");
	const l = fromPaxsenixApple(
		{
			type: "Syllable",
			content: [
				{
					timestamp: 1000,
					endtime: 3000,
					oppositeTurn: false,
					text: [
						{ text: "Hel", timestamp: 1000, endtime: 1300, part: true },
						{ text: "lo", timestamp: 1300, endtime: 1600, part: false },
						{ text: "world", timestamp: 1700, endtime: 2400, part: false },
					],
					backgroundText: [
						{ text: "(ooh", timestamp: 2400, endtime: 2700, part: false },
						{ text: "yeah)", timestamp: 2700, endtime: 3000, part: false },
					],
				},
				{ timestamp: 4000, endtime: 5000, oppositeTurn: true, text: [{ text: "Other", timestamp: 4000, endtime: 5000, part: false }], backgroundText: [] },
			],
		},
		8000,
	);
	const [a, b] = mainLines(l);
	assert.equal(l.hasWords, true);
	assert.equal(a.text, "Hello world");
	assert.deepEqual(
		a.words.map((w) => w.text),
		["Hel", "lo ", "world "],
	);
	assert.equal(a.bg.text, "ooh yeah");
	assert.equal(a.opposite, undefined);
	assert.equal(b.opposite, true);
	// Line-synced variant
	const line = fromPaxsenixApple({ type: "Line", content: [{ timestamp: 1000, text: [{ text: "Just a line", timestamp: 1000, endtime: 2000 }] }] }, 5000);
	assert.equal(line.hasWords, false);
	assert.equal(mainLines(line)[0].text, "Just a line");
});

test("pickItunesSong skips remixes / other artists / other lengths", async () => {
	const { pickItunesSong } = await import("../src/sources.js");
	const t = { title: "Blinding Lights", artist: "The Weeknd", album: "After Hours", duration: 200040 };
	const results = [
		{ kind: "song", trackId: 1, trackName: "Blinding Lights (Remix)", artistName: "The Weeknd & ROSALÍA", trackTimeMillis: 216123 },
		{ kind: "song", trackId: 2, trackName: "Blinding Lights", artistName: "Cover Band", trackTimeMillis: 200000 },
		{ kind: "song", trackId: 3, trackName: "Blinding Lights", artistName: "The Weeknd", trackTimeMillis: 200046, collectionName: "After Hours" },
	];
	assert.equal(pickItunesSong(results, t).trackId, 3);
	assert.equal(pickItunesSong(results.slice(0, 2), t), null);
});

test("settings: a newly added provider is inserted at its default rank", async () => {
	const mem = new Map([["aurora-lyrics:settings", JSON.stringify({ providers: [{ id: "unison", on: true }, { id: "lrclib", on: true }] })]]);
	globalThis.Spicetify = { LocalStorage: { get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, v), remove: (k) => mem.delete(k) } };
	const { settings } = await import(`../src/settings.js?fresh=${Date.now()}`);
	const ids = settings.get("providers").map((p) => p.id);
	assert.equal(ids[0], "paxsenix", "Apple Music goes first, as in the defaults");
	assert.ok(ids.indexOf("unison") < ids.indexOf("lrclib"), "user's own order kept");
});

test("estimateWords keeps a one-word line whole", () => {
	const l = mainLines(estimateWords(parseLRC("[00:01.00]Hello\n[00:02.00]世界\n[00:04.00]x", { duration: 6000 })));
	assert.equal(l[0].words.length, 1);
	assert.equal(l[1].words.length, 2);
	assert.equal(syllables("Hercules"), 3);
	assert.equal(syllables("places"), 2);
	assert.equal(syllables("times"), 1);
});
