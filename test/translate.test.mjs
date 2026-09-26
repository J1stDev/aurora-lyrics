import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { translateLyrics, parseDictResponse, resolveTarget } from "../src/translate.js";

const lyr = (...texts) => ({ synced: true, lines: texts.map((t, i) => (t === null ? { time: i * 1000, text: "", gap: true } : { time: i * 1000, text: t })) });

let calls;
function installFetch(translate) {
	calls = [];
	globalThis.fetch = async (url, opts) => {
		const qs = new URLSearchParams(opts.body).getAll("q");
		calls.push({ url: String(url), qs });
		const rows = qs.map((q) => translate(q));
		return { ok: true, status: 200, json: async () => (rows.length === 1 ? rows[0] : rows) };
	};
}

beforeEach(() => {
	const mem = new Map();
	globalThis.Spicetify = { LocalStorage: { get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, v), remove: (k) => mem.delete(k) }, Locale: { getLocale: () => "pt-BR" } };
});

test("parseDictResponse handles one and many q", () => {
	assert.deepEqual(parseDictResponse(["hello", "es"], 1), [{ text: "hello", lang: "es" }]);
	assert.deepEqual(parseDictResponse([["a", "ja"], ["b", "ja"]], 2), [
		{ text: "a", lang: "ja" },
		{ text: "b", lang: "ja" },
	]);
	assert.equal(parseDictResponse([["a", "ja"]], 2), null, "count mismatch is rejected (never misalign lines)");
});

test("resolveTarget maps Spotify locales to Google codes", () => {
	assert.equal(resolveTarget("auto"), "pt");
	assert.equal(resolveTarget("tr"), "tr");
	globalThis.Spicetify.Locale.getLocale = () => "zh-TW";
	assert.equal(resolveTarget("auto"), "zh-TW");
});

test("translates foreign lines, keeps alignment, sends each unique line once", async () => {
	installFetch((q) => [`EN(${q})`, "ja"]);
	const res = await translateLyrics(lyr("一", null, "二", "一"), "en");
	assert.deepEqual(res.lines, ["EN(一)", null, "EN(二)", "EN(一)"]);
	assert.equal(res.sameLanguage, false);
	assert.equal(res.sourceLang, "ja");
	assert.deepEqual(calls[0].qs, ["一", "二"], "chorus repeat translated once, gaps skipped");
	assert.match(calls[0].url, /tl=en/);
});

test("mixed-language song: lines already in the target language get no translation", async () => {
	installFetch((q) => (/^[a-z ]+$/i.test(q) ? [q, "en"] : [`EN(${q})`, "ko"]));
	const res = await translateLyrics(lyr("사랑해", "baby baby", "보고 싶어"), "en");
	assert.deepEqual(res.lines, ["EN(사랑해)", null, "EN(보고 싶어)"]);
});

test("song already in the target language → sameLanguage, no lines", async () => {
	installFetch((q) => [q, "en"]);
	const res = await translateLyrics(lyr("hello there", "goodbye"), "en");
	assert.equal(res.sameLanguage, true);
	assert.deepEqual(res.lines, [null, null]);
});

test("results are cached per song text + language", async () => {
	installFetch((q) => [`TR(${q})`, "en"]);
	await translateLyrics(lyr("one line"), "tr");
	await translateLyrics(lyr("one line"), "tr");
	assert.equal(calls.length, 1);
	await translateLyrics(lyr("one line"), "de");
	assert.equal(calls.length, 2, "another language is a new request");
});

test("large songs are split into several requests", async () => {
	installFetch((q) => [`x${q}`, "ja"]);
	const long = Array.from({ length: 80 }, (_, i) => `${"長い歌詞の行".repeat(12)} ${i}`);
	const res = await translateLyrics(lyr(...long), "en");
	assert.ok(calls.length > 1);
	assert.equal(res.lines.filter(Boolean).length, 80);
});

test("rate limiting surfaces a friendly error", async () => {
	globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
	await assert.rejects(translateLyrics(lyr("残念"), "en"), /busy/);
});
