import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSongsterr, instrumentKind, songsterrSearchUrl } from "../src/tabs.js";

const track = { title: "Blinding Lights", artist: "The Weeknd" };
const results = [
	{ songId: 1, artist: "Cover Band", title: "Blinding Lights", tracks: [] },
	{
		songId: 469960,
		artist: "The Weeknd",
		title: "Blinding Lights",
		tracks: [
			{ instrument: "Electric Guitar (clean)", name: "Guitar", difficulty: 4 },
			{ instrument: "Acoustic Guitar (steel)", name: "Guitar 2", difficulty: 2 },
			{ instrument: "Fretless Bass", name: "Bass", difficulty: 2 },
			{ instrument: "Drums", name: "Drums" },
			{ instrument: "Choir Aahs", name: "Backing Vocals" },
		],
	},
];

test("pickSongsterr finds the right song and summarises its parts", () => {
	const r = pickSongsterr(results, track);
	assert.equal(r.url, "https://www.songsterr.com/a/wsa/the-weeknd-blinding-lights-tab-s469960");
	assert.deepEqual(r.parts, { guitar: 2, bass: 1, drums: 1, vocals: 1, other: 0 });
	assert.equal(r.difficulty, 4);
});

test("pickSongsterr rejects covers and junk", () => {
	assert.equal(pickSongsterr(results.slice(0, 1), track), null);
	assert.equal(pickSongsterr(null, track), null);
});

test("instrument kinds and search URL", () => {
	assert.equal(instrumentKind({ instrument: "Synth Bass 1" }), "bass");
	assert.equal(instrumentKind({ instrument: "Overdriven Guitar" }), "guitar");
	assert.equal(instrumentKind({ instrument: "Lead 8 (bass + lead)" }), "bass");
	assert.equal(songsterrSearchUrl(track), "https://www.songsterr.com/?pattern=The%20Weeknd%20Blinding%20Lights");
});
