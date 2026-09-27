import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAnalysis, beatIndexAt } from "../src/beats.js";
import { emptyStats, validStats, addTime, addLine, pruneStats, streak, summarize, dayKey, fmtDuration } from "../src/stats.js";

const analysis = (bpm, n, extra = {}) => {
	const step = 60 / bpm;
	return {
		track: { tempo: bpm },
		beats: Array.from({ length: n }, (_, i) => ({ start: 0.5 + i * step, duration: step, confidence: 0.8 })),
		bars: Array.from({ length: Math.ceil(n / 4) }, (_, i) => ({ start: 0.5 + i * 4 * step })),
		sections: [
			{ start: 0, loudness: -20 },
			{ start: 30, loudness: -5 },
		],
		...extra,
	};
};

test("parseAnalysis: beats and bars in ms, tempo, section energy", () => {
	const g = parseAnalysis(analysis(120, 40));
	assert.equal(g.beats[0], 500);
	assert.equal(g.beats[1], 1000);
	assert.equal(g.bars[1], 2500);
	assert.equal(g.tempo, 120);
	assert.ok(g.sections[1].energy > g.sections[0].energy);
	assert.ok(g.sections.every((s) => s.energy >= 0 && s.energy <= 1));
});

test("parseAnalysis: falls back sensibly, rejects empty data", () => {
	assert.equal(parseAnalysis(null), null);
	assert.equal(parseAnalysis({ beats: [] }), null);
	// No tempo: taken from the beat spacing. No bars: every fourth beat.
	const g = parseAnalysis(analysis(100, 20, { track: {}, bars: [] }));
	assert.ok(Math.abs(g.tempo - 100) < 1);
	assert.equal(g.bars.length, 5);
});

test("beatIndexAt finds the last beat at or before a position", () => {
	const t = [500, 1000, 1500];
	assert.equal(beatIndexAt(t, 0), -1);
	assert.equal(beatIndexAt(t, 500), 0);
	assert.equal(beatIndexAt(t, 1499), 1);
	assert.equal(beatIndexAt(t, 9999), 2);
});

const T0 = new Date(2026, 8, 27, 12).getTime();
const DAY = 86400000;
const song = (n) => ({ uri: `spotify:track:${n}`, title: `Song ${n}`, artist: n % 2 ? "Artist A, Guest" : "Artist B" });

test("stats: time, plays and lines per song, day and theme", () => {
	const s = emptyStats(T0);
	addTime(s, { ms: 30000, now: T0, track: song(1), theme: "neon", fresh: true });
	addTime(s, { ms: 30000, now: T0, track: song(1), theme: "neon" });
	addTime(s, { ms: 90000, now: T0, track: song(2), theme: "zen", fresh: true });
	addLine(s, song(1).uri);
	addLine(s, song(1).uri);
	assert.equal(s.ms, 150000);
	assert.equal(s.days[dayKey(T0)], 150000);
	assert.equal(s.songs[song(1).uri].n, 1);
	assert.equal(s.songs[song(1).uri].l, 2);
	const sum = summarize(s, T0);
	assert.equal(sum.songCount, 2);
	assert.equal(sum.topSongs[0].title, "Song 2");
	assert.equal(sum.topArtists[0].name, "Artist B"); // featured artists don't split the count
	assert.equal(sum.topArtists[1].name, "Artist A");
	assert.equal(sum.favTheme.id, "zen");
	assert.equal(sum.lastDays.length, 14);
	assert.equal(sum.lastDays.at(-1).ms, 150000);
});

test("stats: streak counts days in a row with at least a minute", () => {
	const s = emptyStats(T0);
	for (const d of [1, 2, 3]) addTime(s, { ms: 70000, now: T0 - d * DAY, track: song(1) });
	assert.equal(streak(s, T0), 3); // today not started yet: yesterday keeps the streak
	addTime(s, { ms: 70000, now: T0, track: song(1) });
	assert.equal(streak(s, T0), 4);
	addTime(s, { ms: 10000, now: T0 - 5 * DAY, track: song(1) }); // too short to count
	assert.equal(streak(s, T0), 4);
});

test("stats: pruning and repair", () => {
	const s = emptyStats(T0);
	for (let i = 0; i < 450; i++) addTime(s, { ms: 1000 + i, now: T0 - (i % 200) * DAY, track: song(i) });
	pruneStats(s);
	assert.equal(Object.keys(s.songs).length, 400);
	assert.ok(!s.songs[song(0).uri]); // the least-listened go first
	assert.equal(Object.keys(s.days).length, 120);
	assert.equal(validStats({ nonsense: true }, T0).ms, 0);
	assert.equal(validStats(null, T0).v, 1);
});

test("fmtDuration", () => {
	assert.equal(fmtDuration(45000), "45 s");
	assert.equal(fmtDuration(12 * 60000), "12 min");
	assert.equal(fmtDuration(192 * 60000), "3 h 12 min");
	assert.equal(fmtDuration(120 * 60000), "2 h");
});
