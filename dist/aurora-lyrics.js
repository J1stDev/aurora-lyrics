// Aurora Lyrics v2.0.0 — full-screen animated lyrics for Spicetify
// Built from src/ by build.mjs — edit the sources, not this file.
// NAME: Aurora Lyrics
// AUTHOR: yamac
// DESCRIPTION: Full-screen animated, synced lyrics overlay for Spotify (Spicetify extension).

(function fullscreenAnimatedLyrics() {
"use strict";

// ---- util.js ---------------------------------------------------------------
// Small shared helpers. No Spicetify access here so this stays testable in Node.

const EXT_ID = "aurora-lyrics";

function clamp(v, min, max) {
	return Math.min(max, Math.max(min, v));
}

/** Tiny hyperscript helper: h("div", { class: "x", onclick }, child, "text") */
function h(tag, attrs, ...children) {
	const node = document.createElement(tag);
	if (attrs) {
		for (const [k, v] of Object.entries(attrs)) {
			if (v == null || v === false) continue;
			if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
			else if (k === "class") node.className = v;
			else if (k === "html") node.innerHTML = v;
			else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
			else if (k in node && typeof v !== "string") node[k] = v;
			else node.setAttribute(k, v === true ? "" : v);
		}
	}
	for (const c of children.flat()) {
		if (c == null || c === false) continue;
		node.append(c instanceof Node ? c : document.createTextNode(String(c)));
	}
	return node;
}

/**
 * Normalize a title/artist for fuzzy matching and cache keys:
 * lowercases, strips accents, "(feat. …)", "- Remastered 2011" etc.
 */
function normalizeTitle(s) {
	return String(s || "")
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/\s*[([](feat\.?|ft\.?|with)\s[^)\]]*[)\]]/g, "")
		.replace(/\s+-\s+.*(remaster|version|edit|mix|live|mono|stereo|deluxe).*$/g, "")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

function normalizeArtist(s) {
	// Only the primary artist matters for matching.
	return normalizeTitle(String(s || "").split(/,|&|\sfeat\.?\s|\sx\s/i)[0]);
}

/** Titles match if equal after normalising, or one extends the other ("Song" / "Song (Live)"). */
function titleMatches(a, b) {
	const x = normalizeTitle(a);
	const y = normalizeTitle(b);
	return !!x && !!y && (x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `));
}

/** True when any of the track's artists appears among the candidate artist strings. */
function artistMatches(trackArtist, candidates) {
	const split = (s) => String(s || "").split(/\s*(?:,|&|;|\/|\bfeat\.?|\bft\.?|\bwith\b|\sx\s)\s*/i);
	const wanted = split(trackArtist).map(normalizeTitle).filter((a) => a.length > 1);
	const got = candidates.flatMap(split).map(normalizeTitle).filter((a) => a.length > 1);
	const words = (s) => ` ${s} `;
	return wanted.some((w) =>
		got.some(
			(g) =>
				g === w ||
				// whole-word containment: "bts" in "bts 防弹少年团", "weeknd" in "the weeknd"
				words(g).includes(words(w)) ||
				words(w).includes(words(g)) ||
				(g.length > 3 && w.length > 3 && (g.includes(w) || w.includes(g))),
		),
	);
}

/**
 * Guard against a provider answering with a different song (wrong match, cover in another
 * language, or a decoy response): title AND artist must match, and duration if both are known.
 * @param {{title:string, artist:string, duration:number}} track   duration in ms
 * @param {{title:string, artists:string[], durationMs?:number}} cand
 * @param {number} toleranceMs
 */
function sameSong(track, cand, toleranceMs = 6000) {
	if (!titleMatches(track.title, cand.title) || !artistMatches(track.artist, cand.artists)) return false;
	if (track.duration && cand.durationMs && Math.abs(track.duration - cand.durationMs) > toleranceMs) return false;
	return true;
}

function nameKey(track) {
	return `${normalizeArtist(track.artist)}|${normalizeTitle(track.title)}`;
}

function formatMs(ms) {
	const sign = ms < 0 ? "−" : "+";
	return `${sign}${Math.abs(ms)}ms`;
}

/** requestAnimationFrame with a timer fallback (rAF can be throttled in occluded windows). */
function nextFrame(fn) {
	let done = false;
	const run = () => {
		if (done) return;
		done = true;
		fn();
	};
	requestAnimationFrame(run);
	setTimeout(run, 50);
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

/** fetch() with a timeout that also honours an outer AbortSignal. */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
	const outer = opts.signal;
	const onAbort = () => ctrl.abort(outer.reason);
	if (outer) {
		if (outer.aborted) ctrl.abort(outer.reason);
		else outer.addEventListener("abort", onAbort, { once: true });
	}
	try {
		return await fetch(url, { ...opts, signal: ctrl.signal });
	} finally {
		clearTimeout(timer);
		outer?.removeEventListener("abort", onAbort);
	}
}

/** Race a promise against a timeout (for APIs like CosmosAsync that take no signal). */
function withTimeout(promise, ms, label = "request") {
	let t;
	return Promise.race([
		promise,
		new Promise((_, rej) => {
			t = setTimeout(() => rej(new Error(`${label} timed out`)), ms);
		}),
	]).finally(() => clearTimeout(t));
}

// ---- storage.js ------------------------------------------------------------
// Key/value persistence. Prefers Spicetify.LocalStorage (namespaced per Spotify user
// in recent Spicetify builds), falls back to window.localStorage, then to memory.

const memory = new Map();

function backend() {
	const S = globalThis.Spicetify;
	if (S?.LocalStorage?.get && S?.LocalStorage?.set) return S.LocalStorage;
	try {
		if (globalThis.localStorage) {
			return {
				get: (k) => globalThis.localStorage.getItem(k),
				set: (k, v) => globalThis.localStorage.setItem(k, v),
				remove: (k) => globalThis.localStorage.removeItem(k),
			};
		}
	} catch {
		/* storage blocked */
	}
	return { get: (k) => (memory.has(k) ? memory.get(k) : null), set: (k, v) => memory.set(k, v), remove: (k) => memory.delete(k) };
}

/**
 * One-time move of data saved under the extension's old name ("fullscreen-animated-lyrics:…")
 * to the current prefix. Matches the prefix anywhere in the key, so it also works if the
 * storage layer adds its own namespace in front. Existing new keys are never overwritten.
 * @param {Storage} ls  anything with length / key() / getItem() / setItem() / removeItem()
 * @returns {number} keys moved
 */
function migrateLegacyKeys(ls, from = "fullscreen-animated-lyrics:", to = "aurora-lyrics:") {
	let moved = 0;
	try {
		const keys = [];
		for (let i = 0; i < ls.length; i++) {
			const k = ls.key(i);
			if (k && k.includes(from)) keys.push(k);
		}
		for (const k of keys) {
			const next = k.replace(from, to);
			if (ls.getItem(next) == null) {
				ls.setItem(next, ls.getItem(k));
				moved++;
			}
			ls.removeItem(k);
		}
	} catch (e) {
		console.warn("[aurora-lyrics] could not migrate old settings", e);
	}
	return moved;
}
try {
	if (globalThis.localStorage && typeof window !== "undefined") migrateLegacyKeys(globalThis.localStorage);
} catch {
	/* storage blocked */
}

const store = {
	getJSON(key, fallback = null) {
		try {
			const raw = backend().get(key);
			return raw == null ? fallback : JSON.parse(raw);
		} catch {
			return fallback;
		}
	},
	/** Returns false when the write failed (e.g. quota exceeded). */
	setJSON(key, value) {
		try {
			backend().set(key, JSON.stringify(value));
			return true;
		} catch (e) {
			console.warn("[aurora-lyrics] storage write failed", key, e);
			return false;
		}
	},
	remove(key) {
		try {
			backend().remove(key);
		} catch {
			/* ignore */
		}
	},
};

// ---- translate.js ----------------------------------------------------------
// Line-by-line lyric translation.
//
// Uses Google's Chrome-dictionary translate endpoint (clients5.google.com/translate_a/t,
// client=dict-chrome-ex): CORS-enabled, no key, accepts many `q` values in one form POST
// (a "simple" request, no preflight) and answers with one [translation, detectedLang] per q,
// in order — so lines can never drift out of alignment. (The better-known translate_a/single
// "gtx" endpoint is aggressively rate-limited per IP.)
//
// Only unique lines are sent; results are cached per song + target language.


const ENDPOINT = "https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto";
const CHUNK_CHARS = 3500; // keep each POST comfortably small
const CACHE_PREFIX = `${EXT_ID}:tr:`;
const CACHE_INDEX = `${EXT_ID}:tr-index`;
const CACHE_MAX = 60;

/** Target languages offered in settings ([code, label]); "auto" = Spotify's UI language. */
const TRANSLATE_LANGS = [
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
function resolveTarget(setting) {
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
function parseDictResponse(json, count) {
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
function translateLyrics(lyrics, target, { signal } = {}) {
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

// ---- settings.js -----------------------------------------------------------
// Settings schema, defaults, validation and persistence.
// The schema also drives the settings panel UI (see panel.js):
//   type: "range" | "select" | "toggle" | "color" | "providers"
//   ui (select only): "segmented" | "cards" | "fonts" | undefined (dropdown)


const SETTINGS_KEY = `${EXT_ID}:settings`;

/**
 * Font stacks. "web" fonts are loaded from Google Fonts on demand (only when selected);
 * every stack falls back to local fonts if the request is blocked.
 */
const FONTS = {
	spotify: { label: "Spotify Mix", stack: 'var(--encore-title-font-stack, "SpotifyMixUITitle", "SpotifyMixUI", "CircularSp", "Circular", "Helvetica Neue", system-ui, sans-serif)' },
	system: { label: "System", stack: '"Segoe UI Variable Display", "SF Pro Display", -apple-system, "Segoe UI", system-ui, sans-serif' },
	inter: { label: "Inter", web: "Inter:wght@500;700;800;900", stack: '"Inter", "Segoe UI Variable Display", system-ui, sans-serif' },
	outfit: { label: "Outfit", web: "Outfit:wght@500;700;800;900", stack: '"Outfit", "Segoe UI Variable Display", system-ui, sans-serif' },
	rounded: { label: "Rounded", web: "Nunito:wght@500;700;800;900", stack: '"SF Pro Rounded", ui-rounded, "Nunito", "Segoe UI Variable Display", system-ui, sans-serif' },
	serif: { label: "Serif", web: "Playfair+Display:wght@500;700;800;900", stack: '"Playfair Display", "Iowan Old Style", "Palatino Linotype", Georgia, serif' },
};

/**
 * Lyrics providers, in default priority order. "words" = can deliver word-level timing.
 * The user's order / on-off state is stored in settings.providers.
 */
const PROVIDER_INFO = [
	{ id: "paxsenix", label: "Apple Music", words: true, on: true, desc: "Apple Music's syllable-synced lyrics with background vocals and duets, via the community Paxsenix API." },
	{ id: "musixmatch", label: "Musixmatch", words: true, on: true, desc: "Line-synced and plain lyrics for most songs; word-by-word (richsync) when Musixmatch allows it." },
	{ id: "spotify", label: "Spotify", words: false, on: true, desc: "Spotify's own lyrics. Mostly line-synced." },
	{ id: "netease", label: "NetEase", words: true, on: true, desc: "NetEase Cloud Music. Word-by-word (YRC) and line lyrics; great for Asian music." },
	{ id: "lrclib", label: "LRCLIB", words: false, on: true, desc: "Open community database of line-synced and plain lyrics." },
	{ id: "unison", label: "Unison", words: true, on: true, desc: "Community TTML lyrics with word timing and background vocals." },
];

const SCHEMA = [
	// Layout
	{
		key: "view",
		section: "Layout",
		label: "Layout",
		type: "select",
		ui: "cards",
		options: [
			["split", "Split"],
			["mirror", "Mirrored"],
			["poster", "Poster"],
			["vinyl", "Vinyl"],
			["stage", "Stage"],
			["captions", "Captions"],
			["lyrics", "Lyrics only"],
		],
		hints: { split: "Cover left", mirror: "Cover right", poster: "Full-bleed art", vinyl: "Spinning record", stage: "Cover on top", captions: "Big art, 2 lines", lyrics: "Just the words" },
		default: "split",
	},
	// Theme ("accent" = "album" or a "#rrggbb" colour; used for glow, tints, karaoke, gradient)
	{ key: "accent", section: "Theme", label: "Accent colour", type: "color", default: "album" },
	// Text
	{ key: "font", section: "Text", label: "Font", type: "select", ui: "fonts", options: Object.entries(FONTS).map(([k, f]) => [k, f.label]), default: "spotify" },
	{ key: "fontSize", section: "Text", label: "Size", type: "range", min: 24, max: 104, step: 2, unit: "px", default: 56 },
	{ key: "fontWeight", section: "Text", label: "Weight", type: "select", ui: "segmented", options: [["500", "Medium"], ["700", "Bold"], ["800", "Heavy"], ["900", "Black"]], default: "800" },
	{ key: "lineSpacing", section: "Text", label: "Line spacing", type: "range", min: 0.1, max: 1.5, step: 0.05, unit: "em", default: 0.55 },
	{ key: "textAlign", section: "Text", label: "Alignment", type: "select", ui: "segmented", options: [["left", "Left"], ["center", "Center"], ["right", "Right"]], default: "left" },
	{ key: "textColor", section: "Text", label: "Colour", type: "select", ui: "segmented", options: [["white", "White"], ["accent", "Accent tint"]], default: "white" },
	{ key: "glow", section: "Text", label: "Glow", type: "select", ui: "segmented", options: [["off", "Off"], ["soft", "Soft"], ["radiant", "Radiant"]], default: "soft" },
	{ key: "duetColors", section: "Text", label: "Colour each singer in duets", type: "toggle", default: true },
	{ key: "showContext", section: "Text", label: "Show surrounding lines", type: "toggle", default: true },
	// Motion
	{
		key: "animation",
		section: "Motion",
		label: "Style",
		type: "select",
		ui: "cards",
		options: [
			["flow", "Flow"],
			["slide", "Slide"],
			["scale", "Scale"],
			["fade", "Fade"],
			["cinematic", "Cinematic"],
		],
		hints: { flow: "Spring wave", slide: "Smooth scroll", scale: "Springy focus", fade: "3-line carousel", cinematic: "One line, big" },
		default: "flow",
	},
	{ key: "depthBlur", section: "Motion", label: "Depth blur on distant lines", type: "toggle", default: true },
	// Words
	{ key: "wordSync", section: "Words", label: "Word-by-word highlight", type: "toggle", default: true },
	{
		key: "wordAnim",
		section: "Words",
		label: "Word animation",
		type: "select",
		ui: "cards",
		art: "word",
		options: [
			["fill", "Fill"],
			["glow", "Glow"],
			["pop", "Pop"],
			["rise", "Rise"],
			["letters", "Letters"],
			["karaoke", "Karaoke"],
		],
		hints: { fill: "Soft sweep + lift", glow: "Light up + bloom", pop: "Swell on each word", rise: "Float into place", letters: "Letter wave", karaoke: "Accent-colour wipe" },
		default: "fill",
	},
	{ key: "estimateWords", section: "Words", label: "Estimate word timing for line-synced lyrics", type: "toggle", default: false },
	{ key: "showBgVocals", section: "Words", label: "Show background vocals", type: "toggle", default: true },
	{ key: "unsyncedAutoScroll", section: "Motion", label: "Auto-scroll unsynced lyrics", type: "toggle", default: true },
	{ key: "reducedMotion", section: "Motion", label: "Reduced motion", type: "select", ui: "segmented", options: [["system", "System"], ["on", "On"], ["off", "Off"]], default: "system" },
	// Background
	{ key: "bgStyle", section: "Background", label: "Style", type: "select", ui: "segmented", options: [["album", "Album art"], ["gradient", "Gradient"], ["solid", "Solid"]], default: "album" },
	{ key: "bgAnimate", section: "Background", label: "Animated background", type: "toggle", default: true },
	{ key: "bgOpacity", section: "Background", label: "Darkening", type: "range", min: 0, max: 0.9, step: 0.05, unit: "", default: 0.45 },
	{ key: "blur", section: "Background", label: "Blur", type: "range", min: 20, max: 160, step: 5, unit: "px", default: 90 },
	// Sync
	{ key: "offset", section: "Sync", label: "Lyric offset (+ = earlier)", type: "range", min: -5000, max: 5000, step: 50, unit: "ms", default: 0 },
	// Interface
	{ key: "showTransport", section: "Interface", label: "Playback controls & progress", type: "toggle", default: true },
	{ key: "queuePeek", section: "Interface", label: "Show the next track near the end of a song", type: "toggle", default: true },
	{ key: "miniLyrics", section: "Interface", label: "Mini lyrics over Spotify while fullscreen is closed (Alt+M)", type: "toggle", default: false },
	{ key: "npvCard", section: "Interface", label: "Replace Spotify's lyrics card in the Now Playing panel", type: "toggle", default: true },
	{ key: "showTrackInfo", section: "Interface", label: "Track info", type: "toggle", default: true },
	{ key: "autoHideControls", section: "Interface", label: "Auto-hide controls", type: "toggle", default: true },
	{ key: "autoHideDelay", section: "Interface", label: "Hide after", type: "range", min: 1000, max: 10000, step: 500, unit: "ms", default: 2500 },
	// Sources
	// Translation
	{ key: "translate", section: "Translation", label: "Show translation under each line", type: "toggle", default: false },
	{ key: "translateTo", section: "Translation", label: "Translate to", type: "select", options: TRANSLATE_LANGS, default: "auto" },
	{ key: "providers", section: "Sources", label: "Sources (tried top to bottom)", type: "providers", default: PROVIDER_INFO.map(({ id, on }) => ({ id, on })) },
	{
		key: "searchUntil",
		section: "Sources",
		label: "Keep searching until",
		type: "select",
		ui: "segmented",
		options: [
			["word", "Word sync"],
			["synced", "Line sync"],
			["any", "Anything"],
		],
		default: "word",
	},
];

/**
 * Themes: one-click bundles of the settings that make up the look. Keys in LOOK_KEYS that a
 * theme doesn't list take their defaults, so applying a theme always gives the same result.
 * Font size and line spacing are left alone (they're about readability, not style).
 * swatch = colours for the theme card's preview.
 */
const LOOK_KEYS = ["view", "font", "fontWeight", "textAlign", "textColor", "glow", "accent", "animation", "wordAnim", "depthBlur", "bgStyle", "bgOpacity"];
const THEMES = [
	{ id: "aurora", label: "Aurora", hint: "The default look", swatch: ["#6d3bd1", "#1b2a6b"], values: {} },
	{ id: "neon", label: "Neon", hint: "Radiant, vivid", swatch: ["#ff2fb3", "#2a0a5e"], values: { font: "outfit", fontWeight: "900", glow: "radiant", textColor: "accent", animation: "scale", wordAnim: "glow", bgStyle: "gradient", bgOpacity: 0.35 } },
	{ id: "minimal", label: "Minimal", hint: "Quiet and clean", swatch: ["#26262b", "#0d0d10"], values: { view: "lyrics", font: "system", fontWeight: "700", glow: "off", animation: "slide", depthBlur: false, bgStyle: "solid" } },
	{ id: "karaoke", label: "Karaoke", hint: "Big centred captions", swatch: ["#ffb13d", "#8a1f5c"], values: { view: "captions", font: "rounded", fontWeight: "900", textAlign: "center", animation: "fade", wordAnim: "karaoke" } },
	{ id: "cinema", label: "Cinema", hint: "One line, serif", swatch: ["#3a3226", "#0b0a08"], values: { view: "lyrics", font: "serif", fontWeight: "700", textAlign: "center", animation: "cinematic", wordAnim: "rise", bgOpacity: 0.65 } },
	{ id: "lounge", label: "Lounge", hint: "Spinning vinyl", swatch: ["#c0703a", "#2b1408"], values: { view: "vinyl", font: "serif", fontWeight: "700", animation: "flow", wordAnim: "letters" } },
	{ id: "midnight", label: "Midnight", hint: "Cool blue", swatch: ["#7aa2ff", "#0b1330"], values: { font: "inter", textColor: "accent", accent: "#7aa2ff", bgStyle: "gradient", bgOpacity: 0.6 } },
];

/** The full look a theme produces (defaults + its own values). */
function themeLook(theme) {
	return Object.fromEntries(LOOK_KEYS.map((k) => [k, k in theme.values ? theme.values[k] : DEFAULTS[k]]));
}

function pickLook(all) {
	const out = {};
	for (const k of LOOK_KEYS) {
		const entry = SCHEMA.find((s) => s.key === k);
		out[k] = k in all ? validate(entry, all[k]) : DEFAULTS[k];
	}
	return out;
}

/** Id of the theme whose look equals `all`, or null. */
function matchTheme(all) {
	return THEMES.find((t) => Object.entries(themeLook(t)).every(([k, v]) => all[k] === v))?.id || null;
}

/** Normalise a stored provider list: known ids only, no duplicates, new providers appended. */
function validateProviders(value) {
	const out = [];
	if (Array.isArray(value)) {
		for (const p of value) {
			if (p && PROVIDER_INFO.some((i) => i.id === p.id) && !out.some((o) => o.id === p.id)) out.push({ id: p.id, on: p.on !== false });
		}
	}
	// Providers added in newer versions go in at their default rank, not at the bottom.
	PROVIDER_INFO.forEach((info, rank) => {
		if (!out.some((o) => o.id === info.id)) out.splice(Math.min(rank, out.length), 0, { id: info.id, on: info.on });
	});
	return out;
}

const DEFAULTS = Object.fromEntries(SCHEMA.map((s) => [s.key, s.default]));

/** Non-schema UI state that is persisted alongside settings. */
// customLook: the user's own look, saved when a theme replaces it (so "Custom" can bring it back).
// miniPos: centre of the mini lyrics pill as fractions of the window ({ x, y }), null = default.
const EXTRA_DEFAULTS = { pinControls: false, seenTip: false, customLook: null, miniPos: null };

/** Coerce and clamp a raw value against its schema entry. */
function validate(entry, value) {
	switch (entry.type) {
		case "range": {
			const n = Number(value);
			return Number.isFinite(n) ? clamp(n, entry.min, entry.max) : entry.default;
		}
		case "toggle":
			return typeof value === "boolean" ? value : entry.default;
		case "select":
			return entry.options.some(([v]) => v === value) ? value : entry.default;
		case "providers":
			return validateProviders(value);
		case "color":
			return value === "album" || /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value).toLowerCase() : entry.default;
		default:
			return entry.default;
	}
}

const listeners = new Set();
let current = load();

function load() {
	const saved = store.getJSON(SETTINGS_KEY, {}) || {};
	if (typeof saved.glow === "boolean") saved.glow = saved.glow ? "soft" : "off"; // v1 toggle
	const out = {};
	for (const entry of SCHEMA) out[entry.key] = entry.key in saved ? validate(entry, saved[entry.key]) : entry.default;
	// Migrate v1 source toggles into the provider list.
	if (!("providers" in saved)) {
		out.providers = validateProviders(null).map((p) =>
			(p.id === "spotify" && saved.useSpotify === false) || (p.id === "lrclib" && saved.onlineFetch === false) ? { ...p, on: false } : p,
		);
	}
	for (const [k, d] of Object.entries(EXTRA_DEFAULTS)) out[k] = typeof saved[k] === typeof d ? saved[k] : d;
	const mp = saved.miniPos;
	out.miniPos = mp && Number.isFinite(mp.x) && Number.isFinite(mp.y) ? { x: clamp(mp.x, 0, 1), y: clamp(mp.y, 0, 1) } : null;
	out.customLook = saved.customLook && typeof saved.customLook === "object" ? pickLook(saved.customLook) : null;
	return out;
}

const settings = {
	get(key) {
		return current[key];
	},
	all() {
		return { ...current };
	},
	/** Enabled provider ids in the user's priority order. */
	enabledProviders() {
		return current.providers.filter((p) => p.on).map((p) => p.id);
	},
	set(key, value) {
		this.setMany({ [key]: value });
	},
	/** Change several settings at once: one save, then one notification per changed key. */
	setMany(values) {
		const changed = [];
		const next = { ...current };
		for (const [key, value] of Object.entries(values)) {
			const entry = SCHEMA.find((s) => s.key === key);
			const v = entry ? validate(entry, value) : value;
			if (next[key] === v || (typeof v === "object" && JSON.stringify(next[key]) === JSON.stringify(v))) continue;
			next[key] = v;
			changed.push(key);
		}
		if (!changed.length) return;
		current = next;
		store.setJSON(SETTINGS_KEY, current);
		for (const key of changed) for (const fn of listeners) fn(key, current[key], current);
	},
	/** Id of the theme the current look matches exactly, or null (a custom look). */
	currentTheme() {
		return matchTheme(current);
	},
	/** Apply a theme; "custom" restores the look saved when a theme first replaced it. */
	applyTheme(id) {
		if (id === "custom") {
			if (current.customLook) this.setMany(current.customLook);
			return;
		}
		const theme = THEMES.find((t) => t.id === id);
		if (!theme) return;
		// Leaving a look of the user's own: keep it so it can be restored.
		if (!matchTheme(current)) this.setMany({ customLook: pickLook(current) });
		this.setMany(themeLook(theme));
	},
	reset() {
		current = { ...DEFAULTS, ...EXTRA_DEFAULTS, seenTip: current.seenTip };
		store.setJSON(SETTINGS_KEY, current);
		for (const fn of listeners) fn("*", null, current);
	},
	/** Subscribe to changes. Returns an unsubscribe function. */
	subscribe(fn) {
		listeners.add(fn);
		return () => listeners.delete(fn);
	},
};

// ---- lrc.js ----------------------------------------------------------------
// Lyrics model + LRC / enhanced-LRC parser.
//
// Every provider converts its data into this one shape:
//   Lyrics = {
//     synced: boolean,
//     hasWords: boolean,                 // true when any line has word-level timing
//     meta: { ti?, ar?, al?, by?, offset?, length? },
//     lines: Line[]
//   }
//   Line = { time: ms|null, end: ms|null, text: string, gap?: true, words: Word[]|null,
//            bg?: { text, words }, opposite?: true, singer?: 0|1|2 }   (bg/opposite/singer: optional extras)
//   Word = { time: ms, end: ms, text: string }   // text keeps its trailing space
//
// All times are milliseconds with the LRC [offset:] already applied.

// [mm:ss], [mm:ss.x], [mm:ss.xx], [mm:ss.xxx], also [mm:ss:xx] seen in the wild.
const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/y;
const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
// Only well-known ID tags, so plain-text lines like "[Chorus: Someone]" survive.
const META_TAG = /^\[(ti|ar|al|au|by|offset|length|re|ve|tool|la|lang|id|#)\s*:(.*)\]$/i;

/** Gaps shorter than this are dropped (the previous line just stays active). */
const MIN_GAP_MS = 2500;
/** If the first line starts later than this, show an intro "• • •" line. */
const INTRO_MS = 3000;

function toMs(min, sec, frac) {
	let ms = 0;
	if (frac) ms = frac.length === 1 ? +frac * 100 : frac.length === 2 ? +frac * 10 : +frac;
	return (+min * 60 + +sec) * 1000 + ms;
}

/**
 * Duet voices. Lines may carry `singer`: 0 = lead, 1 = second singer, 2 = together / group.
 * A2 LRC numbers voices v1, v2, …; v1000+ is the conventional "all voices" marker.
 */
function voiceToSinger(n) {
	if (n >= 1000) return 2;
	return n >= 1 ? (n - 1) % 2 : null;
}

/** True when the text contains at least one line-level LRC timestamp. */
function looksSynced(text) {
	return /^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/m.test(String(text || ""));
}

/**
 * Split "<00:01.00>Hello <00:01.50>world<00:02.10>" into timed words.
 * Returns { words, plain } or null when the line has no word tags.
 */
function parseWords(content) {
	const first = content.search(WORD_TAG);
	if (first < 0) return null;
	const leading = content.slice(0, first); // text before the first tag (rare)

	const words = [];
	let m;
	let last = null; // { time, start } of the currently open segment
	let trailing = null; // a closing tag with no text after it = end time of last word
	WORD_TAG.lastIndex = 0;

	while ((m = WORD_TAG.exec(content))) {
		const t = toMs(m[1], m[2], m[3]);
		if (last) {
			const text = content.slice(last.start, m.index);
			if (text) words.push({ time: last.time, end: t, text });
		}
		last = { time: t, start: WORD_TAG.lastIndex };
	}
	const tail = content.slice(last.start);
	if (tail) words.push({ time: last.time, end: null, text: tail });
	else trailing = last.time;

	if (leading.trim() && words.length) words[0].text = leading + words[0].text;
	if (!words.length) return null;
	if (trailing != null) words[words.length - 1].end = trailing;
	return { words, plain: words.map((w) => w.text).join("") };
}

/**
 * Parse an LRC / enhanced LRC document.
 * @param {string} text
 * @param {{ duration?: number }} [opts]  track duration (ms), used for the last line's end
 */
function parseLRC(text, opts = {}) {
	const meta = {};
	const lines = [];

	for (const raw of String(text || "").split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;

		// Collect all leading timestamps: "[00:12.00][01:30.00]Chorus line".
		// TIME_TAG is sticky (/y), so it only matches back-to-back tags at the start.
		const times = [];
		let contentStart = 0;
		TIME_TAG.lastIndex = 0;
		let m;
		while ((m = TIME_TAG.exec(line))) {
			times.push(toMs(m[1], m[2], m[3]));
			contentStart = TIME_TAG.lastIndex;
		}

		if (!times.length) {
			const mm = line.match(META_TAG);
			if (mm) meta[mm[1].toLowerCase()] = mm[2].trim();
			continue; // untimed text inside a synced file is ignored
		}

		// A2 voice markers ("v1:", "v2:"): who sings the line in a duet. Stripped from the text.
		let content = line.slice(contentStart);
		let singer = null;
		const voice = content.match(/^v(\d+):\s*/i);
		if (voice) {
			singer = voiceToSinger(Number(voice[1]));
			content = content.slice(voice[0].length);
		}
		const parsedWords = parseWords(content);
		const plain = (parsedWords ? parsedWords.plain : content).replace(/\s+/g, " ").trim();

		for (const t of times) {
			let words = null;
			if (parsedWords) {
				// Repeated timestamps share one set of word tags; shift them relative to the first.
				const shift = t - times[0];
				words = parsedWords.words.map((w) => ({
					time: w.time + shift,
					end: w.end == null ? null : w.end + shift,
					text: w.text,
				}));
			}
			lines.push({ time: t, end: null, text: plain, words, singer, opposite: singer === 1 });
		}
	}

	const offset = Number.parseInt(meta.offset, 10);
	if (Number.isFinite(offset) && offset !== 0) {
		// LRC spec: positive offset = lyrics appear sooner.
		for (const l of lines) {
			l.time = Math.max(0, l.time - offset);
			if (l.words) for (const w of l.words) {
				w.time = Math.max(0, w.time - offset);
				if (w.end != null) w.end = Math.max(0, w.end - offset);
			}
		}
		meta.offset = offset;
	} else {
		delete meta.offset;
	}

	if (!lines.length) return parsePlain(text, meta);

	lines.sort((a, b) => a.time - b.time); // Array.prototype.sort is stable
	return finalizeSynced(lines, meta, opts.duration);
}

/** Parse plain (unsynced) text. LRC metadata tags are still extracted and removed. */
function parsePlain(text, meta = {}) {
	const out = [];
	for (const raw of String(text || "").split(/\r?\n/)) {
		const line = raw.trim();
		const mm = line.match(META_TAG);
		if (mm) {
			meta[mm[1].toLowerCase()] = mm[2].trim();
			continue;
		}
		const cleaned = line.replace(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g, "").replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, "").trim();
		if (!cleaned) {
			// Blank line = stanza break. Collapse runs and skip leading ones.
			if (out.length && !out[out.length - 1].gap) out.push({ time: null, end: null, text: "", gap: true, words: null });
			continue;
		}
		out.push({ time: null, end: null, text: cleaned, words: null });
	}
	while (out.length && out[out.length - 1].gap) out.pop();
	return { synced: false, hasWords: false, meta, lines: out };
}

/**
 * Shared post-processing for synced line lists coming from any provider:
 * computes end times, marks instrumental gaps, drops short gaps, adds an intro gap.
 * @param {{time:number,text:string,words?:any[]|null,bg?:{text:string,words:any[]|null}|null}[]} lines  sorted by time
 *   bg = background vocals (TTML x-bg), shown as a smaller line under the main one.
 */
function finalizeSynced(lines, meta = {}, duration) {
	// Mark gaps: empty lines, or Spotify's "♪" placeholders.
	let list = lines.map((l) => {
		let text = (l.text || "").trim();
		let words = l.words || null;
		let bg = l.bg?.text?.trim() ? { text: l.bg.text.trim(), words: l.bg.words || null } : null;
		if (!text && bg) {
			// Only background vocals on this line: promote them to the main text.
			({ text, words } = bg);
			bg = null;
		}
		const gap = !text || /^[♪♫🎵🎶\s]+$/u.test(text);
		const out = { time: l.time, end: null, text: gap ? "" : text, gap: gap || undefined, words: gap ? null : words };
		if (bg && !gap) out.bg = bg;
		if (l.opposite && !gap) out.opposite = true; // duet: other singer, shown on the opposite side
		if (l.singer != null && !gap) out.singer = l.singer; // duet: who sings it (see voiceToSinger)
		return out;
	});

	// Collapse consecutive gaps and identical duplicates at the same timestamp.
	list = list.filter((l, i) => {
		const prev = list[i - 1];
		if (!prev) return true;
		if (l.gap && prev.gap) return false;
		if (l.time === prev.time && l.text === prev.text) return false;
		return true;
	});

	const lastEnd = (i) => (i + 1 < list.length ? list[i + 1].time : Math.max(duration || 0, list[i].time + 5000));
	for (let i = 0; i < list.length; i++) list[i].end = lastEnd(i);

	// Drop short gaps (and a trailing gap); the previous line simply stays active.
	list = list.filter((l, i) => !l.gap || (i < list.length - 1 && l.end - l.time >= MIN_GAP_MS));
	for (let i = 0; i < list.length; i++) list[i].end = lastEnd(i);

	if (list.length && list[0].time > INTRO_MS && !list[0].gap) {
		list.unshift({ time: 0, end: list[0].time, text: "", gap: true, words: null });
	}

	const fillEnds = (words, lineEnd) => {
		for (let i = 0; i < words.length; i++) {
			const w = words[i];
			if (w.end == null) w.end = i + 1 < words.length ? words[i + 1].time : lineEnd;
			if (w.end < w.time) w.end = w.time;
		}
	};
	let hasWords = false;
	for (const l of list) {
		if (l.bg) {
			if (l.bg.words?.length) fillEnds(l.bg.words, l.end);
			else l.bg.words = null;
		}
		if (!l.words || !l.words.length) {
			l.words = null;
			continue;
		}
		hasWords = true;
		fillEnds(l.words, l.end);
	}

	return { synced: list.some((l) => !l.gap), hasWords, meta, lines: list };
}

/**
 * Give line-synced lyrics approximate word timing so word animations work everywhere.
 * Each line's sung time (capped, since a line often stays up through an instrumental tail)
 * is split across its words in proportion to their length. Returns a new Lyrics object
 * flagged `estimated: true`; lines that already have word timing are left alone.
 */
function estimateWords(lyrics) {
	if (!lyrics?.synced || lyrics.hasWords) return lyrics;
	const lines = lyrics.lines.map((l) => {
		if (l.gap || l.words || !l.text) return l;
		// Split into words; scripts without spaces (CJK) are split per character.
		const tokens = /\s/.test(l.text) ? l.text.match(/\S+\s*/g) : Array.from(l.text);
		const weights = tokens.map((t) => t.trim().length + 1);
		const total = weights.reduce((a, b) => a + b, 0);
		const span = Math.min(l.end - l.time, 450 * tokens.length + 600) * 0.92;
		let t = l.time;
		const words = tokens.map((text, i) => {
			const d = (span * weights[i]) / total;
			const w = { time: Math.round(t), end: Math.round(t + d), text };
			t += d;
			return w;
		});
		return { ...l, words };
	});
	return { ...lyrics, lines, hasWords: true, estimated: true };
}

/** Parse either format, choosing by content. */
function parseLyricsText(text, opts = {}) {
	return looksSynced(text) ? parseLRC(text, opts) : parsePlain(text);
}

/**
 * Binary search: index of the last line whose time <= pos, or -1 before the first line.
 * Lines must be sorted by time.
 */
function findLineIndex(lines, pos) {
	let lo = 0;
	let hi = lines.length - 1;
	let ans = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (lines[mid].time <= pos) {
			ans = mid;
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return ans;
}

function lrcTime(ms) {
	const cs = Math.round(Math.max(0, ms) / 10);
	const m = Math.floor(cs / 6000);
	const s = (cs % 6000) / 100;
	return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

/** Serialize a Lyrics object back to (enhanced) LRC or plain text — used by the editor. */
function toLRC(lyrics, header = {}) {
	if (!lyrics?.lines) return "";
	const out = [];
	for (const [k, v] of Object.entries(header)) if (v) out.push(`[${k}:${v}]`);
	if (!lyrics.synced) {
		for (const l of lyrics.lines) out.push(l.gap ? "" : l.text);
		return out.join("\n");
	}
	for (const l of lyrics.lines) {
		if (l.gap) {
			out.push(`[${lrcTime(l.time)}]`);
		} else if (l.words) {
			const body = l.words.map((w) => `<${lrcTime(w.time)}>${w.text}`).join("");
			out.push(`[${lrcTime(l.time)}]${body}<${lrcTime(l.words[l.words.length - 1].end)}>`);
		} else {
			out.push(`[${lrcTime(l.time)}]${l.text}`);
		}
	}
	return out.join("\n");
}

/** True when a Lyrics object has something displayable. */
function hasContent(lyrics) {
	return !!lyrics && Array.isArray(lyrics.lines) && lyrics.lines.some((l) => !l.gap && l.text);
}

// ---- formats.js ------------------------------------------------------------
// Converters from provider-specific formats into the Lyrics model (see lrc.js).
// Pure functions (no network, no DOM) so they can be unit-tested in Node.
//
//   Musixmatch  macro.subtitles.get → richsync (word) / subtitles (line) / lyrics (plain)
//   NetEase     YRC (word) / LRC (line)
//   TTML        Apple-Music-style timed text (Unison), incl. background vocals


const byTime = (a, b) => a.time - b.time;

/**
 * Providers sometimes give syllables/words without the spaces between them. Re-attach
 * whitespace by walking the full line text alongside the word pieces.
 */
function alignWordsToText(words, fullText) {
	if (!fullText || !words.length) return words;
	const joined = words.map((w) => w.text).join("");
	if (joined.replace(/\s+/g, " ").trim() === fullText.replace(/\s+/g, " ").trim()) return words;
	let pos = 0;
	for (const w of words) {
		const core = w.text.trim();
		const at = fullText.indexOf(core, pos);
		if (at < 0) continue;
		pos = at + core.length;
		let ws = "";
		while (pos < fullText.length && /\s/.test(fullText[pos])) ws += fullText[pos++];
		w.text = core + (ws ? " " : "");
	}
	return words;
}

// ---------------------------------------------------------------------------
// Musixmatch
// ---------------------------------------------------------------------------

/** richsync_body rows: [{ ts, te, x, l: [{ c, o }] }] — seconds; o is relative to ts. */
function fromRichsync(rows, duration) {
	const lines = rows.map((r) => {
		const t0 = Number(r.ts) * 1000;
		const words = [];
		for (const piece of r.l || []) {
			const c = String(piece.c ?? "");
			// Spaces (and untimed pieces) attach to the previous word.
			if (typeof piece.o !== "number" || !c.trim()) {
				if (words.length) words[words.length - 1].text += c;
				continue;
			}
			words.push({ time: Math.round(t0 + piece.o * 1000), end: null, text: c });
		}
		const te = Number(r.te) * 1000;
		if (words.length && te > words[words.length - 1].time) words[words.length - 1].end = Math.round(te);
		return { time: Math.round(t0), text: r.x ?? words.map((w) => w.text).join(""), words: words.length ? words : null };
	});
	return finalizeSynced(lines.sort(byTime), {}, duration);
}

/**
 * Map a Musixmatch macro_calls object to a provider Result.
 * status "auth" means the user token must be renewed.
 */
function fromMusixmatch(calls, duration) {
	const matcher = calls?.["matcher.track.get"]?.message;
	const code = matcher?.header?.status_code;
	if (code === 404) return { status: "notfound" };
	if (code === 401) return { status: "auth", message: matcher?.header?.hint || "unauthorized" };
	if (code !== 200) return { status: "error", message: `Musixmatch: ${matcher?.header?.hint || code || "bad response"}` };

	const track = matcher.body?.track || {};
	if (track.instrumental) return { status: "notfound", instrumental: true };
	const lyricsMsg = calls["track.lyrics.get"]?.message;
	if (lyricsMsg?.body?.lyrics?.restricted) return { status: "notfound" };

	const rich = calls["track.richsync.get"]?.message;
	if (rich?.header?.status_code === 200 && rich.body?.richsync?.richsync_body) {
		try {
			const l = fromRichsync(JSON.parse(rich.body.richsync.richsync_body), duration);
			if (hasContent(l)) return { status: "found", lyrics: l };
		} catch {
			/* fall through to line sync */
		}
	}

	const sub = calls["track.subtitles.get"]?.message?.body?.subtitle_list?.[0]?.subtitle?.subtitle_body;
	if (sub) {
		// The mobile API returns the "mxm" JSON format; the desktop API returns LRC text.
		try {
			const l = /^\s*\[/.test(sub) && !/^\s*\[\s*\{/.test(sub)
				? parseLRC(sub, { duration })
				: finalizeSynced(JSON.parse(sub).map((r) => ({ time: Math.round(Number(r.time?.total) * 1000), text: r.text || "" })).sort(byTime), {}, duration);
			if (hasContent(l) && l.synced) return { status: "found", lyrics: l };
		} catch {
			/* fall through to plain */
		}
	}

	const plain = lyricsMsg?.body?.lyrics?.lyrics_body;
	if (plain) {
		// Strip the "******* This Lyrics is NOT for Commercial use *******" footer.
		const l = parsePlain(plain.replace(/\n*\*{5,}[\s\S]*$/, ""));
		if (hasContent(l)) return { status: "found", lyrics: l };
	}
	return { status: "notfound" };
}

// ---------------------------------------------------------------------------
// NetEase
// ---------------------------------------------------------------------------

// Credit lines NetEase puts at the top (作词 / 作曲 / 制作人 … : name). Same list lyrics-plus uses.
const NETEASE_CREDITS = new RegExp(
	`^(${[
		"\\s?作?\\s*词|\\s?作?\\s*曲|\\s?编\\s*曲?|\\s?监\\s*制?",
		".*编写|.*和音|.*和声|.*合声|.*提琴|.*录|.*工程|.*工作室|.*设计|.*剪辑|.*制作|.*发行|.*出品|.*后期|.*混音|.*缩混",
		"原唱|翻唱|题字|文案|海报|古筝|二胡|钢琴|吉他|贝斯|笛子|鼓|弦乐",
		"lrc|publish|vocal|guitar|program|produce|write|mix",
	].join("|")}).*(:|：)`,
	"i",
);
const isNeteaseCredit = (text) => NETEASE_CREDITS.test(String(text || "").trim());
const isNeteaseInstrumental = (text) => /纯音乐\s*[,，]?\s*请欣赏/.test(String(text || ""));

/** YRC: "[lineStart,lineDur](wordStart,wordDur,0)word(…)…" — absolute ms. JSON lines are credits. */
function parseYrc(text, duration) {
	const lines = [];
	for (const raw of String(text || "").split(/\r?\n/)) {
		const m = raw.match(/^\[(\d+),(\d+)\](.*)$/);
		if (!m) continue;
		const parts = m[3].split(/\((\d+),(\d+),-?\d+\)/);
		const words = [];
		for (let i = 1; i + 1 < parts.length; i += 3) {
			const t = Number(parts[i]);
			const d = Number(parts[i + 1]);
			const txt = parts[i + 2] ?? "";
			if (!txt) continue;
			if (!txt.trim()) {
				if (words.length) words[words.length - 1].text += txt;
				continue;
			}
			words.push({ time: t, end: t + d, text: txt });
		}
		const plain = (words.length ? words.map((w) => w.text).join("") : parts[0]).replace(/\s+/g, " ").trim();
		if (!plain || isNeteaseCredit(plain)) continue;
		lines.push({ time: Number(m[1]), text: plain, words: words.length ? words : null });
	}
	if (!lines.length) return null;
	return finalizeSynced(lines.sort(byTime), {}, duration);
}

/** NetEase LRC with credit lines removed. */
function parseNeteaseLrc(text, duration) {
	const cleaned = String(text || "")
		.split(/\r?\n/)
		.filter((l) => !isNeteaseCredit(l.replace(/^(\[[^\]]*\])+/, "")))
		.join("\n");
	return parseLRC(cleaned, { duration });
}

// ---------------------------------------------------------------------------
// TTML (Apple Music style; served by Unison)
// ---------------------------------------------------------------------------

/** "1:02:03.45" | "02:03.450" | "12.5" | "12.5s" | "1250ms" → ms */
function parseClock(v) {
	if (v == null || v === "") return null;
	const s = String(v).trim();
	let m;
	if ((m = s.match(/^([\d.]+)ms$/))) return Math.round(Number(m[1]));
	if ((m = s.match(/^([\d.]+)s$/))) return Math.round(Number(m[1]) * 1000);
	const parts = s.split(":").map(Number);
	if (parts.some((n) => !Number.isFinite(n))) return null;
	let secs = 0;
	for (const p of parts) secs = secs * 60 + p;
	return Math.round(secs * 1000);
}

function decodeEntities(s) {
	return s
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function attrs(tag) {
	const out = {};
	for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1].replace(/^.*:/, "")] = m[2];
	return out;
}

const stripParens = (s) => s.replace(/^\s*\(\s*/, "").replace(/\s*\)\s*$/, "");

/**
 * Duet singers from TTML agents: <ttm:agent type="person|group" xml:id="v1"/> declared in the
 * head, referenced as <p ttm:agent="v1">. People get singer 0, 1, 0, … in order of their first
 * line (so whoever sings first is the lead); group agents get 2. Returns agentId → singer|null.
 * Songs with a single agent return null for everything (nothing to colour).
 */
function ttmlSingers(xml) {
	const types = new Map();
	for (const m of xml.matchAll(/<(?:[\w-]+:)?agent\b([^>]*)>/g)) {
		const a = attrs(m[1]);
		if (a.id) types.set(a.id, a.type || "person");
	}
	const order = [];
	for (const m of xml.matchAll(/<p\b([^>]*)>/g)) {
		const id = attrs(m[1]).agent;
		if (id && !order.includes(id)) order.push(id);
	}
	if (order.length < 2) return () => null;
	const map = new Map();
	let people = 0;
	for (const id of order) map.set(id, types.get(id) === "group" ? 2 : people++ % 2);
	return (id) => (id && map.has(id) ? map.get(id) : null);
}

/**
 * Small regex-based TTML reader (no DOMParser needed). Handles <p begin end> lines,
 * timed <span> words/syllables (with or without spaces between them), and
 * <span ttm:role="x-bg"> background vocals. Untimed TTML becomes plain text.
 */
function parseTTML(xml, duration) {
	const body = String(xml || "");
	const lines = [];
	let anyTimed = false;
	const singerOf = ttmlSingers(body);
	for (const pm of body.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
		const pa = attrs(pm[1]);
		const buckets = { main: { words: [], text: "" }, bg: { words: [], text: "" } };
		const stack = []; // open spans: { begin, end, bg }
		for (const tm of pm[2].matchAll(/<(\/?)span\b([^>]*?)(\/?)>|<br\s*\/?>|([^<]+)/g)) {
			if (tm[1] === "/") {
				stack.pop();
				continue;
			}
			if (tm[0].startsWith("<span")) {
				if (tm[3] === "/") continue; // self-closing, no content
				const a = attrs(tm[2]);
				const parent = stack[stack.length - 1];
				stack.push({ begin: parseClock(a.begin), end: parseClock(a.end), bg: a.role === "x-bg" || !!parent?.bg });
				continue;
			}
			if (tm[0].startsWith("<br")) continue;
			const text = decodeEntities(tm[4] || "");
			const ctx = stack[stack.length - 1];
			const bucket = ctx?.bg ? buckets.bg : buckets.main;
			bucket.text += text;
			if (ctx && ctx.begin != null && text.trim()) {
				anyTimed = true;
				bucket.words.push({ time: ctx.begin, end: ctx.end, text });
			} else if (bucket.words.length) {
				bucket.words[bucket.words.length - 1].text += text; // whitespace between spans
			}
		}
		const norm = (s) => s.replace(/\s+/g, " ").trim();
		const mainText = norm(buckets.main.text);
		const bgText = norm(stripParens(buckets.bg.text));
		const begin = parseClock(pa.begin) ?? buckets.main.words[0]?.time ?? buckets.bg.words[0]?.time ?? null;
		if (begin != null) anyTimed = true;
		if (!mainText && !bgText) continue;
		const mainWords = buckets.main.words.length ? alignWordsToText(buckets.main.words, mainText) : null;
		let bgWords = null;
		if (buckets.bg.words.length) {
			bgWords = buckets.bg.words;
			bgWords[0].text = bgWords[0].text.replace(/^\s*\(/, "");
			bgWords[bgWords.length - 1].text = bgWords[bgWords.length - 1].text.replace(/\)\s*$/, "");
		}
		const singer = singerOf(pa.agent);
		lines.push({ time: begin, text: mainText, words: mainWords, bg: bgText ? { text: bgText, words: bgWords } : null, singer, opposite: singer === 1 });
	}
	if (!lines.length) return null;
	if (!anyTimed || lines.every((l) => l.time == null)) return parsePlain(lines.map((l) => l.text).join("\n"));
	return finalizeSynced(lines.filter((l) => l.time != null).sort(byTime), {}, duration);
}

// ---------------------------------------------------------------------------
// Paxsenix (Apple Music lyrics as JSON)
// ---------------------------------------------------------------------------

/**
 * /apple-music/lyrics response: { type: "Syllable"|"Line"|…, content: [{ timestamp, endtime,
 * text: [{ text, timestamp, endtime, part }], backgroundText: [...], oppositeTurn }] } (ms).
 * `part: true` = this syllable continues into the next one (no space between them).
 */
function fromPaxsenixApple(json, duration) {
	const content = json?.content;
	if (!Array.isArray(content) || !content.length) return null;
	const type = String(json.type || "").toLowerCase();
	const toWords = (parts) =>
		(parts || [])
			.filter((t) => t && String(t.text ?? "").length && Number.isFinite(Number(t.timestamp)))
			.map((t) => ({ time: Number(t.timestamp), end: Number(t.endtime) || null, text: String(t.text).trim() + (t.part ? "" : " ") }));
	const joinText = (words) => words.map((w) => w.text).join("").replace(/\s+/g, " ").trim();

	if (!content.some((l) => Number.isFinite(Number(l.timestamp)))) {
		return parsePlain(content.map((l) => joinText(toWords(l.text)) || (l.text || []).map((t) => t.text).join(" ")).join("\n"));
	}
	const wordSynced = type === "syllable" || type === "word";
	const lines = content.map((l) => {
		const main = toWords(l.text);
		const bg = toWords(l.backgroundText);
		const bgText = stripParens(joinText(bg));
		if (bg.length) {
			bg[0].text = bg[0].text.replace(/^\s*\(/, "");
			bg[bg.length - 1].text = bg[bg.length - 1].text.replace(/\)\s*$/, "");
		}
		return {
			time: Number(l.timestamp) || main[0]?.time || 0,
			text: joinText(main),
			words: wordSynced && main.length ? main : null,
			bg: bgText ? { text: bgText, words: wordSynced && bg.length ? bg : null } : null,
			opposite: !!l.oppositeTurn,
			singer: l.oppositeTurn ? 1 : 0, // the only duet info this API gives
		};
	});
	return finalizeSynced(lines.sort(byTime), {}, duration);
}

/** Unison /lyrics response → Lyrics */
function fromUnison(data, duration) {
	const format = String(data?.format || "").toLowerCase();
	if (format === "ttml") return parseTTML(data.lyrics, duration);
	if (format === "lrc") return parseLRC(data.lyrics, { duration });
	if (format === "plain") return parsePlain(data.lyrics);
	return null;
}

// ---- cache.js --------------------------------------------------------------
// Two stores:
//  - lyricsCache: fetched results (and "not found" results) per track URI, LRU-capped with TTLs.
//  - localLyrics: user-imported/pasted text, kept until removed. Stored under both the track URI
//    and a normalized "artist|title" key so it also applies to the same song on another album.


// Bumped whenever older builds could have cached wrong results (v3: Musixmatch decoy matches).
const CACHE_VERSION = "cache3";
const INDEX_KEY = `${EXT_ID}:${CACHE_VERSION}-index`;
const ENTRY_PREFIX = `${EXT_ID}:${CACHE_VERSION}:`;
(function dropOldCaches() {
	for (const old of ["cache", "cache2"]) {
		const idx = store.getJSON(`${EXT_ID}:${old}-index`, null);
		if (!Array.isArray(idx)) continue;
		for (const k of idx) store.remove(`${EXT_ID}:${old}:${k}`);
		store.remove(`${EXT_ID}:${old}-index`);
	}
})();
const LOCAL_PREFIX = `${EXT_ID}:local:`;

const MAX_ENTRIES = 150;
const TTL_FOUND = 30 * 24 * 3600 * 1000;
const TTL_NOT_FOUND = 12 * 3600 * 1000; // retry misses twice a day

function readIndex() {
	const idx = store.getJSON(INDEX_KEY, []);
	return Array.isArray(idx) ? idx : [];
}

const lyricsCache = {
	/** @returns {{ source: string, lyrics: object|null, notFound?: boolean } | null} */
	get(uri) {
		if (!uri) return null;
		const entry = store.getJSON(ENTRY_PREFIX + uri);
		if (!entry) return null;
		const ttl = entry.notFound ? TTL_NOT_FOUND : TTL_FOUND;
		if (Date.now() - entry.savedAt > ttl) {
			this.remove(uri);
			return null;
		}
		return entry;
	},

	/** extra: { notFound?: boolean, tried?: string[], instrumental?: boolean } */
	set(uri, source, lyrics, extra = {}) {
		if (!uri) return;
		const entry = { source, lyrics: extra.notFound ? null : lyrics, ...extra, savedAt: Date.now() };
		let idx = readIndex().filter((k) => k !== uri);
		idx.push(uri);
		// Evict least-recently-written entries.
		while (idx.length > MAX_ENTRIES) store.remove(ENTRY_PREFIX + idx.shift());
		// If the write fails (quota), evict harder and retry once.
		if (!store.setJSON(ENTRY_PREFIX + uri, entry)) {
			const drop = idx.splice(0, Math.ceil(idx.length / 3));
			for (const k of drop) store.remove(ENTRY_PREFIX + k);
			store.setJSON(ENTRY_PREFIX + uri, entry);
		}
		store.setJSON(INDEX_KEY, idx);
	},

	remove(uri) {
		store.remove(ENTRY_PREFIX + uri);
		store.setJSON(INDEX_KEY, readIndex().filter((k) => k !== uri));
	},

	clear() {
		for (const k of readIndex()) store.remove(ENTRY_PREFIX + k);
		store.setJSON(INDEX_KEY, []);
	},

	size() {
		return readIndex().length;
	},
};

const localLyrics = {
	/** @returns {{ text: string, savedAt: number, fileName?: string } | null} */
	get(track) {
		if (!track) return null;
		return store.getJSON(LOCAL_PREFIX + track.uri) || store.getJSON(LOCAL_PREFIX + nameKey(track));
	},
	set(track, text, fileName) {
		const entry = { text, fileName: fileName || null, savedAt: Date.now(), title: track.title, artist: track.artist };
		store.setJSON(LOCAL_PREFIX + track.uri, entry);
		store.setJSON(LOCAL_PREFIX + nameKey(track), entry);
	},
	remove(track) {
		store.remove(LOCAL_PREFIX + track.uri);
		store.remove(LOCAL_PREFIX + nameKey(track));
	},
};

// ---- player.js -------------------------------------------------------------
// Thin, defensive wrapper around Spicetify.Player. Player.data's shape has shifted across
// Spotify versions, so every field is read with fallbacks.

/** spotify:image:abc → https://i.scdn.co/image/abc */
function imageUrl(src) {
	if (!src) return null;
	if (src.startsWith("spotify:image:")) return `https://i.scdn.co/image/${src.slice("spotify:image:".length)}`;
	if (/^(https?:\/\/|data:image\/)/.test(src)) return src;
	return null;
}

/**
 * @returns {null | { uri, id, title, artist, album, duration, image, isLocal, isTrack }}
 */
function getCurrentTrack() {
	const data = globalThis.Spicetify?.Player?.data;
	const item = data?.item || data?.track; // very old builds used data.track
	if (!item?.uri) return null;

	const meta = item.metadata || {};
	const uri = item.uri;
	const parts = uri.split(":");
	const isTrack = parts[1] === "track" || parts[1] === "local";
	const artists = Array.isArray(item.artists) && item.artists.length ? item.artists.map((a) => a.name).filter(Boolean) : null;

	const duration =
		Number(item.duration?.milliseconds) ||
		Number(meta.duration) ||
		Number(data.duration) ||
		Number(globalThis.Spicetify?.Player?.getDuration?.()) ||
		0;

	const images = item.album?.images || item.images || [];
	const biggest = images.length ? [...images].sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url : null;

	// Links for the artist / album names (clickable in the overlay).
	const artistLinks = Array.isArray(item.artists) && item.artists.length
		? item.artists.filter((a) => a?.name).map((a) => ({ name: a.name, uri: a.uri || null }))
		: meta.artist_name
			? [{ name: meta.artist_name, uri: meta.artist_uri || null }]
			: [];

	return {
		uri,
		artistLinks,
		albumUri: item.album?.uri || meta.album_uri || null,
		id: parts[1] === "track" ? parts[2] : null,
		title: item.name || meta.title || "",
		artist: artists ? artists.join(", ") : meta.artist_name || "",
		album: item.album?.name || meta.album_title || "",
		duration,
		image: imageUrl(meta.image_xlarge_url) || imageUrl(biggest) || imageUrl(meta.image_large_url) || imageUrl(meta.image_url),
		isLocal: parts[1] === "local" || !!item.isLocal,
		isTrack,
	};
}

/**
 * A queue entry → { uri, title, artist, image }, or null for delimiters / empty entries.
 * Accepts Spicetify.Queue.nextTracks items ({ contextTrack: { uri, metadata } }) and
 * Player.data.nextItems items ({ uri, name, artists, album: { images }, metadata }).
 */
function describeQueueItem(raw) {
	const item = raw?.contextTrack || raw;
	const uri = item?.uri;
	if (!uri || uri.includes("delimiter") || raw?.provider === "unavailable") return null;
	const meta = item.metadata || {};
	const artists = Array.isArray(item.artists) ? item.artists.map((a) => a?.name).filter(Boolean) : [];
	const images = item.album?.images || item.images || [];
	const biggest = images.length ? [...images].sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url : null;
	const title = item.name || meta.title || "";
	if (!title) return null;
	return {
		uri,
		title,
		artist: artists.length ? artists.join(", ") : meta.artist_name || "",
		image: imageUrl(biggest) || imageUrl(meta.image_large_url) || imageUrl(meta.image_url) || imageUrl(meta.image_xlarge_url),
	};
}

/** The track that plays next (queue first, then the context), or null if unknown. */
function getNextTrack() {
	const S = globalThis.Spicetify;
	for (const list of [S?.Queue?.nextTracks, S?.Player?.data?.nextItems]) {
		if (!Array.isArray(list)) continue;
		for (const raw of list.slice(0, 5)) {
			const t = describeQueueItem(raw);
			if (t) return t;
		}
	}
	return null;
}

/** Open a Spotify page ("spotify:album:ID" / "spotify:artist:ID") in the main view. */
function openUri(uri) {
	const m = /^spotify:(album|artist|show|playlist):([A-Za-z0-9]+)$/.exec(uri || "");
	const history = globalThis.Spicetify?.Platform?.History;
	if (!m || !history?.push) return false;
	history.push(`/${m[1]}/${m[2]}`);
	return true;
}

/** Current playback position in ms, interpolated between player state updates. */
function getPosition() {
	const P = globalThis.Spicetify?.Player;
	const d = P?.data;
	let pos = 0;
	if (d && Number.isFinite(d.positionAsOfTimestamp) && Number.isFinite(d.timestamp)) {
		pos = d.positionAsOfTimestamp;
		if (!d.isPaused && !d.isBuffering) pos += (Date.now() - d.timestamp) * (d.speed || 1);
	} else {
		try {
			pos = P?.getProgress?.() || 0;
		} catch {
			pos = 0;
		}
	}
	const dur = Number(d?.duration) || Number(d?.item?.duration?.milliseconds) || 0;
	return dur > 0 ? Math.min(Math.max(0, pos), dur) : Math.max(0, pos);
}

function isPlaying() {
	const P = globalThis.Spicetify?.Player;
	if (P?.data) return !P.data.isPaused;
	return !!P?.isPlaying?.();
}

function getDuration() {
	const P = globalThis.Spicetify?.Player;
	return Number(P?.data?.duration) || Number(P?.data?.item?.duration?.milliseconds) || Number(P?.getDuration?.()) || 0;
}

/** Shuffle / repeat / like / volume, read defensively (any may be unavailable). */
function playerState() {
	const P = globalThis.Spicetify?.Player;
	const read = (fn, fallback) => {
		try {
			const v = P?.[fn]?.();
			return v ?? fallback;
		} catch {
			return fallback;
		}
	};
	return {
		shuffle: !!read("getShuffle", false),
		repeat: Number(read("getRepeat", 0)) || 0, // 0 off, 1 all, 2 one
		heart: !!read("getHeart", false),
		volume: Number(read("getVolume", 1)),
		mute: !!read("getMute", false),
	};
}

function setVolume(v) {
	try {
		globalThis.Spicetify?.Player?.setVolume?.(Math.min(1, Math.max(0, v)));
	} catch (e) {
		console.warn("[aurora-lyrics] setVolume failed", e);
	}
}

/** Call a Player method if it exists (next / back / togglePlay / toggleShuffle / …). */
function playerCommand(name) {
	try {
		globalThis.Spicetify?.Player?.[name]?.();
	} catch (e) {
		console.warn(`[aurora-lyrics] Player.${name} failed`, e);
	}
}

function seek(ms) {
	try {
		globalThis.Spicetify?.Player?.seek?.(Math.max(0, Math.round(ms)));
	} catch (e) {
		console.warn("[aurora-lyrics] seek failed", e);
	}
}

// ---- net.js ----------------------------------------------------------------
// Network helpers.
//
// Why not Spicetify.CosmosAsync for third-party hosts: on Spotify 1.3.x the Spicetify
// wrapper's version check sends every CosmosAsync call to Spotify's native resolver,
// which throws "Resolver not found" for non-Spotify URLs, and custom headers are dropped
// on every path. So:
//   - CORS-enabled hosts (LRCLIB, Unison, Musixmatch desktop API) → plain fetch()
//   - hosts without CORS (NetEase, Musixmatch mobile API) → Spicetify's CORS proxy
//   - Spotify's own endpoints → fetch() with the user's access token (spclient allows the
//     client origin), CosmosAsync only as a fallback.


const DEFAULT_PROXY = "https://cors-proxy.spicetify.app/{url}";

/** Wrap a URL with the CORS proxy (honours Spicetify's own "spicetify:corsProxyTemplate"). */
function corsProxy(url) {
	let tpl = DEFAULT_PROXY;
	try {
		const custom = globalThis.localStorage?.getItem("spicetify:corsProxyTemplate");
		if (custom && custom.includes("{url}")) tpl = custom;
	} catch {
		/* storage blocked */
	}
	return tpl.replace("{url}", url);
}

/**
 * GET a URL and parse JSON. HTTP errors don't throw: check `ok` / `status`.
 * Network failures and timeouts do throw.
 * @returns {Promise<{ status: number, ok: boolean, json: any, headers: Headers }>}
 */
async function getJSON(url, { signal, headers, proxy = false, timeout = 9000 } = {}) {
	const res = await fetchWithTimeout(proxy ? corsProxy(url) : url, { signal, headers }, timeout);
	let json = null;
	try {
		json = await res.json();
	} catch {
		/* not JSON (e.g. an HTML error page) */
	}
	return { status: res.status, ok: res.ok, json, headers: res.headers };
}

/** Headers for Spotify's own APIs, or null if no access token is available. */
function spotifyAuthHeaders() {
	const S = globalThis.Spicetify;
	const token = S?.Platform?.AuthorizationAPI?.getState?.()?.token?.accessToken;
	if (!token) return null;
	const headers = { Authorization: `Bearer ${token}` };
	if (S.Platform?.PlatformData?.app_platform) headers["App-Platform"] = S.Platform.PlatformData.app_platform;
	if (S.Platform?.version) headers["Spotify-App-Version"] = S.Platform.version;
	return headers;
}

// ---- sources.js ------------------------------------------------------------
// Network side of the extra lyrics providers. Parsing lives in formats.js, HTTP in net.js.
//
// Every provider: { id, isAvailable(track), fetch(track, signal) → Result }
//   Result = { status: "found", lyrics } | { status: "notfound", instrumental? }
//          | { status: "error", message } | { status: "skipped", message }
// "skipped" = provider is pausing after rate limits; the resolver moves on silently.


const qs = (o) =>
	Object.entries(o)
		.filter(([, v]) => v != null)
		.map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
		.join("&");

const primaryArtist = (artist) => String(artist || "").split(/\s*,\s*/)[0].trim();

/** Temporary per-key backoff after rate limits / outages. */
const pausedUntil = {};
const pause = (key, ms) => (pausedUntil[key] = Date.now() + ms);
const isPaused = (key) => (pausedUntil[key] || 0) > Date.now();
const skipped = (key) => ({ status: "skipped", message: `${key} paused for ${Math.ceil((pausedUntil[key] - Date.now()) / 1000)}s` });

/** Test hook: clear all backoffs. */
function resetSourceBackoff() {
	for (const k of Object.keys(pausedUntil)) delete pausedUntil[k];
}

// ---------------------------------------------------------------------------
// Musixmatch — mobile API (word-level "richsync", line sync, plain) with a user token,
// through the CORS proxy.
//
// NOT the desktop API: without a valid token it answers every query with the same decoy
// song (different track, filler timings, lyrics in another language). And every answer is
// checked against the playing track, so a wrong match can never be shown.
// ---------------------------------------------------------------------------

const MXM_MOBILE = "https://apic-appmobile.musixmatch.com/ws/1.1/";
const MXM_TOKEN_KEY = `${EXT_ID}:mxm-token`;
const MXM_BAD_KEY = `${EXT_ID}:mxm-bad-tokens`;

function mxmQuery(track, extra) {
	const secs = track.duration ? track.duration / 1000 : null;
	return qs({
		format: "json",
		namespace: "lyrics_richsynched",
		subtitle_format: "mxm",
		q_track: track.title,
		q_artist: primaryArtist(track.artist),
		q_artists: track.artist,
		q_album: track.album || null,
		q_duration: secs,
		f_subtitle_length: secs ? Math.floor(secs) : null,
		track_spotify_id: track.uri,
		...extra,
	});
}

function badTokens() {
	const list = store.getJSON(MXM_BAD_KEY, []);
	return Array.isArray(list) ? list : [];
}
function markBadToken(token) {
	store.setJSON(MXM_BAD_KEY, [...badTokens(), token].slice(-10));
	if (store.getJSON(MXM_TOKEN_KEY)?.token === token) store.remove(MXM_TOKEN_KEY);
}

/** A usable mobile-API token, or null (never throws). */
async function mxmToken(signal) {
	const bad = badTokens();
	const saved = store.getJSON(MXM_TOKEN_KEY)?.token;
	if (saved && !bad.includes(saved)) return saved;
	// Reuse the token the bundled lyrics-plus app saved, if the user has one.
	let lp = null;
	try {
		lp = globalThis.localStorage?.getItem("lyrics-plus:provider:musixmatch:token");
	} catch {
		/* ignore */
	}
	if (lp && lp.length > 20 && !bad.includes(lp)) return lp;

	if (isPaused("musixmatch-token")) return null;
	try {
		const r = await getJSON(`${MXM_MOBILE}token.get?app_id=mac-ios-v2.0`, { signal, proxy: true });
		const token = r.json?.message?.body?.user_token;
		if (r.json?.message?.header?.status_code === 200 && token && !/^(UpgradeOnly|0+$)/.test(token)) {
			store.setJSON(MXM_TOKEN_KEY, { token, at: Date.now() });
			return token;
		}
	} catch (e) {
		if (signal?.aborted) throw e;
	}
	pause("musixmatch-token", 15 * 60 * 1000); // captcha / rate limit: try again later
	return null;
}

/** Does Musixmatch's matched track describe the song that is playing? Exported for tests. */
function mxmMatches(track, matched) {
	if (!matched) return false;
	return sameSong(track, { title: matched.track_name, artists: [matched.artist_name], durationMs: matched.track_length ? matched.track_length * 1000 : 0 }, 6000);
}

const musixmatchProvider = {
	id: "musixmatch",
	isAvailable: (track) => !!track.title,
	async fetch(track, signal) {
		if (isPaused("musixmatch")) return skipped("musixmatch");
		for (let attempt = 0; attempt < 2; attempt++) {
			const token = await mxmToken(signal);
			if (!token) return { status: "skipped", message: "Musixmatch: no token available right now (rate-limited), retrying later" };
			let r;
			try {
				r = await getJSON(`${MXM_MOBILE}macro.subtitles.get?${mxmQuery(track, { app_id: "mac-ios-v2.0", optional_calls: "track.richsync", richsync_compact_type: "words", usertoken: token })}`, { signal, proxy: true });
			} catch (e) {
				if (signal?.aborted) throw e;
				return { status: "error", message: `Musixmatch: ${e?.message || e}` };
			}
			if (r.status === 429) {
				pause("musixmatch", 5 * 60 * 1000);
				return skipped("musixmatch");
			}
			if (!r.ok) return { status: "error", message: `Musixmatch: HTTP ${r.status}` };
			const calls = r.json?.message?.body?.macro_calls;
			const matcherCode = calls?.["matcher.track.get"]?.message?.header?.status_code;
			if (r.json?.message?.header?.status_code === 401 || matcherCode === 401) {
				markBadToken(token); // expired / captcha'd token → try a fresh one once
				continue;
			}
			if (matcherCode === 404) return { status: "notfound" };
			const matched = calls?.["matcher.track.get"]?.message?.body?.track;
			if (!mxmMatches(track, matched)) {
				console.warn(`[aurora-lyrics] Musixmatch matched a different song ("${matched?.track_name}" by ${matched?.artist_name}); ignoring it`);
				return { status: "notfound" };
			}
			const res = fromMusixmatch(calls, track.duration);
			if (res.status !== "auth") return res;
			markBadToken(token);
		}
		return { status: "skipped", message: "Musixmatch: token rejected, retrying later" };
	},
};

// ---------------------------------------------------------------------------
// NetEase Cloud Music — word-level YRC. No CORS headers, so via the proxy.
// ---------------------------------------------------------------------------

/**
 * Pick the NetEase search hit for the track. The title must match and the duration be within
 * 3s; the artist must match too, unless the duration is within 1.5s (artist names are often
 * written differently on NetEase). Covers / other-language versions are rejected. Exported for tests.
 */
function pickNeteaseSong(songs, track) {
	if (!Array.isArray(songs)) return null;
	let best = null;
	let bestScore = -Infinity;
	for (const s of songs) {
		const diff = track.duration && s.duration ? Math.abs(s.duration - track.duration) : 0;
		if (diff > 3000 || !titleMatches(track.title, s.name)) continue;
		const artistOk = artistMatches(track.artist, (s.artists || s.ar || []).map((a) => a.name));
		const exactTitle = normalizeTitle(s.name) === normalizeTitle(track.title);
		// Without an artist match, only an identical title with a near-identical duration counts.
		if (!artistOk && !(exactTitle && track.duration && s.duration && diff <= 1500)) continue;
		let score = (artistOk ? 5 : 0) - diff / 1000;
		if (exactTitle) score += 2;
		if (normalizeTitle(s.album?.name || s.al?.name) === normalizeTitle(track.album)) score += 1;
		if (score > bestScore) {
			best = s;
			bestScore = score;
		}
	}
	return best;
}

const neteaseProvider = {
	id: "netease",
	isAvailable: (track) => !!track.title,
	async fetch(track, signal) {
		if (isPaused("netease")) return skipped("netease");
		try {
			const search = await getJSON(`https://music.163.com/api/search/get?${qs({ s: `${track.title} ${primaryArtist(track.artist)}`, type: 1, limit: 15 })}`, { signal, proxy: true });
			if (search.status === 429 || (search.json?.code && search.json.code !== 200)) {
				pause("netease", 5 * 60 * 1000);
				return skipped("netease");
			}
			if (!search.ok) return { status: "error", message: `NetEase: HTTP ${search.status}` };
			const song = pickNeteaseSong(search.json?.result?.songs, track);
			if (!song) return { status: "notfound" };

			const lyr = await getJSON(`https://music.163.com/api/song/lyric?${qs({ id: song.id, lv: 1, yv: 1, tv: -1 })}`, { signal, proxy: true });
			if (!lyr.ok) return { status: "error", message: `NetEase: HTTP ${lyr.status}` };
			const data = lyr.json;
			if (data?.nolyric || data?.uncollected) return { status: "notfound" };
			const lrcText = data?.lrc?.lyric || "";
			if (isNeteaseInstrumental(lrcText)) return { status: "notfound", instrumental: true };

			const yrc = parseYrc(data?.yrc?.lyric, track.duration);
			if (hasContent(yrc)) return { status: "found", lyrics: yrc };
			const lrc = parseNeteaseLrc(lrcText, track.duration);
			if (hasContent(lrc)) return { status: "found", lyrics: lrc };
			return { status: "notfound" };
		} catch (e) {
			if (signal?.aborted) throw e;
			return { status: "error", message: `NetEase: ${e?.message || e}` };
		}
	},
};

// ---------------------------------------------------------------------------
// Unison (better-lyrics community DB) — TTML with word timing. CORS-enabled.
// ---------------------------------------------------------------------------

const unisonProvider = {
	id: "unison",
	isAvailable: (track) => !!track.title && !!track.artist,
	async fetch(track, signal) {
		if (isPaused("unison")) return skipped("unison");
		const base = { song: track.title, artist: primaryArtist(track.artist), duration: track.duration ? Math.round(track.duration / 1000) : null };
		try {
			// With album first (more precise), then without.
			for (const params of track.album ? [{ ...base, album: track.album }, base] : [base]) {
				const r = await getJSON(`https://unison.boidu.dev/lyrics?${qs(params)}`, { signal, headers: { Accept: "application/json" } });
				if (r.status === 404) continue;
				if (r.status === 429) {
					pause("unison", 60 * 1000);
					return skipped("unison");
				}
				if (!r.ok) return { status: "error", message: `Unison: HTTP ${r.status}` };
				const lyrics = r.json?.data ? fromUnison(r.json.data, track.duration) : null;
				if (hasContent(lyrics)) return { status: "found", lyrics };
			}
			return { status: "notfound" };
		} catch (e) {
			if (signal?.aborted) throw e;
			return { status: "error", message: `Unison: ${e?.message || e}` };
		}
	},
};

// ---------------------------------------------------------------------------
// Apple Music lyrics via Paxsenix (community API, no key). Syllable-level timing,
// background vocals and duet sides. Both hosts send CORS headers → plain fetch().
//   1) iTunes Search finds the Apple Music track id (checked with sameSong, so remixes /
//      covers / other versions are skipped).
//   2) lyrics.paxsenix.org/apple-music/lyrics?id=… returns Apple's lyrics as JSON.
// ---------------------------------------------------------------------------

/** Pick the iTunes search result for the track. Exported for tests. */
function pickItunesSong(results, track) {
	if (!Array.isArray(results)) return null;
	let best = null;
	let bestScore = -Infinity;
	for (const r of results) {
		if (r?.kind && r.kind !== "song") continue;
		if (!sameSong(track, { title: r.trackName, artists: [r.artistName], durationMs: r.trackTimeMillis }, 3000)) continue;
		const diff = track.duration && r.trackTimeMillis ? Math.abs(track.duration - r.trackTimeMillis) : 0;
		let score = -diff / 1000;
		if (normalizeTitle(r.trackName) === normalizeTitle(track.title)) score += 3;
		if (normalizeTitle(r.collectionName) === normalizeTitle(track.album)) score += 1;
		if (score > bestScore) {
			best = r;
			bestScore = score;
		}
	}
	return best;
}

const paxsenixProvider = {
	id: "paxsenix",
	isAvailable: (track) => !!track.title && !!track.artist,
	async fetch(track, signal) {
		if (isPaused("paxsenix")) return skipped("paxsenix");
		try {
			const search = await getJSON(`https://itunes.apple.com/search?${qs({ term: `${track.title} ${primaryArtist(track.artist)}`, entity: "song", limit: 15 })}`, { signal });
			if (search.status === 403 || search.status === 429) {
				pause("paxsenix", 2 * 60 * 1000);
				return skipped("paxsenix");
			}
			if (!search.ok) return { status: "error", message: `Apple Music search: HTTP ${search.status}` };
			const song = pickItunesSong(search.json?.results, track);
			if (!song) return { status: "notfound" };

			const r = await getJSON(`https://lyrics.paxsenix.org/apple-music/lyrics?${qs({ id: song.trackId })}`, { signal, timeout: 15000 });
			if (r.status === 404 || r.status === 400) return { status: "notfound" };
			if (r.status === 429 || r.status === 503) {
				pause("paxsenix", 3 * 60 * 1000);
				return skipped("paxsenix");
			}
			if (!r.ok) return { status: "error", message: `Paxsenix: HTTP ${r.status}` };
			const lyrics = fromPaxsenixApple(r.json, track.duration);
			return hasContent(lyrics) ? { status: "found", lyrics } : { status: "notfound" };
		} catch (e) {
			if (signal?.aborted) throw e;
			return { status: "error", message: `Paxsenix: ${e?.message || e}` };
		}
	},
};

// ---- providers.js ----------------------------------------------------------
// Lyrics providers + resolver.
//
// Each provider: { id, isAvailable(track), fetch(track, signal) → Result }
//   Result = { status: "found", lyrics } | { status: "notfound", instrumental? } | { status: "error", message }
// "notfound" is cacheable (negative cache); "error" is not (network hiccup, rate limit, …).
//
// Resolution: user-imported → cache → providers in the user's order. Results are ranked
// word-synced (3) > line-synced (2) > plain (1). The first result is shown right away
// (onUpdate); the search continues until the "searchUntil" quality is reached, upgrading
// the display whenever a better result arrives.


const TIMEOUT = 8000;

// ---------------------------------------------------------------------------
// Spotify (first-party, via Spicetify.CosmosAsync so auth headers are added for us)
// ---------------------------------------------------------------------------

/** Convert Spotify's color-lyrics JSON into our Lyrics model. Exported for tests. */
function fromSpotify(body, duration) {
	const data = body?.lyrics;
	if (!data || !Array.isArray(data.lines) || !data.lines.length) return null;

	if (data.syncType === "UNSYNCED") {
		return parsePlain(data.lines.map((l) => l.words || "").join("\n"));
	}

	const lines = data.lines.map((l) => {
		const time = Number(l.startTimeMs) || 0;
		const text = l.words || "";
		let words = null;
		// Some tracks are SYLLABLE_SYNCED: syllables = [{ startTimeMs, numChars }]. Use it only
		// if the shape is exactly what we expect; otherwise fall back to line sync.
		if (Array.isArray(l.syllables) && l.syllables.length > 1 && l.syllables.every((s) => s && s.numChars > 0 && s.startTimeMs != null)) {
			let pos = 0;
			words = l.syllables.map((s) => {
				const w = { time: Number(s.startTimeMs), end: null, text: text.slice(pos, pos + s.numChars) };
				pos += s.numChars;
				return w;
			});
			if (pos < text.length) words[words.length - 1].text += text.slice(pos);
		}
		return { time, text, words };
	});
	lines.sort((a, b) => a.time - b.time);
	return finalizeSynced(lines, {}, duration);
}

const spotifyProvider = {
	id: "spotify",
	isAvailable: (track) => !!track.id && (!!spotifyAuthHeaders() || !!globalThis.Spicetify?.CosmosAsync?.get),
	async fetch(track, signal) {
		const url = `https://spclient.wg.spotify.com/color-lyrics/v2/track/${track.id}?format=json&vocalRemoval=false&market=from_token`;
		const toResult = (body) => {
			const lyrics = fromSpotify(body, track.duration);
			return hasContent(lyrics) ? { status: "found", lyrics } : { status: "notfound" };
		};
		// 1) Direct request with the user's token (spclient allows the Spotify client origin).
		const auth = spotifyAuthHeaders();
		if (auth) {
			try {
				const r = await getJSON(url, { signal, headers: auth, timeout: TIMEOUT });
				if (r.status === 404) return { status: "notfound" };
				if (r.ok && r.json) return toResult(r.json);
			} catch (e) {
				if (signal?.aborted) throw e;
			}
		}
		// 2) CosmosAsync fallback. Depending on the Spicetify build it either throws or
		//    resolves to { code, error } on HTTP errors.
		let body;
		try {
			body = await withTimeout(Spicetify.CosmosAsync.get(url), TIMEOUT, "Spotify lyrics");
		} catch (e) {
			const msg = String(e?.message || e);
			if (/404|not\s*found/i.test(msg) && !/resolver/i.test(msg)) return { status: "notfound" };
			return { status: "error", message: `Spotify: ${msg}` };
		}
		if (body && body.code && body.error && !body.lyrics) {
			return body.code === 404 ? { status: "notfound" } : { status: "error", message: `Spotify: HTTP ${body.code}` };
		}
		return toResult(body);
	},
};

// ---------------------------------------------------------------------------
// LRCLIB (https://lrclib.net) — free, open, CORS-enabled, no API key.
// ---------------------------------------------------------------------------

const LRCLIB = "https://lrclib.net/api";
let lrclibBlockedUntil = 0; // set on HTTP 429

/**
 * Pick the best LRCLIB search hit for a track. Exported for tests.
 * Title AND artist must match and the duration be within 5s (so covers / other-language
 * versions are rejected); prefers synced lyrics and exact titles.
 */
function pickBestMatch(results, track) {
	if (!Array.isArray(results)) return null;
	const durSec = track.duration ? track.duration / 1000 : 0;
	let best = null;
	let bestScore = -Infinity;
	for (const r of results) {
		if (!r || (!r.syncedLyrics && !r.plainLyrics && !r.instrumental)) continue;
		if (!lrclibMatches(r, track)) continue;
		const diff = durSec && r.duration ? Math.abs(r.duration - durSec) : 0;
		let score = -diff * 0.5;
		if (normalizeTitle(r.trackName ?? r.name) === normalizeTitle(track.title)) score += 2;
		if (r.syncedLyrics) score += 2;
		if (score > bestScore) {
			best = r;
			bestScore = score;
		}
	}
	return best;
}

function lrclibMatches(rec, track) {
	return sameSong(track, { title: rec.trackName ?? rec.name, artists: [rec.artistName], durationMs: rec.duration ? rec.duration * 1000 : 0 }, 5000);
}

function lrclibRecordToLyrics(rec, duration) {
	if (rec.syncedLyrics) {
		const l = parseLRC(rec.syncedLyrics, { duration });
		if (hasContent(l)) return l;
	}
	if (rec.plainLyrics) {
		const l = parsePlain(rec.plainLyrics);
		if (hasContent(l)) return l;
	}
	return null;
}

async function lrclibRequest(path, signal) {
	if (Date.now() < lrclibBlockedUntil) {
		return { error: `LRCLIB rate-limited, retrying in ${Math.ceil((lrclibBlockedUntil - Date.now()) / 1000)}s` };
	}
	const res = await fetchWithTimeout(
		`${LRCLIB}${path}`,
		{ signal, headers: { "x-user-agent": `${EXT_ID} (spicetify ${globalThis.Spicetify?.Config?.version || "?"})` } },
		TIMEOUT,
	);
	if (res.status === 429) {
		const retry = Number(res.headers.get("retry-after")) || 60;
		lrclibBlockedUntil = Date.now() + retry * 1000;
		return { error: "LRCLIB rate limit hit" };
	}
	if (res.status === 404) return { notFound: true };
	if (!res.ok) return { error: `LRCLIB HTTP ${res.status}` };
	return { json: await res.json() };
}

const lrclibProvider = {
	id: "lrclib",
	isAvailable: (track) => !!track.title,
	async fetch(track, signal) {
		const q = (o) =>
			Object.entries(o)
				.filter(([, v]) => v !== "" && v != null)
				.map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
				.join("&");
		const primaryArtist = track.artist.split(",")[0].trim();
		try {
			// 1) Exact signature lookup (fast, precise).
			if (track.duration) {
				const r = await lrclibRequest(
					`/get?${q({ track_name: track.title, artist_name: primaryArtist, album_name: track.album, duration: Math.round(track.duration / 1000) })}`,
					signal,
				);
				if (r.error) return { status: "error", message: r.error };
				if (r.json) {
					if (lrclibMatches(r.json, track)) {
						if (r.json.instrumental) return { status: "notfound", instrumental: true };
						const lyrics = lrclibRecordToLyrics(r.json, track.duration);
						if (lyrics) return { status: "found", lyrics };
					}
				}
			}
			// 2) Fuzzy search, matched by duration + names.
			const s = await lrclibRequest(`/search?${q({ track_name: track.title, artist_name: primaryArtist })}`, signal);
			if (s.error) return { status: "error", message: s.error };
			const best = pickBestMatch(s.json, track);
			if (!best) return { status: "notfound" };
			if (best.instrumental) return { status: "notfound", instrumental: true };
			const lyrics = lrclibRecordToLyrics(best, track.duration);
			return lyrics ? { status: "found", lyrics } : { status: "notfound" };
		} catch (e) {
			if (signal?.aborted) throw e;
			return { status: "error", message: `LRCLIB: ${e?.message || e}` };
		}
	},
};

const PROVIDERS = {
	paxsenix: paxsenixProvider,
	musixmatch: musixmatchProvider,
	spotify: spotifyProvider,
	netease: neteaseProvider,
	lrclib: lrclibProvider,
	unison: unisonProvider,
};

const SOURCE_LABELS = { local: "Imported", ...Object.fromEntries(PROVIDER_INFO.map((p) => [p.id, p.label])) };

/** 3 = word-synced, 2 = line-synced, 1 = plain, 0 = nothing. */
function lyricsQuality(lyrics) {
	if (!hasContent(lyrics)) return 0;
	return lyrics.hasWords && !lyrics.estimated ? 3 : lyrics.synced ? 2 : 1;
}
const TARGET = { word: 3, synced: 2, any: 1 };

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * @param {object} track   from getCurrentTrack()
 * @param {object} s       settings.all()
 * @param {{
 *   force?: boolean,                     skip the cache
 *   only?: string,                       ask just this provider and pin its result to the track
 *   probe?: boolean,                     with `only`: just test the provider (no cache, no pin)
 *   signal?: AbortSignal,
 *   onStatus?: (msg: string) => void,
 *   onUpdate?: (res: {lyrics, source}) => void,   called for each improved interim result
 * }} opts
 * @returns {Promise<{ lyrics: object|null, source: string|null, cached?: boolean, pinned?: boolean,
 *                     instrumental?: boolean, error?: string, tried?: string[],
 *                     report?: Record<string, { status: string, quality?: number, message?: string }> }>}
 */
const inflight = new Map(); // de-duplicates concurrent plain lookups (overlay + Now Playing card)

function resolveLyrics(track, s, opts = {}) {
	if (opts.force || opts.only || opts.probe) return resolveLyricsNow(track, s, opts);
	const key = `${track.uri}|${s.searchUntil}|${JSON.stringify(s.providers)}`;
	if (inflight.has(key)) return inflight.get(key);
	const p = resolveLyricsNow(track, s, opts).finally(() => inflight.delete(key));
	inflight.set(key, p);
	return p;
}

async function resolveLyricsNow(track, s, { force = false, only, probe = false, signal, onStatus, onUpdate } = {}) {
	// 1) User-imported lyrics always win.
	if (!only) {
		const local = localLyrics.get(track);
		if (local?.text) {
			const lyrics = parseLyricsText(local.text, { duration: track.duration });
			if (hasContent(lyrics)) return { lyrics, source: "local" };
		}
	}

	const order = (only ? [only] : (s.providers || []).filter((p) => p.on).map((p) => p.id)).filter((id) => PROVIDERS[id]?.isAvailable(track));
	const target = only ? 1 : TARGET[s.searchUntil] || 3;

	// 2) Cache. A pinned (user-chosen) source always wins. Otherwise reuse a hit if it is good
	//    enough or every enabled provider was already tried; reuse a miss only if exhausted.
	if (!force && !only) {
		const c = lyricsCache.get(track.uri);
		if (c) {
			const exhausted = order.every((id) => (c.tried || [c.source]).includes(id));
			if (!c.notFound && hasContent(c.lyrics) && (c.pinned || (order.includes(c.source) && (lyricsQuality(c.lyrics) >= target || exhausted)))) {
				return { lyrics: c.lyrics, source: c.source, cached: true, pinned: !!c.pinned };
			}
			if (c.notFound && exhausted) return { lyrics: null, source: null, cached: true, instrumental: !!c.instrumental };
		}
	}

	if (!order.length) {
		return { lyrics: null, source: null, error: only ? `${SOURCE_LABELS[only]} can't be used for this track` : "All lyrics sources are disabled in settings." };
	}

	// 3) Providers, best-so-far with progressive upgrades.
	let best = null;
	const errors = [];
	const tried = [];
	const report = {}; // per-provider outcome, shown in the "Load lyrics from" picker
	let instrumental = false;
	for (const id of order) {
		onStatus?.(`Searching ${SOURCE_LABELS[id]}…`);
		let r;
		try {
			// Providers may report a quick partial result (e.g. Musixmatch line sync while its
			// word timing is still loading) so something shows up without waiting.
			const partial = (lyrics) => {
				const q = lyricsQuality(lyrics);
				if (!signal?.aborted && (!best || q > best.quality) && q < target) onUpdate?.({ lyrics, source: id });
			};
			r = await PROVIDERS[id].fetch(track, signal, partial);
		} catch (e) {
			if (signal?.aborted) throw e;
			r = { status: "error", message: String(e?.message || e) };
		}
		if (signal?.aborted) throw new DOMException("aborted", "AbortError");

		report[id] = { status: r.status, message: r.message };
		if (r.status === "error") {
			errors.push({ id, message: r.message });
			console.warn(`[aurora-lyrics] ${r.message}`);
		} else if (r.status !== "skipped") tried.push(id);

		if (r.status === "found") {
			const q = lyricsQuality(r.lyrics);
			report[id].quality = q;
			if (!best || q > best.quality) {
				best = { lyrics: r.lyrics, source: id, quality: q };
				if (q < target) onUpdate?.({ lyrics: r.lyrics, source: id });
			}
			if (q >= target) break;
		} else if (r.instrumental) {
			instrumental = true;
		}
	}

	if (best) {
		// Cache once the search finished; `tried` lets a later run skip providers already asked.
		if (!probe) lyricsCache.set(track.uri, best.source, best.lyrics, { tried: errors.length ? [best.source] : tried, pinned: !!only });
		return { lyrics: best.lyrics, source: best.source, pinned: !!only, tried, report };
	}
	const skippedAll = order.every((id) => report[id]?.status === "skipped");
	if (!errors.length && !only && !skippedAll) {
		// Definitive miss from every enabled provider: cache it so we don't hammer APIs.
		lyricsCache.set(track.uri, null, null, { notFound: true, tried, instrumental });
	}
	let error;
	if (errors.length) error = `Couldn't reach ${errors.map((e) => SOURCE_LABELS[e.id]).join(", ")} (${errors[0].message})`;
	else if (skippedAll) error = "Lyrics sources are busy right now. Try again in a few minutes.";
	return { lyrics: null, source: null, instrumental, tried, report, error };
}

// ---- icons.js --------------------------------------------------------------
// Inline SVG icons (24x24). Stroke icons inherit currentColor; transport icons are filled.

const svg = (body, size = 20) =>
	`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const filled = (body, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${body}</svg>`;

const ICONS = {
	// Topbar / playbar button: stacked lyric lines with a music note.
	// Drawn like Spotify's own top-bar icons: solid shapes on a 16px grid in currentColor, so it
	// matches their weight and follows the theme's hover / active colours. Same motif as the
	// logo: three lyric lines (the middle one longest) and a note at the top right.
	lyrics: (size = 16) =>
		`<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">` +
		'<rect x="1" y="3.6" width="8" height="1.6" rx=".8"/>' +
		'<rect x="1" y="7.4" width="12" height="1.6" rx=".8"/>' +
		'<rect x="1" y="11.2" width="10" height="1.6" rx=".8"/>' +
		// note: head, stem, and a small flag
		'<circle cx="11.9" cy="5.1" r="1.45"/>' +
		'<rect x="12.55" y="0.6" width="0.8" height="4.6" rx=".4"/>' +
		'<path d="M12.95 .6c.25 1 .9 1.4 1.6 1.8.5.3.75.8.6 1.5-.25-.55-.8-.9-1.5-1.1l-.7-.2z"/>' +
		"</svg>",
	close: () => svg('<path d="M6 6l12 12M18 6L6 18"/>'),
	settings: () => svg('<path d="M4 7h9M18 7h2M4 17h3M12 17h8"/><circle cx="15.5" cy="7" r="2.3"/><circle cx="9.5" cy="17" r="2.3"/>'),
	reload: () => svg('<path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/>'),
	edit: () => svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
	// Mini lyrics: a small window with a lyric line; pop out: window with an arrow leaving it.
	mini: () => svg('<rect x="3" y="5" width="18" height="14" rx="2.5"/><rect x="11" y="12" width="7.5" height="4.5" rx="1.2" fill="currentColor" stroke="none"/>', 18),
	popOut: () => svg('<path d="M19 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4.5"/><path d="M14 4h6v6M20 4l-8 8"/>', 18),
	share: () => svg('<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M5 12.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5.5"/>'),
	copy: () => svg('<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2.2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>', 18),
	download: () => svg('<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M4.5 19.5h15"/>', 18),
	fullscreen: () => svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
	exitFullscreen: () => svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
	pin: () => svg('<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
	unpin: () => svg('<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>'),
	upload: () => svg('<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v4h16v-4"/>'),
	minus: () => svg('<path d="M6 12h12"/>', 16),
	plus: () => svg('<path d="M12 6v12M6 12h12"/>', 16),

	play: () => filled('<path d="M6.7 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 6.7 5.14z"/>', 22), // optically centred ▶
	pause: () => filled('<rect x="6" y="4.5" width="4" height="15" rx="1.4"/><rect x="14" y="4.5" width="4" height="15" rx="1.4"/>', 22),
	next: () => filled('<path d="M5 6.2v11.6a.9.9 0 0 0 1.4.75l8.3-5.8a.9.9 0 0 0 0-1.5L6.4 5.45A.9.9 0 0 0 5 6.2z"/><rect x="16.5" y="5" width="2.6" height="14" rx="1.2"/>', 18),
	prev: () => filled('<path d="M19 6.2v11.6a.9.9 0 0 1-1.4.75l-8.3-5.8a.9.9 0 0 1 0-1.5l8.3-5.8A.9.9 0 0 1 19 6.2z"/><rect x="4.9" y="5" width="2.6" height="14" rx="1.2"/>', 18),

	shuffle: () => svg('<path d="M16 4h4v4"/><path d="M4 18h3.5a4 4 0 0 0 3.3-1.7l2.4-3.6a4 4 0 0 1 3.3-1.7H20"/><path d="M16 20h4v-4"/><path d="M4 6h3.5a4 4 0 0 1 3.3 1.7l.7 1"/><path d="M13.7 15.3l.7 1A4 4 0 0 0 17.7 18H20"/><path d="M20 4l-3 3M20 20l-3-3"/>', 19),
	repeat: () => svg('<path d="M17 3l3 3-3 3"/><path d="M4 11V9.5A3.5 3.5 0 0 1 7.5 6H20"/><path d="M7 21l-3-3 3-3"/><path d="M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H4"/>', 19),
	repeatOne: () => svg('<path d="M17 3l3 3-3 3"/><path d="M4 11V9.5A3.5 3.5 0 0 1 7.5 6H20"/><path d="M7 21l-3-3 3-3"/><path d="M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H4"/><path d="M11.5 10.5l1.5-1v5" stroke-width="1.7"/>', 19),
	heart: () => svg('<path d="M12 20s-7.5-4.6-9.2-9.3C1.7 7.6 3.8 4.5 7 4.5c2 0 3.3 1.1 5 3 1.7-1.9 3-3 5-3 3.2 0 5.3 3.1 4.2 6.2C19.5 15.4 12 20 12 20z"/>', 19),
	heartFill: () => filled('<path d="M12 20s-7.5-4.6-9.2-9.3C1.7 7.6 3.8 4.5 7 4.5c2 0 3.3 1.1 5 3 1.7-1.9 3-3 5-3 3.2 0 5.3 3.1 4.2 6.2C19.5 15.4 12 20 12 20z"/>', 19),
	volHigh: () => svg('<path d="M4 9.5h3l4.5-4v13L7 14.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/>', 19),
	volLow: () => svg('<path d="M4 9.5h3l4.5-4v13L7 14.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/>', 19),
	volMute: () => svg('<path d="M4 9.5h3l4.5-4v13L7 14.5H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>', 19),

	// Settings rail
	navLyrics: () => svg('<path d="M4 6h10M4 11h7M4 16h6"/><path d="M17 18.5V9l4-1.2"/><circle cx="15" cy="18.5" r="2.1"/>', 21),
	navLook: () => svg('<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.4-1.3-1.6-1.3-2.9 0-1 .8-1.7 1.8-1.7h2.2a4 4 0 0 0 4-4C20.5 6.6 16.7 3.5 12 3.5z"/><circle cx="7.6" cy="11" r="1.1"/><circle cx="10.3" cy="7.3" r="1.1"/><circle cx="14.8" cy="7.6" r="1.1"/>', 21),
	navMotion: () => svg('<path d="M3 12c2.2-4 4.4-4 6.6 0s4.4 4 6.6 0 3.3-2.7 4.8-1.5"/><path d="M3 17.5c2.2-2.4 4.4-2.4 6.6 0" opacity=".5"/><path d="M13.5 6.5c1.7-1.9 3.4-1.9 5.1 0" opacity=".5"/>', 21),
	navSources: () => svg('<ellipse cx="12" cy="6" rx="7.5" ry="2.8"/><path d="M4.5 6v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6"/><path d="M4.5 12v6c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-6"/>', 21),
	navGeneral: () => svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a7.7 7.7 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.6 7.6 0 0 0 7 6.5l-2.4-1-2 3.4 2 1.6a7.7 7.7 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 2.6-1.5l2.4 1 2-3.4z"/>', 21),
	translate: () => svg('<path d="M4 5h9M8.5 3v2M6 5c.6 3 2.6 5.4 5.5 6.6M11 5c-.8 3.6-3.2 6.2-6.8 7.4"/><path d="M12.5 21l4.2-10 4.3 10M14 17.6h5.4"/>', 19),
	search: () => svg('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>', 16),

	alignLeft: () => svg('<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>', 16),
	alignCenter: () => svg('<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>', 16),
	alignRight: () => svg('<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>', 16),
	note: () => svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>', 28),
};

/**
 * Tiny illustrations for the animation-style cards (viewBox 60x40).
 * Bars stand for lyric lines; the bright one is the active line.
 */
const STYLE_ART = {
	flow: `<svg viewBox="0 0 60 40" aria-hidden="true"><rect x="6" y="5" width="34" height="4" rx="2" opacity=".25" transform="translate(0 -1)"/><rect x="6" y="15" width="44" height="6" rx="3"/><rect x="6" y="27" width="30" height="4" rx="2" opacity=".35" transform="translate(2 1)"/><rect x="6" y="35" width="24" height="3" rx="1.5" opacity=".15" transform="translate(4 1)"/></svg>`,
	slide: `<svg viewBox="0 0 60 40" aria-hidden="true"><rect x="6" y="4" width="34" height="4" rx="2" opacity=".25"/><rect x="6" y="15" width="44" height="6" rx="3"/><rect x="6" y="27" width="30" height="4" rx="2" opacity=".35"/><rect x="6" y="35" width="24" height="3" rx="1.5" opacity=".15"/></svg>`,
	scale: `<svg viewBox="0 0 60 40" aria-hidden="true"><rect x="6" y="5" width="26" height="3" rx="1.5" opacity=".25"/><rect x="6" y="14" width="48" height="8" rx="4"/><rect x="6" y="28" width="24" height="3" rx="1.5" opacity=".3"/></svg>`,
	fade: `<svg viewBox="0 0 60 40" aria-hidden="true"><rect x="16" y="7" width="28" height="3" rx="1.5" opacity=".3"/><rect x="8" y="17" width="44" height="6" rx="3"/><rect x="18" y="30" width="24" height="3" rx="1.5" opacity=".3"/></svg>`,
	cinematic: `<svg viewBox="0 0 60 40" aria-hidden="true"><rect x="5" y="15" width="50" height="10" rx="5"/></svg>`,

	// Word animations: three "words", the middle one being sung.
	fill: `<svg viewBox="0 0 60 40" aria-hidden="true"><rect x="4" y="16" width="14" height="8" rx="4"/><rect x="21" y="16" width="18" height="8" rx="4" opacity=".3"/><rect x="21" y="16" width="10" height="8" rx="4"/><rect x="42" y="16" width="14" height="8" rx="4" opacity=".3"/></svg>`,
	glow: `<svg viewBox="0 0 60 40" aria-hidden="true"><circle cx="30" cy="20" r="13" opacity=".16"/><rect x="4" y="16" width="14" height="8" rx="4"/><rect x="21" y="16" width="18" height="8" rx="4"/><rect x="42" y="16" width="14" height="8" rx="4" opacity=".3"/></svg>`,
	pop: `<svg viewBox="0 0 60 40" aria-hidden="true"><rect x="4" y="17" width="13" height="7" rx="3.5"/><rect x="19" y="11" width="22" height="11" rx="5.5"/><rect x="43" y="17" width="13" height="7" rx="3.5" opacity=".3"/></svg>`,
	rise: `<svg viewBox="0 0 60 40" aria-hidden="true"><rect x="4" y="14" width="14" height="8" rx="4"/><rect x="21" y="16" width="18" height="8" rx="4" opacity=".75"/><rect x="42" y="21" width="14" height="8" rx="4" opacity=".3"/></svg>`,
	karaoke: `<svg viewBox="0 0 60 40" aria-hidden="true"><rect x="4" y="16" width="52" height="8" rx="4" opacity=".3"/><rect x="4" y="16" width="30" height="8" rx="4"/><rect x="33" y="12" width="2" height="16" rx="1"/></svg>`,
	letters: `<svg viewBox="0 0 60 40" aria-hidden="true"><rect x="6" y="17" width="6" height="8" rx="2"/><rect x="14" y="13" width="6" height="8" rx="2"/><rect x="22" y="11" width="6" height="8" rx="2"/><rect x="30" y="14" width="6" height="8" rx="2" opacity=".7"/><rect x="38" y="17" width="6" height="8" rx="2" opacity=".35"/><rect x="46" y="17" width="6" height="8" rx="2" opacity=".35"/></svg>`,
};

// Layout cards
Object.assign(STYLE_ART, {
	split: `<svg viewBox="0 0 60 40" aria-hidden="true"><rect x="5" y="9" width="20" height="20" rx="3"/><rect x="31" y="11" width="24" height="3.5" rx="1.75" opacity=".35"/><rect x="31" y="18" width="22" height="4.5" rx="2.25"/><rect x="31" y="26" width="18" height="3.5" rx="1.75" opacity=".35"/></svg>`,
	mirror: `<svg viewBox="0 0 60 40" aria-hidden="true"><rect x="35" y="9" width="20" height="20" rx="3"/><rect x="5" y="11" width="24" height="3.5" rx="1.75" opacity=".35"/><rect x="5" y="18" width="22" height="4.5" rx="2.25"/><rect x="5" y="26" width="18" height="3.5" rx="1.75" opacity=".35"/></svg>`,
	poster: `<svg viewBox="0 0 60 40" aria-hidden="true"><defs><linearGradient id="pg" x1="0" x2="1"><stop offset=".55" stop-color="currentColor"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><rect x="0" y="0" width="30" height="40" fill="url(#pg)" opacity=".8"/><rect x="34" y="12" width="22" height="3.5" rx="1.75" opacity=".35"/><rect x="34" y="19" width="20" height="4.5" rx="2.25"/><rect x="34" y="27" width="16" height="3.5" rx="1.75" opacity=".35"/></svg>`,
	vinyl: `<svg viewBox="0 0 60 40" aria-hidden="true"><circle cx="16" cy="20" r="12" opacity=".55"/><circle cx="16" cy="20" r="8" fill="none" stroke="currentColor" stroke-width=".6" opacity=".4"/><circle cx="16" cy="20" r="4.5"/><rect x="33" y="12" width="22" height="3.5" rx="1.75" opacity=".35"/><rect x="33" y="19" width="20" height="4.5" rx="2.25"/><rect x="33" y="27" width="16" height="3.5" rx="1.75" opacity=".35"/></svg>`,
	stage: `<svg viewBox="0 0 60 40" aria-hidden="true"><rect x="18" y="3" width="10" height="10" rx="2"/><rect x="30" y="5" width="12" height="2.5" rx="1.25" opacity=".6"/><rect x="30" y="9" width="8" height="2" rx="1" opacity=".35"/><rect x="12" y="19" width="36" height="4.5" rx="2.25"/><rect x="16" y="27" width="28" height="3.5" rx="1.75" opacity=".35"/><rect x="20" y="33" width="20" height="3" rx="1.5" opacity=".2"/></svg>`,
	captions: `<svg viewBox="0 0 60 40" aria-hidden="true"><rect x="20" y="3" width="20" height="20" rx="3"/><rect x="12" y="27" width="36" height="4.5" rx="2.25"/><rect x="17" y="34" width="26" height="3" rx="1.5" opacity=".35"/></svg>`,
	lyrics: `<svg viewBox="0 0 60 40" aria-hidden="true"><rect x="6" y="8" width="34" height="3.5" rx="1.75" opacity=".3"/><rect x="6" y="16" width="46" height="5" rx="2.5"/><rect x="6" y="25" width="38" height="3.5" rx="1.75" opacity=".35"/><rect x="6" y="32" width="28" height="3" rx="1.5" opacity=".2"/></svg>`,
});

const ARROWS = {
	up: () => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>',
	down: () => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
};

// ---- styles.js -------------------------------------------------------------
const CSS = ".aur-root {\n--aur-font: var(--encore-title-font-stack, \"SpotifyMixUITitle\", \"SpotifyMixUI\", \"CircularSp\", system-ui, sans-serif);\n--aur-fs: 56px;\n--aur-gap: 0.55em;\n--aur-fw: 800;\n--aur-shade: 0.45;\n--aur-bg-scale: 12;\n--aur-bg-blur: 6px;\n--aur-c1: var(--aur-album-c1, #4b3b78);\n--aur-c2: var(--aur-album-c2, #14203a);\n--aur-accent: var(--aur-album-accent, #ffffff);\n--aur-ah: 1.2em;\n--aur-ui-font: var(--encore-body-font-stack, \"SpotifyMixUI\", \"CircularSp\", \"Segoe UI Variable Text\", system-ui, sans-serif);\n--aur-size: min(var(--aur-fs), 7.4vw, 10.5vh);\n--aur-hi: #fff;\n--aur-dim: color-mix(in srgb, var(--aur-hi) 30%, transparent);\n--aur-glow-tint: color-mix(in oklab, var(--aur-accent) 62%, #fff);\n--aur-glow-k: 1;\n--aur-glow-c: color-mix(in oklab, var(--aur-glow-tint) 45%, transparent);\n--aur-green: #1ed760;\n--aur-origin: 0%;\n--aur-pad: max(7vw, 20px);\n--aur-ease: cubic-bezier(0.22, 1, 0.36, 1);\n--aur-spring: cubic-bezier(0.34, 1.56, 0.64, 1);\n--aur-wave: cubic-bezier(0.3, 1.12, 0.44, 1);\n--aur-stagger: 0ms;\n--aur-move: 0.85s;\n--aur-move-ease: var(--aur-ease);\nposition: fixed;\ninset: 0;\nz-index: 99999;\noverflow: hidden;\noverflow: clip;\nisolation: isolate;\ncolor: #fff;\nbackground: #08080b;\nfont-family: var(--aur-ui-font);\n-webkit-font-smoothing: antialiased;\ntext-rendering: optimizeLegibility;\n-webkit-app-region: no-drag;\noutline: none;\nuser-select: none;\nopacity: 0;\ntransform: scale(1.035);\ntransition:\nopacity 0.42s var(--aur-ease),\ntransform 0.7s var(--aur-ease);\n}\n.aur-root[hidden] { display: none; }\n.aur-root.is-open { opacity: 1; transform: none; }\n.aur-root *, .aur-root *::before, .aur-root *::after { box-sizing: border-box; }\n.aur-root ::selection { background: rgba(255, 255, 255, 0.28); }\n.aur-root[data-align=\"center\"] { --aur-origin: 50%; }\n.aur-root[data-align=\"right\"] { --aur-origin: 100%; }\n.aur-root[data-glow=\"radiant\"] { --aur-glow-k: 1.7; }\n.aur-root[data-glow=\"off\"] { --aur-glow-k: 0; }\n.aur-root[data-color=\"accent\"] { --aur-hi: color-mix(in srgb, var(--aur-accent) 42%, #fff); }\n.aur-root[data-accent=\"custom\"] {\n--aur-accent: var(--aur-user-accent, #ffffff);\n--aur-c1: color-mix(in oklab, var(--aur-user-accent, #4b3b78) 62%, #000);\n--aur-c2: color-mix(in oklab, var(--aur-user-accent, #14203a) 22%, #07070c);\n}\n.aur-root[data-anim=\"flow\"] { --aur-stagger: 36ms; --aur-move: 1.05s; --aur-move-ease: var(--aur-wave); }\n.aur-root[data-anim=\"scale\"] { --aur-stagger: 14ms; --aur-move: 0.95s; --aur-move-ease: cubic-bezier(0.34, 1.3, 0.64, 1); }\n.aur-bg { position: absolute; inset: 0; z-index: -1; overflow: hidden; background: #0a0a0e; }\n.aur-bg-stack, .aur-bg-layer { position: absolute; inset: 0; }\n.aur-bg-layer { opacity: 0; transition: opacity 1.6s ease; }\n.aur-bg-layer.is-on { opacity: 1; }\n.aur-blob {\nposition: absolute;\nleft: 50%;\ntop: 50%;\nwidth: 256px;\nheight: 256px;\nmax-width: none;\nmargin: -128px 0 0 -128px;\nobject-fit: cover;\nfilter: blur(var(--aur-bg-blur)) saturate(1.7) brightness(0.92);\ntransform: translate(var(--bx, 0), var(--by, 0)) scale(calc(var(--aur-bg-scale) * var(--bs, 1)));\nanimation: aur-spin var(--bt, 120s) linear infinite;\nwill-change: transform;\n}\n.aur-blob.b3 { --bt: 150s; animation-direction: reverse; }\n.aur-blob.b1 { --bx: -20vw; --by: -14vh; --bs: 0.7; --bt: 70s; opacity: 0.85; border-radius: 42%; animation-delay: -20s; }\n.aur-blob.b2 { --bx: 22vw; --by: 16vh; --bs: 0.62; --bt: 95s; opacity: 0.7; border-radius: 46%; animation-direction: reverse; animation-delay: -45s; }\n.aur-root[data-bganim=\"off\"] .aur-blob,\n.aur-root[data-bganim=\"off\"] .aur-bg-gradient { animation-play-state: paused; }\n@keyframes aur-spin { to { rotate: 360deg; } }\n.aur-bg-gradient {\nposition: absolute;\ninset: -30%;\nopacity: 0;\nbackground:\nradial-gradient(42% 42% at 30% 35%, var(--aur-c1) 0%, transparent 70%),\nradial-gradient(48% 48% at 70% 65%, var(--aur-c2) 0%, transparent 72%),\nradial-gradient(35% 35% at 75% 20%, color-mix(in srgb, var(--aur-accent) 40%, transparent) 0%, transparent 70%),\n#0b0b10;\ntransition: opacity 1s ease;\nanimation: aur-drift 36s ease-in-out infinite alternate;\n}\n.aur-root[data-bg=\"gradient\"] .aur-bg-gradient { opacity: 1; }\n.aur-root:not([data-bg=\"gradient\"]) .aur-bg-gradient { animation: none; }\n.aur-root:not([data-bg=\"album\"]) .aur-bg-stack { display: none; }\n@keyframes aur-drift {\nfrom { transform: translate3d(-3%, -2%, 0) rotate(0deg) scale(1); }\nto { transform: translate3d(3%, 2%, 0) rotate(10deg) scale(1.1); }\n}\n.aur-bg-shade {\nposition: absolute;\ninset: 0;\nbackground:\nlinear-gradient(to top, rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0.18) 16%, transparent 34%),\nradial-gradient(ellipse at 42% 40%, rgba(0, 0, 0, calc(var(--aur-shade) * 0.6)) 0%, rgba(0, 0, 0, var(--aur-shade)) 100%);\n}\n.aur-bg-grain {\nposition: absolute;\ninset: 0;\nopacity: 0.08;\nmix-blend-mode: overlay;\nbackground-size: 180px 180px;\nbackground-image: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\");\npointer-events: none;\n}\n.aur-drag { position: absolute; top: 0; left: 0; right: 0; height: 40px; -webkit-app-region: drag; z-index: 1; }\n.aur-header {\nposition: absolute;\ntop: 30px;\nleft: var(--aur-pad);\nz-index: 2;\ndisplay: flex;\nalign-items: center;\ngap: 14px;\nmax-width: min(560px, 55vw);\npointer-events: none;\ntransition: opacity 0.5s ease, transform 0.6s var(--aur-ease);\n}\n.aur-root[data-info=\"off\"] .aur-header { display: none; }\n.aur-cover { width: 54px; height: 54px; flex: none; border-radius: 8px; object-fit: cover; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45); }\n.aur-meta { min-width: 0; }\n.aur-title, .aur-artist { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.aur-title { font-size: 15.5px; font-weight: 700; letter-spacing: -0.01em; }\n.aur-artist { margin-top: 3px; font-size: 13px; color: rgba(255, 255, 255, 0.62); }\n.aur-stage {\nposition: absolute;\ninset: 0;\npadding: 0 var(--aur-pad);\noverflow: hidden;\n-webkit-mask-image: linear-gradient(to bottom, transparent 0, transparent 72px, #000 calc(72px + 13%), #000 72%, transparent 93%);\nmask-image: linear-gradient(to bottom, transparent 0, transparent 72px, #000 calc(72px + 13%), #000 72%, transparent 93%);\n}\n.aur-lines { position: relative; }\n.aur-root:not([data-transport=\"off\"]) .aur-stage { bottom: 96px; }\n.aur-root[data-align=\"center\"] .aur-stage { text-align: center; }\n.aur-root[data-align=\"right\"] .aur-stage { text-align: right; }\n.aur-stage > .aur-lines,\n.aur-stage > .aur-message { transition: opacity 0.22s ease, filter 0.22s ease; }\n.aur-stage.is-leaving > .aur-lines,\n.aur-stage.is-leaving > .aur-message { opacity: 0; filter: blur(8px); }\n.aur-line {\n--aur-s: 0.95;\n--aur-k: 0;\nfont-family: var(--aur-font);\nfont-size: var(--aur-size);\nfont-weight: var(--aur-fw);\nline-height: 1.16;\nletter-spacing: -0.022em;\npadding: calc(var(--aur-gap) / 2) 0;\nmax-width: 1400px;\ncolor: var(--aur-hi);\nopacity: 0.1;\ntransform-origin: var(--aur-origin) 50%;\noverflow-wrap: anywhere;\ntext-wrap: balance;\nfont-kerning: normal;\ncursor: pointer;\ntransition:\nopacity 0.7s var(--aur-ease),\ntransform var(--aur-move) var(--aur-move-ease) calc(var(--aur-k) * var(--aur-stagger)),\nfilter 0.7s var(--aur-ease),\ncolor 0.5s ease,\ntext-shadow 0.7s ease;\n}\n.aur-root[data-align=\"center\"] .aur-line { margin-inline: auto; }\n.aur-root[data-align=\"right\"] .aur-line { margin-left: auto; }\n.aur-root .aur-line.is-active { --aur-s: 1; opacity: 1; cursor: default; }\n.aur-root:not([data-glow=\"off\"]) .aur-line.is-active:not(.has-words) .aur-main {\ntext-shadow:\n0 0 0.05em color-mix(in srgb, #fff calc(28% * var(--aur-glow-k)), transparent),\n0 0 0.26em color-mix(in oklab, var(--aur-glow-tint) calc(30% * var(--aur-glow-k)), transparent),\n0 0 0.85em color-mix(in oklab, var(--aur-glow-tint) calc(16% * var(--aur-glow-k)), transparent);\n}\n.aur-main { transition: text-shadow 0.8s ease; }\n.aur-main { position: relative; }\n.aur-main::before {\n--a: calc(13% * var(--aur-glow-k));\ncontent: \"\";\nposition: absolute;\nz-index: -1;\nleft: calc(var(--hx, 0px) - 1.1em);\ntop: calc(var(--hy, 0px) - 0.7em);\nwidth: calc(var(--hw, 100%) + 2.2em);\nheight: calc(var(--hh, 100%) + 1.4em);\npointer-events: none;\nbackground: radial-gradient(closest-side, color-mix(in oklab, var(--aur-glow-tint) var(--a), transparent) 0%, color-mix(in oklab, var(--aur-glow-tint) calc(var(--a) * 0.45), transparent) 55%, transparent 100%);\nopacity: 0;\ntransform: scale(0.85);\ntransition: opacity 1.2s ease, transform 1.6s var(--aur-ease);\n}\n.aur-line.is-active .aur-main::before { opacity: 1; transform: none; }\n.aur-stage[data-mode=\"unsynced\"] .aur-main::before { display: none; }\n@property --aur-wp { syntax: \"<number>\"; inherits: true; initial-value: 0; }\n.aur-wg { display: inline-block; white-space: nowrap; }\n.aur-w, .aur-c { display: inline-block; }\n.aur-root[data-words=\"on\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--p: var(--aur-wp);\n--e: calc(var(--p) * var(--p) * (3 - 2 * var(--p)));\n--hop: sin(calc(var(--e) * 3.14159));\n--edge: 0.75em;\ntransform-origin: 50% 90%;\nwill-change: transform;\n}\n.aur-root[data-words=\"on\"] .is-active.has-words .aur-w .aur-c {\n--wave: 2.6;\n--p: clamp(0, (var(--aur-wp) * (var(--n) + var(--wave)) - var(--i)) / var(--wave), 1);\n--edge: 0.4em;\n}\n.aur-root[data-words=\"on\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\ncolor: color-mix(in srgb, var(--aur-hi) calc(var(--e) * 100%), var(--aur-dim));\ntransform: translateY(calc(0.03em - var(--e) * 0.075em));\n}\n.aur-root:not([data-glow=\"off\"])[data-words=\"on\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--g: calc(var(--e) * var(--aur-glow-k));\nfilter:\ndrop-shadow(0 0 0.04em color-mix(in srgb, #fff calc(32% * var(--g)), transparent))\ndrop-shadow(0 0 0.3em color-mix(in oklab, var(--aur-glow-tint) calc(34% * var(--g)), transparent));\n}\n.aur-root[data-words=\"on\"]:is([data-wordanim=\"fill\"], [data-wordanim=\"rise\"], [data-wordanim=\"karaoke\"], [data-wordanim=\"letters\"]) .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\ncolor: transparent;\nbackground-image: linear-gradient(90deg, var(--aur-ink, var(--aur-hi)) calc(var(--p) * (100% + var(--edge)) - var(--edge)), var(--aur-dim) calc(var(--p) * (100% + var(--edge))));\n-webkit-background-clip: text;\nbackground-clip: text;\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"glow\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--lit: clamp(0, var(--e) * 3, 1);\ncolor: color-mix(in srgb, var(--aur-hi) calc(var(--lit) * 100%), var(--aur-dim));\ntransform: translateY(calc(0.03em - var(--lit) * 0.07em)) scale(calc(1 + 0.04 * var(--hop)));\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"glow\"] .is-active .aur-w.now:not(.has-chars),\n.aur-root[data-words=\"on\"][data-wordanim=\"glow\"] .is-active .aur-w.now .aur-c {\n--gk: max(var(--aur-glow-k), 0.6);\nfilter:\ndrop-shadow(0 0 0.05em color-mix(in srgb, #fff calc((30% + 25% * var(--hop)) * var(--gk)), transparent))\ndrop-shadow(0 0 calc(0.25em + 0.3em * var(--hop)) color-mix(in oklab, var(--aur-glow-tint) calc((32% + 30% * var(--hop)) * var(--gk)), transparent));\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"pop\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--lit: clamp(0, var(--e) * 4, 1);\ncolor: color-mix(in srgb, var(--aur-hi) calc(var(--lit) * 100%), var(--aur-dim));\ntransform: translateY(calc(0.03em - var(--lit) * 0.06em - 0.06em * var(--hop))) scale(calc(1 + 0.12 * var(--hop)));\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"rise\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--up: clamp(0, var(--e) * 2.2, 1);\n--up-e: calc(1 - (1 - var(--up)) * (1 - var(--up)));\nopacity: calc(0.45 + 0.55 * var(--up-e));\ntransform: translateY(calc((1 - var(--up-e)) * 0.2em - 0.04em));\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"karaoke\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--aur-ink: var(--aur-kink, color-mix(in srgb, var(--aur-accent) 70%, #fff));\n--edge: 0.18em;\ntransform: none;\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"letters\"] .is-active.has-words .aur-w .aur-c {\ntransform: translateY(calc(0.03em - var(--e) * 0.06em - 0.13em * var(--hop))) scale(calc(1 + 0.09 * var(--hop)));\n}\n.aur-root[data-words=\"on\"]:not([data-wordanim=\"karaoke\"]):not([data-wordanim=\"letters\"]) .is-active .aur-w.is-long .aur-c {\ntransform: translateY(calc(0.03em - var(--e) * 0.075em - 0.08em * var(--hop))) scale(calc(1 + 0.05 * var(--hop)));\n}\n.aur-root[data-words=\"on\"] .is-active .aur-w.is-long.now .aur-c {\nfilter:\ndrop-shadow(0 0 0.05em color-mix(in srgb, #fff calc((20% + 30% * var(--hop)) * var(--aur-glow-k)), transparent))\ndrop-shadow(0 0 calc(0.22em + 0.25em * var(--hop)) color-mix(in oklab, var(--aur-glow-tint) calc((30% + 35% * var(--hop)) * var(--aur-glow-k)), transparent));\n}\n.aur-tr {\nmargin-top: 0.22em;\nfont-family: var(--aur-ui-font);\nfont-size: 0.44em;\nfont-weight: 600;\nline-height: 1.3;\nletter-spacing: 0;\ncolor: rgba(255, 255, 255, 0.62);\ntext-wrap: balance;\ntransition: color 0.5s ease;\n}\n.aur-line.is-active .aur-tr { color: rgba(255, 255, 255, 0.9); }\n.aur-stage[data-mode=\"unsynced\"] .aur-tr { font-size: 0.6em; }\n.aur-root[data-view=\"captions\"] .aur-tr { font-size: 0.5em; }\n.aur-tr-btn.is-on { background: rgba(255, 255, 255, 0.08); }\n.aur-root { --aur-duet: oklch(from var(--aur-accent) 0.86 clamp(0.09, c, 0.16) h); }\n.aur-root:is([data-color=\"accent\"], [data-wordanim=\"karaoke\"]) { --aur-duet: oklch(from var(--aur-accent) 0.86 clamp(0.09, c, 0.16) calc(h + 150)); }\n.aur-root[data-duet=\"on\"] .aur-line[data-singer=\"1\"] { --aur-hi: var(--aur-duet); --aur-kink: var(--aur-duet); }\n.aur-root[data-duet=\"on\"] .aur-line[data-singer=\"2\"] { --aur-hi: color-mix(in oklab, var(--aur-duet) 50%, #fff); --aur-kink: color-mix(in oklab, var(--aur-duet) 50%, #fff); }\n.aur-root[data-duet=\"on\"] .aur-line:is([data-singer=\"1\"], [data-singer=\"2\"]) {\n--aur-dim: color-mix(in srgb, var(--aur-hi) 30%, transparent);\n--aur-glow-tint: color-mix(in oklab, var(--aur-hi) 70%, #fff);\n--aur-glow-c: color-mix(in oklab, var(--aur-glow-tint) 45%, transparent);\n}\n.aur-root[data-align=\"left\"] .aur-line.is-opposite { --aur-origin: 100%; text-align: right; margin-left: auto; }\n.aur-root[data-align=\"right\"] .aur-line.is-opposite { --aur-origin: 0%; text-align: left; margin-left: 0; margin-right: auto; }\n.aur-bgv {\nmargin-top: 0.12em;\nfont-size: 0.56em;\nfont-weight: calc(var(--aur-fw) - 100);\nletter-spacing: -0.01em;\nopacity: 0.55;\ntransition: opacity 0.6s ease;\n}\n.aur-line.is-active .aur-bgv { opacity: 0.85; }\n.aur-line.is-gap { cursor: default; }\n.aur-dots { display: inline-flex; align-items: center; gap: 0.32em; height: 1.16em; transform-origin: var(--aur-origin) 50%; }\n.aur-dots i { width: 0.28em; height: 0.28em; border-radius: 50%; background: var(--aur-hi); opacity: 0.3; transform: scale(0.8); transition: opacity 0.4s ease, transform 0.5s var(--aur-spring); }\n.is-active .aur-dots { animation: aur-breathe 3s ease-in-out infinite; }\n.is-active .aur-dots i:nth-child(1) { opacity: calc(0.3 + 0.7 * clamp(0, var(--aur-gp, 0) * 3, 1)); transform: scale(calc(0.8 + 0.35 * clamp(0, var(--aur-gp, 0) * 3, 1))); }\n.is-active .aur-dots i:nth-child(2) { opacity: calc(0.3 + 0.7 * clamp(0, var(--aur-gp, 0) * 3 - 1, 1)); transform: scale(calc(0.8 + 0.35 * clamp(0, var(--aur-gp, 0) * 3 - 1, 1))); }\n.is-active .aur-dots i:nth-child(3) { opacity: calc(0.3 + 0.7 * clamp(0, var(--aur-gp, 0) * 3 - 2, 1)); transform: scale(calc(0.8 + 0.35 * clamp(0, var(--aur-gp, 0) * 3 - 2, 1))); }\n@keyframes aur-breathe {\n0%, 100% { transform: scale(1); }\n50% { transform: scale(1.14); }\n}\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line {\ntransform: translate3d(0, var(--aur-y, 0px), 0) scale(var(--aur-s));\n}\n.aur-root[data-anim=\"flow\"] .aur-line { --aur-s: 0.96; }\n.aur-root[data-anim=\"scale\"] .aur-line { --aur-s: 0.8; }\n.aur-root[data-anim=\"scale\"] .aur-line[data-d=\"-1\"],\n.aur-root[data-anim=\"scale\"] .aur-line[data-d=\"1\"] { --aur-s: 0.86; }\n.aur-root .aur-line.is-active { --aur-s: 1; }\n.aur-root[data-anim=\"scale\"] .aur-line.is-active { --aur-s: 1.04; }\n.aur-root[data-layout=\"list\"] .aur-line[data-d=\"-1\"], .aur-root[data-layout=\"list\"] .aur-line[data-d=\"1\"] { opacity: 0.36; }\n.aur-root[data-layout=\"list\"] .aur-line[data-d=\"-2\"], .aur-root[data-layout=\"list\"] .aur-line[data-d=\"2\"] { opacity: 0.24; }\n.aur-root[data-layout=\"list\"] .aur-line[data-d=\"-3\"], .aur-root[data-layout=\"list\"] .aur-line[data-d=\"3\"] { opacity: 0.17; }\n.aur-root[data-layout=\"list\"] .aur-line[data-d=\"-4\"], .aur-root[data-layout=\"list\"] .aur-line[data-d=\"4\"] { opacity: 0.13; }\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-1\"],\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"1\"] { filter: blur(0.8px); }\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-2\"],\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"2\"] { filter: blur(1.5px); }\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-3\"],\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"3\"] { filter: blur(2.2px); }\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-4\"],\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"4\"],\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-5\"],\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"5\"],\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-6\"],\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"6\"] { filter: blur(2.8px); }\n.aur-lines[data-dir=\"up\"] .aur-line[data-d=\"-1\"] { --aur-k: 1; }\n.aur-lines[data-dir=\"up\"] .aur-line[data-d=\"0\"] { --aur-k: 2; }\n.aur-lines[data-dir=\"up\"] .aur-line[data-d=\"1\"] { --aur-k: 3; }\n.aur-lines[data-dir=\"up\"] .aur-line[data-d=\"2\"] { --aur-k: 4; }\n.aur-lines[data-dir=\"up\"] .aur-line[data-d=\"3\"] { --aur-k: 5; }\n.aur-lines[data-dir=\"up\"] .aur-line[data-d=\"4\"] { --aur-k: 6; }\n.aur-lines[data-dir=\"up\"] .aur-line[data-d=\"5\"] { --aur-k: 7; }\n.aur-lines[data-dir=\"up\"] .aur-line[data-d=\"6\"],\n.aur-lines[data-dir=\"up\"] .aur-line.is-active ~ .aur-line:not([data-d]) { --aur-k: 8; }\n.aur-lines[data-dir=\"down\"] .aur-line:not([data-d]) { --aur-k: 8; }\n.aur-lines[data-dir=\"down\"] .aur-line.is-active ~ .aur-line:not([data-d]) { --aur-k: 0; }\n.aur-lines[data-dir=\"down\"] .aur-line[data-d=\"1\"] { --aur-k: 1; }\n.aur-lines[data-dir=\"down\"] .aur-line[data-d=\"0\"] { --aur-k: 2; }\n.aur-lines[data-dir=\"down\"] .aur-line[data-d=\"-1\"] { --aur-k: 3; }\n.aur-lines[data-dir=\"down\"] .aur-line[data-d=\"-2\"] { --aur-k: 4; }\n.aur-lines[data-dir=\"down\"] .aur-line[data-d=\"-3\"] { --aur-k: 5; }\n.aur-lines[data-dir=\"down\"] .aur-line[data-d=\"-4\"] { --aur-k: 6; }\n.aur-lines[data-dir=\"down\"] .aur-line[data-d=\"-5\"] { --aur-k: 7; }\n.aur-lines[data-dir=\"down\"] .aur-line[data-d=\"-6\"] { --aur-k: 8; }\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-gap) { position: relative; }\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-active):not(.is-gap):hover { opacity: 0.82; filter: none; transition-duration: 0.25s, var(--aur-move), 0.25s, 0.3s, 0.3s; }\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-gap)::after {\ncontent: \"\";\nposition: absolute;\nz-index: -1;\ninset: 0 -0.32em;\nborder-radius: 0.28em;\nbackground: linear-gradient(90deg, rgba(255, 255, 255, 0.09), rgba(255, 255, 255, 0.04));\nbox-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06), 0 0.2em 0.6em rgba(0, 0, 0, 0.12);\nopacity: 0;\ntransform: scale(0.97);\ntransition: opacity 0.25s ease, transform 0.4s var(--aur-ease);\npointer-events: none;\n}\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-time]::before {\ncontent: attr(data-time) \"  ▶\";\nposition: absolute;\ntop: 50%;\nright: 0.1em;\npadding: 0.35em 0.75em;\nborder-radius: 99px;\nbackground: rgba(0, 0, 0, 0.28);\nfont-family: var(--aur-ui-font);\nfont-size: max(11px, 0.2em);\nfont-weight: 700;\nletter-spacing: 0.02em;\nwhite-space: pre;\ncolor: rgba(255, 255, 255, 0.85);\nopacity: 0;\ntransform: translate(0.4em, -50%);\ntransition: opacity 0.2s ease, transform 0.35s var(--aur-ease);\npointer-events: none;\n}\n.aur-root[data-align=\"right\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-time]::before { right: auto; left: 0.1em; transform: translate(-0.4em, -50%); }\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-gap):hover::after { opacity: 1; transform: none; }\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-time]:hover::before { opacity: 1; transform: translate(0, -50%); }\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-gap):active::after { transform: scale(0.985); }\n.aur-root[data-view=\"captions\"] .aur-line::before, .aur-root[data-view=\"captions\"] .aur-line::after { display: none; }\n.aur-root[data-layout=\"list\"] .aur-stage.is-browsing .aur-line {\n--aur-k: 0 !important;\nfilter: none !important;\ntransition:\nopacity 0.4s ease,\ntransform 0.45s var(--aur-ease),\nfilter 0.3s ease,\ncolor 0.4s ease,\ntext-shadow 0.4s ease;\n}\n.aur-root[data-layout=\"list\"] .aur-stage.is-browsing .aur-line:not(.is-active) { opacity: 0.42; }\n.aur-root[data-layout=\"list\"] .aur-stage.is-browsing .aur-line:not(.is-active):not(.is-gap):hover { opacity: 0.9; }\n.aur-root[data-layout=\"list\"] .aur-stage.is-entering[data-mode=\"synced\"] .aur-line {\nanimation: aur-line-in 1s var(--aur-ease) backwards;\nanimation-delay: calc(var(--i, 0) * 55ms);\n}\n@keyframes aur-line-in {\nfrom { opacity: 0; transform: translate3d(0, calc(var(--aur-y, 0px) + 64px), 0) scale(var(--aur-s)); filter: blur(12px); }\n}\n.aur-root[data-layout=\"stack\"] .aur-stage[data-mode=\"synced\"] .aur-lines { position: absolute; top: 0; bottom: 0; left: var(--aur-pad); right: var(--aur-pad); }\n.aur-root[data-layout=\"stack\"] .aur-stage[data-mode=\"synced\"] .aur-line {\nposition: absolute;\nleft: 0;\nright: 0;\ntop: 44%;\nopacity: 0;\npointer-events: none;\ntransform: translateY(-50%) scale(0.5);\n}\n.aur-root[data-layout=\"stack\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active { opacity: 1; pointer-events: auto; transform: translateY(-50%); }\n.aur-root[data-layout=\"stack\"] .aur-stage.is-entering[data-mode=\"synced\"] .aur-lines { animation: aur-fade-up 0.9s var(--aur-ease) backwards; }\n.aur-root[data-anim=\"fade\"] .aur-line { transition-duration: 0.55s, 0.8s, 0.6s, 0.5s, 0.6s; }\n.aur-root[data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-1\"] { opacity: 0.3; pointer-events: auto; transform: translateY(calc(var(--aur-ah) / -2 - 0.3em - 81%)) scale(0.62); }\n.aur-root[data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"1\"] { opacity: 0.3; pointer-events: auto; transform: translateY(calc(var(--aur-ah) / 2 + 0.3em - 19%)) scale(0.62); }\n.aur-root[data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-2\"] { transform: translateY(calc(var(--aur-ah) / -2 - 1.6em - 75%)) scale(0.5); }\n.aur-root[data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"2\"] { transform: translateY(calc(var(--aur-ah) / 2 + 1.6em - 25%)) scale(0.5); }\n.aur-root[data-depth=\"on\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-1\"],\n.aur-root[data-depth=\"on\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"1\"] { filter: blur(1px); }\n.aur-root[data-anim=\"cinematic\"] .aur-line { letter-spacing: -0.015em; transition-duration: 0.9s, 1.1s, 0.9s, 0.5s, 0.9s; }\n.aur-root[data-anim=\"cinematic\"] .aur-stage[data-mode=\"synced\"] .aur-line { transform: translateY(calc(-50% + 0.45em)) scale(0.97); }\n.aur-root[data-anim=\"cinematic\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d] { filter: blur(16px); }\n.aur-root[data-anim=\"cinematic\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d^=\"-\"] { transform: translateY(calc(-50% - 0.45em)) scale(1.03); }\n.aur-root[data-anim=\"cinematic\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active { filter: none; transform: translateY(-50%) scale(1.05); transition-delay: 0s, 0.14s, 0.14s, 0s, 0s; }\n.aur-root[data-context=\"off\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-active) { opacity: 0 !important; pointer-events: none; }\n.aur-stage[data-mode=\"unsynced\"] { overflow-y: auto; scrollbar-width: none; }\n.aur-stage[data-mode=\"unsynced\"]::-webkit-scrollbar { display: none; }\n.aur-stage[data-mode=\"unsynced\"] .aur-lines { padding: 24vh 0 42vh; }\n.aur-stage[data-mode=\"unsynced\"] .aur-line {\nfont-size: calc(var(--aur-size) * 0.66);\nline-height: 1.28;\npadding: calc(var(--aur-gap) / 3.5) 0;\nopacity: 0.9;\ntransform: none;\ncursor: text;\nuser-select: text;\n}\n.aur-stage[data-mode=\"unsynced\"] .aur-line.is-gap { height: 0.9em; }\n.aur-stage[data-mode=\"unsynced\"] .aur-dots { display: none; }\n.aur-stage.is-entering[data-mode=\"unsynced\"] .aur-lines { animation: aur-fade-up 0.9s var(--aur-ease) backwards; }\n@keyframes aur-fade-up {\nfrom { opacity: 0; transform: translateY(28px); filter: blur(8px); }\n}\n.aur-message {\nposition: absolute;\ninset: 0;\ndisplay: none;\nflex-direction: column;\nalign-items: center;\njustify-content: center;\ngap: 8px;\npadding: 60px 8vw 150px;\ntext-align: center;\n}\n.aur-stage[data-mode=\"message\"] .aur-message { display: flex; }\n.aur-message-art {\nwidth: clamp(120px, 30vh, 280px);\naspect-ratio: 1;\nmargin-bottom: 22px;\nborder-radius: 14px;\noverflow: hidden;\nbox-shadow: 0 30px 80px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.06);\n}\n.aur-message-art img { display: block; width: 100%; height: 100%; object-fit: cover; }\n.aur-message[data-kind=\"loading\"] .aur-message-art { animation: aur-pulse 2.4s ease-in-out infinite; }\n.aur-message-icon { color: rgba(255, 255, 255, 0.55); margin-bottom: 6px; }\n.aur-message-icon:empty { display: none; }\n.aur-message-title { font-family: var(--aur-font); font-size: clamp(22px, calc(var(--aur-size) * 0.6), 40px); font-weight: 800; letter-spacing: -0.02em; line-height: 1.15; }\n.aur-message-detail { min-height: 1.5em; max-width: 520px; font-size: 15px; line-height: 1.5; color: rgba(255, 255, 255, 0.6); }\n.aur-message[data-kind=\"error\"] .aur-message-title { color: #ffb4a8; }\n.aur-message-action { margin-top: 14px; }\n.aur-spinner { display: flex; gap: 7px; margin-bottom: 6px; }\n.aur-spinner i { width: 7px; height: 7px; border-radius: 50%; background: #fff; animation: aur-bounce 1.2s var(--aur-ease) infinite; }\n.aur-spinner i:nth-child(2) { animation-delay: 0.15s; }\n.aur-spinner i:nth-child(3) { animation-delay: 0.3s; }\n.aur-stage.is-entering[data-mode=\"message\"] .aur-message > * { animation: aur-fade-up 0.8s var(--aur-ease) backwards; }\n.aur-stage.is-entering[data-mode=\"message\"] .aur-message > :nth-child(2) { animation-delay: 0.06s; }\n.aur-stage.is-entering[data-mode=\"message\"] .aur-message > :nth-child(3) { animation-delay: 0.12s; }\n.aur-stage.is-entering[data-mode=\"message\"] .aur-message > :nth-child(4) { animation-delay: 0.18s; }\n.aur-stage.is-entering[data-mode=\"message\"] .aur-message > :nth-child(5) { animation-delay: 0.24s; }\n.aur-stage.is-entering[data-mode=\"message\"] .aur-message > .aur-message-art { animation: aur-art-in 1s var(--aur-ease) backwards; }\n@keyframes aur-bounce {\n0%, 100% { transform: translateY(0); opacity: 0.35; }\n40% { transform: translateY(-7px); opacity: 1; }\n}\n@keyframes aur-pulse {\n0%, 100% { transform: scale(1); }\n50% { transform: scale(0.975); }\n}\n@keyframes aur-art-in {\nfrom { opacity: 0; transform: translateY(20px) scale(0.92); filter: blur(10px); }\n}\n:where(.aur-root) button { appearance: none; margin: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; -webkit-app-region: no-drag; }\n.aur-root button:focus-visible,\n.aur-root select:focus-visible,\n.aur-root input:focus-visible,\n.aur-root textarea:focus-visible,\n.aur-progress:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }\n.aur-icon-btn {\ndisplay: inline-grid;\nplace-items: center;\nflex: none;\nwidth: 36px;\nheight: 36px;\nborder-radius: 50%;\ncolor: rgba(255, 255, 255, 0.72);\ntransition: background 0.2s ease, color 0.2s ease, transform 0.25s var(--aur-spring);\n}\n.aur-icon-btn:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }\n.aur-icon-btn:active { transform: scale(0.9); }\n.aur-icon-btn.is-on { color: var(--aur-green); }\n.aur-btn {\ndisplay: inline-flex;\nalign-items: center;\njustify-content: center;\ngap: 8px;\nheight: 36px;\npadding: 0 16px;\nborder-radius: 999px;\nbackground: rgba(255, 255, 255, 0.1);\nfont-size: 13px;\nfont-weight: 700;\ntransition: background 0.2s ease, transform 0.2s var(--aur-spring), box-shadow 0.2s ease;\n}\n.aur-btn svg { width: 16px; height: 16px; }\n.aur-btn:hover { background: rgba(255, 255, 255, 0.17); }\n.aur-btn:active { transform: scale(0.96); }\n.aur-btn:disabled { opacity: 0.4; pointer-events: none; }\n.aur-btn-ghost { background: transparent; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18); }\n.aur-btn-ghost:hover { background: rgba(255, 255, 255, 0.07); }\n.aur-btn-primary { background: #fff; color: #000; }\n.aur-btn-primary:hover { background: #fff; transform: scale(1.03); box-shadow: 0 6px 20px rgba(255, 255, 255, 0.15); }\n.aur-btn-danger { background: transparent; color: #ff8a7a; box-shadow: inset 0 0 0 1px rgba(255, 138, 122, 0.35); }\n.aur-root {\n--aur-toggle-on: color-mix(in oklab, var(--aur-accent) 50%, #fff);\n--aur-ctl: rgba(255, 255, 255, 0.72);\n}\n.aur-player {\nposition: absolute;\nleft: 0;\nright: 0;\nbottom: 0;\nz-index: 3;\ndisplay: grid;\ngrid-template-columns: minmax(0, 1fr) minmax(300px, 640px) minmax(0, 1fr);\nalign-items: end;\ncolumn-gap: 28px;\npadding: 0 var(--aur-pad) 20px;\npointer-events: none;\ntransition: opacity 0.5s ease, transform 0.65s var(--aur-ease);\n}\n.aur-player > * { pointer-events: auto; }\n.aur-player-side { display: flex; align-items: center; gap: 4px; height: 58px; min-width: 0; }\n.aur-player-side.is-left { grid-column: 1; justify-content: flex-start; }\n.aur-player-center { grid-column: 2; display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 0; }\n.aur-player-side.is-right { grid-column: 3; justify-content: flex-end; }\n.aur-root[data-transport=\"off\"] .aur-player-center { display: none; }\n.aur-scrub { width: 100%; }\n.aur-progress { --p: 0; --hx: 0; position: relative; height: 18px; cursor: pointer; touch-action: none; border-radius: 4px; }\n.aur-progress-track {\nposition: absolute;\nleft: 0;\nright: 0;\ntop: 50%;\nheight: 4px;\nmargin-top: -2px;\noverflow: hidden;\nborder-radius: 99px;\nbackground: rgba(255, 255, 255, 0.16);\ntransition: height 0.25s var(--aur-ease), margin 0.25s var(--aur-ease), background 0.25s ease;\n}\n.aur-progress-fill {\nposition: absolute;\ninset: 0;\nborder-radius: inherit;\nbackground: linear-gradient(90deg, rgba(255, 255, 255, 0.75), #fff);\ntransform-origin: 0 50%;\ntransform: scaleX(var(--p));\n}\n.aur-progress-knob-rail { position: absolute; inset: 0; transform: translateX(calc(var(--p) * 100%)); pointer-events: none; }\n.aur-progress-knob {\nposition: absolute;\nleft: -7px;\ntop: 50%;\nwidth: 14px;\nheight: 14px;\nmargin-top: -7px;\nborder-radius: 50%;\nbackground: #fff;\nbox-shadow: 0 2px 10px rgba(0, 0, 0, 0.35), 0 0 0 4px color-mix(in oklab, var(--aur-glow-tint) 25%, transparent);\ntransform: scale(0);\ntransition: transform 0.3s var(--aur-spring);\n}\n.aur-progress:hover .aur-progress-track,\n.aur-progress.is-scrubbing .aur-progress-track { height: 7px; margin-top: -3.5px; background: rgba(255, 255, 255, 0.22); }\n.aur-progress:hover .aur-progress-knob,\n.aur-progress.is-scrubbing .aur-progress-knob,\n.aur-progress:focus-visible .aur-progress-knob { transform: scale(1); }\n.aur-progress.is-scrubbing .aur-progress-knob { transform: scale(1.15); }\n.aur-progress-tip {\nposition: absolute;\nbottom: 20px;\nleft: calc(var(--hx) * 100%);\npadding: 3px 8px;\nborder-radius: 7px;\nbackground: rgba(18, 18, 22, 0.88);\nborder: 1px solid rgba(255, 255, 255, 0.08);\nfont-size: 11.5px;\nfont-weight: 600;\nfont-variant-numeric: tabular-nums;\nwhite-space: nowrap;\npointer-events: none;\nopacity: 0;\ntransform: translate(-50%, 4px);\ntransition: opacity 0.18s ease, transform 0.25s var(--aur-ease);\n}\n.aur-progress:hover .aur-progress-tip,\n.aur-progress.is-scrubbing .aur-progress-tip { opacity: 1; transform: translate(-50%, 0); }\n.aur-times { display: flex; justify-content: space-between; margin-top: 1px; }\n.aur-time { font-size: 11.5px; font-weight: 500; font-variant-numeric: tabular-nums; color: rgba(255, 255, 255, 0.55); }\n.aur-transport { display: flex; align-items: center; gap: 20px; }\n.aur-skip { width: 42px; height: 42px; color: rgba(255, 255, 255, 0.92); }\n.aur-skip svg { width: 22px; height: 22px; }\n.aur-toggle { position: relative; color: rgba(255, 255, 255, 0.5); }\n.aur-toggle.is-on { color: var(--aur-toggle-on); }\n.aur-toggle::after {\ncontent: \"\";\nposition: absolute;\nleft: 50%;\nbottom: 3px;\nwidth: 4px;\nheight: 4px;\nmargin-left: -2px;\nborder-radius: 50%;\nbackground: currentColor;\nopacity: 0;\ntransform: scale(0);\ntransition: opacity 0.2s ease, transform 0.3s var(--aur-spring);\n}\n.aur-toggle.is-on::after { opacity: 1; transform: none; }\n.aur-play-btn {\nposition: relative;\ndisplay: grid;\nplace-items: center;\nwidth: 58px;\nheight: 58px;\nflex: none;\nborder-radius: 50%;\nbackground: #fff;\ncolor: #0b0b0e;\nbox-shadow: 0 10px 30px rgba(0, 0, 0, 0.3), 0 0 0 0 color-mix(in oklab, var(--aur-glow-tint) 30%, transparent);\ntransition: transform 0.35s var(--aur-spring), box-shadow 0.4s ease;\n}\n.aur-play-btn:hover { transform: scale(1.06); box-shadow: 0 12px 34px rgba(0, 0, 0, 0.32), 0 0 0 8px color-mix(in oklab, var(--aur-glow-tint) 16%, transparent); }\n.aur-play-btn:active { transform: scale(0.93); }\n.aur-pp { position: absolute; inset: 0; display: grid; place-items: center; transition: opacity 0.22s ease, transform 0.4s var(--aur-spring); }\n.aur-pp svg { width: 26px; height: 26px; }\n.aur-pp.is-pause { opacity: 0; transform: scale(0.5) rotate(-90deg); }\n.aur-root[data-playing=\"true\"] .aur-pp.is-play { opacity: 0; transform: scale(0.5) rotate(90deg); }\n.aur-root[data-playing=\"true\"] .aur-pp.is-pause { opacity: 1; transform: none; }\n.aur-source {\ndisplay: inline-flex;\nalign-items: center;\ngap: 8px;\nmin-width: 0;\nmax-width: 230px;\nheight: 32px;\npadding: 0 12px 0 10px;\nborder-radius: 99px;\nbackground: rgba(255, 255, 255, 0.07);\nfont-size: 12px;\nfont-weight: 600;\nwhite-space: nowrap;\noverflow: hidden;\ntext-overflow: ellipsis;\ncolor: rgba(255, 255, 255, 0.78);\ntransition: background 0.2s ease, color 0.2s ease;\n}\n.aur-source:hover { background: rgba(255, 255, 255, 0.13); color: #fff; }\n.aur-source::before { content: \"\"; flex: none; width: 7px; height: 7px; border-radius: 50%; background: #777; }\n.aur-source[data-kind=\"synced\"]::before { background: var(--aur-green); }\n.aur-source[data-kind=\"word-synced\"]::before { background: #7cd4ff; box-shadow: 0 0 8px #7cd4ff; }\n.aur-source[data-kind=\"unsynced\"]::before { background: #f5c451; }\n.aur-offset-group { display: inline-flex; align-items: center; flex: none; height: 32px; margin-left: 6px; border-radius: 99px; background: rgba(255, 255, 255, 0.05); }\n.aur-mini-btn { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; color: rgba(255, 255, 255, 0.6); transition: background 0.2s ease, color 0.2s ease; }\n.aur-mini-btn:hover { background: rgba(255, 255, 255, 0.12); color: #fff; }\n.aur-offset { min-width: 54px; height: 30px; font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; text-align: center; color: #fff; }\n.aur-offset.is-zero { color: rgba(255, 255, 255, 0.45); }\n.aur-player-side .aur-icon-btn { color: var(--aur-ctl); }\n.aur-heart { transition: color 0.2s ease, transform 0.35s var(--aur-spring); }\n.aur-heart.is-on { color: var(--aur-green); }\n.aur-heart.is-on svg { animation: aur-heart-pop 0.45s var(--aur-spring); }\n@keyframes aur-heart-pop { 40% { transform: scale(1.3); } }\n.aur-volume { display: flex; align-items: center; }\n.aur-vol {\n--v: 1;\n-webkit-appearance: none;\nappearance: none;\nwidth: 0;\nheight: 18px;\nmargin: 0;\nbackground: transparent;\nopacity: 0;\ncursor: pointer;\ntransition: width 0.35s var(--aur-ease), opacity 0.25s ease, margin 0.35s var(--aur-ease);\n}\n.aur-volume:hover .aur-vol,\n.aur-vol:focus-visible { width: 86px; margin: 0 6px 0 2px; opacity: 1; }\n.aur-vol::-webkit-slider-runnable-track { height: 4px; border-radius: 99px; background: linear-gradient(to right, #fff calc(var(--v) * 100%), rgba(255, 255, 255, 0.18) calc(var(--v) * 100%)); }\n.aur-vol::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; margin-top: -4px; border-radius: 50%; background: #fff; box-shadow: 0 1px 6px rgba(0, 0, 0, 0.4); }\n.aur-vol::-moz-range-track { height: 4px; border-radius: 99px; background: rgba(255, 255, 255, 0.18); }\n.aur-vol::-moz-range-progress { height: 4px; border-radius: 99px; background: #fff; }\n.aur-vol::-moz-range-thumb { width: 12px; height: 12px; border: 0; border-radius: 50%; background: #fff; }\n.aur-player-side .aur-sep { flex: none; width: 1px; height: 20px; margin: 0 6px; background: rgba(255, 255, 255, 0.14); }\n.aur-mini-progress { position: absolute; left: 0; right: 0; bottom: 0; z-index: 3; height: 2px; background: rgba(255, 255, 255, 0.07); opacity: 0; transition: opacity 0.8s ease; pointer-events: none; }\n.aur-mini-fill { height: 100%; background: linear-gradient(90deg, rgba(255, 255, 255, 0.35), rgba(255, 255, 255, 0.75)); transform-origin: 0 50%; transform: scaleX(var(--p, 0)); }\n.aur-root[data-idle=\"true\"] .aur-mini-progress { opacity: 1; transition-delay: 0.3s; }\n.aur-root[data-idle=\"true\"] { cursor: none; }\n.aur-root[data-idle=\"true\"] .aur-chrome { opacity: 0; pointer-events: none; }\n.aur-root[data-idle=\"true\"] .aur-player { transform: translateY(18px); }\n.aur-root[data-idle=\"true\"] .aur-header { transform: translateY(-10px); }\n.aur-root.is-open .aur-player { animation: aur-rise 0.8s var(--aur-ease) 0.1s backwards; }\n.aur-root.is-open .aur-header { animation: aur-drop 0.8s var(--aur-ease) 0.05s backwards; }\n@keyframes aur-rise { from { opacity: 0; transform: translateY(28px); } }\n@keyframes aur-drop { from { opacity: 0; transform: translateY(-14px); } }\n.aur-toast {\nposition: absolute;\nleft: 50%;\nbottom: 150px;\nz-index: 5;\nmax-width: calc(100vw - 32px);\npadding: 9px 18px;\nborder-radius: 999px;\nbackground: rgba(24, 24, 28, 0.82);\nborder: 1px solid rgba(255, 255, 255, 0.1);\nbox-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);\nbackdrop-filter: blur(20px);\nfont-size: 13px;\nfont-weight: 600;\nwhite-space: nowrap;\noverflow: hidden;\ntext-overflow: ellipsis;\nopacity: 0;\npointer-events: none;\ntransform: translate(-50%, 10px) scale(0.96);\ntransition: opacity 0.25s ease, transform 0.4s var(--aur-spring);\n}\n.aur-root[data-transport=\"off\"] .aur-toast { bottom: 84px; }\n.aur-toast.is-on { opacity: 1; transform: translate(-50%, 0) scale(1); }\n.aur-root { --aur-safe-top: 52px; }\n.aur-root[data-fs=\"true\"] { --aur-safe-top: 12px; }\n.aur-panel {\nposition: absolute;\ntop: var(--aur-safe-top);\nright: 12px;\nbottom: 12px;\nz-index: 4;\nwidth: min(520px, calc(100vw - 24px));\ndisplay: grid;\ngrid-template-columns: 76px minmax(0, 1fr);\noverflow: hidden;\nborder-radius: 22px;\nbackground: linear-gradient(180deg, rgba(32, 32, 38, 0.86), rgba(18, 18, 22, 0.9));\nborder: 1px solid rgba(255, 255, 255, 0.08);\nbox-shadow: 0 40px 100px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.06);\nbackdrop-filter: blur(40px) saturate(1.5);\nfont-size: 14px;\n-webkit-app-region: no-drag;\nopacity: 0;\nvisibility: hidden;\ntransform: translateX(28px) scale(0.985);\ntransform-origin: right center;\ntransition: transform 0.5s var(--aur-ease), opacity 0.3s ease, visibility 0s linear 0.5s;\n}\n.aur-panel.is-open { opacity: 1; visibility: visible; transform: none; transition-delay: 0s; }\n.aur-panel [hidden] { display: none !important; }\n.aur-rail {\nposition: relative;\ndisplay: flex;\nflex-direction: column;\ngap: 4px;\npadding: 14px 8px;\nbackground: rgba(0, 0, 0, 0.18);\nborder-right: 1px solid rgba(255, 255, 255, 0.05);\n}\n.aur-rail-btn {\nposition: relative;\nz-index: 1;\ndisplay: flex;\nflex-direction: column;\nalign-items: center;\njustify-content: center;\ngap: 5px;\nheight: 62px;\nborder-radius: 14px;\ncolor: rgba(255, 255, 255, 0.5);\ntransition: color 0.25s ease, background 0.25s ease;\n}\n.aur-rail-btn:hover { color: rgba(255, 255, 255, 0.88); background: rgba(255, 255, 255, 0.04); }\n.aur-rail-btn[aria-selected=\"true\"] { color: #fff; background: none; }\n.aur-rail-icon { display: grid; transition: transform 0.35s var(--aur-spring); }\n.aur-rail-btn[aria-selected=\"true\"] .aur-rail-icon { transform: translateY(-1px) scale(1.06); }\n.aur-rail-icon svg { width: 21px; height: 21px; }\n.aur-rail-label { font-size: 10.5px; font-weight: 650; letter-spacing: 0.01em; }\n.aur-rail-pill {\nposition: absolute;\ntop: 14px;\nleft: 8px;\nright: 8px;\nheight: 62px;\nborder-radius: 14px;\nbackground: rgba(255, 255, 255, 0.1);\nbox-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.07);\ntransform: translateY(calc(var(--i, 1) * 66px));\ntransition: transform 0.45s var(--aur-ease), opacity 0.2s ease;\n}\n.aur-rail-pill::before { content: \"\"; position: absolute; left: -8px; top: 20px; bottom: 20px; width: 3px; border-radius: 0 3px 3px 0; background: var(--aur-toggle-on); }\n.aur-panel[data-searching=\"true\"] .aur-rail-pill { opacity: 0; }\n.aur-panel-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }\n.aur-panel-head {\ndisplay: grid;\ngrid-template-columns: minmax(0, 1fr) auto;\nalign-items: start;\ngap: 14px 8px;\npadding: 18px 14px 14px 20px;\nborder-bottom: 1px solid rgba(255, 255, 255, 0.05);\n}\n.aur-panel-title { font-family: var(--aur-font); font-size: 21px; font-weight: 800; line-height: 1.15; letter-spacing: -0.02em; }\n.aur-panel-sub { margin-top: 3px; font-size: 12.5px; color: rgba(255, 255, 255, 0.5); }\n.aur-panel-close { margin: -4px -2px 0 0; background: rgba(255, 255, 255, 0.06); }\n.aur-panel-close:hover { background: rgba(255, 255, 255, 0.14); }\n.aur-search-wrap { grid-column: 1 / -1; position: relative; display: block; }\n.aur-search-icon { position: absolute; left: 11px; top: 50%; display: grid; transform: translateY(-50%); color: rgba(255, 255, 255, 0.45); pointer-events: none; }\n.aur-search {\nwidth: 100%;\nheight: 36px;\npadding: 0 12px 0 34px;\nborder: 1px solid rgba(255, 255, 255, 0.08);\nborder-radius: 11px;\nbackground: rgba(0, 0, 0, 0.25);\ncolor: #fff;\nfont: inherit;\nfont-size: 13px;\noutline: none;\ntransition: border-color 0.2s ease, background 0.2s ease;\n}\n.aur-search::placeholder { color: rgba(255, 255, 255, 0.4); }\n.aur-search:focus { border-color: rgba(255, 255, 255, 0.28); background: rgba(0, 0, 0, 0.35); }\n.aur-search::-webkit-search-cancel-button { filter: invert(1) opacity(0.5); cursor: pointer; }\n.aur-panel-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 16px 24px 18px; scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.15) transparent; }\n.aur-panel-scroll::-webkit-scrollbar { width: 8px; }\n.aur-panel-scroll::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 99px; background: rgba(255, 255, 255, 0.15) padding-box; }\n.aur-panel.is-open .aur-tab-body:not([hidden]) > * { animation: aur-fade-up 0.5s var(--aur-ease) backwards; }\n.aur-panel.is-open .aur-tab-body:not([hidden]) > :nth-child(2) { animation-delay: 0.04s; }\n.aur-panel.is-open .aur-tab-body:not([hidden]) > :nth-child(3) { animation-delay: 0.08s; }\n.aur-panel.is-open .aur-tab-body:not([hidden]) > :nth-child(n + 4) { animation-delay: 0.12s; }\n.aur-no-results { padding: 48px 0; text-align: center; font-size: 13px; color: rgba(255, 255, 255, 0.5); }\n.aur-tab-body[data-tab=\"track\"] > .aur-np { margin: 14px 0 4px; }\n@media (max-width: 600px) {\n.aur-panel { grid-template-columns: 58px minmax(0, 1fr); }\n.aur-rail-label { display: none; }\n.aur-rail-btn, .aur-rail-pill { height: 50px; }\n.aur-rail-pill { transform: translateY(calc(var(--i, 1) * 54px)); }\n}\n.aur-section h3 { margin: 22px 4px 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: rgba(255, 255, 255, 0.45); }\n.aur-section-card { padding: 2px 14px; border-radius: 14px; background: rgba(255, 255, 255, 0.045); border: 1px solid rgba(255, 255, 255, 0.05); }\n.aur-section-card > .aur-row + .aur-row { border-top: 1px solid rgba(255, 255, 255, 0.06); }\n.aur-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 46px; padding: 10px 0; cursor: pointer; transition: opacity 0.2s ease; }\n.aur-row > span, .aur-row-label > span { font-size: 13.5px; color: rgba(255, 255, 255, 0.9); }\n.aur-row.is-disabled { opacity: 0.35; pointer-events: none; }\n.aur-row-stack, .aur-row-range { flex-direction: column; align-items: stretch; gap: 10px; cursor: default; }\n.aur-row-range { gap: 6px; cursor: pointer; }\n.aur-row-label { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }\n.aur-range-value { font-size: 12px; font-variant-numeric: tabular-nums; color: rgba(255, 255, 255, 0.55); }\n.aur-range { --p: 50%; -webkit-appearance: none; appearance: none; width: 100%; height: 18px; margin: 0; background: transparent; cursor: pointer; }\n.aur-range::-webkit-slider-runnable-track { height: 4px; border-radius: 99px; background: linear-gradient(to right, #fff var(--p), rgba(255, 255, 255, 0.16) var(--p)); }\n.aur-range::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; margin-top: -6px; border-radius: 50%; background: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45); transition: transform 0.2s var(--aur-spring); }\n.aur-range:hover::-webkit-slider-thumb { transform: scale(1.12); }\n.aur-range:active::-webkit-slider-thumb { transform: scale(1.25); }\n.aur-range::-moz-range-track { height: 4px; border-radius: 99px; background: rgba(255, 255, 255, 0.16); }\n.aur-range::-moz-range-progress { height: 4px; border-radius: 99px; background: #fff; }\n.aur-range::-moz-range-thumb { width: 16px; height: 16px; border: 0; border-radius: 50%; background: #fff; }\n.aur-switch { appearance: none; position: relative; flex: none; width: 40px; height: 24px; margin: 0; border-radius: 99px; background: rgba(255, 255, 255, 0.2); cursor: pointer; transition: background 0.25s ease; }\n.aur-switch::before { content: \"\"; position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35); transition: transform 0.35s var(--aur-spring); }\n.aur-switch:checked { background: var(--aur-green); }\n.aur-switch:checked::before { transform: translateX(16px); }\n.aur-segmented { display: flex; gap: 2px; padding: 3px; border-radius: 11px; background: rgba(0, 0, 0, 0.28); }\n.aur-seg { flex: 1; display: grid; place-items: center; height: 30px; border-radius: 8px; font-size: 12.5px; font-weight: 600; color: rgba(255, 255, 255, 0.6); transition: background 0.25s ease, color 0.2s ease, box-shadow 0.25s ease; }\n.aur-seg:hover { color: #fff; }\n.aur-seg[aria-checked=\"true\"] { background: rgba(255, 255, 255, 0.16); color: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3); }\n.aur-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(98px, 1fr)); gap: 8px; }\n.aur-card, .aur-font {\ndisplay: flex;\nflex-direction: column;\ngap: 2px;\npadding: 10px;\nborder-radius: 12px;\nbackground: rgba(255, 255, 255, 0.05);\nborder: 1px solid rgba(255, 255, 255, 0.06);\ntext-align: left;\ntransition: background 0.2s ease, border-color 0.2s ease, transform 0.25s var(--aur-spring);\n}\n.aur-card:hover, .aur-font:hover { background: rgba(255, 255, 255, 0.09); }\n.aur-card:active, .aur-font:active { transform: scale(0.97); }\n.aur-card[aria-checked=\"true\"], .aur-font[aria-checked=\"true\"] { background: rgba(30, 215, 96, 0.12); border-color: rgba(30, 215, 96, 0.75); }\n.aur-card-art { display: block; width: 100%; height: 38px; margin-bottom: 6px; color: rgba(255, 255, 255, 0.8); }\n.aur-card-art svg { width: 100%; height: 100%; fill: currentColor; }\n.aur-card[aria-checked=\"true\"] .aur-card-art { color: var(--aur-green); }\n.aur-card-name { font-size: 13px; font-weight: 700; }\n.aur-card-hint { font-size: 11px; color: rgba(255, 255, 255, 0.5); }\n.aur-themes { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); }\n.aur-theme-art {\nposition: relative;\ndisplay: grid;\nplace-items: center;\nheight: 52px;\nmargin-bottom: 6px;\nborder-radius: 8px;\noverflow: hidden;\nbackground: radial-gradient(120% 140% at 20% 10%, var(--t1) 0%, transparent 70%), var(--t2);\nbox-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);\n}\n.aur-theme-art span { font-size: 24px; font-weight: 800; line-height: 1; color: #fff; text-shadow: 0 0 14px color-mix(in oklab, var(--t1) 70%, transparent); }\n.aur-theme[aria-checked=\"true\"] .aur-theme-art { box-shadow: inset 0 0 0 1px rgba(30, 215, 96, 0.6); }\n.aur-swatches { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }\n.aur-swatch {\nposition: relative;\nwidth: 30px;\nheight: 30px;\nflex: none;\nborder-radius: 50%;\nbackground: var(--sw);\nbox-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);\ncursor: pointer;\ntransition: transform 0.25s var(--aur-spring), box-shadow 0.2s ease;\n}\n.aur-swatch:hover { transform: scale(1.08); }\n.aur-swatch[aria-checked=\"true\"] { box-shadow: 0 0 0 2px #121216, 0 0 0 4px #fff; }\n.aur-swatch.is-album {\nwidth: auto;\npadding: 0 12px;\nborder-radius: 99px;\nfont-size: 12px;\nfont-weight: 700;\ncolor: #fff;\nbackground: linear-gradient(135deg, color-mix(in srgb, var(--aur-album-accent, #fff) 55%, #222), color-mix(in srgb, var(--aur-album-c1, #4b3b78) 70%, #111));\n}\n.aur-swatch.is-custom { background: conic-gradient(var(--sw) 0 0), conic-gradient(#ff5f5f, #ffd23f, #3ddc84, #2ec5ff, #b388ff, #ff5fa2, #ff5f5f); overflow: hidden; }\n.aur-swatch-input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }\n.aur-fonts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }\n.aur-font { align-items: center; text-align: center; }\n.aur-font-sample { font-size: 26px; font-weight: 800; line-height: 1.1; letter-spacing: -0.02em; }\n.aur-font-name { font-size: 11px; color: rgba(255, 255, 255, 0.55); }\n.aur-select { max-width: 200px; padding: 6px 8px; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px; background: rgba(255, 255, 255, 0.07); color: #fff; font: inherit; font-size: 13px; }\n.aur-select option { background: #222; color: #fff; }\n.aur-panel-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }\n.aur-hint { margin: 14px 2px 0; font-size: 12px; line-height: 1.55; color: rgba(255, 255, 255, 0.45); }\n.aur-keys { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; margin-top: 20px; padding: 12px 14px; border-radius: 14px; background: rgba(255, 255, 255, 0.03); font-size: 12px; color: rgba(255, 255, 255, 0.6); }\n.aur-key { display: flex; align-items: center; gap: 8px; }\n.aur-key kbd { flex: none; min-width: 24px; padding: 2px 6px; border-radius: 5px; background: rgba(255, 255, 255, 0.1); box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.12); font: 600 11px/1.4 var(--aur-ui-font); color: #fff; text-align: center; }\n.aur-track-info { display: flex; align-items: center; gap: 14px; margin: 14px 0; }\n.aur-track-art { width: 60px; height: 60px; flex: none; border-radius: 8px; object-fit: cover; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4); }\n.aur-track-text { min-width: 0; }\n.aur-track-title { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.aur-track-sub { margin-top: 2px; font-size: 12.5px; color: rgba(255, 255, 255, 0.6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.aur-track-chip { display: inline-block; margin-top: 7px; padding: 3px 9px; border-radius: 99px; background: rgba(255, 255, 255, 0.08); font-size: 11.5px; font-weight: 600; color: rgba(255, 255, 255, 0.75); }\n.aur-textarea {\ndisplay: block;\nwidth: 100%;\nmin-height: 280px;\npadding: 12px 14px;\nresize: vertical;\nborder: 1px solid rgba(255, 255, 255, 0.1);\nborder-radius: 12px;\nbackground: rgba(0, 0, 0, 0.32);\ncolor: #fff;\nfont: 12px/1.6 ui-monospace, \"Cascadia Code\", Consolas, monospace;\nuser-select: text;\ntransition: border-color 0.2s ease, background 0.2s ease;\n}\n.aur-textarea:focus { border-color: rgba(255, 255, 255, 0.3); outline: none; }\n.aur-textarea.is-drop { border-color: var(--aur-green); background: rgba(30, 215, 96, 0.08); }\n.aur-root { --aur-split-w: clamp(320px, 40vw, 600px); }\n.aur-side {\nposition: absolute;\ntop: 0;\nbottom: 0;\nleft: 0;\nz-index: 1;\nwidth: var(--aur-split-w);\ndisplay: none;\nflex-direction: column;\nalign-items: center;\njustify-content: center;\ngap: 24px;\npadding: 64px 2vw 150px calc(var(--aur-pad) * 0.8);\n}\n.aur-art-wrap {\nposition: relative;\ndisplay: block;\nwidth: min(100%, 52vh, 460px);\naspect-ratio: 1;\nflex: none;\nborder-radius: 14px;\ncursor: pointer;\nbox-shadow: 0 40px 90px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.06);\ntransition: transform 0.8s var(--aur-spring), box-shadow 0.8s ease;\n}\n.aur-root[data-playing=\"false\"] .aur-art-wrap { transform: scale(0.86); box-shadow: 0 18px 44px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.05); }\n.aur-art-wrap:active { transform: scale(0.97); }\n.aur-root[data-playing=\"false\"] .aur-art-wrap:active { transform: scale(0.84); }\n.aur-art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; border-radius: inherit; opacity: 0; transition: opacity 0.9s ease; }\n.aur-art.is-on { opacity: 1; }\n.aur-art-hint {\nposition: absolute;\nleft: 50%;\ntop: 50%;\ndisplay: grid;\nplace-items: center;\nwidth: 64px;\nheight: 64px;\nmargin: -32px 0 0 -32px;\nborder-radius: 50%;\nbackground: rgba(0, 0, 0, 0.45);\nbackdrop-filter: blur(10px);\ncolor: #fff;\nopacity: 0;\ntransform: scale(0.8);\ntransition: opacity 0.25s ease, transform 0.35s var(--aur-spring);\n}\n.aur-art-hint svg { width: 28px; height: 28px; }\n.aur-art-wrap:hover .aur-art-hint, .aur-art-wrap:focus-visible .aur-art-hint { opacity: 1; transform: none; }\n.aur-side-meta { width: min(100%, 52vh, 460px); min-width: 0; }\n.aur-side-title {\ndisplay: -webkit-box;\noverflow: hidden;\n-webkit-line-clamp: 2;\n-webkit-box-orient: vertical;\nfont-family: var(--aur-font);\nfont-size: clamp(20px, 2.1vw, 30px);\nfont-weight: 800;\nline-height: 1.15;\nletter-spacing: -0.02em;\n}\n.aur-side-artist, .aur-side-album { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }\n.aur-side-artist { margin-top: 6px; font-size: 15px; color: rgba(255, 255, 255, 0.7); }\n.aur-side-album { margin-top: 2px; font-size: 13px; color: rgba(255, 255, 255, 0.45); }\n.aur-root.is-open .aur-side { animation: aur-art-in 0.9s var(--aur-ease) 0.05s backwards; }\n.aur-disc { position: absolute; inset: 0; border-radius: inherit; overflow: hidden; }\n.aur-disc-grooves, .aur-disc-shine { display: none; }\n@media (min-width: 900px) and (min-height: 540px) {\n.aur-root:is([data-view=\"split\"], [data-view=\"mirror\"], [data-view=\"poster\"], [data-view=\"vinyl\"]) .aur-side { display: flex; }\n.aur-root:is([data-view=\"split\"], [data-view=\"mirror\"], [data-view=\"poster\"], [data-view=\"vinyl\"]) :is(.aur-header, .aur-message-art) { display: none; }\n.aur-root:is([data-view=\"split\"], [data-view=\"vinyl\"]) .aur-stage { left: var(--aur-split-w); padding-left: 2.5vw; --aur-size: min(var(--aur-fs), 4.6vw, 10.5vh); }\n.aur-root[data-view=\"mirror\"] .aur-side { left: auto; right: 0; padding: 64px calc(var(--aur-pad) * 0.8) 150px 2vw; }\n.aur-root[data-view=\"mirror\"] .aur-stage { right: var(--aur-split-w); padding-right: 2.5vw; --aur-size: min(var(--aur-fs), 4.6vw, 10.5vh); }\n.aur-root[data-view=\"poster\"] { --aur-poster-w: clamp(360px, 46vw, 820px); }\n.aur-root[data-view=\"poster\"] .aur-side { width: var(--aur-poster-w); padding: 0; display: block; }\n.aur-root[data-view=\"poster\"] .aur-art-wrap {\nposition: absolute;\ninset: 0;\nwidth: 100%;\nheight: 100%;\naspect-ratio: auto;\nborder-radius: 0;\nbox-shadow: none;\n-webkit-mask-image: linear-gradient(to right, #000 45%, transparent 98%), linear-gradient(to top, transparent 0, #000 42%);\n-webkit-mask-composite: source-in;\nmask-image: linear-gradient(to right, #000 45%, transparent 98%), linear-gradient(to top, transparent 0, #000 42%);\nmask-composite: intersect;\ntransition: opacity 0.8s ease, filter 0.8s ease;\n}\n.aur-root[data-view=\"poster\"][data-playing=\"false\"] .aur-art-wrap { transform: none; box-shadow: none; filter: saturate(0.6) brightness(0.8); }\n.aur-root[data-view=\"poster\"] .aur-art-wrap:active { transform: none; }\n.aur-root[data-view=\"poster\"] .aur-art-hint { left: 40%; }\n.aur-root[data-view=\"poster\"] .aur-side-meta { position: absolute; left: var(--aur-pad); bottom: 150px; width: min(34vw, 560px); text-shadow: 0 2px 24px rgba(0, 0, 0, 0.45); }\n.aur-root[data-view=\"poster\"] .aur-side-title { font-size: clamp(28px, 3.4vw, 54px); line-height: 1.05; }\n.aur-root[data-view=\"poster\"] .aur-side-artist { font-size: clamp(15px, 1.3vw, 19px); color: rgba(255, 255, 255, 0.82); }\n.aur-root[data-view=\"poster\"] .aur-stage { left: calc(var(--aur-poster-w) * 0.9); padding-left: 2vw; --aur-size: min(var(--aur-fs), 4.4vw, 10.5vh); }\n.aur-root[data-view=\"vinyl\"] .aur-art-wrap { border-radius: 50%; box-shadow: 0 40px 90px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05); }\n.aur-root[data-view=\"vinyl\"] .aur-disc {\nborder-radius: 50%;\nbackground:\nradial-gradient(circle, transparent 0 21%, rgba(255, 255, 255, 0.07) 21.3%, transparent 22%),\nradial-gradient(circle, #1b1b1f 0 60%, #111114 100%);\nanimation: aur-spin-disc 7.5s linear infinite;\nanimation-play-state: paused;\n}\n.aur-root[data-view=\"vinyl\"][data-playing=\"true\"] .aur-disc { animation-play-state: running; }\n.aur-root[data-view=\"vinyl\"] .aur-disc-grooves {\ndisplay: block;\nposition: absolute;\ninset: 0;\nborder-radius: 50%;\nbackground: repeating-radial-gradient(circle, rgba(255, 255, 255, 0.035) 0 1px, rgba(255, 255, 255, 0.012) 1.6px, transparent 2.4px 4px);\n-webkit-mask-image: radial-gradient(circle, transparent 0 33%, #000 34% 96%, transparent 97%);\nmask-image: radial-gradient(circle, transparent 0 33%, #000 34% 96%, transparent 97%);\n}\n.aur-root[data-view=\"vinyl\"] .aur-art { inset: 31%; width: 38%; height: 38%; border-radius: 50%; }\n.aur-root[data-view=\"vinyl\"] .aur-disc::after { content: \"\"; position: absolute; left: 50%; top: 50%; width: 3.2%; height: 3.2%; margin: -1.6% 0 0 -1.6%; border-radius: 50%; background: #0b0b0e; box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.08); }\n.aur-root[data-view=\"vinyl\"] .aur-disc-shine {\ndisplay: block;\nposition: absolute;\ninset: 0;\nborder-radius: 50%;\npointer-events: none;\nbackground: conic-gradient(from 20deg, transparent 0 8%, rgba(255, 255, 255, 0.1) 13%, transparent 20% 52%, rgba(255, 255, 255, 0.08) 60%, transparent 68%);\n-webkit-mask-image: radial-gradient(circle, transparent 0 32%, #000 36%);\nmask-image: radial-gradient(circle, transparent 0 32%, #000 36%);\n}\n.aur-root[data-view=\"vinyl\"] .aur-art-hint { z-index: 1; }\n.aur-root[data-view=\"vinyl\"] .aur-side-meta { text-align: center; }\n}\n@keyframes aur-spin-disc { to { rotate: 360deg; } }\n@media (min-height: 600px) {\n.aur-root:is([data-view=\"stage\"], [data-view=\"captions\"]) .aur-side { display: flex; left: 0; right: 0; width: auto; }\n.aur-root:is([data-view=\"stage\"], [data-view=\"captions\"]) :is(.aur-header, .aur-message-art) { display: none; }\n.aur-root:is([data-view=\"stage\"], [data-view=\"captions\"]) .aur-stage { --aur-origin: 50%; text-align: center; }\n.aur-root:is([data-view=\"stage\"], [data-view=\"captions\"]) .aur-line { margin-inline: auto; }\n.aur-root:is([data-view=\"stage\"], [data-view=\"captions\"]) .aur-side-meta { width: auto; min-width: 0; }\n.aur-root[data-view=\"stage\"] .aur-side { flex-direction: row; justify-content: center; bottom: auto; gap: 18px; padding: calc(var(--aur-safe-top) - 16px) var(--aur-pad) 0; }\n.aur-root[data-view=\"stage\"] .aur-art-wrap { width: clamp(84px, 14vh, 150px); border-radius: 10px; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5); }\n.aur-root[data-view=\"stage\"][data-playing=\"false\"] .aur-art-wrap { transform: scale(0.9); }\n.aur-root[data-view=\"stage\"] .aur-art-hint { width: 44px; height: 44px; margin: -22px 0 0 -22px; }\n.aur-root[data-view=\"stage\"] .aur-side-meta { max-width: 42vw; }\n.aur-root[data-view=\"stage\"] .aur-side-title { font-size: clamp(18px, 2.4vh, 26px); }\n.aur-root[data-view=\"stage\"] .aur-stage { top: calc(var(--aur-safe-top) + clamp(84px, 14vh, 150px)); }\n.aur-root[data-view=\"captions\"] .aur-side { flex-direction: column; justify-content: center; top: 0; bottom: 40vh; gap: 14px; padding: calc(var(--aur-safe-top) - 8px) var(--aur-pad) 0; }\n.aur-root[data-view=\"captions\"] .aur-art-wrap { width: min(34vh, 380px); }\n.aur-root[data-view=\"captions\"] .aur-side-meta { text-align: center; }\n.aur-root[data-view=\"captions\"] .aur-side-title { font-size: clamp(18px, 2.4vh, 26px); }\n.aur-root[data-view=\"captions\"] .aur-stage {\ntop: 58vh;\nbottom: 104px;\n--aur-size: min(calc(var(--aur-fs) * 0.8), 4.4vw, 5.6vh);\n-webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 14%, #000 86%, transparent 100%);\nmask-image: linear-gradient(to bottom, transparent 0, #000 14%, #000 86%, transparent 100%);\n}\n.aur-root[data-view=\"captions\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-active):not([data-d=\"1\"]) { opacity: 0 !important; pointer-events: none; }\n.aur-root[data-view=\"captions\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"1\"] { opacity: 0.4; }\n}\n.aur-root.aur-view-swap :is(.aur-side, .aur-stage) { animation: aur-fade-up 0.7s var(--aur-ease) both; }\n.aur-np {\ndisplay: flex;\nalign-items: center;\ngap: 12px;\nmargin: 2px 14px 8px;\npadding: 10px;\nborder-radius: 14px;\nbackground: linear-gradient(135deg, color-mix(in srgb, var(--aur-accent) 18%, transparent), rgba(255, 255, 255, 0.04));\nborder: 1px solid rgba(255, 255, 255, 0.07);\n}\n.aur-np img { width: 50px; height: 50px; flex: none; border-radius: 8px; object-fit: cover; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4); }\n.aur-np-text { min-width: 0; flex: 1; }\n.aur-np-title, .aur-np-sub { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }\n.aur-np-title { font-size: 14px; font-weight: 700; }\n.aur-np-sub { margin-top: 2px; font-size: 12px; color: rgba(255, 255, 255, 0.6); }\n.aur-np-chip { flex: none; padding: 3px 8px; border-radius: 99px; background: rgba(255, 255, 255, 0.09); font-size: 11px; font-weight: 700; color: rgba(255, 255, 255, 0.8); }\n.aur-prov-list { display: flex; flex-direction: column; gap: 6px; }\n.aur-prov {\ndisplay: grid;\ngrid-template-columns: auto 1fr auto auto;\nalign-items: center;\ngap: 10px;\npadding: 10px 10px 10px 8px;\nborder-radius: 12px;\nbackground: rgba(0, 0, 0, 0.22);\ntransition: opacity 0.2s ease, background 0.2s ease;\n}\n.aur-prov.is-off { opacity: 0.45; }\n.aur-prov-rank { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: rgba(255, 255, 255, 0.1); font-size: 11px; font-weight: 700; }\n.aur-prov-name { font-size: 13.5px; font-weight: 700; }\n.aur-prov-badge { margin-left: 6px; padding: 1px 6px; border-radius: 99px; background: rgba(124, 212, 255, 0.16); color: #7cd4ff; font-size: 10px; font-weight: 700; vertical-align: 1px; }\n.aur-prov-desc { margin-top: 2px; font-size: 11.5px; line-height: 1.35; color: rgba(255, 255, 255, 0.5); }\n.aur-prov-move { display: flex; flex-direction: column; }\n.aur-prov-move button { display: grid; place-items: center; width: 24px; height: 18px; border-radius: 6px; color: rgba(255, 255, 255, 0.6); }\n.aur-prov-move button:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }\n.aur-prov-move button:disabled { opacity: 0.2; pointer-events: none; }\n.aur-prov-move svg { width: 14px; height: 14px; }\n.aur-src-title { margin: 16px 2px 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: rgba(255, 255, 255, 0.45); }\n.aur-src-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }\n.aur-src-btn {\ndisplay: flex;\nalign-items: center;\njustify-content: space-between;\ngap: 6px;\nmin-height: 36px;\npadding: 6px 10px;\nborder-radius: 10px;\nbackground: rgba(255, 255, 255, 0.06);\nfont-size: 12.5px;\nfont-weight: 600;\ntext-align: left;\ntransition: background 0.2s ease, box-shadow 0.2s ease;\n}\n.aur-src-btn:hover { background: rgba(255, 255, 255, 0.11); }\n.aur-src-btn small { font-size: 10.5px; font-weight: 600; color: rgba(255, 255, 255, 0.5); }\n.aur-src-btn.is-current { background: rgba(30, 215, 96, 0.13); box-shadow: inset 0 0 0 1px rgba(30, 215, 96, 0.6); }\n.aur-src-btn.is-loading small { animation: aur-blink 1s ease-in-out infinite; }\n.aur-test-btn { width: 100%; margin-top: 8px; }\n@keyframes aur-blink { 50% { opacity: 0.3; } }\n@media (max-width: 1100px) {\n.aur-offset-group { display: none; }\n.aur-source { max-width: 160px; }\n}\n@media (max-width: 780px) {\n.aur-root { --aur-pad: 22px; }\n.aur-header { top: 18px; max-width: calc(100vw - 44px); }\n.aur-cover { width: 44px; height: 44px; }\n.aur-player { column-gap: 10px; padding-bottom: 12px; grid-template-columns: auto minmax(0, 1fr) auto; }\n.aur-source { width: 32px; padding: 0; justify-content: center; font-size: 0; }\n.aur-source::before { width: 9px; height: 9px; }\n.aur-transport { gap: 8px; }\n.aur-play-btn { width: 50px; height: 50px; }\n.aur-player-side { height: 50px; }\n}\n@media (max-width: 600px) {\n.aur-offset-group,\n.aur-volume,\n.aur-player-side .aur-sep,\n.aur-heart,\n.aur-toggle { display: none; }\n.aur-player-side .aur-icon-btn { width: 34px; height: 34px; }\n}\n@media (max-height: 540px) {\n.aur-header { display: none; }\n.aur-message-art { display: none; }\n}\n.aur-no-anim .aur-line,\n.aur-no-anim .aur-w,\n.aur-no-anim .aur-c { transition: none !important; }\n.aur-root[data-motion=\"reduced\"] { transform: none !important; transition: opacity 0.2s ease; }\n.aur-root[data-motion=\"reduced\"] .aur-line,\n.aur-root[data-motion=\"reduced\"] .aur-w,\n.aur-root[data-motion=\"reduced\"] .aur-player,\n.aur-root[data-motion=\"reduced\"] .aur-header,\n.aur-root[data-motion=\"reduced\"] .aur-panel,\n.aur-root[data-motion=\"reduced\"] .aur-rail-pill {\ntransition-property: opacity, color, visibility !important;\ntransition-duration: 0.2s !important;\ntransition-delay: 0s !important;\n}\n.aur-root[data-motion=\"reduced\"] *,\n.aur-root[data-motion=\"reduced\"] *::before { animation: none !important; }\n.aur-root[data-motion=\"reduced\"] .aur-line[data-d] { filter: none !important; }\n.aur-root[data-motion=\"reduced\"] .aur-w,\n.aur-root[data-motion=\"reduced\"] .aur-c { transform: none !important; }\n[data-testid=\"lyrics-npv-section\"][data-aur-hidden] { display: none !important; }\n.aur-npv {\n--npv-c: #3a3a46;\nposition: relative;\noverflow: hidden;\npadding: 16px 16px 10px;\nborder-radius: 8px;\ncolor: #fff;\nfont-family: var(--encore-body-font-stack, \"SpotifyMixUI\", \"CircularSp\", system-ui, sans-serif);\nbackground:\nradial-gradient(120% 90% at 0% 0%, color-mix(in oklab, var(--npv-c) 80%, #fff 6%) 0%, transparent 70%),\nlinear-gradient(165deg, color-mix(in oklab, var(--npv-c) 72%, #000) 0%, color-mix(in oklab, var(--npv-c) 38%, #0d0d10) 100%);\nbox-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);\ntransition: background 0.8s ease;\n}\n.aur-npv-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; min-width: 0; }\n.aur-npv-title { margin: 0; font-size: 16px; font-weight: 700; }\n.aur-npv-src { min-width: 0; overflow: hidden; padding: 2px 8px; border-radius: 99px; background: rgba(255, 255, 255, 0.1); font-size: 11px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; color: rgba(255, 255, 255, 0.72); }\n.aur-npv-src:empty { display: none; }\n.aur-npv-open {\ndisplay: grid;\nflex: none;\nplace-items: center;\nwidth: 32px;\nheight: 32px;\nmargin-left: auto;\npadding: 0;\nborder: 0;\nborder-radius: 50%;\nbackground: rgba(255, 255, 255, 0.1);\ncolor: rgba(255, 255, 255, 0.8);\ncursor: pointer;\ntransition: background 0.2s ease, color 0.2s ease, transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);\n}\n.aur-npv-open:hover { background: rgba(255, 255, 255, 0.2); color: #fff; transform: scale(1.08); }\n.aur-npv-open svg { width: 16px; height: 16px; }\n.aur-npv-body {\nposition: relative;\nheight: 204px;\noverflow: hidden;\ncursor: pointer;\n-webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 14%, #000 78%, transparent 100%);\nmask-image: linear-gradient(to bottom, transparent 0, #000 14%, #000 78%, transparent 100%);\n}\n.aur-npv-lines { padding-top: 6px; will-change: transform; transition: transform 0.75s cubic-bezier(0.22, 1, 0.36, 1); }\n.aur-npv-lines.no-anim { transition: none; }\n.aur-npv-line {\nmargin: 0 -8px;\npadding: 5px 8px;\nborder-radius: 8px;\nfont-size: 19px;\nfont-weight: 700;\nline-height: 1.32;\nletter-spacing: -0.01em;\ncolor: rgba(255, 255, 255, 0.42);\ntransition: color 0.45s ease, background 0.2s ease, text-shadow 0.6s ease;\n}\n.aur-npv-line.is-past { color: rgba(255, 255, 255, 0.7); }\n.aur-npv-line.is-active { color: #fff; text-shadow: 0 0 18px rgba(255, 255, 255, 0.25); }\n.aur-npv-line.is-gap { letter-spacing: 0.15em; }\n.aur-npv-line[title]:hover { background: rgba(255, 255, 255, 0.09); color: rgba(255, 255, 255, 0.92); }\n.aur-npv-line.is-active:has(.aur-npv-w) { text-shadow: none; }\n.aur-npv-line.is-active .aur-npv-w { color: rgba(255, 255, 255, 0.42); }\n.aur-npv-line.is-active .aur-npv-w.sung { color: #fff; }\n.aur-npv-line.is-active .aur-npv-w.now {\ncolor: transparent;\nbackground: linear-gradient(90deg, #fff calc(var(--aur-wp, 0) * (100% + 0.6em) - 0.6em), rgba(255, 255, 255, 0.42) calc(var(--aur-wp, 0) * (100% + 0.6em)));\n-webkit-background-clip: text;\nbackground-clip: text;\n}\n.aur-npv.is-unsynced .aur-npv-line { color: rgba(255, 255, 255, 0.85); font-size: 16px; }\n.aur-npv[data-duet=\"on\"] .aur-npv-line[data-singer=\"1\"] { text-align: right; }\n.aur-npv[data-duet=\"on\"] .aur-npv-line[data-singer=\"2\"] { text-align: center; }\n.aur-npv[data-duet=\"on\"] .aur-npv-line.is-active[data-singer=\"1\"],\n.aur-npv[data-duet=\"on\"] .aur-npv-line.is-active[data-singer=\"1\"] .aur-npv-w.sung { color: #ffd3e6; }\n.aur-npv[data-duet=\"on\"] .aur-npv-line.is-active[data-singer=\"2\"],\n.aur-npv[data-duet=\"on\"] .aur-npv-line.is-active[data-singer=\"2\"] .aur-npv-w.sung { color: #ffe9f2; }\n.aur-npv-msg { position: absolute; inset: 0; display: grid; place-items: center; padding: 0 16px; font-size: 13px; text-align: center; color: rgba(255, 255, 255, 0.62); }\n.aur-npv-msg:empty { display: none; }\n.aur-npv-tr { margin-top: 2px; font-size: 13px; font-weight: 600; line-height: 1.3; color: rgba(255, 255, 255, 0.55); }\n.aur-npv-line.is-active .aur-npv-tr { color: rgba(255, 255, 255, 0.85); }\n.aur-share {\nposition: absolute;\ninset: 0;\nz-index: 6;\ndisplay: grid;\nplace-items: center;\npadding: var(--aur-safe-top, 48px) 16px 16px;\nbackground: rgba(0, 0, 0, 0.45);\nbackdrop-filter: blur(6px);\nopacity: 0;\ntransition: opacity 0.25s ease;\n}\n.aur-share[hidden] { display: none; }\n.aur-share.is-open { opacity: 1; }\n.aur-share-card {\ndisplay: grid;\ngrid-template-columns: auto minmax(260px, 340px);\ngap: 22px;\nmax-width: min(980px, 100%);\nmax-height: 100%;\npadding: 20px;\nborder-radius: 24px;\nbackground: linear-gradient(180deg, rgba(34, 34, 40, 0.92), rgba(18, 18, 22, 0.95));\nborder: 1px solid rgba(255, 255, 255, 0.08);\nbox-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);\ntransform: translateY(12px) scale(0.98);\ntransition: transform 0.35s var(--aur-ease);\nuser-select: none;\n}\n.aur-share.is-open .aur-share-card { transform: none; }\n.aur-share-preview { display: grid; place-items: center; min-height: 0; }\n.aur-share-canvas {\ndisplay: block;\nwidth: auto;\nmax-width: min(46vw, 440px);\nmax-height: min(72vh, 640px);\nborder-radius: 14px;\nbox-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);\n}\n.aur-share-side { display: flex; flex-direction: column; gap: 8px; min-height: 0; min-width: 0; }\n.aur-share-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 4px; }\n.aur-share-label { display: flex; justify-content: space-between; margin-top: 8px; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: rgba(255, 255, 255, 0.55); }\n.aur-share-count { font-variant-numeric: tabular-nums; letter-spacing: 0; }\n.aur-share-lines {\ndisplay: flex;\nflex-direction: column;\ngap: 2px;\nflex: 1 1 auto;\nmin-height: 120px;\nmax-height: 38vh;\noverflow-y: auto;\npadding: 4px;\nborder-radius: 12px;\nbackground: rgba(0, 0, 0, 0.22);\nscrollbar-width: thin;\n}\n.aur-share-line {\npadding: 7px 10px;\nborder-radius: 8px;\nfont-size: 13.5px;\nfont-weight: 600;\nline-height: 1.35;\ntext-align: left;\ncolor: rgba(255, 255, 255, 0.62);\ntransition: background 0.15s ease, color 0.15s ease;\n}\n.aur-share-line:hover { background: rgba(255, 255, 255, 0.07); color: #fff; }\n.aur-share-line[aria-pressed=\"true\"] { background: rgba(30, 215, 96, 0.14); color: #fff; box-shadow: inset 3px 0 0 var(--aur-green); }\n.aur-share .aur-panel-actions { margin-top: 12px; }\n@media (max-width: 760px) {\n.aur-share-card { grid-template-columns: 1fr; overflow-y: auto; }\n.aur-share-canvas { max-width: 100%; max-height: 40vh; }\n}\n.aur-float {\n--float-c: #2a2a33;\nposition: fixed;\nz-index: 9990;\ndisplay: flex;\nalign-items: center;\ngap: 12px;\nbox-sizing: border-box;\nwidth: min(560px, calc(100vw - 16px));\nmin-height: 68px;\npadding: 10px 16px 10px 10px;\nborder-radius: 18px;\ncolor: #fff;\nfont-family: var(--encore-body-font-stack, \"SpotifyMixUI\", \"CircularSp\", system-ui, sans-serif);\nbackground: linear-gradient(135deg, color-mix(in srgb, var(--float-c) 72%, rgba(14, 14, 18, 0.9)), rgba(14, 14, 18, 0.88));\nborder: 1px solid rgba(255, 255, 255, 0.1);\nbox-shadow: 0 18px 48px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.06);\nbackdrop-filter: blur(22px) saturate(1.4);\ncursor: grab;\nuser-select: none;\n-webkit-app-region: no-drag;\ntransition: background 0.8s ease, box-shadow 0.25s ease;\n}\n.aur-float[hidden] { display: none; }\n.aur-float *, .aur-float *::before { box-sizing: border-box; }\n.aur-float.is-in { animation: aur-float-in 0.45s cubic-bezier(0.22, 1, 0.36, 1); }\n@keyframes aur-float-in { from { opacity: 0; transform: translateY(12px) scale(0.97); } }\n.aur-float.is-dragging { cursor: grabbing; box-shadow: 0 26px 60px rgba(0, 0, 0, 0.6); transition: none; }\n.aur-float-art { flex: none; width: 48px; height: 48px; border-radius: 10px; object-fit: cover; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4); pointer-events: none; }\n.aur-float-art[hidden] { display: none; }\n.aur-float-text { flex: 1; min-width: 0; cursor: pointer; }\n.aur-float-cur {\nfont-family: var(--encore-title-font-stack, \"SpotifyMixUITitle\", \"SpotifyMixUI\", \"CircularSp\", system-ui, sans-serif);\nfont-size: 18px;\nfont-weight: 800;\nline-height: 1.25;\nletter-spacing: -0.01em;\noverflow-wrap: anywhere;\ndisplay: -webkit-box;\n-webkit-line-clamp: 2;\n-webkit-box-orient: vertical;\noverflow: hidden;\n}\n.aur-float-next { margin-top: 2px; font-size: 13px; font-weight: 600; color: rgba(255, 255, 255, 0.5); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.aur-float-next:empty { display: none; }\n.aur-float .is-enter { animation: aur-float-line 0.4s cubic-bezier(0.22, 1, 0.36, 1); }\n@keyframes aur-float-line { from { opacity: 0; transform: translateY(6px); filter: blur(3px); } }\n.aur-float-w { color: rgba(255, 255, 255, 0.4); }\n.aur-float-w.sung { color: #fff; }\n.aur-float-w[style*=\"--aur-wp\"] {\ncolor: transparent;\nbackground: linear-gradient(90deg, #fff calc(var(--aur-wp, 0) * (100% + 0.6em) - 0.6em), rgba(255, 255, 255, 0.4) calc(var(--aur-wp, 0) * (100% + 0.6em)));\n-webkit-background-clip: text;\nbackground-clip: text;\n}\n.aur-float[data-duet=\"on\"] .aur-float-cur[data-singer=\"1\"] .aur-float-w.sung,\n.aur-float[data-duet=\"on\"] .aur-float-cur[data-singer=\"1\"]:not(:has(.aur-float-w)) { color: #ffd3e6; }\n.aur-float-dots { display: inline-flex; gap: 6px; padding: 6px 0; }\n.aur-float-dots i { width: 7px; height: 7px; border-radius: 50%; background: #fff; opacity: 0.35; animation: aur-float-dot 1.4s ease-in-out infinite; }\n.aur-float-dots i:nth-child(2) { animation-delay: 0.18s; }\n.aur-float-dots i:nth-child(3) { animation-delay: 0.36s; }\n@keyframes aur-float-dot { 50% { opacity: 0.9; transform: translateY(-2px); } }\n.aur-float-actions {\nposition: absolute;\ntop: -12px;\nright: 10px;\ndisplay: flex;\ngap: 4px;\npadding: 3px;\nborder-radius: 99px;\nbackground: rgba(24, 24, 28, 0.95);\nborder: 1px solid rgba(255, 255, 255, 0.1);\nbox-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);\nopacity: 0;\ntransform: translateY(4px);\ntransition: opacity 0.2s ease, transform 0.25s ease;\npointer-events: none;\n}\n.aur-float:hover .aur-float-actions, .aur-float:focus-within .aur-float-actions { opacity: 1; transform: none; pointer-events: auto; }\n.aur-float-btn {\ndisplay: grid;\nplace-items: center;\nwidth: 28px;\nheight: 28px;\npadding: 0;\nborder: 0;\nborder-radius: 50%;\nbackground: transparent;\ncolor: rgba(255, 255, 255, 0.75);\ncursor: pointer;\n}\n.aur-float-btn:hover { background: rgba(255, 255, 255, 0.12); color: #fff; }\n.aur-float-btn[hidden] { display: none; }\n.aur-float-btn svg { width: 16px; height: 16px; }\n.aur-float-pip-body { margin: 0; overflow: hidden; background: #0e0e12; }\n.aur-float.is-pip { position: static; width: 100vw; height: 100vh; min-height: 0; border: 0; border-radius: 0; padding: 12px 18px 12px 12px; box-shadow: none; cursor: default; }\n.aur-float.is-pip .aur-float-art { width: min(64px, calc(100vh - 24px)); height: min(64px, calc(100vh - 24px)); }\n.aur-float.is-pip .aur-float-cur { font-size: clamp(16px, 6.5vw, 30px); }\n.aur-float.is-pip .aur-float-actions { top: 6px; right: 6px; }\n.aur-float.is-pip .is-pip-btn { display: none; }\n.aur-upnext {\nposition: absolute;\nright: var(--aur-pad);\nbottom: 116px;\nz-index: 3;\ndisplay: flex;\nalign-items: center;\ngap: 12px;\nmax-width: min(340px, calc(100vw - 32px));\npadding: 8px 12px 8px 8px;\nborder-radius: 16px;\nbackground: rgba(20, 20, 26, 0.55);\nborder: 1px solid rgba(255, 255, 255, 0.1);\nbox-shadow: 0 14px 40px rgba(0, 0, 0, 0.35);\nbackdrop-filter: blur(20px) saturate(1.4);\ncolor: #fff;\ntext-align: left;\nopacity: 0;\ntransform: translateY(14px) scale(0.97);\npointer-events: none;\ntransition: opacity 0.5s var(--aur-ease), transform 0.6s var(--aur-ease), bottom 0.65s var(--aur-ease), background 0.2s ease;\n}\n.aur-upnext.is-on { opacity: 1; transform: none; pointer-events: auto; }\n.aur-upnext:hover { background: rgba(38, 38, 46, 0.7); }\n.aur-root[data-transport=\"off\"] .aur-upnext,\n.aur-root[data-idle=\"true\"] .aur-upnext { bottom: 24px; }\n.aur-upnext-art { flex: none; width: 46px; height: 46px; border-radius: 9px; object-fit: cover; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4); }\n.aur-upnext-art[hidden] { display: none; }\n.aur-upnext-text { min-width: 0; flex: 1; }\n.aur-upnext-label { font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255, 255, 255, 0.55); }\n.aur-upnext-when { letter-spacing: 0.02em; text-transform: none; font-variant-numeric: tabular-nums; }\n.aur-upnext-title, .aur-upnext-artist { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.aur-upnext-title { margin-top: 1px; font-size: 14px; font-weight: 700; }\n.aur-upnext-artist { font-size: 12.5px; color: rgba(255, 255, 255, 0.62); }\n.aur-upnext-skip { flex: none; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: rgba(255, 255, 255, 0.1); opacity: 0.7; transition: opacity 0.2s ease, background 0.2s ease; }\n.aur-upnext-skip svg { width: 14px; height: 14px; }\n.aur-upnext:hover .aur-upnext-skip { opacity: 1; background: rgba(255, 255, 255, 0.2); }\n.aur-root[data-motion=\"reduced\"] .aur-upnext { transition: opacity 0.3s ease; transform: none; }\n.aur-link { display: inline; padding: 0; border: 0; background: none; font: inherit; color: inherit; cursor: pointer; text-decoration: underline transparent 1px; text-underline-offset: 3px; transition: color 0.2s ease, text-decoration-color 0.2s ease; }\n.aur-link:hover, .aur-link:focus-visible { color: #fff; text-decoration-color: currentColor; outline: none; }\n.aur-topbar-btn {\ndisplay: inline-grid !important;\nplace-items: center;\nwidth: 48px !important;\nheight: 48px !important;\nmin-width: 48px;\nmargin-inline: 8px;\npadding: 0 !important;\nborder: 0;\nborder-radius: 50% !important;\nbackground-color: var(--background-elevated-base, #1f1f1f) !important;\ncolor: var(--text-subdued, #b3b3b3) !important;\ncursor: pointer;\ntransition: background-color 0.2s ease, color 0.2s ease, transform 0.2s ease;\n}\n.aur-topbar-btn:hover, .aur-topbar-btn:focus-visible {\nbackground-color: var(--background-elevated-highlight, #2a2a2a) !important;\ncolor: var(--text-base, #fff) !important;\ntransform: scale(1.04);\n}\n.aur-topbar-btn:active { transform: scale(0.98); }\n.aur-topbar-btn svg { width: 20px; height: 20px; }";

// ---- view.js ---------------------------------------------------------------
// LyricsView: renders a Lyrics object into the stage and keeps it in sync with playback.
//
// Performance model:
//  - DOM for all lines is built once per lyrics load.
//  - update(pos) runs every frame but only does a binary search; the DOM is touched only
//    when the active line changes (a few attribute writes around the old/new index) and,
//    for word-synced lines, one CSS variable on the current word.
//  - All motion is CSS transitions on transform / opacity / filter.
//
// Layouts:
//  - "list"  (flow, slide, scale): lines in a column. The list publishes --aur-y (the
//            scroll offset); every line applies it in its own transform, so each line can
//            transition with its own delay — that's the staggered "wave" in Flow.
//  - "stack" (fade, cinematic): lines absolutely stacked at the centre; the active line's
//            height is published as --aur-ah so neighbours sit above/below it.


const ANCHOR = 0.4; // active line position, fraction of stage height
const WINDOW = 6; // lines on each side that get a data-d distance attribute (opacity / blur / stagger)
const SNAP_JUMP = 12; // jumps larger than this many lines skip the scroll animation
const USER_SCROLL_PAUSE = 5000; // unsynced auto-scroll pauses after manual scrolling
const BROWSE_RESUME = 3000; // synced: return to the current line after browsing with the wheel
const LEAVE_MS = 220; // fade-out before content is swapped (keep in sync with styles.css)
const ENTER_MS = 1600; // how long the entrance animation class stays on
const LONG_WORD_MS = 900; // words held at least this long get a letter-by-letter sweep + swell
const WORD_LEAD_MS = 40; // highlight words slightly early to cover render latency

class LyricsView {
	/**
	 * @param {HTMLElement} stage
	 * @param {{ onSeek?: (ms:number)=>void, onShare?: (lineIndex:number)=>void }} opts
	 */
	constructor(stage, opts = {}) {
		this.stage = stage;
		this.onSeek = opts.onSeek;
		this.onShare = opts.onShare;
		this.list = h("div", { class: "aur-lines" });
		this.message = h("div", { class: "aur-message", role: "status" });
		stage.append(this.list, this.message);
		stage.dataset.mode = "none";

		this.lyrics = null;
		this.lineEls = [];
		this.wordEls = []; // per line: array of word spans or null
		this.active = -2; // -2 = nothing rendered yet, -1 = before first line
		this.wordIdx = -1;
		this.layout = "list";
		this.wordSync = true;
		this.autoScroll = true;
		this.reduced = false;
		this.wordAnim = "fill";
		this.tr = null; // translations: array aligned to lyrics.lines (string|null), or null
		this.showBg = true;
		this.frozen = false; // ignore updates while old content fades out

		this.lastPos = 0;
		this.lastDuration = 0;
		this.lastUserScroll = 0;
		this.scrollPos = 0;
		this.y = 0; // resting scroll offset (list layout)
		this.browsing = false;
		this.browseY = 0;
		this.browseTimer = 0;
		this.swapToken = 0;
		this.swapTimer = 0;
		this.enterTimer = 0;

		stage.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
		const markUser = () => (this.lastUserScroll = performance.now());
		stage.addEventListener("touchstart", markUser, { passive: true });
		stage.addEventListener("pointerdown", markUser, { passive: true });
	}

	// -------------------------------------------------------------------------
	// Content swaps (fade old out, render, play entrance)
	// -------------------------------------------------------------------------

	/** Stop following playback until the next render (e.g. right after a track change). */
	freeze() {
		this.frozen = true;
	}

	swap(render) {
		const token = ++this.swapToken;
		clearTimeout(this.swapTimer);
		const run = () => {
			if (token !== this.swapToken) return;
			this.stage.classList.remove("is-leaving");
			this.frozen = false;
			render();
			this.playEnter();
		};
		if (this.reduced || this.stage.dataset.mode === "none") return run();
		this.frozen = true;
		this.stage.classList.add("is-leaving");
		this.swapTimer = setTimeout(run, LEAVE_MS);
	}

	/** (Re)play the staggered entrance animation. */
	playEnter() {
		if (this.reduced) return;
		this.stage.classList.remove("is-entering");
		void this.stage.offsetWidth; // restart CSS animations
		this.stage.classList.add("is-entering");
		clearTimeout(this.enterTimer);
		this.enterTimer = setTimeout(() => this.stage.classList.remove("is-entering"), ENTER_MS);
	}

	resetContent() {
		this.stopBrowsing(true);
		this.lyrics = null;
		this.list.replaceChildren();
		this.lineEls = [];
		this.wordEls = [];
		this.active = -2;
		this.wordIdx = -1;
	}

	/**
	 * Show a state screen instead of lyrics.
	 * @param {"loading"|"empty"|"error"} kind
	 * @param {{ image?: string|null, action?: { label: string, onClick: () => void } }} [opts]
	 */
	setMessage(kind, title, detail, opts = {}) {
		// Same loading screen again (e.g. status text changed): just update the detail line.
		if (kind === "loading" && this.stage.dataset.mode === "message" && this.message.dataset.kind === "loading" && !this.stage.classList.contains("is-leaving")) {
			return this.setStatus(detail);
		}
		this.swap(() => {
			this.resetContent();
			this.stage.dataset.mode = "message";
			this.message.dataset.kind = kind;
			const parts = [
				opts.image
					? h("div", { class: "aur-message-art" }, h("img", { src: opts.image, alt: "", decoding: "async" }))
					: h("div", { class: "aur-message-icon", html: opts.icon || "" }),
				kind === "loading" && h("div", { class: "aur-spinner", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
				h("div", { class: "aur-message-title" }, title),
				h("div", { class: "aur-message-detail" }, detail || ""),
				opts.action && h("button", { class: "aur-btn aur-btn-primary aur-message-action", onclick: opts.action.onClick }, opts.action.label),
			];
			this.message.replaceChildren(...parts.filter(Boolean)); // replaceChildren would stringify null
		});
	}

	setStatus(text) {
		const el = this.message.querySelector(".aur-message-detail");
		if (el) el.textContent = text || "";
	}

	/** Render a Lyrics object (with a cross-fade from whatever was shown). */
	setLyrics(lyrics) {
		this.swap(() => this.render(lyrics));
	}

	render(lyrics) {
		this.resetContent();
		this.lyrics = lyrics;
		this.message.replaceChildren();
		this.stage.dataset.mode = lyrics.synced ? "synced" : "unsynced";
		this.stage.scrollTop = 0;
		this.scrollPos = 0;

		const letters = this.wordAnim === "letters";
		/**
		 * Append word spans for `words` to `container`; returns [{ w, span }].
		 * Pieces with no whitespace between them (syllables of one word) share one
		 * no-wrap group so a word can never break across lines or drift apart.
		 * Long-held words (and every word in "letters" mode) are split into letters,
		 * each knowing its index (--i) and the letter count (--n) for the letter wave.
		 */
		const addWords = (container, words) => {
			let group = null;
			return words.map((w) => {
				const m = w.text.match(/^(\s*)([\s\S]*?)(\s*)$/);
				if (m[1]) {
					group = null;
					container.append(m[1]);
				}
				const long = w.end - w.time >= LONG_WORD_MS;
				const chars = Array.from(m[2]);
				const split = (letters || long) && chars.length > 1 && chars.length <= 16;
				const content = split ? chars.map((ch, ci) => h("span", { class: "aur-c", style: `--i:${ci};--n:${chars.length}` }, ch)) : m[2];
				const span = h("span", { class: `aur-w${long ? " is-long" : ""}${split ? " has-chars" : ""}` }, content);
				if (!group) {
					group = h("span", { class: "aur-wg" });
					container.append(group);
				}
				group.append(span);
				if (m[3]) {
					group = null;
					container.append(m[3]);
				}
				return { w, span };
			});
		};

		const frag = document.createDocumentFragment();
		lyrics.lines.forEach((line, i) => {
			let el;
			let words = null;
			if (line.gap) {
				// Instrumental break: three dots that fill up over the gap's duration.
				el = h("div", { class: "aur-line is-gap", "aria-hidden": "true" }, h("span", { class: "aur-dots" }, h("i"), h("i"), h("i")));
			} else {
				const main = h("div", { class: "aur-main" });
				el = h("div", { class: line.opposite ? "aur-line is-opposite" : "aur-line" }, main);
				// Duets: who sings it (colours per singer; older cached lyrics only have `opposite`).
				const singer = line.singer ?? (line.opposite ? 1 : null);
				if (singer) el.dataset.singer = String(singer);
				let pairs = [];
				if (line.words) {
					el.classList.add("has-words");
					pairs = addWords(main, line.words);
				} else {
					main.textContent = line.text;
				}
				// Background vocals: a smaller line under the main one, filled in time with it.
				if (line.bg && this.showBg) {
					const bgEl = h("div", { class: "aur-bgv" });
					if (line.bg.words) {
						el.classList.add("has-words");
						pairs = pairs.concat(addWords(bgEl, line.bg.words));
					} else bgEl.textContent = line.bg.text;
					el.classList.add("has-bg");
					el.append(bgEl);
				}
				if (pairs.length) {
					pairs.sort((a, b) => a.w.time - b.w.time);
					words = { words: pairs.map((p) => p.w), spans: pairs.map((p) => p.span) };
				}
			}
			if (lyrics.synced && line.time != null && this.onSeek) {
				if (!line.gap) {
					const s = Math.floor(line.time / 1000);
					el.dataset.time = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; // hover chip
				}
				el.addEventListener("click", () => {
					this.stopBrowsing(true);
					this.onSeek(line.time);
				});
			}
			if (!line.gap && this.onShare) {
				el.addEventListener("contextmenu", (e) => {
					e.preventDefault();
					this.onShare(i);
				});
			}
			this.lineEls.push(el);
			this.wordEls.push(words);
			frag.append(el);
		});
		this.list.replaceChildren(frag);
		this.applyTranslations();

		if (lyrics.synced) {
			// Jump straight to the current line, then order the entrance wave around it.
			this.update(this.lastPos, this.lastDuration);
			const focus = Math.max(this.active, 0);
			this.lineEls.forEach((el, i) => el.style.setProperty("--i", String(clamp(i - focus + 3, 0, 12))));
		}
	}

	/** Show translations (array aligned to the current lyrics' lines) or remove them (null). */
	setTranslations(lines) {
		this.tr = lines;
		this.applyTranslations();
		if (this.lyrics?.synced) this.position(true);
	}

	applyTranslations() {
		for (const el of this.list.querySelectorAll(".aur-tr")) el.remove();
		const tr = this.tr;
		if (!tr || !this.lyrics || tr.length !== this.lyrics.lines.length) return;
		this.lineEls.forEach((el, i) => {
			if (!tr[i] || el.classList.contains("is-gap")) return;
			const node = h("div", { class: "aur-tr", lang: "" }, tr[i]);
			const bg = el.querySelector(".aur-bgv");
			bg ? el.insertBefore(node, bg) : el.append(node);
		});
	}

	setOptions({ layout, wordSync, autoScroll, reduced, wordAnim, showBg }) {
		if (layout && layout !== this.layout) {
			this.layout = layout;
			this.stopBrowsing(true);
		}
		// These change the DOM structure, so re-render in place (no swap animation).
		const rebuild = (wordAnim != null && (wordAnim === "letters") !== (this.wordAnim === "letters")) || (showBg != null && showBg !== this.showBg);
		if (wordAnim != null) this.wordAnim = wordAnim;
		if (showBg != null) this.showBg = showBg;
		if (rebuild && this.lyrics && !this.frozen) this.render(this.lyrics);
		if (wordSync != null) this.wordSync = wordSync;
		if (autoScroll != null) this.autoScroll = autoScroll;
		if (reduced != null) this.reduced = reduced;
	}

	// -------------------------------------------------------------------------
	// Per-frame update
	// -------------------------------------------------------------------------

	/**
	 * @param {number} pos      lyrics-timeline position in ms (offset already applied)
	 * @param {number} duration track duration in ms (for unsynced auto-scroll)
	 */
	update(pos, duration) {
		this.lastPos = pos;
		this.lastDuration = duration;
		const lyrics = this.lyrics;
		if (!lyrics || this.frozen) return;
		if (!lyrics.synced) return this.updateUnsynced(pos, duration);

		const idx = findLineIndex(lyrics.lines, pos);
		if (idx !== this.active) this.activate(idx);
		if (idx < 0) return;

		const line = lyrics.lines[idx];
		if (line.gap) {
			const p = clamp((pos - line.time) / Math.max(1, line.end - line.time), 0, 1);
			this.lineEls[idx].style.setProperty("--aur-gp", p.toFixed(3));
		} else if (this.wordEls[idx] && this.wordSync) {
			this.updateWords(idx, pos);
		}
	}

	/** Move the "active" markers from the old index to the new one. */
	activate(idx) {
		const prev = this.active;
		const els = this.lineEls;
		const n = els.length;

		if (prev >= -1) {
			for (let i = Math.max(0, prev - WINDOW); i <= Math.min(n - 1, prev + WINDOW); i++) {
				els[i].removeAttribute("data-d");
				els[i].classList.remove("is-active");
			}
			if (prev >= 0) this.resetWords(prev);
		}

		// Before the first line, line 0 is the focus but isn't marked active.
		const focus = Math.max(idx, 0);
		for (let i = Math.max(0, focus - WINDOW); i <= Math.min(n - 1, focus + WINDOW); i++) {
			els[i].dataset.d = String(idx < 0 ? i - focus + 1 : i - focus);
		}
		if (idx >= 0) {
			els[idx].classList.add("is-active");
			this.measureHalo(els[idx]);
		}

		// Direction drives the stagger order (leading edge moves first).
		this.list.dataset.dir = idx >= prev ? "up" : "down";
		const jump = prev < -1 || Math.abs(idx - prev) > SNAP_JUMP;
		this.active = idx;
		this.wordIdx = -1;
		this.position(jump);
	}

	/** Recompute geometry for the current active line (also used on resize / settings change). */
	position(instant = false) {
		if (!this.lyrics?.synced || !this.lineEls.length) return;
		const focus = this.lineEls[Math.max(this.active, 0)];
		if (instant) this.stage.classList.add("aur-no-anim");

		if (this.layout === "stack") {
			this.stage.style.setProperty("--aur-ah", `${focus.offsetHeight}px`);
		} else {
			this.y = Math.round(this.stage.clientHeight * ANCHOR - (focus.offsetTop + focus.offsetHeight / 2));
			if (!this.browsing) this.list.style.setProperty("--aur-y", `${this.y}px`);
		}

		if (instant) {
			void this.list.offsetHeight; // flush so no-anim applies to this change only
			nextFrame(() => this.stage.classList.remove("aur-no-anim"));
		}
	}

	/**
	 * Place the ambient light behind the actual text of a line: a block's box spans the full
	 * width, but wrapped/balanced text usually doesn't. Measured once per line change, in the
	 * element's own (untransformed) coordinates.
	 */
	measureHalo(el) {
		const main = el.querySelector(".aur-main");
		if (!main || !main.firstChild) return;
		const range = document.createRange();
		range.selectNodeContents(main);
		const t = range.getBoundingClientRect();
		const m = main.getBoundingClientRect();
		if (!m.width || !t.width) return;
		const k = main.offsetWidth / m.width; // undo the line's current scale
		main.style.setProperty("--hx", `${Math.round((t.left - m.left) * k)}px`);
		main.style.setProperty("--hy", `${Math.round((t.top - m.top) * k)}px`);
		main.style.setProperty("--hw", `${Math.round(t.width * k)}px`);
		main.style.setProperty("--hh", `${Math.round(t.height * k)}px`);
	}

	relayout() {
		if (this.lyrics?.synced && this.active >= 0) this.measureHalo(this.lineEls[this.active]);
		if (this.lyrics?.synced) this.position(true);
	}

	// -------------------------------------------------------------------------
	// Browsing synced lyrics with the mouse wheel
	// -------------------------------------------------------------------------

	onWheel(e) {
		this.lastUserScroll = performance.now();
		if (!this.lyrics?.synced || this.layout !== "list" || !this.lineEls.length) return; // unsynced: native scroll
		e.preventDefault();
		const first = this.lineEls[0];
		const last = this.lineEls[this.lineEls.length - 1];
		const anchor = this.stage.clientHeight * ANCHOR;
		const maxY = anchor - (first.offsetTop + first.offsetHeight / 2);
		const minY = anchor - (last.offsetTop + last.offsetHeight / 2);
		const dy = e.deltaMode === 1 ? e.deltaY * 36 : e.deltaY;
		this.browseY = clamp((this.browsing ? this.browseY : this.y) - dy, minY, maxY);
		if (!this.browsing) {
			this.browsing = true;
			this.stage.classList.add("is-browsing");
		}
		this.list.style.setProperty("--aur-y", `${Math.round(this.browseY)}px`);
		clearTimeout(this.browseTimer);
		this.browseTimer = setTimeout(() => this.stopBrowsing(), BROWSE_RESUME);
	}

	/** Return to following playback. */
	stopBrowsing(instant = false) {
		clearTimeout(this.browseTimer);
		if (!this.browsing) return;
		this.browsing = false;
		this.stage.classList.remove("is-browsing");
		if (instant) return;
		this.list.dataset.dir = this.browseY > this.y ? "up" : "down";
		this.list.style.setProperty("--aur-y", `${this.y}px`);
	}

	// -------------------------------------------------------------------------
	// Words / unsynced
	// -------------------------------------------------------------------------

	resetWords(i) {
		const data = this.wordEls[i];
		if (!data) return;
		for (const s of data.spans) {
			s.classList.remove("sung", "now");
			s.style.removeProperty("--aur-wp");
		}
	}

	/**
	 * Word-level progress for the active line (main + background words, time-ordered).
	 * Every word carries one continuous value, --aur-wp: 0 = upcoming, 0..1 = being sung,
	 * 1 = sung. All word styling (sweep, colour, lift, glow, scale, letter wave) is derived
	 * from it in CSS, so nothing ever snaps between states. Only the current word is
	 * written every frame; others change once when the current word moves on.
	 */
	updateWords(idx, pos) {
		const { words, spans } = this.wordEls[idx];
		pos += WORD_LEAD_MS;
		const k = findLineIndex(words, pos); // same binary search works on words
		if (k !== this.wordIdx) {
			const from = Math.max(0, Math.min(k, this.wordIdx));
			const to = Math.max(k, this.wordIdx);
			for (let i = from; i <= to && i < spans.length; i++) {
				const span = spans[i];
				span.classList.toggle("sung", i < k);
				span.classList.toggle("now", i === k);
				if (i < k) span.style.setProperty("--aur-wp", "1");
				else if (i > k) span.style.removeProperty("--aur-wp");
			}
			this.wordIdx = k;
		}
		if (k >= 0 && k < spans.length) {
			const w = words[k];
			const p = w.end > w.time ? Math.min(1, Math.max(0, (pos - w.time) / (w.end - w.time))) : 1;
			spans[k].style.setProperty("--aur-wp", p.toFixed(4));
		}
	}

	/** Unsynced lyrics: gently scroll proportionally to track progress. */
	updateUnsynced(pos, duration) {
		if (!this.autoScroll || !duration) return;
		if (performance.now() - this.lastUserScroll < USER_SCROLL_PAUSE) {
			this.scrollPos = this.stage.scrollTop;
			return;
		}
		const max = this.stage.scrollHeight - this.stage.clientHeight;
		if (max <= 0) return;
		// Lead slightly so the lines being sung sit in the upper-middle of the screen.
		const target = clamp((pos / duration) * max * 1.05 - this.stage.clientHeight * 0.1, 0, max);
		this.scrollPos += (target - this.scrollPos) * 0.04; // exponential smoothing
		if (Math.abs(this.scrollPos - this.stage.scrollTop) >= 0.5) this.stage.scrollTop = this.scrollPos;
	}
}

// ---- panel.js --------------------------------------------------------------
// Side drawer with two tabs:
//  - Settings: generated from SCHEMA (segmented controls, style cards, font tiles,
//    filled sliders, switches), applied live.
//  - This track: paste / import .lrc or .txt lyrics for the current track.


const MAX_IMPORT_BYTES = 512 * 1024;
const SEGMENT_ICONS = { left: ICONS.alignLeft, center: ICONS.alignCenter, right: ICONS.alignRight };
const ACCENT_SWATCHES = ["#ff5fa2", "#ff7a45", "#ffc93d", "#3ddc84", "#2ec5ff", "#7aa2ff", "#b388ff", "#ffffff"];

const loadedFonts = new Set();
/** Load a Google web font the first time it is needed (no-op for local stacks). */
function ensureFont(key) {
	const f = FONTS[key];
	if (!f?.web || loadedFonts.has(key)) return;
	loadedFonts.add(key);
	document.head.append(h("link", { rel: "stylesheet", href: `https://fonts.googleapis.com/css2?family=${f.web}&display=swap`, "data-aur-font": key }));
}

function fmtValue(entry, v) {
	if (entry.key === "bgOpacity") return `${Math.round(v * 100)}%`;
	if (entry.key === "offset") return `${v > 0 ? "+" : ""}${v} ms`;
	if (entry.unit === "em") return `${Number(v).toFixed(2)}em`;
	if (entry.key === "autoHideDelay") return `${(v / 1000).toFixed(1)} s`;
	return `${v}${entry.unit ? ` ${entry.unit}` : ""}`;
}

/** A group of radio-like buttons; returns { el, sync }. */
function choiceGroup(entry, className, renderOption) {
	const buttons = new Map();
	const el = h(
		"div",
		{ class: className, role: "radiogroup", "aria-label": entry.label },
		entry.options.map(([v, label]) => {
			const btn = renderOption(v, label);
			btn.setAttribute("role", "radio");
			btn.addEventListener("click", () => settings.set(entry.key, v));
			buttons.set(v, btn);
			return btn;
		}),
	);
	const sync = (value) => {
		for (const [v, btn] of buttons) btn.setAttribute("aria-checked", String(v === value));
	};
	sync(settings.get(entry.key));
	return { el, sync };
}

function buildControl(entry) {
	const id = `aur-set-${entry.key}`;
	const value = settings.get(entry.key);
	const labelEl = (extra) => h("div", { class: "aur-row-label" }, h("span", null, entry.label), extra);

	if (entry.type === "providers") {
		// Ordered provider list: rank, name (+ WORD badge), description, move up/down, on/off.
		const list = h("div", { class: "aur-prov-list" });
		const render = (providers) => {
			const set = (next) => settings.set(entry.key, next);
			list.replaceChildren(
				...providers.map((p, i) => {
					const info = PROVIDER_INFO.find((x) => x.id === p.id);
					const move = (d) => {
						const next = [...providers];
						[next[i], next[i + d]] = [next[i + d], next[i]];
						set(next);
					};
					return h(
						"div",
						{ class: p.on ? "aur-prov" : "aur-prov is-off" },
						h("span", { class: "aur-prov-rank" }, String(i + 1)),
						h("div", null, h("div", { class: "aur-prov-name" }, info.label, info.words ? h("span", { class: "aur-prov-badge", title: "Can provide word-by-word timing" }, "WORD") : null), h("div", { class: "aur-prov-desc" }, info.desc)),
						h(
							"div",
							{ class: "aur-prov-move" },
							h("button", { title: "Move up", "aria-label": `Move ${info.label} up`, html: ARROWS.up(), disabled: i === 0, onclick: () => move(-1) }),
							h("button", { title: "Move down", "aria-label": `Move ${info.label} down`, html: ARROWS.down(), disabled: i === providers.length - 1, onclick: () => move(1) }),
						),
						h("input", {
							type: "checkbox",
							class: "aur-switch",
							checked: p.on,
							"aria-label": `Use ${info.label}`,
							onchange: (e) => set(providers.map((q) => (q.id === p.id ? { ...q, on: e.target.checked } : q))),
						}),
					);
				}),
			);
		};
		render(value);
		return { row: h("div", { class: "aur-row aur-row-stack" }, labelEl(), list), sync: render };
	}

	if (entry.type === "color") {
		// "Album" (colour from the cover art), a few presets, and a custom picker.
		const picker = h("input", { type: "color", class: "aur-swatch-input", "aria-label": "Pick a custom colour", oninput: (e) => settings.set(entry.key, e.target.value) });
		const customBtn = h("label", { class: "aur-swatch is-custom", title: "Custom colour", role: "radio" }, picker);
		const albumBtn = h("button", { class: "aur-swatch is-album", title: "From the album cover", role: "radio", onclick: () => settings.set(entry.key, "album") }, "Album");
		const presetBtns = ACCENT_SWATCHES.map((c) =>
			h("button", { class: "aur-swatch", title: c, role: "radio", "aria-label": `Accent ${c}`, style: `--sw:${c}`, "data-color": c, onclick: () => settings.set(entry.key, c) }),
		);
		const sync = (v) => {
			const preset = ACCENT_SWATCHES.includes(v);
			albumBtn.setAttribute("aria-checked", String(v === "album"));
			for (const b of presetBtns) b.setAttribute("aria-checked", String(b.dataset.color === v));
			const custom = v !== "album" && !preset;
			customBtn.setAttribute("aria-checked", String(custom));
			customBtn.style.setProperty("--sw", custom ? v : "transparent");
			if (v !== "album") picker.value = v;
		};
		sync(value);
		const el = h("div", { class: "aur-swatches", role: "radiogroup", "aria-label": entry.label }, albumBtn, presetBtns, customBtn);
		return { row: h("div", { class: "aur-row aur-row-stack" }, labelEl(), el), sync };
	}

	if (entry.type === "toggle") {
		const input = h("input", { type: "checkbox", id, class: "aur-switch", checked: !!value, onchange: (e) => settings.set(entry.key, e.target.checked) });
		return { row: h("label", { class: "aur-row aur-row-toggle", for: id }, h("span", null, entry.label), input), sync: (v) => (input.checked = !!v) };
	}

	if (entry.type === "select" && entry.ui === "segmented") {
		const { el, sync } = choiceGroup(entry, "aur-segmented", (v, label) =>
			h("button", { class: "aur-seg", title: label, html: SEGMENT_ICONS[v] && entry.key === "textAlign" ? SEGMENT_ICONS[v]() : null }, SEGMENT_ICONS[v] && entry.key === "textAlign" ? null : label),
		);
		return { row: h("div", { class: "aur-row aur-row-stack" }, labelEl(), el), sync };
	}

	if (entry.type === "select" && entry.ui === "cards") {
		const { el, sync } = choiceGroup(entry, "aur-cards", (v, label) =>
			h("button", { class: "aur-card" }, h("span", { class: "aur-card-art", html: STYLE_ART[v] || "" }), h("span", { class: "aur-card-name" }, label), h("span", { class: "aur-card-hint" }, entry.hints?.[v] || "")),
		);
		return { row: h("div", { class: "aur-row aur-row-stack" }, labelEl(), el), sync };
	}

	if (entry.type === "select" && entry.ui === "fonts") {
		const { el, sync } = choiceGroup(entry, "aur-fonts", (v, label) => {
			const f = FONTS[v];
			return h(
				"button",
				{ class: "aur-font", title: f.web ? `${label} (web font, loaded from Google Fonts)` : label, onpointerenter: () => ensureFont(v), onfocus: () => ensureFont(v) },
				h("span", { class: "aur-font-sample", style: { fontFamily: f.stack } }, "Aa"),
				h("span", { class: "aur-font-name" }, label),
			);
		});
		return { row: h("div", { class: "aur-row aur-row-stack" }, labelEl(), el), sync };
	}

	if (entry.type === "select") {
		const select = h(
			"select",
			{ id, class: "aur-select", onchange: (e) => settings.set(entry.key, e.target.value) },
			entry.options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)),
		);
		return { row: h("label", { class: "aur-row", for: id }, h("span", null, entry.label), select), sync: (v) => (select.value = v) };
	}

	// range — the filled part of the track is drawn from --p (0..100%)
	const out = h("output", { class: "aur-range-value" }, fmtValue(entry, value));
	const input = h("input", { type: "range", id, min: String(entry.min), max: String(entry.max), step: String(entry.step), class: "aur-range" });
	const paint = (v) => {
		input.style.setProperty("--p", `${((v - entry.min) / (entry.max - entry.min)) * 100}%`);
		out.textContent = fmtValue(entry, v);
	};
	input.addEventListener("input", (e) => {
		const v = Number(e.target.value);
		paint(v);
		settings.set(entry.key, v);
	});
	input.value = String(value);
	paint(value);
	return {
		row: h("label", { class: "aur-row aur-row-range", for: id }, labelEl(out), input),
		sync: (v) => {
			input.value = String(v);
			paint(v);
		},
	};
}

/**
 * @param {{
 *   getTrack: () => object|null,
 *   getLyricsInfo: () => { source: string|null, sourceLabel: string, pinned: boolean, lrc: string, localText: string|null },
 *   chooseSource: (id: string|null) => Promise<void>,   // null = automatic
 *   testSources: () => Promise<object>,

 *   saveLocal: (text: string, fileName?: string) => void,
 *   removeLocal: () => void,
 *   clearCache: () => number,
 *   toast: (msg: string) => void,
 * }} ctx
 */
function createPanel(ctx) {
	const syncers = new Map();

	// --- Pages ----------------------------------------------------------------
	// Rail order. "track" = this song's lyrics; the others group SCHEMA sections.
	const PAGES = [
		{ id: "track", label: "Lyrics", icon: ICONS.navLyrics, title: "This track", sub: "Source, reload, import" },
		{ id: "look", label: "Look", icon: ICONS.navLook, title: "Look", sub: "Layout, text and background", sections: ["Theme", "Layout", "Text", "Background"] },
		{ id: "motion", label: "Motion", icon: ICONS.navMotion, title: "Motion", sub: "Line and word animation", sections: ["Motion", "Words"] },
		{ id: "sources", label: "Sources", icon: ICONS.navSources, title: "Sources", sub: "Where lyrics come from, translation", sections: ["Sources", "Translation"] },
		{ id: "general", label: "General", icon: ICONS.navGeneral, title: "General", sub: "Sync, controls and shortcuts", sections: ["Sync", "Interface"] },
	];

	const sections = new Map();
	for (const entry of SCHEMA) {
		if (!sections.has(entry.section)) sections.set(entry.section, []);
		const { row, sync } = buildControl(entry);
		row.dataset.key = entry.key;
		// Text the search box matches against: label, section, option names.
		row.dataset.search = [entry.label, entry.section, ...(entry.options || []).map((o) => o[1]), ...Object.values(entry.hints || {})].join(" ").toLowerCase();
		syncers.set(entry.key, sync);
		sections.get(entry.section).push(row);
	}
	// Theme cards: one-click looks. "Custom" appears once the user has a look of their own
	// (it restores what a theme replaced).
	const themeCards = new Map();
	const themeCard = (id, label, hint, swatch, font) => {
		const btn = h(
			"button",
			{
				class: "aur-card aur-theme",
				role: "radio",
				title: hint,
				onpointerenter: () => ensureFont(font),
				onclick: () => {
					if (btn.getAttribute("aria-checked") === "true") return;
					settings.applyTheme(id);
					ctx.toast(id === "custom" ? "Your custom look is back" : `Theme: ${label}`);
				},
			},
			h("span", { class: "aur-theme-art", style: `--t1:${swatch[0]};--t2:${swatch[1]}` }, h("span", { style: { fontFamily: FONTS[font]?.stack } }, "Aa")),
			h("span", { class: "aur-card-name" }, label),
			h("span", { class: "aur-card-hint" }, hint),
		);
		themeCards.set(id, btn);
		return btn;
	};
	const themeGrid = h(
		"div",
		{ class: "aur-cards aur-themes", role: "radiogroup", "aria-label": "Theme" },
		THEMES.map((t) => themeCard(t.id, t.label, t.hint, t.swatch, t.values.font || DEFAULTS.font)),
		themeCard("custom", "Custom", "Your own look", ["#3a3a44", "#16161c"], DEFAULTS.font),
	);
	const syncThemes = (all) => {
		const active = settings.currentTheme() || "custom";
		for (const [id, btn] of themeCards) btn.setAttribute("aria-checked", String(id === active));
		themeCards.get("custom").hidden = active !== "custom" && !all.customLook;
	};
	const themeRow = h("div", { class: "aur-row aur-row-stack" }, h("div", { class: "aur-row-label" }, h("span", null, "Theme")), themeGrid);
	themeRow.dataset.search = ["theme preset look style", ...THEMES.map((t) => `${t.label} ${t.hint}`)].join(" ").toLowerCase();
	sections.get("Theme").unshift(themeRow);
	syncThemes(settings.all());

	const bodies = {};
	for (const page of PAGES.filter((pg) => pg.sections)) {
		bodies[page.id] = h(
			"div",
			{ class: "aur-tab-body", "data-tab": page.id, hidden: true },
			page.sections.map((name) => h("div", { class: "aur-section", "data-section": name }, h("h3", null, name), h("div", { class: "aur-section-card" }, sections.get(name) || []))),
		);
	}
	bodies.general.append(
		h("div", { class: "aur-section" }, h("h3", null, "Shortcuts"), h(
			"div",
			{ class: "aur-keys" },
			[
				["Alt L", "Open / close"],
				["Esc", "Close"],
				["[ ]", "Offset ∓100 ms"],
				["F", "Fullscreen"],
				["S", "Share lyrics"],
				["Alt M", "Mini lyrics"],
				["Right-click line", "Share that line"],
				["Wheel", "Browse lyrics"],
				["Click line", "Jump there"],
			].map(([k, d]) => h("div", { class: "aur-key" }, h("kbd", null, k), h("span", null, d))),
		)),
		h(
			"div",
			{ class: "aur-section" },
			h("h3", null, "Maintenance"),
			h(
				"div",
				{ class: "aur-panel-actions" },
				h("button", { class: "aur-btn", onclick: () => ctx.toast(`Cleared ${ctx.clearCache()} cached lyrics`) }, "Clear lyrics cache"),
				h("button", { class: "aur-btn aur-btn-ghost", onclick: () => (settings.reset(), ctx.toast("Settings reset")) }, "Reset to defaults"),
			),
		),
	);
	const settingsBodies = Object.values(bodies);
	const noResults = h("div", { class: "aur-no-results", hidden: true }, "No settings match your search.");

	const syncDisabled = (all) => {
		for (const b of settingsBodies) b.querySelector('[data-key="autoHideDelay"]')?.classList.toggle("is-disabled", !all.autoHideControls);
	};
	const unsubscribe = settings.subscribe((key, v, all) => {
		if (key === "*") for (const [k, fn] of syncers) fn(all[k]);
		else syncers.get(key)?.(v);
		syncDisabled(all);
		syncThemes(all);
	});
	syncDisabled(settings.all());

	// --- This track tab ------------------------------------------------------
	// "Load lyrics from": Auto + one button per provider. Picking one pins it to this track.
	const sourceGrid = h("div", { class: "aur-src-grid" });
	const testBtn = h(
		"button",
		{
			class: "aur-btn aur-btn-ghost aur-test-btn",
			title: "Ask every source for this song and show what each one returns (doesn't change your settings)",
			onclick: async () => {
				testBtn.disabled = true;
				testBtn.textContent = "Testing sources…";
				await ctx.testSources();
				testBtn.disabled = false;
				testBtn.textContent = "Test all sources";
				refreshSources();
			},
		},
		"Test all sources",
	);
	const trackInfo = h("div", null, h("div", { class: "aur-src-title" }, "Load lyrics from"), sourceGrid, testBtn, h("div", { class: "aur-src-title" }, "Edit or import"));
	const textarea = h("textarea", {
		class: "aur-textarea",
		spellcheck: "false",
		placeholder: "Paste lyrics here.\n\nSynced (LRC):\n[00:12.30]First line\n[00:15.80]Second line\n\nEnhanced LRC (word timing):\n[00:12.30]<00:12.30>First <00:12.70>line<00:13.40>\n\nOr plain text for unsynced lyrics.",
	});
	const fileInput = h("input", {
		type: "file",
		accept: ".lrc,.txt,text/plain",
		hidden: true,
		onchange: async (e) => {
			const file = e.target.files?.[0];
			e.target.value = "";
			if (!file) return;
			if (file.size > MAX_IMPORT_BYTES) return ctx.toast("File is too large (max 512 KB)");
			textarea.value = await file.text();
			textarea.dataset.fileName = file.name;
			ctx.toast(`Loaded ${file.name} — press Save to use it`);
		},
	});
	const removeBtn = h("button", { class: "aur-btn aur-btn-danger", onclick: () => (ctx.removeLocal(), refreshTrack()) }, "Remove imported");

	// Dropping a file anywhere on the editor imports it.
	textarea.addEventListener("dragover", (e) => (e.preventDefault(), textarea.classList.add("is-drop")));
	textarea.addEventListener("dragleave", () => textarea.classList.remove("is-drop"));
	textarea.addEventListener("drop", async (e) => {
		e.preventDefault();
		textarea.classList.remove("is-drop");
		const file = e.dataTransfer?.files?.[0];
		if (!file) return;
		if (file.size > MAX_IMPORT_BYTES) return ctx.toast("File is too large (max 512 KB)");
		textarea.value = await file.text();
		textarea.dataset.fileName = file.name;
		ctx.toast(`Loaded ${file.name} — press Save to use it`);
	});

	const trackBody = h(
		"div",
		{ class: "aur-tab-body", "data-tab": "track", hidden: true },
		trackInfo,
		textarea,
		h(
			"div",
			{ class: "aur-panel-actions" },
			h("button", { class: "aur-btn", onclick: () => fileInput.click(), html: `${ICONS.upload()}<span>Import file</span>` }),
			h(
				"button",
				{
					class: "aur-btn aur-btn-ghost",
					title: "Copy the currently shown lyrics into the editor (e.g. to fix timings)",
					onclick: () => {
						const { lrc } = ctx.getLyricsInfo();
						if (!lrc) return ctx.toast("No lyrics loaded to copy");
						textarea.value = lrc;
					},
				},
				"Start from current",
			),
		),
		h(
			"div",
			{ class: "aur-panel-actions" },
			h(
				"button",
				{
					class: "aur-btn aur-btn-primary",
					onclick: () => {
						const text = textarea.value.trim();
						if (!text) return ctx.toast("Nothing to save");
						ctx.saveLocal(text, textarea.dataset.fileName);
						refreshTrack();
					},
				},
				"Save for this track",
			),
			removeBtn,
		),
		h("p", { class: "aur-hint" }, "Drop an .lrc or .txt file on the editor, or paste text. Imported lyrics are stored locally, always take priority over online sources, and also apply to the same song on other albums."),
		fileInput,
	);

	function refreshSources() {
		const info = ctx.getLyricsInfo();
		const current = info.pinned ? info.source : "auto";
		// Hint per source: what the last search found there, else what it can provide.
		const outcome = (id) => {
			const r = info.report?.[id];
			if (!r) return null;
			if (r.status === "found") return r.quality === 3 ? "word sync" : r.quality === 2 ? "line sync" : "plain text";
			return { notfound: "no lyrics", error: "unreachable", skipped: "busy, retry later" }[r.status] || null;
		};
		// Sources switched off in settings are still pickable here, but say so.
		const enabled = new Set(settings.enabledProviders());
		const hintFor = (p) => {
			const o = outcome(p.id);
			if (o) return o;
			if (!enabled.has(p.id)) return "off in settings";
			return p.words ? "can word sync" : "";
		};
		const options = [["auto", "Auto", "best match"], ...PROVIDER_INFO.map((p) => [p.id, p.label, hintFor(p)])];
		sourceGrid.replaceChildren(
			...options.map(([id, label, hint]) => {
				const btn = h(
					"button",
					{
						class: `aur-src-btn${id === current ? " is-current" : ""}`,
						title: id === "auto" ? "Search all enabled sources in order" : `Use ${label} for this track`,
						onclick: async () => {
							btn.classList.add("is-loading");
							btn.lastChild.textContent = "loading…";
							await ctx.chooseSource(id === "auto" ? null : id);
							refreshSources();
						},
					},
					h("span", null, label),
					h("small", null, id === info.source ? (info.pinned || id === "auto" ? "✓ in use" : "in use") : hint),
				);
				return btn;
			}),
		);
	}

	function refreshTrack() {
		const info = ctx.getLyricsInfo();
		refreshSources();
		textarea.value = info.localText || "";
		delete textarea.dataset.fileName;
		removeBtn.disabled = !info.localText;
	}

	// --- Shell: rail + header (title, search, close) + pages --------------------
	const nowPlaying = h("div", { class: "aur-np" });
	function setNowPlaying(track, sourceLabel) {
		nowPlaying.hidden = !track;
		if (!track) return;
		nowPlaying.replaceChildren(
			track.image ? h("img", { src: track.image, alt: "" }) : null,
			h("div", { class: "aur-np-text" }, h("div", { class: "aur-np-title" }, track.title), h("div", { class: "aur-np-sub" }, [track.artist, track.album].filter(Boolean).join(" • "))),
			h("span", { class: "aur-np-chip", title: "Lyrics source" }, sourceLabel || "No lyrics"),
		);
	}
	trackBody.prepend(nowPlaying);

	const railButtons = new Map();
	const rail = h(
		"nav",
		{ class: "aur-rail", role: "tablist", "aria-orientation": "vertical", "aria-label": "Settings pages" },
		h("span", { class: "aur-rail-pill", "aria-hidden": "true" }),
		PAGES.map((pg) => {
			const btn = h("button", { class: "aur-rail-btn", role: "tab", title: pg.title, onclick: () => ((search.value = ""), show(pg.id)) }, h("span", { class: "aur-rail-icon", html: pg.icon() }), h("span", { class: "aur-rail-label" }, pg.label));
			railButtons.set(pg.id, btn);
			return btn;
		}),
	);
	const titleEl = h("div", { class: "aur-panel-title" });
	const subEl = h("div", { class: "aur-panel-sub" });
	const search = h("input", { type: "search", class: "aur-search", placeholder: "Search settings", "aria-label": "Search settings", spellcheck: "false" });
	search.addEventListener("input", () => applySearch());
	const el = h(
		"div",
		{ class: "aur-panel", role: "dialog", "aria-label": "Lyrics settings" },
		rail,
		h(
			"div",
			{ class: "aur-panel-main" },
			h(
				"div",
				{ class: "aur-panel-head" },
				h("div", { class: "aur-panel-heading" }, titleEl, subEl),
				h("button", { class: "aur-icon-btn aur-panel-close", title: "Close (Esc)", "aria-label": "Close settings", html: ICONS.close(), onclick: () => close() }),
				h("label", { class: "aur-search-wrap" }, h("span", { class: "aur-search-icon", html: ICONS.search() }), search),
			),
			h("div", { class: "aur-panel-scroll" }, trackBody, settingsBodies, noResults),
		),
	);
	// Keep typing in the panel from triggering Spotify / overlay shortcuts.
	el.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && search.value) {
			e.stopPropagation();
			search.value = "";
			applySearch();
			return;
		}
		if (e.key !== "Escape") e.stopPropagation();
	});
	// Wheel inside the panel scrolls the panel, not the lyrics.
	el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

	let current = "look";
	let lastSettingsPage = "look";
	function show(tab) {
		current = tab;
		if (tab !== "track") lastSettingsPage = tab;
		el.dataset.tab = tab;
		const page = PAGES.find((pg) => pg.id === tab);
		titleEl.textContent = page.title;
		subEl.textContent = page.sub;
		PAGES.forEach((pg, i) => {
			const on = pg.id === tab;
			railButtons.get(pg.id).setAttribute("aria-selected", String(on));
			if (on) rail.style.setProperty("--i", String(i));
		});
		trackBody.hidden = tab !== "track";
		for (const [id, body] of Object.entries(bodies)) body.hidden = id !== tab;
		noResults.hidden = true;
		el.querySelector(".aur-panel-scroll").scrollTop = 0;
		if (tab === "track") refreshTrack();
	}

	/** Filter rows on every settings page; empty query returns to the current page. */
	function applySearch() {
		const q = search.value.trim().toLowerCase();
		el.dataset.searching = q ? "true" : "false";
		if (!q) {
			for (const b of settingsBodies) for (const r of b.querySelectorAll("[data-search]")) r.hidden = false;
			for (const sec of el.querySelectorAll(".aur-section")) sec.hidden = false;
			return show(current);
		}
		titleEl.textContent = "Search";
		subEl.textContent = `Results for “${search.value.trim()}”`;
		for (const btn of railButtons.values()) btn.setAttribute("aria-selected", "false");
		trackBody.hidden = true;
		let any = false;
		for (const body of settingsBodies) {
			body.hidden = false;
			for (const sec of body.querySelectorAll(".aur-section")) {
				const rows = [...sec.querySelectorAll("[data-search]")];
				let visible = 0;
				for (const r of rows) {
					r.hidden = !q.split(/\s+/).every((w) => r.dataset.search.includes(w));
					if (!r.hidden) visible++;
				}
				sec.hidden = rows.length ? visible === 0 : true;
				any ||= visible > 0;
			}
		}
		noResults.hidden = any;
	}

	function open(tab = current) {
		if (tab === "settings") tab = lastSettingsPage;
		if (search.value) {
			search.value = "";
			el.dataset.searching = "false";
		}
		show(tab);
		el.classList.add("is-open");
	}
	function close() {
		el.classList.remove("is-open");
	}

	show("look");
	return {
		el,
		open,
		close,
		/** toggle("settings" | "track" | page id): close if that page is already showing. */
		toggle(tab) {
			const want = tab === "settings" ? (current === "track" ? lastSettingsPage : current) : tab;
			if (el.classList.contains("is-open") && (!tab || want === current)) close();
			else open(want);
		},
		isOpen: () => el.classList.contains("is-open"),
		onTrackChange: () => current === "track" && el.classList.contains("is-open") && refreshTrack(),
		/** Update the now-playing card (and the source picker if visible). */
		setNowPlaying(track, sourceLabel) {
			setNowPlaying(track, sourceLabel);
			if (current === "track" && el.classList.contains("is-open")) refreshSources();
		},
		destroy: unsubscribe,
	};
}

// ---- share.js --------------------------------------------------------------
// Share card: render a few lyric lines + cover art + track info into an image (canvas), with a
// live preview. Copy it to the clipboard or save it as a PNG.
//
// Opened from the overlay (share button, S, or right-click on a line). Everything is drawn
// locally; the only network use is loading the cover image (CORS-enabled Spotify CDN). If the
// cover can't be used on a canvas, the card falls back to the gradient background.


const SHARE_FORMATS = {
	square: { label: "Square", w: 1080, h: 1080 },
	portrait: { label: "Portrait", w: 1080, h: 1350 },
	story: { label: "Story", w: 1080, h: 1920 },
};
const BACKGROUNDS = [
	["album", "Album art"],
	["gradient", "Gradient"],
	["dark", "Dark"],
];
const MAX_LINES = 6;

const images = new Map();
/** Load an image for canvas use (CORS), cached; resolves null if it can't be used. */
function loadImage(url) {
	if (!url) return Promise.resolve(null);
	if (!images.has(url)) {
		images.set(
			url,
			new Promise((resolve) => {
				const img = new Image();
				img.crossOrigin = "anonymous";
				img.decoding = "async";
				img.onload = () => resolve(img);
				img.onerror = () => resolve(null);
				img.src = url;
			}),
		);
	}
	return images.get(url);
}

/** Any CSS colour (incl. color-mix / oklch) → something canvas understands. */
function canvasColor(css, fallback) {
	if (!css) return fallback;
	const probe = document.createElement("canvas").getContext("2d");
	probe.fillStyle = fallback;
	const el = h("span", { style: { color: css, display: "none" } });
	document.body.append(el);
	const resolved = getComputedStyle(el).color;
	el.remove();
	probe.fillStyle = resolved || fallback;
	return probe.fillStyle;
}

/** Word-wrap `text` to `maxW`; text without spaces (CJK) wraps per character. */
function wrapText(ctx, text, maxW) {
	const tokens = /\s/.test(text.trim()) ? text.trim().split(/(?<=\s)/) : Array.from(text.trim());
	const out = [];
	let line = "";
	for (const tok of tokens) {
		const tryLine = line + tok;
		if (line && ctx.measureText(tryLine.trimEnd()).width > maxW) {
			out.push(line.trimEnd());
			line = tok.trimStart();
		} else line = tryLine;
		// A single token wider than the line: break it by characters.
		while (ctx.measureText(line.trimEnd()).width > maxW && Array.from(line).length > 1) {
			const chars = Array.from(line);
			let n = chars.length - 1;
			while (n > 1 && ctx.measureText(chars.slice(0, n).join("")).width > maxW) n--;
			out.push(chars.slice(0, n).join(""));
			line = chars.slice(n).join("");
		}
	}
	if (line.trim()) out.push(line.trimEnd());
	return out;
}

function ellipsize(ctx, text, maxW) {
	if (ctx.measureText(text).width <= maxW) return text;
	const chars = Array.from(text);
	while (chars.length && ctx.measureText(`${chars.join("")}…`).width > maxW) chars.pop();
	return `${chars.join("").trimEnd()}…`;
}

function roundRect(ctx, x, y, w, hgt, r) {
	ctx.beginPath();
	ctx.roundRect ? ctx.roundRect(x, y, w, hgt, r) : ctx.rect(x, y, w, hgt);
}

/** Draw `img` covering the box (like object-fit: cover). */
function drawCover(ctx, img, x, y, w, hgt) {
	const s = Math.max(w / img.naturalWidth, hgt / img.naturalHeight);
	const iw = img.naturalWidth * s;
	const ih = img.naturalHeight * s;
	ctx.drawImage(img, x + (w - iw) / 2, y + (hgt - ih) / 2, iw, ih);
}

/**
 * Render the share image.
 * @param {HTMLCanvasElement} canvas
 * @param {{ lines: string[], title: string, artist: string, cover: HTMLImageElement|null,
 *   format: string, bg: string, font: string, uiFont: string, weight: string|number,
 *   accent: string, c1: string, c2: string }} o
 */
function drawShareCard(canvas, o) {
	const { w: W, h: H } = SHARE_FORMATS[o.format] || SHARE_FORMATS.portrait;
	canvas.width = W;
	canvas.height = H;
	const ctx = canvas.getContext("2d");
	const radial = (x, y, r, color, alpha) => {
		const g = ctx.createRadialGradient(x, y, 0, x, y, r);
		ctx.globalAlpha = alpha;
		g.addColorStop(0, color);
		g.addColorStop(1, "rgba(0,0,0,0)");
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, W, H);
		ctx.globalAlpha = 1;
	};

	// ---- background
	const bg = o.bg === "album" && !o.cover ? "gradient" : o.bg;
	if (bg === "album") {
		ctx.fillStyle = o.c2;
		ctx.fillRect(0, 0, W, H);
		ctx.save();
		ctx.filter = `blur(${Math.round(W * 0.07)}px) saturate(1.5) brightness(0.85)`;
		drawCover(ctx, o.cover, -W * 0.2, -H * 0.2, W * 1.4, H * 1.4);
		ctx.restore();
		ctx.fillStyle = "rgba(0,0,0,0.3)";
		ctx.fillRect(0, 0, W, H);
	} else if (bg === "gradient") {
		ctx.fillStyle = o.c2;
		ctx.fillRect(0, 0, W, H);
		radial(W * 0.2, H * 0.18, W * 1.05, o.c1, 0.95);
		radial(W * 0.9, H * 0.92, W * 0.8, o.accent, 0.38);
		ctx.fillStyle = "rgba(0,0,0,0.22)";
		ctx.fillRect(0, 0, W, H);
	} else {
		ctx.fillStyle = "#0b0b0f";
		ctx.fillRect(0, 0, W, H);
		radial(W * 0.12, H * 0.08, W * 0.9, o.accent, 0.2);
	}
	// Darker towards the footer so the track info always reads.
	const fade = ctx.createLinearGradient(0, H * 0.55, 0, H);
	fade.addColorStop(0, "rgba(0,0,0,0)");
	fade.addColorStop(1, "rgba(0,0,0,0.45)");
	ctx.fillStyle = fade;
	ctx.fillRect(0, 0, W, H);

	// ---- footer: cover + title / artist
	const pad = Math.round(W * 0.08);
	const cs = Math.round(W * 0.13);
	const fy = H - pad - cs;
	let tx = pad;
	if (o.cover) {
		ctx.save();
		ctx.shadowColor = "rgba(0,0,0,0.45)";
		ctx.shadowBlur = W * 0.03;
		ctx.shadowOffsetY = W * 0.008;
		roundRect(ctx, pad, fy, cs, cs, W * 0.016);
		ctx.fillStyle = "#000";
		ctx.fill();
		ctx.restore();
		ctx.save();
		roundRect(ctx, pad, fy, cs, cs, W * 0.016);
		ctx.clip();
		drawCover(ctx, o.cover, pad, fy, cs, cs);
		ctx.restore();
		tx = pad + cs + W * 0.035;
	}
	const maxT = W - pad - tx;
	ctx.textBaseline = "alphabetic";
	ctx.fillStyle = "#fff";
	ctx.font = `700 ${Math.round(W * 0.038)}px ${o.uiFont}`;
	ctx.fillText(ellipsize(ctx, o.title || "", maxT), tx, fy + cs * 0.46);
	ctx.fillStyle = "rgba(255,255,255,0.7)";
	ctx.font = `500 ${Math.round(W * 0.03)}px ${o.uiFont}`;
	ctx.fillText(ellipsize(ctx, o.artist || "", maxT), tx, fy + cs * 0.82);

	// ---- lyrics: largest size that fits the space above the footer
	const top = pad;
	const bottom = fy - pad * 0.9;
	const maxW = W - pad * 2;
	let size = W * 0.088;
	let layout;
	for (;;) {
		ctx.font = `${o.weight} ${Math.round(size)}px ${o.font}`;
		const blocks = o.lines.map((l) => wrapText(ctx, l, maxW));
		const lh = size * 1.16;
		const gapH = size * 0.42;
		const height = blocks.reduce((sum, b) => sum + b.length * lh, 0) + gapH * Math.max(0, blocks.length - 1);
		layout = { blocks, lh, gapH, height };
		if (height <= bottom - top || size <= W * 0.036) break;
		size *= 0.94;
	}
	// Centred in portrait / story; nearer the top in square (reads like a quote).
	let y = top + Math.max(0, (bottom - top - layout.height) * (o.format === "square" ? 0.35 : 0.5)) + layout.lh * 0.8;
	ctx.fillStyle = "#fff";
	// Soft light in the accent colour (canvasColor gives "#rrggbb" or "rgba(…)").
	ctx.shadowColor = /^#[0-9a-f]{6}$/i.test(o.accent) ? `${o.accent}8c` : o.accent;
	ctx.shadowBlur = size * 0.38;
	for (const [bi, block] of layout.blocks.entries()) {
		ctx.globalAlpha = 0.97;
		for (const line of block) {
			ctx.fillText(line, pad, y);
			y += layout.lh;
		}
		if (bi < layout.blocks.length - 1) y += layout.gapH;
	}
	ctx.globalAlpha = 1;
	ctx.shadowBlur = 0;
	return canvas;
}

/**
 * The share sheet (lives inside the overlay).
 * @param {{ getContext: () => { track: object|null, lyrics: object|null, active: number, root: HTMLElement }, toast: (m: string) => void, onClose?: () => void }} ctx
 */
function createShareSheet(ctx) {
	const opts = { format: "portrait", bg: "album" };
	let selected = new Set();
	let info = null; // snapshot of the context when opened
	let renderToken = 0;

	const canvas = h("canvas", { class: "aur-share-canvas", "aria-label": "Share image preview" });
	const lineList = h("div", { class: "aur-share-lines", role: "group", "aria-label": "Lines to include" });
	const count = h("span", { class: "aur-share-count" });

	const segmented = (options, key) => {
		const buttons = options.map(([v, label]) =>
			h("button", { class: "aur-seg", role: "radio", "aria-checked": String(opts[key] === v), onclick: () => ((opts[key] = v), sync(), render()) }, label),
		);
		const sync = () => buttons.forEach((b, i) => b.setAttribute("aria-checked", String(options[i][0] === opts[key])));
		return h("div", { class: "aur-segmented", role: "radiogroup" }, buttons);
	};

	const copyBtn = h("button", { class: "aur-btn aur-btn-primary", html: `${ICONS.copy()}<span>Copy image</span>`, onclick: () => copy() });
	const saveBtn = h("button", { class: "aur-btn", html: `${ICONS.download()}<span>Save PNG</span>`, onclick: () => save() });
	const card = h(
		"div",
		{ class: "aur-share-card", role: "dialog", "aria-label": "Share lyrics" },
		h("div", { class: "aur-share-preview" }, canvas),
		h(
			"div",
			{ class: "aur-share-side" },
			h(
				"div",
				{ class: "aur-share-head" },
				h("div", null, h("div", { class: "aur-panel-title" }, "Share lyrics"), h("div", { class: "aur-panel-sub" }, "Pick lines, then copy or save the image")),
				h("button", { class: "aur-icon-btn", title: "Close (Esc)", "aria-label": "Close", html: ICONS.close(), onclick: () => close() }),
			),
			h("div", { class: "aur-share-label" }, h("span", null, "Lines"), count),
			lineList,
			h("div", { class: "aur-share-label" }, h("span", null, "Format")),
			segmented(Object.entries(SHARE_FORMATS).map(([k, f]) => [k, f.label]), "format"),
			h("div", { class: "aur-share-label" }, h("span", null, "Background")),
			segmented(BACKGROUNDS, "bg"),
			h("div", { class: "aur-panel-actions" }, copyBtn, saveBtn),
		),
	);
	const el = h("div", { class: "aur-share", hidden: true, onclick: (e) => e.target === el && close() }, card);
	// Keep keys (Escape is handled by the overlay) and the wheel inside the sheet.
	el.addEventListener("keydown", (e) => e.key !== "Escape" && e.stopPropagation());
	el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

	function renderLines() {
		const ls = info.lyrics?.lines || [];
		lineList.replaceChildren(
			...ls.flatMap((l, i) =>
				l.gap || !l.text
					? []
					: [
							h(
								"button",
								{
									class: "aur-share-line",
									"aria-pressed": String(selected.has(i)),
									onclick: (e) => {
										if (selected.has(i)) selected.delete(i);
										else if (selected.size >= MAX_LINES) return ctx.toast(`Up to ${MAX_LINES} lines`);
										else selected.add(i);
										e.currentTarget.setAttribute("aria-pressed", String(selected.has(i)));
										render();
									},
								},
								l.text,
							),
						],
			),
		);
		lineList.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "center" });
	}

	async function render() {
		const token = ++renderToken;
		count.textContent = `${selected.size} / ${MAX_LINES}`;
		copyBtn.disabled = saveBtn.disabled = !selected.size;
		const ls = info.lyrics?.lines || [];
		const lines = [...selected].sort((a, b) => a - b).map((i) => ls[i]?.text).filter(Boolean);
		const cover = await loadImage(info.track?.image);
		if (token !== renderToken) return;
		// Make sure the lyric font is loaded before measuring with it.
		try {
			await document.fonts?.load?.(`${info.weight} 40px ${info.font}`, lines.join(" ") || "Aa");
		} catch {
			/* draw with whatever is available */
		}
		if (token !== renderToken) return;
		drawShareCard(canvas, { ...info.style, lines: lines.length ? lines : ["Pick a line to share"], title: info.track?.title, artist: info.track?.artist, cover, format: opts.format, bg: opts.bg });
		canvas.dataset.format = opts.format;
	}

	const toBlob = () => new Promise((resolve, reject) => {
		try {
			canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("empty image"))), "image/png");
		} catch (e) {
			reject(e); // tainted canvas
		}
	});

	async function copy() {
		try {
			const blob = await toBlob();
			await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
			ctx.toast("Image copied — paste it anywhere");
		} catch (e) {
			console.warn("[aurora-lyrics] copy image failed", e);
			ctx.toast("Couldn't copy the image here — try Save PNG");
		}
	}

	async function save() {
		const name = `${[info.track?.artist, info.track?.title].filter(Boolean).join(" - ") || "lyrics"}.png`.replace(/[\\/:*?"<>|]+/g, "");
		try {
			const blob = await toBlob();
			if (globalThis.showSaveFilePicker) {
				try {
					const handle = await globalThis.showSaveFilePicker({ suggestedName: name, types: [{ description: "PNG image", accept: { "image/png": [".png"] } }] });
					const w = await handle.createWritable();
					await w.write(blob);
					await w.close();
					return ctx.toast("Image saved");
				} catch (e) {
					if (e?.name === "AbortError") return; // user cancelled
				}
			}
			const url = URL.createObjectURL(blob);
			h("a", { href: url, download: name }).click();
			setTimeout(() => URL.revokeObjectURL(url), 10000);
			ctx.toast("Image saved to Downloads");
		} catch (e) {
			console.warn("[aurora-lyrics] save image failed", e);
			ctx.toast("Couldn't save the image");
		}
	}

	/** @param {number} [lineIdx] line to preselect (default: the current line and the next one) */
	function open(lineIdx) {
		const c = ctx.getContext();
		if (!c.lyrics?.lines?.some((l) => !l.gap && l.text)) return ctx.toast("No lyrics to share");
		const cs = getComputedStyle(c.root);
		const sample = c.root.querySelector(".aur-line .aur-main") || c.root;
		const ss = getComputedStyle(sample);
		info = {
			track: c.track,
			lyrics: c.lyrics,
			font: ss.fontFamily,
			weight: ss.fontWeight,
			style: {
				font: ss.fontFamily,
				weight: ss.fontWeight,
				uiFont: cs.fontFamily,
				accent: canvasColor(cs.getPropertyValue("--aur-accent").trim(), "#ffffff"),
				c1: canvasColor(cs.getPropertyValue("--aur-c1").trim(), "#4b3b78"),
				c2: canvasColor(cs.getPropertyValue("--aur-c2").trim(), "#14203a"),
			},
		};
		const ls = c.lyrics.lines;
		const firstReal = (from) => ls.findIndex((l, i) => i >= from && !l.gap && l.text);
		const start = firstReal(Math.max(0, lineIdx ?? c.active));
		selected = new Set();
		if (start >= 0) {
			selected.add(start);
			const second = lineIdx == null ? firstReal(start + 1) : -1;
			if (second >= 0) selected.add(second);
		}
		renderLines();
		el.hidden = false;
		void el.offsetWidth;
		el.classList.add("is-open");
		copyBtn.focus({ preventScroll: true });
		render();
	}

	function close() {
		if (el.hidden) return;
		el.classList.remove("is-open");
		setTimeout(() => !el.classList.contains("is-open") && (el.hidden = true), 250);
		ctx.onClose?.();
	}

	return { el, open, close, isOpen: () => !el.hidden && el.classList.contains("is-open") };
}

// ---- overlay.js ------------------------------------------------------------
// The overlay controller: builds the full-screen UI once (lazily), owns the playback loop,
// loads lyrics on track changes, and applies settings live.


const CLOSE_MS = 420; // must match the overlay fade-out transition in styles.css
const BG_SIZE = 256; // px; background art is drawn small and scaled up (cheap heavy blur)
const RELAYOUT_KEYS = new Set(["fontSize", "lineSpacing", "textAlign", "animation", "fontWeight", "font", "showContext", "view", "showBgVocals", "*"]);
const SOURCE_KEYS = new Set(["providers", "searchUntil"]);
const UP_NEXT_MS = 20000; // show the next track this long before the current one ends

function isTyping(target) {
	return !!target?.closest?.("input, textarea, select, [contenteditable='true']");
}

function fmtTime(ms) {
	const s = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function createOverlay({ onOpenChange, onLyrics } = {}) {
	const state = {
		open: false,
		track: null,
		lyrics: null,
		source: null,
		cached: false,
		stale: true, // track changed while closed → reload on open
		loadToken: 0,
		abort: null,
		raf: 0,
		timer: 0,
		idleTimer: 0,
		closeTimer: 0,
		hoverChrome: false,
		enteredFullscreen: false,
		lastFocus: null,
		bgUrl: null,
		artUrl: null,
		pinned: false,
		trToken: 0,
		trNotice: "",
		report: {}, // per-provider outcome of the last search
		playing: null,
		progressP: -1,
		progressSec: -1,
		scrubbing: false,
		scrubFrac: 0,
		clock: null,
		ps: {}, // last rendered shuffle / repeat / like / volume state
		psAt: 0,
		volDragging: false, // smoothed playback clock: { pos, at, uri }
	};

	let ui = null; // built lazily on first open
	const reducedQuery = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");

	// ---------------------------------------------------------------------------
	// DOM
	// ---------------------------------------------------------------------------
	function build() {
		const bgStack = h("div", { class: "aur-bg-stack" });
		const bg = h(
			"div",
			{ class: "aur-bg", "aria-hidden": "true" },
			bgStack,
			h("div", { class: "aur-bg-gradient" }),
			h("div", { class: "aur-bg-shade" }),
			h("div", { class: "aur-bg-grain" }),
		);

		const cover = h("img", { class: "aur-cover", alt: "" });
		const title = h("div", { class: "aur-title" });
		const artist = h("div", { class: "aur-artist" });
		const header = h("div", { class: "aur-header aur-chrome" }, cover, h("div", { class: "aur-meta" }, title, artist));

		const stage = h("div", { class: "aur-stage", role: "main" });

		// Split view: big cover (click = play/pause) + track info beside the lyrics.
		const artA = h("img", { class: "aur-art", alt: "", decoding: "async" });
		const artB = h("img", { class: "aur-art", alt: "", decoding: "async" });
		const artHint = h("span", { class: "aur-art-hint", html: ICONS.pause() });
		// .aur-disc holds the art (it spins in the Vinyl layout); grooves/shine only show there.
		const disc = h("span", { class: "aur-disc" }, artA, artB, h("span", { class: "aur-disc-grooves", "aria-hidden": "true" }));
		const artWrap = h(
			"button",
			{ class: "aur-art-wrap", title: "Play / pause", "aria-label": "Play / pause", onclick: () => (playerCommand("togglePlay"), setTimeout(kick, 60)) },
			disc,
			h("span", { class: "aur-disc-shine", "aria-hidden": "true" }),
			artHint,
		);
		const sideTitle = h("div", { class: "aur-side-title" });
		const sideArtist = h("div", { class: "aur-side-artist" });
		const sideAlbum = h("div", { class: "aur-side-album" });
		const side = h("div", { class: "aur-side", role: "region", "aria-label": "Now playing" }, artWrap, h("div", { class: "aur-side-meta" }, sideTitle, sideArtist, sideAlbum));

		const iconBtn = (label, icon, onclick, cls = "aur-icon-btn") => h("button", { class: cls, title: label, "aria-label": label, html: icon, onclick });

		// ---- Player (bottom centre): progress + transport. Lyrics info bottom-left, actions right.
		const elapsed = h("span", { class: "aur-time" }, "0:00");
		const remaining = h("span", { class: "aur-time is-right" }, "-0:00");
		const tip = h("span", { class: "aur-progress-tip", "aria-hidden": "true" }, "0:00");
		const bar = h(
			"div",
			{ class: "aur-progress", role: "slider", "aria-label": "Seek", tabindex: "0", "aria-valuemin": "0" },
			h("div", { class: "aur-progress-track" }, h("div", { class: "aur-progress-fill" })),
			h("div", { class: "aur-progress-knob-rail" }, h("div", { class: "aur-progress-knob" })),
			tip,
		);
		const scrub = h("div", { class: "aur-scrub" }, bar, h("div", { class: "aur-times" }, elapsed, remaining));

		const act = (fn) => () => (fn(), setTimeout(() => (state.psAt = 0), 120), setTimeout(kick, 60));
		// Play/pause: both icons live in the button and cross-fade/rotate (no icon swap flash).
		const playBtn = h(
			"button",
			{ class: "aur-play-btn", title: "Play / pause", "aria-label": "Play / pause", onclick: act(() => playerCommand("togglePlay")) },
			h("span", { class: "aur-pp is-play", html: ICONS.play() }),
			h("span", { class: "aur-pp is-pause", html: ICONS.pause() }),
		);
		const shuffleBtn = iconBtn("Shuffle", ICONS.shuffle(), act(() => playerCommand("toggleShuffle")), "aur-icon-btn aur-toggle");
		const repeatBtn = iconBtn("Repeat", ICONS.repeat(), act(() => playerCommand("toggleRepeat")), "aur-icon-btn aur-toggle");
		const transport = h(
			"div",
			{ class: "aur-transport" },
			shuffleBtn,
			iconBtn("Previous", ICONS.prev(), act(() => playerCommand("back")), "aur-icon-btn aur-skip"),
			playBtn,
			iconBtn("Next", ICONS.next(), act(() => playerCommand("next")), "aur-icon-btn aur-skip"),
			repeatBtn,
		);

		// Lyrics info: source chip (opens the source picker) + timing offset.
		const source = h("button", { class: "aur-source", title: "Lyrics source: choose, reload, import", onclick: () => panel.toggle("track") }, "—");
		const offsetOut = h("button", { class: "aur-offset", title: "Lyric offset (+ = earlier). Click to reset.", onclick: () => settings.set("offset", 0) });
		const trBtn = iconBtn("Translate lyrics (T)", ICONS.translate(), () => settings.set("translate", !settings.get("translate")), "aur-icon-btn aur-toggle aur-tr-btn");
		const offsetGroup = h(
			"div",
			{ class: "aur-offset-group", role: "group", "aria-label": "Lyric offset" },
			iconBtn("Lyrics later by 100 ms ( [ )", ICONS.minus(), () => nudgeOffset(-100), "aur-mini-btn"),
			offsetOut,
			iconBtn("Lyrics earlier by 100 ms ( ] )", ICONS.plus(), () => nudgeOffset(100), "aur-mini-btn"),
		);

		// Actions: like, volume, settings, fullscreen, close.
		const heartBtn = iconBtn("Save to Liked Songs", ICONS.heart(), act(() => playerCommand("toggleHeart")), "aur-icon-btn aur-heart");
		const muteBtn = iconBtn("Mute", ICONS.volHigh(), act(() => playerCommand("toggleMute")));
		const vol = h("input", { type: "range", class: "aur-vol", min: "0", max: "1", step: "0.01", "aria-label": "Volume" });
		vol.addEventListener("input", () => {
			state.volDragging = true;
			vol.style.setProperty("--v", vol.value);
			setVolume(Number(vol.value));
		});
		vol.addEventListener("change", () => ((state.volDragging = false), (state.psAt = 0)));
		const fsBtn = iconBtn("Fullscreen (F)", ICONS.fullscreen(), toggleFullscreen);

		const dock = h(
			"div",
			{ class: "aur-player aur-chrome", role: "toolbar", "aria-label": "Playback controls" },
			h("div", { class: "aur-player-side is-left" }, source, trBtn, offsetGroup),
			h("div", { class: "aur-player-center" }, scrub, transport),
			h(
				"div",
				{ class: "aur-player-side is-right" },
				heartBtn,
				h("div", { class: "aur-volume" }, muteBtn, vol),
				h("span", { class: "aur-sep", "aria-hidden": "true" }),
				iconBtn("Share lyrics as an image (S)", ICONS.share(), () => openShare()),
				iconBtn("Mini lyrics (Alt+M)", ICONS.mini(), () => (settings.set("miniLyrics", true), close())),
				iconBtn("Settings", ICONS.settings(), () => panel.toggle("settings")),
				fsBtn,
				iconBtn("Close (Esc)", ICONS.close(), close),
			),
		);
		// Hairline progress at the very bottom, visible only while the controls are hidden.
		const miniProgress = h("div", { class: "aur-mini-progress", "aria-hidden": "true" }, h("div", { class: "aur-mini-fill" }));
		for (const el of [dock, header]) {
			el.addEventListener("mouseenter", () => (state.hoverChrome = true));
			el.addEventListener("mouseleave", () => ((state.hoverChrome = false), wake()));
		}

		// Seek by click / drag on the progress bar, or arrow keys when focused.
		const fracAt = (e) => {
			const r = bar.getBoundingClientRect();
			return clamp((e.clientX - r.left) / r.width, 0, 1);
		};
		bar.addEventListener("pointerdown", (e) => {
			state.scrubbing = true;
			state.scrubFrac = fracAt(e);
			bar.setPointerCapture(e.pointerId);
			bar.classList.add("is-scrubbing");
			renderProgress();
		});
		bar.addEventListener("pointermove", (e) => {
			// Time preview under the pointer (hover and while dragging).
			const f = fracAt(e);
			bar.style.setProperty("--hx", f.toFixed(4));
			tip.textContent = fmtTime(f * getDuration());
			if (!state.scrubbing) return;
			state.scrubFrac = f;
			renderProgress();
		});
		const endScrub = () => {
			if (!state.scrubbing) return;
			state.scrubbing = false;
			bar.classList.remove("is-scrubbing");
			seek(state.scrubFrac * getDuration());
			state.clock = null; // snap the smoothed clock to the new position
			setTimeout(kick, 60);
		};
		bar.addEventListener("pointerup", endScrub);
		bar.addEventListener("pointercancel", endScrub);
		bar.addEventListener("keydown", (e) => {
			const step = e.key === "ArrowLeft" ? -5000 : e.key === "ArrowRight" ? 5000 : 0;
			if (!step) return;
			e.preventDefault();
			e.stopPropagation();
			seek(getPosition() + step);
			setTimeout(kick, 60);
		});

		const toastEl = h("div", { class: "aur-toast", role: "status", "aria-live": "polite" });

		// Queue peek: the next track, shown near the end of the current one. Click to skip to it.
		const upArt = h("img", { class: "aur-upnext-art", alt: "", decoding: "async" });
		const upTitle = h("div", { class: "aur-upnext-title" });
		const upArtist = h("div", { class: "aur-upnext-artist" });
		const upWhen = h("span", { class: "aur-upnext-when" });
		const upNext = h(
			"button",
			{ class: "aur-upnext", "aria-live": "polite", onclick: act(() => playerCommand("next")) },
			upArt,
			h("div", { class: "aur-upnext-text" }, h("div", { class: "aur-upnext-label" }, "Up next", upWhen), upTitle, upArtist),
			h("span", { class: "aur-upnext-skip", html: ICONS.next() }),
		);

		const panel = createPanel({
			getTrack: () => state.track,
			getLyricsInfo: () => ({
				source: state.source,
				pinned: state.pinned,
				report: state.report,
				sourceLabel: state.source ? SOURCE_LABELS[state.source] : "",
				lrc: state.lyrics ? toLRC(state.lyrics, { ti: state.track?.title, ar: state.track?.artist, al: state.track?.album }) : "",
				localText: state.track ? localLyrics.get(state.track)?.text || null : null,
			}),
			saveLocal: (text, fileName) => {
				if (!state.track) return toast("Nothing is playing");
				localLyrics.set(state.track, text, fileName);
				toast("Saved lyrics for this track");
				loadLyrics();
			},
			removeLocal: () => {
				if (!state.track) return;
				localLyrics.remove(state.track);
				toast("Removed imported lyrics");
				loadLyrics();
			},
			testSources: () => testSources(),
			chooseSource: async (id) => {
				if (!state.track) return;
				if (id === null) {
					lyricsCache.remove(state.track.uri); // drop any pin, search everything again
					return loadLyrics({ force: true });
				}
				return loadLyrics({ only: id });
			},
			clearCache: () => {
				const n = lyricsCache.size();
				lyricsCache.clear();
				return n;
			},
			toast,
		});

		const share = createShareSheet({
			getContext: () => ({ track: state.track, lyrics: state.lyrics, active: ui?.view.active ?? -1, root }),
			toast,
			onClose: () => root.focus({ preventScroll: true }),
		});

		const root = h(
			"div",
			{ id: "aur-root", class: "aur-root", role: "dialog", "aria-modal": "true", "aria-label": "Aurora Lyrics", tabindex: "-1", hidden: true },
			bg,
			h("div", { class: "aur-drag", "aria-hidden": "true" }), // keeps the window draggable
			header,
			side,
			stage,
			dock,
			miniProgress,
			panel.el,
			share.el,
			upNext,
			toastEl,
		);

		const view = new LyricsView(stage, {
			onShare: (i) => openShare(i),
			onSeek: (t) => {
				// Seek so that the *effective* (offset-adjusted) position lands on the line.
				seek(t - settings.get("offset") + 20);
				setTimeout(kick, 60);
			},
		});

		// Activity → show controls; idle → hide them (and the cursor).
		for (const ev of ["pointermove", "pointerdown", "wheel"]) root.addEventListener(ev, wake, { passive: true });

		// Geometry: lyrics re-centre on resize; background scale follows the window size.
		let roPending = false;
		new ResizeObserver(() => {
			if (roPending) return;
			roPending = true;
			nextFrame(() => {
				roPending = false;
				view.relayout();
				sizeBackground();
			});
		}).observe(root);
		document.fonts?.addEventListener?.("loadingdone", () => view.relayout());

		document.addEventListener("fullscreenchange", () => {
			const fs = !!document.fullscreenElement;
			root.dataset.fs = String(fs);
			fsBtn.innerHTML = fs ? ICONS.exitFullscreen() : ICONS.fullscreen();
			fsBtn.title = fs ? "Exit fullscreen (F)" : "Fullscreen (F)";
			if (!fs) state.enteredFullscreen = false;
		});

		document.body.append(root);
		ui = { trBtn, root, bgStack, cover, title, artist, artA, artB, artHint, sideTitle, sideArtist, sideAlbum, activeArt: artA, stage, dock, bar, miniProgress, elapsed, remaining, playBtn, shuffleBtn, repeatBtn, heartBtn, muteBtn, vol, source, offsetOut, fsBtn, toastEl, panel, share, view, upNext, upArt, upTitle, upArtist, upWhen };
		applySettings("*", null, settings.all());
	}

	// ---------------------------------------------------------------------------
	// Settings → CSS variables / data attributes
	// ---------------------------------------------------------------------------
	function reducedMotion(all) {
		if (all.reducedMotion === "on") return true;
		if (all.reducedMotion === "off") return false;
		return !!reducedQuery?.matches;
	}

	function applySettings(key, _v, all) {
		if (!ui) return;
		const { root, view } = ui;
		const st = root.style;
		ensureFont(all.font);
		st.setProperty("--aur-font", FONTS[all.font]?.stack || FONTS.spotify.stack);
		st.setProperty("--aur-fs", `${all.fontSize}px`);
		st.setProperty("--aur-gap", `${all.lineSpacing}em`);
		st.setProperty("--aur-fw", all.fontWeight);
		st.setProperty("--aur-shade", String(all.bgOpacity));
		if (all.accent === "album") st.removeProperty("--aur-user-accent");
		else st.setProperty("--aur-user-accent", all.accent);

		const layout = all.animation === "fade" || all.animation === "cinematic" ? "stack" : "list";
		const reduced = reducedMotion(all);
		Object.assign(root.dataset, {
			anim: all.animation,
			layout,
			align: all.textAlign,
			color: all.textColor,
			context: all.showContext ? "on" : "off",
			glow: all.glow,
			duet: all.duetColors ? "on" : "off",
			accent: all.accent === "album" ? "album" : "custom",
			depth: all.depthBlur ? "on" : "off",
			bg: all.bgStyle,
			bganim: all.bgAnimate && !reduced ? "on" : "off",
			words: all.wordSync ? "on" : "off",
			motion: reduced ? "reduced" : "full",
			transport: all.showTransport ? "on" : "off",
			info: all.showTrackInfo ? "on" : "off",
			pinned: all.pinControls ? "true" : "false",
			view: all.view,
			wordanim: all.wordAnim,
		});
		view.setOptions({ layout, wordSync: all.wordSync, autoScroll: all.unsyncedAutoScroll, reduced, wordAnim: all.wordAnim, showBg: all.showBgVocals });
		sizeBackground();

		ui.offsetOut.textContent = `${all.offset > 0 ? "+" : ""}${all.offset} ms`;
		ui.offsetOut.classList.toggle("is-zero", all.offset === 0);

		if (key === "view") {
			// Cross-fade into the new layout instead of jumping.
			root.classList.remove("aur-view-swap");
			void root.offsetWidth;
			root.classList.add("aur-view-swap");
			clearTimeout(state.viewSwapTimer);
			state.viewSwapTimer = setTimeout(() => root.classList.remove("aur-view-swap"), 900);
		}
		if (RELAYOUT_KEYS.has(key)) nextFrame(() => view.relayout());
		if (SOURCE_KEYS.has(key) && state.open) loadLyrics();
		if (key === "estimateWords" && state.lyrics) displayLyrics();
		ui.trBtn.classList.toggle("is-on", !!all.translate);
		if (key === "translate" || key === "translateTo") {
			state.trNotice = "";
			applyTranslation(true);
		}
		if (key === "offset") kick();
		wake();
	}

	settings.subscribe(applySettings);
	reducedQuery?.addEventListener?.("change", () => applySettings("reducedMotion", null, settings.all()));

	function nudgeOffset(delta) {
		const next = clamp(settings.get("offset") + delta, -5000, 5000);
		settings.set("offset", next);
		toast(next === 0 ? "Offset reset" : `Lyrics ${Math.abs(next)} ms ${next > 0 ? "earlier" : "later"}`);
	}

	// ---------------------------------------------------------------------------
	// Background: small album-art "blobs" scaled up to cover the window. Blurring a
	// 256px image and scaling it is far cheaper than blurring a full-window image,
	// which is what makes the slow rotation affordable.
	// ---------------------------------------------------------------------------
	function sizeBackground() {
		if (!ui) return;
		const { clientWidth: w, clientHeight: hgt } = ui.root;
		if (!w || !hgt) return;
		const scale = (Math.max(w, hgt) * 1.9) / BG_SIZE;
		ui.root.style.setProperty("--aur-bg-scale", scale.toFixed(3));
		ui.root.style.setProperty("--aur-bg-blur", `${(settings.get("blur") / scale).toFixed(2)}px`);
	}

	function updateBackground(track) {
		const url = track?.image;
		if (!url || url === state.bgUrl) return;
		state.bgUrl = url;
		const blobs = ["b1", "b2", "b3"].map((c) => h("img", { class: `aur-blob ${c}`, alt: "", src: url, width: BG_SIZE, height: BG_SIZE }));
		const layer = h("div", { class: "aur-bg-layer" }, blobs);
		ui.bgStack.append(layer);
		const reveal = () => {
			if (state.bgUrl !== url) return layer.remove();
			void layer.offsetWidth; // commit opacity:0 first so the fade-in transition runs
			layer.classList.add("is-on");
			const old = [...ui.bgStack.children].filter((l) => l !== layer);
			setTimeout(() => old.forEach((l) => l.remove()), 1800);
		};
		blobs[0].decode ? blobs[0].decode().then(reveal, reveal) : (blobs[0].onload = reveal);

		// Accent colours for the gradient background / tinted text (best effort).
		const extract = globalThis.Spicetify?.colorExtractor;
		if (typeof extract === "function" && track.uri) {
			Promise.resolve(extract(track.uri))
				.then((c) => {
					if (!c || state.track?.uri !== track.uri) return;
					const st = ui.root.style;
					// Album colours; styles.css swaps in the user's accent when one is chosen.
					st.setProperty("--aur-album-c1", c.VIBRANT || c.PROMINENT || "#4b3b78");
					st.setProperty("--aur-album-c2", c.DARK_VIBRANT || c.DESATURATED || "#14203a");
					st.setProperty("--aur-album-accent", c.LIGHT_VIBRANT || c.VIBRANT || c.PROMINENT || "#ffffff");
				})
				.catch(() => {});
		}
	}

	// ---------------------------------------------------------------------------
	// Chrome auto-hide + toast
	// ---------------------------------------------------------------------------
	function wake() {
		if (!ui) return;
		ui.root.dataset.idle = "false";
		clearTimeout(state.idleTimer);
		if (!settings.get("autoHideControls") || settings.get("pinControls")) return;
		state.idleTimer = setTimeout(() => {
			if (state.hoverChrome || state.scrubbing || ui.panel.isOpen()) return wake();
			ui.root.dataset.idle = "true";
		}, settings.get("autoHideDelay"));
	}

	let toastTimer = 0;
	function toast(msg, ms = 1800) {
		if (!ui) return;
		ui.toastEl.textContent = msg;
		ui.toastEl.classList.add("is-on");
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => ui.toastEl.classList.remove("is-on"), ms);
	}

	// ---------------------------------------------------------------------------
	// Track / lyrics loading
	// ---------------------------------------------------------------------------
	function updateTrackChrome(track) {
		ui.title.textContent = track?.title || "";
		// Artist and album names open their Spotify page (and close the overlay).
		const link = (text, uri) =>
			uri ? h("button", { class: "aur-link", title: `Go to ${text}`, onclick: (e) => (e.stopPropagation(), openUri(uri) && close()) }, text) : h("span", null, text);
		const artistNodes = () =>
			(track?.artistLinks?.length ? track.artistLinks : track?.artist ? [{ name: track.artist }] : []).flatMap((a, i) => (i ? [", ", link(a.name, a.uri)] : [link(a.name, a.uri)]));
		const albumNode = () => (track?.album ? link(track.album, track.albumUri) : null);
		ui.artist.replaceChildren(...artistNodes(), ...(track?.album ? [" • ", albumNode()] : []));
		if (track?.image) ui.cover.src = track.image;
		ui.cover.hidden = !track?.image;
		ui.sideTitle.textContent = track?.title || "";
		ui.sideArtist.replaceChildren(...artistNodes());
		ui.sideAlbum.replaceChildren(...(track?.album ? [albumNode()] : []));
		updateSideArt(track?.image);
		updateBackground(track);
	}

	/** Cross-fade the big cover in the split view. */
	function updateSideArt(url) {
		if (!url || url === state.artUrl) return;
		state.artUrl = url;
		const cur = ui.activeArt;
		const next = cur === ui.artA ? ui.artB : ui.artA;
		next.src = url;
		const reveal = () => {
			if (state.artUrl !== url) return;
			next.classList.add("is-on");
			cur.classList.remove("is-on");
			ui.activeArt = next;
		};
		next.decode ? next.decode().then(reveal, reveal) : (next.onload = reveal);
	}

	function setSourceBadge() {
		const l = state.lyrics;
		const label = SOURCE_LABELS[state.source] || state.source;
		ui.panel.setNowPlaying(state.track, l ? label : "");
		if (!l) {
			ui.source.textContent = "No lyrics";
			ui.source.dataset.kind = "none";
			ui.source.title = "No lyrics loaded";
			return;
		}
		const estimated = !l.hasWords && l.synced && settings.get("estimateWords");
		const kind = l.synced ? (l.hasWords ? "Word sync" : estimated ? "Synced · est. words" : "Synced") : "Plain text";
		ui.source.textContent = `${label} · ${kind}`;
		ui.source.dataset.kind = l.synced ? (l.hasWords ? "word-synced" : "synced") : "unsynced";
		ui.source.title = `Lyrics from ${label}${state.pinned ? " (chosen for this track)" : ""}${state.cached ? " (cached)" : ""}`;
	}

	/** Render state.lyrics, adding estimated word timing if that option is on. */
	function displayLyrics() {
		if (!state.lyrics) return;
		ui.view.setLyrics(settings.get("estimateWords") ? estimateWords(state.lyrics) : state.lyrics);
		setSourceBadge();
		onLyrics?.(state.track?.uri, state.lyrics, state.source); // keep the Now Playing card in step
		applyTranslation();
	}

	/**
	 * Load lyrics for the current track.
	 * @param {{ force?: boolean, only?: string|null }} opts
	 *   force: skip the cache. only: fetch from one provider and pin it to this track
	 *   (the current lyrics stay on screen until that result arrives).
	 */
	async function loadLyrics({ force = false, only = null } = {}) {
		if (!ui) return;
		state.abort?.abort();
		const ctrl = new AbortController();
		state.abort = ctrl;
		const token = ++state.loadToken;
		state.stale = false;

		const track = getCurrentTrack();
		state.track = track;
		if (!only) {
			state.lyrics = null;
			state.source = null;
			state.cached = false;
			state.pinned = false;
			ui.view.freeze(); // don't let the old lyrics chase the new track's position
		}
		updateTrackChrome(track);
		ui.panel.onTrackChange();
		setSourceBadge();

		const image = track?.image;
		if (!track) return ui.view.setMessage("empty", "Nothing is playing", "Start a song to see its lyrics.", { icon: ICONS.note() });
		if (!track.isTrack) return ui.view.setMessage("empty", "No lyrics here", "Podcasts, audiobooks and ads don't have lyrics.", { image });

		// Only show the loading screen if the lookup takes a moment (cache hits are instant).
		let status = "";
		const spinner = only
			? 0
			: setTimeout(() => {
					if (token === state.loadToken && !state.lyrics) ui.view.setMessage("loading", track.title, status || "Looking for lyrics…", { image });
				}, 180);

		const show = (lyrics, source, extra = {}) => {
			state.lyrics = lyrics;
			state.source = source;
			state.cached = !!extra.cached;
			state.pinned = !!extra.pinned;
			displayLyrics();
		};

		let res;
		let interim = null;
		try {
			res = await resolveLyrics(track, settings.all(), {
				force,
				only,
				signal: ctrl.signal,
				onStatus: (msg) => {
					status = msg;
					if (token === state.loadToken) ui.view.setStatus(msg);
				},
				// Show a good-enough result right away while better (word-synced) sources are tried.
				onUpdate: (r) => {
					if (token !== state.loadToken || only) return;
					clearTimeout(spinner);
					interim = r.lyrics;
					show(r.lyrics, r.source);
				},
			});
		} catch (e) {
			if (ctrl.signal.aborted) return;
			res = { lyrics: null, error: String(e?.message || e) };
		} finally {
			clearTimeout(spinner);
		}
		if (token !== state.loadToken) return; // a newer load started meanwhile

		if (res.report) state.report = only ? { ...state.report, ...res.report } : res.report;
		const label = SOURCE_LABELS[res.source] || res.source;
		if (res.lyrics) {
			if (state.lyrics !== res.lyrics) show(res.lyrics, res.source, res);
			else {
				state.cached = !!res.cached;
				setSourceBadge();
			}
			if (only) toast(`Using ${label} for this track`);
			else if (interim && interim !== res.lyrics && lyricsQuality(res.lyrics) === 3) toast(`Upgraded to word sync from ${label}`);
			else if (force) toast(`Reloaded from ${label}`);
			maybeShowTip();
		} else if (only) {
			toast(res.error || `${SOURCE_LABELS[only]} has no lyrics for this track`, 2600);
		} else if (res.instrumental) {
			ui.view.setMessage("empty", "Instrumental", "No lyrics — just enjoy the music.", { image });
		} else if (res.error) {
			ui.view.setMessage("error", "Couldn't load lyrics", res.error, { image, action: { label: "Try again", onClick: () => loadLyrics({ force: true }) } });
		} else {
			ui.view.setMessage("empty", "No lyrics found for this track.", "Try another source, or paste / import your own.", { image, action: { label: "Choose source", onClick: () => ui.panel.open("track") } });
		}
		setSourceBadge();
		kick();
	}

	/**
	 * Ask every source for the current track (ignoring on/off switches, cache and pins) and
	 * record what each returned. Shown in the ✎ panel; also exposed as AuroraLyrics.testSources().
	 */
	async function testSources() {
		const track = getCurrentTrack();
		if (!track) return {};
		const report = {};
		for (const { id } of PROVIDER_INFO) {
			const t0 = performance.now();
			let r;
			try {
				r = await resolveLyrics(track, settings.all(), { only: id, probe: true });
			} catch (e) {
				r = { report: { [id]: { status: "error", message: String(e?.message || e) } } };
			}
			report[id] = { ...(r.report?.[id] || { status: r.error ? "error" : "notfound", message: r.error }), ms: Math.round(performance.now() - t0) };
		}
		state.report = report;
		ui?.panel.onTrackChange();
		console.table(Object.fromEntries(Object.entries(report).map(([id, r]) => [id, { status: r.status, quality: ["none", "plain", "line", "word"][r.quality || 0], ms: r.ms, message: r.message || "" }])));
		return report;
	}

	/** Fetch (or drop) translations for the current lyrics. `announce` = user just toggled it. */
	async function applyTranslation(announce = false) {
		const token = ++state.trToken;
		if (!ui) return;
		if (!settings.get("translate") || !state.lyrics) {
			ui.view.setTranslations(null);
			return;
		}
		const lyrics = state.lyrics;
		const target = resolveTarget(settings.get("translateTo"));
		if (announce) toast("Translating…", 1200);
		try {
			const res = await translateLyrics(lyrics, target);
			if (token !== state.trToken || lyrics !== state.lyrics) return;
			if (res.sameLanguage) {
				ui.view.setTranslations(null);
				const note = `Lyrics are already in ${new Intl.DisplayNames([target], { type: "language" }).of(target) || target}`;
				if (announce || state.trNotice !== note) toast(note, 2400);
				state.trNotice = note;
				return;
			}
			ui.view.setTranslations(res.lines);
		} catch (e) {
			if (token !== state.trToken) return;
			ui.view.setTranslations(null);
			toast(String(e?.message || e), 3000);
		}
	}

	function maybeShowTip() {
		if (settings.get("seenTip")) return;
		settings.set("seenTip", true);
		setTimeout(() => toast("Tip: scroll to browse · click a line to jump · [ ] to fix timing", 4500), 1200);
	}

	// ---------------------------------------------------------------------------
	// Playback loop: rAF while playing (with a timer fallback), a slow timer when paused.
	// ---------------------------------------------------------------------------
	function renderProgress() {
		const dur = getDuration();
		const pos = state.scrubbing ? state.scrubFrac * dur : getPosition();
		const p = dur ? clamp(pos / dur, 0, 1) : 0;
		if (Math.abs(p - state.progressP) > 0.0004) {
			state.progressP = p;
			ui.bar.style.setProperty("--p", p.toFixed(5));
			ui.miniProgress.style.setProperty("--p", p.toFixed(5));
			ui.bar.setAttribute("aria-valuenow", String(Math.round(pos / 1000)));
		}
		const sec = Math.floor(pos / 1000);
		if (sec !== state.progressSec) {
			state.progressSec = sec;
			ui.elapsed.textContent = fmtTime(pos);
			ui.remaining.textContent = `-${fmtTime(dur - pos)}`;
			ui.bar.setAttribute("aria-valuemax", String(Math.round(dur / 1000)));
			updateUpNext(pos, dur);
		}
		const playing = isPlaying();
		if (playing !== state.playing) {
			state.playing = playing;
			ui.artHint.innerHTML = playing ? ICONS.pause() : ICONS.play();
			ui.playBtn.title = playing ? "Pause" : "Play";
			ui.root.dataset.playing = String(playing); // CSS cross-fades the play/pause icons
		}
		// Shuffle / repeat / like / volume change rarely: poll a few times a second.
		const now = performance.now();
		if (now - state.psAt > 300) {
			state.psAt = now;
			renderPlayerState(playerState());
		}
	}

	/** Show / fill / hide the "Up next" card (called once per second of playback). */
	function updateUpNext(pos, dur) {
		const left = dur - pos;
		const next =
			settings.get("queuePeek") && dur > 45000 && left <= UP_NEXT_MS && left > 700 && state.ps.repeat !== 2 && !state.scrubbing ? getNextTrack() : null;
		const card = ui.upNext;
		if (!next || next.uri === state.track?.uri) {
			card.classList.remove("is-on");
			return;
		}
		if (card.dataset.uri !== next.uri) {
			card.dataset.uri = next.uri;
			ui.upTitle.textContent = next.title;
			ui.upArtist.textContent = next.artist;
			ui.upArt.hidden = !next.image;
			if (next.image) ui.upArt.src = next.image;
			card.title = `Play “${next.title}” now`;
		}
		ui.upWhen.textContent = ` · in ${Math.max(1, Math.ceil(left / 1000))}s`;
		card.classList.add("is-on");
	}

	function renderPlayerState(ps) {
		const prev = state.ps;
		if (ps.shuffle !== prev.shuffle) {
			ui.shuffleBtn.classList.toggle("is-on", ps.shuffle);
			ui.shuffleBtn.title = ps.shuffle ? "Shuffle: on" : "Shuffle: off";
		}
		if (ps.repeat !== prev.repeat) {
			ui.repeatBtn.innerHTML = ps.repeat === 2 ? ICONS.repeatOne() : ICONS.repeat();
			ui.repeatBtn.classList.toggle("is-on", ps.repeat > 0);
			ui.repeatBtn.title = ["Repeat: off", "Repeat: all", "Repeat: one"][ps.repeat] || "Repeat";
		}
		if (ps.heart !== prev.heart) {
			ui.heartBtn.innerHTML = ps.heart ? ICONS.heartFill() : ICONS.heart();
			ui.heartBtn.classList.toggle("is-on", ps.heart);
			ui.heartBtn.title = ps.heart ? "Remove from Liked Songs" : "Save to Liked Songs";
		}
		const level = ps.mute ? 0 : ps.volume;
		if (level !== (prev.mute ? 0 : prev.volume)) {
			ui.muteBtn.innerHTML = level === 0 ? ICONS.volMute() : level < 0.5 ? ICONS.volLow() : ICONS.volHigh();
			ui.muteBtn.title = ps.mute ? "Unmute" : "Mute";
			if (!state.volDragging) {
				ui.vol.value = String(level);
				ui.vol.style.setProperty("--v", String(level));
			}
		}
		state.ps = ps;
	}

	/**
	 * Playback position for rendering, smoothed. Spotify's reported position is re-synced
	 * about once a second and can jump by tens of ms, which makes word sweeps stutter.
	 * This clock advances on its own (performance.now) and glides onto the reported
	 * position; it only snaps on real jumps (seek, track change, pause/resume).
	 */
	function smoothPosition() {
		const raw = getPosition();
		const now = performance.now();
		const uri = state.track?.uri;
		const c = state.clock;
		if (!isPlaying() || !c || c.uri !== uri) {
			state.clock = { pos: raw, at: now, uri };
			return raw;
		}
		const predicted = c.pos + (now - c.at);
		const drift = raw - predicted;
		// Big difference = a real jump: snap. Otherwise correct ~10% of the drift per frame
		// (at 60 fps that closes a 50 ms error in well under half a second, invisibly).
		const pos = Math.abs(drift) > 350 ? raw : predicted + drift * Math.min(1, (now - c.at) / 160);
		state.clock = { pos, at: now, uri };
		return pos;
	}

	function tick() {
		// Whichever of rAF / fallback timer fired first, cancel the other.
		if (state.raf) cancelAnimationFrame(state.raf);
		clearTimeout(state.timer);
		state.raf = 0;
		state.timer = 0;
		if (!state.open) return;
		ui.view.update(smoothPosition() + settings.get("offset"), state.track?.duration || getDuration());
		renderProgress();
		schedule();
	}

	function schedule() {
		if (!state.open || state.raf || state.timer) return;
		if (document.hidden) state.timer = setTimeout(tick, 500);
		else if (isPlaying()) {
			state.raf = requestAnimationFrame(tick);
			// Occluded windows can throttle rAF to ~1-2 fps without setting document.hidden;
			// this keeps line changes on time (the timer is cancelled when rAF wins).
			state.timer = setTimeout(tick, 200);
		} else state.timer = setTimeout(tick, 250);
	}

	function kick() {
		tick(); // tick() cancels pending frames/timers and does nothing when closed
	}

	// ---------------------------------------------------------------------------
	// Open / close / fullscreen / keyboard
	// ---------------------------------------------------------------------------
	function open() {
		if (state.open) return;
		if (!ui) build();
		clearTimeout(state.closeTimer);
		state.open = true;
		state.lastFocus = document.activeElement;
		ui.root.hidden = false;
		sizeBackground();
		void ui.root.offsetHeight; // flush so the fade-in transition runs
		ui.root.classList.add("is-open");
		ui.root.focus({ preventScroll: true });
		wake();
		if (state.stale || state.track?.uri !== getCurrentTrack()?.uri) loadLyrics();
		else {
			ui.view.relayout();
			ui.view.playEnter();
		}
		kick();
		onOpenChange?.(true);
	}

	function close() {
		if (!state.open) return;
		state.open = false;
		ui.panel.close();
		ui.share.close();
		ui.view.stopBrowsing(true);
		ui.root.classList.remove("is-open");
		if (state.enteredFullscreen && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
		state.closeTimer = setTimeout(() => (ui.root.hidden = true), CLOSE_MS);
		kick(); // cancels pending frames because state.open is false
		state.lastFocus?.focus?.({ preventScroll: true });
		onOpenChange?.(false);
	}

	/** Share sheet; `lineIdx` preselects that line (right-click on a line). */
	function openShare(lineIdx) {
		if (!ui) return;
		ui.panel.close();
		ui.share.open(lineIdx);
	}

	async function toggleFullscreen() {
		try {
			if (document.fullscreenElement) await document.exitFullscreen();
			else {
				await document.documentElement.requestFullscreen();
				state.enteredFullscreen = true;
			}
		} catch (e) {
			toast("Fullscreen isn't available here");
			console.warn("[aurora-lyrics] fullscreen failed", e);
		}
	}

	// Capture phase so Escape is ours while the overlay is open.
	window.addEventListener(
		"keydown",
		(e) => {
			// Global toggle: Alt+L (by physical key, so it works on any keyboard layout).
			if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyL") {
				e.preventDefault();
				e.stopPropagation();
				state.open ? close() : open();
				return;
			}
			if (!state.open) return;
			wake();
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				if (ui.share.isOpen()) ui.share.close();
				else if (ui.panel.isOpen()) ui.panel.close();
				else if (ui.view.browsing) ui.view.stopBrowsing();
				else close();
				return;
			}
			if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || ui.share.isOpen()) return;
			if (e.key === "[") nudgeOffset(-100);
			else if (e.key === "]") nudgeOffset(100);
			else if (e.key === "f" || e.key === "F") toggleFullscreen();
			else if (e.key === "t" || e.key === "T") settings.set("translate", !settings.get("translate"));
			else if (e.key === "s" || e.key === "S") openShare();
			else return;
			e.preventDefault();
			e.stopPropagation();
		},
		true,
	);

	// ---------------------------------------------------------------------------
	// Player events (wired by main.js)
	// ---------------------------------------------------------------------------
	return {
		open,
		close,
		toggle: () => (state.open ? close() : open()),
		isOpen: () => state.open,
		onSongChange() {
			if (state.open) loadLyrics();
			else state.stale = true;
		},
		onPlayPause: kick,
		testSources,
		onProgress() {
			// ~1/s while playing and on seeks. Cheap, and makes seeks show up immediately
			// even if animation frames are being throttled.
			if (state.open) kick();
		},
	};
}

// ---- npv.js ----------------------------------------------------------------
// Our own lyrics card in Spotify's right-hand "Now Playing" panel, replacing Spotify's
// "Lyrics preview" card: synced + auto-scrolling, word fill, click a line to jump,
// click the card (or ⤢) to open the fullscreen view.
//
// Spotify's card is found by its stable test id; we hide it and put ours in its slot.
// When Spotify shows no card (no lyrics on Spotify), ours goes right after the track info.
// React re-renders the panel freely, so a (debounced) MutationObserver keeps us attached.


const SPOTIFY_CARD = '[data-testid="lyrics-npv-section"]';
const NPV_ANCHOR = ".main-nowPlayingView-nowPlayingWidget";
const ANCHOR_Y = 0.34; // active line position within the card body
const LEAD_MS = 40;

function createNowPlayingCard({ openOverlay, isOverlayOpen, onState, toggleMini }) {
	const state = { uri: null, lyrics: null, source: null, token: 0, active: -2, wordIdx: -1, raf: 0, timer: 0, visible: false };
	let lineEls = [];
	let wordData = []; // per line: { words, spans } | null

	// ---- DOM
	const src = h("span", { class: "aur-npv-src" });
	const openBtn = h("button", {
		class: "aur-npv-open",
		title: "Open fullscreen lyrics (Alt+L)",
		"aria-label": "Open fullscreen lyrics",
		html: ICONS.fullscreen(),
		onclick: (e) => (e.stopPropagation(), openOverlay()),
	});
	const lines = h("div", { class: "aur-npv-lines" });
	const msg = h("div", { class: "aur-npv-msg" });
	const body = h("div", { class: "aur-npv-body", title: "Open fullscreen lyrics", onclick: () => openOverlay() }, lines, msg);
	const miniBtn = h("button", {
		class: "aur-npv-open",
		title: "Mini lyrics (Alt+M)",
		"aria-label": "Mini lyrics",
		html: ICONS.mini(),
		onclick: (e) => (e.stopPropagation(), toggleMini?.()),
	});
	const card = h("div", { class: "aur-npv", "data-aur-npv": "" }, h("div", { class: "aur-npv-head" }, h("h2", { class: "aur-npv-title" }, "Lyrics"), src, miniBtn, openBtn), body);

	// ---- mounting
	function unhideSpotify() {
		for (const el of document.querySelectorAll("[data-aur-hidden]")) el.removeAttribute("data-aur-hidden");
	}
	function mount() {
		if (!settings.get("npvCard")) {
			card.remove();
			unhideSpotify();
			return;
		}
		const spotifyCard = document.querySelector(SPOTIFY_CARD);
		if (spotifyCard) {
			if (!spotifyCard.hasAttribute("data-aur-hidden")) spotifyCard.setAttribute("data-aur-hidden", "");
			if (spotifyCard.previousElementSibling !== card) spotifyCard.before(card);
		} else {
			const anchor = document.querySelector(NPV_ANCHOR);
			if (!anchor) return; // Now Playing panel closed
			if (anchor.nextElementSibling !== card) anchor.after(card);
		}
		if (state.uri !== getCurrentTrack()?.uri) load();
	}
	// Throttle, not debounce: Spotify's DOM changes constantly (progress times, animations), so a
	// debounce that restarts on every mutation could starve forever. Check at most every 250 ms.
	let mountTimer = 0;
	new MutationObserver(() => {
		if (mountTimer) return;
		mountTimer = setTimeout(() => {
			mountTimer = 0;
			mount();
		}, 250);
	}).observe(document.body, { childList: true, subtree: true });

	// Only animate while the card is actually on screen.
	new IntersectionObserver((entries) => {
		state.visible = entries.some((e) => e.isIntersecting);
		kick();
	}).observe(card);

	settings.subscribe((key) => {
		if (key === "npvCard" || key === "*") mount();
		if (["providers", "searchUntil", "estimateWords", "*"].includes(key)) load();
		else if (key === "translate" || key === "translateTo") translateCard();
		if (key === "duetColors" || key === "*") card.dataset.duet = settings.get("duetColors") ? "on" : "off";
	});

	// ---- lyrics
	function setMessage(text) {
		msg.textContent = text;
		lines.replaceChildren();
		lineEls = [];
		wordData = [];
		state.active = -2;
		card.classList.remove("is-unsynced");
		onState?.(state.uri, null, text);
	}

	async function load() {
		const token = ++state.token;
		const track = getCurrentTrack();
		state.uri = track?.uri || null;
		state.lyrics = null;
		src.textContent = "";
		tint(track);
		if (!track) return setMessage("Nothing is playing");
		if (!track.isTrack) return setMessage("No lyrics for this content");
		setMessage("Loading lyrics…");
		let res;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				res = await resolveLyrics(track, settings.all());
				break;
			} catch {
				// Shared lookup was cancelled (e.g. the overlay switched tracks): try once more.
				await new Promise((r) => setTimeout(r, 300));
			}
		}
		if (token !== state.token) return;
		if (res?.lyrics) show(res.lyrics, res.source);
		else setMessage(res?.instrumental ? "Instrumental — enjoy the music ♪" : "No lyrics found for this song");
	}

	/** Lyrics pushed from the overlay (imports, source picks, upgrades) for the same song. */
	function useLyrics(uri, lyrics, source) {
		if (!lyrics || uri !== state.uri) return;
		state.token++; // supersede any lookup still running here
		show(lyrics, source);
	}

	function tint(track) {
		const extract = globalThis.Spicetify?.colorExtractor;
		if (!track?.uri || typeof extract !== "function") return;
		Promise.resolve(extract(track.uri))
			.then((c) => {
				if (c && state.uri === track.uri) card.style.setProperty("--npv-c", c.DARK_VIBRANT || c.VIBRANT || c.PROMINENT || "#3a3a46");
			})
			.catch(() => {});
	}

	function show(lyrics, source) {
		const l = settings.get("estimateWords") ? estimateWords(lyrics) : lyrics;
		state.lyrics = l;
		state.source = source;
		state.active = -2;
		state.wordIdx = -1;
		msg.textContent = "";
		const kind = l.synced ? (l.hasWords ? "word sync" : "synced") : "plain";
		src.textContent = `${SOURCE_LABELS[source] || source} · ${kind}`;
		card.classList.toggle("is-unsynced", !l.synced);
		card.dataset.duet = settings.get("duetColors") ? "on" : "off";

		const frag = document.createDocumentFragment();
		lineEls = [];
		wordData = [];
		for (const line of l.lines) {
			let el;
			let wd = null;
			if (line.gap) {
				el = h("div", { class: "aur-npv-line is-gap" }, "• • •");
			} else if (line.words && l.synced) {
				el = h("div", { class: "aur-npv-line" });
				const spans = line.words.map((w) => {
					const m = w.text.match(/^(\s*)([\s\S]*?)(\s*)$/);
					if (m[1]) el.append(m[1]);
					const span = h("span", { class: "aur-npv-w" }, m[2]);
					el.append(span);
					if (m[3]) el.append(m[3]);
					return span;
				});
				wd = { words: line.words, spans };
			} else {
				el = h("div", { class: "aur-npv-line" }, line.text);
			}
			if (l.synced && line.time != null && !line.gap) {
				el.addEventListener("click", (e) => {
					e.stopPropagation();
					seek(line.time - settings.get("offset") + 20);
					setTimeout(kick, 60);
				});
				el.title = "Jump here";
			}
			const singer = line.gap ? null : (line.singer ?? (line.opposite ? 1 : null));
			if (singer) el.dataset.singer = String(singer);
			lineEls.push(el);
			wordData.push(wd);
			frag.append(el);
		}
		lines.replaceChildren(frag);
		lines.style.transform = "";
		onState?.(state.uri, l);
		translateCard();
		kick();
	}

	async function translateCard() {
		for (const el of lines.querySelectorAll(".aur-npv-tr")) el.remove();
		const l = state.lyrics;
		if (!l || !settings.get("translate")) return;
		try {
			const res = await translateLyrics(l, resolveTarget(settings.get("translateTo")));
			if (state.lyrics !== l || res.sameLanguage) return;
			res.lines.forEach((t, i) => t && lineEls[i]?.append(h("div", { class: "aur-npv-tr" }, t)));
			state.active = -2; // re-measure scroll position with the taller lines
			kick();
		} catch {
			/* the fullscreen view reports translation errors */
		}
	}

	// ---- playback sync (only while visible and the fullscreen view is closed)
	function tick() {
		cancelAnimationFrame(state.raf);
		clearTimeout(state.timer);
		state.raf = state.timer = 0;
		if (!state.visible || !card.isConnected || isOverlayOpen() || !state.lyrics?.synced) return;
		const pos = getPosition() + settings.get("offset");
		const ls = state.lyrics.lines;
		const idx = findLineIndex(ls, pos);
		if (idx !== state.active) activate(idx);
		const wd = idx >= 0 ? wordData[idx] : null;
		if (wd) updateWords(wd, pos + LEAD_MS);
		if (isPlaying()) {
			state.raf = requestAnimationFrame(tick);
			state.timer = setTimeout(tick, 200); // rAF stalls in occluded windows
		} else state.timer = setTimeout(tick, 300);
	}
	function kick() {
		tick();
	}

	function activate(idx) {
		const prev = state.active;
		if (prev >= 0 && lineEls[prev]) {
			lineEls[prev].classList.remove("is-active");
			const wd = wordData[prev];
			if (wd) for (const s of wd.spans) s.classList.remove("sung", "now"), s.style.removeProperty("--aur-wp");
		}
		lineEls.forEach((el, i) => el.classList.toggle("is-past", i < idx));
		state.active = idx;
		state.wordIdx = -1;
		const focus = lineEls[Math.max(idx, 0)];
		if (idx >= 0) focus.classList.add("is-active");
		if (!focus) return;
		const y = body.clientHeight * ANCHOR_Y - (focus.offsetTop + focus.offsetHeight / 2);
		const jump = prev < -1 || Math.abs(idx - prev) > 8;
		if (jump) lines.classList.add("no-anim");
		lines.style.transform = `translateY(${Math.round(Math.min(0, y))}px)`;
		if (jump) requestAnimationFrame(() => lines.classList.remove("no-anim"));
	}

	function updateWords({ words, spans }, pos) {
		const k = findLineIndex(words, pos);
		if (k !== state.wordIdx) {
			spans.forEach((s, i) => {
				s.classList.toggle("sung", i < k);
				s.classList.toggle("now", i === k);
				if (i !== k) s.style.removeProperty("--aur-wp");
			});
			state.wordIdx = k;
		}
		if (k >= 0 && k < spans.length) {
			const w = words[k];
			const p = w.end > w.time ? Math.min(1, Math.max(0, (pos - w.time) / (w.end - w.time))) : 1;
			spans[k].style.setProperty("--aur-wp", p.toFixed(3));
		}
	}

	mount();
	if (state.uri !== getCurrentTrack()?.uri) load(); // also feeds mini lyrics when the card is off
	return {
		onSongChange: () => load(),
		onPlayPause: kick,
		onProgress: () => !isPlaying() && kick(),
		onOverlayClosed: kick,
		useLyrics,
	};
}

// ---- mini.js ---------------------------------------------------------------
// Mini lyrics: a small floating pill with the current line (word fill) and the next one, shown
// over Spotify while the fullscreen view is closed. Drag it anywhere (position is remembered),
// click the text to open the fullscreen view. Where the browser supports Document
// Picture-in-Picture it can also pop out into an always-on-top window of its own.
//
// Lyrics come from the Now Playing card's lookup (see npv.js → main.js), so there is no
// second search for the same song.


const MINI_LEAD_MS = 40; // highlight words slightly early, as in the other views
const PIP_SIZE = { width: 480, height: 150 };
const MINI_UP_NEXT_MS = 20000; // same window as the overlay's "Up next" card

function createMiniLyrics({ openOverlay, isOverlayOpen }) {
	const state = { upAt: 0, lyrics: null, message: "", uri: null, active: -2, wordIdx: -1, raf: 0, rafWin: null, timer: 0, pip: null, words: null };

	// ---- DOM
	const art = h("img", { class: "aur-float-art", alt: "", decoding: "async" });
	const cur = h("div", { class: "aur-float-cur" });
	const next = h("div", { class: "aur-float-next" });
	const text = h("div", { class: "aur-float-text", title: "Open fullscreen lyrics", onclick: () => openOverlay() }, cur, next);
	const btn = (label, icon, onclick, cls = "") => h("button", { class: `aur-float-btn ${cls}`, title: label, "aria-label": label, html: icon, onclick: (e) => (e.stopPropagation(), onclick()) });
	const pipBtn = btn("Pop out (always on top)", ICONS.popOut(), () => popOut(), "is-pip-btn");
	pipBtn.hidden = !("documentPictureInPicture" in globalThis);
	const actions = h(
		"div",
		{ class: "aur-float-actions" },
		pipBtn,
		btn("Open fullscreen lyrics (Alt+L)", ICONS.fullscreen(), () => openOverlay()),
		btn("Close mini lyrics (Alt+M)", ICONS.close(), () => (state.pip ? state.pip.close() : settings.set("miniLyrics", false))),
	);
	const el = h("div", { class: "aur-float", role: "region", "aria-label": "Mini lyrics", hidden: true }, art, text, actions);
	document.body.append(el);

	// ---- position + dragging (the pill, not the buttons; a short drag still counts as a click)
	function place() {
		if (state.pip) return;
		const pos = settings.get("miniPos");
		const w = el.offsetWidth || 420;
		const hgt = el.offsetHeight || 64;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		// Default: centred just above Spotify's player bar.
		const x = pos ? pos.x * vw : vw / 2;
		const y = pos ? pos.y * vh : vh - 96 - hgt / 2;
		el.style.left = `${Math.round(clamp(x - w / 2, 8, Math.max(8, vw - w - 8)))}px`;
		el.style.top = `${Math.round(clamp(y - hgt / 2, 8, Math.max(8, vh - hgt - 8)))}px`;
	}
	let drag = null;
	el.addEventListener("pointerdown", (e) => {
		if (state.pip || e.button !== 0 || e.target.closest(".aur-float-btn")) return;
		const r = el.getBoundingClientRect();
		drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY, moved: false, id: e.pointerId };
	});
	el.addEventListener("pointermove", (e) => {
		if (!drag || e.pointerId !== drag.id) return;
		if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 5) return;
		if (!drag.moved) {
			drag.moved = true;
			el.setPointerCapture(e.pointerId);
			el.classList.add("is-dragging");
		}
		el.style.left = `${Math.round(clamp(e.clientX - drag.dx, 8, window.innerWidth - el.offsetWidth - 8))}px`;
		el.style.top = `${Math.round(clamp(e.clientY - drag.dy, 8, window.innerHeight - el.offsetHeight - 8))}px`;
	});
	const endDrag = (e) => {
		if (!drag || e.pointerId !== drag.id) return;
		const moved = drag.moved;
		drag = null;
		if (!moved) return;
		el.classList.remove("is-dragging");
		const r = el.getBoundingClientRect();
		settings.set("miniPos", { x: (r.left + r.width / 2) / window.innerWidth, y: (r.top + r.height / 2) / window.innerHeight });
		// Swallow the click that ends a drag, so dropping on the text doesn't open fullscreen.
		el.addEventListener("click", (ev) => ev.stopPropagation(), { capture: true, once: true });
	};
	el.addEventListener("pointerup", endDrag);
	el.addEventListener("pointercancel", endDrag);
	window.addEventListener("resize", () => place());

	// ---- visibility
	function shouldShow() {
		return !!state.pip || (settings.get("miniLyrics") && !isOverlayOpen());
	}
	function refresh() {
		const show = shouldShow();
		if (show === !el.hidden) return kick();
		if (show) {
			el.hidden = false;
			place();
			state.active = -2;
			el.classList.remove("is-in");
			void el.offsetWidth;
			el.classList.add("is-in");
		} else {
			el.hidden = true;
		}
		kick();
	}
	settings.subscribe((key) => {
		if (key === "miniLyrics" || key === "*") refresh();
		if (key === "duetColors" || key === "*") el.dataset.duet = settings.get("duetColors") ? "on" : "off";
	});
	el.dataset.duet = settings.get("duetColors") ? "on" : "off";
	setTimeout(refresh); // after main.js has finished wiring (isOverlayOpen needs the overlay)

	// Alt+M anywhere toggles it (physical key, so any keyboard layout works).
	window.addEventListener(
		"keydown",
		(e) => {
			if (!(e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyM")) return;
			e.preventDefault();
			e.stopPropagation();
			toggle();
		},
		true,
	);
	function toggle() {
		if (state.pip) return state.pip.close();
		settings.set("miniLyrics", !settings.get("miniLyrics"));
	}

	// ---- content
	/** From the Now Playing card: lyrics for `uri`, or null with a message. */
	function setLyrics(uri, lyrics, message = "") {
		state.uri = uri;
		state.lyrics = lyrics;
		state.message = message;
		state.active = -2;
		state.wordIdx = -1;
		const track = getCurrentTrack();
		if (track?.image && art.getAttribute("src") !== track.image) art.src = track.image;
		art.hidden = !track?.image;
		tint(track);
		if (!lyrics) showLines(message || "", "");
		else if (!lyrics.synced) showLines(track ? `${track.title}` : "", "Lyrics aren't synced · click to read them");
		kick();
	}

	function tint(track) {
		const extract = globalThis.Spicetify?.colorExtractor;
		if (!track?.uri || typeof extract !== "function") return;
		Promise.resolve(extract(track.uri))
			.then((c) => c && state.uri === track.uri && el.style.setProperty("--float-c", c.DARK_VIBRANT || c.VIBRANT || c.PROMINENT || "#2a2a33"))
			.catch(() => {});
	}

	/** Swap the two lines with a short enter animation. `a` may be a node or text. */
	function showLines(a, b, singer = null) {
		cur.replaceChildren(a);
		next.textContent = b || "";
		if (singer) cur.dataset.singer = String(singer);
		else delete cur.dataset.singer;
		for (const n of [cur, next]) {
			n.classList.remove("is-enter");
			void n.offsetWidth;
			n.classList.add("is-enter");
		}
	}

	function lineNode(line) {
		if (line.gap) return h("span", { class: "aur-float-dots" }, h("i"), h("i"), h("i"));
		if (!line.words) return line.text;
		const frag = document.createDocumentFragment();
		const spans = line.words.map((w) => {
			const m = w.text.match(/^(\s*)([\s\S]*?)(\s*)$/);
			if (m[1]) frag.append(m[1]);
			const span = h("span", { class: "aur-float-w" }, m[2]);
			frag.append(span);
			if (m[3]) frag.append(m[3]);
			return span;
		});
		state.words = { words: line.words, spans };
		return frag;
	}

	function activate(idx) {
		const ls = state.lyrics.lines;
		state.active = idx;
		state.wordIdx = -1;
		state.words = null;
		const nextText = (from) => ls.slice(from).find((l) => !l.gap)?.text || "";
		if (idx < 0) return showLines(lineNode({ gap: true }), nextText(0));
		const line = ls[idx];
		showLines(lineNode(line), nextText(idx + 1), line.gap ? null : (line.singer ?? (line.opposite ? 1 : null)));
	}

	function updateWords(pos) {
		const { words, spans } = state.words;
		const k = findLineIndex(words, pos);
		if (k !== state.wordIdx) {
			spans.forEach((s, i) => {
				s.classList.toggle("sung", i < k);
				if (i !== k) s.style.removeProperty("--aur-wp");
			});
			state.wordIdx = k;
		}
		if (k >= 0 && k < spans.length) {
			const w = words[k];
			const p = w.end > w.time ? clamp((pos - w.time) / (w.end - w.time), 0, 1) : 1;
			spans[k].style.setProperty("--aur-wp", p.toFixed(3));
		}
	}

	/** After the last lyric line, near the end of the song: "Up next · title — artist". */
	function peekNext() {
		const ls = state.lyrics.lines;
		if (state.active < 0 || ls.slice(state.active + 1).some((l) => !l.gap)) return;
		const dur = getDuration();
		const t = settings.get("queuePeek") && dur > 45000 && dur - getPosition() <= MINI_UP_NEXT_MS ? getNextTrack() : null;
		const text = t && t.uri !== state.uri ? `Up next · ${t.title}${t.artist ? ` — ${t.artist}` : ""}` : "";
		if (next.textContent !== text) next.textContent = text;
	}

	// ---- loop: rAF of whichever window shows the pill (the PiP window keeps running while
	// Spotify's own window is minimised), a slow timer while paused.
	function stop() {
		if (state.raf) state.rafWin?.cancelAnimationFrame(state.raf);
		clearTimeout(state.timer);
		state.raf = state.timer = 0;
	}
	function tick() {
		stop();
		if (el.hidden || !state.lyrics?.synced) return;
		const pos = getPosition() + settings.get("offset");
		const idx = findLineIndex(state.lyrics.lines, pos);
		if (idx !== state.active) activate(idx);
		if (state.words) updateWords(pos + MINI_LEAD_MS);
		const now = performance.now();
		if (now - state.upAt > 1000) {
			state.upAt = now;
			peekNext();
		}
		if (isPlaying()) {
			state.rafWin = state.pip || window;
			state.raf = state.rafWin.requestAnimationFrame(tick);
			// rAF stalls in occluded / background windows; the timer keeps lines on time.
			state.timer = setTimeout(tick, 200);
		} else state.timer = setTimeout(tick, 300);
	}
	function kick() {
		tick();
	}

	// ---- Document Picture-in-Picture
	async function popOut() {
		const api = globalThis.documentPictureInPicture;
		if (!api || state.pip) return;
		let pip;
		try {
			pip = await api.requestWindow(PIP_SIZE);
		} catch (e) {
			// e.g. the host app can't open extra windows ("no window"): don't offer it again.
			console.warn("[aurora-lyrics] pop-out failed", e);
			pipBtn.hidden = true;
			next.textContent = "Pop-out isn't available in this Spotify version";
			return;
		}
		// Same styles as the main window (Spotify's fonts + ours).
		for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) pip.document.head.append(node.cloneNode(true));
		pip.document.documentElement.className = document.documentElement.className;
		pip.document.body.classList.add("aur-float-pip-body");
		pip.document.title = "Aurora Lyrics";
		stop();
		state.pip = pip;
		el.classList.add("is-pip");
		el.style.left = el.style.top = "";
		el.hidden = false;
		pip.document.body.append(el);
		pip.addEventListener("pagehide", () => {
			stop();
			state.pip = null;
			el.classList.remove("is-pip");
			document.body.append(el);
			el.hidden = true; // refresh() decides whether it shows in Spotify again
			refresh();
		});
		state.active = -2;
		kick();
	}

	return {
		setLyrics,
		refresh,
		toggle,
		onPlayPause: kick,
		onProgress: kick, // ~1/s and on seeks
	};
}

// ---- main.js ---------------------------------------------------------------
// Entry point: wait for Spicetify, inject CSS, register buttons and player listeners.


async function waitForSpicetify(timeoutMs = 60000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const S = globalThis.Spicetify;
		if (S?.Player?.addEventListener && S?.Player?.data !== undefined && S?.LocalStorage && document.body) return S;
		await sleep(250);
	}
	throw new Error("Spicetify APIs did not become available");
}

async function main() {
	if (globalThis.__auroraLyricsLoaded) return; // guard against double injection
	globalThis.__auroraLyricsLoaded = true;

	const S = await waitForSpicetify();

	const style = document.createElement("style");
	style.id = `${EXT_ID}-style`;
	style.textContent = CSS;
	document.head.append(style);

	let playbarBtn = null;
	let card = null;
	let mini = null;
	const overlay = createOverlay({
		onOpenChange: (open) => {
			if (playbarBtn) playbarBtn.active = open;
			if (!open) card?.onOverlayClosed();
			mini?.refresh();
		},
		onLyrics: (uri, lyrics, source) => card?.useLyrics(uri, lyrics, source),
	});
	const isOverlayOpen = () => overlay.isOpen();
	// Mini lyrics: a floating pill over Spotify (fed by the Now Playing card's lookup).
	try {
		mini = createMiniLyrics({ openOverlay: () => overlay.open(), isOverlayOpen });
	} catch (e) {
		console.warn(`[${EXT_ID}] mini lyrics unavailable`, e);
	}
	// Our lyrics card in Spotify's right-hand Now Playing panel.
	try {
		card = createNowPlayingCard({
			openOverlay: () => overlay.open(),
			isOverlayOpen,
			onState: (uri, lyrics, message) => mini?.setLyrics(uri, lyrics, message),
			toggleMini: () => mini?.toggle(),
		});
	} catch (e) {
		console.warn(`[${EXT_ID}] Now Playing card unavailable`, e);
	}

	// Buttons: each API is optional across Spicetify versions, so register what exists.
	const label = "Aurora Lyrics (Alt+L)";
	try {
		if (S.Topbar?.Button) {
			const tb = new S.Topbar.Button(label, ICONS.lyrics(20), () => overlay.toggle());
			// Round like Spotify's global-nav buttons (Home, Marketplace…); styles in styles.css.
			const el = tb.element?.matches?.("button") ? tb.element : tb.element?.querySelector?.("button") || tb.element;
			el?.classList.add("aur-topbar-btn");
		}
	} catch (e) {
		console.warn(`[${EXT_ID}] topbar button unavailable`, e);
	}
	try {
		if (S.Playbar?.Button) playbarBtn = new S.Playbar.Button(label, ICONS.lyrics(16), () => overlay.toggle(), false, false);
	} catch (e) {
		console.warn(`[${EXT_ID}] playbar button unavailable`, e);
	}

	S.Player.addEventListener("songchange", () => (overlay.onSongChange(), card?.onSongChange()));
	S.Player.addEventListener("onplaypause", () => (overlay.onPlayPause(), card?.onPlayPause(), mini?.onPlayPause()));
	S.Player.addEventListener("onprogress", () => (overlay.onProgress(), card?.onProgress(), mini?.onProgress()));

	// Small public handle for debugging from DevTools: window.AuroraLyrics.open()
	globalThis.AuroraLyrics = { open: overlay.open, close: overlay.close, toggle: overlay.toggle, testSources: overlay.testSources, toggleMini: () => mini?.toggle() };
	console.info(`[${EXT_ID}] loaded`);
}

main().catch((e) => console.error("[aurora-lyrics] failed to start", e));
})();
