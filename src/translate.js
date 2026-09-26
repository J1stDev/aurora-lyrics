// Line-by-line lyric translation.
//
// Uses Google's Chrome-dictionary translate endpoint (clients5.google.com/translate_a/t,
// client=dict-chrome-ex): CORS-enabled, no key, accepts many `q` values in one form POST
// (a "simple" request, no preflight) and answers with one [translation, detectedLang] per q,
// in order — so lines can never drift out of alignment. (The better-known translate_a/single
// "gtx" endpoint is aggressively rate-limited per IP.)
//
// Only unique lines are sent; results are cached per song + target language.

import { EXT_ID } from "./util.js";
import { store } from "./storage.js";

const ENDPOINT = "https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto";
const CHUNK_CHARS = 3500; // keep each POST comfortably small
const CACHE_PREFIX = `${EXT_ID}:tr:`;
const CACHE_INDEX = `${EXT_ID}:tr-index`;
const CACHE_MAX = 60;

/** Target languages offered in settings ([code, label]); "auto" = Spotify's UI language. */
export const TRANSLATE_LANGS = [
	["auto", "Spotify language"],
	["en", "English"],
	["tr", "Türkçe"],
	["es", "Español"],
	["fr", "Français"],
	["de", "Deutsch"],
	["it", "Italiano"],
	["pt", "Português"],
	["nl", "Nederlands"],
	["pl", "Polski"],
	["sv", "Svenska"],
	["ru", "Русский"],
	["uk", "Українська"],
	["ar", "العربية"],
	["fa", "فارسی"],
	["he", "עברית"],
	["hi", "हिन्दी"],
	["id", "Bahasa Indonesia"],
	["vi", "Tiếng Việt"],
	["th", "ไทย"],
	["ja", "日本語"],
	["ko", "한국어"],
	["zh-CN", "中文 (简体)"],
	["zh-TW", "中文 (繁體)"],
	["el", "Ελληνικά"],
	["cs", "Čeština"],
	["ro", "Română"],
	["hu", "Magyar"],
];

/** Resolve "auto" to Spotify's UI language, in the codes Google expects. */
export function resolveTarget(setting) {
	if (setting && setting !== "auto") return setting;
	let loc = "en";
	try {
		loc = globalThis.Spicetify?.Locale?.getLocale?.() || navigator.language || "en";
	} catch {
		/* ignore */
	}
	loc = String(loc).replace("_", "-");
	if (/^zh-(TW|HK|Hant)/i.test(loc)) return "zh-TW";
	if (/^zh/i.test(loc)) return "zh-CN";
	return loc.split("-")[0].toLowerCase();
}

const base = (code) => String(code || "").toLowerCase().split("-")[0];
const comparable = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Parse the endpoint's answer: [[text, lang], …] for several q, or [text, lang] for one. */
export function parseDictResponse(json, count) {
	if (!Array.isArray(json)) return null;
	const rows = count === 1 && typeof json[0] === "string" ? [json] : json;
	if (rows.length !== count) return null;
	return rows.map((r) => (Array.isArray(r) ? { text: String(r[0] ?? ""), lang: r[1] || null } : { text: String(r ?? ""), lang: null }));
}

async function translateChunk(texts, target, signal) {
	const body = texts.map((t) => `q=${encodeURIComponent(t)}`).join("&");
	const res = await fetch(`${ENDPOINT}&tl=${encodeURIComponent(target)}`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
		signal,
	});
	if (res.status === 429) throw new Error("The translation service is busy right now — try again in a minute");
	if (!res.ok) throw new Error(`Translation failed (HTTP ${res.status})`);
	const rows = parseDictResponse(await res.json(), texts.length);
	if (!rows) throw new Error("Unexpected answer from the translation service");
	return rows;
}

/** djb2 hash of the lyric text, so a cache entry is tied to these exact lines. */
function hash(s) {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}

function cacheGet(key) {
	return store.getJSON(CACHE_PREFIX + key);
}
function cacheSet(key, value) {
	const idx = (store.getJSON(CACHE_INDEX, []) || []).filter((k) => k !== key);
	idx.push(key);
	while (idx.length > CACHE_MAX) store.remove(CACHE_PREFIX + idx.shift());
	store.setJSON(CACHE_PREFIX + key, value);
	store.setJSON(CACHE_INDEX, idx);
}

const trInflight = new Map();

/**
 * Translate a Lyrics object's lines.
 * @returns {Promise<{ lines: (string|null)[], sameLanguage: boolean, sourceLang: string|null }>}
 *   lines[i] is the translation for lyrics.lines[i], or null (gap, same language, unchanged).
 *   sameLanguage = the whole song is already in the target language.
 */
export function translateLyrics(lyrics, target, { signal } = {}) {
	const texts = lyrics.lines.map((l) => (l.gap ? "" : String(l.text || "").trim()));
	const key = `${target}:${hash(texts.join("\n"))}`;
	const cached = cacheGet(key);
	if (cached) return Promise.resolve(cached);
	if (trInflight.has(key)) return trInflight.get(key);

	const p = (async () => {
		const unique = [...new Set(texts.filter(Boolean))];
		const byText = new Map();
		let chunk = [];
		let size = 0;
		const flush = async () => {
			if (!chunk.length) return;
			const rows = await translateChunk(chunk, target, signal);
			chunk.forEach((t, i) => byText.set(t, rows[i]));
			chunk = [];
			size = 0;
		};
		for (const t of unique) {
			if (size + t.length > CHUNK_CHARS) await flush();
			chunk.push(t);
			size += t.length + 3;
		}
		await flush();

		// A line needs no translation if it's already in the target language or came back unchanged.
		let foreign = 0;
		const langCount = new Map();
		const lines = texts.map((t) => {
			if (!t) return null;
			const r = byText.get(t);
			if (!r) return null;
			if (r.lang) langCount.set(r.lang, (langCount.get(r.lang) || 0) + 1);
			if ((r.lang && base(r.lang) === base(target)) || comparable(r.text) === comparable(t) || !r.text.trim()) return null;
			foreign++;
			return r.text.trim();
		});
		const sourceLang = [...langCount].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
		const result = { lines, sameLanguage: foreign === 0, sourceLang };
		cacheSet(key, result);
		return result;
	})().finally(() => trInflight.delete(key));
	trInflight.set(key, p);
	return p;
}
