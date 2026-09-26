// Aurora Lyrics v2.0.0 — full-screen animated lyrics for Spicetify
// Built from src/ by build.mjs — edit the sources, not this file.
// NAME: Aurora Lyrics
// AUTHOR: yamac
// DESCRIPTION: Full-screen animated, synced lyrics overlay for Spotify (Spicetify extension).

(function fullscreenAnimatedLyrics() {
"use strict";

// ---- util.js ---------------------------------------------------------------
// Small shared helpers. No Spicetify access here so this stays testable in Node.

const EXT_ID = "fullscreen-animated-lyrics";

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
			console.warn("[fal] storage write failed", key, e);
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
//   type: "range" | "select" | "toggle"
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
	// Text
	{ key: "font", section: "Text", label: "Font", type: "select", ui: "fonts", options: Object.entries(FONTS).map(([k, f]) => [k, f.label]), default: "spotify" },
	{ key: "fontSize", section: "Text", label: "Size", type: "range", min: 24, max: 104, step: 2, unit: "px", default: 56 },
	{ key: "fontWeight", section: "Text", label: "Weight", type: "select", ui: "segmented", options: [["500", "Medium"], ["700", "Bold"], ["800", "Heavy"], ["900", "Black"]], default: "800" },
	{ key: "lineSpacing", section: "Text", label: "Line spacing", type: "range", min: 0.1, max: 1.5, step: 0.05, unit: "em", default: 0.55 },
	{ key: "textAlign", section: "Text", label: "Alignment", type: "select", ui: "segmented", options: [["left", "Left"], ["center", "Center"], ["right", "Right"]], default: "left" },
	{ key: "textColor", section: "Text", label: "Colour", type: "select", ui: "segmented", options: [["white", "White"], ["accent", "Album tint"]], default: "white" },
	{ key: "glow", section: "Text", label: "Glow", type: "select", ui: "segmented", options: [["off", "Off"], ["soft", "Soft"], ["radiant", "Radiant"]], default: "soft" },
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
		hints: { fill: "Soft sweep + lift", glow: "Light up + bloom", pop: "Swell on each word", rise: "Float into place", letters: "Letter wave", karaoke: "Album-colour wipe" },
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
const EXTRA_DEFAULTS = { pinControls: false, seenTip: false };

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
		const entry = SCHEMA.find((s) => s.key === key);
		const v = entry ? validate(entry, value) : value;
		if (current[key] === v || (typeof v === "object" && JSON.stringify(current[key]) === JSON.stringify(v))) return;
		current = { ...current, [key]: v };
		store.setJSON(SETTINGS_KEY, current);
		for (const fn of listeners) fn(key, v, current);
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
//   Line = { time: ms|null, end: ms|null, text: string, gap?: true, words: Word[]|null }
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

		// A2 voice markers ("v1:") and stray whitespace.
		const content = line.slice(contentStart).replace(/^v\d+:\s*/i, "");
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
			lines.push({ time: t, end: null, text: plain, words });
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
 * Small regex-based TTML reader (no DOMParser needed). Handles <p begin end> lines,
 * timed <span> words/syllables (with or without spaces between them), and
 * <span ttm:role="x-bg"> background vocals. Untimed TTML becomes plain text.
 */
function parseTTML(xml, duration) {
	const body = String(xml || "");
	const lines = [];
	let anyTimed = false;
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
		lines.push({ time: begin, text: mainText, words: mainWords, bg: bgText ? { text: bgText, words: bgWords } : null });
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

	return {
		uri,
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
		console.warn("[fal] setVolume failed", e);
	}
}

/** Call a Player method if it exists (next / back / togglePlay / toggleShuffle / …). */
function playerCommand(name) {
	try {
		globalThis.Spicetify?.Player?.[name]?.();
	} catch (e) {
		console.warn(`[fal] Player.${name} failed`, e);
	}
}

function seek(ms) {
	try {
		globalThis.Spicetify?.Player?.seek?.(Math.max(0, Math.round(ms)));
	} catch (e) {
		console.warn("[fal] seek failed", e);
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
				console.warn(`[fal] Musixmatch matched a different song ("${matched?.track_name}" by ${matched?.artist_name}); ignoring it`);
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
			console.warn(`[fal] ${r.message}`);
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
	lyrics: (size = 16) => svg('<path d="M4 5h16M4 10h11M4 15h8"/><path d="M17 20.5V13l4-1"/><circle cx="15" cy="20.5" r="2"/>', size),
	close: () => svg('<path d="M6 6l12 12M18 6L6 18"/>'),
	settings: () => svg('<path d="M4 7h9M18 7h2M4 17h3M12 17h8"/><circle cx="15.5" cy="7" r="2.3"/><circle cx="9.5" cy="17" r="2.3"/>'),
	reload: () => svg('<path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/>'),
	edit: () => svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
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
const CSS = ".fal-root {\n--fal-font: var(--encore-title-font-stack, \"SpotifyMixUITitle\", \"SpotifyMixUI\", \"CircularSp\", system-ui, sans-serif);\n--fal-fs: 56px;\n--fal-gap: 0.55em;\n--fal-fw: 800;\n--fal-shade: 0.45;\n--fal-bg-scale: 12;\n--fal-bg-blur: 6px;\n--fal-c1: #4b3b78;\n--fal-c2: #14203a;\n--fal-accent: #ffffff;\n--fal-ah: 1.2em;\n--fal-ui-font: var(--encore-body-font-stack, \"SpotifyMixUI\", \"CircularSp\", \"Segoe UI Variable Text\", system-ui, sans-serif);\n--fal-size: min(var(--fal-fs), 7.4vw, 10.5vh);\n--fal-hi: #fff;\n--fal-dim: color-mix(in srgb, var(--fal-hi) 30%, transparent);\n--fal-glow-tint: color-mix(in oklab, var(--fal-accent) 62%, #fff);\n--fal-glow-k: 1;\n--fal-glow-c: color-mix(in oklab, var(--fal-glow-tint) 45%, transparent);\n--fal-green: #1ed760;\n--fal-origin: 0%;\n--fal-pad: max(7vw, 20px);\n--fal-ease: cubic-bezier(0.22, 1, 0.36, 1);\n--fal-spring: cubic-bezier(0.34, 1.56, 0.64, 1);\n--fal-wave: cubic-bezier(0.3, 1.12, 0.44, 1);\n--fal-stagger: 0ms;\n--fal-move: 0.85s;\n--fal-move-ease: var(--fal-ease);\nposition: fixed;\ninset: 0;\nz-index: 99999;\noverflow: hidden;\noverflow: clip;\nisolation: isolate;\ncolor: #fff;\nbackground: #08080b;\nfont-family: var(--fal-ui-font);\n-webkit-font-smoothing: antialiased;\ntext-rendering: optimizeLegibility;\n-webkit-app-region: no-drag;\noutline: none;\nuser-select: none;\nopacity: 0;\ntransform: scale(1.035);\ntransition:\nopacity 0.42s var(--fal-ease),\ntransform 0.7s var(--fal-ease);\n}\n.fal-root[hidden] { display: none; }\n.fal-root.is-open { opacity: 1; transform: none; }\n.fal-root *, .fal-root *::before, .fal-root *::after { box-sizing: border-box; }\n.fal-root ::selection { background: rgba(255, 255, 255, 0.28); }\n.fal-root[data-align=\"center\"] { --fal-origin: 50%; }\n.fal-root[data-align=\"right\"] { --fal-origin: 100%; }\n.fal-root[data-glow=\"radiant\"] { --fal-glow-k: 1.7; }\n.fal-root[data-glow=\"off\"] { --fal-glow-k: 0; }\n.fal-root[data-color=\"accent\"] { --fal-hi: color-mix(in srgb, var(--fal-accent) 42%, #fff); }\n.fal-root[data-anim=\"flow\"] { --fal-stagger: 36ms; --fal-move: 1.05s; --fal-move-ease: var(--fal-wave); }\n.fal-root[data-anim=\"scale\"] { --fal-stagger: 14ms; --fal-move: 0.95s; --fal-move-ease: cubic-bezier(0.34, 1.3, 0.64, 1); }\n.fal-bg { position: absolute; inset: 0; z-index: -1; overflow: hidden; background: #0a0a0e; }\n.fal-bg-stack, .fal-bg-layer { position: absolute; inset: 0; }\n.fal-bg-layer { opacity: 0; transition: opacity 1.6s ease; }\n.fal-bg-layer.is-on { opacity: 1; }\n.fal-blob {\nposition: absolute;\nleft: 50%;\ntop: 50%;\nwidth: 256px;\nheight: 256px;\nmax-width: none;\nmargin: -128px 0 0 -128px;\nobject-fit: cover;\nfilter: blur(var(--fal-bg-blur)) saturate(1.7) brightness(0.92);\ntransform: translate(var(--bx, 0), var(--by, 0)) scale(calc(var(--fal-bg-scale) * var(--bs, 1)));\nanimation: fal-spin var(--bt, 120s) linear infinite;\nwill-change: transform;\n}\n.fal-blob.b3 { --bt: 150s; animation-direction: reverse; }\n.fal-blob.b1 { --bx: -20vw; --by: -14vh; --bs: 0.7; --bt: 70s; opacity: 0.85; border-radius: 42%; animation-delay: -20s; }\n.fal-blob.b2 { --bx: 22vw; --by: 16vh; --bs: 0.62; --bt: 95s; opacity: 0.7; border-radius: 46%; animation-direction: reverse; animation-delay: -45s; }\n.fal-root[data-bganim=\"off\"] .fal-blob,\n.fal-root[data-bganim=\"off\"] .fal-bg-gradient { animation-play-state: paused; }\n@keyframes fal-spin { to { rotate: 360deg; } }\n.fal-bg-gradient {\nposition: absolute;\ninset: -30%;\nopacity: 0;\nbackground:\nradial-gradient(42% 42% at 30% 35%, var(--fal-c1) 0%, transparent 70%),\nradial-gradient(48% 48% at 70% 65%, var(--fal-c2) 0%, transparent 72%),\nradial-gradient(35% 35% at 75% 20%, color-mix(in srgb, var(--fal-accent) 40%, transparent) 0%, transparent 70%),\n#0b0b10;\ntransition: opacity 1s ease;\nanimation: fal-drift 36s ease-in-out infinite alternate;\n}\n.fal-root[data-bg=\"gradient\"] .fal-bg-gradient { opacity: 1; }\n.fal-root:not([data-bg=\"gradient\"]) .fal-bg-gradient { animation: none; }\n.fal-root:not([data-bg=\"album\"]) .fal-bg-stack { display: none; }\n@keyframes fal-drift {\nfrom { transform: translate3d(-3%, -2%, 0) rotate(0deg) scale(1); }\nto { transform: translate3d(3%, 2%, 0) rotate(10deg) scale(1.1); }\n}\n.fal-bg-shade {\nposition: absolute;\ninset: 0;\nbackground:\nlinear-gradient(to top, rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0.18) 16%, transparent 34%),\nradial-gradient(ellipse at 42% 40%, rgba(0, 0, 0, calc(var(--fal-shade) * 0.6)) 0%, rgba(0, 0, 0, var(--fal-shade)) 100%);\n}\n.fal-bg-grain {\nposition: absolute;\ninset: 0;\nopacity: 0.08;\nmix-blend-mode: overlay;\nbackground-size: 180px 180px;\nbackground-image: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\");\npointer-events: none;\n}\n.fal-drag { position: absolute; top: 0; left: 0; right: 0; height: 40px; -webkit-app-region: drag; z-index: 1; }\n.fal-header {\nposition: absolute;\ntop: 30px;\nleft: var(--fal-pad);\nz-index: 2;\ndisplay: flex;\nalign-items: center;\ngap: 14px;\nmax-width: min(560px, 55vw);\npointer-events: none;\ntransition: opacity 0.5s ease, transform 0.6s var(--fal-ease);\n}\n.fal-root[data-info=\"off\"] .fal-header { display: none; }\n.fal-cover { width: 54px; height: 54px; flex: none; border-radius: 8px; object-fit: cover; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45); }\n.fal-meta { min-width: 0; }\n.fal-title, .fal-artist { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.fal-title { font-size: 15.5px; font-weight: 700; letter-spacing: -0.01em; }\n.fal-artist { margin-top: 3px; font-size: 13px; color: rgba(255, 255, 255, 0.62); }\n.fal-stage {\nposition: absolute;\ninset: 0;\npadding: 0 var(--fal-pad);\noverflow: hidden;\n-webkit-mask-image: linear-gradient(to bottom, transparent 0, transparent 72px, #000 calc(72px + 13%), #000 72%, transparent 93%);\nmask-image: linear-gradient(to bottom, transparent 0, transparent 72px, #000 calc(72px + 13%), #000 72%, transparent 93%);\n}\n.fal-lines { position: relative; }\n.fal-root:not([data-transport=\"off\"]) .fal-stage { bottom: 96px; }\n.fal-root[data-align=\"center\"] .fal-stage { text-align: center; }\n.fal-root[data-align=\"right\"] .fal-stage { text-align: right; }\n.fal-stage > .fal-lines,\n.fal-stage > .fal-message { transition: opacity 0.22s ease, filter 0.22s ease; }\n.fal-stage.is-leaving > .fal-lines,\n.fal-stage.is-leaving > .fal-message { opacity: 0; filter: blur(8px); }\n.fal-line {\n--fal-s: 0.95;\n--fal-k: 0;\nfont-family: var(--fal-font);\nfont-size: var(--fal-size);\nfont-weight: var(--fal-fw);\nline-height: 1.16;\nletter-spacing: -0.022em;\npadding: calc(var(--fal-gap) / 2) 0;\nmax-width: 1400px;\ncolor: var(--fal-hi);\nopacity: 0.1;\ntransform-origin: var(--fal-origin) 50%;\noverflow-wrap: anywhere;\ntext-wrap: balance;\nfont-kerning: normal;\ncursor: pointer;\ntransition:\nopacity 0.7s var(--fal-ease),\ntransform var(--fal-move) var(--fal-move-ease) calc(var(--fal-k) * var(--fal-stagger)),\nfilter 0.7s var(--fal-ease),\ncolor 0.5s ease,\ntext-shadow 0.7s ease;\n}\n.fal-root[data-align=\"center\"] .fal-line { margin-inline: auto; }\n.fal-root[data-align=\"right\"] .fal-line { margin-left: auto; }\n.fal-root .fal-line.is-active { --fal-s: 1; opacity: 1; cursor: default; }\n.fal-root:not([data-glow=\"off\"]) .fal-line.is-active:not(.has-words) .fal-main {\ntext-shadow:\n0 0 0.05em color-mix(in srgb, #fff calc(28% * var(--fal-glow-k)), transparent),\n0 0 0.26em color-mix(in oklab, var(--fal-glow-tint) calc(30% * var(--fal-glow-k)), transparent),\n0 0 0.85em color-mix(in oklab, var(--fal-glow-tint) calc(16% * var(--fal-glow-k)), transparent);\n}\n.fal-main { transition: text-shadow 0.8s ease; }\n.fal-main { position: relative; }\n.fal-main::before {\n--a: calc(13% * var(--fal-glow-k));\ncontent: \"\";\nposition: absolute;\nz-index: -1;\nleft: calc(var(--hx, 0px) - 1.1em);\ntop: calc(var(--hy, 0px) - 0.7em);\nwidth: calc(var(--hw, 100%) + 2.2em);\nheight: calc(var(--hh, 100%) + 1.4em);\npointer-events: none;\nbackground: radial-gradient(closest-side, color-mix(in oklab, var(--fal-glow-tint) var(--a), transparent) 0%, color-mix(in oklab, var(--fal-glow-tint) calc(var(--a) * 0.45), transparent) 55%, transparent 100%);\nopacity: 0;\ntransform: scale(0.85);\ntransition: opacity 1.2s ease, transform 1.6s var(--fal-ease);\n}\n.fal-line.is-active .fal-main::before { opacity: 1; transform: none; }\n.fal-stage[data-mode=\"unsynced\"] .fal-main::before { display: none; }\n@property --fal-wp { syntax: \"<number>\"; inherits: true; initial-value: 0; }\n.fal-wg { display: inline-block; white-space: nowrap; }\n.fal-w, .fal-c { display: inline-block; }\n.fal-root[data-words=\"on\"] .is-active.has-words :is(.fal-w:not(.has-chars), .fal-c) {\n--p: var(--fal-wp);\n--e: calc(var(--p) * var(--p) * (3 - 2 * var(--p)));\n--hop: sin(calc(var(--e) * 3.14159));\n--edge: 0.75em;\ntransform-origin: 50% 90%;\nwill-change: transform;\n}\n.fal-root[data-words=\"on\"] .is-active.has-words .fal-w .fal-c {\n--wave: 2.6;\n--p: clamp(0, (var(--fal-wp) * (var(--n) + var(--wave)) - var(--i)) / var(--wave), 1);\n--edge: 0.4em;\n}\n.fal-root[data-words=\"on\"] .is-active.has-words :is(.fal-w:not(.has-chars), .fal-c) {\ncolor: color-mix(in srgb, var(--fal-hi) calc(var(--e) * 100%), var(--fal-dim));\ntransform: translateY(calc(0.03em - var(--e) * 0.075em));\n}\n.fal-root:not([data-glow=\"off\"])[data-words=\"on\"] .is-active.has-words :is(.fal-w:not(.has-chars), .fal-c) {\n--g: calc(var(--e) * var(--fal-glow-k));\nfilter:\ndrop-shadow(0 0 0.04em color-mix(in srgb, #fff calc(32% * var(--g)), transparent))\ndrop-shadow(0 0 0.3em color-mix(in oklab, var(--fal-glow-tint) calc(34% * var(--g)), transparent));\n}\n.fal-root[data-words=\"on\"]:is([data-wordanim=\"fill\"], [data-wordanim=\"rise\"], [data-wordanim=\"karaoke\"], [data-wordanim=\"letters\"]) .is-active.has-words :is(.fal-w:not(.has-chars), .fal-c) {\ncolor: transparent;\nbackground-image: linear-gradient(90deg, var(--fal-ink, var(--fal-hi)) calc(var(--p) * (100% + var(--edge)) - var(--edge)), var(--fal-dim) calc(var(--p) * (100% + var(--edge))));\n-webkit-background-clip: text;\nbackground-clip: text;\n}\n.fal-root[data-words=\"on\"][data-wordanim=\"glow\"] .is-active.has-words :is(.fal-w:not(.has-chars), .fal-c) {\n--lit: clamp(0, var(--e) * 3, 1);\ncolor: color-mix(in srgb, var(--fal-hi) calc(var(--lit) * 100%), var(--fal-dim));\ntransform: translateY(calc(0.03em - var(--lit) * 0.07em)) scale(calc(1 + 0.04 * var(--hop)));\n}\n.fal-root[data-words=\"on\"][data-wordanim=\"glow\"] .is-active .fal-w.now:not(.has-chars),\n.fal-root[data-words=\"on\"][data-wordanim=\"glow\"] .is-active .fal-w.now .fal-c {\n--gk: max(var(--fal-glow-k), 0.6);\nfilter:\ndrop-shadow(0 0 0.05em color-mix(in srgb, #fff calc((30% + 25% * var(--hop)) * var(--gk)), transparent))\ndrop-shadow(0 0 calc(0.25em + 0.3em * var(--hop)) color-mix(in oklab, var(--fal-glow-tint) calc((32% + 30% * var(--hop)) * var(--gk)), transparent));\n}\n.fal-root[data-words=\"on\"][data-wordanim=\"pop\"] .is-active.has-words :is(.fal-w:not(.has-chars), .fal-c) {\n--lit: clamp(0, var(--e) * 4, 1);\ncolor: color-mix(in srgb, var(--fal-hi) calc(var(--lit) * 100%), var(--fal-dim));\ntransform: translateY(calc(0.03em - var(--lit) * 0.06em - 0.06em * var(--hop))) scale(calc(1 + 0.12 * var(--hop)));\n}\n.fal-root[data-words=\"on\"][data-wordanim=\"rise\"] .is-active.has-words :is(.fal-w:not(.has-chars), .fal-c) {\n--up: clamp(0, var(--e) * 2.2, 1);\n--up-e: calc(1 - (1 - var(--up)) * (1 - var(--up)));\nopacity: calc(0.45 + 0.55 * var(--up-e));\ntransform: translateY(calc((1 - var(--up-e)) * 0.2em - 0.04em));\n}\n.fal-root[data-words=\"on\"][data-wordanim=\"karaoke\"] .is-active.has-words :is(.fal-w:not(.has-chars), .fal-c) {\n--fal-ink: color-mix(in srgb, var(--fal-accent) 70%, #fff);\n--edge: 0.18em;\ntransform: none;\n}\n.fal-root[data-words=\"on\"][data-wordanim=\"letters\"] .is-active.has-words .fal-w .fal-c {\ntransform: translateY(calc(0.03em - var(--e) * 0.06em - 0.13em * var(--hop))) scale(calc(1 + 0.09 * var(--hop)));\n}\n.fal-root[data-words=\"on\"]:not([data-wordanim=\"karaoke\"]):not([data-wordanim=\"letters\"]) .is-active .fal-w.is-long .fal-c {\ntransform: translateY(calc(0.03em - var(--e) * 0.075em - 0.08em * var(--hop))) scale(calc(1 + 0.05 * var(--hop)));\n}\n.fal-root[data-words=\"on\"] .is-active .fal-w.is-long.now .fal-c {\nfilter:\ndrop-shadow(0 0 0.05em color-mix(in srgb, #fff calc((20% + 30% * var(--hop)) * var(--fal-glow-k)), transparent))\ndrop-shadow(0 0 calc(0.22em + 0.25em * var(--hop)) color-mix(in oklab, var(--fal-glow-tint) calc((30% + 35% * var(--hop)) * var(--fal-glow-k)), transparent));\n}\n.fal-tr {\nmargin-top: 0.22em;\nfont-family: var(--fal-ui-font);\nfont-size: 0.44em;\nfont-weight: 600;\nline-height: 1.3;\nletter-spacing: 0;\ncolor: rgba(255, 255, 255, 0.62);\ntext-wrap: balance;\ntransition: color 0.5s ease;\n}\n.fal-line.is-active .fal-tr { color: rgba(255, 255, 255, 0.9); }\n.fal-stage[data-mode=\"unsynced\"] .fal-tr { font-size: 0.6em; }\n.fal-root[data-view=\"captions\"] .fal-tr { font-size: 0.5em; }\n.fal-tr-btn.is-on { background: rgba(255, 255, 255, 0.08); }\n.fal-root[data-align=\"left\"] .fal-line.is-opposite { --fal-origin: 100%; text-align: right; margin-left: auto; }\n.fal-root[data-align=\"right\"] .fal-line.is-opposite { --fal-origin: 0%; text-align: left; margin-left: 0; margin-right: auto; }\n.fal-bgv {\nmargin-top: 0.12em;\nfont-size: 0.56em;\nfont-weight: calc(var(--fal-fw) - 100);\nletter-spacing: -0.01em;\nopacity: 0.55;\ntransition: opacity 0.6s ease;\n}\n.fal-line.is-active .fal-bgv { opacity: 0.85; }\n.fal-line.is-gap { cursor: default; }\n.fal-dots { display: inline-flex; align-items: center; gap: 0.32em; height: 1.16em; transform-origin: var(--fal-origin) 50%; }\n.fal-dots i { width: 0.28em; height: 0.28em; border-radius: 50%; background: var(--fal-hi); opacity: 0.3; transform: scale(0.8); transition: opacity 0.4s ease, transform 0.5s var(--fal-spring); }\n.is-active .fal-dots { animation: fal-breathe 3s ease-in-out infinite; }\n.is-active .fal-dots i:nth-child(1) { opacity: calc(0.3 + 0.7 * clamp(0, var(--fal-gp, 0) * 3, 1)); transform: scale(calc(0.8 + 0.35 * clamp(0, var(--fal-gp, 0) * 3, 1))); }\n.is-active .fal-dots i:nth-child(2) { opacity: calc(0.3 + 0.7 * clamp(0, var(--fal-gp, 0) * 3 - 1, 1)); transform: scale(calc(0.8 + 0.35 * clamp(0, var(--fal-gp, 0) * 3 - 1, 1))); }\n.is-active .fal-dots i:nth-child(3) { opacity: calc(0.3 + 0.7 * clamp(0, var(--fal-gp, 0) * 3 - 2, 1)); transform: scale(calc(0.8 + 0.35 * clamp(0, var(--fal-gp, 0) * 3 - 2, 1))); }\n@keyframes fal-breathe {\n0%, 100% { transform: scale(1); }\n50% { transform: scale(1.14); }\n}\n.fal-root[data-layout=\"list\"] .fal-stage[data-mode=\"synced\"] .fal-line {\ntransform: translate3d(0, var(--fal-y, 0px), 0) scale(var(--fal-s));\n}\n.fal-root[data-anim=\"flow\"] .fal-line { --fal-s: 0.96; }\n.fal-root[data-anim=\"scale\"] .fal-line { --fal-s: 0.8; }\n.fal-root[data-anim=\"scale\"] .fal-line[data-d=\"-1\"],\n.fal-root[data-anim=\"scale\"] .fal-line[data-d=\"1\"] { --fal-s: 0.86; }\n.fal-root .fal-line.is-active { --fal-s: 1; }\n.fal-root[data-anim=\"scale\"] .fal-line.is-active { --fal-s: 1.04; }\n.fal-root[data-layout=\"list\"] .fal-line[data-d=\"-1\"], .fal-root[data-layout=\"list\"] .fal-line[data-d=\"1\"] { opacity: 0.36; }\n.fal-root[data-layout=\"list\"] .fal-line[data-d=\"-2\"], .fal-root[data-layout=\"list\"] .fal-line[data-d=\"2\"] { opacity: 0.24; }\n.fal-root[data-layout=\"list\"] .fal-line[data-d=\"-3\"], .fal-root[data-layout=\"list\"] .fal-line[data-d=\"3\"] { opacity: 0.17; }\n.fal-root[data-layout=\"list\"] .fal-line[data-d=\"-4\"], .fal-root[data-layout=\"list\"] .fal-line[data-d=\"4\"] { opacity: 0.13; }\n.fal-root[data-depth=\"on\"][data-layout=\"list\"] .fal-stage[data-mode=\"synced\"] .fal-line[data-d=\"-1\"],\n.fal-root[data-depth=\"on\"][data-layout=\"list\"] .fal-stage[data-mode=\"synced\"] .fal-line[data-d=\"1\"] { filter: blur(0.8px); }\n.fal-root[data-depth=\"on\"][data-layout=\"list\"] .fal-stage[data-mode=\"synced\"] .fal-line[data-d=\"-2\"],\n.fal-root[data-depth=\"on\"][data-layout=\"list\"] .fal-stage[data-mode=\"synced\"] .fal-line[data-d=\"2\"] { filter: blur(1.5px); }\n.fal-root[data-depth=\"on\"][data-layout=\"list\"] .fal-stage[data-mode=\"synced\"] .fal-line[data-d=\"-3\"],\n.fal-root[data-depth=\"on\"][data-layout=\"list\"] .fal-stage[data-mode=\"synced\"] .fal-line[data-d=\"3\"] { filter: blur(2.2px); }\n.fal-root[data-depth=\"on\"][data-layout=\"list\"] .fal-stage[data-mode=\"synced\"] .fal-line[data-d=\"-4\"],\n.fal-root[data-depth=\"on\"][data-layout=\"list\"] .fal-stage[data-mode=\"synced\"] .fal-line[data-d=\"4\"],\n.fal-root[data-depth=\"on\"][data-layout=\"list\"] .fal-stage[data-mode=\"synced\"] .fal-line[data-d=\"-5\"],\n.fal-root[data-depth=\"on\"][data-layout=\"list\"] .fal-stage[data-mode=\"synced\"] .fal-line[data-d=\"5\"],\n.fal-root[data-depth=\"on\"][data-layout=\"list\"] .fal-stage[data-mode=\"synced\"] .fal-line[data-d=\"-6\"],\n.fal-root[data-depth=\"on\"][data-layout=\"list\"] .fal-stage[data-mode=\"synced\"] .fal-line[data-d=\"6\"] { filter: blur(2.8px); }\n.fal-lines[data-dir=\"up\"] .fal-line[data-d=\"-1\"] { --fal-k: 1; }\n.fal-lines[data-dir=\"up\"] .fal-line[data-d=\"0\"] { --fal-k: 2; }\n.fal-lines[data-dir=\"up\"] .fal-line[data-d=\"1\"] { --fal-k: 3; }\n.fal-lines[data-dir=\"up\"] .fal-line[data-d=\"2\"] { --fal-k: 4; }\n.fal-lines[data-dir=\"up\"] .fal-line[data-d=\"3\"] { --fal-k: 5; }\n.fal-lines[data-dir=\"up\"] .fal-line[data-d=\"4\"] { --fal-k: 6; }\n.fal-lines[data-dir=\"up\"] .fal-line[data-d=\"5\"] { --fal-k: 7; }\n.fal-lines[data-dir=\"up\"] .fal-line[data-d=\"6\"],\n.fal-lines[data-dir=\"up\"] .fal-line.is-active ~ .fal-line:not([data-d]) { --fal-k: 8; }\n.fal-lines[data-dir=\"down\"] .fal-line:not([data-d]) { --fal-k: 8; }\n.fal-lines[data-dir=\"down\"] .fal-line.is-active ~ .fal-line:not([data-d]) { --fal-k: 0; }\n.fal-lines[data-dir=\"down\"] .fal-line[data-d=\"1\"] { --fal-k: 1; }\n.fal-lines[data-dir=\"down\"] .fal-line[data-d=\"0\"] { --fal-k: 2; }\n.fal-lines[data-dir=\"down\"] .fal-line[data-d=\"-1\"] { --fal-k: 3; }\n.fal-lines[data-dir=\"down\"] .fal-line[data-d=\"-2\"] { --fal-k: 4; }\n.fal-lines[data-dir=\"down\"] .fal-line[data-d=\"-3\"] { --fal-k: 5; }\n.fal-lines[data-dir=\"down\"] .fal-line[data-d=\"-4\"] { --fal-k: 6; }\n.fal-lines[data-dir=\"down\"] .fal-line[data-d=\"-5\"] { --fal-k: 7; }\n.fal-lines[data-dir=\"down\"] .fal-line[data-d=\"-6\"] { --fal-k: 8; }\n.fal-root[data-layout=\"list\"] .fal-stage[data-mode=\"synced\"] .fal-line:not(.is-gap) { position: relative; }\n.fal-root[data-layout=\"list\"] .fal-stage[data-mode=\"synced\"] .fal-line:not(.is-active):not(.is-gap):hover { opacity: 0.82; filter: none; transition-duration: 0.25s, var(--fal-move), 0.25s, 0.3s, 0.3s; }\n.fal-root[data-layout=\"list\"] .fal-stage[data-mode=\"synced\"] .fal-line:not(.is-gap)::after {\ncontent: \"\";\nposition: absolute;\nz-index: -1;\ninset: 0 -0.32em;\nborder-radius: 0.28em;\nbackground: linear-gradient(90deg, rgba(255, 255, 255, 0.09), rgba(255, 255, 255, 0.04));\nbox-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06), 0 0.2em 0.6em rgba(0, 0, 0, 0.12);\nopacity: 0;\ntransform: scale(0.97);\ntransition: opacity 0.25s ease, transform 0.4s var(--fal-ease);\npointer-events: none;\n}\n.fal-root[data-layout=\"list\"] .fal-stage[data-mode=\"synced\"] .fal-line[data-time]::before {\ncontent: attr(data-time) \"  ▶\";\nposition: absolute;\ntop: 50%;\nright: 0.1em;\npadding: 0.35em 0.75em;\nborder-radius: 99px;\nbackground: rgba(0, 0, 0, 0.28);\nfont-family: var(--fal-ui-font);\nfont-size: max(11px, 0.2em);\nfont-weight: 700;\nletter-spacing: 0.02em;\nwhite-space: pre;\ncolor: rgba(255, 255, 255, 0.85);\nopacity: 0;\ntransform: translate(0.4em, -50%);\ntransition: opacity 0.2s ease, transform 0.35s var(--fal-ease);\npointer-events: none;\n}\n.fal-root[data-align=\"right\"][data-layout=\"list\"] .fal-stage[data-mode=\"synced\"] .fal-line[data-time]::before { right: auto; left: 0.1em; transform: translate(-0.4em, -50%); }\n.fal-root[data-layout=\"list\"] .fal-stage[data-mode=\"synced\"] .fal-line:not(.is-gap):hover::after { opacity: 1; transform: none; }\n.fal-root[data-layout=\"list\"] .fal-stage[data-mode=\"synced\"] .fal-line[data-time]:hover::before { opacity: 1; transform: translate(0, -50%); }\n.fal-root[data-layout=\"list\"] .fal-stage[data-mode=\"synced\"] .fal-line:not(.is-gap):active::after { transform: scale(0.985); }\n.fal-root[data-view=\"captions\"] .fal-line::before, .fal-root[data-view=\"captions\"] .fal-line::after { display: none; }\n.fal-root[data-layout=\"list\"] .fal-stage.is-browsing .fal-line {\n--fal-k: 0 !important;\nfilter: none !important;\ntransition:\nopacity 0.4s ease,\ntransform 0.45s var(--fal-ease),\nfilter 0.3s ease,\ncolor 0.4s ease,\ntext-shadow 0.4s ease;\n}\n.fal-root[data-layout=\"list\"] .fal-stage.is-browsing .fal-line:not(.is-active) { opacity: 0.42; }\n.fal-root[data-layout=\"list\"] .fal-stage.is-browsing .fal-line:not(.is-active):not(.is-gap):hover { opacity: 0.9; }\n.fal-root[data-layout=\"list\"] .fal-stage.is-entering[data-mode=\"synced\"] .fal-line {\nanimation: fal-line-in 1s var(--fal-ease) backwards;\nanimation-delay: calc(var(--i, 0) * 55ms);\n}\n@keyframes fal-line-in {\nfrom { opacity: 0; transform: translate3d(0, calc(var(--fal-y, 0px) + 64px), 0) scale(var(--fal-s)); filter: blur(12px); }\n}\n.fal-root[data-layout=\"stack\"] .fal-stage[data-mode=\"synced\"] .fal-lines { position: absolute; top: 0; bottom: 0; left: var(--fal-pad); right: var(--fal-pad); }\n.fal-root[data-layout=\"stack\"] .fal-stage[data-mode=\"synced\"] .fal-line {\nposition: absolute;\nleft: 0;\nright: 0;\ntop: 44%;\nopacity: 0;\npointer-events: none;\ntransform: translateY(-50%) scale(0.5);\n}\n.fal-root[data-layout=\"stack\"] .fal-stage[data-mode=\"synced\"] .fal-line.is-active { opacity: 1; pointer-events: auto; transform: translateY(-50%); }\n.fal-root[data-layout=\"stack\"] .fal-stage.is-entering[data-mode=\"synced\"] .fal-lines { animation: fal-fade-up 0.9s var(--fal-ease) backwards; }\n.fal-root[data-anim=\"fade\"] .fal-line { transition-duration: 0.55s, 0.8s, 0.6s, 0.5s, 0.6s; }\n.fal-root[data-anim=\"fade\"] .fal-stage[data-mode=\"synced\"] .fal-line[data-d=\"-1\"] { opacity: 0.3; pointer-events: auto; transform: translateY(calc(var(--fal-ah) / -2 - 0.3em - 81%)) scale(0.62); }\n.fal-root[data-anim=\"fade\"] .fal-stage[data-mode=\"synced\"] .fal-line[data-d=\"1\"] { opacity: 0.3; pointer-events: auto; transform: translateY(calc(var(--fal-ah) / 2 + 0.3em - 19%)) scale(0.62); }\n.fal-root[data-anim=\"fade\"] .fal-stage[data-mode=\"synced\"] .fal-line[data-d=\"-2\"] { transform: translateY(calc(var(--fal-ah) / -2 - 1.6em - 75%)) scale(0.5); }\n.fal-root[data-anim=\"fade\"] .fal-stage[data-mode=\"synced\"] .fal-line[data-d=\"2\"] { transform: translateY(calc(var(--fal-ah) / 2 + 1.6em - 25%)) scale(0.5); }\n.fal-root[data-depth=\"on\"][data-anim=\"fade\"] .fal-stage[data-mode=\"synced\"] .fal-line[data-d=\"-1\"],\n.fal-root[data-depth=\"on\"][data-anim=\"fade\"] .fal-stage[data-mode=\"synced\"] .fal-line[data-d=\"1\"] { filter: blur(1px); }\n.fal-root[data-anim=\"cinematic\"] .fal-line { letter-spacing: -0.015em; transition-duration: 0.9s, 1.1s, 0.9s, 0.5s, 0.9s; }\n.fal-root[data-anim=\"cinematic\"] .fal-stage[data-mode=\"synced\"] .fal-line { transform: translateY(calc(-50% + 0.45em)) scale(0.97); }\n.fal-root[data-anim=\"cinematic\"] .fal-stage[data-mode=\"synced\"] .fal-line[data-d] { filter: blur(16px); }\n.fal-root[data-anim=\"cinematic\"] .fal-stage[data-mode=\"synced\"] .fal-line[data-d^=\"-\"] { transform: translateY(calc(-50% - 0.45em)) scale(1.03); }\n.fal-root[data-anim=\"cinematic\"] .fal-stage[data-mode=\"synced\"] .fal-line.is-active { filter: none; transform: translateY(-50%) scale(1.05); transition-delay: 0s, 0.14s, 0.14s, 0s, 0s; }\n.fal-root[data-context=\"off\"] .fal-stage[data-mode=\"synced\"] .fal-line:not(.is-active) { opacity: 0 !important; pointer-events: none; }\n.fal-stage[data-mode=\"unsynced\"] { overflow-y: auto; scrollbar-width: none; }\n.fal-stage[data-mode=\"unsynced\"]::-webkit-scrollbar { display: none; }\n.fal-stage[data-mode=\"unsynced\"] .fal-lines { padding: 24vh 0 42vh; }\n.fal-stage[data-mode=\"unsynced\"] .fal-line {\nfont-size: calc(var(--fal-size) * 0.66);\nline-height: 1.28;\npadding: calc(var(--fal-gap) / 3.5) 0;\nopacity: 0.9;\ntransform: none;\ncursor: text;\nuser-select: text;\n}\n.fal-stage[data-mode=\"unsynced\"] .fal-line.is-gap { height: 0.9em; }\n.fal-stage[data-mode=\"unsynced\"] .fal-dots { display: none; }\n.fal-stage.is-entering[data-mode=\"unsynced\"] .fal-lines { animation: fal-fade-up 0.9s var(--fal-ease) backwards; }\n@keyframes fal-fade-up {\nfrom { opacity: 0; transform: translateY(28px); filter: blur(8px); }\n}\n.fal-message {\nposition: absolute;\ninset: 0;\ndisplay: none;\nflex-direction: column;\nalign-items: center;\njustify-content: center;\ngap: 8px;\npadding: 60px 8vw 150px;\ntext-align: center;\n}\n.fal-stage[data-mode=\"message\"] .fal-message { display: flex; }\n.fal-message-art {\nwidth: clamp(120px, 30vh, 280px);\naspect-ratio: 1;\nmargin-bottom: 22px;\nborder-radius: 14px;\noverflow: hidden;\nbox-shadow: 0 30px 80px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.06);\n}\n.fal-message-art img { display: block; width: 100%; height: 100%; object-fit: cover; }\n.fal-message[data-kind=\"loading\"] .fal-message-art { animation: fal-pulse 2.4s ease-in-out infinite; }\n.fal-message-icon { color: rgba(255, 255, 255, 0.55); margin-bottom: 6px; }\n.fal-message-icon:empty { display: none; }\n.fal-message-title { font-family: var(--fal-font); font-size: clamp(22px, calc(var(--fal-size) * 0.6), 40px); font-weight: 800; letter-spacing: -0.02em; line-height: 1.15; }\n.fal-message-detail { min-height: 1.5em; max-width: 520px; font-size: 15px; line-height: 1.5; color: rgba(255, 255, 255, 0.6); }\n.fal-message[data-kind=\"error\"] .fal-message-title { color: #ffb4a8; }\n.fal-message-action { margin-top: 14px; }\n.fal-spinner { display: flex; gap: 7px; margin-bottom: 6px; }\n.fal-spinner i { width: 7px; height: 7px; border-radius: 50%; background: #fff; animation: fal-bounce 1.2s var(--fal-ease) infinite; }\n.fal-spinner i:nth-child(2) { animation-delay: 0.15s; }\n.fal-spinner i:nth-child(3) { animation-delay: 0.3s; }\n.fal-stage.is-entering[data-mode=\"message\"] .fal-message > * { animation: fal-fade-up 0.8s var(--fal-ease) backwards; }\n.fal-stage.is-entering[data-mode=\"message\"] .fal-message > :nth-child(2) { animation-delay: 0.06s; }\n.fal-stage.is-entering[data-mode=\"message\"] .fal-message > :nth-child(3) { animation-delay: 0.12s; }\n.fal-stage.is-entering[data-mode=\"message\"] .fal-message > :nth-child(4) { animation-delay: 0.18s; }\n.fal-stage.is-entering[data-mode=\"message\"] .fal-message > :nth-child(5) { animation-delay: 0.24s; }\n.fal-stage.is-entering[data-mode=\"message\"] .fal-message > .fal-message-art { animation: fal-art-in 1s var(--fal-ease) backwards; }\n@keyframes fal-bounce {\n0%, 100% { transform: translateY(0); opacity: 0.35; }\n40% { transform: translateY(-7px); opacity: 1; }\n}\n@keyframes fal-pulse {\n0%, 100% { transform: scale(1); }\n50% { transform: scale(0.975); }\n}\n@keyframes fal-art-in {\nfrom { opacity: 0; transform: translateY(20px) scale(0.92); filter: blur(10px); }\n}\n:where(.fal-root) button { appearance: none; margin: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; -webkit-app-region: no-drag; }\n.fal-root button:focus-visible,\n.fal-root select:focus-visible,\n.fal-root input:focus-visible,\n.fal-root textarea:focus-visible,\n.fal-progress:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }\n.fal-icon-btn {\ndisplay: inline-grid;\nplace-items: center;\nflex: none;\nwidth: 36px;\nheight: 36px;\nborder-radius: 50%;\ncolor: rgba(255, 255, 255, 0.72);\ntransition: background 0.2s ease, color 0.2s ease, transform 0.25s var(--fal-spring);\n}\n.fal-icon-btn:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }\n.fal-icon-btn:active { transform: scale(0.9); }\n.fal-icon-btn.is-on { color: var(--fal-green); }\n.fal-btn {\ndisplay: inline-flex;\nalign-items: center;\njustify-content: center;\ngap: 8px;\nheight: 36px;\npadding: 0 16px;\nborder-radius: 999px;\nbackground: rgba(255, 255, 255, 0.1);\nfont-size: 13px;\nfont-weight: 700;\ntransition: background 0.2s ease, transform 0.2s var(--fal-spring), box-shadow 0.2s ease;\n}\n.fal-btn svg { width: 16px; height: 16px; }\n.fal-btn:hover { background: rgba(255, 255, 255, 0.17); }\n.fal-btn:active { transform: scale(0.96); }\n.fal-btn:disabled { opacity: 0.4; pointer-events: none; }\n.fal-btn-ghost { background: transparent; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18); }\n.fal-btn-ghost:hover { background: rgba(255, 255, 255, 0.07); }\n.fal-btn-primary { background: #fff; color: #000; }\n.fal-btn-primary:hover { background: #fff; transform: scale(1.03); box-shadow: 0 6px 20px rgba(255, 255, 255, 0.15); }\n.fal-btn-danger { background: transparent; color: #ff8a7a; box-shadow: inset 0 0 0 1px rgba(255, 138, 122, 0.35); }\n.fal-root {\n--fal-toggle-on: color-mix(in oklab, var(--fal-accent) 50%, #fff);\n--fal-ctl: rgba(255, 255, 255, 0.72);\n}\n.fal-player {\nposition: absolute;\nleft: 0;\nright: 0;\nbottom: 0;\nz-index: 3;\ndisplay: grid;\ngrid-template-columns: minmax(0, 1fr) minmax(300px, 640px) minmax(0, 1fr);\nalign-items: end;\ncolumn-gap: 28px;\npadding: 0 var(--fal-pad) 20px;\npointer-events: none;\ntransition: opacity 0.5s ease, transform 0.65s var(--fal-ease);\n}\n.fal-player > * { pointer-events: auto; }\n.fal-player-side { display: flex; align-items: center; gap: 4px; height: 58px; min-width: 0; }\n.fal-player-side.is-left { grid-column: 1; justify-content: flex-start; }\n.fal-player-center { grid-column: 2; display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 0; }\n.fal-player-side.is-right { grid-column: 3; justify-content: flex-end; }\n.fal-root[data-transport=\"off\"] .fal-player-center { display: none; }\n.fal-scrub { width: 100%; }\n.fal-progress { --p: 0; --hx: 0; position: relative; height: 18px; cursor: pointer; touch-action: none; border-radius: 4px; }\n.fal-progress-track {\nposition: absolute;\nleft: 0;\nright: 0;\ntop: 50%;\nheight: 4px;\nmargin-top: -2px;\noverflow: hidden;\nborder-radius: 99px;\nbackground: rgba(255, 255, 255, 0.16);\ntransition: height 0.25s var(--fal-ease), margin 0.25s var(--fal-ease), background 0.25s ease;\n}\n.fal-progress-fill {\nposition: absolute;\ninset: 0;\nborder-radius: inherit;\nbackground: linear-gradient(90deg, rgba(255, 255, 255, 0.75), #fff);\ntransform-origin: 0 50%;\ntransform: scaleX(var(--p));\n}\n.fal-progress-knob-rail { position: absolute; inset: 0; transform: translateX(calc(var(--p) * 100%)); pointer-events: none; }\n.fal-progress-knob {\nposition: absolute;\nleft: -7px;\ntop: 50%;\nwidth: 14px;\nheight: 14px;\nmargin-top: -7px;\nborder-radius: 50%;\nbackground: #fff;\nbox-shadow: 0 2px 10px rgba(0, 0, 0, 0.35), 0 0 0 4px color-mix(in oklab, var(--fal-glow-tint) 25%, transparent);\ntransform: scale(0);\ntransition: transform 0.3s var(--fal-spring);\n}\n.fal-progress:hover .fal-progress-track,\n.fal-progress.is-scrubbing .fal-progress-track { height: 7px; margin-top: -3.5px; background: rgba(255, 255, 255, 0.22); }\n.fal-progress:hover .fal-progress-knob,\n.fal-progress.is-scrubbing .fal-progress-knob,\n.fal-progress:focus-visible .fal-progress-knob { transform: scale(1); }\n.fal-progress.is-scrubbing .fal-progress-knob { transform: scale(1.15); }\n.fal-progress-tip {\nposition: absolute;\nbottom: 20px;\nleft: calc(var(--hx) * 100%);\npadding: 3px 8px;\nborder-radius: 7px;\nbackground: rgba(18, 18, 22, 0.88);\nborder: 1px solid rgba(255, 255, 255, 0.08);\nfont-size: 11.5px;\nfont-weight: 600;\nfont-variant-numeric: tabular-nums;\nwhite-space: nowrap;\npointer-events: none;\nopacity: 0;\ntransform: translate(-50%, 4px);\ntransition: opacity 0.18s ease, transform 0.25s var(--fal-ease);\n}\n.fal-progress:hover .fal-progress-tip,\n.fal-progress.is-scrubbing .fal-progress-tip { opacity: 1; transform: translate(-50%, 0); }\n.fal-times { display: flex; justify-content: space-between; margin-top: 1px; }\n.fal-time { font-size: 11.5px; font-weight: 500; font-variant-numeric: tabular-nums; color: rgba(255, 255, 255, 0.55); }\n.fal-transport { display: flex; align-items: center; gap: 20px; }\n.fal-skip { width: 42px; height: 42px; color: rgba(255, 255, 255, 0.92); }\n.fal-skip svg { width: 22px; height: 22px; }\n.fal-toggle { position: relative; color: rgba(255, 255, 255, 0.5); }\n.fal-toggle.is-on { color: var(--fal-toggle-on); }\n.fal-toggle::after {\ncontent: \"\";\nposition: absolute;\nleft: 50%;\nbottom: 3px;\nwidth: 4px;\nheight: 4px;\nmargin-left: -2px;\nborder-radius: 50%;\nbackground: currentColor;\nopacity: 0;\ntransform: scale(0);\ntransition: opacity 0.2s ease, transform 0.3s var(--fal-spring);\n}\n.fal-toggle.is-on::after { opacity: 1; transform: none; }\n.fal-play-btn {\nposition: relative;\ndisplay: grid;\nplace-items: center;\nwidth: 58px;\nheight: 58px;\nflex: none;\nborder-radius: 50%;\nbackground: #fff;\ncolor: #0b0b0e;\nbox-shadow: 0 10px 30px rgba(0, 0, 0, 0.3), 0 0 0 0 color-mix(in oklab, var(--fal-glow-tint) 30%, transparent);\ntransition: transform 0.35s var(--fal-spring), box-shadow 0.4s ease;\n}\n.fal-play-btn:hover { transform: scale(1.06); box-shadow: 0 12px 34px rgba(0, 0, 0, 0.32), 0 0 0 8px color-mix(in oklab, var(--fal-glow-tint) 16%, transparent); }\n.fal-play-btn:active { transform: scale(0.93); }\n.fal-pp { position: absolute; inset: 0; display: grid; place-items: center; transition: opacity 0.22s ease, transform 0.4s var(--fal-spring); }\n.fal-pp svg { width: 26px; height: 26px; }\n.fal-pp.is-pause { opacity: 0; transform: scale(0.5) rotate(-90deg); }\n.fal-root[data-playing=\"true\"] .fal-pp.is-play { opacity: 0; transform: scale(0.5) rotate(90deg); }\n.fal-root[data-playing=\"true\"] .fal-pp.is-pause { opacity: 1; transform: none; }\n.fal-source {\ndisplay: inline-flex;\nalign-items: center;\ngap: 8px;\nmin-width: 0;\nmax-width: 230px;\nheight: 32px;\npadding: 0 12px 0 10px;\nborder-radius: 99px;\nbackground: rgba(255, 255, 255, 0.07);\nfont-size: 12px;\nfont-weight: 600;\nwhite-space: nowrap;\noverflow: hidden;\ntext-overflow: ellipsis;\ncolor: rgba(255, 255, 255, 0.78);\ntransition: background 0.2s ease, color 0.2s ease;\n}\n.fal-source:hover { background: rgba(255, 255, 255, 0.13); color: #fff; }\n.fal-source::before { content: \"\"; flex: none; width: 7px; height: 7px; border-radius: 50%; background: #777; }\n.fal-source[data-kind=\"synced\"]::before { background: var(--fal-green); }\n.fal-source[data-kind=\"word-synced\"]::before { background: #7cd4ff; box-shadow: 0 0 8px #7cd4ff; }\n.fal-source[data-kind=\"unsynced\"]::before { background: #f5c451; }\n.fal-offset-group { display: inline-flex; align-items: center; flex: none; height: 32px; margin-left: 6px; border-radius: 99px; background: rgba(255, 255, 255, 0.05); }\n.fal-mini-btn { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; color: rgba(255, 255, 255, 0.6); transition: background 0.2s ease, color 0.2s ease; }\n.fal-mini-btn:hover { background: rgba(255, 255, 255, 0.12); color: #fff; }\n.fal-offset { min-width: 54px; height: 30px; font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; text-align: center; color: #fff; }\n.fal-offset.is-zero { color: rgba(255, 255, 255, 0.45); }\n.fal-player-side .fal-icon-btn { color: var(--fal-ctl); }\n.fal-heart { transition: color 0.2s ease, transform 0.35s var(--fal-spring); }\n.fal-heart.is-on { color: var(--fal-green); }\n.fal-heart.is-on svg { animation: fal-heart-pop 0.45s var(--fal-spring); }\n@keyframes fal-heart-pop { 40% { transform: scale(1.3); } }\n.fal-volume { display: flex; align-items: center; }\n.fal-vol {\n--v: 1;\n-webkit-appearance: none;\nappearance: none;\nwidth: 0;\nheight: 18px;\nmargin: 0;\nbackground: transparent;\nopacity: 0;\ncursor: pointer;\ntransition: width 0.35s var(--fal-ease), opacity 0.25s ease, margin 0.35s var(--fal-ease);\n}\n.fal-volume:hover .fal-vol,\n.fal-vol:focus-visible { width: 86px; margin: 0 6px 0 2px; opacity: 1; }\n.fal-vol::-webkit-slider-runnable-track { height: 4px; border-radius: 99px; background: linear-gradient(to right, #fff calc(var(--v) * 100%), rgba(255, 255, 255, 0.18) calc(var(--v) * 100%)); }\n.fal-vol::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; margin-top: -4px; border-radius: 50%; background: #fff; box-shadow: 0 1px 6px rgba(0, 0, 0, 0.4); }\n.fal-vol::-moz-range-track { height: 4px; border-radius: 99px; background: rgba(255, 255, 255, 0.18); }\n.fal-vol::-moz-range-progress { height: 4px; border-radius: 99px; background: #fff; }\n.fal-vol::-moz-range-thumb { width: 12px; height: 12px; border: 0; border-radius: 50%; background: #fff; }\n.fal-player-side .fal-sep { flex: none; width: 1px; height: 20px; margin: 0 6px; background: rgba(255, 255, 255, 0.14); }\n.fal-mini-progress { position: absolute; left: 0; right: 0; bottom: 0; z-index: 3; height: 2px; background: rgba(255, 255, 255, 0.07); opacity: 0; transition: opacity 0.8s ease; pointer-events: none; }\n.fal-mini-fill { height: 100%; background: linear-gradient(90deg, rgba(255, 255, 255, 0.35), rgba(255, 255, 255, 0.75)); transform-origin: 0 50%; transform: scaleX(var(--p, 0)); }\n.fal-root[data-idle=\"true\"] .fal-mini-progress { opacity: 1; transition-delay: 0.3s; }\n.fal-root[data-idle=\"true\"] { cursor: none; }\n.fal-root[data-idle=\"true\"] .fal-chrome { opacity: 0; pointer-events: none; }\n.fal-root[data-idle=\"true\"] .fal-player { transform: translateY(18px); }\n.fal-root[data-idle=\"true\"] .fal-header { transform: translateY(-10px); }\n.fal-root.is-open .fal-player { animation: fal-rise 0.8s var(--fal-ease) 0.1s backwards; }\n.fal-root.is-open .fal-header { animation: fal-drop 0.8s var(--fal-ease) 0.05s backwards; }\n@keyframes fal-rise { from { opacity: 0; transform: translateY(28px); } }\n@keyframes fal-drop { from { opacity: 0; transform: translateY(-14px); } }\n.fal-toast {\nposition: absolute;\nleft: 50%;\nbottom: 150px;\nz-index: 5;\nmax-width: calc(100vw - 32px);\npadding: 9px 18px;\nborder-radius: 999px;\nbackground: rgba(24, 24, 28, 0.82);\nborder: 1px solid rgba(255, 255, 255, 0.1);\nbox-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);\nbackdrop-filter: blur(20px);\nfont-size: 13px;\nfont-weight: 600;\nwhite-space: nowrap;\noverflow: hidden;\ntext-overflow: ellipsis;\nopacity: 0;\npointer-events: none;\ntransform: translate(-50%, 10px) scale(0.96);\ntransition: opacity 0.25s ease, transform 0.4s var(--fal-spring);\n}\n.fal-root[data-transport=\"off\"] .fal-toast { bottom: 84px; }\n.fal-toast.is-on { opacity: 1; transform: translate(-50%, 0) scale(1); }\n.fal-root { --fal-safe-top: 52px; }\n.fal-root[data-fs=\"true\"] { --fal-safe-top: 12px; }\n.fal-panel {\nposition: absolute;\ntop: var(--fal-safe-top);\nright: 12px;\nbottom: 12px;\nz-index: 4;\nwidth: min(520px, calc(100vw - 24px));\ndisplay: grid;\ngrid-template-columns: 76px minmax(0, 1fr);\noverflow: hidden;\nborder-radius: 22px;\nbackground: linear-gradient(180deg, rgba(32, 32, 38, 0.86), rgba(18, 18, 22, 0.9));\nborder: 1px solid rgba(255, 255, 255, 0.08);\nbox-shadow: 0 40px 100px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.06);\nbackdrop-filter: blur(40px) saturate(1.5);\nfont-size: 14px;\n-webkit-app-region: no-drag;\nopacity: 0;\nvisibility: hidden;\ntransform: translateX(28px) scale(0.985);\ntransform-origin: right center;\ntransition: transform 0.5s var(--fal-ease), opacity 0.3s ease, visibility 0s linear 0.5s;\n}\n.fal-panel.is-open { opacity: 1; visibility: visible; transform: none; transition-delay: 0s; }\n.fal-panel [hidden] { display: none !important; }\n.fal-rail {\nposition: relative;\ndisplay: flex;\nflex-direction: column;\ngap: 4px;\npadding: 14px 8px;\nbackground: rgba(0, 0, 0, 0.18);\nborder-right: 1px solid rgba(255, 255, 255, 0.05);\n}\n.fal-rail-btn {\nposition: relative;\nz-index: 1;\ndisplay: flex;\nflex-direction: column;\nalign-items: center;\njustify-content: center;\ngap: 5px;\nheight: 62px;\nborder-radius: 14px;\ncolor: rgba(255, 255, 255, 0.5);\ntransition: color 0.25s ease, background 0.25s ease;\n}\n.fal-rail-btn:hover { color: rgba(255, 255, 255, 0.88); background: rgba(255, 255, 255, 0.04); }\n.fal-rail-btn[aria-selected=\"true\"] { color: #fff; background: none; }\n.fal-rail-icon { display: grid; transition: transform 0.35s var(--fal-spring); }\n.fal-rail-btn[aria-selected=\"true\"] .fal-rail-icon { transform: translateY(-1px) scale(1.06); }\n.fal-rail-icon svg { width: 21px; height: 21px; }\n.fal-rail-label { font-size: 10.5px; font-weight: 650; letter-spacing: 0.01em; }\n.fal-rail-pill {\nposition: absolute;\ntop: 14px;\nleft: 8px;\nright: 8px;\nheight: 62px;\nborder-radius: 14px;\nbackground: rgba(255, 255, 255, 0.1);\nbox-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.07);\ntransform: translateY(calc(var(--i, 1) * 66px));\ntransition: transform 0.45s var(--fal-ease), opacity 0.2s ease;\n}\n.fal-rail-pill::before { content: \"\"; position: absolute; left: -8px; top: 20px; bottom: 20px; width: 3px; border-radius: 0 3px 3px 0; background: var(--fal-toggle-on); }\n.fal-panel[data-searching=\"true\"] .fal-rail-pill { opacity: 0; }\n.fal-panel-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }\n.fal-panel-head {\ndisplay: grid;\ngrid-template-columns: minmax(0, 1fr) auto;\nalign-items: start;\ngap: 14px 8px;\npadding: 18px 14px 14px 20px;\nborder-bottom: 1px solid rgba(255, 255, 255, 0.05);\n}\n.fal-panel-title { font-family: var(--fal-font); font-size: 21px; font-weight: 800; line-height: 1.15; letter-spacing: -0.02em; }\n.fal-panel-sub { margin-top: 3px; font-size: 12.5px; color: rgba(255, 255, 255, 0.5); }\n.fal-panel-close { margin: -4px -2px 0 0; background: rgba(255, 255, 255, 0.06); }\n.fal-panel-close:hover { background: rgba(255, 255, 255, 0.14); }\n.fal-search-wrap { grid-column: 1 / -1; position: relative; display: block; }\n.fal-search-icon { position: absolute; left: 11px; top: 50%; display: grid; transform: translateY(-50%); color: rgba(255, 255, 255, 0.45); pointer-events: none; }\n.fal-search {\nwidth: 100%;\nheight: 36px;\npadding: 0 12px 0 34px;\nborder: 1px solid rgba(255, 255, 255, 0.08);\nborder-radius: 11px;\nbackground: rgba(0, 0, 0, 0.25);\ncolor: #fff;\nfont: inherit;\nfont-size: 13px;\noutline: none;\ntransition: border-color 0.2s ease, background 0.2s ease;\n}\n.fal-search::placeholder { color: rgba(255, 255, 255, 0.4); }\n.fal-search:focus { border-color: rgba(255, 255, 255, 0.28); background: rgba(0, 0, 0, 0.35); }\n.fal-search::-webkit-search-cancel-button { filter: invert(1) opacity(0.5); cursor: pointer; }\n.fal-panel-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 16px 24px 18px; scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.15) transparent; }\n.fal-panel-scroll::-webkit-scrollbar { width: 8px; }\n.fal-panel-scroll::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 99px; background: rgba(255, 255, 255, 0.15) padding-box; }\n.fal-panel.is-open .fal-tab-body:not([hidden]) > * { animation: fal-fade-up 0.5s var(--fal-ease) backwards; }\n.fal-panel.is-open .fal-tab-body:not([hidden]) > :nth-child(2) { animation-delay: 0.04s; }\n.fal-panel.is-open .fal-tab-body:not([hidden]) > :nth-child(3) { animation-delay: 0.08s; }\n.fal-panel.is-open .fal-tab-body:not([hidden]) > :nth-child(n + 4) { animation-delay: 0.12s; }\n.fal-no-results { padding: 48px 0; text-align: center; font-size: 13px; color: rgba(255, 255, 255, 0.5); }\n.fal-tab-body[data-tab=\"track\"] > .fal-np { margin: 14px 0 4px; }\n@media (max-width: 600px) {\n.fal-panel { grid-template-columns: 58px minmax(0, 1fr); }\n.fal-rail-label { display: none; }\n.fal-rail-btn, .fal-rail-pill { height: 50px; }\n.fal-rail-pill { transform: translateY(calc(var(--i, 1) * 54px)); }\n}\n.fal-section h3 { margin: 22px 4px 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: rgba(255, 255, 255, 0.45); }\n.fal-section-card { padding: 2px 14px; border-radius: 14px; background: rgba(255, 255, 255, 0.045); border: 1px solid rgba(255, 255, 255, 0.05); }\n.fal-section-card > .fal-row + .fal-row { border-top: 1px solid rgba(255, 255, 255, 0.06); }\n.fal-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 46px; padding: 10px 0; cursor: pointer; transition: opacity 0.2s ease; }\n.fal-row > span, .fal-row-label > span { font-size: 13.5px; color: rgba(255, 255, 255, 0.9); }\n.fal-row.is-disabled { opacity: 0.35; pointer-events: none; }\n.fal-row-stack, .fal-row-range { flex-direction: column; align-items: stretch; gap: 10px; cursor: default; }\n.fal-row-range { gap: 6px; cursor: pointer; }\n.fal-row-label { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }\n.fal-range-value { font-size: 12px; font-variant-numeric: tabular-nums; color: rgba(255, 255, 255, 0.55); }\n.fal-range { --p: 50%; -webkit-appearance: none; appearance: none; width: 100%; height: 18px; margin: 0; background: transparent; cursor: pointer; }\n.fal-range::-webkit-slider-runnable-track { height: 4px; border-radius: 99px; background: linear-gradient(to right, #fff var(--p), rgba(255, 255, 255, 0.16) var(--p)); }\n.fal-range::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; margin-top: -6px; border-radius: 50%; background: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45); transition: transform 0.2s var(--fal-spring); }\n.fal-range:hover::-webkit-slider-thumb { transform: scale(1.12); }\n.fal-range:active::-webkit-slider-thumb { transform: scale(1.25); }\n.fal-range::-moz-range-track { height: 4px; border-radius: 99px; background: rgba(255, 255, 255, 0.16); }\n.fal-range::-moz-range-progress { height: 4px; border-radius: 99px; background: #fff; }\n.fal-range::-moz-range-thumb { width: 16px; height: 16px; border: 0; border-radius: 50%; background: #fff; }\n.fal-switch { appearance: none; position: relative; flex: none; width: 40px; height: 24px; margin: 0; border-radius: 99px; background: rgba(255, 255, 255, 0.2); cursor: pointer; transition: background 0.25s ease; }\n.fal-switch::before { content: \"\"; position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35); transition: transform 0.35s var(--fal-spring); }\n.fal-switch:checked { background: var(--fal-green); }\n.fal-switch:checked::before { transform: translateX(16px); }\n.fal-segmented { display: flex; gap: 2px; padding: 3px; border-radius: 11px; background: rgba(0, 0, 0, 0.28); }\n.fal-seg { flex: 1; display: grid; place-items: center; height: 30px; border-radius: 8px; font-size: 12.5px; font-weight: 600; color: rgba(255, 255, 255, 0.6); transition: background 0.25s ease, color 0.2s ease, box-shadow 0.25s ease; }\n.fal-seg:hover { color: #fff; }\n.fal-seg[aria-checked=\"true\"] { background: rgba(255, 255, 255, 0.16); color: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3); }\n.fal-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(98px, 1fr)); gap: 8px; }\n.fal-card, .fal-font {\ndisplay: flex;\nflex-direction: column;\ngap: 2px;\npadding: 10px;\nborder-radius: 12px;\nbackground: rgba(255, 255, 255, 0.05);\nborder: 1px solid rgba(255, 255, 255, 0.06);\ntext-align: left;\ntransition: background 0.2s ease, border-color 0.2s ease, transform 0.25s var(--fal-spring);\n}\n.fal-card:hover, .fal-font:hover { background: rgba(255, 255, 255, 0.09); }\n.fal-card:active, .fal-font:active { transform: scale(0.97); }\n.fal-card[aria-checked=\"true\"], .fal-font[aria-checked=\"true\"] { background: rgba(30, 215, 96, 0.12); border-color: rgba(30, 215, 96, 0.75); }\n.fal-card-art { display: block; width: 100%; height: 38px; margin-bottom: 6px; color: rgba(255, 255, 255, 0.8); }\n.fal-card-art svg { width: 100%; height: 100%; fill: currentColor; }\n.fal-card[aria-checked=\"true\"] .fal-card-art { color: var(--fal-green); }\n.fal-card-name { font-size: 13px; font-weight: 700; }\n.fal-card-hint { font-size: 11px; color: rgba(255, 255, 255, 0.5); }\n.fal-fonts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }\n.fal-font { align-items: center; text-align: center; }\n.fal-font-sample { font-size: 26px; font-weight: 800; line-height: 1.1; letter-spacing: -0.02em; }\n.fal-font-name { font-size: 11px; color: rgba(255, 255, 255, 0.55); }\n.fal-select { max-width: 200px; padding: 6px 8px; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px; background: rgba(255, 255, 255, 0.07); color: #fff; font: inherit; font-size: 13px; }\n.fal-select option { background: #222; color: #fff; }\n.fal-panel-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }\n.fal-hint { margin: 14px 2px 0; font-size: 12px; line-height: 1.55; color: rgba(255, 255, 255, 0.45); }\n.fal-keys { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; margin-top: 20px; padding: 12px 14px; border-radius: 14px; background: rgba(255, 255, 255, 0.03); font-size: 12px; color: rgba(255, 255, 255, 0.6); }\n.fal-key { display: flex; align-items: center; gap: 8px; }\n.fal-key kbd { flex: none; min-width: 24px; padding: 2px 6px; border-radius: 5px; background: rgba(255, 255, 255, 0.1); box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.12); font: 600 11px/1.4 var(--fal-ui-font); color: #fff; text-align: center; }\n.fal-track-info { display: flex; align-items: center; gap: 14px; margin: 14px 0; }\n.fal-track-art { width: 60px; height: 60px; flex: none; border-radius: 8px; object-fit: cover; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4); }\n.fal-track-text { min-width: 0; }\n.fal-track-title { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.fal-track-sub { margin-top: 2px; font-size: 12.5px; color: rgba(255, 255, 255, 0.6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.fal-track-chip { display: inline-block; margin-top: 7px; padding: 3px 9px; border-radius: 99px; background: rgba(255, 255, 255, 0.08); font-size: 11.5px; font-weight: 600; color: rgba(255, 255, 255, 0.75); }\n.fal-textarea {\ndisplay: block;\nwidth: 100%;\nmin-height: 280px;\npadding: 12px 14px;\nresize: vertical;\nborder: 1px solid rgba(255, 255, 255, 0.1);\nborder-radius: 12px;\nbackground: rgba(0, 0, 0, 0.32);\ncolor: #fff;\nfont: 12px/1.6 ui-monospace, \"Cascadia Code\", Consolas, monospace;\nuser-select: text;\ntransition: border-color 0.2s ease, background 0.2s ease;\n}\n.fal-textarea:focus { border-color: rgba(255, 255, 255, 0.3); outline: none; }\n.fal-textarea.is-drop { border-color: var(--fal-green); background: rgba(30, 215, 96, 0.08); }\n.fal-root { --fal-split-w: clamp(320px, 40vw, 600px); }\n.fal-side {\nposition: absolute;\ntop: 0;\nbottom: 0;\nleft: 0;\nz-index: 1;\nwidth: var(--fal-split-w);\ndisplay: none;\nflex-direction: column;\nalign-items: center;\njustify-content: center;\ngap: 24px;\npadding: 64px 2vw 150px calc(var(--fal-pad) * 0.8);\n}\n.fal-art-wrap {\nposition: relative;\ndisplay: block;\nwidth: min(100%, 52vh, 460px);\naspect-ratio: 1;\nflex: none;\nborder-radius: 14px;\ncursor: pointer;\nbox-shadow: 0 40px 90px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.06);\ntransition: transform 0.8s var(--fal-spring), box-shadow 0.8s ease;\n}\n.fal-root[data-playing=\"false\"] .fal-art-wrap { transform: scale(0.86); box-shadow: 0 18px 44px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.05); }\n.fal-art-wrap:active { transform: scale(0.97); }\n.fal-root[data-playing=\"false\"] .fal-art-wrap:active { transform: scale(0.84); }\n.fal-art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; border-radius: inherit; opacity: 0; transition: opacity 0.9s ease; }\n.fal-art.is-on { opacity: 1; }\n.fal-art-hint {\nposition: absolute;\nleft: 50%;\ntop: 50%;\ndisplay: grid;\nplace-items: center;\nwidth: 64px;\nheight: 64px;\nmargin: -32px 0 0 -32px;\nborder-radius: 50%;\nbackground: rgba(0, 0, 0, 0.45);\nbackdrop-filter: blur(10px);\ncolor: #fff;\nopacity: 0;\ntransform: scale(0.8);\ntransition: opacity 0.25s ease, transform 0.35s var(--fal-spring);\n}\n.fal-art-hint svg { width: 28px; height: 28px; }\n.fal-art-wrap:hover .fal-art-hint, .fal-art-wrap:focus-visible .fal-art-hint { opacity: 1; transform: none; }\n.fal-side-meta { width: min(100%, 52vh, 460px); min-width: 0; }\n.fal-side-title {\ndisplay: -webkit-box;\noverflow: hidden;\n-webkit-line-clamp: 2;\n-webkit-box-orient: vertical;\nfont-family: var(--fal-font);\nfont-size: clamp(20px, 2.1vw, 30px);\nfont-weight: 800;\nline-height: 1.15;\nletter-spacing: -0.02em;\n}\n.fal-side-artist, .fal-side-album { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }\n.fal-side-artist { margin-top: 6px; font-size: 15px; color: rgba(255, 255, 255, 0.7); }\n.fal-side-album { margin-top: 2px; font-size: 13px; color: rgba(255, 255, 255, 0.45); }\n.fal-root.is-open .fal-side { animation: fal-art-in 0.9s var(--fal-ease) 0.05s backwards; }\n.fal-disc { position: absolute; inset: 0; border-radius: inherit; overflow: hidden; }\n.fal-disc-grooves, .fal-disc-shine { display: none; }\n@media (min-width: 900px) and (min-height: 540px) {\n.fal-root:is([data-view=\"split\"], [data-view=\"mirror\"], [data-view=\"poster\"], [data-view=\"vinyl\"]) .fal-side { display: flex; }\n.fal-root:is([data-view=\"split\"], [data-view=\"mirror\"], [data-view=\"poster\"], [data-view=\"vinyl\"]) :is(.fal-header, .fal-message-art) { display: none; }\n.fal-root:is([data-view=\"split\"], [data-view=\"vinyl\"]) .fal-stage { left: var(--fal-split-w); padding-left: 2.5vw; --fal-size: min(var(--fal-fs), 4.6vw, 10.5vh); }\n.fal-root[data-view=\"mirror\"] .fal-side { left: auto; right: 0; padding: 64px calc(var(--fal-pad) * 0.8) 150px 2vw; }\n.fal-root[data-view=\"mirror\"] .fal-stage { right: var(--fal-split-w); padding-right: 2.5vw; --fal-size: min(var(--fal-fs), 4.6vw, 10.5vh); }\n.fal-root[data-view=\"poster\"] { --fal-poster-w: clamp(360px, 46vw, 820px); }\n.fal-root[data-view=\"poster\"] .fal-side { width: var(--fal-poster-w); padding: 0; display: block; }\n.fal-root[data-view=\"poster\"] .fal-art-wrap {\nposition: absolute;\ninset: 0;\nwidth: 100%;\nheight: 100%;\naspect-ratio: auto;\nborder-radius: 0;\nbox-shadow: none;\n-webkit-mask-image: linear-gradient(to right, #000 45%, transparent 98%), linear-gradient(to top, transparent 0, #000 42%);\n-webkit-mask-composite: source-in;\nmask-image: linear-gradient(to right, #000 45%, transparent 98%), linear-gradient(to top, transparent 0, #000 42%);\nmask-composite: intersect;\ntransition: opacity 0.8s ease, filter 0.8s ease;\n}\n.fal-root[data-view=\"poster\"][data-playing=\"false\"] .fal-art-wrap { transform: none; box-shadow: none; filter: saturate(0.6) brightness(0.8); }\n.fal-root[data-view=\"poster\"] .fal-art-wrap:active { transform: none; }\n.fal-root[data-view=\"poster\"] .fal-art-hint { left: 40%; }\n.fal-root[data-view=\"poster\"] .fal-side-meta { position: absolute; left: var(--fal-pad); bottom: 150px; width: min(34vw, 560px); text-shadow: 0 2px 24px rgba(0, 0, 0, 0.45); }\n.fal-root[data-view=\"poster\"] .fal-side-title { font-size: clamp(28px, 3.4vw, 54px); line-height: 1.05; }\n.fal-root[data-view=\"poster\"] .fal-side-artist { font-size: clamp(15px, 1.3vw, 19px); color: rgba(255, 255, 255, 0.82); }\n.fal-root[data-view=\"poster\"] .fal-stage { left: calc(var(--fal-poster-w) * 0.9); padding-left: 2vw; --fal-size: min(var(--fal-fs), 4.4vw, 10.5vh); }\n.fal-root[data-view=\"vinyl\"] .fal-art-wrap { border-radius: 50%; box-shadow: 0 40px 90px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05); }\n.fal-root[data-view=\"vinyl\"] .fal-disc {\nborder-radius: 50%;\nbackground:\nradial-gradient(circle, transparent 0 21%, rgba(255, 255, 255, 0.07) 21.3%, transparent 22%),\nradial-gradient(circle, #1b1b1f 0 60%, #111114 100%);\nanimation: fal-spin-disc 7.5s linear infinite;\nanimation-play-state: paused;\n}\n.fal-root[data-view=\"vinyl\"][data-playing=\"true\"] .fal-disc { animation-play-state: running; }\n.fal-root[data-view=\"vinyl\"] .fal-disc-grooves {\ndisplay: block;\nposition: absolute;\ninset: 0;\nborder-radius: 50%;\nbackground: repeating-radial-gradient(circle, rgba(255, 255, 255, 0.035) 0 1px, rgba(255, 255, 255, 0.012) 1.6px, transparent 2.4px 4px);\n-webkit-mask-image: radial-gradient(circle, transparent 0 33%, #000 34% 96%, transparent 97%);\nmask-image: radial-gradient(circle, transparent 0 33%, #000 34% 96%, transparent 97%);\n}\n.fal-root[data-view=\"vinyl\"] .fal-art { inset: 31%; width: 38%; height: 38%; border-radius: 50%; }\n.fal-root[data-view=\"vinyl\"] .fal-disc::after { content: \"\"; position: absolute; left: 50%; top: 50%; width: 3.2%; height: 3.2%; margin: -1.6% 0 0 -1.6%; border-radius: 50%; background: #0b0b0e; box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.08); }\n.fal-root[data-view=\"vinyl\"] .fal-disc-shine {\ndisplay: block;\nposition: absolute;\ninset: 0;\nborder-radius: 50%;\npointer-events: none;\nbackground: conic-gradient(from 20deg, transparent 0 8%, rgba(255, 255, 255, 0.1) 13%, transparent 20% 52%, rgba(255, 255, 255, 0.08) 60%, transparent 68%);\n-webkit-mask-image: radial-gradient(circle, transparent 0 32%, #000 36%);\nmask-image: radial-gradient(circle, transparent 0 32%, #000 36%);\n}\n.fal-root[data-view=\"vinyl\"] .fal-art-hint { z-index: 1; }\n.fal-root[data-view=\"vinyl\"] .fal-side-meta { text-align: center; }\n}\n@keyframes fal-spin-disc { to { rotate: 360deg; } }\n@media (min-height: 600px) {\n.fal-root:is([data-view=\"stage\"], [data-view=\"captions\"]) .fal-side { display: flex; left: 0; right: 0; width: auto; }\n.fal-root:is([data-view=\"stage\"], [data-view=\"captions\"]) :is(.fal-header, .fal-message-art) { display: none; }\n.fal-root:is([data-view=\"stage\"], [data-view=\"captions\"]) .fal-stage { --fal-origin: 50%; text-align: center; }\n.fal-root:is([data-view=\"stage\"], [data-view=\"captions\"]) .fal-line { margin-inline: auto; }\n.fal-root:is([data-view=\"stage\"], [data-view=\"captions\"]) .fal-side-meta { width: auto; min-width: 0; }\n.fal-root[data-view=\"stage\"] .fal-side { flex-direction: row; justify-content: center; bottom: auto; gap: 18px; padding: calc(var(--fal-safe-top) - 16px) var(--fal-pad) 0; }\n.fal-root[data-view=\"stage\"] .fal-art-wrap { width: clamp(84px, 14vh, 150px); border-radius: 10px; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5); }\n.fal-root[data-view=\"stage\"][data-playing=\"false\"] .fal-art-wrap { transform: scale(0.9); }\n.fal-root[data-view=\"stage\"] .fal-art-hint { width: 44px; height: 44px; margin: -22px 0 0 -22px; }\n.fal-root[data-view=\"stage\"] .fal-side-meta { max-width: 42vw; }\n.fal-root[data-view=\"stage\"] .fal-side-title { font-size: clamp(18px, 2.4vh, 26px); }\n.fal-root[data-view=\"stage\"] .fal-stage { top: calc(var(--fal-safe-top) + clamp(84px, 14vh, 150px)); }\n.fal-root[data-view=\"captions\"] .fal-side { flex-direction: column; justify-content: center; top: 0; bottom: 40vh; gap: 14px; padding: calc(var(--fal-safe-top) - 8px) var(--fal-pad) 0; }\n.fal-root[data-view=\"captions\"] .fal-art-wrap { width: min(34vh, 380px); }\n.fal-root[data-view=\"captions\"] .fal-side-meta { text-align: center; }\n.fal-root[data-view=\"captions\"] .fal-side-title { font-size: clamp(18px, 2.4vh, 26px); }\n.fal-root[data-view=\"captions\"] .fal-stage {\ntop: 58vh;\nbottom: 104px;\n--fal-size: min(calc(var(--fal-fs) * 0.8), 4.4vw, 5.6vh);\n-webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 14%, #000 86%, transparent 100%);\nmask-image: linear-gradient(to bottom, transparent 0, #000 14%, #000 86%, transparent 100%);\n}\n.fal-root[data-view=\"captions\"] .fal-stage[data-mode=\"synced\"] .fal-line:not(.is-active):not([data-d=\"1\"]) { opacity: 0 !important; pointer-events: none; }\n.fal-root[data-view=\"captions\"][data-layout=\"list\"] .fal-stage[data-mode=\"synced\"] .fal-line[data-d=\"1\"] { opacity: 0.4; }\n}\n.fal-root.fal-view-swap :is(.fal-side, .fal-stage) { animation: fal-fade-up 0.7s var(--fal-ease) both; }\n.fal-np {\ndisplay: flex;\nalign-items: center;\ngap: 12px;\nmargin: 2px 14px 8px;\npadding: 10px;\nborder-radius: 14px;\nbackground: linear-gradient(135deg, color-mix(in srgb, var(--fal-accent) 18%, transparent), rgba(255, 255, 255, 0.04));\nborder: 1px solid rgba(255, 255, 255, 0.07);\n}\n.fal-np img { width: 50px; height: 50px; flex: none; border-radius: 8px; object-fit: cover; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4); }\n.fal-np-text { min-width: 0; flex: 1; }\n.fal-np-title, .fal-np-sub { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }\n.fal-np-title { font-size: 14px; font-weight: 700; }\n.fal-np-sub { margin-top: 2px; font-size: 12px; color: rgba(255, 255, 255, 0.6); }\n.fal-np-chip { flex: none; padding: 3px 8px; border-radius: 99px; background: rgba(255, 255, 255, 0.09); font-size: 11px; font-weight: 700; color: rgba(255, 255, 255, 0.8); }\n.fal-prov-list { display: flex; flex-direction: column; gap: 6px; }\n.fal-prov {\ndisplay: grid;\ngrid-template-columns: auto 1fr auto auto;\nalign-items: center;\ngap: 10px;\npadding: 10px 10px 10px 8px;\nborder-radius: 12px;\nbackground: rgba(0, 0, 0, 0.22);\ntransition: opacity 0.2s ease, background 0.2s ease;\n}\n.fal-prov.is-off { opacity: 0.45; }\n.fal-prov-rank { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: rgba(255, 255, 255, 0.1); font-size: 11px; font-weight: 700; }\n.fal-prov-name { font-size: 13.5px; font-weight: 700; }\n.fal-prov-badge { margin-left: 6px; padding: 1px 6px; border-radius: 99px; background: rgba(124, 212, 255, 0.16); color: #7cd4ff; font-size: 10px; font-weight: 700; vertical-align: 1px; }\n.fal-prov-desc { margin-top: 2px; font-size: 11.5px; line-height: 1.35; color: rgba(255, 255, 255, 0.5); }\n.fal-prov-move { display: flex; flex-direction: column; }\n.fal-prov-move button { display: grid; place-items: center; width: 24px; height: 18px; border-radius: 6px; color: rgba(255, 255, 255, 0.6); }\n.fal-prov-move button:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }\n.fal-prov-move button:disabled { opacity: 0.2; pointer-events: none; }\n.fal-prov-move svg { width: 14px; height: 14px; }\n.fal-src-title { margin: 16px 2px 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: rgba(255, 255, 255, 0.45); }\n.fal-src-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }\n.fal-src-btn {\ndisplay: flex;\nalign-items: center;\njustify-content: space-between;\ngap: 6px;\nmin-height: 36px;\npadding: 6px 10px;\nborder-radius: 10px;\nbackground: rgba(255, 255, 255, 0.06);\nfont-size: 12.5px;\nfont-weight: 600;\ntext-align: left;\ntransition: background 0.2s ease, box-shadow 0.2s ease;\n}\n.fal-src-btn:hover { background: rgba(255, 255, 255, 0.11); }\n.fal-src-btn small { font-size: 10.5px; font-weight: 600; color: rgba(255, 255, 255, 0.5); }\n.fal-src-btn.is-current { background: rgba(30, 215, 96, 0.13); box-shadow: inset 0 0 0 1px rgba(30, 215, 96, 0.6); }\n.fal-src-btn.is-loading small { animation: fal-blink 1s ease-in-out infinite; }\n.fal-test-btn { width: 100%; margin-top: 8px; }\n@keyframes fal-blink { 50% { opacity: 0.3; } }\n@media (max-width: 1100px) {\n.fal-offset-group { display: none; }\n.fal-source { max-width: 160px; }\n}\n@media (max-width: 780px) {\n.fal-root { --fal-pad: 22px; }\n.fal-header { top: 18px; max-width: calc(100vw - 44px); }\n.fal-cover { width: 44px; height: 44px; }\n.fal-player { column-gap: 10px; padding-bottom: 12px; grid-template-columns: auto minmax(0, 1fr) auto; }\n.fal-source { width: 32px; padding: 0; justify-content: center; font-size: 0; }\n.fal-source::before { width: 9px; height: 9px; }\n.fal-transport { gap: 8px; }\n.fal-play-btn { width: 50px; height: 50px; }\n.fal-player-side { height: 50px; }\n}\n@media (max-width: 600px) {\n.fal-offset-group,\n.fal-volume,\n.fal-player-side .fal-sep,\n.fal-heart,\n.fal-toggle { display: none; }\n.fal-player-side .fal-icon-btn { width: 34px; height: 34px; }\n}\n@media (max-height: 540px) {\n.fal-header { display: none; }\n.fal-message-art { display: none; }\n}\n.fal-no-anim .fal-line,\n.fal-no-anim .fal-w,\n.fal-no-anim .fal-c { transition: none !important; }\n.fal-root[data-motion=\"reduced\"] { transform: none !important; transition: opacity 0.2s ease; }\n.fal-root[data-motion=\"reduced\"] .fal-line,\n.fal-root[data-motion=\"reduced\"] .fal-w,\n.fal-root[data-motion=\"reduced\"] .fal-player,\n.fal-root[data-motion=\"reduced\"] .fal-header,\n.fal-root[data-motion=\"reduced\"] .fal-panel,\n.fal-root[data-motion=\"reduced\"] .fal-rail-pill {\ntransition-property: opacity, color, visibility !important;\ntransition-duration: 0.2s !important;\ntransition-delay: 0s !important;\n}\n.fal-root[data-motion=\"reduced\"] *,\n.fal-root[data-motion=\"reduced\"] *::before { animation: none !important; }\n.fal-root[data-motion=\"reduced\"] .fal-line[data-d] { filter: none !important; }\n.fal-root[data-motion=\"reduced\"] .fal-w,\n.fal-root[data-motion=\"reduced\"] .fal-c { transform: none !important; }\n[data-testid=\"lyrics-npv-section\"][data-fal-hidden] { display: none !important; }\n.fal-npv {\n--npv-c: #3a3a46;\nposition: relative;\noverflow: hidden;\npadding: 16px 16px 10px;\nborder-radius: 8px;\ncolor: #fff;\nfont-family: var(--encore-body-font-stack, \"SpotifyMixUI\", \"CircularSp\", system-ui, sans-serif);\nbackground:\nradial-gradient(120% 90% at 0% 0%, color-mix(in oklab, var(--npv-c) 80%, #fff 6%) 0%, transparent 70%),\nlinear-gradient(165deg, color-mix(in oklab, var(--npv-c) 72%, #000) 0%, color-mix(in oklab, var(--npv-c) 38%, #0d0d10) 100%);\nbox-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);\ntransition: background 0.8s ease;\n}\n.fal-npv-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; min-width: 0; }\n.fal-npv-title { margin: 0; font-size: 16px; font-weight: 700; }\n.fal-npv-src { min-width: 0; overflow: hidden; padding: 2px 8px; border-radius: 99px; background: rgba(255, 255, 255, 0.1); font-size: 11px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; color: rgba(255, 255, 255, 0.72); }\n.fal-npv-src:empty { display: none; }\n.fal-npv-open {\ndisplay: grid;\nflex: none;\nplace-items: center;\nwidth: 32px;\nheight: 32px;\nmargin-left: auto;\npadding: 0;\nborder: 0;\nborder-radius: 50%;\nbackground: rgba(255, 255, 255, 0.1);\ncolor: rgba(255, 255, 255, 0.8);\ncursor: pointer;\ntransition: background 0.2s ease, color 0.2s ease, transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);\n}\n.fal-npv-open:hover { background: rgba(255, 255, 255, 0.2); color: #fff; transform: scale(1.08); }\n.fal-npv-open svg { width: 16px; height: 16px; }\n.fal-npv-body {\nposition: relative;\nheight: 204px;\noverflow: hidden;\ncursor: pointer;\n-webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 14%, #000 78%, transparent 100%);\nmask-image: linear-gradient(to bottom, transparent 0, #000 14%, #000 78%, transparent 100%);\n}\n.fal-npv-lines { padding-top: 6px; will-change: transform; transition: transform 0.75s cubic-bezier(0.22, 1, 0.36, 1); }\n.fal-npv-lines.no-anim { transition: none; }\n.fal-npv-line {\nmargin: 0 -8px;\npadding: 5px 8px;\nborder-radius: 8px;\nfont-size: 19px;\nfont-weight: 700;\nline-height: 1.32;\nletter-spacing: -0.01em;\ncolor: rgba(255, 255, 255, 0.42);\ntransition: color 0.45s ease, background 0.2s ease, text-shadow 0.6s ease;\n}\n.fal-npv-line.is-past { color: rgba(255, 255, 255, 0.7); }\n.fal-npv-line.is-active { color: #fff; text-shadow: 0 0 18px rgba(255, 255, 255, 0.25); }\n.fal-npv-line.is-gap { letter-spacing: 0.15em; }\n.fal-npv-line[title]:hover { background: rgba(255, 255, 255, 0.09); color: rgba(255, 255, 255, 0.92); }\n.fal-npv-line.is-active:has(.fal-npv-w) { text-shadow: none; }\n.fal-npv-line.is-active .fal-npv-w { color: rgba(255, 255, 255, 0.42); }\n.fal-npv-line.is-active .fal-npv-w.sung { color: #fff; }\n.fal-npv-line.is-active .fal-npv-w.now {\ncolor: transparent;\nbackground: linear-gradient(90deg, #fff calc(var(--fal-wp, 0) * (100% + 0.6em) - 0.6em), rgba(255, 255, 255, 0.42) calc(var(--fal-wp, 0) * (100% + 0.6em)));\n-webkit-background-clip: text;\nbackground-clip: text;\n}\n.fal-npv.is-unsynced .fal-npv-line { color: rgba(255, 255, 255, 0.85); font-size: 16px; }\n.fal-npv-msg { position: absolute; inset: 0; display: grid; place-items: center; padding: 0 16px; font-size: 13px; text-align: center; color: rgba(255, 255, 255, 0.62); }\n.fal-npv-msg:empty { display: none; }\n.fal-npv-tr { margin-top: 2px; font-size: 13px; font-weight: 600; line-height: 1.3; color: rgba(255, 255, 255, 0.55); }\n.fal-npv-line.is-active .fal-npv-tr { color: rgba(255, 255, 255, 0.85); }";

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
//  - "list"  (flow, slide, scale): lines in a column. The list publishes --fal-y (the
//            scroll offset); every line applies it in its own transform, so each line can
//            transition with its own delay — that's the staggered "wave" in Flow.
//  - "stack" (fade, cinematic): lines absolutely stacked at the centre; the active line's
//            height is published as --fal-ah so neighbours sit above/below it.


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
	 * @param {{ onSeek?: (ms:number)=>void }} opts
	 */
	constructor(stage, opts = {}) {
		this.stage = stage;
		this.onSeek = opts.onSeek;
		this.list = h("div", { class: "fal-lines" });
		this.message = h("div", { class: "fal-message", role: "status" });
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
					? h("div", { class: "fal-message-art" }, h("img", { src: opts.image, alt: "", decoding: "async" }))
					: h("div", { class: "fal-message-icon", html: opts.icon || "" }),
				kind === "loading" && h("div", { class: "fal-spinner", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
				h("div", { class: "fal-message-title" }, title),
				h("div", { class: "fal-message-detail" }, detail || ""),
				opts.action && h("button", { class: "fal-btn fal-btn-primary fal-message-action", onclick: opts.action.onClick }, opts.action.label),
			];
			this.message.replaceChildren(...parts.filter(Boolean)); // replaceChildren would stringify null
		});
	}

	setStatus(text) {
		const el = this.message.querySelector(".fal-message-detail");
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
				const content = split ? chars.map((ch, ci) => h("span", { class: "fal-c", style: `--i:${ci};--n:${chars.length}` }, ch)) : m[2];
				const span = h("span", { class: `fal-w${long ? " is-long" : ""}${split ? " has-chars" : ""}` }, content);
				if (!group) {
					group = h("span", { class: "fal-wg" });
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
				el = h("div", { class: "fal-line is-gap", "aria-hidden": "true" }, h("span", { class: "fal-dots" }, h("i"), h("i"), h("i")));
			} else {
				const main = h("div", { class: "fal-main" });
				el = h("div", { class: line.opposite ? "fal-line is-opposite" : "fal-line" }, main);
				let pairs = [];
				if (line.words) {
					el.classList.add("has-words");
					pairs = addWords(main, line.words);
				} else {
					main.textContent = line.text;
				}
				// Background vocals: a smaller line under the main one, filled in time with it.
				if (line.bg && this.showBg) {
					const bgEl = h("div", { class: "fal-bgv" });
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
		for (const el of this.list.querySelectorAll(".fal-tr")) el.remove();
		const tr = this.tr;
		if (!tr || !this.lyrics || tr.length !== this.lyrics.lines.length) return;
		this.lineEls.forEach((el, i) => {
			if (!tr[i] || el.classList.contains("is-gap")) return;
			const node = h("div", { class: "fal-tr", lang: "" }, tr[i]);
			const bg = el.querySelector(".fal-bgv");
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
			this.lineEls[idx].style.setProperty("--fal-gp", p.toFixed(3));
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
		if (instant) this.stage.classList.add("fal-no-anim");

		if (this.layout === "stack") {
			this.stage.style.setProperty("--fal-ah", `${focus.offsetHeight}px`);
		} else {
			this.y = Math.round(this.stage.clientHeight * ANCHOR - (focus.offsetTop + focus.offsetHeight / 2));
			if (!this.browsing) this.list.style.setProperty("--fal-y", `${this.y}px`);
		}

		if (instant) {
			void this.list.offsetHeight; // flush so no-anim applies to this change only
			nextFrame(() => this.stage.classList.remove("fal-no-anim"));
		}
	}

	/**
	 * Place the ambient light behind the actual text of a line: a block's box spans the full
	 * width, but wrapped/balanced text usually doesn't. Measured once per line change, in the
	 * element's own (untransformed) coordinates.
	 */
	measureHalo(el) {
		const main = el.querySelector(".fal-main");
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
		this.list.style.setProperty("--fal-y", `${Math.round(this.browseY)}px`);
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
		this.list.style.setProperty("--fal-y", `${this.y}px`);
	}

	// -------------------------------------------------------------------------
	// Words / unsynced
	// -------------------------------------------------------------------------

	resetWords(i) {
		const data = this.wordEls[i];
		if (!data) return;
		for (const s of data.spans) {
			s.classList.remove("sung", "now");
			s.style.removeProperty("--fal-wp");
		}
	}

	/**
	 * Word-level progress for the active line (main + background words, time-ordered).
	 * Every word carries one continuous value, --fal-wp: 0 = upcoming, 0..1 = being sung,
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
				if (i < k) span.style.setProperty("--fal-wp", "1");
				else if (i > k) span.style.removeProperty("--fal-wp");
			}
			this.wordIdx = k;
		}
		if (k >= 0 && k < spans.length) {
			const w = words[k];
			const p = w.end > w.time ? Math.min(1, Math.max(0, (pos - w.time) / (w.end - w.time))) : 1;
			spans[k].style.setProperty("--fal-wp", p.toFixed(4));
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

const loadedFonts = new Set();
/** Load a Google web font the first time it is needed (no-op for local stacks). */
function ensureFont(key) {
	const f = FONTS[key];
	if (!f?.web || loadedFonts.has(key)) return;
	loadedFonts.add(key);
	document.head.append(h("link", { rel: "stylesheet", href: `https://fonts.googleapis.com/css2?family=${f.web}&display=swap`, "data-fal-font": key }));
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
	const id = `fal-set-${entry.key}`;
	const value = settings.get(entry.key);
	const labelEl = (extra) => h("div", { class: "fal-row-label" }, h("span", null, entry.label), extra);

	if (entry.type === "providers") {
		// Ordered provider list: rank, name (+ WORD badge), description, move up/down, on/off.
		const list = h("div", { class: "fal-prov-list" });
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
						{ class: p.on ? "fal-prov" : "fal-prov is-off" },
						h("span", { class: "fal-prov-rank" }, String(i + 1)),
						h("div", null, h("div", { class: "fal-prov-name" }, info.label, info.words ? h("span", { class: "fal-prov-badge", title: "Can provide word-by-word timing" }, "WORD") : null), h("div", { class: "fal-prov-desc" }, info.desc)),
						h(
							"div",
							{ class: "fal-prov-move" },
							h("button", { title: "Move up", "aria-label": `Move ${info.label} up`, html: ARROWS.up(), disabled: i === 0, onclick: () => move(-1) }),
							h("button", { title: "Move down", "aria-label": `Move ${info.label} down`, html: ARROWS.down(), disabled: i === providers.length - 1, onclick: () => move(1) }),
						),
						h("input", {
							type: "checkbox",
							class: "fal-switch",
							checked: p.on,
							"aria-label": `Use ${info.label}`,
							onchange: (e) => set(providers.map((q) => (q.id === p.id ? { ...q, on: e.target.checked } : q))),
						}),
					);
				}),
			);
		};
		render(value);
		return { row: h("div", { class: "fal-row fal-row-stack" }, labelEl(), list), sync: render };
	}

	if (entry.type === "toggle") {
		const input = h("input", { type: "checkbox", id, class: "fal-switch", checked: !!value, onchange: (e) => settings.set(entry.key, e.target.checked) });
		return { row: h("label", { class: "fal-row fal-row-toggle", for: id }, h("span", null, entry.label), input), sync: (v) => (input.checked = !!v) };
	}

	if (entry.type === "select" && entry.ui === "segmented") {
		const { el, sync } = choiceGroup(entry, "fal-segmented", (v, label) =>
			h("button", { class: "fal-seg", title: label, html: SEGMENT_ICONS[v] && entry.key === "textAlign" ? SEGMENT_ICONS[v]() : null }, SEGMENT_ICONS[v] && entry.key === "textAlign" ? null : label),
		);
		return { row: h("div", { class: "fal-row fal-row-stack" }, labelEl(), el), sync };
	}

	if (entry.type === "select" && entry.ui === "cards") {
		const { el, sync } = choiceGroup(entry, "fal-cards", (v, label) =>
			h("button", { class: "fal-card" }, h("span", { class: "fal-card-art", html: STYLE_ART[v] || "" }), h("span", { class: "fal-card-name" }, label), h("span", { class: "fal-card-hint" }, entry.hints?.[v] || "")),
		);
		return { row: h("div", { class: "fal-row fal-row-stack" }, labelEl(), el), sync };
	}

	if (entry.type === "select" && entry.ui === "fonts") {
		const { el, sync } = choiceGroup(entry, "fal-fonts", (v, label) => {
			const f = FONTS[v];
			return h(
				"button",
				{ class: "fal-font", title: f.web ? `${label} (web font, loaded from Google Fonts)` : label, onpointerenter: () => ensureFont(v), onfocus: () => ensureFont(v) },
				h("span", { class: "fal-font-sample", style: { fontFamily: f.stack } }, "Aa"),
				h("span", { class: "fal-font-name" }, label),
			);
		});
		return { row: h("div", { class: "fal-row fal-row-stack" }, labelEl(), el), sync };
	}

	if (entry.type === "select") {
		const select = h(
			"select",
			{ id, class: "fal-select", onchange: (e) => settings.set(entry.key, e.target.value) },
			entry.options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)),
		);
		return { row: h("label", { class: "fal-row", for: id }, h("span", null, entry.label), select), sync: (v) => (select.value = v) };
	}

	// range — the filled part of the track is drawn from --p (0..100%)
	const out = h("output", { class: "fal-range-value" }, fmtValue(entry, value));
	const input = h("input", { type: "range", id, min: String(entry.min), max: String(entry.max), step: String(entry.step), class: "fal-range" });
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
		row: h("label", { class: "fal-row fal-row-range", for: id }, labelEl(out), input),
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
		{ id: "look", label: "Look", icon: ICONS.navLook, title: "Look", sub: "Layout, text and background", sections: ["Layout", "Text", "Background"] },
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
	const bodies = {};
	for (const page of PAGES.filter((pg) => pg.sections)) {
		bodies[page.id] = h(
			"div",
			{ class: "fal-tab-body", "data-tab": page.id, hidden: true },
			page.sections.map((name) => h("div", { class: "fal-section", "data-section": name }, h("h3", null, name), h("div", { class: "fal-section-card" }, sections.get(name) || []))),
		);
	}
	bodies.general.append(
		h("div", { class: "fal-section" }, h("h3", null, "Shortcuts"), h(
			"div",
			{ class: "fal-keys" },
			[
				["Alt L", "Open / close"],
				["Esc", "Close"],
				["[ ]", "Offset ∓100 ms"],
				["F", "Fullscreen"],
				["Wheel", "Browse lyrics"],
				["Click line", "Jump there"],
			].map(([k, d]) => h("div", { class: "fal-key" }, h("kbd", null, k), h("span", null, d))),
		)),
		h(
			"div",
			{ class: "fal-section" },
			h("h3", null, "Maintenance"),
			h(
				"div",
				{ class: "fal-panel-actions" },
				h("button", { class: "fal-btn", onclick: () => ctx.toast(`Cleared ${ctx.clearCache()} cached lyrics`) }, "Clear lyrics cache"),
				h("button", { class: "fal-btn fal-btn-ghost", onclick: () => (settings.reset(), ctx.toast("Settings reset")) }, "Reset to defaults"),
			),
		),
	);
	const settingsBodies = Object.values(bodies);
	const noResults = h("div", { class: "fal-no-results", hidden: true }, "No settings match your search.");

	const syncDisabled = (all) => {
		for (const b of settingsBodies) b.querySelector('[data-key="autoHideDelay"]')?.classList.toggle("is-disabled", !all.autoHideControls);
	};
	const unsubscribe = settings.subscribe((key, v, all) => {
		if (key === "*") for (const [k, fn] of syncers) fn(all[k]);
		else syncers.get(key)?.(v);
		syncDisabled(all);
	});
	syncDisabled(settings.all());

	// --- This track tab ------------------------------------------------------
	// "Load lyrics from": Auto + one button per provider. Picking one pins it to this track.
	const sourceGrid = h("div", { class: "fal-src-grid" });
	const testBtn = h(
		"button",
		{
			class: "fal-btn fal-btn-ghost fal-test-btn",
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
	const trackInfo = h("div", null, h("div", { class: "fal-src-title" }, "Load lyrics from"), sourceGrid, testBtn, h("div", { class: "fal-src-title" }, "Edit or import"));
	const textarea = h("textarea", {
		class: "fal-textarea",
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
	const removeBtn = h("button", { class: "fal-btn fal-btn-danger", onclick: () => (ctx.removeLocal(), refreshTrack()) }, "Remove imported");

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
		{ class: "fal-tab-body", "data-tab": "track", hidden: true },
		trackInfo,
		textarea,
		h(
			"div",
			{ class: "fal-panel-actions" },
			h("button", { class: "fal-btn", onclick: () => fileInput.click(), html: `${ICONS.upload()}<span>Import file</span>` }),
			h(
				"button",
				{
					class: "fal-btn fal-btn-ghost",
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
			{ class: "fal-panel-actions" },
			h(
				"button",
				{
					class: "fal-btn fal-btn-primary",
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
		h("p", { class: "fal-hint" }, "Drop an .lrc or .txt file on the editor, or paste text. Imported lyrics are stored locally, always take priority over online sources, and also apply to the same song on other albums."),
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
						class: `fal-src-btn${id === current ? " is-current" : ""}`,
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
	const nowPlaying = h("div", { class: "fal-np" });
	function setNowPlaying(track, sourceLabel) {
		nowPlaying.hidden = !track;
		if (!track) return;
		nowPlaying.replaceChildren(
			track.image ? h("img", { src: track.image, alt: "" }) : null,
			h("div", { class: "fal-np-text" }, h("div", { class: "fal-np-title" }, track.title), h("div", { class: "fal-np-sub" }, [track.artist, track.album].filter(Boolean).join(" • "))),
			h("span", { class: "fal-np-chip", title: "Lyrics source" }, sourceLabel || "No lyrics"),
		);
	}
	trackBody.prepend(nowPlaying);

	const railButtons = new Map();
	const rail = h(
		"nav",
		{ class: "fal-rail", role: "tablist", "aria-orientation": "vertical", "aria-label": "Settings pages" },
		h("span", { class: "fal-rail-pill", "aria-hidden": "true" }),
		PAGES.map((pg) => {
			const btn = h("button", { class: "fal-rail-btn", role: "tab", title: pg.title, onclick: () => ((search.value = ""), show(pg.id)) }, h("span", { class: "fal-rail-icon", html: pg.icon() }), h("span", { class: "fal-rail-label" }, pg.label));
			railButtons.set(pg.id, btn);
			return btn;
		}),
	);
	const titleEl = h("div", { class: "fal-panel-title" });
	const subEl = h("div", { class: "fal-panel-sub" });
	const search = h("input", { type: "search", class: "fal-search", placeholder: "Search settings", "aria-label": "Search settings", spellcheck: "false" });
	search.addEventListener("input", () => applySearch());
	const el = h(
		"div",
		{ class: "fal-panel", role: "dialog", "aria-label": "Lyrics settings" },
		rail,
		h(
			"div",
			{ class: "fal-panel-main" },
			h(
				"div",
				{ class: "fal-panel-head" },
				h("div", { class: "fal-panel-heading" }, titleEl, subEl),
				h("button", { class: "fal-icon-btn fal-panel-close", title: "Close (Esc)", "aria-label": "Close settings", html: ICONS.close(), onclick: () => close() }),
				h("label", { class: "fal-search-wrap" }, h("span", { class: "fal-search-icon", html: ICONS.search() }), search),
			),
			h("div", { class: "fal-panel-scroll" }, trackBody, settingsBodies, noResults),
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
		el.querySelector(".fal-panel-scroll").scrollTop = 0;
		if (tab === "track") refreshTrack();
	}

	/** Filter rows on every settings page; empty query returns to the current page. */
	function applySearch() {
		const q = search.value.trim().toLowerCase();
		el.dataset.searching = q ? "true" : "false";
		if (!q) {
			for (const b of settingsBodies) for (const r of b.querySelectorAll("[data-search]")) r.hidden = false;
			for (const sec of el.querySelectorAll(".fal-section")) sec.hidden = false;
			return show(current);
		}
		titleEl.textContent = "Search";
		subEl.textContent = `Results for “${search.value.trim()}”`;
		for (const btn of railButtons.values()) btn.setAttribute("aria-selected", "false");
		trackBody.hidden = true;
		let any = false;
		for (const body of settingsBodies) {
			body.hidden = false;
			for (const sec of body.querySelectorAll(".fal-section")) {
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

// ---- overlay.js ------------------------------------------------------------
// The overlay controller: builds the full-screen UI once (lazily), owns the playback loop,
// loads lyrics on track changes, and applies settings live.


const CLOSE_MS = 420; // must match the overlay fade-out transition in styles.css
const BG_SIZE = 256; // px; background art is drawn small and scaled up (cheap heavy blur)
const RELAYOUT_KEYS = new Set(["fontSize", "lineSpacing", "textAlign", "animation", "fontWeight", "font", "showContext", "view", "showBgVocals", "*"]);
const SOURCE_KEYS = new Set(["providers", "searchUntil"]);

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
		const bgStack = h("div", { class: "fal-bg-stack" });
		const bg = h(
			"div",
			{ class: "fal-bg", "aria-hidden": "true" },
			bgStack,
			h("div", { class: "fal-bg-gradient" }),
			h("div", { class: "fal-bg-shade" }),
			h("div", { class: "fal-bg-grain" }),
		);

		const cover = h("img", { class: "fal-cover", alt: "" });
		const title = h("div", { class: "fal-title" });
		const artist = h("div", { class: "fal-artist" });
		const header = h("div", { class: "fal-header fal-chrome" }, cover, h("div", { class: "fal-meta" }, title, artist));

		const stage = h("div", { class: "fal-stage", role: "main" });

		// Split view: big cover (click = play/pause) + track info beside the lyrics.
		const artA = h("img", { class: "fal-art", alt: "", decoding: "async" });
		const artB = h("img", { class: "fal-art", alt: "", decoding: "async" });
		const artHint = h("span", { class: "fal-art-hint", html: ICONS.pause() });
		// .fal-disc holds the art (it spins in the Vinyl layout); grooves/shine only show there.
		const disc = h("span", { class: "fal-disc" }, artA, artB, h("span", { class: "fal-disc-grooves", "aria-hidden": "true" }));
		const artWrap = h(
			"button",
			{ class: "fal-art-wrap", title: "Play / pause", "aria-label": "Play / pause", onclick: () => (playerCommand("togglePlay"), setTimeout(kick, 60)) },
			disc,
			h("span", { class: "fal-disc-shine", "aria-hidden": "true" }),
			artHint,
		);
		const sideTitle = h("div", { class: "fal-side-title" });
		const sideArtist = h("div", { class: "fal-side-artist" });
		const sideAlbum = h("div", { class: "fal-side-album" });
		const side = h("div", { class: "fal-side", role: "region", "aria-label": "Now playing" }, artWrap, h("div", { class: "fal-side-meta" }, sideTitle, sideArtist, sideAlbum));

		const iconBtn = (label, icon, onclick, cls = "fal-icon-btn") => h("button", { class: cls, title: label, "aria-label": label, html: icon, onclick });

		// ---- Player (bottom centre): progress + transport. Lyrics info bottom-left, actions right.
		const elapsed = h("span", { class: "fal-time" }, "0:00");
		const remaining = h("span", { class: "fal-time is-right" }, "-0:00");
		const tip = h("span", { class: "fal-progress-tip", "aria-hidden": "true" }, "0:00");
		const bar = h(
			"div",
			{ class: "fal-progress", role: "slider", "aria-label": "Seek", tabindex: "0", "aria-valuemin": "0" },
			h("div", { class: "fal-progress-track" }, h("div", { class: "fal-progress-fill" })),
			h("div", { class: "fal-progress-knob-rail" }, h("div", { class: "fal-progress-knob" })),
			tip,
		);
		const scrub = h("div", { class: "fal-scrub" }, bar, h("div", { class: "fal-times" }, elapsed, remaining));

		const act = (fn) => () => (fn(), setTimeout(() => (state.psAt = 0), 120), setTimeout(kick, 60));
		// Play/pause: both icons live in the button and cross-fade/rotate (no icon swap flash).
		const playBtn = h(
			"button",
			{ class: "fal-play-btn", title: "Play / pause", "aria-label": "Play / pause", onclick: act(() => playerCommand("togglePlay")) },
			h("span", { class: "fal-pp is-play", html: ICONS.play() }),
			h("span", { class: "fal-pp is-pause", html: ICONS.pause() }),
		);
		const shuffleBtn = iconBtn("Shuffle", ICONS.shuffle(), act(() => playerCommand("toggleShuffle")), "fal-icon-btn fal-toggle");
		const repeatBtn = iconBtn("Repeat", ICONS.repeat(), act(() => playerCommand("toggleRepeat")), "fal-icon-btn fal-toggle");
		const transport = h(
			"div",
			{ class: "fal-transport" },
			shuffleBtn,
			iconBtn("Previous", ICONS.prev(), act(() => playerCommand("back")), "fal-icon-btn fal-skip"),
			playBtn,
			iconBtn("Next", ICONS.next(), act(() => playerCommand("next")), "fal-icon-btn fal-skip"),
			repeatBtn,
		);

		// Lyrics info: source chip (opens the source picker) + timing offset.
		const source = h("button", { class: "fal-source", title: "Lyrics source: choose, reload, import", onclick: () => panel.toggle("track") }, "—");
		const offsetOut = h("button", { class: "fal-offset", title: "Lyric offset (+ = earlier). Click to reset.", onclick: () => settings.set("offset", 0) });
		const trBtn = iconBtn("Translate lyrics (T)", ICONS.translate(), () => settings.set("translate", !settings.get("translate")), "fal-icon-btn fal-toggle fal-tr-btn");
		const offsetGroup = h(
			"div",
			{ class: "fal-offset-group", role: "group", "aria-label": "Lyric offset" },
			iconBtn("Lyrics later by 100 ms ( [ )", ICONS.minus(), () => nudgeOffset(-100), "fal-mini-btn"),
			offsetOut,
			iconBtn("Lyrics earlier by 100 ms ( ] )", ICONS.plus(), () => nudgeOffset(100), "fal-mini-btn"),
		);

		// Actions: like, volume, settings, fullscreen, close.
		const heartBtn = iconBtn("Save to Liked Songs", ICONS.heart(), act(() => playerCommand("toggleHeart")), "fal-icon-btn fal-heart");
		const muteBtn = iconBtn("Mute", ICONS.volHigh(), act(() => playerCommand("toggleMute")));
		const vol = h("input", { type: "range", class: "fal-vol", min: "0", max: "1", step: "0.01", "aria-label": "Volume" });
		vol.addEventListener("input", () => {
			state.volDragging = true;
			vol.style.setProperty("--v", vol.value);
			setVolume(Number(vol.value));
		});
		vol.addEventListener("change", () => ((state.volDragging = false), (state.psAt = 0)));
		const fsBtn = iconBtn("Fullscreen (F)", ICONS.fullscreen(), toggleFullscreen);

		const dock = h(
			"div",
			{ class: "fal-player fal-chrome", role: "toolbar", "aria-label": "Playback controls" },
			h("div", { class: "fal-player-side is-left" }, source, trBtn, offsetGroup),
			h("div", { class: "fal-player-center" }, scrub, transport),
			h(
				"div",
				{ class: "fal-player-side is-right" },
				heartBtn,
				h("div", { class: "fal-volume" }, muteBtn, vol),
				h("span", { class: "fal-sep", "aria-hidden": "true" }),
				iconBtn("Settings", ICONS.settings(), () => panel.toggle("settings")),
				fsBtn,
				iconBtn("Close (Esc)", ICONS.close(), close),
			),
		);
		// Hairline progress at the very bottom, visible only while the controls are hidden.
		const miniProgress = h("div", { class: "fal-mini-progress", "aria-hidden": "true" }, h("div", { class: "fal-mini-fill" }));
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

		const toastEl = h("div", { class: "fal-toast", role: "status", "aria-live": "polite" });

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

		const root = h(
			"div",
			{ id: "fal-root", class: "fal-root", role: "dialog", "aria-modal": "true", "aria-label": "Aurora Lyrics", tabindex: "-1", hidden: true },
			bg,
			h("div", { class: "fal-drag", "aria-hidden": "true" }), // keeps the window draggable
			header,
			side,
			stage,
			dock,
			miniProgress,
			panel.el,
			toastEl,
		);

		const view = new LyricsView(stage, {
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
		ui = { trBtn, root, bgStack, cover, title, artist, artA, artB, artHint, sideTitle, sideArtist, sideAlbum, activeArt: artA, stage, dock, bar, miniProgress, elapsed, remaining, playBtn, shuffleBtn, repeatBtn, heartBtn, muteBtn, vol, source, offsetOut, fsBtn, toastEl, panel, view };
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
		st.setProperty("--fal-font", FONTS[all.font]?.stack || FONTS.spotify.stack);
		st.setProperty("--fal-fs", `${all.fontSize}px`);
		st.setProperty("--fal-gap", `${all.lineSpacing}em`);
		st.setProperty("--fal-fw", all.fontWeight);
		st.setProperty("--fal-shade", String(all.bgOpacity));

		const layout = all.animation === "fade" || all.animation === "cinematic" ? "stack" : "list";
		const reduced = reducedMotion(all);
		Object.assign(root.dataset, {
			anim: all.animation,
			layout,
			align: all.textAlign,
			color: all.textColor,
			context: all.showContext ? "on" : "off",
			glow: all.glow,
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
			root.classList.remove("fal-view-swap");
			void root.offsetWidth;
			root.classList.add("fal-view-swap");
			clearTimeout(state.viewSwapTimer);
			state.viewSwapTimer = setTimeout(() => root.classList.remove("fal-view-swap"), 900);
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
		ui.root.style.setProperty("--fal-bg-scale", scale.toFixed(3));
		ui.root.style.setProperty("--fal-bg-blur", `${(settings.get("blur") / scale).toFixed(2)}px`);
	}

	function updateBackground(track) {
		const url = track?.image;
		if (!url || url === state.bgUrl) return;
		state.bgUrl = url;
		const blobs = ["b1", "b2", "b3"].map((c) => h("img", { class: `fal-blob ${c}`, alt: "", src: url, width: BG_SIZE, height: BG_SIZE }));
		const layer = h("div", { class: "fal-bg-layer" }, blobs);
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
					st.setProperty("--fal-c1", c.VIBRANT || c.PROMINENT || "#4b3b78");
					st.setProperty("--fal-c2", c.DARK_VIBRANT || c.DESATURATED || "#14203a");
					st.setProperty("--fal-accent", c.LIGHT_VIBRANT || c.VIBRANT || c.PROMINENT || "#ffffff");
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
		ui.artist.textContent = track ? [track.artist, track.album].filter(Boolean).join(" • ") : "";
		if (track?.image) ui.cover.src = track.image;
		ui.cover.hidden = !track?.image;
		ui.sideTitle.textContent = track?.title || "";
		ui.sideArtist.textContent = track?.artist || "";
		ui.sideAlbum.textContent = track?.album || "";
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
	 * record what each returned. Shown in the ✎ panel; also exposed as FullscreenLyrics.testSources().
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
		ui.view.stopBrowsing(true);
		ui.root.classList.remove("is-open");
		if (state.enteredFullscreen && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
		state.closeTimer = setTimeout(() => (ui.root.hidden = true), CLOSE_MS);
		kick(); // cancels pending frames because state.open is false
		state.lastFocus?.focus?.({ preventScroll: true });
		onOpenChange?.(false);
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
			console.warn("[fal] fullscreen failed", e);
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
				if (ui.panel.isOpen()) ui.panel.close();
				else if (ui.view.browsing) ui.view.stopBrowsing();
				else close();
				return;
			}
			if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
			if (e.key === "[") nudgeOffset(-100);
			else if (e.key === "]") nudgeOffset(100);
			else if (e.key === "f" || e.key === "F") toggleFullscreen();
			else if (e.key === "t" || e.key === "T") settings.set("translate", !settings.get("translate"));
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

function createNowPlayingCard({ openOverlay, isOverlayOpen }) {
	const state = { uri: null, lyrics: null, source: null, token: 0, active: -2, wordIdx: -1, raf: 0, timer: 0, visible: false };
	let lineEls = [];
	let wordData = []; // per line: { words, spans } | null

	// ---- DOM
	const src = h("span", { class: "fal-npv-src" });
	const openBtn = h("button", {
		class: "fal-npv-open",
		title: "Open fullscreen lyrics (Alt+L)",
		"aria-label": "Open fullscreen lyrics",
		html: ICONS.fullscreen(),
		onclick: (e) => (e.stopPropagation(), openOverlay()),
	});
	const lines = h("div", { class: "fal-npv-lines" });
	const msg = h("div", { class: "fal-npv-msg" });
	const body = h("div", { class: "fal-npv-body", title: "Open fullscreen lyrics", onclick: () => openOverlay() }, lines, msg);
	const card = h("div", { class: "fal-npv", "data-fal-npv": "" }, h("div", { class: "fal-npv-head" }, h("h2", { class: "fal-npv-title" }, "Lyrics"), src, openBtn), body);

	// ---- mounting
	function unhideSpotify() {
		for (const el of document.querySelectorAll("[data-fal-hidden]")) el.removeAttribute("data-fal-hidden");
	}
	function mount() {
		if (!settings.get("npvCard")) {
			card.remove();
			unhideSpotify();
			return;
		}
		const spotifyCard = document.querySelector(SPOTIFY_CARD);
		if (spotifyCard) {
			if (!spotifyCard.hasAttribute("data-fal-hidden")) spotifyCard.setAttribute("data-fal-hidden", "");
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
	});

	// ---- lyrics
	function setMessage(text) {
		msg.textContent = text;
		lines.replaceChildren();
		lineEls = [];
		wordData = [];
		state.active = -2;
		card.classList.remove("is-unsynced");
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

		const frag = document.createDocumentFragment();
		lineEls = [];
		wordData = [];
		for (const line of l.lines) {
			let el;
			let wd = null;
			if (line.gap) {
				el = h("div", { class: "fal-npv-line is-gap" }, "• • •");
			} else if (line.words && l.synced) {
				el = h("div", { class: "fal-npv-line" });
				const spans = line.words.map((w) => {
					const m = w.text.match(/^(\s*)([\s\S]*?)(\s*)$/);
					if (m[1]) el.append(m[1]);
					const span = h("span", { class: "fal-npv-w" }, m[2]);
					el.append(span);
					if (m[3]) el.append(m[3]);
					return span;
				});
				wd = { words: line.words, spans };
			} else {
				el = h("div", { class: "fal-npv-line" }, line.text);
			}
			if (l.synced && line.time != null && !line.gap) {
				el.addEventListener("click", (e) => {
					e.stopPropagation();
					seek(line.time - settings.get("offset") + 20);
					setTimeout(kick, 60);
				});
				el.title = "Jump here";
			}
			lineEls.push(el);
			wordData.push(wd);
			frag.append(el);
		}
		lines.replaceChildren(frag);
		lines.style.transform = "";
		translateCard();
		kick();
	}

	async function translateCard() {
		for (const el of lines.querySelectorAll(".fal-npv-tr")) el.remove();
		const l = state.lyrics;
		if (!l || !settings.get("translate")) return;
		try {
			const res = await translateLyrics(l, resolveTarget(settings.get("translateTo")));
			if (state.lyrics !== l || res.sameLanguage) return;
			res.lines.forEach((t, i) => t && lineEls[i]?.append(h("div", { class: "fal-npv-tr" }, t)));
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
		if (isPlaying()) state.raf = requestAnimationFrame(tick);
		else state.timer = setTimeout(tick, 300);
	}
	function kick() {
		tick();
	}

	function activate(idx) {
		const prev = state.active;
		if (prev >= 0 && lineEls[prev]) {
			lineEls[prev].classList.remove("is-active");
			const wd = wordData[prev];
			if (wd) for (const s of wd.spans) s.classList.remove("sung", "now"), s.style.removeProperty("--fal-wp");
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
				if (i !== k) s.style.removeProperty("--fal-wp");
			});
			state.wordIdx = k;
		}
		if (k >= 0 && k < spans.length) {
			const w = words[k];
			const p = w.end > w.time ? Math.min(1, Math.max(0, (pos - w.time) / (w.end - w.time))) : 1;
			spans[k].style.setProperty("--fal-wp", p.toFixed(3));
		}
	}

	mount();
	return {
		onSongChange: () => load(),
		onPlayPause: kick,
		onProgress: () => !isPlaying() && kick(),
		onOverlayClosed: kick,
		useLyrics,
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
	if (globalThis.__falLoaded) return; // guard against double injection
	globalThis.__falLoaded = true;

	const S = await waitForSpicetify();

	const style = document.createElement("style");
	style.id = `${EXT_ID}-style`;
	style.textContent = CSS;
	document.head.append(style);

	let playbarBtn = null;
	let card = null;
	const overlay = createOverlay({
		onOpenChange: (open) => {
			if (playbarBtn) playbarBtn.active = open;
			if (!open) card?.onOverlayClosed();
		},
		onLyrics: (uri, lyrics, source) => card?.useLyrics(uri, lyrics, source),
	});
	// Our lyrics card in Spotify's right-hand Now Playing panel.
	try {
		card = createNowPlayingCard({ openOverlay: () => overlay.open(), isOverlayOpen: () => overlay.isOpen() });
	} catch (e) {
		console.warn(`[${EXT_ID}] Now Playing card unavailable`, e);
	}

	// Buttons: each API is optional across Spicetify versions, so register what exists.
	const label = "Aurora Lyrics (Alt+L)";
	try {
		if (S.Topbar?.Button) new S.Topbar.Button(label, ICONS.lyrics(16), () => overlay.toggle());
	} catch (e) {
		console.warn(`[${EXT_ID}] topbar button unavailable`, e);
	}
	try {
		if (S.Playbar?.Button) playbarBtn = new S.Playbar.Button(label, ICONS.lyrics(16), () => overlay.toggle(), false, false);
	} catch (e) {
		console.warn(`[${EXT_ID}] playbar button unavailable`, e);
	}

	S.Player.addEventListener("songchange", () => (overlay.onSongChange(), card?.onSongChange()));
	S.Player.addEventListener("onplaypause", () => (overlay.onPlayPause(), card?.onPlayPause()));
	S.Player.addEventListener("onprogress", () => (overlay.onProgress(), card?.onProgress()));

	// Small public handle for debugging from DevTools: window.FullscreenLyrics.open()
	globalThis.FullscreenLyrics = { open: overlay.open, close: overlay.close, toggle: overlay.toggle, testSources: overlay.testSources };
	console.info(`[${EXT_ID}] loaded`);
}

main().catch((e) => console.error("[aurora-lyrics] failed to start", e));
})();
