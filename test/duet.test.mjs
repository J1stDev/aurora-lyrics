import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLRC, voiceToSinger } from "../src/lrc.js";
import { parseTTML } from "../src/formats.js";
import { migrateLegacyKeys } from "../src/storage.js";

const sung = (l) => l.lines.filter((x) => !x.gap);

test("voiceToSinger: v1 lead, v2 second, v1000 group", () => {
	assert.equal(voiceToSinger(1), 0);
	assert.equal(voiceToSinger(2), 1);
	assert.equal(voiceToSinger(3), 0);
	assert.equal(voiceToSinger(1000), 2);
	assert.equal(voiceToSinger(0), null);
});

test("LRC voice markers become singers and are stripped from the text", () => {
	const l = parseLRC("[00:01.00]v1: Hello there\n[00:03.00]v2:<00:03.00>Hi <00:03.50>back\n[00:05.00]v1000: Together\n[00:07.00]No marker");
	assert.deepEqual(
		sung(l).map((x) => [x.text, x.singer, !!x.opposite]),
		[
			["Hello there", 0, false],
			["Hi back", 1, true],
			["Together", 2, false],
			["No marker", undefined, false],
		],
	);
});

test("TTML agents: people alternate in order of appearance, groups are 2", () => {
	const xml = `<tt xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><head><metadata>
		<ttm:agent type="person" xml:id="v2"/><ttm:agent type="person" xml:id="v1"/><ttm:agent type="group" xml:id="v1000"/>
	</metadata></head><body><div>
		<p begin="1.0" end="2.0" ttm:agent="v2">First voice</p>
		<p begin="3.0" end="4.0" ttm:agent="v1">Second voice</p>
		<p begin="5.0" end="6.0" ttm:agent="v1000">Everyone</p>
		<p begin="7.0" end="8.0" ttm:agent="v2">First again</p>
	</div></body></tt>`;
	const l = parseTTML(xml, 9000);
	assert.deepEqual(sung(l).map((x) => [x.text, x.singer]), [["First voice", 0], ["Second voice", 1], ["Everyone", 2], ["First again", 0]]);
	assert.equal(sung(l)[1].opposite, true);
});

test("TTML with a single agent has no singers", () => {
	const l = parseTTML(`<tt><body><p begin="1" end="2" ttm:agent="v1">Solo</p><p begin="3" end="4" ttm:agent="v1">Still solo</p></body></tt>`, 5000);
	assert.ok(sung(l).every((x) => x.singer === undefined));
});

test("migrateLegacyKeys moves old-prefix keys and never overwrites new ones", () => {
	const m = new Map([
		["fullscreen-animated-lyrics:settings", '{"a":1}'],
		["user123:fullscreen-animated-lyrics:local:x", "old-local"],
		["fullscreen-animated-lyrics:mxm-token", "old-token"],
		["aurora-lyrics:mxm-token", "new-token"],
		["unrelated", "keep"],
	]);
	const ls = {
		get length() { return m.size; },
		key: (i) => [...m.keys()][i] ?? null,
		getItem: (k) => (m.has(k) ? m.get(k) : null),
		setItem: (k, v) => m.set(k, String(v)),
		removeItem: (k) => m.delete(k),
	};
	assert.equal(migrateLegacyKeys(ls), 2);
	assert.equal(m.get("aurora-lyrics:settings"), '{"a":1}');
	assert.equal(m.get("user123:aurora-lyrics:local:x"), "old-local");
	assert.equal(m.get("aurora-lyrics:mxm-token"), "new-token");
	assert.equal(m.get("unrelated"), "keep");
	assert.ok(![...m.keys()].some((k) => k.includes("fullscreen-animated-lyrics")));
});
