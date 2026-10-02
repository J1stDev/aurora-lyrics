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
	// Spicetify's wrapper rescans every element not marked like this (reading its computed
	// style) each time any node in the page is added or removed. Our elements are never
	// scroll containers it needs to touch, so mark them to keep them out of that scan.
	node.setAttribute("data-scroll-optimized", "");
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
 * Set an element's text by editing its text node in place when it has exactly one, so the
 * change doesn't add or remove nodes. Spicetify's wrapper rescans the whole page (~60 ms on a
 * big library view) every time a node is added or removed anywhere, so text that changes
 * while playing (clock, countdowns) must go through here.
 */
function setText(el, text) {
	const s = text == null ? "" : String(text);
	const n = el.firstChild;
	if (n && n.nodeType === 3 && !n.nextSibling) {
		if (n.data !== s) n.data = s;
	} else el.textContent = s;
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
//   type: "range" | "select" | "toggle" | "color" | "media" | "providers"
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
	mono: { label: "Mono", web: "JetBrains+Mono:wght@500;700;800", stack: '"JetBrains Mono", "Cascadia Code", Consolas, ui-monospace, monospace' },
	condensed: { label: "Condensed", web: "Oswald:wght@500;600;700", stack: '"Oswald", "Bahnschrift SemiCondensed", "Arial Narrow", sans-serif' },
	serif: { label: "Serif", web: "Playfair+Display:wght@500;700;800;900", stack: '"Playfair Display", "Iowan Old Style", "Palatino Linotype", Georgia, serif' },
	gothic: { label: "Gothic", web: "Grenze+Gotisch:wght@500;700;800;900", stack: '"Grenze Gotisch", "Old English Text MT", "Palatino Linotype", Georgia, serif' },
	wide: { label: "Wide", web: "Unbounded:wght@500;700;800", stack: '"Unbounded", "Outfit", "Segoe UI Variable Display", system-ui, sans-serif' },
	neon: { label: "Neon tube", web: "Tilt+Neon", stack: '"Tilt Neon", "Outfit", "Segoe UI Variable Display", system-ui, sans-serif' },
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
	{ key: "ambience", section: "Theme", label: "Theme ambience (scanlines, spotlights, stars…)", type: "toggle", default: true },
	{ key: "glassRefract", section: "Theme", label: "Glass refraction (glass themes bend what is behind them; turn off if the lyrics stutter)", type: "toggle", default: true },
	{ key: "beatSync", section: "Theme", label: "Time ambience to the beat (when Spotify has beat data for the song)", type: "toggle", default: true },
	// Text
	{ key: "font", section: "Text", label: "Font", type: "select", ui: "fonts", options: Object.entries(FONTS).map(([k, f]) => [k, f.label]), default: "spotify" },
	{ key: "fontSize", section: "Text", label: "Size", type: "range", min: 24, max: 104, step: 2, unit: "px", default: 56 },
	{ key: "fontWeight", section: "Text", label: "Weight", type: "select", ui: "segmented", options: [["500", "Medium"], ["700", "Bold"], ["800", "Heavy"], ["900", "Black"]], default: "800" },
	{ key: "lineSpacing", section: "Text", label: "Line spacing", type: "range", min: 0.1, max: 1.5, step: 0.05, unit: "em", default: 0.55 },
	{ key: "textAlign", section: "Text", label: "Alignment", type: "select", ui: "segmented", options: [["left", "Left"], ["center", "Center"], ["right", "Right"]], default: "left" },
	{ key: "textColor", section: "Text", label: "Colour", type: "select", ui: "segmented", options: [["white", "White"], ["accent", "Accent tint"], ["gradient", "Album gradient"]], default: "white" },
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
			["spring", "Spring"],
			["wheel", "Wheel"],
			["swipe", "Swipe"],
			["zoom", "Zoom"],
			["flip", "Flip"],
			["depth", "Depth"],
		],
		hints: {
			flow: "Spring wave",
			slide: "Smooth scroll",
			scale: "Springy focus",
			fade: "3-line carousel",
			cinematic: "One line, big",
			spring: "Bouncy wave",
			wheel: "3D drum",
			swipe: "Slides sideways",
			zoom: "Fly through",
			flip: "Split-flap",
			depth: "3D parallax",
		},
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
			["focus", "Focus"],
			["bounce", "Bounce"],
			["neon", "Neon"],
			["typewriter", "Typewriter"],
			["shimmer", "Shimmer"],
		],
		hints: {
			fill: "Soft sweep + lift",
			glow: "Light up + bloom",
			pop: "Swell on each word",
			rise: "Float into place",
			letters: "Letter wave",
			karaoke: "Accent-colour wipe",
			focus: "Blur to sharp",
			bounce: "Hop and settle",
			neon: "Flicker on in colour",
			typewriter: "Typed letter by letter",
			shimmer: "Light sweeps through",
		},
		default: "fill",
	},
	{ key: "estimateWords", section: "Words", label: "Estimate word timing for line-synced lyrics", type: "toggle", default: false },
	{ key: "showBgVocals", section: "Words", label: "Show background vocals", type: "toggle", default: true },
	{ key: "unsyncedAutoScroll", section: "Motion", label: "Auto-scroll unsynced lyrics", type: "toggle", default: true },
	{ key: "reducedMotion", section: "Motion", label: "Reduced motion", type: "select", ui: "segmented", options: [["system", "System"], ["on", "On"], ["off", "Off"]], default: "system" },
	// Background
	{ key: "bgStyle", section: "Background", label: "Style", type: "select", ui: "segmented", options: [["album", "Album art"], ["gradient", "Gradient"], ["solid", "Solid"], ["custom", "Custom"]], default: "album" },
	{ key: "customBg", section: "Background", label: "Custom image or video", type: "media", default: null },
	{ key: "customBlur", section: "Background", label: "Custom background blur", type: "range", min: 0, max: 40, step: 1, unit: "px", default: 0 },
	{ key: "bgAnimate", section: "Background", label: "Animated background", type: "toggle", default: true },
	{ key: "bgOpacity", section: "Background", label: "Darkening", type: "range", min: 0, max: 0.9, step: 0.05, unit: "", default: 0.45 },
	{ key: "blur", section: "Background", label: "Blur", type: "range", min: 20, max: 160, step: 5, unit: "px", default: 90 },
	// Sync
	{ key: "offset", section: "Sync", label: "Lyric offset (+ = earlier)", type: "range", min: -5000, max: 5000, step: 50, unit: "ms", default: 0 },
	// Interface
	{ key: "showTransport", section: "Interface", label: "Playback controls & progress", type: "toggle", default: true },
	{ key: "tabsButton", section: "Interface", label: "Guitar tabs button (Songsterr)", type: "toggle", default: true },
	{ key: "queuePeek", section: "Interface", label: "Show the next track near the end of a song", type: "toggle", default: true },
	{ key: "miniStyle", section: "Interface", label: "Mini lyrics style", type: "select", ui: "segmented", options: [["glass", "Glass"], ["compact", "Compact"], ["bar", "Bar"], ["bare", "Floating"], ["neon", "Neon"]], default: "glass" },
	{ key: "miniNext", section: "Interface", label: "Mini lyrics: show the next line", type: "toggle", default: true },
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
 * glass: true = the theme wears the liquid-glass kit (glass.css): a lens behind the line being sung,
 * glass control bar and cover.
 */
const LOOK_KEYS = ["view", "font", "fontWeight", "textAlign", "textColor", "glow", "accent", "animation", "wordAnim", "depthBlur", "bgStyle", "bgOpacity"];
const THEMES = [
	{ id: "aurora", label: "Aurora", hint: "The default look", swatch: ["#6d3bd1", "#1b2a6b"], values: {} },
	{ id: "neon", label: "Neon", hint: "Liquid light in glass tubes", glass: true, swatch: ["#ff2fb3", "#14101c"], values: { font: "neon", fontWeight: "700", glow: "radiant", textColor: "accent", animation: "scale", wordAnim: "neon", depthBlur: false, bgStyle: "gradient", bgOpacity: 0.35 } },
	{ id: "minimal", label: "Minimal", hint: "Quiet frosted glass", glass: true, swatch: ["#8f98ab", "#0d0e12"], values: { view: "lyrics", font: "system", fontWeight: "700", glow: "off", animation: "slide", depthBlur: false, bgStyle: "album", bgOpacity: 0.6 } },
	{ id: "karaoke", label: "Karaoke", hint: "Glass KTV stage, colour-wipe lyrics", glass: true, swatch: ["#ff3d8b", "#1a0b44"], values: { view: "captions", font: "rounded", fontWeight: "900", textAlign: "center", accent: "#ff3d8b", glow: "off", animation: "fade", wordAnim: "karaoke", bgStyle: "gradient", bgOpacity: 0.5 } },
	{ id: "gothic", label: "Gothic", hint: "Stained glass and candlelight", glass: true, swatch: ["#9e1030", "#0d0709"], values: { view: "lyrics", font: "gothic", fontWeight: "700", textAlign: "center", accent: "#c21f3f", animation: "fade", wordAnim: "glow", bgStyle: "gradient", bgOpacity: 0.62 } },
	{ id: "blackmetal", label: "Black Metal", hint: "Frozen forest under the moon", swatch: ["#cfd9e2", "#07090c"], values: { view: "lyrics", font: "gothic", fontWeight: "700", textAlign: "center", accent: "#aebfcd", animation: "fade", wordAnim: "focus", bgOpacity: 0.6 } },
	{ id: "lounge", label: "Lounge", hint: "Spinning vinyl", swatch: ["#c0703a", "#2b1408"], values: { view: "vinyl", font: "serif", fontWeight: "700", animation: "flow", wordAnim: "letters" } },
	{ id: "retro", label: "Retro", hint: "Amber terminal", swatch: ["#ffb000", "#1a1204"], values: { view: "lyrics", font: "mono", fontWeight: "700", textColor: "accent", accent: "#ffb000", animation: "flip", wordAnim: "typewriter", depthBlur: false, bgStyle: "solid" } },
	{ id: "synthwave", label: "Synthwave", hint: "Outrun sunset, chrome type", swatch: ["#ff4fd8", "#1b0b3a"], values: { view: "lyrics", font: "outfit", fontWeight: "900", textAlign: "center", accent: "#ff4fd8", glow: "soft", animation: "slide", wordAnim: "fill", bgStyle: "gradient", bgOpacity: 0.3 } },
	{ id: "zen", label: "Zen", hint: "Soft and slow", swatch: ["#9fd8b8", "#10231c"], values: { view: "lyrics", font: "serif", fontWeight: "500", textAlign: "center", accent: "#9fd8b8", animation: "fade", wordAnim: "focus", bgStyle: "gradient", bgOpacity: 0.55 } },
	{ id: "sunset", label: "Sunset", hint: "Warm shimmer", swatch: ["#ff8a4c", "#3a0e2e"], values: { font: "inter", textColor: "accent", accent: "#ff8a4c", animation: "spring", wordAnim: "shimmer", bgStyle: "gradient", bgOpacity: 0.4 } },
	{ id: "midnight", label: "Midnight", hint: "Cool blue", swatch: ["#7aa2ff", "#0b1330"], values: { font: "inter", textColor: "accent", accent: "#7aa2ff", bgStyle: "gradient", bgOpacity: 0.6 } },
	{ id: "vaporwave", label: "Vaporwave", hint: "Pastel dream, checker floor, VHS", swatch: ["#ff71ce", "#2b0f5c"], values: { view: "split", font: "wide", fontWeight: "700", accent: "#ff71ce", glow: "soft", animation: "slide", wordAnim: "glow", bgStyle: "gradient", bgOpacity: 0.3 } },
	{ id: "ocean", label: "Ocean", hint: "A dive: light shafts, manta, jellyfish", swatch: ["#3fb4e8", "#04264f"], values: { view: "split", font: "rounded", fontWeight: "800", accent: "#5fd4ff", animation: "flow", wordAnim: "shimmer", bgStyle: "gradient", bgOpacity: 0.3 } },
	{ id: "rain", label: "Rain", hint: "Real drops on a night window", swatch: ["#8fb4e6", "#0b1220"], values: { view: "lyrics", font: "inter", fontWeight: "700", textAlign: "center", accent: "#9fc2e8", glow: "soft", animation: "fade", wordAnim: "focus", bgStyle: "gradient", bgOpacity: 0.55 } },
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
// themeFx: the ambience layer of the last theme picked (kept when you then tweak settings).
const EXTRA_DEFAULTS = { pinControls: false, seenTip: false, customLook: null, miniPos: null, themeFx: "aurora" };

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
		case "media":
			return value && typeof value === "object" && (value.kind === "image" || value.kind === "video") && typeof value.name === "string"
				? { kind: value.kind, name: value.name, size: Number(value.size) || 0 }
				: null;
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
	if (out.themeFx !== "none" && !THEMES.some((t) => t.id === out.themeFx)) out.themeFx = "aurora";
	const mp = saved.miniPos;
	out.miniPos = mp && Number.isFinite(mp.x) && Number.isFinite(mp.y) ? { x: clamp(mp.x, 0, 1), y: clamp(mp.y, 0, 1) } : null;
	out.customLook = saved.customLook && typeof saved.customLook === "object" ? pickLook(saved.customLook) : null;
	if (out.customLook && typeof saved.customLook.themeFx === "string") out.customLook.themeFx = saved.customLook.themeFx;
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
		// Tweaking a theme's look turns it into a custom one, and a custom look has no theme ambience.
		if (!("ambience" in values) && next.ambience && changed.some((k) => LOOK_KEYS.includes(k)) && matchTheme(current) && !matchTheme(next)) {
			next.ambience = false;
			changed.push("ambience");
		}
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
			// Your own look has no theme ambience, so switch it off.
			if (current.customLook) this.setMany({ ...current.customLook, themeFx: current.customLook.themeFx || "none", ambience: false });
			return;
		}
		const theme = THEMES.find((t) => t.id === id);
		if (!theme) return;
		// Leaving a look of the user's own: keep it so it can be restored.
		if (!matchTheme(current)) this.setMany({ customLook: { ...pickLook(current), themeFx: current.themeFx } });
		// Picking a theme asks for its whole look, so its ambience comes back on too.
		this.setMany({ ...themeLook(theme), themeFx: theme.id, ambience: true });
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

const VOWEL_RUN = /[aeiouyàáâãäåæèéêëìíîïòóôõöøœùúûüýÿāēīōūăąęěőűαεηιουωάέήίόύώаеёиоуыэюяіїє]+/giu;
const SYLLABLE_CHAR = /[ぁ-ゖァ-ヺ一-鿿㐀-䶿가-힯]/gu;
const CJK = /[ぁ-ヺ㐀-䶿一-鿿]/u;
const SMALL_KANA =/[ぁぃぅぇぉゃゅょっゎァィゥェォャュョッヮ]/gu;
// A comma, full stop, dash etc. at the end of a word: the singer usually breathes there.
const PAUSE_AFTER = /[,.;:!?…—–、。，！？]["'”’)\]]*\s*$/u;

/**
 * Rough syllable count for one word: each CJK/kana/Hangul character is a syllable, other
 * scripts count vowel groups, with English silent endings ("love", "moved") dropped.
 */
function syllables(word) {
	const w = word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
	if (!w) return 0;
	const block = (w.match(SYLLABLE_CHAR) || []).length - (w.match(SMALL_KANA) || []).length;
	const rest = w.replace(SYLLABLE_CHAR, "");
	let n = (rest.match(VOWEL_RUN) || []).length;
	if (/^[a-z']+$/.test(rest) && n > 1) {
		if (/[^aeiouyl]e$|[^aeiouyslcgzxh]es$|[^aeiouytd]ed$/.test(rest)) n--;
	}
	n += (rest.match(/\d/g) || []).length; // "99" is sung as several syllables
	return Math.max(block + n, 1);
}

/**
 * Typical time per syllable for this song, from the tighter lines (a line's slot often
 * includes an instrumental tail, so the fast end of the distribution is closest to the
 * actual singing pace). Rap lands near 150 ms, ballads 400+.
 */
function syllableRate(items) {
	const rates = items.filter((it) => it.syl >= 3).map((it) => (it.l.end - it.l.time) / it.syl);
	if (rates.length < 3) return 300;
	rates.sort((a, b) => a - b);
	return Math.min(Math.max(rates[Math.floor(rates.length * 0.3)], 130), 650);
}

/**
 * Give line-synced lyrics approximate word timing so word animations work everywhere.
 * Words get time by syllable count, at the song's own singing pace, with a short breath
 * after punctuation and the last word of each line held a little longer. A line that
 * stays up through an instrumental tail finishes early instead of crawling to its end.
 * Returns a new Lyrics object flagged `estimated: true`; lines that already have word
 * timing are left alone.
 */
function estimateWords(lyrics) {
	if (!lyrics?.synced || lyrics.hasWords) return lyrics;
	const items = [];
	for (const l of lyrics.lines) {
		if (l.gap || l.words || !l.text) continue;
		// Split into words; Chinese/Japanese written without spaces is split per character.
		const text = l.text.trim();
		const tokens = /\s/.test(text) ? l.text.match(/\S+\s*/g) : CJK.test(text) ? Array.from(l.text) : [l.text];
		const syl = tokens.map((t) => syllables(t) || 0.5);
		items.push({ l, tokens, syl: syl.reduce((a, b) => a + b, 0), sylEach: syl });
	}
	const rate = syllableRate(items);
	const byLine = new Map();
	for (const { l, tokens, sylEach } of items) {
		const last = tokens.length - 1;
		const pause = tokens.map((t, i) => (i < last && PAUSE_AFTER.test(t) ? 0.6 : 0));
		const hold = last > 0 ? 1 : 0.5; // the last word is usually drawn out
		const units = sylEach.reduce((a, b) => a + b, 0) + pause.reduce((a, b) => a + b, 0) + hold;
		const avail = l.end - l.time;
		// Sing at the song's pace, a little slower when there is room, never past the line.
		const span = Math.min(units * rate * 1.1, avail * 0.94);
		const unit = span / units;
		let t = l.time;
		const words = tokens.map((text, i) => {
			const d = unit * (sylEach[i] + (i === last ? hold : 0));
			const w = { time: Math.round(t), end: Math.round(t + d), text };
			t += d + unit * pause[i];
			return w;
		});
		byLine.set(l, words);
	}
	const lines = lyrics.lines.map((l) => (byLine.has(l) ? { ...l, words: byLine.get(l) } : l));
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

// ---- beats.js --------------------------------------------------------------
// Beat grid for the current song, from Spotify's audio analysis (Spicetify.getAudioData), used to
// time theme ambience to the music. Optional: when the analysis isn't available (the endpoint
// can be missing or refused) themes simply keep reacting to lyric lines.

const BEAT_CACHE_MAX = 30;
const beatCache = new Map(); // uri → parsed grid, or null when there is none

/**
 * Parse an audio-analysis response into what the ambience needs.
 * @returns {{ beats: number[], bars: number[], tempo: number, sections: { time: number, energy: number }[] } | null}
 *   times in ms; energy 0..1 per section (from its loudness)
 */
function parseAnalysis(a) {
	const beats = (a?.beats || []).filter((b) => b && Number.isFinite(b.start)).map((b) => Math.round(b.start * 1000));
	if (beats.length < 8) return null;
	const bars = (a.bars || []).filter((b) => b && Number.isFinite(b.start)).map((b) => Math.round(b.start * 1000));
	const gaps = beats.slice(1).map((t, i) => t - beats[i]).sort((x, y) => x - y);
	const median = gaps[gaps.length >> 1];
	let tempo = Number(a.track?.tempo);
	if (!(tempo > 30 && tempo < 300)) tempo = median > 0 ? 60000 / median : 120;
	// Loudness in dB (about -35 quiet … -4 loud) → 0..1.
	const sections = (a.sections || [])
		.filter((s) => s && Number.isFinite(s.start))
		.map((s) => ({ time: Math.round(s.start * 1000), energy: Math.min(1, Math.max(0, ((Number(s.loudness) || -20) + 35) / 31)) }));
	return { beats, bars: bars.length >= 2 ? bars : beats.filter((_, i) => i % 4 === 0), tempo, sections };
}

/** Index of the last time <= pos, or -1 (binary search; times sorted). */
function beatIndexAt(times, pos) {
	let lo = 0;
	let hi = times.length - 1;
	let ans = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (times[mid] <= pos) (ans = mid), (lo = mid + 1);
		else hi = mid - 1;
	}
	return ans;
}

/** The beat grid for a track uri (cached per session), or null. */
async function loadBeats(uri) {
	if (!uri) return null;
	if (beatCache.has(uri)) return beatCache.get(uri);
	let grid = null;
	try {
		const get = globalThis.Spicetify?.getAudioData;
		if (typeof get === "function") grid = parseAnalysis(await get(uri));
	} catch {
		/* no analysis for this track, or the endpoint is unavailable */
	}
	beatCache.set(uri, grid);
	if (beatCache.size > BEAT_CACHE_MAX) beatCache.delete(beatCache.keys().next().value);
	return grid;
}

// ---- stats.js --------------------------------------------------------------
// Listening stats: time spent with the fullscreen lyrics open while music plays, broken down by
// song, artist, day and theme, plus lines sung along. One small JSON object in local storage.
// The functions here are pure (they take and change a stats object); overlay.js drives them.

const STATS_MAX_SONGS = 400;
const STATS_MAX_DAYS = 120;
const STREAK_MIN_MS = 60000; // a day counts toward the streak after a minute of lyrics

const pad2 = (n) => String(n).padStart(2, "0");
/** Local calendar day, "YYYY-MM-DD". */
function dayKey(ts) {
	const d = new Date(ts);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function emptyStats(now) {
	return { v: 1, since: now, ms: 0, lines: 0, days: {}, songs: {}, themes: {} };
}

/** A stored object, repaired or replaced if it isn't one of ours. */
function validStats(s, now) {
	if (!s || s.v !== 1 || typeof s.ms !== "number") return emptyStats(now);
	for (const k of ["days", "songs", "themes"]) if (!s[k] || typeof s[k] !== "object") s[k] = {};
	s.lines = Number(s.lines) || 0;
	s.since = Number(s.since) || now;
	return s;
}

/**
 * Add listening time. `fresh` marks the first time counted for this play of the track, so the
 * song's play count goes up once per play.
 */
function addTime(s, { ms, now, track, theme, fresh = false }) {
	if (!(ms > 0)) return;
	s.ms += ms;
	const d = dayKey(now);
	s.days[d] = (s.days[d] || 0) + ms;
	if (track?.uri) {
		const e = (s.songs[track.uri] ||= { t: "", a: "", ms: 0, n: 0, l: 0, last: 0 });
		e.t = track.title || e.t;
		e.a = track.artist || e.a;
		e.ms += ms;
		e.last = now;
		if (fresh) e.n++;
	}
	if (theme) s.themes[theme] = (s.themes[theme] || 0) + ms;
}

function addLine(s, uri) {
	s.lines++;
	if (uri && s.songs[uri]) s.songs[uri].l++;
}

/** Keep the object small: the newest days and the most-listened songs. */
function pruneStats(s) {
	const days = Object.keys(s.days).sort();
	for (const d of days.slice(0, Math.max(0, days.length - STATS_MAX_DAYS))) delete s.days[d];
	const songs = Object.entries(s.songs);
	if (songs.length > STATS_MAX_SONGS) {
		songs.sort((a, b) => b[1].ms - a[1].ms);
		for (const [uri] of songs.slice(STATS_MAX_SONGS)) delete s.songs[uri];
	}
	return s;
}

/** Days in a row with lyrics, ending today (or yesterday, so an unfinished today doesn't break it). */
function streak(s, now) {
	const has = (t) => (s.days[dayKey(t)] || 0) >= STREAK_MIN_MS;
	const DAY = 86400000;
	let t = now;
	if (!has(t)) t -= DAY;
	let n = 0;
	while (has(t)) (n++, (t -= DAY));
	return n;
}

/** Everything the Stats page shows. */
function summarize(s, now, days = 14) {
	const songs = Object.entries(s.songs).map(([uri, e]) => ({ uri, title: e.t, artist: e.a, ms: e.ms, plays: e.n, lines: e.l }));
	const artists = new Map();
	for (const e of songs) {
		const name = (e.artist || "").split(/,\s*/)[0];
		if (!name) continue;
		const a = artists.get(name) || { name, ms: 0, songs: 0 };
		a.ms += e.ms;
		a.songs++;
		artists.set(name, a);
	}
	const lastDays = [];
	for (let i = days - 1; i >= 0; i--) {
		const t = now - i * 86400000;
		lastDays.push({ day: dayKey(t), date: t, ms: s.days[dayKey(t)] || 0 });
	}
	const theme = Object.entries(s.themes).sort((a, b) => b[1] - a[1])[0];
	return {
		since: s.since,
		totalMs: s.ms,
		lines: s.lines,
		songCount: songs.length,
		streak: streak(s, now),
		todayMs: s.days[dayKey(now)] || 0,
		topSongs: songs.sort((a, b) => b.ms - a.ms).slice(0, 5),
		topArtists: [...artists.values()].sort((a, b) => b.ms - a.ms).slice(0, 5),
		lastDays,
		favTheme: theme ? { id: theme[0], ms: theme[1] } : null,
	};
}

/** "3 h 12 min", "12 min", "45 s". */
function fmtDuration(ms) {
	const m = Math.floor(ms / 60000);
	if (m < 1) return `${Math.round(ms / 1000)} s`;
	if (m < 60) return `${m} min`;
	const h = Math.floor(m / 60);
	return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

// ---- rain.js ---------------------------------------------------------------
// Rain on a window, drawn with WebGL (the Rain theme's ambience; if WebGL isn't there, the CSS
// scene in styles.css is used instead).
//
// The glass is misted, so the night city behind it is a blur of light. Drops of water on the glass
// are small lenses: through one you see the street sharp and upside down. The bigger drops run down
// in fits and starts and wipe a clear trail behind them; smaller beads come and go. All of that is
// worked out per pixel in one fragment shader from a few hashes (there are no textures for the drops).
// The only images are three copies of one night street, painted once with the 2D canvas and blurred
// by different amounts: the shader picks between them depending on how clear the glass is there.

const RAIN_VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const RAIN_FRAG = `#version 300 es
precision highp float;

uniform vec2 uRes;
uniform float uTime;
uniform float uRain;   // how hard it rains, 0..1
uniform float uFlash;  // lightning, 0..1
uniform float uPulse;  // the beat, 0..1
uniform sampler2D uSharp;
uniform sampler2D uMid;
uniform sampler2D uFog;
out vec4 fragColor;

#define S smoothstep

float aspect;

float h11(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec4 h41(float n) { return fract(sin(n * vec4(12.9898, 78.233, 37.719, 93.989) + vec4(4.14, 1.32, 9.71, 2.55)) * 43758.5453); }
vec4 h42(vec2 p) {
	return fract(sin(vec4(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)), dot(p, vec2(419.2, 371.9)), dot(p, vec2(63.7, 91.3)))) * 43758.5453);
}
float vnoise(vec2 x) {
	vec2 i = floor(x), f = fract(x);
	f = f * f * (3. - 2. * f);
	return mix(mix(h21(i), h21(i + vec2(1., 0.)), f.x), mix(h21(i + vec2(0., 1.)), h21(i + vec2(1., 1.)), f.x), f.y);
}
float fbm(vec2 x) { return .62 * vnoise(x) + .38 * vnoise(x * 2.13 + 7.7); }

// ---- the night outside -----------------------------------------------------------------------
// Cars go by on the street: head lights one way, tail lights the other. How sharp the glass is
// there sets how big and soft each light is.
vec3 traffic(vec2 uv, float sharp) {
	vec3 acc = vec3(0.);
	float rad = mix(.05, .011, sharp);
	for (int i = 0; i < 4; i++) {
		float fi = float(i);
		vec4 r = h41(fi + 3.);
		float dir = (i % 2 == 0) ? 1. : -1.;
		float x = fract(dir * uTime / mix(24., 46., r.x) + r.y);
		float y = mix(.79, .9, r.z);
		vec3 col = dir > 0. ? vec3(1., .1, .06) : vec3(1., .86, .62);
		for (int k = 0; k < 2; k++) {
			vec2 c = vec2(x + (float(k) - .5) * mix(.026, .04, r.w), y);
			float d = length((uv - c) * vec2(aspect, 1.));
			acc += col * S(rad, rad * .3, d) * mix(.45, 1.15, sharp);
		}
	}
	return acc * .75;
}

vec3 world(vec2 uv, float sharp) {
	uv = clamp(uv, vec2(.003), vec2(.997));
	vec3 f = texture(uFog, uv).rgb;
	vec3 m = texture(uMid, uv).rgb;
	vec3 s = texture(uSharp, uv).rgb;
	vec3 c = mix(mix(f, m, S(0., .5, sharp)), s, S(.5, 1., sharp));
	c += traffic(uv, sharp);
	float lum = dot(c, vec3(.3, .59, .11));
	c *= 1. + uPulse * .3 * S(.2, .75, lum); // on the beat the lights swell
	c *= 1. + uFlash * .9;
	c += uFlash * vec3(.3, .42, .75) * S(.65, .0, uv.y) * .6; // lightning lights the low cloud
	return c;
}

// ---- drops ------------------------------------------------------------------------------------
struct Lens {
	float cov;   // how much of this pixel is inside a drop
	vec2 uv;     // where in the world it looks: a drop mirrors what is around it
	float rim;   // the dark edge of the drop
	float lit;   // the bright arc on its lower edge
	float spec;  // the sharp glint at its top
	float trail; // how clear the glass is here because a drop has run over it
	float edge;  // the thin bright line along each side of a trail, where the water stands
};

void lens(inout Lens L, vec2 p, vec2 c, float R, float squash, float K) {
	vec2 d = p - c;
	vec2 q = vec2(d.x, d.y / squash) / R;
	float r = length(q);
	float cov = S(1.03, .93, r);
	if (cov > L.cov) {
		L.cov = cov;
		L.uv = vec2(c.x / aspect, c.y) - vec2(d.x / aspect, d.y) * K; // inverted, and widened by K
		L.rim = S(.5, 1., r);
		vec2 n = q / max(r, .001);
		L.lit = S(.25, .95, dot(n, normalize(vec2(.55, .83)))) * S(.55, .95, r);
		L.spec = S(.42, .0, length(q - vec2(-.38, -.44)));
	}
}

// A drop slides down in four bursts, stalling in between (ph is 0..1 over its life).
float slide(float ph, vec4 r) {
	float a = mix(.12, .3, r.x), b = mix(.12, .3, r.y), c = mix(.1, .26, r.z);
	float d = max(1. - a - b - c, .14);
	float s = a * S(.05, .14, ph) + b * S(.3, .4, ph) + c * S(.55, .66, ph) + d * S(.78, .92, ph);
	return s / (a + b + c + d);
}

// How far a drop's path wanders sideways at height y.
float swayAt(float y, vec4 r) { return .006 * sin(y * 41. + r.w * 20.) + .0035 * sin(y * 103. + r.x * 9.); }

// A column of big drops: each column carries two, running out of step with each other.
void runners(inout Lens L, vec2 p, float colW, float rlo, float rhi, float seed, float speed) {
	float id = floor(p.x / colW);
	float cx = (id + .5) * colW;
	for (int k = 0; k < 2; k++) {
		vec4 r = h41(id * 7.13 + float(k) * 31.7 + seed);
		vec4 g = h41(id * 3.71 + float(k) * 11.3 + seed + 90.);
		if (r.x > mix(.4, 1., uRain)) continue;
		float T = mix(11., 25., r.y) / (speed * mix(.7, 1.5, uRain));
		float ph = fract(uTime / T + r.z);
		float y0 = mix(-.04, .62, g.x);
		float yh = y0 + slide(ph, g) * (1.2 - y0);
		float R = mix(rlo, rhi, g.y);
		float xo = (g.z - .5) * (colW - 3.4 * R);
		float x0 = cx + xo;
		// the drop itself
		lens(L, p, vec2(x0 + swayAt(yh, r), yh), R, 1.16, 2.5);
		// the trail it leaves: narrow at the start, wider toward the drop, and it fades as the life ends
		float k01 = clamp((p.y - y0) / max(yh - y0, .001), 0., 1.);
		float inT = S(y0 - .004, y0 + .02, p.y) * S(yh + .004, yh - .02, p.y);
		float w = R * (.13 + .55 * k01);
		float dx = abs(p.x - (x0 + swayAt(p.y, r)));
		float fade = S(1., .86, ph);
		L.trail = max(L.trail, S(w, w * .3, dx) * inT * fade);
		L.edge = max(L.edge, (S(w * 1.6, w * 1.08, dx) - S(w * 1.08, w * .72, dx)) * inT * fade * S(.02, .1, k01));
		// beads of water it drops along the way
		float by = p.y * 19. + g.w * 9.;
		float bi = floor(by);
		vec4 bh = h41(bi + id * 13. + seed + float(k) * 5.);
		if (bh.x < .38) {
			float bcy = (bi + .5 - g.w * 9.) / 19.;
			float inB = S(y0, y0 + .03, bcy) * S(yh - .01, yh - .05, bcy) * fade;
			if (inB > .5) lens(L, p, vec2(x0 + swayAt(bcy, r) + (bh.y - .5) * R * .9, bcy), R * mix(.22, .42, bh.z), 1.1, 2.2);
		}
	}
}

// Small beads that sit on the glass, come and go.
void beads(inout Lens L, vec2 p, float cs, float rmax, float seed, float dens) {
	vec2 g = p / cs;
	vec2 id = floor(g);
	vec4 h = h42(id + seed);
	if (h.w > dens * mix(.55, 1., uRain)) return;
	float life = fract(uTime / mix(14., 44., h.z) + h.x * 13.); // beads come and go, so the glass keeps changing
	float R = rmax * mix(.35, 1., h.y) * S(0., .06, life) * S(1., .8, life);
	if (R < .0015) return;
	vec2 c = (id + .5 + (h.xy - .5) * .38) * cs;
	lens(L, p, c, R, 1.12, 2.4);
}

void main() {
	aspect = uRes.x / uRes.y;
	vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1. - gl_FragCoord.y / uRes.y);
	vec2 p = vec2(uv.x * aspect, uv.y);

	Lens L = Lens(0., uv, 0., 0., 0., 0., 0.);
	runners(L, p, .17, .017, .03, 1., 1.);
	runners(L, p, .085, .0082, .0135, 40., 1.4);
	beads(L, p, .07, .02, 7., .55);
	beads(L, p, .034, .0102, 19., .62);
	beads(L, p, .017, .0052, 31., .5);

	// the glass: misted, more toward the bottom, with patches wiped clearer here and there
	float wipe = S(.44, .8, fbm(p * 2.4 + vec2(3., uTime * .004)));
	vec2 haze = vec2(sin(p.y * 7. + uTime * .35), sin(p.x * 5. - uTime * .3)) * .0016; // the mist shimmers a little
	vec3 col = world(uv + haze, wipe * .3);
	col += vec3(.07, .1, .14) * (.35 + .65 * uv.y) * .55;

	// a trail is clear glass: the street is nearly sharp there, and bent a little, with water
	// standing along its two sides
	if (L.trail > .002) {
		vec2 uvT = uv + vec2(sin(p.y * 90.) * .0012, 0.);
		col = mix(col, mix(col, world(uvT, .62), .82) * 1.02, L.trail);
	}
	col += L.edge * vec3(.5, .62, .85) * .18;

	// a drop shows the street upside down and sharp, darker at its edge, with a glint on it
	if (L.cov > .002) {
		vec2 fringe = (L.uv - uv) * .045; // the lens bends red and blue a little differently
		vec3 d = vec3(world(L.uv + fringe, .94).r, world(L.uv, .94).g, world(L.uv - fringe, .94).b) * 1.35;
		d = mix(d, col * 1.15 + vec3(.02, .03, .05), .16); // some of the mist shows through
		d *= mix(1., .4, L.rim);
		d += L.lit * vec3(.5, .62, .8) * .5;
		d += L.spec * vec3(1., .97, .92) * .9;
		col = mix(col, d, L.cov);
	}

	// the window frame: a dark rim, with a thin lit edge where the glass meets it
	float rim = min(min(uv.x * aspect, (1. - uv.x) * aspect), min(uv.y, 1. - uv.y));
	float inFrame = S(.016, .012, rim);
	col = mix(col, vec3(.012, .016, .024), inFrame);
	col += S(.02, .016, rim) * (1. - inFrame) * vec3(.32, .4, .55) * .1;

	// grade: cool, a little desaturated, darker at the edges
	col = mix(vec3(dot(col, vec3(.3, .59, .11))), col, .9);
	col *= vec3(.95, 1., 1.07);
	col *= 1. - .55 * pow(length((uv - .5) * vec2(1.05, 1.25)), 2.3);
	col += (h21(gl_FragCoord.xy + fract(uTime) * 91.) - .5) * .014;
	fragColor = vec4(max(col, 0.), 1.);
}`;

// ---------------------------------------------------------------------------------------------
// Colour helpers (the album's accent tints the neon signs in the street)
// ---------------------------------------------------------------------------------------------

/** "rgb(…)", "rgba(…)", "color(srgb r g b)" or "#rgb"/"#rrggbb" → [r, g, b] (0-255), or null. */
function parseCssColor(s) {
	if (typeof s !== "string") return null;
	s = s.trim().toLowerCase();
	let m = s.match(/^#([0-9a-f]{3,8})$/);
	if (m) {
		let h = m[1];
		if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
		if (h.length !== 6 && h.length !== 8) return null;
		return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
	}
	m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
	if (m) return [m[1], m[2], m[3]].map((v) => Math.max(0, Math.min(255, Math.round(Number(v)))));
	m = s.match(/^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
	if (m) return [m[1], m[2], m[3]].map((v) => Math.max(0, Math.min(255, Math.round(Number(v) * 255))));
	return null;
}

function rainHsl([r, g, b]) {
	r /= 255;
	g /= 255;
	b /= 255;
	const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
	if (mx === mn) return [0, 0, l];
	const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
	const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return [h * 60, s, l];
}

function rainRgb(h, s, l) {
	h = ((h % 360) + 360) % 360;
	const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
	const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

/** Two neon colours for the street ("r,g,b" strings): the accent made vivid, and one across the wheel
 *  from it. A dull accent (white, grey) falls back to a warm pink and a cool cyan. */
function rainTint(rgb) {
	const [h, s] = rgb ? rainHsl(rgb) : [0, 0, 0];
	const base = s > 0.22 ? h : 330;
	return { a: rainRgb(base, 0.9, 0.58).join(","), b: rainRgb(base + (s > 0.22 ? 150 : 180), 0.85, 0.58).join(",") };
}

// ---------------------------------------------------------------------------------------------
// The street, painted once (512x288) and blurred three ways
// ---------------------------------------------------------------------------------------------
function rainRng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function rainGlow(g, x, y, r, rgb, a) {
	const k = g.createRadialGradient(x, y, 0, x, y, r);
	k.addColorStop(0, `rgba(${rgb},${a})`);
	k.addColorStop(1, `rgba(${rgb},0)`);
	g.fillStyle = k;
	g.fillRect(x - r, y - r, r * 2, r * 2);
}

const RAIN_WINDOWS = ["255,214,138", "255,243,208", "255,196,120", "181,212,255", "255,232,170"];

function rainSkyline(g, rnd, W, base, o) {
	let x = -10;
	while (x < W + 10) {
		const bw = o.minW + rnd() * (o.maxW - o.minW);
		const bh = o.minH + rnd() * (o.maxH - o.minH);
		g.fillStyle = o.fill;
		g.fillRect(x, base - bh, bw, bh + 40);
		if (rnd() < 0.35) g.fillRect(x + bw * 0.3, base - bh - 4 - rnd() * 8, bw * 0.12, 12); // a plant room on the roof
		const cw = o.ws * 2.2, ch = o.ws * 2.7;
		for (let wx = x + 3; wx < x + bw - cw - 2; wx += cw + 1.5) {
			for (let wy = base - bh + 5; wy < base - 4; wy += ch + 1.7) {
				if (rnd() > o.lit) continue;
				g.fillStyle = `rgba(${RAIN_WINDOWS[(rnd() * RAIN_WINDOWS.length) | 0]},${((0.35 + rnd() * 0.6) * o.dim).toFixed(2)})`;
				g.fillRect(wx, wy, o.ws, o.ws * 1.3);
			}
		}
		x += bw + rnd() * 3;
	}
}

function rainPaint(g, W, H, tint) {
	const rnd = rainRng(11);
	const sky = g.createLinearGradient(0, 0, 0, H);
	[[0, "#03050c"], [0.3, "#0a1226"], [0.55, "#182749"], [0.7, "#26294d"], [1, "#080b16"]].forEach(([o, c]) => sky.addColorStop(o, c));
	g.fillStyle = sky;
	g.fillRect(0, 0, W, H);
	// the city's glow on the low cloud
	rainGlow(g, W * 0.5, H * 0.62, W * 0.7, "255,150,90", 0.26);
	rainGlow(g, W * 0.16, H * 0.6, W * 0.34, tint.a, 0.2);
	rainGlow(g, W * 0.84, H * 0.58, W * 0.34, tint.b, 0.18);
	// two skylines: far and small, near and big
	rainSkyline(g, rnd, W, H * 0.74, { minH: H * 0.12, maxH: H * 0.34, minW: 14, maxW: 34, fill: "#0b1329", lit: 0.16, ws: 2.2, dim: 0.6 });
	rainSkyline(g, rnd, W, H * 0.77, { minH: H * 0.2, maxH: H * 0.5, minW: 26, maxW: 60, fill: "#060a17", lit: 0.26, ws: 3, dim: 1 });
	// red beacons on the towers
	g.globalCompositeOperation = "lighter";
	for (let i = 0; i < 4; i++) rainGlow(g, 30 + rnd() * (W - 60), H * (0.3 + rnd() * 0.08), 6, "255,60,50", 0.9);
	// neon signs: a rectangle, a ring, a zigzag
	const signs = [
		[0.1, 0.52, tint.a, "rect"],
		[0.33, 0.44, tint.b, "ring"],
		[0.62, 0.5, tint.a, "zig"],
		[0.86, 0.46, tint.b, "rect"],
	];
	for (const [fx, fy, rgb, kind] of signs) {
		const x = fx * W, y = fy * H;
		rainGlow(g, x, y, 34, rgb, 0.4);
		g.save();
		g.shadowColor = `rgb(${rgb})`;
		g.shadowBlur = 9;
		g.strokeStyle = `rgba(${rgb},0.95)`;
		g.lineWidth = 2;
		g.beginPath();
		if (kind === "rect") g.rect(x - 14, y - 8, 28, 16);
		else if (kind === "ring") g.arc(x, y, 10, 0, Math.PI * 2);
		else {
			g.moveTo(x - 16, y + 6);
			g.lineTo(x - 6, y - 8);
			g.lineTo(x + 4, y + 6);
			g.lineTo(x + 16, y - 8);
		}
		g.stroke();
		g.restore();
	}
	// the street: lamps, shop fronts, cars standing in the traffic
	const lights = [];
	for (let i = 0; i < 9; i++) lights.push([W * (0.04 + i * 0.115) + rnd() * 10, H * (0.72 + rnd() * 0.04), 3.2 + rnd() * 1.6, "255,190,108"]); // street lamps
	for (let i = 0; i < 6; i++) lights.push([rnd() * W, H * (0.8 + rnd() * 0.08), 2.4 + rnd() * 1.4, rnd() < 0.5 ? "255,52,44" : "255,236,190"]); // cars
	lights.push([W * 0.7, H * 0.7, 3, "60,255,140"], [W * 0.7, H * 0.66, 3, "255,60,50"]); // a traffic light
	// the road, wet: a dark surface and each light smeared down it
	const road = g.createLinearGradient(0, H * 0.77, 0, H);
	road.addColorStop(0, "rgba(10,14,28,0.9)");
	road.addColorStop(1, "rgba(4,6,14,1)");
	g.globalCompositeOperation = "source-over";
	g.fillStyle = road;
	g.fillRect(0, H * 0.77, W, H);
	g.globalCompositeOperation = "lighter";
	for (const [x, y, r, rgb] of lights) {
		rainGlow(g, x, y, r * 6, rgb, 0.45);
		rainGlow(g, x, y, r * 2, rgb, 0.95);
		const sm = g.createLinearGradient(0, y + r, 0, Math.min(H, y + r + 46));
		sm.addColorStop(0, `rgba(${rgb},0.34)`);
		sm.addColorStop(1, `rgba(${rgb},0)`);
		g.fillStyle = sm;
		g.fillRect(x - r * 0.9, y + r, r * 1.8, 46);
	}
	g.globalCompositeOperation = "source-over";
}

// ---------------------------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------------------------

/**
 * createRain(canvas, root, bg): draws into `canvas`. `root` (.aur-root) and `bg` (.aur-bg) are read
 * for the signals that drive the scene: data-gap on root (an instrumental break: it rains harder)
 * and data-bt / data-bar on bg (the beat and the bar, flipping a/b).
 * Returns { init, start, stop, still, flash, ok, running }; ok is null until init() has run.
 */
function createRain(canvas, root, bg) {
	const S = {
		gl: null, loc: {}, tex: [], ok: null, running: false, raf: 0, last: 0, t0: 0, still: false,
		scale: 0.5, w: 0, h: 0, sized: false, tintKey: "", tintAt: 0, dts: [],
		flashAt: -1e9, nextFlash: 0, pulse: 0, bt: "", bar: "", rain: 0.55, lastNow: 0,
	};
	const FRAME_MS = 1000 / 30;
	const TEX = 3;
	let observer = null;

	function compile(gl, type, src) {
		const sh = gl.createShader(type);
		gl.shaderSource(sh, src);
		gl.compileShader(sh);
		if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || "shader");
		return sh;
	}

	function init() {
		if (S.ok !== null) return S.ok;
		S.ok = false;
		try {
			const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
			if (!gl) return false;
			const prog = gl.createProgram();
			gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, RAIN_VERT));
			gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, RAIN_FRAG));
			gl.linkProgram(prog);
			if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "link");
			gl.useProgram(prog);
			const buf = gl.createBuffer();
			gl.bindBuffer(gl.ARRAY_BUFFER, buf);
			gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
			const a = gl.getAttribLocation(prog, "aPos");
			gl.enableVertexAttribArray(a);
			gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
			for (const n of ["uRes", "uTime", "uRain", "uFlash", "uPulse", "uSharp", "uMid", "uFog"]) S.loc[n] = gl.getUniformLocation(prog, n);
			for (let i = 0; i < TEX; i++) {
				const t = gl.createTexture();
				gl.activeTexture(gl.TEXTURE0 + i);
				gl.bindTexture(gl.TEXTURE_2D, t);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
				S.tex.push(t);
			}
			gl.uniform1i(S.loc.uSharp, 0);
			gl.uniform1i(S.loc.uMid, 1);
			gl.uniform1i(S.loc.uFog, 2);
			S.gl = gl;
			canvas.style.color = "var(--aur-accent)"; // read back later, to tint the neon in the street
			canvas.addEventListener("webglcontextlost", (e) => {
				e.preventDefault();
				stop();
				S.ok = false;
				root.dataset.gl = "off";
			});
			if (typeof ResizeObserver === "function") {
				observer = new ResizeObserver((es) => {
					const r = es[0]?.contentRect;
					if (!r) return;
					S.w = r.width;
					S.h = r.height;
					S.sized = true;
					if (S.still && S.running === false && S.ok) requestAnimationFrame(() => draw(performance.now()));
				});
				observer.observe(canvas);
			}
			S.ok = true;
		} catch (err) {
			console.warn("[Aurora Lyrics] rain: WebGL scene unavailable, using the CSS one:", err?.message || err);
			S.ok = false;
		}
		return S.ok;
	}

	/** The colours of the neon in the street follow the album's accent (read from the CSS). */
	function readTint() {
		let rgb = null;
		try {
			rgb = parseCssColor(getComputedStyle(canvas).color);
		} catch {}
		return rainTint(rgb);
	}

	/** Paint the street and upload it, when it hasn't been yet or when the accent has changed (checked
	 *  every second and a half, not every frame, since reading the colour costs a style calculation). */
	function upload(now) {
		if (S.tintKey && now - S.tintAt < 1500) return;
		S.tintAt = now;
		const gl = S.gl;
		const tint = readTint();
		const key = tint.a + "|" + tint.b;
		if (key === S.tintKey) return;
		S.tintKey = key;
		const W = 512, H = 288;
		const base = document.createElement("canvas");
		base.width = W;
		base.height = H;
		rainPaint(base.getContext("2d"), W, H, tint);
		// sharp (barely softened), mid, and fog: the blur in px of the 512-wide picture
		[0.7, 3.6, 11].forEach((blur, i) => {
			const c = document.createElement("canvas");
			c.width = W;
			c.height = H;
			const g = c.getContext("2d");
			g.filter = `blur(${blur}px)`;
			const m = Math.ceil(blur * 2); // draw a little larger so the blur has no dark edge
			g.drawImage(base, -m, -m, W + m * 2, H + m * 2);
			gl.activeTexture(gl.TEXTURE0 + i);
			gl.bindTexture(gl.TEXTURE_2D, S.tex[i]);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
		});
	}

	function signals(now) {
		const dt = Math.min(0.25, Math.max(0, (now - S.lastNow) / 1000));
		S.lastNow = now;
		const gap = root.dataset.gap === "on";
		S.rain += ((gap ? 0.95 : 0.55) - S.rain) * Math.min(1, dt * 0.6);
		S.pulse *= Math.exp(-dt / 0.16);
		if (bg.dataset.bt && bg.dataset.bt !== S.bt) S.pulse = Math.max(S.pulse, 0.7);
		if (bg.dataset.bar && bg.dataset.bar !== S.bar) {
			S.pulse = 1;
			if (Math.random() < 0.06 && now - S.flashAt > 7000) S.flashAt = now; // now and then a bar brings lightning
		}
		S.bt = bg.dataset.bt || "";
		S.bar = bg.dataset.bar || "";
		if (now >= S.nextFlash) {
			if (S.nextFlash) S.flashAt = now;
			S.nextFlash = now + (gap ? 5000 + Math.random() * 8000 : 13000 + Math.random() * 26000);
		}
		const f = (now - S.flashAt) / 1000;
		const flash = f < 0 || f > 1.2 ? 0 : Math.max(f < 0.6 ? Math.exp(-f / 0.08) : 0, f > 0.18 ? 0.7 * Math.exp(-(f - 0.18) / 0.13) : 0);
		return flash * 0.85;
	}

	function draw(now) {
		const gl = S.gl;
		if (!gl || !S.sized || !S.w || !S.h) return;
		const w = Math.max(64, Math.round(S.w * S.scale)), h = Math.max(36, Math.round(S.h * S.scale));
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
			gl.viewport(0, 0, w, h);
		}
		upload(now);
		const flash = S.still ? 0 : signals(now);
		const t = S.still ? 41 : ((now - S.t0) / 1000) % 100000;
		gl.uniform2f(S.loc.uRes, w, h);
		gl.uniform1f(S.loc.uTime, t);
		gl.uniform1f(S.loc.uRain, S.rain);
		gl.uniform1f(S.loc.uFlash, flash);
		gl.uniform1f(S.loc.uPulse, S.pulse);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	}

	function loop(now) {
		S.raf = 0;
		if (!S.running) return;
		S.raf = requestAnimationFrame(loop);
		if (now - S.last < FRAME_MS - 2) return;
		// if frames arrive far slower than asked for, the machine is struggling: draw fewer pixels
		S.dts.push(now - S.last);
		S.last = now;
		if (S.dts.length >= 90) {
			const avg = S.dts.reduce((a, b) => a + b, 0) / S.dts.length;
			S.dts.length = 0;
			if (avg > FRAME_MS * 1.7 && S.scale > 0.3) S.scale = Math.max(0.3, S.scale * 0.8);
		}
		draw(now);
	}

	/** Animate. */
	function start() {
		if (!S.ok || S.running) return;
		S.still = false;
		S.running = true;
		if (!S.t0) S.t0 = performance.now();
		S.lastNow = performance.now();
		if (!S.nextFlash) S.nextFlash = S.lastNow + 6000 + Math.random() * 8000;
		S.raf = requestAnimationFrame(loop);
	}

	function stop() {
		S.running = false;
		if (S.raf) cancelAnimationFrame(S.raf);
		S.raf = 0;
	}

	/** One still frame (the animated background is off). */
	function still() {
		if (!S.ok) return;
		stop();
		S.still = true;
		requestAnimationFrame(() => draw(performance.now()));
	}

	/** Lightning, now. */
	function flash() {
		S.flashAt = performance.now();
	}

	return { init, start, stop, still, flash, get ok() { return S.ok; }, get running() { return S.running; } };
}

// ---- scene-glsl.js ---------------------------------------------------------
// The parts every scene shares (scenes.js draws them): the vertex shader and the head of a fragment
// shader (the signals a scene is driven by, and a few small helpers).

const SCENE_VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const SCENE_HEAD = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uA;      // the theme's colours, from the album's accent (0..1)
uniform vec3 uB;
uniform vec3 uC;
uniform vec3 uBase;   // the album's deep colour, darkened: the tint of the dark
uniform float uBeat;  // 1 on a beat, falling away
uniform float uBar;   // 1 on the first beat of a bar
uniform float uLine;  // 1 when a new line starts
uniform float uLineId;// which of the scene's parts that new line wakes (0..4)
uniform float uGap;   // 0..1: an instrumental break
uniform float uSong;  // how far through the song, 0..1
uniform float uCentered; // 1 in the layouts that centre the cover (Captions, Stage), else 0
uniform vec4 uText;   // where the lyrics are (x0, y0, x1, y1 in 0..1, y down): a scene keeps its brightest parts clear of it
uniform vec4 uMeta;   // and the song title beside the cover
out vec4 fragColor;

// smoothstep that is happy with its edges either way round
float sst(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0., 1.); return t * t * (3. - 2. * t); }
float h11(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec4 h42(vec2 p) {
	return fract(sin(vec4(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)), dot(p, vec2(419.2, 371.9)), dot(p, vec2(63.7, 91.3)))) * 43758.5453);
}
float vnoise(vec2 x) {
	vec2 i = floor(x), f = fract(x);
	f = f * f * (3. - 2. * f);
	return mix(mix(h21(i), h21(i + vec2(1., 0.)), f.x), mix(h21(i + vec2(0., 1.)), h21(i + vec2(1., 1.)), f.x), f.y);
}
float fbm(vec2 x) { return .5 * vnoise(x) + .3 * vnoise(x * 2.07 + 7.7) + .2 * vnoise(x * 4.3 + 3.1); }
float sdSeg(vec2 p, vec2 a, vec2 b) {
	vec2 pa = p - a, ba = b - a;
	return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0., 1.));
}
// 1 inside a box (feathered), 0 outside
float inBox(vec4 r, vec2 uv) {
	float bx = sst(r.x - .03, r.x + .06, uv.x) * sst(r.z + .03, r.z - .06, uv.x);
	float by = sst(r.y - .04, r.y + .08, uv.y) * sst(r.w + .02, r.w - .1, uv.y);
	return bx * by;
}
// 1 where there are words to read (the lyrics, the song title), 0 elsewhere
float inText(vec2 uv) { return max(inBox(uText, uv), inBox(uMeta, uv)); }
`;

// ---- scene-neon.js ---------------------------------------------------------
// Neon: glass tubes of light over a dark wet floor (the Neon theme's scene; see scenes.js).
//
// Long tubes of neon sweep across a dark room, each a wave made of a few sines, so how far a pixel is
// from the tube is cheap to work out. A tube is a hot core in a coloured body in a halo of light that
// spills into haze (the haze is noise, so the light has texture). Light runs along the tubes. Two glass
// signs, a ring and a bolt, stand at the edges and now and then stutter like a tired transformer.
// Below a horizon the floor is wet glass: the same lights, mirrored, blurred and rippled. Sparks of
// dust drift through it all. On every beat the light swells, on the bar it surges, and on every new
// line one part of the scene flares; in a break it all dims and slows.


const NEON_FRAG =
	SCENE_HEAD +
	`
float aspect;
 const float HORIZON = .3;

// height of a wave at x, and its slope
vec2 wave(float x, float y0, vec3 a, vec3 k, vec3 w, vec3 ph, float t) {
	vec3 s = k * x + w * t + ph;
	return vec2(y0 + dot(a, sin(s)), dot(a * k, cos(s)));
}

// light of a glass tube at signed distance d from its axis (+ below it), radius r;
// soft > 0 blurs it (the reflection), surge swells the spill, haze textures it
vec3 tube(float d, float r, vec3 col, float soft, float surge, float haze) {
	float ad = abs(d);
	float rr = r * (1. + soft);
	float body = sst(rr * 1.15, rr * .72, ad);                  // the gas glows right to the glass
	float core = sst(rr * .62, 0., ad);                         // and brightest in the middle
	float rim = sst(rr * 1.35, rr * 1.12, ad) * sst(rr * .9, rr * 1.12, ad); // the glass wall catches a little light
	float near = exp(-ad / (rr * 3.4));
	float spill = near * .42 + exp(-ad / (rr * 12.)) * .17 * haze + exp(-ad / (rr * 55.)) * .05 * haze;
	float glint = exp(-pow((d + rr * .55) / (rr * .2), 2.)) * (1. - soft);
	vec3 sat = pow(col, vec3(1.18));                            // colour deepens away from the tube
	vec3 c = col * body * 1.05 + sat * spill * surge * 1.25 + mix(col, vec3(1.), .62) * core * .85 + vec3(rim * .1 + glint * .22);
	return c / (1. + soft * 1.4);
}

// the tubes and signs as light; p is centred, one screen high, y down. calm holds the tubes back (the lyrics are here)
vec3 lights(vec2 p, float soft, float haze, float calm) {
	float t = uTime * (1. - .45 * uGap);
	float surge = (1. + .3 * uBeat + .55 * uBar) * (1. - .3 * uGap);
	vec3 acc = vec3(0.);
	vec2 c;
	float d, flow, wake, fl;

	// 1: the big one, in the accent colour, low across the room
	c = wave(p.x, .205, vec3(.055, .03, .004), vec3(1.5, 3.4, 8.), vec3(.19, .31, .57), vec3(0., 1.9, 4.2), t);
	d = (p.y - c.x) / sqrt(1. + c.y * c.y);
	flow = .8 + .2 * sin(p.x * 6.5 - t * 2.3);
	wake = 1. + 1.4 * uLine * step(abs(uLineId - 0.), .5);
	acc += tube(d, .0085, uA, soft, surge * flow * wake, haze) * calm;

	// 2: second colour, high up, slower
	c = wave(p.x, -.36, vec3(.07, .032, .004), vec3(1.1, 2.7, 9.), vec3(-.16, .27, .5), vec3(2.1, .4, 3.), t);
	d = (p.y - c.x) / sqrt(1. + c.y * c.y);
	flow = .8 + .2 * sin(p.x * 5.1 + t * 1.9 + 1.);
	wake = 1. + 1.4 * uLine * step(abs(uLineId - 1.), .5);
	acc += tube(d, .0068, uB, soft, surge * flow * wake, haze) * calm;

	// 3: a thin one through the middle, far away
	c = wave(p.x, -.17, vec3(.09, .035, .005), vec3(.8, 2.2, 7.), vec3(.12, -.2, .4), vec3(4., 2.2, 1.), t);
	d = (p.y - c.x) / sqrt(1. + c.y * c.y);
	flow = .72 + .28 * sin(p.x * 8. - t * 2.9 + 2.);
	wake = 1. + 1.4 * uLine * step(abs(uLineId - 2.), .5);
	acc += tube(d, .0036, uC, soft, surge * flow * wake, haze) * calm * .7;

	// 4: thin, accent, near the floor
	c = wave(p.x, .265, vec3(.035, .02, .003), vec3(1.9, 4.1, 10.), vec3(.24, -.33, .6), vec3(1., 3.1, 5.), t);
	d = (p.y - c.x) / sqrt(1. + c.y * c.y);
	flow = .72 + .28 * sin(p.x * 9. - t * 2.6 + 4.);
	acc += tube(d, .0038, uA, soft, surge * flow, haze) * calm * .75;

	// 5: thin, second colour, along the top
	c = wave(p.x, -.46, vec3(.03, .018, .003), vec3(1.7, 3.8, 9.), vec3(.2, .3, -.5), vec3(.3, 5., 2.), t);
	d = (p.y - c.x) / sqrt(1. + c.y * c.y);
	acc += tube(d, .0034, uB, soft, surge, haze) * calm * .7;

	// the ring sign, top right, half off the screen
	vec2 rc = vec2(aspect * .5 - .05, -.5 + .07);
	float rd = length(p - rc);
	fl = 1. - .8 * step(.992, h11(floor(uTime * 5.) + 3.));
	wake = 1. + 1.2 * uLine * step(abs(uLineId - 3.), .5);
	acc += (tube(rd - .21, .0074, uC, soft, surge * wake, haze) + tube(rd - .15, .0054, uC, soft, surge * wake, haze) * .85) * fl;

	// the bolt sign, bottom right: a closed outline of six corners
	vec2 bp = p - vec2(aspect * .5 - .11, .27);
	vec2 b0 = vec2(.048, -.178), b1 = vec2(-.092, .014), b2 = vec2(-.010, .014), b3 = vec2(-.062, .180), b4 = vec2(.100, -.040), b5 = vec2(.014, -.040);
	float bd = min(min(sdSeg(bp, b0, b1), sdSeg(bp, b1, b2)), min(sdSeg(bp, b2, b3), min(sdSeg(bp, b3, b4), min(sdSeg(bp, b4, b5), sdSeg(bp, b5, b0)))));
	fl = 1. - .85 * step(.97, h11(floor(uTime * 7.) + 11.));
	wake = 1. + 1.2 * uLine * step(abs(uLineId - 4.), .5);
	acc += tube(bd, .0078, uB, soft, surge * wake, haze) * fl;

	return acc;
}

// out-of-focus lights far behind everything: soft discs with a brighter edge, drifting very slowly
vec3 bokeh(vec2 p) {
	vec3 acc = vec3(0.);
	for (int i = 0; i < 3; i++) {
		float fi = float(i);
		vec2 g = p * mix(2.2, 5., fi / 2.) + vec2(uTime * (.012 + .008 * fi) * (fi > .5 ? -1. : 1.), uTime * .005 * (fi + 1.));
		vec2 id = floor(g);
		vec4 r = h42(id + fi * 57.);
		vec2 f = fract(g) - .5 - (r.yz - .5) * .45;
		float rad = mix(.18, .38, r.x);
		float d = length(f);
		float disc = sst(rad, rad * .86, d) * (.55 + .45 * sst(rad * .6, rad, d));
		float on = step(.74 - .1 * fi, r.w);
		acc += mix(uA, uB, fract(r.x * 7. + fi * .3)) * disc * on * (.075 - .018 * fi) * (1. + .6 * uBeat * step(.5, r.y));
	}
	return acc;
}

void main() {
	aspect = uRes.x / uRes.y;
	vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1. - gl_FragCoord.y / uRes.y);
	vec2 p = vec2((uv.x - .5) * aspect, uv.y - .5);
	float calm = 1. - .45 * inText(uv);

	// the dark: almost black, tinted by the album, lighter towards the floor
	vec3 col = mix(vec3(.010, .008, .026), uBase * .6 + vec3(.012, .01, .03), sst(-.5, .4, p.y));
	float haze = .4 + .8 * fbm(p * 1.8 + vec2(uTime * .011, uTime * .006));

	col += bokeh(p) * (1. - .6 * inText(uv)) * (1. - .5 * uGap);

	float depth = p.y - HORIZON;
	if (depth < .06) col += lights(p, 0., haze, calm) * sst(.06, -.02, depth);
	col += mix(uA, uB, .5) * exp(-abs(depth) * 18.) * (.05 + .05 * uBeat); // a glow where the room meets the floor
	if (depth > -.04) {
		// the floor: wet and dark; the room is in it, upside down, blurred and rippled
		float f = sst(-.04, .08, depth);
		vec2 q = vec2(p.x + sin(depth * 70. + uTime * 1.3) * .004 * (.4 + depth * 5.) + (vnoise(vec2(p.x * 9., depth * 40. - uTime * .4)) - .5) * .012, HORIZON - max(depth, 0.));
		vec3 refl = lights(q, 1.4 + max(depth, 0.) * 6., haze * .8, calm);
		float streak = .55 + .9 * vnoise(vec2(p.x * 5., depth * 55.));
		col = mix(col, col * .35 + uBase * .08, f);
		col += refl * streak * exp(-max(depth, 0.) * 3.4) * .5 * f;
	}

	// sparks of dust in the light
	for (int i = 0; i < 2; i++) {
		float fi = float(i);
		vec2 g = p * mix(7., 12., fi) + vec2(uTime * (.03 + .02 * fi), -uTime * (.05 + .03 * fi));
		vec2 id = floor(g);
		vec4 r = h42(id + fi * 31.);
		vec2 f = fract(g) - .5 - (r.yz - .5) * .5;
		float rad = mix(.05, .16, r.x) / (1. + fi * .6);
		float a = sst(rad, rad * .35, length(f)) * step(.68, r.w) * (.5 + .5 * sin(uTime * (.6 + r.x * 1.6) + r.y * 20.));
		col += mix(uA, uB, r.x) * a * .1 * (1. + uBeat * .8);
	}

	// grade: a hue-keeping shoulder so overlapping lights burn to white instead of clipping to a colour, a vignette, a little noise against banding
	float m = max(col.r, max(col.g, col.b));
	col *= 1.3 / (1. + max(m - .7, 0.) * 1.1);
	col += vec3(max(m - 1.5, 0.)) * .12;
	col *= 1. - .5 * pow(length((uv - .5) * vec2(1.05, 1.2)), 2.4);
	col += (h21(gl_FragCoord.xy + fract(uTime) * 91.) - .5) * .012;
	fragColor = vec4(clamp(col, 0., 1.), 1.);
}`;

// ---- scene-karaoke.js ------------------------------------------------------
// Karaoke: a KTV room (the Karaoke theme's scene; see scenes.js).
//
// A dark room full of party light. Six moving-head spotlights hang along the top and sweep slowly
// through the haze, each a cone with a bright core. A mirror ball hangs at the top right: its tiles
// turn, each reflecting a different colour and flashing now and then, and the light it throws is
// scattered over the room as a drift of small bright spots. In the centred layouts (Captions, Stage)
// a row of glass equaliser columns stands either side of the cover. On every beat the spots and the
// columns jump, on the bar the beams swing and widen, on every new line a different beam flares, and
// in a break the room dims and slows.


const KARAOKE_FRAG =
	SCENE_HEAD +
	`
float aspect;

// one moving-head beam: from s, along the angle a (0 = straight down), half-angle h, fading over len
float beam(vec2 p, vec2 s, float a, float h, float len) {
	vec2 dir = vec2(sin(a), cos(a));
	vec2 v = p - s;
	float along = dot(v, dir);
	float perp = abs(v.x * dir.y - v.y * dir.x);
	float w = .003 + max(along, 0.) * tan(h);
	float cone = sst(w, w * .2, perp);
	float core = exp(-perp / (w * .25));
	return (cone * .5 + core * .5) * exp(-max(along, 0.) / len) * sst(0., .05, along);
}

vec3 pick(float i) {
	float k = mod(i, 3.);
	return k < .5 ? uA : (k < 1.5 ? uB : uC);
}

// the spotlights
vec3 beams(vec2 p, float haze) {
	float t = uTime * (1. - .4 * uGap);
	float kick = .045 * uBeat + .09 * uBar;
	vec3 acc = vec3(0.);
	for (int i = 0; i < 6; i++) {
		float fi = float(i);
		float sx = (fi / 5. - .5) * aspect * .96;
		float a = (fi - 2.5) * .13 + .4 * sin(t * (.31 + .055 * fi) + fi * 1.9) + kick * (mod(fi, 2.) < 1. ? 1. : -1.);
		float wake = 1. + 1.6 * uLine * step(abs(uLineId - mod(fi, 5.)), .5);
		acc += pick(fi) * beam(p, vec2(sx, -.53), a, .034 + .016 * uBar, 1.15) * haze * (.5 + .3 * uBeat) * wake;
	}
	return acc;
}

// the mirror ball
vec4 ball(vec2 p, vec2 c, float R) {
	vec2 q = (p - c) / R;
	float r2 = dot(q, q);
	if (r2 > 1.) return vec4(0.);
	vec3 n = vec3(q, sqrt(1. - r2));
	float lon = atan(n.x, n.z) + uTime * .45;
	float lat = asin(clamp(n.y, -1., 1.));
	vec2 g = vec2(lon * 3.8197, lat * 5.093);
	vec2 id = floor(g), f = fract(g);
	vec4 r = h42(id + 5.);
	float edge = min(min(f.x, 1. - f.x), min(f.y, 1. - f.y));
	float tile = sst(.03, .14, edge);
	vec3 tc = mix(vec3(.2, .22, .32), mix(uA, uB, r.x), .45 + .45 * r.y);
	float flash = pow(max(0., sin(uTime * (1. + r.z * 2.5) + r.w * 40.)), 16.) * (.35 + r.y);
	vec3 col = (tc * (.3 + .55 * n.z) + vec3(flash * .9)) * tile;
	col *= .3 + .7 * n.z;
	col += uC * pow(1. - n.z, 3.) * .55;
	col += vec3(1.) * pow(max(0., dot(n, normalize(vec3(-.5, -.6, .65)))), 22.) * .8;
	return vec4(col, sst(1., .96, sqrt(r2)));
}

// the light the ball throws: small bright spots turning slowly round it
vec3 spots(vec2 p, vec2 c, float calm) {
	vec2 d = p - c;
	float rad = length(d);
	float ang = atan(d.y, d.x) + uTime * .09;
	vec2 g = vec2(ang * 7., rad * 12.);
	vec2 id = floor(g);
	vec4 r = h42(id + 3.1);
	vec2 f = fract(g) - .5 - (r.xy - .5) * .4;
	float s = sst(.24, .08, length(f)) * step(.52, r.z);
	float near = exp(-rad * 1.05) * sst(.1, .2, rad);
	vec3 col = mix(uA, mix(uB, uC, r.x), r.y);
	float tw = .5 + .5 * sin(uTime * (.8 + r.w) + r.x * 30.);
	return col * s * near * (.35 + .65 * tw) * (.55 + .5 * uBeat) * calm;
}

// the equaliser: two rows of segmented glass columns either side of the cover
vec3 eq(vec2 p) {
	float ax = abs(p.x);
	float k = floor((ax - .26) / .036);
	if (k < 0. || k > 11.) return vec3(0.);
	float side = p.x < 0. ? 0. : 1.;
	float cx = .26 + (k + .5) * .036;
	float dx = ax - cx;
	float level = .3 + .7 * vnoise(vec2(k * 1.3 + side * 7.1, uTime * (1.4 + .11 * k)));
	float h = (.05 + .21 * level * (.62 + .55 * uBeat + .25 * uBar)) * (1. - .55 * uGap);
	float base = .055;
	float pitch = .0128;
	float n = (base - p.y) / pitch;                       // segments counted up from the baseline
	if (n < 0. || n > 24.) return vec3(0.);
	float idx = floor(n);
	float nLit = floor(h / pitch);
	float lit = step(idx, nLit - 1.);                     // this segment is lit
	float peak = step(abs(idx - (nLit + 1.)), .5) * .45;  // and a dim mark floats just above the top
	float w = .0112;
	float cellX = sst(w, w * .72, abs(dx));
	float cellY = sst(.5, .34, abs(fract(n) - .5));       // rounded gaps between the segments
	float tt = idx / 18.;
	vec3 c = mix(uB, mix(uC, uA, sst(.2, .8, tt)), sst(0., .9, tt));
	float on = clamp(lit + peak, 0., 1.);
	vec3 col = c * (.5 + .65 * tt) * on + c * (1. - on) * .07;      // unlit glass keeps a faint ghost
	col += vec3(1.) * lit * step(abs(idx - (nLit - 1.)), .5) * .4;   // the top lit segment is brightest
	col += vec3(1.) * sst(w * .22, 0., abs(dx + w * .4)) * on * .22; // a highlight down the glass
	float halo = exp(-max(abs(dx) - w, 0.) / .012) * step(0., n) * step(n, nLit) * .14;
	return col * cellX * cellY + c * halo;
}

void main() {
	aspect = uRes.x / uRes.y;
	vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1. - gl_FragCoord.y / uRes.y);
	vec2 p = vec2((uv.x - .5) * aspect, uv.y - .5);
	float calm = 1. - .5 * inText(uv);

	// the dark room: deep violet, a little lighter at the top where the lights hang
	vec3 col = mix(vec3(.018, .01, .045), uBase * .75 + vec3(.02, .012, .05), sst(-.5, .5, p.y));
	col += uC * exp(-length(p - vec2(0., -.52)) * 1.7) * .07;
	float haze = (.4 + .9 * fbm(p * 2. + vec2(uTime * .015, -uTime * .01))) * calm;

	col += beams(p, haze);

	// the mirror ball, top right, on a thread; it sways a little
	vec2 bc = vec2(aspect * .5 * .66 + sin(uTime * .33) * .005, -.352);
	col += spots(p, bc, calm);
	col += mix(uB, uC, .5) * exp(-length(p - bc) / .1) * .2 * (1. + .8 * uBeat);
	col += vec3(.8) * sst(.0013, 0., abs(p.x - bc.x)) * step(p.y, bc.y) * .3;
	vec4 b = ball(p, bc, .072);
	col = mix(col, b.rgb, b.a);

	// the equaliser, in the centred layouts only (there the cover sits between the two rows)
	if (uCentered > .5) col += eq(p) * (1. - .35 * inText(uv));

	// a soft pool of colour along the bottom, where the stage is
	col += uA * exp(-abs(p.y - .46) * 9.) * .05 * (1. + uBeat);

	// grade
	float m = max(col.r, max(col.g, col.b));
	col *= 1.25 / (1. + max(m - .7, 0.) * 1.1);
	col += vec3(max(m - 1.5, 0.)) * .12;
	col *= 1. - .55 * pow(length((uv - .5) * vec2(1.05, 1.2)), 2.4);
	col += (h21(gl_FragCoord.xy + fract(uTime) * 91.) - .5) * .012;
	fragColor = vec4(clamp(col, 0., 1.), 1.);
}`;

// ---- scene-gothic.js -------------------------------------------------------
// Gothic: a cathedral at night (the Gothic theme's scene; see scenes.js).
//
// High in the dark a rose window glows: twelve identical sectors of coloured glass cut into mosaic
// cells, held by black lead and stone spokes and rings, lit from behind and never quite steady. Its
// light falls through the haze in long slanted shafts, with dust turning in them, and spills over the
// stone round it. The nave is black at the edges. Candles stand low at both sides, and mist creeps
// along the floor. Beat and bar make the whole window swell; each new line wakes one sector; in a
// break the light sinks.


const GOTHIC_FRAG =
	SCENE_HEAD +
	`
float aspect;
 const vec2 WIN = vec2(0., -.74);   // the middle of the rose window, above the top edge so only its lower part shows
 const float WR = .62;             // and its radius

// the window's glass: crimson, sapphire, amber (all from the theme's colours), emerald and violet
vec3 glassColour(float k) {
	if (k < .30) return uA;
	if (k < .56) return uB;
	if (k < .74) return uC;
	if (k < .88) return vec3(.04, .4, .25);
	return vec3(.34, .1, .5);
}

// cells of a mosaic: x = distance to the nearest border (in cells), y = which cell
vec2 vor(vec2 x) {
	vec2 n = floor(x), f = fract(x);
	vec2 mg = vec2(0.), mr = vec2(0.);
	float md = 8.;
	for (int j = -1; j <= 1; j++) {
		for (int i = -1; i <= 1; i++) {
			vec2 g = vec2(float(i), float(j));
			vec2 r = g + h42(n + g).xy - f;
			float d = dot(r, r);
			if (d < md) { md = d; mr = r; mg = g; }
		}
	}
	float bd = 8.;
	for (int j = -2; j <= 2; j++) {
		for (int i = -2; i <= 2; i++) {
			vec2 g = mg + vec2(float(i), float(j));
			vec2 r = g + h42(n + g).xy - f;
			if (dot(mr - r, mr - r) > 1e-4) bd = min(bd, dot(.5 * (mr + r), normalize(r - mr)));
		}
	}
	return vec2(bd, dot(n + mg, vec2(7.13, 113.7)));
}

// the rose window: rgb = what is seen, a = how much of p is window (0 outside)
vec4 rose(vec2 p, float level) {
	vec2 d = p - WIN;
	float R = length(d) / WR;
	if (R > 1.05) return vec4(0.);
	float th = atan(d.y, d.x);
	float sec = 6.2831853 / 12.;
	float sid = floor(th / sec);
	float phi = abs(mod(th, sec) - sec * .5);              // 0 mid-petal .. sec/2 at the spoke
	// stone: rings at .2 .54 .9 and 1, a spoke between every two sectors
	float dr = min(min(abs(R - .2), abs(R - .54)), min(abs(R - .9), abs(R - 1.)));
	float ds = (sec * .5 - phi) * R;
	float stone = sst(.013, .007, min(dr, ds)) ;
	// glass: a mosaic in each of the three rings, the same in every sector (the window is symmetrical)
	float ring = R < .2 ? 0. : (R < .54 ? 1. : 2.);
	float sc = ring < .5 ? 6. : (ring < 1.5 ? 9. : 8.);
	vec2 v = vor(vec2(R, phi * R) * sc + ring * 17.);
	float lead = sst(.075, .03, v.x);
	float pick = h11(v.y + ring * 3.1 + sid * 2.7);
	float tex = .55 + .6 * fbm(vec2(R, phi * R) * 26.);   // painted, uneven glass
	vec3 glass = glassColour(pick) * tex * level * (.8 + .5 * (1. - R)) * .62;
	vec3 col = mix(glass, vec3(.014, .01, .012), lead);
	col = mix(col, vec3(.04, .034, .036) * (.6 + .6 * fbm(d * 30.)), stone);
	return vec4(col, sst(1.05, 1., R));
}

// the light of the window falling through the haze
vec3 shafts(vec2 p, float haze, float level) {
	vec3 acc = vec3(0.);
	for (int i = 0; i < 5; i++) {
		float fi = float(i);
		vec2 s = WIN + vec2((fi - 2.) * .2, .5);
		float a = -.3 + fi * .13 + .025 * sin(uTime * .17 + fi * 2.);
		vec2 dir = vec2(sin(a), cos(a));
		vec2 v = p - s;
		float along = dot(v, dir);
		float perp = abs(v.x * dir.y - v.y * dir.x);
		float w = .04 + max(along, 0.) * .07;
		float shaft = sst(w, 0., perp) * exp(-max(along, 0.) * 1.15) * sst(0., .1, along);
		vec3 c = fi < .5 ? uA : (fi < 1.5 ? uB : (fi < 2.5 ? uC : (fi < 3.5 ? vec3(.1, .6, .4) : uA)));
		float wake = 1. + 1.4 * uLine * step(abs(uLineId - fi), .5);
		acc += c * shaft * haze * level * wake * .3;
	}
	return acc;
}

// candles: wax, a flame that wavers, and the glow round it
vec3 candles(vec2 p) {
	vec3 acc = vec3(0.);
	for (int i = 0; i < 6; i++) {
		float fi = float(i);
		float side = i < 3 ? -1. : 1.;
		float k = mod(fi, 3.);
		vec2 base = vec2(side * (aspect * .5 - .075 - k * .07), .325 - k * .012);
		float h = .045 + .05 * h11(fi * 3.7 + 1.);
		vec2 d = p - base;
		float wax = sst(.0075, .0055, abs(d.x)) * sst(.002, -.002, d.y) * sst(-h - .002, -h + .002, d.y);
		float fk = vnoise(vec2(uTime * 4.5 + fi * 9.3, fi)) - .5;
		vec2 fp = d - vec2(0., -h - .013);
		fp.x -= fk * .005 * (1. + fp.y * 30.);
		float flame = sst(.011, .003, length(fp * vec2(1.25, .62)));
		float glow = exp(-length(d - vec2(0., -h - .012)) * 13.) * (.8 + .5 * fk);
		acc += wax * vec3(.5, .42, .32) * (.4 + 1.6 * glow) + flame * vec3(1., .8, .45) * 1.7 + vec3(1., .5, .18) * glow * .42;
	}
	return acc;
}

void main() {
	aspect = uRes.x / uRes.y;
	vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1. - gl_FragCoord.y / uRes.y);
	vec2 p = vec2((uv.x - .5) * aspect, uv.y - .5);
	float calm = 1. - .6 * inText(uv);

	// the window is lit from behind and never steady; beat and bar make it swell, a break lets it sink
	float level = (.8 + .12 * vnoise(vec2(uTime * 1.7, 3.)) + .1 * sin(uTime * .31)) * (1. + .14 * uBeat + .28 * uBar) * (1. - .2 * uGap);

	// the stone of the nave: nearly black, warm, with a grain to it
	float grain = fbm(p * 9. + 4.);
	vec3 col = mix(vec3(.012, .008, .01), uBase * .45 + vec3(.014, .01, .012), sst(-.5, .5, p.y));
	col += vec3(.05, .036, .032) * grain * .5;

	// the window and the light it gives the wall round it
	float R = length(p - WIN) / WR;
	vec3 wall = mix(uA, uC, .4) * exp(-max(R - 1., 0.) * 3.2) * .14 * level;
	vec4 w = rose(p, level * mix(1., calm, .5));
	col = mix(col + wall * (.6 + .6 * grain), w.rgb, w.a);

	// shafts of coloured light, with dust turning in them
	float haze = .4 + .9 * fbm(p * 2.2 + vec2(uTime * .012, -uTime * .008));
	vec3 sh = shafts(p, haze, level) * calm;
	col += sh;
	for (int i = 0; i < 2; i++) {
		float fi = float(i);
		vec2 g = p * mix(9., 15., fi) + vec2(uTime * .02, -uTime * (.04 + .02 * fi));
		vec4 r = h42(floor(g) + fi * 17.);
		vec2 f = fract(g) - .5 - (r.yz - .5) * .5;
		float a = sst(.1, .03, length(f)) * step(.7, r.w);
		col += (sh + vec3(.02)) * a * 2.2;
	}

	// the edges of the nave sink into black
	col *= 1. - .9 * sst(aspect * .5 - .16, aspect * .5 - .02, abs(p.x));

	// candles at both sides, mist along the floor
	col += candles(p);
	float mist = fbm(vec2(p.x * 2.2 + uTime * .02, p.y * 7.)) * sst(.12, .46, p.y);
	col += vec3(.1, .09, .11) * mist * .5 * (1. + .0);

	// grade: a shoulder, a vignette, a little noise against banding
	float m = max(col.r, max(col.g, col.b));
	col *= 1.25 / (1. + max(m - .75, 0.) * 1.2);
	col *= 1. - .5 * pow(length((uv - .5) * vec2(1.05, 1.2)), 2.5);
	col += (h21(gl_FragCoord.xy + fract(uTime) * 91.) - .5) * .012;
	fragColor = vec4(clamp(col, 0., 1.), 1.);
}`;

// ---- scenes.js -------------------------------------------------------------
// Theme scenes drawn with WebGL.
//
// A scene is one fragment shader (scene-*.js) that paints the whole background of a theme from a few
// signals: the time, the album's colours, the beat of the song and the bar, a pulse on every new
// line, whether the song is in an instrumental break, and where the lyrics are. One canvas
// (.aur-fx-sc, in the ambience layer) serves every scene; picking a theme compiles its program the
// first time. Where WebGL isn't there the theme falls back to the plain CSS ambience in its
// stylesheet (data-sc="off").
//
// Colours: a scene gets its colours from the album's accent, made the way the stylesheet makes them
// (OKLCH: lightness and chroma set by the theme, hue round the wheel), so the lyrics and the scene
// always agree.


const SCENES = {
	neon: { frag: NEON_FRAG, palette: (accent, deep) => neonPalette(accent, deep) },
	karaoke: { frag: KARAOKE_FRAG, palette: (accent, deep) => ktvPalette(accent, deep) },
	gothic: { frag: GOTHIC_FRAG, palette: (accent, deep) => gothicPalette(accent, deep) },
};

/** Does this theme have a WebGL scene? */
const hasScene = (id) => Object.prototype.hasOwnProperty.call(SCENES, id);

// ---------------------------------------------------------------------------------------------
// Colour (OKLab, so a scene's colours are made the way the stylesheet's oklch(from …) makes them)
// ---------------------------------------------------------------------------------------------

const scLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const scGam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** [r, g, b] 0-255 → [L, C, h°] (OKLCH). Greys have no hue; it is 0, as in CSS. */
function rgbToOklch([r, g, b]) {
	const [lr, lg, lb] = [r, g, b].map((v) => scLin(v / 255));
	const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
	const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
	const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
	const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
	const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
	const C = Math.hypot(a, bb);
	return [L, C, C < 1e-4 ? 0 : ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360];
}

function scOklchToLinear(L, C, h) {
	const a = C * Math.cos((h * Math.PI) / 180);
	const b = C * Math.sin((h * Math.PI) / 180);
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

/** OKLCH → sRGB 0..1; a colour outside the screen's range keeps its lightness and hue and loses chroma. */
function oklchToRgb(L, C, h) {
	const inGamut = (v) => v.every((x) => x >= -0.0005 && x <= 1.0005);
	let lin = scOklchToLinear(L, C, h);
	if (!inGamut(lin)) {
		let lo = 0,
			hi = C;
		for (let i = 0; i < 18; i++) {
			const mid = (lo + hi) / 2;
			if (inGamut(scOklchToLinear(L, mid, h))) lo = mid;
			else hi = mid;
		}
		lin = scOklchToLinear(L, lo, h);
	}
	return lin.map((x) => scGam(Math.min(1, Math.max(0, x))));
}

/** The tint of a scene's dark: the album's deep colour, much darker and quieter. */
function scBase(deep) {
	const base = rgbToOklch(deep || [20, 30, 60]);
	return oklchToRgb(Math.min(base[0], 0.45) * 0.5, Math.min(base[1], 0.12), base[2]);
}

/** The neon colours of a scene from the album's accent and deep colour (both [r, g, b] 0-255 or null). */
function neonPalette(accent, deep) {
	const [, C, h] = rgbToOklch(accent || [255, 255, 255]);
	const hue = C < 0.02 ? 0 : h; // a colourless accent: the same hot pink the stylesheet gets
	return {
		uA: oklchToRgb(0.74, Math.max(C, 0.22), hue),
		uB: oklchToRgb(0.8, Math.max(C, 0.18), hue + 150),
		uC: oklchToRgb(0.76, Math.max(C, 0.2), hue - 40),
		uBase: scBase(deep),
	};
}

/** Karaoke: the accent made hot, with a cool cyan and a violet for company (as the stylesheet's --ktv-a, -b, -c). */
function ktvPalette(accent, deep) {
	const [, C, h] = rgbToOklch(accent || [255, 61, 139]);
	return {
		uA: oklchToRgb(0.72, Math.max(C, 0.2), C < 0.02 ? 0 : h),
		uB: [94 / 255, 225 / 255, 1],
		uC: [180 / 255, 140 / 255, 1],
		uBase: scBase(deep),
	};
}

/** Gothic: the accent as deep crimson glass, with sapphire and amber for the rest of the window. */
function gothicPalette(accent, deep) {
	const [, C, h] = rgbToOklch(accent || [194, 31, 63]);
	return {
		uA: oklchToRgb(0.5, Math.max(C, 0.17), C < 0.02 ? 22 : h),
		uB: oklchToRgb(0.46, 0.15, 262),
		uC: oklchToRgb(0.78, 0.15, 80),
		uBase: scBase(deep),
	};
}

let scSwatch = null;
/** Any CSS colour the browser understands → [r, g, b] 0-255 (a 1x1 canvas does the converting), or null. */
function cssToRgb(str) {
	if (typeof str !== "string" || !str.trim()) return null;
	const parsed = parseCssColor(str);
	if (parsed) return parsed;
	try {
		scSwatch ||= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
		scSwatch.canvas.width = scSwatch.canvas.height = 1;
		scSwatch.fillStyle = "#010203";
		scSwatch.fillStyle = str.trim();
		if (scSwatch.fillStyle === "#010203") return null; // not a colour
		scSwatch.clearRect(0, 0, 1, 1);
		scSwatch.fillRect(0, 0, 1, 1);
		const d = scSwatch.getImageData(0, 0, 1, 1).data;
		return [d[0], d[1], d[2]];
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------------------------

/**
 * createScenes(canvas, root, bg, fx, textRects): draws into `canvas`. Reads the signals that drive a scene
 * from `root` (.aur-root: data-gap, data-lb), `bg` (.aur-bg: data-bt / data-bar flip a/b on each beat and
 * bar) and `fx` (--aur-song); textRects() gives { text, meta }: the boxes of the lyrics and of the song title on the page. Returns
 * { init, use, start, stop, still, ok, running, id }.
 */
function createScenes(canvas, root, bg, fx, textRects) {
	const S = {
		gl: null, progs: new Map(), prog: null, loc: null, id: "", ok: null, running: false, raf: 0, last: 0, t0: 0, still: false,
		scale: 0.5, w: 0, h: 0, sized: false, palAt: -1e9, pal: null, box: null, meta: null, boxAt: -1e9, dts: [], lastNow: 0,
		beat: 0, bar: 0, line: 0, lineId: 0, gap: 0, bt: "", barKey: "", lb: "",
	};
	const FRAME_MS = 1000 / 30;
	const NAMES = ["uRes", "uTime", "uA", "uB", "uC", "uBase", "uBeat", "uBar", "uLine", "uLineId", "uGap", "uSong", "uCentered", "uText", "uMeta"];
	let observer = null;

	function compile(gl, type, src) {
		const sh = gl.createShader(type);
		gl.shaderSource(sh, src);
		gl.compileShader(sh);
		if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || "shader");
		return sh;
	}

	function init() {
		if (S.ok !== null) return S.ok;
		S.ok = false;
		try {
			const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: !!globalThis.AURORA_LYRICS_DEBUG }); // the preview page keeps the picture so it can be read back
			if (!gl) return false;
			const buf = gl.createBuffer();
			gl.bindBuffer(gl.ARRAY_BUFFER, buf);
			gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
			S.gl = gl;
			canvas.addEventListener("webglcontextlost", (e) => {
				e.preventDefault();
				stop();
				S.ok = false;
				root.dataset.sc = "off";
			});
			if (typeof ResizeObserver === "function") {
				observer = new ResizeObserver((es) => {
					const r = es[0]?.contentRect;
					if (!r) return;
					S.w = r.width;
					S.h = r.height;
					S.sized = true;
					S.boxAt = -1e9;
					if (S.still && !S.running && S.ok) requestAnimationFrame(() => draw(performance.now()));
				});
				observer.observe(canvas);
			}
			S.ok = true;
		} catch (err) {
			console.warn("[Aurora Lyrics] scenes: WebGL unavailable, using the plain ambience:", err?.message || err);
			S.ok = false;
		}
		return S.ok;
	}

	/** Pick the scene for a theme (compiling it the first time). False when there is none or it won't compile. */
	function use(id) {
		if (!S.ok || !SCENES[id]) return false;
		if (S.id === id && S.prog) return true;
		const gl = S.gl;
		try {
			let entry = S.progs.get(id);
			if (!entry) {
				const prog = gl.createProgram();
				gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, SCENE_VERT));
				gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, SCENES[id].frag));
				gl.linkProgram(prog);
				if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "link");
				const loc = {};
				for (const n of NAMES) loc[n] = gl.getUniformLocation(prog, n);
				entry = { prog, loc, aPos: gl.getAttribLocation(prog, "aPos") };
				S.progs.set(id, entry);
			}
			gl.useProgram(entry.prog);
			gl.enableVertexAttribArray(entry.aPos);
			gl.vertexAttribPointer(entry.aPos, 2, gl.FLOAT, false, 0, 0);
			S.prog = entry.prog;
			S.loc = entry.loc;
			S.id = id;
			S.palAt = -1e9;
			return true;
		} catch (err) {
			console.warn(`[Aurora Lyrics] scene "${id}" failed to compile:`, err?.message || err);
			S.prog = null;
			S.id = "";
			return false;
		}
	}

	/** The scene's colours follow the album (read from the CSS every second and a half, since reading costs a style recalculation). */
	function palette(now) {
		if (S.pal && now - S.palAt < 1500) return S.pal;
		S.palAt = now;
		let accent = null,
			deep = null;
		try {
			const cs = getComputedStyle(root);
			accent = cssToRgb(cs.getPropertyValue("--aur-accent"));
			deep = cssToRgb(cs.getPropertyValue("--aur-c2"));
		} catch {}
		S.pal = SCENES[S.id].palette(accent, deep);
		return S.pal;
	}

	/** Where the words are (the lyrics, and the song title beside the cover), as fractions of the canvas; checked every second and a half. */
	function textBoxes(now) {
		if (S.box && now - S.boxAt < 1500) return;
		S.boxAt = now;
		S.box = [0.3, 0.1, 1, 0.8];
		S.meta = [-1, -1, -1, -1];
		try {
			const r = textRects?.();
			const c = canvas.getBoundingClientRect();
			const frac = (b) => (b && b.width > 0 && b.height > 0 ? [(b.left - c.left) / c.width, (b.top - c.top) / c.height, (b.right - c.left) / c.width, (b.bottom - c.top) / c.height] : [-1, -1, -1, -1]);
			if (r && c.width && c.height) {
				S.box = frac(r.text);
				S.meta = frac(r.meta);
			}
		} catch {}
	}

	function signals(now) {
		const dt = Math.min(0.25, Math.max(0, (now - S.lastNow) / 1000));
		S.lastNow = now;
		S.beat *= Math.exp(-dt / 0.2);
		S.bar *= Math.exp(-dt / 0.4);
		S.line *= Math.exp(-dt / 0.9);
		if (bg.dataset.bt && bg.dataset.bt !== S.bt) S.beat = 1;
		if (bg.dataset.bar && bg.dataset.bar !== S.barKey) S.bar = 1;
		S.bt = bg.dataset.bt || "";
		S.barKey = bg.dataset.bar || "";
		if (root.dataset.lb && root.dataset.lb !== S.lb && S.lb) {
			S.line = 1;
			S.lineId = Math.floor(Math.random() * 5);
		}
		S.lb = root.dataset.lb || "";
		const gap = root.dataset.gap === "on" ? 1 : 0;
		S.gap += (gap - S.gap) * Math.min(1, dt * 1.2);
	}

	function draw(now) {
		const gl = S.gl;
		if (!gl || !S.prog || !S.sized || !S.w || !S.h) return;
		const w = Math.max(64, Math.round(S.w * S.scale)),
			h = Math.max(36, Math.round(S.h * S.scale));
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
			gl.viewport(0, 0, w, h);
		}
		const pal = palette(now);
		if (S.still) S.beat = S.bar = S.line = S.gap = 0;
		else signals(now);
		const t = S.still ? 41 : ((now - S.t0) / 1000) % 100000;
		const L = S.loc;
		gl.uniform2f(L.uRes, w, h);
		gl.uniform1f(L.uTime, t);
		gl.uniform3fv(L.uA, pal.uA);
		gl.uniform3fv(L.uB, pal.uB);
		gl.uniform3fv(L.uC, pal.uC);
		gl.uniform3fv(L.uBase, pal.uBase);
		gl.uniform1f(L.uBeat, S.beat);
		gl.uniform1f(L.uBar, S.bar);
		gl.uniform1f(L.uLine, S.line);
		gl.uniform1f(L.uLineId, S.lineId);
		gl.uniform1f(L.uGap, S.gap);
		gl.uniform1f(L.uSong, parseFloat(fx?.style.getPropertyValue("--aur-song")) || 0);
		gl.uniform1f(L.uCentered, root.dataset.view === "captions" || root.dataset.view === "stage" ? 1 : 0);
		textBoxes(now);
		gl.uniform4fv(L.uText, S.box);
		gl.uniform4fv(L.uMeta, S.meta);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	}

	function loop(now) {
		S.raf = 0;
		if (!S.running) return;
		S.raf = requestAnimationFrame(loop);
		if (now - S.last < FRAME_MS - 2) return;
		// frames arriving far slower than asked for: the machine is struggling, draw fewer pixels
		S.dts.push(now - S.last);
		S.last = now;
		if (S.dts.length >= 90) {
			const avg = S.dts.reduce((a, b) => a + b, 0) / S.dts.length;
			S.dts.length = 0;
			if (avg > FRAME_MS * 1.7 && S.scale > 0.3) S.scale = Math.max(0.3, S.scale * 0.8);
			else if (avg > FRAME_MS * 2.2 && S.scale <= 0.3) root.dataset.lite = "on"; // still too slow: glass without refraction (glass.css)
		}
		draw(now);
	}

	function start() {
		if (!S.ok || !S.prog || S.running) return;
		S.still = false;
		S.running = true;
		if (!S.t0) S.t0 = performance.now();
		S.lastNow = performance.now();
		S.raf = requestAnimationFrame(loop);
	}

	function stop() {
		S.running = false;
		if (S.raf) cancelAnimationFrame(S.raf);
		S.raf = 0;
	}

	/** One still frame (the animated background is off). */
	function still() {
		if (!S.ok || !S.prog) return;
		stop();
		S.still = true;
		requestAnimationFrame(() => draw(performance.now()));
	}

	return {
		init,
		use,
		start,
		stop,
		still,
		get ok() {
			return S.ok;
		},
		get running() {
			return S.running;
		},
		get id() {
			return S.id;
		},
	};
}

// ---- glass.js --------------------------------------------------------------
// Liquid-glass refraction.
//
// A pane of thick glass bends what is behind it, most at its edge. The browser can do the same to
// the backdrop of an element: `backdrop-filter: url(#filter)` runs an SVG filter over the pixels
// behind it, and feDisplacementMap moves each pixel by an amount read from an image. The image here
// is a map of how far to move (red = across, green = down; grey = not at all): grey in the middle of
// the pane, and a band along each edge where the shift grows towards the edge, pulling the picture
// at the rim towards the middle, like looking through the curved lip of a glass.
//
// The maps are SVG made of gradients stuck to the four sides (the right and bottom ones sit in a
// nested <svg> placed at 100%), so a single filter fits an element of any size and keeps its rim the
// same number of pixels wide while the element grows and shrinks. Two displacement passes (across,
// then down) add up to the 2-D shift.
//
// Sizes: "s" for small chips and buttons, "m" for the player bar, "l" for the lens behind the lyric.
// A shift can't be more than about 0.85 x rim / power or the rim folds over itself and the picture
// repeats; the table keeps clear of that.

const GLASS_SIZES = {
	s: { rim: 16, shift: 6, power: 1.6 },
	m: { rim: 28, shift: 11, power: 1.7 },
	l: { rim: 44, shift: 17, power: 1.8 },
};

/** One axis of a refraction map as an SVG image URL. axis "x": red varies; "y": green varies. */
function glassMapUri(axis, rim, power) {
	const val = (sign, f) => Math.round(128 + sign * f * 127);
	const stops = (sign) =>
		Array.from({ length: 9 }, (_, i) => {
			const t = i / 8;
			const v = val(sign, Math.pow(1 - t, power));
			return `<stop offset='${t}' stop-color='rgb(${axis === "x" ? `${v},128,128` : `128,${v},128`})'/>`;
		}).join("");
	const g = (id, x1, y1, x2, y2, sign) => `<linearGradient id='${id}' x1='${x1}' y1='${y1}' x2='${x2}' y2='${y2}'>${stops(sign)}</linearGradient>`;
	const svg =
		axis === "x"
			? `<svg xmlns='http://www.w3.org/2000/svg' width='100%' height='100%' preserveAspectRatio='none'><defs>${g("a", 0, 0, 1, 0, 1)}${g("b", 1, 0, 0, 0, -1)}</defs>` +
				`<rect width='100%' height='100%' fill='rgb(128,128,128)'/><rect width='${rim}' height='100%' fill='url(#a)'/>` +
				`<svg x='100%' width='1' height='100%' overflow='visible'><rect x='${-rim}' width='${rim}' height='100%' fill='url(#b)'/></svg></svg>`
			: `<svg xmlns='http://www.w3.org/2000/svg' width='100%' height='100%' preserveAspectRatio='none'><defs>${g("a", 0, 0, 0, 1, 1)}${g("b", 0, 1, 0, 0, -1)}</defs>` +
				`<rect width='100%' height='100%' fill='rgb(128,128,128)'/><rect width='100%' height='${rim}' fill='url(#a)'/>` +
				`<svg y='100%' width='100%' height='1' overflow='visible'><rect y='${-rim}' width='100%' height='${rim}' fill='url(#b)'/></svg></svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * The hidden <svg> that holds the refraction filters (#aur-rf-s / -m / -l). Append it to the overlay;
 * styles.css names them in backdrop-filter. Returns the element.
 */
function createGlassDefs() {
	const ns = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(ns, "svg");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("width", "0");
	svg.setAttribute("height", "0");
	svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
	svg.innerHTML =
		"<defs>" +
		Object.entries(GLASS_SIZES)
			.map(
				([id, { rim, shift, power }]) =>
					`<filter id="aur-rf-${id}" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">` +
					`<feImage href="${glassMapUri("x", rim, power)}" result="mx" preserveAspectRatio="none"/>` +
					`<feImage href="${glassMapUri("y", rim, power)}" result="my" preserveAspectRatio="none"/>` +
					`<feDisplacementMap in="SourceGraphic" in2="mx" scale="${shift * 2}" xChannelSelector="R" yChannelSelector="B" result="across"/>` +
					`<feDisplacementMap in="across" in2="my" scale="${shift * 2}" xChannelSelector="B" yChannelSelector="G"/>` +
					`</filter>`,
			)
			.join("") +
		"</defs>";
	return svg;
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
	// Guitar pick (Songsterr tabs)
	pick: () => svg('<path d="M12 21c-2.2-2.6-7-8.3-7-12.4C5 5.4 8.1 3.5 12 3.5s7 1.9 7 5.1C19 12.7 14.2 18.4 12 21z"/>'),
	external: () => svg('<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>', 16),
	share: () => svg('<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M5 12.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5.5"/>'),
	video: () => svg('<rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="M16 10.5l5-3v9l-5-3z"/>', 18),
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
	navStats: () => svg('<path d="M4 20V11"/><path d="M10 20V5"/><path d="M16 20v-7"/><path d="M22 20H2"/>', 21),
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

// New motion styles
Object.assign(STYLE_ART, {
	spring: `<svg viewBox="0 0 60 40" aria-hidden="true"><rect x="6" y="4" width="34" height="4" rx="2" opacity=".25" transform="translate(0 -2)"/><rect x="6" y="15" width="44" height="6" rx="3" transform="translate(0 -1)"/><rect x="6" y="27" width="30" height="4" rx="2" opacity=".35" transform="translate(3 2)"/><rect x="6" y="35" width="24" height="3" rx="1.5" opacity=".15" transform="translate(7 2)"/></svg>`,
	wheel: `<svg viewBox="0 0 60 40" aria-hidden="true"><rect x="12" y="4" width="30" height="2.5" rx="1.25" opacity=".2"/><rect x="8" y="10" width="38" height="4" rx="2" opacity=".4"/><rect x="5" y="17" width="48" height="6" rx="3"/><rect x="8" y="26" width="36" height="4" rx="2" opacity=".4"/><rect x="12" y="33.5" width="28" height="2.5" rx="1.25" opacity=".2"/></svg>`,
	swipe: `<svg viewBox="0 0 60 40" aria-hidden="true"><rect x="-6" y="18" width="14" height="5" rx="2.5" opacity=".2"/><rect x="12" y="17" width="36" height="6" rx="3"/><rect x="52" y="18" width="14" height="5" rx="2.5" opacity=".2"/><path d="M40 31h10m-3-3 3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity=".5"/></svg>`,
	zoom: `<svg viewBox="0 0 60 40" aria-hidden="true"><rect x="2" y="13" width="56" height="14" rx="7" opacity=".12"/><rect x="11" y="17" width="38" height="6" rx="3"/><rect x="22" y="25.5" width="16" height="2.5" rx="1.25" opacity=".3"/></svg>`,
	depth: `<svg viewBox="0 0 60 40" aria-hidden="true"><rect x="16" y="4" width="26" height="3" rx="1.5" opacity=".2"/><rect x="12" y="10" width="34" height="4" rx="2" opacity=".4"/><rect x="5" y="17" width="48" height="7" rx="3.5"/><rect x="10" y="28" width="36" height="4" rx="2" opacity=".4"/><rect x="15" y="35" width="28" height="3" rx="1.5" opacity=".2"/></svg>`,
	flip: `<svg viewBox="0 0 60 40" aria-hidden="true"><path d="M10 9h40l-4 8H14z" opacity=".3"/><rect x="8" y="19" width="44" height="7" rx="3"/><rect x="8" y="22.2" width="44" height=".8" fill="#000" opacity=".35"/></svg>`,
});

// New word animations (three "words", the middle one being sung)
Object.assign(STYLE_ART, {
	focus: `<svg viewBox="0 0 60 40" aria-hidden="true"><defs><filter id="sa-blur"><feGaussianBlur stdDeviation="1.4"/></filter></defs><rect x="4" y="16" width="14" height="8" rx="4"/><rect x="21" y="16" width="18" height="8" rx="4" opacity=".8"/><rect x="42" y="16" width="14" height="8" rx="4" opacity=".4" filter="url(#sa-blur)"/></svg>`,
	bounce: `<svg viewBox="0 0 60 40" aria-hidden="true"><rect x="4" y="19" width="14" height="8" rx="4"/><rect x="21" y="9" width="18" height="8" rx="4"/><path d="M25 22q5 4 10 0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity=".4"/><rect x="42" y="19" width="14" height="8" rx="4" opacity=".3"/></svg>`,
	neon: `<svg viewBox="0 0 60 40" aria-hidden="true"><rect x="17" y="12" width="26" height="16" rx="8" opacity=".14"/><rect x="4" y="16" width="14" height="8" rx="4" opacity=".75"/><rect x="21" y="16" width="18" height="8" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><rect x="42" y="16" width="14" height="8" rx="4" opacity=".3"/></svg>`,
	typewriter: `<svg viewBox="0 0 60 40" aria-hidden="true"><rect x="6" y="16" width="6" height="8" rx="1.5"/><rect x="14" y="16" width="6" height="8" rx="1.5"/><rect x="22" y="16" width="6" height="8" rx="1.5"/><rect x="30" y="14" width="1.6" height="12" rx=".8"/><rect x="34" y="16" width="6" height="8" rx="1.5" opacity=".2"/><rect x="42" y="16" width="6" height="8" rx="1.5" opacity=".2"/></svg>`,
	shimmer: `<svg viewBox="0 0 60 40" aria-hidden="true"><defs><linearGradient id="sa-sh" x1="0" x2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".75"/><stop offset=".62" stop-color="currentColor"/><stop offset=".72" stop-color="currentColor" stop-opacity=".3"/></linearGradient></defs><rect x="4" y="16" width="52" height="8" rx="4" fill="url(#sa-sh)"/><rect x="33" y="11" width="4" height="18" rx="2" opacity=".25"/></svg>`,
});

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
const CSS = ".aur-root {\n--aur-font: var(--encore-title-font-stack, \"SpotifyMixUITitle\", \"SpotifyMixUI\", \"CircularSp\", system-ui, sans-serif);\n--aur-fs: 56px;\n--aur-gap: 0.55em;\n--aur-fw: 800;\n--aur-shade: 0.45;\n--aur-bg-scale: 12;\n--aur-bg-blur: 6px;\n--aur-c1: var(--aur-album-c1, #4b3b78);\n--aur-c2: var(--aur-album-c2, #14203a);\n--aur-accent: var(--aur-album-accent, #ffffff);\n--aur-ah: 1.2em;\n--aur-ui-font: var(--encore-body-font-stack, \"SpotifyMixUI\", \"CircularSp\", \"Segoe UI Variable Text\", system-ui, sans-serif);\n--aur-size: min(var(--aur-fs), 7.4vw, 10.5vh);\n--aur-hi: #fff;\n--aur-dim: color-mix(in srgb, var(--aur-hi) 30%, transparent);\n--aur-glow-tint: color-mix(in oklab, var(--aur-accent) 62%, #fff);\n--aur-glow-k: 1;\n--aur-glow-c: color-mix(in oklab, var(--aur-glow-tint) 45%, transparent);\n--aur-green: #1ed760;\n--aur-origin: 0%;\n--aur-pad: max(7vw, 20px);\n--aur-ease: cubic-bezier(0.22, 1, 0.36, 1);\n--aur-spring: cubic-bezier(0.34, 1.56, 0.64, 1);\n--aur-wave: cubic-bezier(0.3, 1.12, 0.44, 1);\n--aur-stagger: 0ms;\n--aur-move: 0.85s;\n--aur-move-ease: var(--aur-ease);\nposition: fixed;\ninset: 0;\nz-index: 99999;\noverflow: hidden;\noverflow: clip;\nisolation: isolate;\ncolor: #fff;\nbackground: #08080b;\nfont-family: var(--aur-ui-font);\n-webkit-font-smoothing: antialiased;\ntext-rendering: optimizeLegibility;\n-webkit-app-region: no-drag;\noutline: none;\nuser-select: none;\nopacity: 0;\ntransform: scale(1.035);\ntransition:\nopacity 0.42s var(--aur-ease),\ntransform 0.7s var(--aur-ease);\n}\n.aur-root[hidden] { display: none; }\nhtml.aur-covered body > :not(.aur-root) { visibility: hidden !important; }\nhtml.aur-covered body > :not(.aur-root, .aur-float),\nhtml.aur-covered body > :not(.aur-root, .aur-float) *,\nhtml.aur-covered body > :not(.aur-root, .aur-float) *::before,\nhtml.aur-covered body > :not(.aur-root, .aur-float) *::after { animation-play-state: paused !important; }\n.aur-root.is-open { opacity: 1; transform: none; }\n.aur-root *, .aur-root *::before, .aur-root *::after { box-sizing: border-box; }\n.aur-root ::selection { background: rgba(255, 255, 255, 0.28); }\n.aur-root[data-align=\"center\"] { --aur-origin: 50%; }\n.aur-root[data-align=\"right\"] { --aur-origin: 100%; }\n.aur-root[data-glow=\"radiant\"] { --aur-glow-k: 1.7; }\n.aur-root[data-glow=\"off\"] { --aur-glow-k: 0; }\n.aur-root[data-color=\"accent\"] { --aur-hi: color-mix(in srgb, var(--aur-accent) 42%, #fff); }\n.aur-root[data-color=\"gradient\"] {\n--aur-grad-a: color-mix(in oklab, var(--aur-accent) 78%, #fff);\n--aur-grad-b: color-mix(in oklab, var(--aur-c2) 50%, #fff);\n--aur-hi: color-mix(in oklab, var(--aur-grad-a) 50%, var(--aur-grad-b));\n}\n.aur-root[data-color=\"gradient\"] .aur-line:not([data-singer]) .aur-w {\n--aur-hi: color-mix(in oklab, var(--aur-grad-a) calc((1 - var(--wx, 0.5)) * 100%), var(--aur-grad-b));\n--aur-kink: var(--aur-hi);\ncolor: var(--aur-hi);\n}\n.aur-root[data-accent=\"custom\"] {\n--aur-accent: var(--aur-user-accent, #ffffff);\n--aur-c1: color-mix(in oklab, var(--aur-user-accent, #4b3b78) 62%, #000);\n--aur-c2: color-mix(in oklab, var(--aur-user-accent, #14203a) 22%, #07070c);\n}\n.aur-root[data-anim=\"flow\"] { --aur-stagger: 36ms; --aur-move: 1.05s; --aur-move-ease: var(--aur-wave); }\n.aur-root[data-anim=\"scale\"] { --aur-stagger: 14ms; --aur-move: 0.95s; --aur-move-ease: cubic-bezier(0.34, 1.3, 0.64, 1); }\n.aur-bg { position: absolute; inset: 0; z-index: -1; overflow: hidden; background: #0a0a0e; }\n.aur-bg-stack, .aur-bg-layer { position: absolute; inset: 0; }\n.aur-bg-layer { opacity: 0; transition: opacity 1.6s ease; }\n.aur-bg-layer.is-on { opacity: 1; }\n.aur-blob {\nposition: absolute;\nleft: 50%;\ntop: 50%;\nwidth: 256px;\nheight: 256px;\nmax-width: none;\nmargin: -128px 0 0 -128px;\nobject-fit: cover;\nfilter: blur(var(--aur-bg-blur)) saturate(1.7) brightness(0.92);\ntransform: translate(var(--bx, 0), var(--by, 0)) scale(calc(var(--aur-bg-scale) * var(--bs, 1)));\nanimation: aur-spin var(--bt, 120s) steps(3600) infinite;\nwill-change: transform;\n}\n.aur-blob.b3 { --bt: 150s; animation-direction: reverse; }\n.aur-blob.b1 { --bx: -20vw; --by: -14vh; --bs: 0.7; --bt: 70s; opacity: 0.85; border-radius: 42%; animation-delay: -20s; }\n.aur-blob.b2 { --bx: 22vw; --by: 16vh; --bs: 0.62; --bt: 95s; opacity: 0.7; border-radius: 46%; animation-direction: reverse; animation-delay: -45s; }\n.aur-root[data-bganim=\"off\"] .aur-blob,\n.aur-root[data-bganim=\"off\"] .aur-bg-gradient { animation-play-state: paused; }\n@keyframes aur-spin { to { rotate: 360deg; } }\n.aur-bg-gradient {\nposition: absolute;\ninset: -30%;\nopacity: 0;\nbackground:\nradial-gradient(42% 42% at 30% 35%, var(--aur-c1) 0%, transparent 70%),\nradial-gradient(48% 48% at 70% 65%, var(--aur-c2) 0%, transparent 72%),\nradial-gradient(35% 35% at 75% 20%, color-mix(in srgb, var(--aur-accent) 40%, transparent) 0%, transparent 70%),\n#0b0b10;\ntransition: opacity 1s ease;\nanimation: aur-drift 36s steps(1080) infinite alternate;\n}\n.aur-root[data-bg=\"gradient\"] .aur-bg-gradient { opacity: 1; }\n.aur-root:not([data-bg=\"gradient\"]) .aur-bg-gradient { animation: none; }\n.aur-root:not([data-bg=\"album\"]) .aur-bg-stack { display: none; }\n@keyframes aur-drift {\nfrom { transform: translate3d(-3%, -2%, 0) rotate(0deg) scale(1); }\nto { transform: translate3d(3%, 2%, 0) rotate(10deg) scale(1.1); }\n}\n.aur-bg-shade {\nposition: absolute;\ninset: 0;\nbackground:\nlinear-gradient(to top, rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0.18) 16%, transparent 34%),\nradial-gradient(ellipse at 42% 40%, rgba(0, 0, 0, calc(var(--aur-shade) * 0.6)) 0%, rgba(0, 0, 0, var(--aur-shade)) 100%);\n}\n.aur-bg-grain {\nposition: absolute;\ninset: 0;\nopacity: 0.035;\nbackground-size: 180px 180px;\nbackground-image: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\");\npointer-events: none;\n}\n.aur-drag { position: absolute; top: 0; left: 0; right: 0; height: 40px; -webkit-app-region: drag; z-index: 1; }\n.aur-header {\nposition: absolute;\ntop: 30px;\nleft: var(--aur-pad);\nz-index: 2;\ndisplay: flex;\nalign-items: center;\ngap: 14px;\nmax-width: min(560px, 55vw);\npointer-events: none;\ntransition: opacity 0.5s ease, transform 0.6s var(--aur-ease);\n}\n.aur-root[data-info=\"off\"] .aur-header { display: none; }\n.aur-cover { width: 54px; height: 54px; flex: none; border-radius: 8px; object-fit: cover; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45); }\n.aur-meta { min-width: 0; }\n.aur-title, .aur-artist { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.aur-title { font-size: 15.5px; font-weight: 700; letter-spacing: -0.01em; }\n.aur-artist { margin-top: 3px; font-size: 13px; color: rgba(255, 255, 255, 0.62); }\n.aur-stage {\nposition: absolute;\ninset: 0;\npadding: 0 var(--aur-pad);\noverflow: hidden;\n-webkit-mask-image: linear-gradient(to bottom, transparent 0, transparent 72px, #000 calc(72px + 13%), #000 72%, transparent 93%);\nmask-image: linear-gradient(to bottom, transparent 0, transparent 72px, #000 calc(72px + 13%), #000 72%, transparent 93%);\n}\n.aur-lines { position: relative; }\n.aur-root:not([data-transport=\"off\"]) .aur-stage { bottom: 96px; }\n.aur-root[data-align=\"center\"] .aur-stage { text-align: center; }\n.aur-root[data-align=\"right\"] .aur-stage { text-align: right; }\n.aur-stage > .aur-lines,\n.aur-stage > .aur-message { transition: opacity 0.22s ease, filter 0.22s ease; }\n.aur-stage.is-leaving > .aur-lines,\n.aur-stage.is-leaving > .aur-message { opacity: 0; filter: blur(8px); }\n.aur-line {\n--aur-s: 0.95;\n--aur-k: 0;\nfont-family: var(--aur-font);\nfont-size: var(--aur-size);\nfont-weight: var(--aur-fw);\nline-height: 1.16;\nletter-spacing: -0.022em;\npadding: calc(var(--aur-gap) / 2) 0;\nmax-width: 1400px;\ncolor: var(--aur-hi);\nopacity: 0.1;\ntransform-origin: var(--aur-origin) 50%;\noverflow-wrap: anywhere;\ntext-wrap: balance;\nfont-kerning: normal;\ncursor: pointer;\ntransition:\nopacity 0.7s var(--aur-ease),\ntransform var(--aur-move) var(--aur-move-ease) calc(var(--aur-k) * var(--aur-stagger)),\nfilter 0.7s var(--aur-ease),\ncolor 0.5s ease,\ntext-shadow 0.7s ease;\n}\n.aur-root[data-align=\"center\"] .aur-line { margin-inline: auto; }\n.aur-root[data-align=\"right\"] .aur-line { margin-left: auto; }\n.aur-root .aur-line.is-active { --aur-s: 1; opacity: 1; cursor: default; }\n.aur-root:not([data-glow=\"off\"]) .aur-line.is-active:not(.has-words) .aur-main {\ntext-shadow:\n0 0 0.05em color-mix(in srgb, #fff calc(28% * var(--aur-glow-k)), transparent),\n0 0 0.26em color-mix(in oklab, var(--aur-glow-tint) calc(30% * var(--aur-glow-k)), transparent),\n0 0 0.85em color-mix(in oklab, var(--aur-glow-tint) calc(16% * var(--aur-glow-k)), transparent);\n}\n.aur-main { transition: text-shadow 0.8s ease; }\n.aur-main { position: relative; }\n.aur-main::before {\n--a: calc(13% * var(--aur-glow-k));\ncontent: \"\";\nposition: absolute;\nz-index: -1;\nleft: calc(var(--hx, 0px) - 1.1em);\ntop: calc(var(--hy, 0px) - 0.7em);\nwidth: calc(var(--hw, 100%) + 2.2em);\nheight: calc(var(--hh, 100%) + 1.4em);\npointer-events: none;\nbackground: radial-gradient(closest-side, color-mix(in oklab, var(--aur-glow-tint) var(--a), transparent) 0%, color-mix(in oklab, var(--aur-glow-tint) calc(var(--a) * 0.45), transparent) 55%, transparent 100%);\nopacity: 0;\ntransform: scale(0.85);\ntransition: opacity 1.2s ease, transform 1.6s var(--aur-ease);\n}\n.aur-line.is-active .aur-main::before { opacity: 1; transform: none; }\n.aur-stage[data-mode=\"unsynced\"] .aur-main::before { display: none; }\n@property --aur-wp { syntax: \"<number>\"; inherits: true; initial-value: 0; }\n.aur-wg { display: inline-block; white-space: nowrap; }\n.aur-w, .aur-c { display: inline-block; }\n.aur-root[data-words=\"on\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--p: var(--aur-wp);\n--e: calc(var(--p) * var(--p) * (3 - 2 * var(--p)));\n--hop: sin(calc(var(--e) * 3.14159));\n--edge: 0.75em;\ntransform-origin: 50% 90%;\n}\n.aur-root[data-words=\"on\"] .is-active.has-words .aur-w.now:not(.has-chars),\n.aur-root[data-words=\"on\"] .is-active.has-words .aur-w.now .aur-c { will-change: transform; }\n.aur-root[data-words=\"on\"] .is-active.has-words .aur-w .aur-c {\n--wave: 2.6;\n--p: clamp(0, (var(--aur-wp) * (var(--n) + var(--wave)) - var(--i)) / var(--wave), 1);\n--edge: 0.4em;\n}\n.aur-root[data-words=\"on\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\ncolor: color-mix(in srgb, var(--aur-hi) calc(var(--e) * 100%), var(--aur-dim));\ntransform: translateY(calc(0.03em - var(--e) * 0.075em));\n}\n.aur-root:not([data-glow=\"off\"])[data-words=\"on\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--g: calc(var(--e) * var(--aur-glow-k));\nfilter:\ndrop-shadow(0 0 0.04em color-mix(in srgb, #fff calc(32% * var(--g)), transparent))\ndrop-shadow(0 0 0.3em color-mix(in oklab, var(--aur-glow-tint) calc(34% * var(--g)), transparent));\n}\n.aur-root[data-words=\"on\"]:is([data-wordanim=\"fill\"], [data-wordanim=\"rise\"], [data-wordanim=\"karaoke\"], [data-wordanim=\"letters\"]) .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\ncolor: transparent;\nbackground-image: linear-gradient(90deg, var(--aur-ink, var(--aur-hi)) calc(var(--p) * (100% + var(--edge)) - var(--edge)), var(--aur-dim) calc(var(--p) * (100% + var(--edge))));\n-webkit-background-clip: text;\nbackground-clip: text;\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"glow\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--lit: clamp(0, var(--e) * 3, 1);\ncolor: color-mix(in srgb, var(--aur-hi) calc(var(--lit) * 100%), var(--aur-dim));\ntransform: translateY(calc(0.03em - var(--lit) * 0.07em)) scale(calc(1 + 0.04 * var(--hop)));\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"glow\"] .is-active .aur-w.now:not(.has-chars),\n.aur-root[data-words=\"on\"][data-wordanim=\"glow\"] .is-active .aur-w.now .aur-c {\n--gk: max(var(--aur-glow-k), 0.6);\nfilter:\ndrop-shadow(0 0 0.05em color-mix(in srgb, #fff calc((30% + 25% * var(--hop)) * var(--gk)), transparent))\ndrop-shadow(0 0 calc(0.25em + 0.3em * var(--hop)) color-mix(in oklab, var(--aur-glow-tint) calc((32% + 30% * var(--hop)) * var(--gk)), transparent));\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"pop\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--lit: clamp(0, var(--e) * 4, 1);\ncolor: color-mix(in srgb, var(--aur-hi) calc(var(--lit) * 100%), var(--aur-dim));\ntransform: translateY(calc(0.03em - var(--lit) * 0.06em - 0.06em * var(--hop))) scale(calc(1 + 0.12 * var(--hop)));\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"rise\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--up: clamp(0, var(--e) * 2.2, 1);\n--up-e: calc(1 - (1 - var(--up)) * (1 - var(--up)));\nopacity: calc(0.45 + 0.55 * var(--up-e));\ntransform: translateY(calc((1 - var(--up-e)) * 0.2em - 0.04em));\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"karaoke\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--aur-ink: var(--aur-kink, color-mix(in srgb, var(--aur-accent) 70%, #fff));\n--edge: 0.18em;\ntransform: none;\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"letters\"] .is-active.has-words .aur-w .aur-c {\n--wave: 3.2;\ntransform-origin: 50% 85%;\ntransform: translateY(calc(0.03em - var(--e) * 0.06em - 0.16em * var(--hop))) rotate(calc(-4deg * var(--hop))) scale(calc(1 + 0.11 * var(--hop)));\n}\n.aur-root:not([data-glow=\"off\"])[data-words=\"on\"][data-wordanim=\"letters\"] .is-active.has-words .aur-w .aur-c {\nfilter:\ndrop-shadow(0 0 0.04em color-mix(in srgb, #fff calc((24% * var(--e) + 30% * var(--hop)) * var(--aur-glow-k)), transparent))\ndrop-shadow(0 0 calc(0.2em + 0.2em * var(--hop)) color-mix(in oklab, var(--aur-glow-tint) calc((28% * var(--e) + 36% * var(--hop)) * var(--aur-glow-k)), transparent));\n}\n.aur-root[data-words=\"on\"]:not([data-wordanim=\"karaoke\"]):not([data-wordanim=\"letters\"]):not([data-wordanim=\"typewriter\"]) .is-active .aur-w.is-long .aur-c {\ntransform: translateY(calc(0.03em - var(--e) * 0.075em - 0.08em * var(--hop))) scale(calc(1 + 0.05 * var(--hop)));\n}\n.aur-root[data-words=\"on\"] .is-active .aur-w.is-long.now .aur-c {\nfilter:\ndrop-shadow(0 0 0.05em color-mix(in srgb, #fff calc((20% + 30% * var(--hop)) * var(--aur-glow-k)), transparent))\ndrop-shadow(0 0 calc(0.22em + 0.25em * var(--hop)) color-mix(in oklab, var(--aur-glow-tint) calc((30% + 35% * var(--hop)) * var(--aur-glow-k)), transparent));\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"focus\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--lit: clamp(0, var(--e) * 2.2, 1);\ncolor: color-mix(in srgb, var(--aur-hi) calc(var(--lit) * 100%), var(--aur-dim));\ntransform: translateY(calc(0.03em - var(--lit) * 0.05em)) scale(calc(0.965 + 0.035 * var(--lit)));\nfilter: blur(calc((1 - var(--lit)) * 0.045em))\ndrop-shadow(0 0 0.3em color-mix(in oklab, var(--aur-glow-tint) calc(30% * var(--lit) * var(--aur-glow-k)), transparent));\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"focus\"] .aur-stage[data-mode=\"synced\"] .aur-line.has-words:not(.is-active)[data-d=\"1\"] .aur-main { filter: blur(0.045em); }\n.aur-root[data-words=\"on\"][data-wordanim=\"bounce\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--hh: 0.2em;\n--lit: clamp(0, var(--e) * 4, 1);\n--t: clamp(0, var(--p) * 1.8, 1);\n--h1: sin(calc(clamp(0, var(--t) / 0.6, 1) * 3.14159));\n--sq: sin(calc(clamp(0, (var(--t) - 0.52) / 0.2, 1) * 3.14159));\n--h2: sin(calc(clamp(0, (var(--t) - 0.66) / 0.34, 1) * 3.14159));\ncolor: color-mix(in srgb, var(--aur-hi) calc(var(--lit) * 100%), var(--aur-dim));\ntransform-origin: 50% 100%;\ntransform: translateY(calc(0.02em - var(--h1) * var(--hh) - var(--h2) * var(--hh) * 0.25))\nscale(calc(1 - 0.03 * var(--h1) + 0.07 * var(--sq)), calc(1 + 0.07 * var(--h1) - 0.09 * var(--sq)));\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"bounce\"] .is-active.has-words .aur-w.is-long .aur-c { --hh: 0.28em; }\n.aur-root[data-words=\"on\"][data-wordanim=\"neon\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--lit: clamp(0, var(--e) * 5, 1);\n--neon: color-mix(in oklab, var(--aur-accent) 70%, #fff);\n--gk: max(var(--aur-glow-k), 0.7);\ncolor: color-mix(in srgb, var(--neon) calc(var(--lit) * 100%), color-mix(in srgb, var(--aur-hi) 22%, transparent));\n-webkit-text-stroke: 0.014em color-mix(in oklab, var(--neon) calc((1 - var(--lit)) * 50%), transparent);\ntransform: none;\nfilter:\ndrop-shadow(0 0 0.05em color-mix(in srgb, #fff calc(38% * var(--lit) * var(--gk)), transparent))\ndrop-shadow(0 0 0.32em color-mix(in oklab, var(--neon) calc(75% * var(--lit) * var(--gk)), transparent));\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"neon\"] .is-active .aur-w.now { animation: aur-neon-on 0.5s linear; }\n@keyframes aur-neon-on {\n0% { opacity: 0.3; }\n8% { opacity: 1; }\n14% { opacity: 0.45; }\n22% { opacity: 1; }\n30% { opacity: 0.75; }\n38%, 100% { opacity: 1; }\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"typewriter\"] .is-active.has-words .aur-w .aur-c { --wave: 1.1; position: relative; }\n.aur-root[data-words=\"on\"][data-wordanim=\"typewriter\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--lit: clamp(0, var(--p) * 3.5, 1);\ncolor: color-mix(in srgb, var(--aur-hi) calc(var(--lit) * 100%), color-mix(in srgb, var(--aur-hi) 16%, transparent));\ntransform: translateY(calc((1 - var(--lit)) * 0.1em)) scale(calc(0.92 + 0.08 * var(--lit)));\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"typewriter\"] .is-active.has-words .aur-w .aur-c::after {\ncontent: \"\";\nposition: absolute;\ntop: 0.14em;\nbottom: 0.1em;\nright: -0.05em;\nwidth: 0.07em;\nborder-radius: 0.04em;\nbackground: var(--aur-hi);\nopacity: clamp(0, var(--p) * (1 - var(--p)) * 8, 1);\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"shimmer\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--x: calc(var(--p) * (100% + 1.4em));\n--sung: color-mix(in oklab, var(--aur-hi) 76%, var(--aur-accent));\n--rim: color-mix(in oklab, var(--aur-accent) 45%, #fff);\ncolor: transparent;\nbackground-image:\nlinear-gradient(180deg, rgba(255, 255, 255, 0.2), transparent 55%),\nlinear-gradient(90deg, var(--sung) calc(var(--x) - 1.4em), #fff calc(var(--x) - 0.7em), var(--rim) calc(var(--x) - 0.35em), var(--aur-dim) var(--x));\n-webkit-background-clip: text;\nbackground-clip: text;\nfilter:\ndrop-shadow(0 0 0.04em color-mix(in srgb, #fff calc((22% * var(--e) + 30% * var(--hop)) * max(var(--aur-glow-k), 0.5)), transparent))\ndrop-shadow(0 0 0.3em color-mix(in oklab, var(--rim) calc((24% * var(--e) + 34% * var(--hop)) * max(var(--aur-glow-k), 0.5)), transparent));\n}\n.aur-tr {\nmargin-top: 0.22em;\nfont-family: var(--aur-ui-font);\nfont-size: 0.44em;\nfont-weight: 600;\nline-height: 1.3;\nletter-spacing: 0;\ncolor: rgba(255, 255, 255, 0.62);\ntext-wrap: balance;\ntransition: color 0.5s ease;\n}\n.aur-line.is-active .aur-tr { color: rgba(255, 255, 255, 0.9); }\n.aur-stage[data-mode=\"unsynced\"] .aur-tr { font-size: 0.6em; }\n.aur-root[data-view=\"captions\"] .aur-tr { font-size: 0.5em; }\n.aur-tr-btn.is-on { background: rgba(255, 255, 255, 0.08); }\n.aur-root { --aur-duet: oklch(from var(--aur-accent) 0.86 clamp(0.09, c, 0.16) h); }\n.aur-root:is([data-color=\"accent\"], [data-wordanim=\"karaoke\"]) { --aur-duet: oklch(from var(--aur-accent) 0.86 clamp(0.09, c, 0.16) calc(h + 150)); }\n.aur-root[data-duet=\"on\"] .aur-line[data-singer=\"1\"] { --aur-hi: var(--aur-duet); --aur-kink: var(--aur-duet); }\n.aur-root[data-duet=\"on\"] .aur-line[data-singer=\"2\"] { --aur-hi: color-mix(in oklab, var(--aur-duet) 50%, #fff); --aur-kink: color-mix(in oklab, var(--aur-duet) 50%, #fff); }\n.aur-root[data-duet=\"on\"] .aur-line:is([data-singer=\"1\"], [data-singer=\"2\"]) {\n--aur-dim: color-mix(in srgb, var(--aur-hi) 30%, transparent);\n--aur-glow-tint: color-mix(in oklab, var(--aur-hi) 70%, #fff);\n--aur-glow-c: color-mix(in oklab, var(--aur-glow-tint) 45%, transparent);\n}\n.aur-root[data-align=\"left\"] .aur-line.is-opposite { --aur-origin: 100%; text-align: right; margin-left: auto; }\n.aur-root[data-align=\"right\"] .aur-line.is-opposite { --aur-origin: 0%; text-align: left; margin-left: 0; margin-right: auto; }\n.aur-bgv {\nmargin-top: 0.12em;\nfont-size: 0.56em;\nfont-weight: calc(var(--aur-fw) - 100);\nletter-spacing: -0.01em;\nopacity: 0.55;\ntransition: opacity 0.6s ease;\n}\n.aur-line.is-active .aur-bgv { opacity: 0.85; }\n.aur-line.is-gap { cursor: default; }\n.aur-dots { display: inline-flex; align-items: center; gap: 0.32em; height: 1.16em; transform-origin: var(--aur-origin) 50%; }\n.aur-dots i { width: 0.28em; height: 0.28em; border-radius: 50%; background: var(--aur-hi); opacity: 0.3; transform: scale(0.8); transition: opacity 0.4s ease, transform 0.5s var(--aur-spring); }\n.is-active .aur-dots { animation: aur-breathe 3s ease-in-out infinite; }\n.is-active .aur-dots i:nth-child(1) { opacity: calc(0.3 + 0.7 * clamp(0, var(--aur-gp, 0) * 3, 1)); transform: scale(calc(0.8 + 0.35 * clamp(0, var(--aur-gp, 0) * 3, 1))); }\n.is-active .aur-dots i:nth-child(2) { opacity: calc(0.3 + 0.7 * clamp(0, var(--aur-gp, 0) * 3 - 1, 1)); transform: scale(calc(0.8 + 0.35 * clamp(0, var(--aur-gp, 0) * 3 - 1, 1))); }\n.is-active .aur-dots i:nth-child(3) { opacity: calc(0.3 + 0.7 * clamp(0, var(--aur-gp, 0) * 3 - 2, 1)); transform: scale(calc(0.8 + 0.35 * clamp(0, var(--aur-gp, 0) * 3 - 2, 1))); }\n@keyframes aur-breathe {\n0%, 100% { transform: scale(1); }\n50% { transform: scale(1.14); }\n}\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line {\ntransform: translate(0, var(--aur-y, 0px)) scale(var(--aur-s));\ntransition: none;\n}\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line:is([data-d], .is-active) {\ntransform: translate3d(0, var(--aur-y, 0px), 0) scale(var(--aur-s));\ntransition:\nopacity 0.7s var(--aur-ease),\ntransform var(--aur-move) var(--aur-move-ease) calc(var(--aur-k) * var(--aur-stagger)),\nfilter 0.7s var(--aur-ease),\ncolor 0.5s ease,\ntext-shadow 0.7s ease;\n}\n.aur-root[data-anim=\"flow\"] .aur-line { --aur-s: 0.96; }\n.aur-root[data-anim=\"scale\"] .aur-line { --aur-s: 0.8; }\n.aur-root[data-anim=\"scale\"] .aur-line[data-d=\"-1\"],\n.aur-root[data-anim=\"scale\"] .aur-line[data-d=\"1\"] { --aur-s: 0.86; }\n.aur-root .aur-line.is-active { --aur-s: 1; }\n.aur-root[data-anim=\"scale\"] .aur-line.is-active { --aur-s: 1.04; }\n.aur-root[data-layout=\"list\"] .aur-line[data-d=\"-1\"], .aur-root[data-layout=\"list\"] .aur-line[data-d=\"1\"] { opacity: 0.36; }\n.aur-root[data-layout=\"list\"] .aur-line[data-d=\"-2\"], .aur-root[data-layout=\"list\"] .aur-line[data-d=\"2\"] { opacity: 0.24; }\n.aur-root[data-layout=\"list\"] .aur-line[data-d=\"-3\"], .aur-root[data-layout=\"list\"] .aur-line[data-d=\"3\"] { opacity: 0.17; }\n.aur-root[data-layout=\"list\"] .aur-line[data-d=\"-4\"], .aur-root[data-layout=\"list\"] .aur-line[data-d=\"4\"] { opacity: 0.13; }\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-1\"],\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"1\"] { filter: blur(0.8px); }\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-2\"],\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"2\"] { filter: blur(1.5px); }\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-3\"],\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"3\"] { filter: blur(2.2px); }\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-4\"],\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"4\"],\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-5\"],\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"5\"],\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-6\"],\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"6\"] { filter: blur(2.8px); }\n.aur-lines[data-dir=\"up\"] .aur-line[data-d=\"-1\"] { --aur-k: 1; }\n.aur-lines[data-dir=\"up\"] .aur-line[data-d=\"0\"] { --aur-k: 2; }\n.aur-lines[data-dir=\"up\"] .aur-line[data-d=\"1\"] { --aur-k: 3; }\n.aur-lines[data-dir=\"up\"] .aur-line[data-d=\"2\"] { --aur-k: 4; }\n.aur-lines[data-dir=\"up\"] .aur-line[data-d=\"3\"] { --aur-k: 5; }\n.aur-lines[data-dir=\"up\"] .aur-line[data-d=\"4\"] { --aur-k: 6; }\n.aur-lines[data-dir=\"up\"] .aur-line[data-d=\"5\"] { --aur-k: 7; }\n.aur-lines[data-dir=\"up\"] .aur-line[data-d=\"6\"],\n.aur-lines[data-dir=\"up\"] .aur-line.is-active ~ .aur-line:not([data-d]) { --aur-k: 8; }\n.aur-lines[data-dir=\"down\"] .aur-line:not([data-d]) { --aur-k: 8; }\n.aur-lines[data-dir=\"down\"] .aur-line.is-active ~ .aur-line:not([data-d]) { --aur-k: 0; }\n.aur-lines[data-dir=\"down\"] .aur-line[data-d=\"1\"] { --aur-k: 1; }\n.aur-lines[data-dir=\"down\"] .aur-line[data-d=\"0\"] { --aur-k: 2; }\n.aur-lines[data-dir=\"down\"] .aur-line[data-d=\"-1\"] { --aur-k: 3; }\n.aur-lines[data-dir=\"down\"] .aur-line[data-d=\"-2\"] { --aur-k: 4; }\n.aur-lines[data-dir=\"down\"] .aur-line[data-d=\"-3\"] { --aur-k: 5; }\n.aur-lines[data-dir=\"down\"] .aur-line[data-d=\"-4\"] { --aur-k: 6; }\n.aur-lines[data-dir=\"down\"] .aur-line[data-d=\"-5\"] { --aur-k: 7; }\n.aur-lines[data-dir=\"down\"] .aur-line[data-d=\"-6\"] { --aur-k: 8; }\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-gap) { position: relative; }\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-active):not(.is-gap):hover { opacity: 0.82; filter: none; transition-duration: 0.25s, var(--aur-move), 0.25s, 0.3s, 0.3s; }\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-gap)::after {\ncontent: \"\";\nposition: absolute;\nz-index: -1;\ninset: 0 -0.32em;\nborder-radius: 0.28em;\nbackground: linear-gradient(90deg, rgba(255, 255, 255, 0.09), rgba(255, 255, 255, 0.04));\nbox-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06), 0 0.2em 0.6em rgba(0, 0, 0, 0.12);\nopacity: 0;\ntransform: scale(0.97);\ntransition: opacity 0.25s ease, transform 0.4s var(--aur-ease);\npointer-events: none;\n}\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-time]::before {\ncontent: attr(data-time) \"  ▶\";\nposition: absolute;\ntop: 50%;\nright: 0.1em;\npadding: 0.35em 0.75em;\nborder-radius: 99px;\nbackground: rgba(0, 0, 0, 0.28);\nfont-family: var(--aur-ui-font);\nfont-size: max(11px, 0.2em);\nfont-weight: 700;\nletter-spacing: 0.02em;\nwhite-space: pre;\ncolor: rgba(255, 255, 255, 0.85);\nopacity: 0;\ntransform: translate(0.4em, -50%);\ntransition: opacity 0.2s ease, transform 0.35s var(--aur-ease);\npointer-events: none;\n}\n.aur-root[data-align=\"right\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-time]::before { right: auto; left: 0.1em; transform: translate(-0.4em, -50%); }\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-gap):hover::after { opacity: 1; transform: none; }\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-time]:hover::before { opacity: 1; transform: translate(0, -50%); }\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-gap):active::after { transform: scale(0.985); }\n.aur-root[data-view=\"captions\"] .aur-line::before, .aur-root[data-view=\"captions\"] .aur-line::after { display: none; }\n.aur-root[data-layout=\"list\"] .aur-stage.is-browsing .aur-line {\n--aur-k: 0 !important;\nfilter: none !important;\ntransition:\nopacity 0.4s ease,\ntransform 0.45s var(--aur-ease),\nfilter 0.3s ease,\ncolor 0.4s ease,\ntext-shadow 0.4s ease;\n}\n.aur-root[data-layout=\"list\"] .aur-stage.is-browsing .aur-line:not(.is-active) { opacity: 0.42; }\n.aur-root[data-layout=\"list\"] .aur-stage.is-browsing .aur-line:not(.is-active):not(.is-gap):hover { opacity: 0.9; }\n.aur-root[data-layout=\"list\"] .aur-stage.is-entering[data-mode=\"synced\"] .aur-line {\nanimation: aur-line-in 1s var(--aur-ease) backwards;\nanimation-delay: calc(var(--i, 0) * 55ms);\n}\n@keyframes aur-line-in {\nfrom { opacity: 0; transform: translate3d(0, calc(var(--aur-y, 0px) + 64px), 0) scale(var(--aur-s)); filter: blur(12px); }\n}\n.aur-root[data-layout=\"stack\"] .aur-stage[data-mode=\"synced\"] .aur-lines { position: absolute; top: 0; bottom: 0; left: var(--aur-pad); right: var(--aur-pad); }\n.aur-root[data-layout=\"stack\"] .aur-stage[data-mode=\"synced\"] .aur-line {\nposition: absolute;\nleft: 0;\nright: 0;\ntop: 44%;\nopacity: 0;\npointer-events: none;\ntransform: translateY(-50%) scale(0.5);\n}\n.aur-root[data-layout=\"stack\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active { opacity: 1; pointer-events: auto; transform: translateY(-50%); }\n.aur-root[data-layout=\"stack\"] .aur-stage.is-entering[data-mode=\"synced\"] .aur-lines { animation: aur-fade-up 0.9s var(--aur-ease) backwards; }\n.aur-root[data-anim=\"fade\"] .aur-line { transition-duration: 0.55s, 0.8s, 0.6s, 0.5s, 0.6s; }\n.aur-root[data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-1\"] { opacity: 0.3; pointer-events: auto; transform: translateY(calc(var(--aur-ah) / -2 - 0.3em - 81%)) scale(0.62); }\n.aur-root[data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"1\"] { opacity: 0.3; pointer-events: auto; transform: translateY(calc(var(--aur-ah) / 2 + 0.3em - 19%)) scale(0.62); }\n.aur-root[data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-2\"] { transform: translateY(calc(var(--aur-ah) / -2 - 1.6em - 75%)) scale(0.5); }\n.aur-root[data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"2\"] { transform: translateY(calc(var(--aur-ah) / 2 + 1.6em - 25%)) scale(0.5); }\n.aur-root[data-depth=\"on\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-1\"],\n.aur-root[data-depth=\"on\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"1\"] { filter: blur(1px); }\n.aur-root[data-anim=\"cinematic\"] .aur-line { letter-spacing: -0.015em; transition-duration: 0.9s, 1.1s, 0.9s, 0.5s, 0.9s; }\n.aur-root[data-anim=\"cinematic\"] .aur-stage[data-mode=\"synced\"] .aur-line { transform: translateY(calc(-50% + 0.45em)) scale(0.97); }\n.aur-root[data-anim=\"cinematic\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d] { filter: blur(16px); }\n.aur-root[data-anim=\"cinematic\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d^=\"-\"] { transform: translateY(calc(-50% - 0.45em)) scale(1.03); }\n.aur-root[data-anim=\"cinematic\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active { filter: none; transform: translateY(-50%) scale(1.05); transition-delay: 0s, 0.14s, 0.14s, 0s, 0s; }\n.aur-root[data-anim=\"spring\"] { --aur-stagger: 42ms; --aur-move: 1.15s; --aur-move-ease: cubic-bezier(0.3, 1.55, 0.5, 1); }\n.aur-root[data-anim=\"spring\"] .aur-line { --aur-s: 0.95; }\n.aur-root[data-anim=\"spring\"] .aur-line.is-active { --aur-s: 1.02; }\n.aur-root[data-anim=\"spring\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active .aur-main {\ntransform-origin: var(--aur-origin) 60%;\nanimation: aur-spring-settle 0.75s cubic-bezier(0.3, 1.6, 0.5, 1);\n}\n@keyframes aur-spring-settle { from { transform: translateY(0.08em) scale(0.97); } }\n.aur-root[data-anim=\"wheel\"] { --aur-stagger: 0ms; --aur-move: 1s; --aur-move-ease: cubic-bezier(0.22, 1.08, 0.36, 1); }\n.aur-root[data-anim=\"wheel\"] .aur-stage[data-mode=\"synced\"] .aur-lines { perspective: 1100px; perspective-origin: 50% var(--aur-anchor-y, 40%); }\n.aur-root[data-anim=\"wheel\"] .aur-stage[data-mode=\"synced\"] .aur-line {\ntransform: translate3d(0, calc(var(--aur-y, 0px) - var(--dd, 0) * var(--ad, 0) * 0.09em), calc(var(--ad, 0) * -0.35em)) rotateX(calc(var(--dd, 0) * -19deg));\ntransform-origin: 50% 50%;\nbackface-visibility: hidden;\n}\n.aur-root[data-anim=\"wheel\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d] { opacity: calc(0.6 - var(--ad, 0) * 0.11); }\n.aur-root[data-anim=\"wheel\"] .aur-stage[data-mode=\"synced\"] .aur-line:not([data-d]) { opacity: 0; }\n.aur-root[data-anim=\"wheel\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active { opacity: 1; }\n.aur-line[data-d=\"-6\"] { --dd: -6; --ad: 6; }\n.aur-line[data-d=\"-5\"] { --dd: -5; --ad: 5; }\n.aur-line[data-d=\"-4\"] { --dd: -4; --ad: 4; }\n.aur-line[data-d=\"-3\"] { --dd: -3; --ad: 3; }\n.aur-line[data-d=\"-2\"] { --dd: -2; --ad: 2; }\n.aur-line[data-d=\"-1\"] { --dd: -1; --ad: 1; }\n.aur-line[data-d=\"1\"] { --dd: 1; --ad: 1; }\n.aur-line[data-d=\"2\"] { --dd: 2; --ad: 2; }\n.aur-line[data-d=\"3\"] { --dd: 3; --ad: 3; }\n.aur-line[data-d=\"4\"] { --dd: 4; --ad: 4; }\n.aur-line[data-d=\"5\"] { --dd: 5; --ad: 5; }\n.aur-line[data-d=\"6\"] { --dd: 6; --ad: 6; }\n.aur-root[data-anim=\"swipe\"] .aur-stage[data-mode=\"synced\"] .aur-line {\ntransform: translate(1.8em, -50%) skewX(-8deg) scale(0.97);\nfilter: blur(4px);\ntransition-duration: 0.5s, 0.8s, 0.6s, 0.5s, 0.6s;\ntransition-timing-function: ease, cubic-bezier(0.22, 1, 0.36, 1), ease, ease, ease;\n}\n.aur-root[data-anim=\"swipe\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d^=\"-\"] {\ntransform: translate(-1.8em, -50%) skewX(8deg) scale(0.97);\nfilter: blur(6px);\ntransition-duration: 0.32s, 0.5s, 0.4s, 0.3s, 0.3s;\ntransition-timing-function: ease-in, cubic-bezier(0.55, 0, 0.8, 0.4), ease-in, ease, ease;\ntransition-delay: 0s;\n}\n.aur-root[data-anim=\"swipe\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active {\ntransform: translate(0, -50%) skewX(0deg) scale(1);\nfilter: none;\ntransition-duration: 0.5s, 0.95s, 0.55s, 0.5s, 0.6s;\ntransition-timing-function: ease-out, cubic-bezier(0.18, 1.25, 0.4, 1), ease-out, ease, ease;\ntransition-delay: 0.08s, 0.08s, 0.08s, 0s, 0s;\n}\n.aur-root[data-anim=\"zoom\"] .aur-stage[data-mode=\"synced\"] .aur-line {\ntransform: translateY(-50%) scale(0.72);\nfilter: blur(8px);\ntransition-duration: 0.5s, 0.9s, 0.7s, 0.5s, 0.6s;\n}\n.aur-root[data-anim=\"zoom\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d^=\"-\"] {\ntransform: translateY(-50%) scale(1.32);\nfilter: blur(12px);\ntransition-duration: 0.35s, 0.6s, 0.45s, 0.3s, 0.3s;\ntransition-timing-function: ease-in, cubic-bezier(0.4, 0, 1, 1), ease-in, ease, ease;\ntransition-delay: 0s;\n}\n.aur-root[data-anim=\"zoom\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active {\ntransform: translateY(-50%) scale(1);\nfilter: none;\ntransition-duration: 0.6s, 1s, 0.8s, 0.5s, 0.6s;\ntransition-timing-function: ease, cubic-bezier(0.16, 1, 0.3, 1), ease-out, ease, ease;\ntransition-delay: 0.1s, 0.1s, 0.1s, 0s, 0s;\n}\n.aur-root[data-anim=\"flip\"] .aur-stage[data-mode=\"synced\"] .aur-line {\ntransform-origin: 50% 0%;\ntransform: translateY(-50%) perspective(700px) rotateX(-95deg);\nfilter: brightness(0.3);\nbackface-visibility: hidden;\ntransition-duration: 0.4s, 0.8s, 0.5s, 0.5s, 0.5s;\n}\n.aur-root[data-anim=\"flip\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d^=\"-\"] {\ntransform: translateY(-58%) perspective(700px) rotateX(75deg);\nfilter: brightness(0.45);\ntransition-duration: 0.28s, 0.5s, 0.4s, 0.3s, 0.3s;\ntransition-timing-function: ease-in, cubic-bezier(0.5, 0, 0.9, 0.5), ease-in, ease, ease;\ntransition-delay: 0s;\n}\n.aur-root[data-anim=\"flip\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active {\ntransform: translateY(-50%) perspective(700px) rotateX(0deg);\nfilter: brightness(1);\ntransition-duration: 0.22s, 0.9s, 0.65s, 0.5s, 0.5s;\ntransition-timing-function: ease-out, cubic-bezier(0.2, 1.45, 0.35, 1), ease-out, ease, ease;\ntransition-delay: 0.1s, 0.1s, 0.1s, 0s, 0s;\n}\n.aur-root[data-anim=\"depth\"] { --aur-stagger: 22ms; --aur-move: 1.15s; --aur-move-ease: cubic-bezier(0.22, 1, 0.36, 1); }\n.aur-root[data-anim=\"depth\"] .aur-stage[data-mode=\"synced\"] { perspective: 1300px; perspective-origin: 50% 40%; }\n.aur-root[data-anim=\"depth\"] .aur-stage[data-mode=\"synced\"] .aur-lines {\ntransform-style: preserve-3d;\ntransform: rotateX(var(--aur-tx, 0deg)) rotateY(var(--aur-ty, 0deg));\ntransition: transform 1.4s cubic-bezier(0.22, 1, 0.36, 1);\nanimation: aur-depth-drift 26s ease-in-out infinite alternate;\n}\n@keyframes aur-depth-drift {\nfrom { translate: -1.2% 0.6% 0; rotate: y -1.5deg; }\nto { translate: 1.2% -0.6% 0; rotate: y 1.5deg; }\n}\n.aur-root[data-anim=\"depth\"] .aur-stage[data-mode=\"synced\"] .aur-line {\ntransform: translate3d(0, var(--aur-y, 0px), calc(var(--ad, 0) * -140px));\n}\n.aur-root[data-anim=\"depth\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d] { opacity: calc(0.62 - var(--ad, 0) * 0.1); }\n.aur-root[data-anim=\"depth\"] .aur-stage[data-mode=\"synced\"] .aur-line:not([data-d]) { opacity: 0; }\n.aur-root[data-anim=\"depth\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active { opacity: 1; transform: translate3d(0, var(--aur-y, 0px), 40px); }\n.aur-root[data-context=\"off\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-active) { opacity: 0 !important; pointer-events: none; }\n.aur-stage[data-mode=\"unsynced\"] { overflow-y: auto; scrollbar-width: none; }\n.aur-stage[data-mode=\"unsynced\"]::-webkit-scrollbar { display: none; }\n.aur-stage[data-mode=\"unsynced\"] .aur-lines { padding: 24vh 0 42vh; }\n.aur-stage[data-mode=\"unsynced\"] .aur-line {\nfont-size: calc(var(--aur-size) * 0.66);\nline-height: 1.28;\npadding: calc(var(--aur-gap) / 3.5) 0;\nopacity: 0.9;\ntransform: none;\ncursor: text;\nuser-select: text;\n}\n.aur-stage[data-mode=\"unsynced\"] .aur-line.is-gap { height: 0.9em; }\n.aur-stage[data-mode=\"unsynced\"] .aur-dots { display: none; }\n.aur-stage.is-entering[data-mode=\"unsynced\"] .aur-lines { animation: aur-fade-up 0.9s var(--aur-ease) backwards; }\n@keyframes aur-fade-up {\nfrom { opacity: 0; transform: translateY(28px); filter: blur(8px); }\n}\n.aur-message {\nposition: absolute;\ninset: 0;\ndisplay: none;\nflex-direction: column;\nalign-items: center;\njustify-content: center;\ngap: 8px;\npadding: 60px 8vw 150px;\ntext-align: center;\n}\n.aur-stage[data-mode=\"message\"] .aur-message { display: flex; }\n.aur-message-art {\nwidth: clamp(120px, 30vh, 280px);\naspect-ratio: 1;\nmargin-bottom: 22px;\nborder-radius: 14px;\noverflow: hidden;\nbox-shadow: 0 30px 80px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.06);\n}\n.aur-message-art img { display: block; width: 100%; height: 100%; object-fit: cover; }\n.aur-message[data-kind=\"loading\"] .aur-message-art { animation: aur-pulse 2.4s ease-in-out infinite; }\n.aur-message-icon { color: rgba(255, 255, 255, 0.55); margin-bottom: 6px; }\n.aur-message-icon:empty { display: none; }\n.aur-message-title { font-family: var(--aur-font); font-size: clamp(22px, calc(var(--aur-size) * 0.6), 40px); font-weight: 800; letter-spacing: -0.02em; line-height: 1.15; }\n.aur-message-detail { min-height: 1.5em; max-width: 520px; font-size: 15px; line-height: 1.5; color: rgba(255, 255, 255, 0.6); }\n.aur-message[data-kind=\"error\"] .aur-message-title { color: #ffb4a8; }\n.aur-message-action { margin-top: 14px; }\n.aur-spinner { display: flex; gap: 7px; margin-bottom: 6px; }\n.aur-spinner i { width: 7px; height: 7px; border-radius: 50%; background: #fff; animation: aur-bounce 1.2s var(--aur-ease) infinite; }\n.aur-spinner i:nth-child(2) { animation-delay: 0.15s; }\n.aur-spinner i:nth-child(3) { animation-delay: 0.3s; }\n.aur-stage.is-entering[data-mode=\"message\"] .aur-message > * { animation: aur-fade-up 0.8s var(--aur-ease) backwards; }\n.aur-stage.is-entering[data-mode=\"message\"] .aur-message > :nth-child(2) { animation-delay: 0.06s; }\n.aur-stage.is-entering[data-mode=\"message\"] .aur-message > :nth-child(3) { animation-delay: 0.12s; }\n.aur-stage.is-entering[data-mode=\"message\"] .aur-message > :nth-child(4) { animation-delay: 0.18s; }\n.aur-stage.is-entering[data-mode=\"message\"] .aur-message > :nth-child(5) { animation-delay: 0.24s; }\n.aur-stage.is-entering[data-mode=\"message\"] .aur-message > .aur-message-art { animation: aur-art-in 1s var(--aur-ease) backwards; }\n@keyframes aur-bounce {\n0%, 100% { transform: translateY(0); opacity: 0.35; }\n40% { transform: translateY(-7px); opacity: 1; }\n}\n@keyframes aur-pulse {\n0%, 100% { transform: scale(1); }\n50% { transform: scale(0.975); }\n}\n@keyframes aur-art-in {\nfrom { opacity: 0; transform: translateY(20px) scale(0.92); filter: blur(10px); }\n}\n:where(.aur-root) button { appearance: none; margin: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; -webkit-app-region: no-drag; }\n.aur-root button:focus-visible,\n.aur-root select:focus-visible,\n.aur-root input:focus-visible,\n.aur-root textarea:focus-visible,\n.aur-progress:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }\n.aur-icon-btn {\ndisplay: inline-grid;\nplace-items: center;\nflex: none;\nwidth: 36px;\nheight: 36px;\nborder-radius: 50%;\ncolor: rgba(255, 255, 255, 0.72);\ntransition: background 0.2s ease, color 0.2s ease, transform 0.25s var(--aur-spring);\n}\n.aur-icon-btn:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }\n.aur-icon-btn:active { transform: scale(0.9); }\n.aur-icon-btn.is-on { color: var(--aur-green); }\n.aur-btn {\ndisplay: inline-flex;\nalign-items: center;\njustify-content: center;\ngap: 8px;\nheight: 36px;\npadding: 0 16px;\nborder-radius: 999px;\nbackground: rgba(255, 255, 255, 0.1);\nfont-size: 13px;\nfont-weight: 700;\ntransition: background 0.2s ease, transform 0.2s var(--aur-spring), box-shadow 0.2s ease;\n}\n.aur-btn svg { width: 16px; height: 16px; }\n.aur-btn:hover { background: rgba(255, 255, 255, 0.17); }\n.aur-btn:active { transform: scale(0.96); }\n.aur-btn:disabled { opacity: 0.4; pointer-events: none; }\n.aur-btn-ghost { background: transparent; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18); }\n.aur-btn-ghost:hover { background: rgba(255, 255, 255, 0.07); }\n.aur-btn-primary { background: #fff; color: #000; }\n.aur-btn-primary:hover { background: #fff; transform: scale(1.03); box-shadow: 0 6px 20px rgba(255, 255, 255, 0.15); }\n.aur-btn-danger { background: transparent; color: #ff8a7a; box-shadow: inset 0 0 0 1px rgba(255, 138, 122, 0.35); }\n.aur-root {\n--aur-toggle-on: color-mix(in oklab, var(--aur-accent) 50%, #fff);\n--aur-ctl: rgba(255, 255, 255, 0.72);\n}\n.aur-player {\nposition: absolute;\nleft: 0;\nright: 0;\nbottom: 0;\nz-index: 3;\ndisplay: grid;\ngrid-template-columns: minmax(0, 1fr) minmax(300px, 640px) minmax(0, 1fr);\nalign-items: end;\ncolumn-gap: 28px;\npadding: 0 var(--aur-pad) 20px;\npointer-events: none;\ntransition: opacity 0.5s ease, transform 0.65s var(--aur-ease);\n}\n.aur-player > * { pointer-events: auto; }\n.aur-player-side { display: flex; align-items: center; gap: 4px; height: 58px; min-width: 0; }\n.aur-player-side.is-left { grid-column: 1; justify-content: flex-start; }\n.aur-player-center { grid-column: 2; display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 0; }\n.aur-player-side.is-right { grid-column: 3; justify-content: flex-end; }\n.aur-root[data-transport=\"off\"] .aur-player-center { display: none; }\n.aur-scrub { width: 100%; }\n.aur-progress { --p: 0; --hx: 0; position: relative; height: 18px; cursor: pointer; touch-action: none; border-radius: 4px; }\n.aur-progress-track {\nposition: absolute;\nleft: 0;\nright: 0;\ntop: 50%;\nheight: 4px;\nmargin-top: -2px;\noverflow: hidden;\nborder-radius: 99px;\nbackground: rgba(255, 255, 255, 0.16);\ntransition: height 0.25s var(--aur-ease), margin 0.25s var(--aur-ease), background 0.25s ease;\n}\n.aur-progress-fill {\nposition: absolute;\ninset: 0;\nborder-radius: inherit;\nbackground: linear-gradient(90deg, rgba(255, 255, 255, 0.75), #fff);\ntransform-origin: 0 50%;\ntransform: scaleX(var(--p));\n}\n.aur-progress-knob-rail { position: absolute; inset: 0; transform: translateX(calc(var(--p) * 100%)); pointer-events: none; }\n.aur-progress-knob {\nposition: absolute;\nleft: -7px;\ntop: 50%;\nwidth: 14px;\nheight: 14px;\nmargin-top: -7px;\nborder-radius: 50%;\nbackground: #fff;\nbox-shadow: 0 2px 10px rgba(0, 0, 0, 0.35), 0 0 0 4px color-mix(in oklab, var(--aur-glow-tint) 25%, transparent);\ntransform: scale(0);\ntransition: transform 0.3s var(--aur-spring);\n}\n.aur-progress:hover .aur-progress-track,\n.aur-progress.is-scrubbing .aur-progress-track { height: 7px; margin-top: -3.5px; background: rgba(255, 255, 255, 0.22); }\n.aur-progress:hover .aur-progress-knob,\n.aur-progress.is-scrubbing .aur-progress-knob,\n.aur-progress:focus-visible .aur-progress-knob { transform: scale(1); }\n.aur-progress.is-scrubbing .aur-progress-knob { transform: scale(1.15); }\n.aur-progress-tip {\nposition: absolute;\nbottom: 20px;\nleft: calc(var(--hx) * 100%);\npadding: 3px 8px;\nborder-radius: 7px;\nbackground: rgba(18, 18, 22, 0.88);\nborder: 1px solid rgba(255, 255, 255, 0.08);\nfont-size: 11.5px;\nfont-weight: 600;\nfont-variant-numeric: tabular-nums;\nwhite-space: nowrap;\npointer-events: none;\nopacity: 0;\ntransform: translate(-50%, 4px);\ntransition: opacity 0.18s ease, transform 0.25s var(--aur-ease);\n}\n.aur-progress:hover .aur-progress-tip,\n.aur-progress.is-scrubbing .aur-progress-tip { opacity: 1; transform: translate(-50%, 0); }\n.aur-times { display: flex; justify-content: space-between; margin-top: 1px; }\n.aur-time { font-size: 11.5px; font-weight: 500; font-variant-numeric: tabular-nums; color: rgba(255, 255, 255, 0.55); }\n.aur-transport { display: flex; align-items: center; gap: 20px; }\n.aur-skip { width: 42px; height: 42px; color: rgba(255, 255, 255, 0.92); }\n.aur-skip svg { width: 22px; height: 22px; }\n.aur-toggle { position: relative; color: rgba(255, 255, 255, 0.5); }\n.aur-toggle.is-on { color: var(--aur-toggle-on); }\n.aur-toggle::after {\ncontent: \"\";\nposition: absolute;\nleft: 50%;\nbottom: 3px;\nwidth: 4px;\nheight: 4px;\nmargin-left: -2px;\nborder-radius: 50%;\nbackground: currentColor;\nopacity: 0;\ntransform: scale(0);\ntransition: opacity 0.2s ease, transform 0.3s var(--aur-spring);\n}\n.aur-toggle.is-on::after { opacity: 1; transform: none; }\n.aur-play-btn {\nposition: relative;\ndisplay: grid;\nplace-items: center;\nwidth: 58px;\nheight: 58px;\nflex: none;\nborder-radius: 50%;\nbackground: #fff;\ncolor: #0b0b0e;\nbox-shadow: 0 10px 30px rgba(0, 0, 0, 0.3), 0 0 0 0 color-mix(in oklab, var(--aur-glow-tint) 30%, transparent);\ntransition: transform 0.35s var(--aur-spring), box-shadow 0.4s ease;\n}\n.aur-play-btn:hover { transform: scale(1.06); box-shadow: 0 12px 34px rgba(0, 0, 0, 0.32), 0 0 0 8px color-mix(in oklab, var(--aur-glow-tint) 16%, transparent); }\n.aur-play-btn:active { transform: scale(0.93); }\n.aur-pp { position: absolute; inset: 0; display: grid; place-items: center; transition: opacity 0.22s ease, transform 0.4s var(--aur-spring); }\n.aur-pp svg { width: 26px; height: 26px; }\n.aur-pp.is-pause { opacity: 0; transform: scale(0.5) rotate(-90deg); }\n.aur-root[data-playing=\"true\"] .aur-pp.is-play { opacity: 0; transform: scale(0.5) rotate(90deg); }\n.aur-root[data-playing=\"true\"] .aur-pp.is-pause { opacity: 1; transform: none; }\n.aur-source {\ndisplay: inline-flex;\nalign-items: center;\ngap: 8px;\nmin-width: 0;\nmax-width: 230px;\nheight: 32px;\npadding: 0 12px 0 10px;\nborder-radius: 99px;\nbackground: rgba(255, 255, 255, 0.07);\nfont-size: 12px;\nfont-weight: 600;\nwhite-space: nowrap;\noverflow: hidden;\ntext-overflow: ellipsis;\ncolor: rgba(255, 255, 255, 0.78);\ntransition: background 0.2s ease, color 0.2s ease;\n}\n.aur-source:hover { background: rgba(255, 255, 255, 0.13); color: #fff; }\n.aur-source::before { content: \"\"; flex: none; width: 7px; height: 7px; border-radius: 50%; background: #777; }\n.aur-source[data-kind=\"synced\"]::before { background: var(--aur-green); }\n.aur-source[data-kind=\"word-synced\"]::before { background: #7cd4ff; box-shadow: 0 0 8px #7cd4ff; }\n.aur-source[data-kind=\"unsynced\"]::before { background: #f5c451; }\n.aur-offset-group { display: inline-flex; align-items: center; flex: none; height: 32px; margin-left: 6px; border-radius: 99px; background: rgba(255, 255, 255, 0.05); }\n.aur-mini-btn { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; color: rgba(255, 255, 255, 0.6); transition: background 0.2s ease, color 0.2s ease; }\n.aur-mini-btn:hover { background: rgba(255, 255, 255, 0.12); color: #fff; }\n.aur-offset { min-width: 54px; height: 30px; font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; text-align: center; color: #fff; }\n.aur-offset.is-zero { color: rgba(255, 255, 255, 0.45); }\n.aur-player-side .aur-icon-btn { color: var(--aur-ctl); }\n.aur-heart { transition: color 0.2s ease, transform 0.35s var(--aur-spring); }\n.aur-heart.is-on { color: var(--aur-green); }\n.aur-heart.is-on svg { animation: aur-heart-pop 0.45s var(--aur-spring); }\n@keyframes aur-heart-pop { 40% { transform: scale(1.3); } }\n.aur-volume { display: flex; align-items: center; }\n.aur-vol {\n--v: 1;\n-webkit-appearance: none;\nappearance: none;\nwidth: 0;\nheight: 18px;\nmargin: 0;\nbackground: transparent;\nopacity: 0;\ncursor: pointer;\ntransition: width 0.35s var(--aur-ease), opacity 0.25s ease, margin 0.35s var(--aur-ease);\n}\n.aur-volume:hover .aur-vol,\n.aur-vol:focus-visible { width: 86px; margin: 0 6px 0 2px; opacity: 1; }\n.aur-vol::-webkit-slider-runnable-track { height: 4px; border-radius: 99px; background: linear-gradient(to right, #fff calc(var(--v) * 100%), rgba(255, 255, 255, 0.18) calc(var(--v) * 100%)); }\n.aur-vol::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; margin-top: -4px; border-radius: 50%; background: #fff; box-shadow: 0 1px 6px rgba(0, 0, 0, 0.4); }\n.aur-vol::-moz-range-track { height: 4px; border-radius: 99px; background: rgba(255, 255, 255, 0.18); }\n.aur-vol::-moz-range-progress { height: 4px; border-radius: 99px; background: #fff; }\n.aur-vol::-moz-range-thumb { width: 12px; height: 12px; border: 0; border-radius: 50%; background: #fff; }\n.aur-player-side .aur-sep { flex: none; width: 1px; height: 20px; margin: 0 6px; background: rgba(255, 255, 255, 0.14); }\n.aur-mini-progress { position: absolute; left: 0; right: 0; bottom: 0; z-index: 3; height: 2px; background: rgba(255, 255, 255, 0.07); opacity: 0; transition: opacity 0.8s ease; pointer-events: none; }\n.aur-mini-fill { height: 100%; background: linear-gradient(90deg, rgba(255, 255, 255, 0.35), rgba(255, 255, 255, 0.75)); transform-origin: 0 50%; transform: scaleX(var(--p, 0)); }\n.aur-root[data-idle=\"true\"] .aur-mini-progress { opacity: 1; transition-delay: 0.3s; }\n.aur-root[data-idle=\"true\"] { cursor: none; }\n.aur-root[data-idle=\"true\"] .aur-chrome { opacity: 0; pointer-events: none; }\n.aur-root[data-idle=\"true\"] .aur-player { transform: translateY(18px); }\n.aur-root[data-idle=\"true\"] .aur-header { transform: translateY(-10px); }\n.aur-root.is-open .aur-player { animation: aur-rise 0.8s var(--aur-ease) 0.1s backwards; }\n.aur-root.is-open .aur-header { animation: aur-drop 0.8s var(--aur-ease) 0.05s backwards; }\n@keyframes aur-rise { from { opacity: 0; transform: translateY(28px); } }\n@keyframes aur-drop { from { opacity: 0; transform: translateY(-14px); } }\n.aur-toast {\nposition: absolute;\nleft: 50%;\nbottom: 150px;\nz-index: 5;\nmax-width: calc(100vw - 32px);\npadding: 9px 18px;\nborder-radius: 999px;\nbackground: rgba(24, 24, 28, 0.82);\nborder: 1px solid rgba(255, 255, 255, 0.1);\nbox-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);\nbackdrop-filter: blur(20px);\nfont-size: 13px;\nfont-weight: 600;\nwhite-space: nowrap;\noverflow: hidden;\ntext-overflow: ellipsis;\nopacity: 0;\npointer-events: none;\ntransform: translate(-50%, 10px) scale(0.96);\ntransition: opacity 0.25s ease, transform 0.4s var(--aur-spring);\n}\n.aur-root[data-transport=\"off\"] .aur-toast { bottom: 84px; }\n.aur-toast.is-on { opacity: 1; transform: translate(-50%, 0) scale(1); }\n.aur-root { --aur-safe-top: 52px; }\n.aur-root[data-fs=\"true\"] { --aur-safe-top: 12px; }\n.aur-panel {\nposition: absolute;\ntop: var(--aur-safe-top);\nright: 12px;\nbottom: 12px;\nz-index: 4;\nwidth: min(520px, calc(100vw - 24px));\ndisplay: grid;\ngrid-template-columns: 76px minmax(0, 1fr);\noverflow: hidden;\nborder-radius: 22px;\nbackground: linear-gradient(180deg, rgba(32, 32, 38, 0.86), rgba(18, 18, 22, 0.9));\nborder: 1px solid rgba(255, 255, 255, 0.08);\nbox-shadow: 0 40px 100px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.06);\nbackdrop-filter: blur(40px) saturate(1.5);\nfont-size: 14px;\n-webkit-app-region: no-drag;\nopacity: 0;\nvisibility: hidden;\ntransform: translateX(28px) scale(0.985);\ntransform-origin: right center;\ntransition: transform 0.5s var(--aur-ease), opacity 0.3s ease, visibility 0s linear 0.5s;\n}\n.aur-panel.is-open { opacity: 1; visibility: visible; transform: none; transition-delay: 0s; }\n.aur-panel [hidden] { display: none !important; }\n.aur-rail {\nposition: relative;\ndisplay: flex;\nflex-direction: column;\ngap: 4px;\npadding: 14px 8px;\nbackground: rgba(0, 0, 0, 0.18);\nborder-right: 1px solid rgba(255, 255, 255, 0.05);\n}\n.aur-rail-btn {\nposition: relative;\nz-index: 1;\ndisplay: flex;\nflex-direction: column;\nalign-items: center;\njustify-content: center;\ngap: 5px;\nheight: 62px;\nborder-radius: 14px;\ncolor: rgba(255, 255, 255, 0.5);\ntransition: color 0.25s ease, background 0.25s ease;\n}\n.aur-rail-btn:hover { color: rgba(255, 255, 255, 0.88); background: rgba(255, 255, 255, 0.04); }\n.aur-rail-btn[aria-selected=\"true\"] { color: #fff; background: none; }\n.aur-rail-icon { display: grid; transition: transform 0.35s var(--aur-spring); }\n.aur-rail-btn[aria-selected=\"true\"] .aur-rail-icon { transform: translateY(-1px) scale(1.06); }\n.aur-rail-icon svg { width: 21px; height: 21px; }\n.aur-rail-label { font-size: 10.5px; font-weight: 650; letter-spacing: 0.01em; }\n.aur-rail-pill {\nposition: absolute;\ntop: 14px;\nleft: 8px;\nright: 8px;\nheight: 62px;\nborder-radius: 14px;\nbackground: rgba(255, 255, 255, 0.1);\nbox-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.07);\ntransform: translateY(calc(var(--i, 1) * 66px));\ntransition: transform 0.45s var(--aur-ease), opacity 0.2s ease;\n}\n.aur-rail-pill::before { content: \"\"; position: absolute; left: -8px; top: 20px; bottom: 20px; width: 3px; border-radius: 0 3px 3px 0; background: var(--aur-toggle-on); }\n.aur-panel[data-searching=\"true\"] .aur-rail-pill { opacity: 0; }\n.aur-panel-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }\n.aur-panel-head {\ndisplay: grid;\ngrid-template-columns: minmax(0, 1fr) auto;\nalign-items: start;\ngap: 14px 8px;\npadding: 18px 14px 14px 20px;\nborder-bottom: 1px solid rgba(255, 255, 255, 0.05);\n}\n.aur-panel-title { font-family: var(--aur-font); font-size: 21px; font-weight: 800; line-height: 1.15; letter-spacing: -0.02em; }\n.aur-panel-sub { margin-top: 3px; font-size: 12.5px; color: rgba(255, 255, 255, 0.5); }\n.aur-panel-close { margin: -4px -2px 0 0; background: rgba(255, 255, 255, 0.06); }\n.aur-panel-close:hover { background: rgba(255, 255, 255, 0.14); }\n.aur-search-wrap { grid-column: 1 / -1; position: relative; display: block; }\n.aur-search-icon { position: absolute; left: 11px; top: 50%; display: grid; transform: translateY(-50%); color: rgba(255, 255, 255, 0.45); pointer-events: none; }\n.aur-search {\nwidth: 100%;\nheight: 36px;\npadding: 0 12px 0 34px;\nborder: 1px solid rgba(255, 255, 255, 0.08);\nborder-radius: 11px;\nbackground: rgba(0, 0, 0, 0.25);\ncolor: #fff;\nfont: inherit;\nfont-size: 13px;\noutline: none;\ntransition: border-color 0.2s ease, background 0.2s ease;\n}\n.aur-search::placeholder { color: rgba(255, 255, 255, 0.4); }\n.aur-search:focus { border-color: rgba(255, 255, 255, 0.28); background: rgba(0, 0, 0, 0.35); }\n.aur-search::-webkit-search-cancel-button { filter: invert(1) opacity(0.5); cursor: pointer; }\n.aur-panel-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 16px 24px 18px; scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.15) transparent; }\n.aur-panel-scroll::-webkit-scrollbar { width: 8px; }\n.aur-panel-scroll::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 99px; background: rgba(255, 255, 255, 0.15) padding-box; }\n.aur-panel.is-open .aur-tab-body:not([hidden]) > * { animation: aur-fade-up 0.5s var(--aur-ease) backwards; }\n.aur-panel.is-open .aur-tab-body:not([hidden]) > :nth-child(2) { animation-delay: 0.04s; }\n.aur-panel.is-open .aur-tab-body:not([hidden]) > :nth-child(3) { animation-delay: 0.08s; }\n.aur-panel.is-open .aur-tab-body:not([hidden]) > :nth-child(n + 4) { animation-delay: 0.12s; }\n.aur-no-results { padding: 48px 0; text-align: center; font-size: 13px; color: rgba(255, 255, 255, 0.5); }\n.aur-tab-body[data-tab=\"track\"] > .aur-np { margin: 14px 0 4px; }\n@media (max-width: 600px) {\n.aur-panel { grid-template-columns: 58px minmax(0, 1fr); }\n.aur-rail-label { display: none; }\n.aur-rail-btn, .aur-rail-pill { height: 50px; }\n.aur-rail-pill { transform: translateY(calc(var(--i, 1) * 54px)); }\n}\n.aur-section h3 { margin: 22px 4px 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: rgba(255, 255, 255, 0.45); }\n.aur-section-card { padding: 2px 14px; border-radius: 14px; background: rgba(255, 255, 255, 0.045); border: 1px solid rgba(255, 255, 255, 0.05); }\n.aur-section-card > .aur-row + .aur-row { border-top: 1px solid rgba(255, 255, 255, 0.06); }\n.aur-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 46px; padding: 10px 0; cursor: pointer; transition: opacity 0.2s ease; }\n.aur-row > span, .aur-row-label > span { font-size: 13.5px; color: rgba(255, 255, 255, 0.9); }\n.aur-row.is-disabled { opacity: 0.35; pointer-events: none; }\n.aur-row-stack, .aur-row-range { flex-direction: column; align-items: stretch; gap: 10px; cursor: default; }\n.aur-row-range { gap: 6px; cursor: pointer; }\n.aur-row-label { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }\n.aur-range-value { font-size: 12px; font-variant-numeric: tabular-nums; color: rgba(255, 255, 255, 0.55); }\n.aur-range { --p: 50%; -webkit-appearance: none; appearance: none; width: 100%; height: 18px; margin: 0; background: transparent; cursor: pointer; }\n.aur-range::-webkit-slider-runnable-track { height: 4px; border-radius: 99px; background: linear-gradient(to right, #fff var(--p), rgba(255, 255, 255, 0.16) var(--p)); }\n.aur-range::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; margin-top: -6px; border-radius: 50%; background: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45); transition: transform 0.2s var(--aur-spring); }\n.aur-range:hover::-webkit-slider-thumb { transform: scale(1.12); }\n.aur-range:active::-webkit-slider-thumb { transform: scale(1.25); }\n.aur-range::-moz-range-track { height: 4px; border-radius: 99px; background: rgba(255, 255, 255, 0.16); }\n.aur-range::-moz-range-progress { height: 4px; border-radius: 99px; background: #fff; }\n.aur-range::-moz-range-thumb { width: 16px; height: 16px; border: 0; border-radius: 50%; background: #fff; }\n.aur-switch { appearance: none; position: relative; flex: none; width: 40px; height: 24px; margin: 0; border-radius: 99px; background: rgba(255, 255, 255, 0.2); cursor: pointer; transition: background 0.25s ease; }\n.aur-switch::before { content: \"\"; position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35); transition: transform 0.35s var(--aur-spring); }\n.aur-switch:checked { background: var(--aur-green); }\n.aur-switch:checked::before { transform: translateX(16px); }\n.aur-segmented { display: flex; gap: 2px; padding: 3px; border-radius: 11px; background: rgba(0, 0, 0, 0.28); }\n.aur-seg { flex: 1; display: grid; place-items: center; height: 30px; border-radius: 8px; font-size: 12.5px; font-weight: 600; color: rgba(255, 255, 255, 0.6); transition: background 0.25s ease, color 0.2s ease, box-shadow 0.25s ease; }\n.aur-seg:hover { color: #fff; }\n.aur-seg[aria-checked=\"true\"] { background: rgba(255, 255, 255, 0.16); color: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3); }\n.aur-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(98px, 1fr)); gap: 8px; }\n.aur-card, .aur-font {\ndisplay: flex;\nflex-direction: column;\ngap: 2px;\npadding: 10px;\nborder-radius: 12px;\nbackground: rgba(255, 255, 255, 0.05);\nborder: 1px solid rgba(255, 255, 255, 0.06);\ntext-align: left;\ntransition: background 0.2s ease, border-color 0.2s ease, transform 0.25s var(--aur-spring);\n}\n.aur-card:hover, .aur-font:hover { background: rgba(255, 255, 255, 0.09); }\n.aur-card:active, .aur-font:active { transform: scale(0.97); }\n.aur-card[aria-checked=\"true\"], .aur-font[aria-checked=\"true\"] { background: rgba(30, 215, 96, 0.12); border-color: rgba(30, 215, 96, 0.75); }\n.aur-card-art { display: block; width: 100%; height: 38px; margin-bottom: 6px; color: rgba(255, 255, 255, 0.8); }\n.aur-card-art svg { width: 100%; height: 100%; fill: currentColor; }\n.aur-card[aria-checked=\"true\"] .aur-card-art { color: var(--aur-green); }\n.aur-card-name { font-size: 13px; font-weight: 700; }\n.aur-card-hint { font-size: 11px; color: rgba(255, 255, 255, 0.5); }\n.aur-themes { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); }\n.aur-theme-art {\nposition: relative;\ndisplay: grid;\nplace-items: center;\nheight: 52px;\nmargin-bottom: 6px;\nborder-radius: 8px;\noverflow: hidden;\nbackground: radial-gradient(120% 140% at 20% 10%, var(--t1) 0%, transparent 70%), var(--t2);\nbox-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);\n}\n.aur-theme-art span { font-size: 24px; font-weight: 800; line-height: 1; color: #fff; text-shadow: 0 0 14px color-mix(in oklab, var(--t1) 70%, transparent); }\n.aur-theme[aria-checked=\"true\"] .aur-theme-art { box-shadow: inset 0 0 0 1px rgba(30, 215, 96, 0.6); }\n.aur-swatches { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }\n.aur-swatch {\nposition: relative;\nwidth: 30px;\nheight: 30px;\nflex: none;\nborder-radius: 50%;\nbackground: var(--sw);\nbox-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);\ncursor: pointer;\ntransition: transform 0.25s var(--aur-spring), box-shadow 0.2s ease;\n}\n.aur-swatch:hover { transform: scale(1.08); }\n.aur-swatch[aria-checked=\"true\"] { box-shadow: 0 0 0 2px #121216, 0 0 0 4px #fff; }\n.aur-swatch.is-album {\nwidth: auto;\npadding: 0 12px;\nborder-radius: 99px;\nfont-size: 12px;\nfont-weight: 700;\ncolor: #fff;\nbackground: linear-gradient(135deg, color-mix(in srgb, var(--aur-album-accent, #fff) 55%, #222), color-mix(in srgb, var(--aur-album-c1, #4b3b78) 70%, #111));\n}\n.aur-swatch.is-custom { background: conic-gradient(var(--sw) 0 0), conic-gradient(#ff5f5f, #ffd23f, #3ddc84, #2ec5ff, #b388ff, #ff5fa2, #ff5f5f); overflow: hidden; }\n.aur-swatch-input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }\n.aur-fonts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }\n.aur-font { align-items: center; text-align: center; }\n.aur-font-sample { font-size: 26px; font-weight: 800; line-height: 1.1; letter-spacing: -0.02em; }\n.aur-font-name { font-size: 11px; color: rgba(255, 255, 255, 0.55); }\n.aur-select { max-width: 200px; padding: 6px 8px; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px; background: rgba(255, 255, 255, 0.07); color: #fff; font: inherit; font-size: 13px; }\n.aur-select option { background: #222; color: #fff; }\n.aur-panel-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }\n.aur-hint { margin: 14px 2px 0; font-size: 12px; line-height: 1.55; color: rgba(255, 255, 255, 0.45); }\n.aur-keys { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; margin-top: 20px; padding: 12px 14px; border-radius: 14px; background: rgba(255, 255, 255, 0.03); font-size: 12px; color: rgba(255, 255, 255, 0.6); }\n.aur-key { display: flex; align-items: center; gap: 8px; }\n.aur-key kbd { flex: none; min-width: 24px; padding: 2px 6px; border-radius: 5px; background: rgba(255, 255, 255, 0.1); box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.12); font: 600 11px/1.4 var(--aur-ui-font); color: #fff; text-align: center; }\n.aur-stat-tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 6px 0 4px; }\n.aur-stat { padding: 14px 12px 12px; border-radius: 14px; background: rgba(255, 255, 255, 0.045); border: 1px solid rgba(255, 255, 255, 0.05); }\n.aur-stat-value { font-size: 20px; font-weight: 800; letter-spacing: -0.02em; line-height: 1.1; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.aur-stat-label { margin-top: 4px; font-size: 11.5px; color: rgba(255, 255, 255, 0.5); }\n.aur-stat-today { float: right; letter-spacing: 0.02em; text-transform: none; font-weight: 600; color: rgba(255, 255, 255, 0.55); }\n.aur-stat-chart { display: grid; grid-template-columns: repeat(14, 1fr); gap: 6px; align-items: end; height: 120px; padding: 14px 14px 10px; border-radius: 14px; background: rgba(255, 255, 255, 0.045); border: 1px solid rgba(255, 255, 255, 0.05); }\n.aur-stat-day { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 6px; height: 100%; }\n.aur-stat-bar { width: 100%; max-width: 18px; height: max(3px, calc(var(--v, 0) * (100% - 20px))); border-radius: 5px; background: rgba(255, 255, 255, 0.22); }\n.aur-stat-day.is-today .aur-stat-bar { background: linear-gradient(to top, color-mix(in oklab, var(--aur-accent) 70%, #fff), color-mix(in oklab, var(--aur-accent) 30%, #fff)); }\n.aur-stat-dow { font-size: 10.5px; color: rgba(255, 255, 255, 0.4); }\n.aur-stat-list { margin: 0; padding: 2px 14px; list-style: none; counter-reset: aur-rank; border-radius: 14px; background: rgba(255, 255, 255, 0.045); border: 1px solid rgba(255, 255, 255, 0.05); }\n.aur-stat-list li { display: flex; align-items: center; gap: 12px; padding: 10px 0; counter-increment: aur-rank; }\n.aur-stat-list li + li { border-top: 1px solid rgba(255, 255, 255, 0.06); }\n.aur-stat-list li::before { content: counter(aur-rank); width: 16px; flex: none; font-size: 12px; font-weight: 700; color: rgba(255, 255, 255, 0.35); text-align: center; }\n.aur-stat-name { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }\n.aur-stat-name b, .aur-stat-name span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.aur-stat-name b { font-size: 13.5px; font-weight: 600; color: #fff; }\n.aur-stat-name span, .aur-stat-num span { font-size: 11.5px; color: rgba(255, 255, 255, 0.45); }\n.aur-stat-num { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 2px; font-size: 13px; font-weight: 600; color: rgba(255, 255, 255, 0.85); font-variant-numeric: tabular-nums; }\n@media (max-width: 700px) { .aur-stat-tiles { grid-template-columns: repeat(2, 1fr); } }\n.aur-track-info { display: flex; align-items: center; gap: 14px; margin: 14px 0; }\n.aur-track-art { width: 60px; height: 60px; flex: none; border-radius: 8px; object-fit: cover; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4); }\n.aur-track-text { min-width: 0; }\n.aur-track-title { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.aur-track-sub { margin-top: 2px; font-size: 12.5px; color: rgba(255, 255, 255, 0.6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.aur-track-chip { display: inline-block; margin-top: 7px; padding: 3px 9px; border-radius: 99px; background: rgba(255, 255, 255, 0.08); font-size: 11.5px; font-weight: 600; color: rgba(255, 255, 255, 0.75); }\n.aur-textarea {\ndisplay: block;\nwidth: 100%;\nmin-height: 280px;\npadding: 12px 14px;\nresize: vertical;\nborder: 1px solid rgba(255, 255, 255, 0.1);\nborder-radius: 12px;\nbackground: rgba(0, 0, 0, 0.32);\ncolor: #fff;\nfont: 12px/1.6 ui-monospace, \"Cascadia Code\", Consolas, monospace;\nuser-select: text;\ntransition: border-color 0.2s ease, background 0.2s ease;\n}\n.aur-textarea:focus { border-color: rgba(255, 255, 255, 0.3); outline: none; }\n.aur-textarea.is-drop { border-color: var(--aur-green); background: rgba(30, 215, 96, 0.08); }\n.aur-root { --aur-split-w: clamp(320px, 40vw, 600px); }\n.aur-side {\nposition: absolute;\ntop: 0;\nbottom: 0;\nleft: 0;\nz-index: 1;\nwidth: var(--aur-split-w);\ndisplay: none;\nflex-direction: column;\nalign-items: center;\njustify-content: center;\ngap: 24px;\npadding: 64px 2vw 150px calc(var(--aur-pad) * 0.8);\n}\n.aur-art-wrap {\nposition: relative;\ndisplay: block;\nwidth: min(100%, 52vh, 460px);\naspect-ratio: 1;\nflex: none;\nborder-radius: 14px;\ncursor: pointer;\nbox-shadow: 0 40px 90px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.06);\ntransition: transform 0.8s var(--aur-spring), box-shadow 0.8s ease;\n}\n.aur-root[data-playing=\"false\"] .aur-art-wrap { transform: scale(0.86); box-shadow: 0 18px 44px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.05); }\n.aur-art-wrap:active { transform: scale(0.97); }\n.aur-root[data-playing=\"false\"] .aur-art-wrap:active { transform: scale(0.84); }\n.aur-art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; border-radius: inherit; opacity: 0; transition: opacity 0.9s ease; }\n.aur-art.is-on { opacity: 1; }\n.aur-art-hint {\nposition: absolute;\nleft: 50%;\ntop: 50%;\ndisplay: grid;\nplace-items: center;\nwidth: 64px;\nheight: 64px;\nmargin: -32px 0 0 -32px;\nborder-radius: 50%;\nbackground: rgba(0, 0, 0, 0.45);\nbackdrop-filter: blur(10px);\ncolor: #fff;\nopacity: 0;\ntransform: scale(0.8);\ntransition: opacity 0.25s ease, transform 0.35s var(--aur-spring);\n}\n.aur-art-hint svg { width: 28px; height: 28px; }\n.aur-art-wrap:hover .aur-art-hint, .aur-art-wrap:focus-visible .aur-art-hint { opacity: 1; transform: none; }\n.aur-side-meta { width: min(100%, 52vh, 460px); min-width: 0; }\n.aur-side-title {\ndisplay: -webkit-box;\noverflow: hidden;\n-webkit-line-clamp: 2;\n-webkit-box-orient: vertical;\nfont-family: var(--aur-font);\nfont-size: clamp(20px, 2.1vw, 30px);\nfont-weight: 800;\nline-height: 1.15;\nletter-spacing: -0.02em;\n}\n.aur-side-artist, .aur-side-album { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }\n.aur-side-artist { margin-top: 6px; font-size: 15px; color: rgba(255, 255, 255, 0.7); }\n.aur-side-album { margin-top: 2px; font-size: 13px; color: rgba(255, 255, 255, 0.45); }\n.aur-root.is-open .aur-side { animation: aur-art-in 0.9s var(--aur-ease) 0.05s backwards; }\n.aur-disc { position: absolute; inset: 0; border-radius: inherit; overflow: hidden; }\n.aur-disc-grooves, .aur-disc-shine { display: none; }\n@media (min-width: 900px) and (min-height: 540px) {\n.aur-root:is([data-view=\"split\"], [data-view=\"mirror\"], [data-view=\"poster\"], [data-view=\"vinyl\"]) .aur-side { display: flex; }\n.aur-root:is([data-view=\"split\"], [data-view=\"mirror\"], [data-view=\"poster\"], [data-view=\"vinyl\"]) :is(.aur-header, .aur-message-art) { display: none; }\n.aur-root:is([data-view=\"split\"], [data-view=\"vinyl\"]) .aur-stage { left: var(--aur-split-w); padding-left: 2.5vw; --aur-size: min(var(--aur-fs), 4.6vw, 10.5vh); }\n.aur-root[data-view=\"mirror\"] .aur-side { left: auto; right: 0; padding: 64px calc(var(--aur-pad) * 0.8) 150px 2vw; }\n.aur-root[data-view=\"mirror\"] .aur-stage { right: var(--aur-split-w); padding-right: 2.5vw; --aur-size: min(var(--aur-fs), 4.6vw, 10.5vh); }\n.aur-root[data-view=\"poster\"] { --aur-poster-w: clamp(360px, 46vw, 820px); }\n.aur-root[data-view=\"poster\"] .aur-side { width: var(--aur-poster-w); padding: 0; display: block; }\n.aur-root[data-view=\"poster\"] .aur-art-wrap {\nposition: absolute;\ninset: 0;\nwidth: 100%;\nheight: 100%;\naspect-ratio: auto;\nborder-radius: 0;\nbox-shadow: none;\n-webkit-mask-image: linear-gradient(to right, #000 45%, transparent 98%), linear-gradient(to top, transparent 0, #000 42%);\n-webkit-mask-composite: source-in;\nmask-image: linear-gradient(to right, #000 45%, transparent 98%), linear-gradient(to top, transparent 0, #000 42%);\nmask-composite: intersect;\ntransition: opacity 0.8s ease, filter 0.8s ease;\n}\n.aur-root[data-view=\"poster\"][data-playing=\"false\"] .aur-art-wrap { transform: none; box-shadow: none; filter: saturate(0.6) brightness(0.8); }\n.aur-root[data-view=\"poster\"] .aur-art-wrap:active { transform: none; }\n.aur-root[data-view=\"poster\"] .aur-art-hint { left: 40%; }\n.aur-root[data-view=\"poster\"] .aur-side-meta { position: absolute; left: var(--aur-pad); bottom: 150px; width: min(34vw, 560px); text-shadow: 0 2px 24px rgba(0, 0, 0, 0.45); }\n.aur-root[data-view=\"poster\"] .aur-side-title { font-size: clamp(28px, 3.4vw, 54px); line-height: 1.05; }\n.aur-root[data-view=\"poster\"] .aur-side-artist { font-size: clamp(15px, 1.3vw, 19px); color: rgba(255, 255, 255, 0.82); }\n.aur-root[data-view=\"poster\"] .aur-stage { left: calc(var(--aur-poster-w) * 0.9); padding-left: 2vw; --aur-size: min(var(--aur-fs), 4.4vw, 10.5vh); }\n.aur-root[data-view=\"vinyl\"] .aur-art-wrap { border-radius: 50%; box-shadow: 0 40px 90px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05); }\n.aur-root[data-view=\"vinyl\"] .aur-disc {\nborder-radius: 50%;\nbackground:\nradial-gradient(circle, transparent 0 21%, rgba(255, 255, 255, 0.07) 21.3%, transparent 22%),\nradial-gradient(circle, #1b1b1f 0 60%, #111114 100%);\nanimation: aur-spin-disc 7.5s linear infinite;\nanimation-play-state: paused;\n}\n.aur-root[data-view=\"vinyl\"][data-playing=\"true\"] .aur-disc { animation-play-state: running; }\n.aur-root[data-view=\"vinyl\"] .aur-disc-grooves {\ndisplay: block;\nposition: absolute;\ninset: 0;\nborder-radius: 50%;\nbackground: repeating-radial-gradient(circle, rgba(255, 255, 255, 0.035) 0 1px, rgba(255, 255, 255, 0.012) 1.6px, transparent 2.4px 4px);\n-webkit-mask-image: radial-gradient(circle, transparent 0 33%, #000 34% 96%, transparent 97%);\nmask-image: radial-gradient(circle, transparent 0 33%, #000 34% 96%, transparent 97%);\n}\n.aur-root[data-view=\"vinyl\"] .aur-art { inset: 31%; width: 38%; height: 38%; border-radius: 50%; }\n.aur-root[data-view=\"vinyl\"] .aur-disc::after { content: \"\"; position: absolute; left: 50%; top: 50%; width: 3.2%; height: 3.2%; margin: -1.6% 0 0 -1.6%; border-radius: 50%; background: #0b0b0e; box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.08); }\n.aur-root[data-view=\"vinyl\"] .aur-disc-shine {\ndisplay: block;\nposition: absolute;\ninset: 0;\nborder-radius: 50%;\npointer-events: none;\nbackground: conic-gradient(from 20deg, transparent 0 8%, rgba(255, 255, 255, 0.1) 13%, transparent 20% 52%, rgba(255, 255, 255, 0.08) 60%, transparent 68%);\n-webkit-mask-image: radial-gradient(circle, transparent 0 32%, #000 36%);\nmask-image: radial-gradient(circle, transparent 0 32%, #000 36%);\n}\n.aur-root[data-view=\"vinyl\"] .aur-art-hint { z-index: 1; }\n.aur-root[data-view=\"vinyl\"] .aur-side-meta { text-align: center; }\n}\n@keyframes aur-spin-disc { to { rotate: 360deg; } }\n@media (min-height: 600px) {\n.aur-root:is([data-view=\"stage\"], [data-view=\"captions\"]) .aur-side { display: flex; left: 0; right: 0; width: auto; }\n.aur-root:is([data-view=\"stage\"], [data-view=\"captions\"]) :is(.aur-header, .aur-message-art) { display: none; }\n.aur-root:is([data-view=\"stage\"], [data-view=\"captions\"]) .aur-stage { --aur-origin: 50%; text-align: center; }\n.aur-root:is([data-view=\"stage\"], [data-view=\"captions\"]) .aur-line { margin-inline: auto; }\n.aur-root:is([data-view=\"stage\"], [data-view=\"captions\"]) .aur-side-meta { width: auto; min-width: 0; }\n.aur-root[data-view=\"stage\"] .aur-side { flex-direction: row; justify-content: center; bottom: auto; gap: 18px; padding: calc(var(--aur-safe-top) - 16px) var(--aur-pad) 0; }\n.aur-root[data-view=\"stage\"] .aur-art-wrap { width: clamp(84px, 14vh, 150px); border-radius: 10px; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5); }\n.aur-root[data-view=\"stage\"][data-playing=\"false\"] .aur-art-wrap { transform: scale(0.9); }\n.aur-root[data-view=\"stage\"] .aur-art-hint { width: 44px; height: 44px; margin: -22px 0 0 -22px; }\n.aur-root[data-view=\"stage\"] .aur-side-meta { max-width: 42vw; }\n.aur-root[data-view=\"stage\"] .aur-side-title { font-size: clamp(18px, 2.4vh, 26px); }\n.aur-root[data-view=\"stage\"] .aur-stage { top: calc(var(--aur-safe-top) + clamp(84px, 14vh, 150px)); }\n.aur-root[data-view=\"captions\"] .aur-side { flex-direction: column; justify-content: center; top: 0; bottom: 40vh; gap: 14px; padding: calc(var(--aur-safe-top) - 8px) var(--aur-pad) 0; }\n.aur-root[data-view=\"captions\"] .aur-art-wrap { width: min(34vh, 380px); }\n.aur-root[data-view=\"captions\"] .aur-side-meta { text-align: center; }\n.aur-root[data-view=\"captions\"] .aur-side-title { font-size: clamp(18px, 2.4vh, 26px); }\n.aur-root[data-view=\"captions\"] .aur-stage {\ntop: 58vh;\nbottom: 104px;\n--aur-size: min(calc(var(--aur-fs) * 0.8), 4.4vw, 5.6vh);\n-webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 14%, #000 86%, transparent 100%);\nmask-image: linear-gradient(to bottom, transparent 0, #000 14%, #000 86%, transparent 100%);\n}\n.aur-root[data-view=\"captions\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-active):not([data-d=\"1\"]) { opacity: 0 !important; pointer-events: none; }\n.aur-root[data-view=\"captions\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"1\"] { opacity: 0.4; }\n}\n.aur-root.aur-view-swap :is(.aur-side, .aur-stage) { animation: aur-fade-up 0.7s var(--aur-ease) both; }\n.aur-np {\ndisplay: flex;\nalign-items: center;\ngap: 12px;\nmargin: 2px 14px 8px;\npadding: 10px;\nborder-radius: 14px;\nbackground: linear-gradient(135deg, color-mix(in srgb, var(--aur-accent) 18%, transparent), rgba(255, 255, 255, 0.04));\nborder: 1px solid rgba(255, 255, 255, 0.07);\n}\n.aur-np img { width: 50px; height: 50px; flex: none; border-radius: 8px; object-fit: cover; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4); }\n.aur-np-text { min-width: 0; flex: 1; }\n.aur-np-title, .aur-np-sub { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }\n.aur-np-title { font-size: 14px; font-weight: 700; }\n.aur-np-sub { margin-top: 2px; font-size: 12px; color: rgba(255, 255, 255, 0.6); }\n.aur-np-chip { flex: none; padding: 3px 8px; border-radius: 99px; background: rgba(255, 255, 255, 0.09); font-size: 11px; font-weight: 700; color: rgba(255, 255, 255, 0.8); }\n.aur-prov-list { display: flex; flex-direction: column; gap: 6px; }\n.aur-prov {\ndisplay: grid;\ngrid-template-columns: auto 1fr auto auto;\nalign-items: center;\ngap: 10px;\npadding: 10px 10px 10px 8px;\nborder-radius: 12px;\nbackground: rgba(0, 0, 0, 0.22);\ntransition: opacity 0.2s ease, background 0.2s ease;\n}\n.aur-prov.is-off { opacity: 0.45; }\n.aur-prov-rank { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: rgba(255, 255, 255, 0.1); font-size: 11px; font-weight: 700; }\n.aur-prov-name { font-size: 13.5px; font-weight: 700; }\n.aur-prov-badge { margin-left: 6px; padding: 1px 6px; border-radius: 99px; background: rgba(124, 212, 255, 0.16); color: #7cd4ff; font-size: 10px; font-weight: 700; vertical-align: 1px; }\n.aur-prov-desc { margin-top: 2px; font-size: 11.5px; line-height: 1.35; color: rgba(255, 255, 255, 0.5); }\n.aur-prov-move { display: flex; flex-direction: column; }\n.aur-prov-move button { display: grid; place-items: center; width: 24px; height: 18px; border-radius: 6px; color: rgba(255, 255, 255, 0.6); }\n.aur-prov-move button:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }\n.aur-prov-move button:disabled { opacity: 0.2; pointer-events: none; }\n.aur-prov-move svg { width: 14px; height: 14px; }\n.aur-src-title { margin: 16px 2px 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: rgba(255, 255, 255, 0.45); }\n.aur-src-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }\n.aur-src-btn {\ndisplay: flex;\nalign-items: center;\njustify-content: space-between;\ngap: 6px;\nmin-height: 36px;\npadding: 6px 10px;\nborder-radius: 10px;\nbackground: rgba(255, 255, 255, 0.06);\nfont-size: 12.5px;\nfont-weight: 600;\ntext-align: left;\ntransition: background 0.2s ease, box-shadow 0.2s ease;\n}\n.aur-src-btn:hover { background: rgba(255, 255, 255, 0.11); }\n.aur-src-btn small { font-size: 10.5px; font-weight: 600; color: rgba(255, 255, 255, 0.5); }\n.aur-src-btn.is-current { background: rgba(30, 215, 96, 0.13); box-shadow: inset 0 0 0 1px rgba(30, 215, 96, 0.6); }\n.aur-src-btn.is-loading small { animation: aur-blink 1s ease-in-out infinite; }\n.aur-test-btn { width: 100%; margin-top: 8px; }\n@keyframes aur-blink { 50% { opacity: 0.3; } }\n@media (max-width: 1100px) {\n.aur-offset-group { display: none; }\n.aur-source { max-width: 160px; }\n}\n@media (max-width: 780px) {\n.aur-root { --aur-pad: 22px; }\n.aur-header { top: 18px; max-width: calc(100vw - 44px); }\n.aur-cover { width: 44px; height: 44px; }\n.aur-player { column-gap: 10px; padding-bottom: 12px; grid-template-columns: auto minmax(0, 1fr) auto; }\n.aur-source { width: 32px; padding: 0; justify-content: center; font-size: 0; }\n.aur-source::before { width: 9px; height: 9px; }\n.aur-transport { gap: 8px; }\n.aur-play-btn { width: 50px; height: 50px; }\n.aur-player-side { height: 50px; }\n}\n@media (max-width: 600px) {\n.aur-offset-group,\n.aur-volume,\n.aur-player-side .aur-sep,\n.aur-heart,\n.aur-toggle { display: none; }\n.aur-player-side .aur-icon-btn { width: 34px; height: 34px; }\n}\n@media (max-height: 540px) {\n.aur-header { display: none; }\n.aur-message-art { display: none; }\n}\n.aur-no-anim .aur-line,\n.aur-no-anim .aur-w,\n.aur-no-anim .aur-c { transition: none !important; }\n.aur-root[data-motion=\"reduced\"] { transform: none !important; transition: opacity 0.2s ease; }\n.aur-root[data-motion=\"reduced\"] .aur-line,\n.aur-root[data-motion=\"reduced\"] .aur-w,\n.aur-root[data-motion=\"reduced\"] .aur-player,\n.aur-root[data-motion=\"reduced\"] .aur-header,\n.aur-root[data-motion=\"reduced\"] .aur-panel,\n.aur-root[data-motion=\"reduced\"] .aur-rail-pill {\ntransition-property: opacity, color, visibility !important;\ntransition-duration: 0.2s !important;\ntransition-delay: 0s !important;\n}\n.aur-root[data-motion=\"reduced\"] *,\n.aur-root[data-motion=\"reduced\"] *::before { animation: none !important; }\n.aur-root[data-motion=\"reduced\"] .aur-line[data-d] { filter: none !important; }\n.aur-root[data-motion=\"reduced\"] .aur-w,\n.aur-root[data-motion=\"reduced\"] .aur-c { transform: none !important; }\n[data-testid=\"lyrics-npv-section\"][data-aur-hidden] { display: none !important; }\n.aur-npv {\n--npv-c: #3a3a46;\nposition: relative;\noverflow: hidden;\npadding: 16px 16px 10px;\nborder-radius: 8px;\ncolor: #fff;\nfont-family: var(--encore-body-font-stack, \"SpotifyMixUI\", \"CircularSp\", system-ui, sans-serif);\nbackground:\nradial-gradient(120% 90% at 0% 0%, color-mix(in oklab, var(--npv-c) 80%, #fff 6%) 0%, transparent 70%),\nlinear-gradient(165deg, color-mix(in oklab, var(--npv-c) 72%, #000) 0%, color-mix(in oklab, var(--npv-c) 38%, #0d0d10) 100%);\nbox-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);\ntransition: background 0.8s ease;\n}\n.aur-npv-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; min-width: 0; }\n.aur-npv-title { margin: 0; font-size: 16px; font-weight: 700; }\n.aur-npv-src { min-width: 0; overflow: hidden; padding: 2px 8px; border-radius: 99px; background: rgba(255, 255, 255, 0.1); font-size: 11px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; color: rgba(255, 255, 255, 0.72); }\n.aur-npv-src:empty { display: none; }\n.aur-npv-open {\ndisplay: grid;\nflex: none;\nplace-items: center;\nwidth: 32px;\nheight: 32px;\nmargin-left: auto;\npadding: 0;\nborder: 0;\nborder-radius: 50%;\nbackground: rgba(255, 255, 255, 0.1);\ncolor: rgba(255, 255, 255, 0.8);\ncursor: pointer;\ntransition: background 0.2s ease, color 0.2s ease, transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);\n}\n.aur-npv-open:hover { background: rgba(255, 255, 255, 0.2); color: #fff; transform: scale(1.08); }\n.aur-npv-open svg { width: 16px; height: 16px; }\n.aur-npv-body {\nposition: relative;\nheight: 204px;\noverflow: hidden;\ncursor: pointer;\n-webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 14%, #000 78%, transparent 100%);\nmask-image: linear-gradient(to bottom, transparent 0, #000 14%, #000 78%, transparent 100%);\n}\n.aur-npv-lines { padding-top: 6px; will-change: transform; transition: transform 0.75s cubic-bezier(0.22, 1, 0.36, 1); }\n.aur-npv-lines.no-anim { transition: none; }\n.aur-npv-line {\nmargin: 0 -8px;\npadding: 5px 8px;\nborder-radius: 8px;\nfont-size: 19px;\nfont-weight: 700;\nline-height: 1.32;\nletter-spacing: -0.01em;\ncolor: rgba(255, 255, 255, 0.42);\ntransition: color 0.45s ease, background 0.2s ease, text-shadow 0.6s ease;\n}\n.aur-npv-line.is-past { color: rgba(255, 255, 255, 0.7); }\n.aur-npv-line.is-active { color: #fff; text-shadow: 0 0 18px rgba(255, 255, 255, 0.25); }\n.aur-npv-line.is-gap { letter-spacing: 0.15em; }\n.aur-npv-line[title]:hover { background: rgba(255, 255, 255, 0.09); color: rgba(255, 255, 255, 0.92); }\n.aur-npv-line.is-active:has(.aur-npv-w) { text-shadow: none; }\n.aur-npv-line.is-active .aur-npv-w { color: rgba(255, 255, 255, 0.42); }\n.aur-npv-line.is-active .aur-npv-w.sung { color: #fff; }\n.aur-npv-line.is-active .aur-npv-w.now {\ncolor: transparent;\nbackground: linear-gradient(90deg, #fff calc(var(--aur-wp, 0) * (100% + 0.6em) - 0.6em), rgba(255, 255, 255, 0.42) calc(var(--aur-wp, 0) * (100% + 0.6em)));\n-webkit-background-clip: text;\nbackground-clip: text;\n}\n.aur-npv.is-unsynced .aur-npv-line { color: rgba(255, 255, 255, 0.85); font-size: 16px; }\n.aur-npv[data-duet=\"on\"] .aur-npv-line[data-singer=\"1\"] { text-align: right; }\n.aur-npv[data-duet=\"on\"] .aur-npv-line[data-singer=\"2\"] { text-align: center; }\n.aur-npv[data-duet=\"on\"] .aur-npv-line.is-active[data-singer=\"1\"],\n.aur-npv[data-duet=\"on\"] .aur-npv-line.is-active[data-singer=\"1\"] .aur-npv-w.sung { color: #ffd3e6; }\n.aur-npv[data-duet=\"on\"] .aur-npv-line.is-active[data-singer=\"2\"],\n.aur-npv[data-duet=\"on\"] .aur-npv-line.is-active[data-singer=\"2\"] .aur-npv-w.sung { color: #ffe9f2; }\n.aur-npv-msg { position: absolute; inset: 0; display: grid; place-items: center; padding: 0 16px; font-size: 13px; text-align: center; color: rgba(255, 255, 255, 0.62); }\n.aur-npv-msg:empty { display: none; }\n.aur-npv-tr { margin-top: 2px; font-size: 13px; font-weight: 600; line-height: 1.3; color: rgba(255, 255, 255, 0.55); }\n.aur-npv-line.is-active .aur-npv-tr { color: rgba(255, 255, 255, 0.85); }\n.aur-share {\nposition: absolute;\ninset: 0;\nz-index: 6;\ndisplay: grid;\nplace-items: center;\npadding: var(--aur-safe-top, 48px) 16px 16px;\nbackground: rgba(0, 0, 0, 0.45);\nbackdrop-filter: blur(6px);\nopacity: 0;\ntransition: opacity 0.25s ease;\n}\n.aur-share[hidden] { display: none; }\n.aur-share.is-open { opacity: 1; }\n.aur-share-card {\ndisplay: grid;\ngrid-template-columns: auto minmax(260px, 340px);\ngap: 22px;\nmax-width: min(980px, 100%);\nmax-height: 100%;\npadding: 20px;\nborder-radius: 24px;\nbackground: linear-gradient(180deg, rgba(34, 34, 40, 0.92), rgba(18, 18, 22, 0.95));\nborder: 1px solid rgba(255, 255, 255, 0.08);\nbox-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);\ntransform: translateY(12px) scale(0.98);\ntransition: transform 0.35s var(--aur-ease);\nuser-select: none;\n}\n.aur-share.is-open .aur-share-card { transform: none; }\n.aur-share-preview { display: grid; place-items: center; min-height: 0; }\n.aur-share-canvas {\ndisplay: block;\nwidth: auto;\nmax-width: min(46vw, 440px);\nmax-height: min(72vh, 640px);\nborder-radius: 14px;\nbox-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);\n}\n.aur-share-side { display: flex; flex-direction: column; gap: 8px; min-height: 0; min-width: 0; max-height: min(78vh, 720px); }\n.aur-share-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 2px; }\n.aur-share-scroll { display: flex; flex-direction: column; gap: 8px; min-height: 0; overflow-y: auto; margin-right: -8px; padding-right: 8px; scrollbar-width: thin; }\n.aur-share-label { display: flex; justify-content: space-between; margin-top: 8px; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: rgba(255, 255, 255, 0.55); }\n.aur-share-count { font-variant-numeric: tabular-nums; letter-spacing: 0; }\n.aur-share-lines {\ndisplay: flex;\nflex-direction: column;\ngap: 2px;\nflex: none;\nheight: 26vh;\nmin-height: 120px;\nmax-height: 260px;\noverflow-y: auto;\npadding: 4px;\nborder-radius: 12px;\nbackground: rgba(0, 0, 0, 0.22);\nscrollbar-width: thin;\n}\n.aur-share-line {\npadding: 7px 10px;\nborder-radius: 8px;\nfont-size: 13.5px;\nfont-weight: 600;\nline-height: 1.35;\ntext-align: left;\ncolor: rgba(255, 255, 255, 0.62);\nuser-select: none;\ntransition: background 0.15s ease, color 0.15s ease;\n}\n.aur-share-line:hover { background: rgba(255, 255, 255, 0.07); color: #fff; }\n.aur-share-line[aria-pressed=\"true\"] { background: rgba(30, 215, 96, 0.14); color: #fff; box-shadow: inset 3px 0 0 var(--aur-green); }\n.aur-share-quick { display: flex; align-items: center; gap: 12px; font-size: 12px; }\n.aur-share-link { padding: 0; font-weight: 700; color: rgba(255, 255, 255, 0.8); }\n.aur-share-link:hover { color: #fff; text-decoration: underline; }\n.aur-share-tip { margin-left: auto; color: rgba(255, 255, 255, 0.4); }\n.aur-share .aur-segmented.is-disabled { opacity: 0.4; pointer-events: none; }\n.aur-share .aur-seg { padding: 0 6px; font-size: 12px; }\n.aur-share-size { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 12px; margin-top: 4px; font-size: 13px; color: rgba(255, 255, 255, 0.75); }\n.aur-share-toggles { display: flex; flex-direction: column; margin-top: 8px; border-radius: 12px; background: rgba(255, 255, 255, 0.04); }\n.aur-share-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 12px; font-size: 13px; cursor: pointer; }\n.aur-share-toggle + .aur-share-toggle { border-top: 1px solid rgba(255, 255, 255, 0.05); }\n.aur-share-toggle[hidden] { display: none; }\n.aur-share-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding-top: 12px; border-top: 1px solid rgba(255, 255, 255, 0.06); }\n.aur-share-actions .aur-btn { justify-content: center; }\n.aur-share-actions .aur-btn[hidden] { display: none; }\n@media (max-width: 760px) {\n.aur-share-card { grid-template-columns: 1fr; overflow-y: auto; }\n.aur-share-canvas { max-width: 100%; max-height: 40vh; }\n}\n.aur-float {\n--float-c: #2a2a33;\nposition: fixed;\nz-index: 9990;\ndisplay: flex;\nalign-items: center;\ngap: 12px;\nbox-sizing: border-box;\nwidth: min(560px, calc(100vw - 16px));\nmin-height: 68px;\npadding: 10px 16px 10px 10px;\nborder-radius: 18px;\ncolor: #fff;\nfont-family: var(--encore-body-font-stack, \"SpotifyMixUI\", \"CircularSp\", system-ui, sans-serif);\nbackground: linear-gradient(135deg, color-mix(in srgb, var(--float-c) 72%, rgba(14, 14, 18, 0.9)), rgba(14, 14, 18, 0.88));\nborder: 1px solid rgba(255, 255, 255, 0.1);\nbox-shadow: 0 18px 48px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.06);\nbackdrop-filter: blur(22px) saturate(1.4);\ncursor: grab;\nuser-select: none;\n-webkit-app-region: no-drag;\ntransition: background 0.8s ease, box-shadow 0.25s ease;\n}\n.aur-float[hidden] { display: none; }\n.aur-float *, .aur-float *::before { box-sizing: border-box; }\n.aur-float.is-in { animation: aur-float-in 0.45s cubic-bezier(0.22, 1, 0.36, 1); }\n@keyframes aur-float-in { from { opacity: 0; transform: translateY(12px) scale(0.97); } }\n.aur-float.is-dragging { cursor: grabbing; box-shadow: 0 26px 60px rgba(0, 0, 0, 0.6); transition: none; }\n.aur-float-art { flex: none; width: 48px; height: 48px; border-radius: 10px; object-fit: cover; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4); pointer-events: none; }\n.aur-float-art[hidden] { display: none; }\n.aur-float-text { flex: 1; min-width: 0; cursor: pointer; }\n.aur-float-cur {\nfont-family: var(--encore-title-font-stack, \"SpotifyMixUITitle\", \"SpotifyMixUI\", \"CircularSp\", system-ui, sans-serif);\nfont-size: 18px;\nfont-weight: 800;\nline-height: 1.25;\nletter-spacing: -0.01em;\noverflow-wrap: anywhere;\ndisplay: -webkit-box;\n-webkit-line-clamp: 2;\n-webkit-box-orient: vertical;\noverflow: hidden;\n}\n.aur-float-next { margin-top: 2px; font-size: 13px; font-weight: 600; color: rgba(255, 255, 255, 0.5); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.aur-float-next:empty { display: none; }\n.aur-float .is-enter { animation: aur-float-line 0.4s cubic-bezier(0.22, 1, 0.36, 1); }\n@keyframes aur-float-line { from { opacity: 0; transform: translateY(6px); filter: blur(3px); } }\n.aur-float-w { color: rgba(255, 255, 255, 0.4); }\n.aur-float-w.sung { color: #fff; }\n.aur-float-w[style*=\"--aur-wp\"] {\ncolor: transparent;\nbackground: linear-gradient(90deg, #fff calc(var(--aur-wp, 0) * (100% + 0.6em) - 0.6em), rgba(255, 255, 255, 0.4) calc(var(--aur-wp, 0) * (100% + 0.6em)));\n-webkit-background-clip: text;\nbackground-clip: text;\n}\n.aur-float[data-duet=\"on\"] .aur-float-cur[data-singer=\"1\"] .aur-float-w.sung,\n.aur-float[data-duet=\"on\"] .aur-float-cur[data-singer=\"1\"]:not(:has(.aur-float-w:not([hidden]))) { color: #ffd3e6; }\n.aur-float-dots { display: inline-flex; gap: 6px; padding: 6px 0; }\n.aur-float-cur > [hidden] { display: none; }\n.aur-float-dots i { width: 7px; height: 7px; border-radius: 50%; background: #fff; opacity: 0.35; animation: aur-float-dot 1.4s ease-in-out infinite; }\n.aur-float-dots i:nth-child(2) { animation-delay: 0.18s; }\n.aur-float-dots i:nth-child(3) { animation-delay: 0.36s; }\n@keyframes aur-float-dot { 50% { opacity: 0.9; transform: translateY(-2px); } }\n.aur-float-actions {\nposition: absolute;\ntop: -12px;\nright: 10px;\ndisplay: flex;\ngap: 4px;\npadding: 3px;\nborder-radius: 99px;\nbackground: rgba(24, 24, 28, 0.95);\nborder: 1px solid rgba(255, 255, 255, 0.1);\nbox-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);\nopacity: 0;\ntransform: translateY(4px);\ntransition: opacity 0.2s ease, transform 0.25s ease;\npointer-events: none;\n}\n.aur-float:hover .aur-float-actions, .aur-float:focus-within .aur-float-actions { opacity: 1; transform: none; pointer-events: auto; }\n.aur-float-btn {\ndisplay: grid;\nplace-items: center;\nwidth: 28px;\nheight: 28px;\npadding: 0;\nborder: 0;\nborder-radius: 50%;\nbackground: transparent;\ncolor: rgba(255, 255, 255, 0.75);\ncursor: pointer;\n}\n.aur-float-btn:hover { background: rgba(255, 255, 255, 0.12); color: #fff; }\n.aur-float-btn[hidden] { display: none; }\n.aur-float-btn svg { width: 16px; height: 16px; }\n.aur-float-pip-body { margin: 0; overflow: hidden; background: #0e0e12; }\n.aur-float.is-pip { position: static; width: 100vw; height: 100vh; min-height: 0; border: 0; border-radius: 0; padding: 12px 18px 12px 12px; box-shadow: none; cursor: default; }\n.aur-float.is-pip .aur-float-art { width: min(64px, calc(100vh - 24px)); height: min(64px, calc(100vh - 24px)); }\n.aur-float.is-pip .aur-float-cur { font-size: clamp(16px, 6.5vw, 30px); }\n.aur-float.is-pip .aur-float-actions { top: 6px; right: 6px; }\n.aur-float.is-pip .is-pip-btn { display: none; }\n.aur-upnext {\nposition: absolute;\nright: var(--aur-pad);\nbottom: 116px;\nz-index: 3;\ndisplay: flex;\nalign-items: center;\ngap: 12px;\nmax-width: min(340px, calc(100vw - 32px));\npadding: 8px 12px 8px 8px;\nborder-radius: 16px;\nbackground: rgba(20, 20, 26, 0.55);\nborder: 1px solid rgba(255, 255, 255, 0.1);\nbox-shadow: 0 14px 40px rgba(0, 0, 0, 0.35);\nbackdrop-filter: blur(20px) saturate(1.4);\ncolor: #fff;\ntext-align: left;\nopacity: 0;\ntransform: translateY(14px) scale(0.97);\npointer-events: none;\ntransition: opacity 0.5s var(--aur-ease), transform 0.6s var(--aur-ease), bottom 0.65s var(--aur-ease), background 0.2s ease;\n}\n.aur-upnext.is-on { opacity: 1; transform: none; pointer-events: auto; }\n.aur-upnext:hover { background: rgba(38, 38, 46, 0.7); }\n.aur-root[data-transport=\"off\"] .aur-upnext,\n.aur-root[data-idle=\"true\"] .aur-upnext { bottom: 24px; }\n.aur-upnext-art { flex: none; width: 46px; height: 46px; border-radius: 9px; object-fit: cover; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4); }\n.aur-upnext-art[hidden] { display: none; }\n.aur-upnext-text { min-width: 0; flex: 1; }\n.aur-upnext-label { font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255, 255, 255, 0.55); }\n.aur-upnext-when { letter-spacing: 0.02em; text-transform: none; font-variant-numeric: tabular-nums; }\n.aur-upnext-title, .aur-upnext-artist { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.aur-upnext-title { margin-top: 1px; font-size: 14px; font-weight: 700; }\n.aur-upnext-artist { font-size: 12.5px; color: rgba(255, 255, 255, 0.62); }\n.aur-upnext-skip { flex: none; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: rgba(255, 255, 255, 0.1); opacity: 0.7; transition: opacity 0.2s ease, background 0.2s ease; }\n.aur-upnext-skip svg { width: 14px; height: 14px; }\n.aur-upnext:hover .aur-upnext-skip { opacity: 1; background: rgba(255, 255, 255, 0.2); }\n.aur-root[data-motion=\"reduced\"] .aur-upnext { transition: opacity 0.3s ease; transform: none; }\n.aur-link { display: inline; padding: 0; border: 0; background: none; font: inherit; color: inherit; cursor: pointer; text-decoration: underline transparent 1px; text-underline-offset: 3px; transition: color 0.2s ease, text-decoration-color 0.2s ease; }\n.aur-link:hover, .aur-link:focus-visible { color: #fff; text-decoration-color: currentColor; outline: none; }\n.aur-topbar-btn {\n--aur-pb-c: #b98cff;\nposition: relative;\ndisplay: inline-grid !important;\nplace-items: center;\nwidth: 44px !important;\nheight: 44px !important;\nmin-width: 44px;\nmargin-inline: 8px;\npadding: 0 !important;\nborder: 0;\nborder-radius: 14px !important;\noverflow: hidden;\ncursor: pointer;\n}\n.aur-topbar-btn svg { position: relative; width: 20px; height: 20px; }\n.aur-root[data-tabs=\"off\"] .aur-tabs-btn { display: none; }\n.aur-tabs-pop {\nposition: absolute;\nright: var(--aur-pad);\nbottom: 96px;\nz-index: 5;\nwidth: min(300px, calc(100vw - 32px));\npadding: 14px;\nborder-radius: 18px;\nbackground: linear-gradient(180deg, rgba(34, 34, 40, 0.94), rgba(18, 18, 22, 0.96));\nborder: 1px solid rgba(255, 255, 255, 0.1);\nbox-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);\nbackdrop-filter: blur(20px);\nopacity: 0;\ntransform: translateY(10px) scale(0.97);\ntransform-origin: 85% 100%;\ntransition: opacity 0.22s ease, transform 0.3s var(--aur-ease);\n}\n.aur-tabs-pop[hidden] { display: none; }\n.aur-tabs-pop.is-open { opacity: 1; transform: none; }\n.aur-tabs-head { display: flex; align-items: center; gap: 10px; min-width: 0; }\n.aur-tabs-logo { flex: none; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; background: rgba(255, 255, 255, 0.08); color: #fff; }\n.aur-tabs-logo svg { width: 18px; height: 18px; }\n.aur-tabs-head > div { min-width: 0; }\n.aur-tabs-kicker { font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255, 255, 255, 0.5); }\n.aur-tabs-song { font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.aur-tabs-status { margin-top: 12px; font-size: 13px; color: rgba(255, 255, 255, 0.65); }\n.aur-tabs-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }\n.aur-tabs-chip { padding: 4px 10px; border-radius: 99px; background: rgba(255, 255, 255, 0.09); font-size: 12px; font-weight: 600; }\n.aur-tabs-diff { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 12px; color: rgba(255, 255, 255, 0.6); }\n.aur-tabs-dots { display: inline-flex; gap: 3px; }\n.aur-tabs-dots i { width: 7px; height: 7px; border-radius: 50%; background: rgba(255, 255, 255, 0.18); }\n.aur-tabs-dots i:nth-child(-n + 1) { background: var(--aur-green); }\n.aur-tabs-dots[style*=\"--d:2\"] i:nth-child(-n + 2),\n.aur-tabs-dots[style*=\"--d:3\"] i:nth-child(-n + 3),\n.aur-tabs-dots[style*=\"--d:4\"] i:nth-child(-n + 4),\n.aur-tabs-dots[style*=\"--d:5\"] i:nth-child(-n + 5) { background: var(--aur-green); }\n.aur-tabs-actions { display: flex; gap: 8px; margin-top: 14px; }\n.aur-tabs-actions .aur-btn { flex: 1; justify-content: center; }\n.aur-fx { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }\n.aur-fx > i { position: absolute; display: none; }\n.aur-root[data-bganim=\"off\"] .aur-fx > i,\n.aur-root[data-bganim=\"off\"] .aur-fx > i::before,\n.aur-root[data-bganim=\"off\"] .aur-fx > i::after,\n.aur-root[data-bganim=\"off\"] .aur-fx-e > i,\n.aur-root[data-bganim=\"off\"] .aur-fx-e > i::before,\n.aur-root[data-bganim=\"off\"] .aur-fx-e > i::after,\n.aur-root[data-bganim=\"off\"] .aur-fx::before,\n.aur-root[data-bganim=\"off\"] .aur-fx::after { animation-play-state: paused; }\n@keyframes aur-fx-pulse { 50% { opacity: 0.6; } }\n@keyframes aur-fx-breathe { 50% { transform: scale(1.12); opacity: 0.7; } }\n.aur-root[data-fx=\"aurora\"] .aur-fx {\nbackground:\nradial-gradient(80% 34% at 50% 100%, rgba(60, 255, 170, 0.2), rgba(40, 200, 170, 0.07) 55%, transparent 80%),\nlinear-gradient(to bottom, rgba(6, 14, 34, 0.8), rgba(9, 24, 46, 0.7) 40%, rgba(12, 36, 58, 0.6) 70%, rgba(14, 44, 62, 0.5) 100%);\n}\n.aur-root[data-fx=\"aurora\"] .aur-fx::before {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground:\nradial-gradient(1.2px 1.2px at 85.0% 54.9%, rgba(235, 255, 245, 0.68), transparent),\nradial-gradient(1.5px 1.5px at 19.1% 36.3%, rgba(255, 255, 255, 0.76), transparent),\nradial-gradient(1px 1px at 44.8% 10.8%, rgba(255, 255, 255, 0.72), transparent),\nradial-gradient(0.8px 0.8px at 97.3% 67.6%, rgba(235, 255, 245, 0.78), transparent),\nradial-gradient(1.5px 1.5px at 16.4% 2.0%, rgba(235, 255, 245, 0.71), transparent),\nradial-gradient(0.8px 0.8px at 19.6% 17.7%, rgba(255, 255, 255, 0.47), transparent),\nradial-gradient(1.2px 1.2px at 44.2% 59.1%, rgba(220, 235, 255, 0.71), transparent),\nradial-gradient(1px 1px at 1.5% 6.9%, rgba(220, 235, 255, 0.78), transparent),\nradial-gradient(1.2px 1.2px at 98.6% 59.0%, rgba(235, 255, 245, 0.80), transparent),\nradial-gradient(1px 1px at 51.3% 3.1%, rgba(255, 255, 255, 0.73), transparent),\nradial-gradient(0.8px 0.8px at 11.6% 21.1%, rgba(220, 235, 255, 0.48), transparent),\nradial-gradient(0.8px 0.8px at 1.1% 15.5%, rgba(235, 255, 245, 0.91), transparent),\nradial-gradient(1.2px 1.2px at 97.1% 28.4%, rgba(220, 235, 255, 0.49), transparent),\nradial-gradient(1px 1px at 27.4% 7.0%, rgba(235, 255, 245, 0.62), transparent),\nradial-gradient(1.2px 1.2px at 14.2% 49.8%, rgba(255, 255, 255, 0.46), transparent),\nradial-gradient(1.2px 1.2px at 18.4% 39.6%, rgba(220, 235, 255, 0.67), transparent),\nradial-gradient(1px 1px at 76.4% 29.9%, rgba(235, 255, 245, 0.64), transparent),\nradial-gradient(1.2px 1.2px at 98.0% 1.0%, rgba(220, 235, 255, 0.88), transparent),\nradial-gradient(1.5px 1.5px at 98.8% 2.4%, rgba(220, 235, 255, 0.54), transparent),\nradial-gradient(1.5px 1.5px at 57.5% 3.9%, rgba(235, 255, 245, 0.52), transparent),\nradial-gradient(1.2px 1.2px at 1.9% 43.1%, rgba(220, 235, 255, 0.87), transparent),\nradial-gradient(1.2px 1.2px at 8.3% 15.4%, rgba(255, 255, 255, 0.77), transparent),\nradial-gradient(0.8px 0.8px at 37.1% 43.9%, rgba(235, 255, 245, 0.51), transparent),\nradial-gradient(1.5px 1.5px at 82.6% 10.4%, rgba(220, 235, 255, 0.64), transparent),\nradial-gradient(1px 1px at 90.0% 57.4%, rgba(220, 235, 255, 0.57), transparent),\nradial-gradient(1px 1px at 73.5% 65.9%, rgba(255, 255, 255, 0.55), transparent),\nradial-gradient(1.2px 1.2px at 60.1% 30.1%, rgba(220, 235, 255, 0.50), transparent),\nradial-gradient(0.8px 0.8px at 95.3% 17.5%, rgba(235, 255, 245, 0.80), transparent),\nradial-gradient(1px 1px at 81.7% 42.2%, rgba(220, 235, 255, 0.60), transparent),\nradial-gradient(1px 1px at 96.8% 9.7%, rgba(235, 255, 245, 0.69), transparent),\nradial-gradient(1.5px 1.5px at 8.3% 15.7%, rgba(235, 255, 245, 0.91), transparent),\nradial-gradient(0.8px 0.8px at 27.4% 31.8%, rgba(255, 255, 255, 0.48), transparent),\nradial-gradient(1px 1px at 37.1% 40.5%, rgba(220, 235, 255, 0.52), transparent),\nradial-gradient(1px 1px at 88.3% 68.7%, rgba(255, 255, 255, 0.78), transparent),\nradial-gradient(1.5px 1.5px at 93.8% 41.7%, rgba(235, 255, 245, 0.91), transparent),\nradial-gradient(1.2px 1.2px at 69.7% 67.4%, rgba(220, 235, 255, 0.46), transparent),\nradial-gradient(0.8px 0.8px at 7.6% 22.5%, rgba(220, 235, 255, 0.52), transparent),\nradial-gradient(0.8px 0.8px at 45.4% 26.4%, rgba(255, 255, 255, 0.47), transparent),\nradial-gradient(1px 1px at 35.5% 48.3%, rgba(220, 235, 255, 0.90), transparent),\nradial-gradient(1.2px 1.2px at 85.6% 40.5%, rgba(255, 255, 255, 0.76), transparent);\n-webkit-mask-image: linear-gradient(#000 35%, transparent 80%);\nmask-image: linear-gradient(#000 35%, transparent 80%);\nopacity: 0.8;\nanimation: aur-au-twinkle 8s steps(48) infinite alternate;\n}\n@keyframes aur-au-twinkle { from { opacity: 0.55; } to { opacity: 0.9; } }\n.aur-root[data-fx=\"aurora\"] .aur-fx-a {\ndisplay: block;\nleft: -8%;\nright: -8%;\ntop: -4%;\nheight: 92%;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2400 1000' preserveAspectRatio='none'%3E%3Cdefs%3E%3ClinearGradient id='c' gradientUnits='userSpaceOnUse' x1='0' y1='0' x2='0' y2='1000'%3E%3Cstop offset='0.181' stop-color='%23c455ff'/%3E%3Cstop offset='0.390' stop-color='%237f70ff'/%3E%3Cstop offset='0.626' stop-color='%2326e6b4'/%3E%3Cstop offset='0.807' stop-color='%2357ffbd'/%3E%3Cstop offset='0.876' stop-color='%23e4fff4'/%3E%3C/linearGradient%3E%3ClinearGradient id='g' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%23000'/%3E%3Cstop offset='.4' stop-color='%23fff' stop-opacity='.14'/%3E%3Cstop offset='.7' stop-color='%23fff' stop-opacity='.55'/%3E%3Cstop offset='.86' stop-color='%23fff'/%3E%3Cstop offset='.93' stop-color='%23fff' stop-opacity='.85'/%3E%3Cstop offset='1' stop-color='%23000'/%3E%3C/linearGradient%3E%3Cmask id='f' maskContentUnits='objectBoundingBox'%3E%3Crect width='1' height='1' fill='url(%23g)'/%3E%3C/mask%3E%3ClinearGradient id='s'%3E%3Cstop offset='0' stop-color='%23000'/%3E%3Cstop offset='.5' stop-color='%23fff'/%3E%3Cstop offset='1' stop-color='%23000'/%3E%3C/linearGradient%3E%3Cpattern id='r' width='1200' height='1000' patternUnits='userSpaceOnUse'%3E%3Cg fill='url(%23s)'%3E%3Crect x='0' width='16' height='1000' opacity='0.75'/%3E%3Crect x='31' width='27' height='1000' opacity='0.91'/%3E%3Crect x='58' width='35' height='1000' opacity='0.84'/%3E%3Crect x='115' width='34' height='1000' opacity='0.62'/%3E%3Crect x='146' width='7' height='1000' opacity='0.82'/%3E%3Crect x='160' width='6' height='1000' opacity='0.84'/%3E%3Crect x='169' width='23' height='1000' opacity='1.00'/%3E%3Crect x='212' width='12' height='1000' opacity='0.56'/%3E%3Crect x='231' width='5' height='1000' opacity='0.98'/%3E%3Crect x='240' width='11' height='1000' opacity='0.72'/%3E%3Crect x='259' width='21' height='1000' opacity='0.67'/%3E%3Crect x='280' width='6' height='1000' opacity='0.61'/%3E%3Crect x='291' width='28' height='1000' opacity='0.80'/%3E%3Crect x='331' width='19' height='1000' opacity='0.72'/%3E%3Crect x='357' width='37' height='1000' opacity='0.69'/%3E%3Crect x='429' width='37' height='1000' opacity='0.81'/%3E%3Crect x='464' width='16' height='1000' opacity='0.70'/%3E%3Crect x='484' width='4' height='1000' opacity='0.56'/%3E%3Crect x='490' width='30' height='1000' opacity='0.61'/%3E%3Crect x='531' width='21' height='1000' opacity='0.66'/%3E%3Crect x='555' width='21' height='1000' opacity='0.95'/%3E%3Crect x='590' width='9' height='1000' opacity='0.66'/%3E%3Crect x='606' width='20' height='1000' opacity='0.78'/%3E%3Crect x='645' width='28' height='1000' opacity='0.93'/%3E%3Crect x='690' width='6' height='1000' opacity='0.58'/%3E%3Crect x='698' width='23' height='1000' opacity='0.81'/%3E%3Crect x='722' width='40' height='1000' opacity='0.88'/%3E%3Crect x='783' width='16' height='1000' opacity='0.96'/%3E%3Crect x='811' width='8' height='1000' opacity='0.58'/%3E%3Crect x='822' width='9' height='1000' opacity='0.88'/%3E%3Crect x='840' width='18' height='1000' opacity='0.71'/%3E%3Crect x='870' width='9' height='1000' opacity='0.94'/%3E%3Crect x='885' width='30' height='1000' opacity='0.58'/%3E%3Crect x='915' width='12' height='1000' opacity='0.72'/%3E%3Crect x='936' width='7' height='1000' opacity='0.78'/%3E%3Crect x='947' width='17' height='1000' opacity='0.60'/%3E%3Crect x='978' width='15' height='1000' opacity='0.69'/%3E%3Crect x='1003' width='38' height='1000' opacity='0.97'/%3E%3Crect x='1060' width='22' height='1000' opacity='0.74'/%3E%3Crect x='1101' width='25' height='1000' opacity='0.96'/%3E%3Crect x='1130' width='5' height='1000' opacity='0.87'/%3E%3Crect x='1140' width='10' height='1000' opacity='0.97'/%3E%3Crect x='1159' width='32' height='1000' opacity='0.93'/%3E%3C/g%3E%3C/pattern%3E%3Cmask id='rm' maskUnits='userSpaceOnUse' x='0' y='0' width='2400' height='1000'%3E%3Crect width='2400' height='1000' fill='url(%23r)'/%3E%3C/mask%3E%3Cg id='sl' fill='url(%23c)'%3E%3Cpath d='M0 863L25 864 25 432 0 431Z' opacity='0.76' mask='url(%23f)'/%3E%3Cpath d='M24 864L49 861 49 428 24 432Z' opacity='0.76' mask='url(%23f)'/%3E%3Cpath d='M48 861L73 854 73 419 48 428Z' opacity='0.76' mask='url(%23f)'/%3E%3Cpath d='M72 854L97 846 97 409 72 419Z' opacity='0.77' mask='url(%23f)'/%3E%3Cpath d='M96 846L121 837 121 398 96 409Z' opacity='0.77' mask='url(%23f)'/%3E%3Cpath d='M120 837L145 827 145 385 120 398Z' opacity='0.78' mask='url(%23f)'/%3E%3Cpath d='M144 827L169 816 169 370 144 385Z' opacity='0.78' mask='url(%23f)'/%3E%3Cpath d='M168 816L193 801 193 353 168 370Z' opacity='0.79' mask='url(%23f)'/%3E%3Cpath d='M192 801L217 783 217 332 192 353Z' opacity='0.79' mask='url(%23f)'/%3E%3Cpath d='M216 783L241 763 241 309 216 332Z' opacity='0.79' mask='url(%23f)'/%3E%3Cpath d='M240 763L265 742 265 286 240 309Z' opacity='0.78' mask='url(%23f)'/%3E%3Cpath d='M264 742L289 724 289 266 264 286Z' opacity='0.75' mask='url(%23f)'/%3E%3Cpath d='M288 724L313 711 313 252 288 266Z' opacity='0.71' mask='url(%23f)'/%3E%3Cpath d='M312 711L337 705 337 246 312 252Z' opacity='0.65' mask='url(%23f)'/%3E%3Cpath d='M336 705L361 707 361 247 336 246Z' opacity='0.59' mask='url(%23f)'/%3E%3Cpath d='M360 707L385 714 385 254 360 247Z' opacity='0.54' mask='url(%23f)'/%3E%3Cpath d='M384 714L409 725 409 264 384 254Z' opacity='0.50' mask='url(%23f)'/%3E%3Cpath d='M408 725L433 734 433 273 408 264Z' opacity='0.48' mask='url(%23f)'/%3E%3Cpath d='M432 734L457 741 457 278 432 273Z' opacity='0.47' mask='url(%23f)'/%3E%3Cpath d='M456 741L481 742 481 278 456 278Z' opacity='0.46' mask='url(%23f)'/%3E%3Cpath d='M480 742L505 737 505 272 480 278Z' opacity='0.45' mask='url(%23f)'/%3E%3Cpath d='M504 737L529 729 529 263 504 272Z' opacity='0.43' mask='url(%23f)'/%3E%3Cpath d='M528 729L553 720 553 252 528 263Z' opacity='0.40' mask='url(%23f)'/%3E%3Cpath d='M552 720L577 712 577 243 552 252Z' opacity='0.37' mask='url(%23f)'/%3E%3Cpath d='M576 712L601 708 601 238 576 243Z' opacity='0.35' mask='url(%23f)'/%3E%3Cpath d='M600 708L625 708 625 237 600 238Z' opacity='0.33' mask='url(%23f)'/%3E%3Cpath d='M624 708L649 712 649 240 624 237Z' opacity='0.32' mask='url(%23f)'/%3E%3Cpath d='M648 712L673 718 673 246 648 240Z' opacity='0.31' mask='url(%23f)'/%3E%3Cpath d='M672 718L697 726 697 254 672 246Z' opacity='0.31' mask='url(%23f)'/%3E%3Cpath d='M696 726L721 733 721 261 696 254Z' opacity='0.30' mask='url(%23f)'/%3E%3Cpath d='M720 733L745 741 745 267 720 261Z' opacity='0.28' mask='url(%23f)'/%3E%3Cpath d='M744 741L769 751 769 274 744 267Z' opacity='0.26' mask='url(%23f)'/%3E%3Cpath d='M768 751L793 762 793 283 768 274Z' opacity='0.25' mask='url(%23f)'/%3E%3Cpath d='M792 762L817 777 817 294 792 283Z' opacity='0.23' mask='url(%23f)'/%3E%3Cpath d='M816 777L841 797 841 310 816 294Z' opacity='0.22' mask='url(%23f)'/%3E%3Cpath d='M840 797L865 818 865 328 840 310Z' opacity='0.22' mask='url(%23f)'/%3E%3Cpath d='M864 818L889 840 889 346 864 328Z' opacity='0.22' mask='url(%23f)'/%3E%3Cpath d='M888 840L913 859 913 362 888 346Z' opacity='0.22' mask='url(%23f)'/%3E%3Cpath d='M912 859L937 872 937 371 912 362Z' opacity='0.23' mask='url(%23f)'/%3E%3Cpath d='M936 872L961 876 961 373 936 371Z' opacity='0.25' mask='url(%23f)'/%3E%3Cpath d='M960 876L985 871 985 366 960 373Z' opacity='0.29' mask='url(%23f)'/%3E%3Cpath d='M984 871L1009 859 1009 353 984 366Z' opacity='0.36' mask='url(%23f)'/%3E%3Cpath d='M1008 859L1033 842 1033 335 1008 353Z' opacity='0.44' mask='url(%23f)'/%3E%3Cpath d='M1032 842L1057 824 1057 318 1032 335Z' opacity='0.52' mask='url(%23f)'/%3E%3Cpath d='M1056 824L1081 808 1081 304 1056 318Z' opacity='0.58' mask='url(%23f)'/%3E%3Cpath d='M1080 808L1105 795 1105 294 1080 304Z' opacity='0.62' mask='url(%23f)'/%3E%3Cpath d='M1104 795L1129 788 1129 290 1104 294Z' opacity='0.62' mask='url(%23f)'/%3E%3Cpath d='M1128 788L1153 783 1153 290 1128 290Z' opacity='0.61' mask='url(%23f)'/%3E%3Cpath d='M1152 783L1177 781 1177 293 1152 290Z' opacity='0.59' mask='url(%23f)'/%3E%3Cpath d='M1176 781L1201 778 1201 295 1176 293Z' opacity='0.56' mask='url(%23f)'/%3E%3Cpath d='M1200 778L1225 774 1225 296 1200 295Z' opacity='0.53' mask='url(%23f)'/%3E%3Cpath d='M1224 774L1249 768 1249 295 1224 296Z' opacity='0.51' mask='url(%23f)'/%3E%3Cpath d='M1248 768L1273 762 1273 293 1248 295Z' opacity='0.48' mask='url(%23f)'/%3E%3Cpath d='M1272 762L1297 756 1297 291 1272 293Z' opacity='0.46' mask='url(%23f)'/%3E%3Cpath d='M1296 756L1321 752 1321 290 1296 291Z' opacity='0.45' mask='url(%23f)'/%3E%3Cpath d='M1320 752L1345 750 1345 290 1320 290Z' opacity='0.45' mask='url(%23f)'/%3E%3Cpath d='M1344 750L1369 749 1369 290 1344 290Z' opacity='0.47' mask='url(%23f)'/%3E%3Cpath d='M1368 749L1393 749 1393 289 1368 290Z' opacity='0.49' mask='url(%23f)'/%3E%3Cpath d='M1392 749L1417 745 1417 284 1392 289Z' opacity='0.53' mask='url(%23f)'/%3E%3Cpath d='M1416 745L1441 738 1441 274 1416 284Z' opacity='0.57' mask='url(%23f)'/%3E%3Cpath d='M1440 738L1465 726 1465 259 1440 274Z' opacity='0.62' mask='url(%23f)'/%3E%3Cpath d='M1464 726L1489 710 1489 240 1464 259Z' opacity='0.66' mask='url(%23f)'/%3E%3Cpath d='M1488 710L1513 693 1513 219 1488 240Z' opacity='0.70' mask='url(%23f)'/%3E%3Cpath d='M1512 693L1537 679 1537 200 1512 219Z' opacity='0.72' mask='url(%23f)'/%3E%3Cpath d='M1536 679L1561 670 1561 186 1536 200Z' opacity='0.72' mask='url(%23f)'/%3E%3Cpath d='M1560 670L1585 670 1585 181 1560 186Z' opacity='0.70' mask='url(%23f)'/%3E%3Cpath d='M1584 670L1609 678 1609 186 1584 181Z' opacity='0.66' mask='url(%23f)'/%3E%3Cpath d='M1608 678L1633 694 1633 198 1608 186Z' opacity='0.60' mask='url(%23f)'/%3E%3Cpath d='M1632 694L1657 715 1657 216 1632 198Z' opacity='0.54' mask='url(%23f)'/%3E%3Cpath d='M1656 715L1681 737 1681 237 1656 216Z' opacity='0.49' mask='url(%23f)'/%3E%3Cpath d='M1680 737L1705 759 1705 257 1680 237Z' opacity='0.44' mask='url(%23f)'/%3E%3Cpath d='M1704 759L1729 777 1729 276 1704 257Z' opacity='0.40' mask='url(%23f)'/%3E%3Cpath d='M1728 777L1753 791 1753 296 1728 276Z' opacity='0.39' mask='url(%23f)'/%3E%3Cpath d='M1752 791L1777 802 1777 317 1752 296Z' opacity='0.38' mask='url(%23f)'/%3E%3Cpath d='M1776 802L1801 812 1801 340 1776 317Z' opacity='0.39' mask='url(%23f)'/%3E%3Cpath d='M1800 812L1825 820 1825 367 1800 340Z' opacity='0.42' mask='url(%23f)'/%3E%3Cpath d='M1824 820L1849 828 1849 396 1824 367Z' opacity='0.47' mask='url(%23f)'/%3E%3Cpath d='M1848 828L1873 835 1873 425 1848 396Z' opacity='0.52' mask='url(%23f)'/%3E%3Cpath d='M1872 835L1897 840 1897 453 1872 425Z' opacity='0.58' mask='url(%23f)'/%3E%3Cpath d='M1896 840L1921 842 1921 477 1896 453Z' opacity='0.64' mask='url(%23f)'/%3E%3Cpath d='M1920 842L1945 838 1945 494 1920 477Z' opacity='0.69' mask='url(%23f)'/%3E%3Cpath d='M1944 838L1969 830 1969 504 1944 494Z' opacity='0.73' mask='url(%23f)'/%3E%3Cpath d='M1968 830L1993 819 1993 508 1968 504Z' opacity='0.73' mask='url(%23f)'/%3E%3Cpath d='M1992 819L2017 807 2017 507 1992 508Z' opacity='0.71' mask='url(%23f)'/%3E%3Cpath d='M2016 807L2041 798 2041 504 2016 507Z' opacity='0.66' mask='url(%23f)'/%3E%3Cpath d='M2040 798L2065 793 2065 500 2040 504Z' opacity='0.60' mask='url(%23f)'/%3E%3Cpath d='M2064 793L2089 794 2089 499 2064 500Z' opacity='0.52' mask='url(%23f)'/%3E%3Cpath d='M2088 794L2113 800 2113 501 2088 499Z' opacity='0.45' mask='url(%23f)'/%3E%3Cpath d='M2112 800L2137 809 2137 504 2112 501Z' opacity='0.39' mask='url(%23f)'/%3E%3Cpath d='M2136 809L2161 818 2161 504 2136 504Z' opacity='0.35' mask='url(%23f)'/%3E%3Cpath d='M2160 818L2185 822 2185 499 2160 504Z' opacity='0.32' mask='url(%23f)'/%3E%3Cpath d='M2184 822L2209 821 2209 487 2184 499Z' opacity='0.32' mask='url(%23f)'/%3E%3Cpath d='M2208 821L2233 812 2233 467 2208 487Z' opacity='0.33' mask='url(%23f)'/%3E%3Cpath d='M2232 812L2257 798 2257 441 2232 467Z' opacity='0.36' mask='url(%23f)'/%3E%3Cpath d='M2256 798L2281 780 2281 413 2256 441Z' opacity='0.41' mask='url(%23f)'/%3E%3Cpath d='M2280 780L2305 760 2305 384 2280 413Z' opacity='0.47' mask='url(%23f)'/%3E%3Cpath d='M2304 760L2329 742 2329 358 2304 384Z' opacity='0.55' mask='url(%23f)'/%3E%3Cpath d='M2328 742L2353 727 2353 337 2328 358Z' opacity='0.63' mask='url(%23f)'/%3E%3Cpath d='M2352 727L2377 714 2377 321 2352 337Z' opacity='0.70' mask='url(%23f)'/%3E%3Cpath d='M2376 714L2401 704 2401 309 2376 321Z' opacity='0.75' mask='url(%23f)'/%3E%3C/g%3E%3C/defs%3E%3Cuse href='%23sl' opacity='.17'/%3E%3Cg mask='url(%23rm)'%3E%3Cuse href='%23sl'/%3E%3C/g%3E%3Cdefs%3E%3Cg id='hm'%3E%3Cpath d='M0 855L25 856' opacity='0.76'/%3E%3Cpath d='M24 856L49 853' opacity='0.76'/%3E%3Cpath d='M48 853L73 846' opacity='0.76'/%3E%3Cpath d='M72 846L97 838' opacity='0.77'/%3E%3Cpath d='M96 838L121 829' opacity='0.77'/%3E%3Cpath d='M120 829L145 819' opacity='0.78'/%3E%3Cpath d='M144 819L169 808' opacity='0.78'/%3E%3Cpath d='M168 808L193 793' opacity='0.79'/%3E%3Cpath d='M192 793L217 775' opacity='0.79'/%3E%3Cpath d='M216 775L241 755' opacity='0.79'/%3E%3Cpath d='M240 755L265 734' opacity='0.78'/%3E%3Cpath d='M264 734L289 716' opacity='0.75'/%3E%3Cpath d='M288 716L313 703' opacity='0.71'/%3E%3Cpath d='M312 703L337 697' opacity='0.65'/%3E%3Cpath d='M336 697L361 699' opacity='0.59'/%3E%3Cpath d='M360 699L385 706' opacity='0.54'/%3E%3Cpath d='M384 706L409 717' opacity='0.50'/%3E%3Cpath d='M408 717L433 726' opacity='0.48'/%3E%3Cpath d='M432 726L457 733' opacity='0.47'/%3E%3Cpath d='M456 733L481 734' opacity='0.46'/%3E%3Cpath d='M480 734L505 729' opacity='0.45'/%3E%3Cpath d='M504 729L529 721' opacity='0.43'/%3E%3Cpath d='M528 721L553 712' opacity='0.40'/%3E%3Cpath d='M552 712L577 704' opacity='0.37'/%3E%3Cpath d='M576 704L601 700' opacity='0.35'/%3E%3Cpath d='M600 700L625 700' opacity='0.33'/%3E%3Cpath d='M624 700L649 704' opacity='0.32'/%3E%3Cpath d='M648 704L673 710' opacity='0.31'/%3E%3Cpath d='M672 710L697 718' opacity='0.31'/%3E%3Cpath d='M696 718L721 725' opacity='0.30'/%3E%3Cpath d='M720 725L745 733' opacity='0.28'/%3E%3Cpath d='M744 733L769 743' opacity='0.26'/%3E%3Cpath d='M768 743L793 754' opacity='0.25'/%3E%3Cpath d='M792 754L817 769' opacity='0.23'/%3E%3Cpath d='M816 769L841 789' opacity='0.22'/%3E%3Cpath d='M840 789L865 810' opacity='0.22'/%3E%3Cpath d='M864 810L889 832' opacity='0.22'/%3E%3Cpath d='M888 832L913 851' opacity='0.22'/%3E%3Cpath d='M912 851L937 864' opacity='0.23'/%3E%3Cpath d='M936 864L961 868' opacity='0.25'/%3E%3Cpath d='M960 868L985 863' opacity='0.29'/%3E%3Cpath d='M984 863L1009 851' opacity='0.36'/%3E%3Cpath d='M1008 851L1033 834' opacity='0.44'/%3E%3Cpath d='M1032 834L1057 816' opacity='0.52'/%3E%3Cpath d='M1056 816L1081 800' opacity='0.58'/%3E%3Cpath d='M1080 800L1105 787' opacity='0.62'/%3E%3Cpath d='M1104 787L1129 780' opacity='0.62'/%3E%3Cpath d='M1128 780L1153 775' opacity='0.61'/%3E%3Cpath d='M1152 775L1177 773' opacity='0.59'/%3E%3Cpath d='M1176 773L1201 770' opacity='0.56'/%3E%3Cpath d='M1200 770L1225 766' opacity='0.53'/%3E%3Cpath d='M1224 766L1249 760' opacity='0.51'/%3E%3Cpath d='M1248 760L1273 754' opacity='0.48'/%3E%3Cpath d='M1272 754L1297 748' opacity='0.46'/%3E%3Cpath d='M1296 748L1321 744' opacity='0.45'/%3E%3Cpath d='M1320 744L1345 742' opacity='0.45'/%3E%3Cpath d='M1344 742L1369 741' opacity='0.47'/%3E%3Cpath d='M1368 741L1393 741' opacity='0.49'/%3E%3Cpath d='M1392 741L1417 737' opacity='0.53'/%3E%3Cpath d='M1416 737L1441 730' opacity='0.57'/%3E%3Cpath d='M1440 730L1465 718' opacity='0.62'/%3E%3Cpath d='M1464 718L1489 702' opacity='0.66'/%3E%3Cpath d='M1488 702L1513 685' opacity='0.70'/%3E%3Cpath d='M1512 685L1537 671' opacity='0.72'/%3E%3Cpath d='M1536 671L1561 662' opacity='0.72'/%3E%3Cpath d='M1560 662L1585 662' opacity='0.70'/%3E%3Cpath d='M1584 662L1609 670' opacity='0.66'/%3E%3Cpath d='M1608 670L1633 686' opacity='0.60'/%3E%3Cpath d='M1632 686L1657 707' opacity='0.54'/%3E%3Cpath d='M1656 707L1681 729' opacity='0.49'/%3E%3Cpath d='M1680 729L1705 751' opacity='0.44'/%3E%3Cpath d='M1704 751L1729 769' opacity='0.40'/%3E%3Cpath d='M1728 769L1753 783' opacity='0.39'/%3E%3Cpath d='M1752 783L1777 794' opacity='0.38'/%3E%3Cpath d='M1776 794L1801 804' opacity='0.39'/%3E%3Cpath d='M1800 804L1825 812' opacity='0.42'/%3E%3Cpath d='M1824 812L1849 820' opacity='0.47'/%3E%3Cpath d='M1848 820L1873 827' opacity='0.52'/%3E%3Cpath d='M1872 827L1897 832' opacity='0.58'/%3E%3Cpath d='M1896 832L1921 834' opacity='0.64'/%3E%3Cpath d='M1920 834L1945 830' opacity='0.69'/%3E%3Cpath d='M1944 830L1969 822' opacity='0.73'/%3E%3Cpath d='M1968 822L1993 811' opacity='0.73'/%3E%3Cpath d='M1992 811L2017 799' opacity='0.71'/%3E%3Cpath d='M2016 799L2041 790' opacity='0.66'/%3E%3Cpath d='M2040 790L2065 785' opacity='0.60'/%3E%3Cpath d='M2064 785L2089 786' opacity='0.52'/%3E%3Cpath d='M2088 786L2113 792' opacity='0.45'/%3E%3Cpath d='M2112 792L2137 801' opacity='0.39'/%3E%3Cpath d='M2136 801L2161 810' opacity='0.35'/%3E%3Cpath d='M2160 810L2185 814' opacity='0.32'/%3E%3Cpath d='M2184 814L2209 813' opacity='0.32'/%3E%3Cpath d='M2208 813L2233 804' opacity='0.33'/%3E%3Cpath d='M2232 804L2257 790' opacity='0.36'/%3E%3Cpath d='M2256 790L2281 772' opacity='0.41'/%3E%3Cpath d='M2280 772L2305 752' opacity='0.47'/%3E%3Cpath d='M2304 752L2329 734' opacity='0.55'/%3E%3Cpath d='M2328 734L2353 719' opacity='0.63'/%3E%3Cpath d='M2352 719L2377 706' opacity='0.70'/%3E%3Cpath d='M2376 706L2401 696' opacity='0.75'/%3E%3C/g%3E%3C/defs%3E%3Cg fill='none' stroke='%2357ffbd' stroke-linecap='round'%3E%3Cuse href='%23hm' stroke-width='40' opacity='.06'/%3E%3Cuse href='%23hm' stroke-width='14' opacity='.12'/%3E%3C/g%3E%3C/svg%3E\") center / 100% 100% no-repeat;\ntransform-origin: 50% 80%;\nopacity: 0.9;\ntransition: opacity 3s ease;\nanimation: aur-au-sway 30s steps(900) infinite alternate;\n}\n.aur-root[data-fx=\"aurora\"][data-gap=\"on\"] .aur-fx-a { opacity: 1; }\n.aur-root[data-fx=\"aurora\"][data-bganim=\"on\"][data-lb=\"a\"] .aur-fx-a { animation: aur-au-sway 30s steps(900) infinite alternate, aur-au-flare-a 2.6s ease-out; }\n.aur-root[data-fx=\"aurora\"][data-bganim=\"on\"][data-lb=\"b\"] .aur-fx-a { animation: aur-au-sway 30s steps(900) infinite alternate, aur-au-flare-b 2.6s ease-out; }\n@keyframes aur-au-sway {\n0% { transform: translate3d(-2.5%, 0, 0) skewX(-5deg) scaleY(0.96); }\n50% { transform: translate3d(0.5%, -1%, 0) skewX(1deg) scaleY(1.04); }\n100% { transform: translate3d(3%, 0.5%, 0) skewX(5deg) scaleY(0.98); }\n}\n@keyframes aur-au-flare-a { from { opacity: 1; } }\n@keyframes aur-au-flare-b { from { opacity: 1; } }\n.aur-root[data-fx=\"aurora\"] .aur-fx-a::after {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2400 1000' preserveAspectRatio='none'%3E%3Cdefs%3E%3ClinearGradient id='c' gradientUnits='userSpaceOnUse' x1='0' y1='0' x2='0' y2='1000'%3E%3Cstop offset='0.181' stop-color='%23c455ff'/%3E%3Cstop offset='0.390' stop-color='%237f70ff'/%3E%3Cstop offset='0.626' stop-color='%2326e6b4'/%3E%3Cstop offset='0.807' stop-color='%2357ffbd'/%3E%3Cstop offset='0.876' stop-color='%23e4fff4'/%3E%3C/linearGradient%3E%3ClinearGradient id='g' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%23000'/%3E%3Cstop offset='.4' stop-color='%23fff' stop-opacity='.14'/%3E%3Cstop offset='.7' stop-color='%23fff' stop-opacity='.55'/%3E%3Cstop offset='.86' stop-color='%23fff'/%3E%3Cstop offset='.93' stop-color='%23fff' stop-opacity='.85'/%3E%3Cstop offset='1' stop-color='%23000'/%3E%3C/linearGradient%3E%3Cmask id='f' maskContentUnits='objectBoundingBox'%3E%3Crect width='1' height='1' fill='url(%23g)'/%3E%3C/mask%3E%3ClinearGradient id='s'%3E%3Cstop offset='0' stop-color='%23000'/%3E%3Cstop offset='.5' stop-color='%23fff'/%3E%3Cstop offset='1' stop-color='%23000'/%3E%3C/linearGradient%3E%3Cpattern id='r' width='1200' height='1000' patternUnits='userSpaceOnUse'%3E%3Cg fill='url(%23s)'%3E%3Crect x='0' width='6' height='1000' opacity='0.61'/%3E%3Crect x='6' width='8' height='1000' opacity='0.97'/%3E%3Crect x='19' width='17' height='1000' opacity='0.92'/%3E%3Crect x='51' width='20' height='1000' opacity='0.70'/%3E%3Crect x='92' width='19' height='1000' opacity='0.57'/%3E%3Crect x='122' width='7' height='1000' opacity='0.76'/%3E%3Crect x='135' width='8' height='1000' opacity='0.98'/%3E%3Crect x='148' width='8' height='1000' opacity='0.97'/%3E%3Crect x='163' width='8' height='1000' opacity='0.59'/%3E%3Crect x='174' width='12' height='1000' opacity='0.61'/%3E%3Crect x='191' width='22' height='1000' opacity='0.67'/%3E%3Crect x='221' width='9' height='1000' opacity='0.61'/%3E%3Crect x='238' width='18' height='1000' opacity='0.61'/%3E%3Crect x='257' width='6' height='1000' opacity='0.95'/%3E%3Crect x='265' width='11' height='1000' opacity='0.63'/%3E%3Crect x='276' width='6' height='1000' opacity='0.72'/%3E%3Crect x='283' width='36' height='1000' opacity='0.59'/%3E%3Crect x='353' width='18' height='1000' opacity='0.65'/%3E%3Crect x='388' width='19' height='1000' opacity='0.87'/%3E%3Crect x='409' width='17' height='1000' opacity='0.75'/%3E%3Crect x='445' width='9' height='1000' opacity='0.78'/%3E%3Crect x='463' width='19' height='1000' opacity='0.74'/%3E%3Crect x='487' width='20' height='1000' opacity='0.86'/%3E%3Crect x='519' width='17' height='1000' opacity='0.70'/%3E%3Crect x='539' width='4' height='1000' opacity='0.95'/%3E%3Crect x='546' width='26' height='1000' opacity='0.65'/%3E%3Crect x='596' width='19' height='1000' opacity='0.64'/%3E%3Crect x='624' width='40' height='1000' opacity='0.90'/%3E%3Crect x='681' width='18' height='1000' opacity='0.80'/%3E%3Crect x='712' width='20' height='1000' opacity='0.64'/%3E%3Crect x='730' width='5' height='1000' opacity='0.74'/%3E%3Crect x='736' width='21' height='1000' opacity='0.64'/%3E%3Crect x='758' width='14' height='1000' opacity='0.76'/%3E%3Crect x='772' width='36' height='1000' opacity='0.73'/%3E%3Crect x='829' width='13' height='1000' opacity='0.81'/%3E%3Crect x='855' width='20' height='1000' opacity='0.81'/%3E%3Crect x='887' width='40' height='1000' opacity='0.66'/%3E%3Crect x='945' width='13' height='1000' opacity='0.84'/%3E%3Crect x='956' width='12' height='1000' opacity='0.74'/%3E%3Crect x='969' width='9' height='1000' opacity='0.78'/%3E%3Crect x='983' width='20' height='1000' opacity='0.65'/%3E%3Crect x='1005' width='7' height='1000' opacity='0.80'/%3E%3Crect x='1013' width='32' height='1000' opacity='0.59'/%3E%3Crect x='1067' width='8' height='1000' opacity='0.56'/%3E%3Crect x='1080' width='6' height='1000' opacity='0.83'/%3E%3Crect x='1091' width='13' height='1000' opacity='0.91'/%3E%3Crect x='1109' width='20' height='1000' opacity='0.98'/%3E%3Crect x='1144' width='4' height='1000' opacity='0.90'/%3E%3Crect x='1153' width='7' height='1000' opacity='0.94'/%3E%3Crect x='1161' width='10' height='1000' opacity='0.69'/%3E%3Crect x='1171' width='6' height='1000' opacity='0.95'/%3E%3Crect x='1182' width='6' height='1000' opacity='0.57'/%3E%3Crect x='1189' width='8' height='1000' opacity='0.72'/%3E%3Crect x='1199' width='10' height='1000' opacity='0.88'/%3E%3C/g%3E%3C/pattern%3E%3Cmask id='rm' maskUnits='userSpaceOnUse' x='0' y='0' width='2400' height='1000'%3E%3Crect width='2400' height='1000' fill='url(%23r)'/%3E%3C/mask%3E%3Cg id='sl' fill='url(%23c)'%3E%3Cpath d='M0 863L25 864 25 432 0 431Z' opacity='0.76' mask='url(%23f)'/%3E%3Cpath d='M24 864L49 861 49 428 24 432Z' opacity='0.76' mask='url(%23f)'/%3E%3Cpath d='M48 861L73 854 73 419 48 428Z' opacity='0.76' mask='url(%23f)'/%3E%3Cpath d='M72 854L97 846 97 409 72 419Z' opacity='0.77' mask='url(%23f)'/%3E%3Cpath d='M96 846L121 837 121 398 96 409Z' opacity='0.77' mask='url(%23f)'/%3E%3Cpath d='M120 837L145 827 145 385 120 398Z' opacity='0.78' mask='url(%23f)'/%3E%3Cpath d='M144 827L169 816 169 370 144 385Z' opacity='0.78' mask='url(%23f)'/%3E%3Cpath d='M168 816L193 801 193 353 168 370Z' opacity='0.79' mask='url(%23f)'/%3E%3Cpath d='M192 801L217 783 217 332 192 353Z' opacity='0.79' mask='url(%23f)'/%3E%3Cpath d='M216 783L241 763 241 309 216 332Z' opacity='0.79' mask='url(%23f)'/%3E%3Cpath d='M240 763L265 742 265 286 240 309Z' opacity='0.78' mask='url(%23f)'/%3E%3Cpath d='M264 742L289 724 289 266 264 286Z' opacity='0.75' mask='url(%23f)'/%3E%3Cpath d='M288 724L313 711 313 252 288 266Z' opacity='0.71' mask='url(%23f)'/%3E%3Cpath d='M312 711L337 705 337 246 312 252Z' opacity='0.65' mask='url(%23f)'/%3E%3Cpath d='M336 705L361 707 361 247 336 246Z' opacity='0.59' mask='url(%23f)'/%3E%3Cpath d='M360 707L385 714 385 254 360 247Z' opacity='0.54' mask='url(%23f)'/%3E%3Cpath d='M384 714L409 725 409 264 384 254Z' opacity='0.50' mask='url(%23f)'/%3E%3Cpath d='M408 725L433 734 433 273 408 264Z' opacity='0.48' mask='url(%23f)'/%3E%3Cpath d='M432 734L457 741 457 278 432 273Z' opacity='0.47' mask='url(%23f)'/%3E%3Cpath d='M456 741L481 742 481 278 456 278Z' opacity='0.46' mask='url(%23f)'/%3E%3Cpath d='M480 742L505 737 505 272 480 278Z' opacity='0.45' mask='url(%23f)'/%3E%3Cpath d='M504 737L529 729 529 263 504 272Z' opacity='0.43' mask='url(%23f)'/%3E%3Cpath d='M528 729L553 720 553 252 528 263Z' opacity='0.40' mask='url(%23f)'/%3E%3Cpath d='M552 720L577 712 577 243 552 252Z' opacity='0.37' mask='url(%23f)'/%3E%3Cpath d='M576 712L601 708 601 238 576 243Z' opacity='0.35' mask='url(%23f)'/%3E%3Cpath d='M600 708L625 708 625 237 600 238Z' opacity='0.33' mask='url(%23f)'/%3E%3Cpath d='M624 708L649 712 649 240 624 237Z' opacity='0.32' mask='url(%23f)'/%3E%3Cpath d='M648 712L673 718 673 246 648 240Z' opacity='0.31' mask='url(%23f)'/%3E%3Cpath d='M672 718L697 726 697 254 672 246Z' opacity='0.31' mask='url(%23f)'/%3E%3Cpath d='M696 726L721 733 721 261 696 254Z' opacity='0.30' mask='url(%23f)'/%3E%3Cpath d='M720 733L745 741 745 267 720 261Z' opacity='0.28' mask='url(%23f)'/%3E%3Cpath d='M744 741L769 751 769 274 744 267Z' opacity='0.26' mask='url(%23f)'/%3E%3Cpath d='M768 751L793 762 793 283 768 274Z' opacity='0.25' mask='url(%23f)'/%3E%3Cpath d='M792 762L817 777 817 294 792 283Z' opacity='0.23' mask='url(%23f)'/%3E%3Cpath d='M816 777L841 797 841 310 816 294Z' opacity='0.22' mask='url(%23f)'/%3E%3Cpath d='M840 797L865 818 865 328 840 310Z' opacity='0.22' mask='url(%23f)'/%3E%3Cpath d='M864 818L889 840 889 346 864 328Z' opacity='0.22' mask='url(%23f)'/%3E%3Cpath d='M888 840L913 859 913 362 888 346Z' opacity='0.22' mask='url(%23f)'/%3E%3Cpath d='M912 859L937 872 937 371 912 362Z' opacity='0.23' mask='url(%23f)'/%3E%3Cpath d='M936 872L961 876 961 373 936 371Z' opacity='0.25' mask='url(%23f)'/%3E%3Cpath d='M960 876L985 871 985 366 960 373Z' opacity='0.29' mask='url(%23f)'/%3E%3Cpath d='M984 871L1009 859 1009 353 984 366Z' opacity='0.36' mask='url(%23f)'/%3E%3Cpath d='M1008 859L1033 842 1033 335 1008 353Z' opacity='0.44' mask='url(%23f)'/%3E%3Cpath d='M1032 842L1057 824 1057 318 1032 335Z' opacity='0.52' mask='url(%23f)'/%3E%3Cpath d='M1056 824L1081 808 1081 304 1056 318Z' opacity='0.58' mask='url(%23f)'/%3E%3Cpath d='M1080 808L1105 795 1105 294 1080 304Z' opacity='0.62' mask='url(%23f)'/%3E%3Cpath d='M1104 795L1129 788 1129 290 1104 294Z' opacity='0.62' mask='url(%23f)'/%3E%3Cpath d='M1128 788L1153 783 1153 290 1128 290Z' opacity='0.61' mask='url(%23f)'/%3E%3Cpath d='M1152 783L1177 781 1177 293 1152 290Z' opacity='0.59' mask='url(%23f)'/%3E%3Cpath d='M1176 781L1201 778 1201 295 1176 293Z' opacity='0.56' mask='url(%23f)'/%3E%3Cpath d='M1200 778L1225 774 1225 296 1200 295Z' opacity='0.53' mask='url(%23f)'/%3E%3Cpath d='M1224 774L1249 768 1249 295 1224 296Z' opacity='0.51' mask='url(%23f)'/%3E%3Cpath d='M1248 768L1273 762 1273 293 1248 295Z' opacity='0.48' mask='url(%23f)'/%3E%3Cpath d='M1272 762L1297 756 1297 291 1272 293Z' opacity='0.46' mask='url(%23f)'/%3E%3Cpath d='M1296 756L1321 752 1321 290 1296 291Z' opacity='0.45' mask='url(%23f)'/%3E%3Cpath d='M1320 752L1345 750 1345 290 1320 290Z' opacity='0.45' mask='url(%23f)'/%3E%3Cpath d='M1344 750L1369 749 1369 290 1344 290Z' opacity='0.47' mask='url(%23f)'/%3E%3Cpath d='M1368 749L1393 749 1393 289 1368 290Z' opacity='0.49' mask='url(%23f)'/%3E%3Cpath d='M1392 749L1417 745 1417 284 1392 289Z' opacity='0.53' mask='url(%23f)'/%3E%3Cpath d='M1416 745L1441 738 1441 274 1416 284Z' opacity='0.57' mask='url(%23f)'/%3E%3Cpath d='M1440 738L1465 726 1465 259 1440 274Z' opacity='0.62' mask='url(%23f)'/%3E%3Cpath d='M1464 726L1489 710 1489 240 1464 259Z' opacity='0.66' mask='url(%23f)'/%3E%3Cpath d='M1488 710L1513 693 1513 219 1488 240Z' opacity='0.70' mask='url(%23f)'/%3E%3Cpath d='M1512 693L1537 679 1537 200 1512 219Z' opacity='0.72' mask='url(%23f)'/%3E%3Cpath d='M1536 679L1561 670 1561 186 1536 200Z' opacity='0.72' mask='url(%23f)'/%3E%3Cpath d='M1560 670L1585 670 1585 181 1560 186Z' opacity='0.70' mask='url(%23f)'/%3E%3Cpath d='M1584 670L1609 678 1609 186 1584 181Z' opacity='0.66' mask='url(%23f)'/%3E%3Cpath d='M1608 678L1633 694 1633 198 1608 186Z' opacity='0.60' mask='url(%23f)'/%3E%3Cpath d='M1632 694L1657 715 1657 216 1632 198Z' opacity='0.54' mask='url(%23f)'/%3E%3Cpath d='M1656 715L1681 737 1681 237 1656 216Z' opacity='0.49' mask='url(%23f)'/%3E%3Cpath d='M1680 737L1705 759 1705 257 1680 237Z' opacity='0.44' mask='url(%23f)'/%3E%3Cpath d='M1704 759L1729 777 1729 276 1704 257Z' opacity='0.40' mask='url(%23f)'/%3E%3Cpath d='M1728 777L1753 791 1753 296 1728 276Z' opacity='0.39' mask='url(%23f)'/%3E%3Cpath d='M1752 791L1777 802 1777 317 1752 296Z' opacity='0.38' mask='url(%23f)'/%3E%3Cpath d='M1776 802L1801 812 1801 340 1776 317Z' opacity='0.39' mask='url(%23f)'/%3E%3Cpath d='M1800 812L1825 820 1825 367 1800 340Z' opacity='0.42' mask='url(%23f)'/%3E%3Cpath d='M1824 820L1849 828 1849 396 1824 367Z' opacity='0.47' mask='url(%23f)'/%3E%3Cpath d='M1848 828L1873 835 1873 425 1848 396Z' opacity='0.52' mask='url(%23f)'/%3E%3Cpath d='M1872 835L1897 840 1897 453 1872 425Z' opacity='0.58' mask='url(%23f)'/%3E%3Cpath d='M1896 840L1921 842 1921 477 1896 453Z' opacity='0.64' mask='url(%23f)'/%3E%3Cpath d='M1920 842L1945 838 1945 494 1920 477Z' opacity='0.69' mask='url(%23f)'/%3E%3Cpath d='M1944 838L1969 830 1969 504 1944 494Z' opacity='0.73' mask='url(%23f)'/%3E%3Cpath d='M1968 830L1993 819 1993 508 1968 504Z' opacity='0.73' mask='url(%23f)'/%3E%3Cpath d='M1992 819L2017 807 2017 507 1992 508Z' opacity='0.71' mask='url(%23f)'/%3E%3Cpath d='M2016 807L2041 798 2041 504 2016 507Z' opacity='0.66' mask='url(%23f)'/%3E%3Cpath d='M2040 798L2065 793 2065 500 2040 504Z' opacity='0.60' mask='url(%23f)'/%3E%3Cpath d='M2064 793L2089 794 2089 499 2064 500Z' opacity='0.52' mask='url(%23f)'/%3E%3Cpath d='M2088 794L2113 800 2113 501 2088 499Z' opacity='0.45' mask='url(%23f)'/%3E%3Cpath d='M2112 800L2137 809 2137 504 2112 501Z' opacity='0.39' mask='url(%23f)'/%3E%3Cpath d='M2136 809L2161 818 2161 504 2136 504Z' opacity='0.35' mask='url(%23f)'/%3E%3Cpath d='M2160 818L2185 822 2185 499 2160 504Z' opacity='0.32' mask='url(%23f)'/%3E%3Cpath d='M2184 822L2209 821 2209 487 2184 499Z' opacity='0.32' mask='url(%23f)'/%3E%3Cpath d='M2208 821L2233 812 2233 467 2208 487Z' opacity='0.33' mask='url(%23f)'/%3E%3Cpath d='M2232 812L2257 798 2257 441 2232 467Z' opacity='0.36' mask='url(%23f)'/%3E%3Cpath d='M2256 798L2281 780 2281 413 2256 441Z' opacity='0.41' mask='url(%23f)'/%3E%3Cpath d='M2280 780L2305 760 2305 384 2280 413Z' opacity='0.47' mask='url(%23f)'/%3E%3Cpath d='M2304 760L2329 742 2329 358 2304 384Z' opacity='0.55' mask='url(%23f)'/%3E%3Cpath d='M2328 742L2353 727 2353 337 2328 358Z' opacity='0.63' mask='url(%23f)'/%3E%3Cpath d='M2352 727L2377 714 2377 321 2352 337Z' opacity='0.70' mask='url(%23f)'/%3E%3Cpath d='M2376 714L2401 704 2401 309 2376 321Z' opacity='0.75' mask='url(%23f)'/%3E%3C/g%3E%3C/defs%3E%3Cg mask='url(%23rm)'%3E%3Cuse href='%23sl'/%3E%3C/g%3E%3C/svg%3E\") center / 100% 100% no-repeat;\nopacity: 0;\nanimation: aur-au-shimmer 6.5s steps(78) infinite alternate;\n}\n@keyframes aur-au-shimmer { to { opacity: 0.85; } }\n.aur-root[data-fx=\"aurora\"] .aur-fx-b {\ndisplay: block;\nleft: -10%;\nright: -10%;\ntop: -8%;\nheight: 70%;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2400 1000' preserveAspectRatio='none'%3E%3Cdefs%3E%3ClinearGradient id='c' gradientUnits='userSpaceOnUse' x1='0' y1='0' x2='0' y2='1000'%3E%3Cstop offset='0.096' stop-color='%23d05cff'/%3E%3Cstop offset='0.249' stop-color='%238467ff'/%3E%3Cstop offset='0.423' stop-color='%232aa6d8'/%3E%3Cstop offset='0.556' stop-color='%233fe6c8'/%3E%3Cstop offset='0.607' stop-color='%23b8fff0'/%3E%3C/linearGradient%3E%3ClinearGradient id='g' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%23000'/%3E%3Cstop offset='.4' stop-color='%23fff' stop-opacity='.14'/%3E%3Cstop offset='.7' stop-color='%23fff' stop-opacity='.55'/%3E%3Cstop offset='.86' stop-color='%23fff'/%3E%3Cstop offset='.93' stop-color='%23fff' stop-opacity='.85'/%3E%3Cstop offset='1' stop-color='%23000'/%3E%3C/linearGradient%3E%3Cmask id='f' maskContentUnits='objectBoundingBox'%3E%3Crect width='1' height='1' fill='url(%23g)'/%3E%3C/mask%3E%3ClinearGradient id='s'%3E%3Cstop offset='0' stop-color='%23000'/%3E%3Cstop offset='.5' stop-color='%23fff'/%3E%3Cstop offset='1' stop-color='%23000'/%3E%3C/linearGradient%3E%3Cpattern id='r' width='1200' height='1000' patternUnits='userSpaceOnUse'%3E%3Cg fill='url(%23s)'%3E%3Crect x='0' width='21' height='1000' opacity='0.79'/%3E%3Crect x='22' width='34' height='1000' opacity='0.78'/%3E%3Crect x='78' width='10' height='1000' opacity='0.90'/%3E%3Crect x='98' width='4' height='1000' opacity='0.65'/%3E%3Crect x='104' width='22' height='1000' opacity='0.56'/%3E%3Crect x='149' width='6' height='1000' opacity='0.84'/%3E%3Crect x='157' width='24' height='1000' opacity='0.74'/%3E%3Crect x='203' width='22' height='1000' opacity='0.72'/%3E%3Crect x='234' width='18' height='1000' opacity='0.80'/%3E%3Crect x='267' width='4' height='1000' opacity='0.93'/%3E%3Crect x='272' width='9' height='1000' opacity='0.81'/%3E%3Crect x='280' width='5' height='1000' opacity='0.86'/%3E%3Crect x='286' width='31' height='1000' opacity='0.86'/%3E%3Crect x='326' width='7' height='1000' opacity='0.62'/%3E%3Crect x='332' width='39' height='1000' opacity='0.76'/%3E%3Crect x='394' width='8' height='1000' opacity='0.57'/%3E%3Crect x='412' width='5' height='1000' opacity='0.82'/%3E%3Crect x='416' width='4' height='1000' opacity='0.91'/%3E%3Crect x='421' width='31' height='1000' opacity='0.73'/%3E%3Crect x='453' width='10' height='1000' opacity='0.93'/%3E%3Crect x='468' width='6' height='1000' opacity='0.78'/%3E%3Crect x='479' width='8' height='1000' opacity='0.73'/%3E%3Crect x='489' width='27' height='1000' opacity='0.77'/%3E%3Crect x='514' width='9' height='1000' opacity='0.65'/%3E%3Crect x='524' width='39' height='1000' opacity='0.88'/%3E%3Crect x='567' width='15' height='1000' opacity='0.77'/%3E%3Crect x='583' width='8' height='1000' opacity='0.80'/%3E%3Crect x='593' width='27' height='1000' opacity='0.87'/%3E%3Crect x='628' width='23' height='1000' opacity='0.68'/%3E%3Crect x='670' width='19' height='1000' opacity='0.98'/%3E%3Crect x='689' width='23' height='1000' opacity='0.68'/%3E%3Crect x='737' width='26' height='1000' opacity='0.56'/%3E%3Crect x='783' width='9' height='1000' opacity='0.89'/%3E%3Crect x='796' width='34' height='1000' opacity='1.00'/%3E%3Crect x='857' width='19' height='1000' opacity='0.86'/%3E%3Crect x='897' width='18' height='1000' opacity='0.73'/%3E%3Crect x='933' width='26' height='1000' opacity='0.67'/%3E%3Crect x='959' width='17' height='1000' opacity='0.65'/%3E%3Crect x='978' width='21' height='1000' opacity='0.85'/%3E%3Crect x='1006' width='17' height='1000' opacity='0.76'/%3E%3Crect x='1030' width='18' height='1000' opacity='0.77'/%3E%3Crect x='1050' width='30' height='1000' opacity='0.91'/%3E%3Crect x='1104' width='31' height='1000' opacity='0.76'/%3E%3Crect x='1137' width='16' height='1000' opacity='0.78'/%3E%3Crect x='1157' width='8' height='1000' opacity='0.80'/%3E%3Crect x='1167' width='40' height='1000' opacity='0.96'/%3E%3C/g%3E%3C/pattern%3E%3Cmask id='rm' maskUnits='userSpaceOnUse' x='0' y='0' width='2400' height='1000'%3E%3Crect width='2400' height='1000' fill='url(%23r)'/%3E%3C/mask%3E%3Cg id='sl' fill='url(%23c)'%3E%3Cpath d='M0 444L31 440 31 96 0 99Z' opacity='0.26' mask='url(%23f)'/%3E%3Cpath d='M30 440L61 441 61 99 30 96Z' opacity='0.27' mask='url(%23f)'/%3E%3Cpath d='M60 441L91 449 91 110 60 99Z' opacity='0.31' mask='url(%23f)'/%3E%3Cpath d='M90 449L121 462 121 127 90 110Z' opacity='0.37' mask='url(%23f)'/%3E%3Cpath d='M120 462L151 478 151 147 120 127Z' opacity='0.45' mask='url(%23f)'/%3E%3Cpath d='M150 478L181 493 181 168 150 147Z' opacity='0.54' mask='url(%23f)'/%3E%3Cpath d='M180 493L211 507 211 186 180 168Z' opacity='0.61' mask='url(%23f)'/%3E%3Cpath d='M210 507L241 515 241 199 210 186Z' opacity='0.65' mask='url(%23f)'/%3E%3Cpath d='M240 515L271 519 271 206 240 199Z' opacity='0.65' mask='url(%23f)'/%3E%3Cpath d='M270 519L301 518 301 207 270 206Z' opacity='0.64' mask='url(%23f)'/%3E%3Cpath d='M300 518L331 514 331 205 300 207Z' opacity='0.63' mask='url(%23f)'/%3E%3Cpath d='M330 514L361 510 361 201 330 205Z' opacity='0.62' mask='url(%23f)'/%3E%3Cpath d='M360 510L391 508 391 198 360 201Z' opacity='0.61' mask='url(%23f)'/%3E%3Cpath d='M390 508L421 510 421 199 390 198Z' opacity='0.60' mask='url(%23f)'/%3E%3Cpath d='M420 510L451 515 451 203 420 199Z' opacity='0.60' mask='url(%23f)'/%3E%3Cpath d='M450 515L481 524 481 210 450 203Z' opacity='0.60' mask='url(%23f)'/%3E%3Cpath d='M480 524L511 534 511 219 480 210Z' opacity='0.58' mask='url(%23f)'/%3E%3Cpath d='M510 534L541 545 541 228 510 219Z' opacity='0.56' mask='url(%23f)'/%3E%3Cpath d='M540 545L571 555 571 236 540 228Z' opacity='0.53' mask='url(%23f)'/%3E%3Cpath d='M570 555L601 563 601 243 570 236Z' opacity='0.50' mask='url(%23f)'/%3E%3Cpath d='M600 563L631 570 631 248 600 243Z' opacity='0.48' mask='url(%23f)'/%3E%3Cpath d='M630 570L661 575 661 254 630 248Z' opacity='0.46' mask='url(%23f)'/%3E%3Cpath d='M660 575L691 581 691 259 660 254Z' opacity='0.46' mask='url(%23f)'/%3E%3Cpath d='M690 581L721 586 721 263 690 259Z' opacity='0.45' mask='url(%23f)'/%3E%3Cpath d='M720 586L751 590 751 266 720 263Z' opacity='0.42' mask='url(%23f)'/%3E%3Cpath d='M750 590L781 593 781 267 750 266Z' opacity='0.38' mask='url(%23f)'/%3E%3Cpath d='M780 593L811 591 811 263 780 267Z' opacity='0.34' mask='url(%23f)'/%3E%3Cpath d='M810 591L841 585 841 253 810 263Z' opacity='0.31' mask='url(%23f)'/%3E%3Cpath d='M840 585L871 573 871 238 840 253Z' opacity='0.29' mask='url(%23f)'/%3E%3Cpath d='M870 573L901 556 901 218 870 238Z' opacity='0.29' mask='url(%23f)'/%3E%3Cpath d='M900 556L931 535 931 194 900 218Z' opacity='0.30' mask='url(%23f)'/%3E%3Cpath d='M930 535L961 513 961 171 930 194Z' opacity='0.34' mask='url(%23f)'/%3E%3Cpath d='M960 513L991 493 991 150 960 171Z' opacity='0.41' mask='url(%23f)'/%3E%3Cpath d='M990 493L1021 478 1021 134 990 150Z' opacity='0.51' mask='url(%23f)'/%3E%3Cpath d='M1020 478L1051 470 1051 126 1020 134Z' opacity='0.62' mask='url(%23f)'/%3E%3Cpath d='M1050 470L1081 467 1081 128 1050 126Z' opacity='0.71' mask='url(%23f)'/%3E%3Cpath d='M1080 467L1111 470 1111 139 1080 128Z' opacity='0.75' mask='url(%23f)'/%3E%3Cpath d='M1110 470L1141 476 1141 156 1110 139Z' opacity='0.76' mask='url(%23f)'/%3E%3Cpath d='M1140 476L1171 482 1171 176 1140 156Z' opacity='0.76' mask='url(%23f)'/%3E%3Cpath d='M1170 482L1201 487 1201 195 1170 176Z' opacity='0.76' mask='url(%23f)'/%3E%3Cpath d='M1200 487L1231 489 1231 211 1200 195Z' opacity='0.77' mask='url(%23f)'/%3E%3Cpath d='M1230 489L1261 489 1261 224 1230 211Z' opacity='0.77' mask='url(%23f)'/%3E%3Cpath d='M1260 489L1291 486 1291 232 1260 224Z' opacity='0.77' mask='url(%23f)'/%3E%3Cpath d='M1290 486L1321 482 1321 236 1290 232Z' opacity='0.77' mask='url(%23f)'/%3E%3Cpath d='M1320 482L1351 480 1351 238 1320 236Z' opacity='0.77' mask='url(%23f)'/%3E%3Cpath d='M1350 480L1381 478 1381 238 1350 238Z' opacity='0.75' mask='url(%23f)'/%3E%3Cpath d='M1380 478L1411 479 1411 237 1380 238Z' opacity='0.70' mask='url(%23f)'/%3E%3Cpath d='M1410 479L1441 481 1441 235 1410 237Z' opacity='0.64' mask='url(%23f)'/%3E%3Cpath d='M1440 481L1471 483 1471 232 1440 235Z' opacity='0.58' mask='url(%23f)'/%3E%3Cpath d='M1470 483L1501 486 1501 227 1470 232Z' opacity='0.53' mask='url(%23f)'/%3E%3Cpath d='M1500 486L1531 488 1531 221 1500 227Z' opacity='0.50' mask='url(%23f)'/%3E%3Cpath d='M1530 488L1561 490 1561 215 1530 221Z' opacity='0.49' mask='url(%23f)'/%3E%3Cpath d='M1560 490L1591 494 1591 211 1560 215Z' opacity='0.49' mask='url(%23f)'/%3E%3Cpath d='M1590 494L1621 502 1621 211 1590 211Z' opacity='0.49' mask='url(%23f)'/%3E%3Cpath d='M1620 502L1651 513 1651 217 1620 211Z' opacity='0.49' mask='url(%23f)'/%3E%3Cpath d='M1650 513L1681 528 1681 229 1650 217Z' opacity='0.48' mask='url(%23f)'/%3E%3Cpath d='M1680 528L1711 547 1711 246 1680 229Z' opacity='0.48' mask='url(%23f)'/%3E%3Cpath d='M1710 547L1741 567 1741 265 1710 246Z' opacity='0.48' mask='url(%23f)'/%3E%3Cpath d='M1740 567L1771 585 1771 282 1740 265Z' opacity='0.48' mask='url(%23f)'/%3E%3Cpath d='M1770 585L1801 599 1801 292 1770 282Z' opacity='0.47' mask='url(%23f)'/%3E%3Cpath d='M1800 599L1831 607 1831 295 1800 292Z' opacity='0.45' mask='url(%23f)'/%3E%3Cpath d='M1830 607L1861 607 1861 289 1830 295Z' opacity='0.41' mask='url(%23f)'/%3E%3Cpath d='M1860 607L1891 600 1891 276 1860 289Z' opacity='0.37' mask='url(%23f)'/%3E%3Cpath d='M1890 600L1921 587 1921 258 1890 276Z' opacity='0.34' mask='url(%23f)'/%3E%3Cpath d='M1920 587L1951 573 1951 238 1920 258Z' opacity='0.31' mask='url(%23f)'/%3E%3Cpath d='M1950 573L1981 558 1981 219 1950 238Z' opacity='0.30' mask='url(%23f)'/%3E%3Cpath d='M1980 558L2011 546 2011 203 1980 219Z' opacity='0.30' mask='url(%23f)'/%3E%3Cpath d='M2010 546L2041 537 2041 193 2010 203Z' opacity='0.28' mask='url(%23f)'/%3E%3Cpath d='M2040 537L2071 531 2071 186 2040 193Z' opacity='0.27' mask='url(%23f)'/%3E%3Cpath d='M2070 531L2101 527 2101 183 2070 186Z' opacity='0.25' mask='url(%23f)'/%3E%3Cpath d='M2100 527L2131 524 2131 180 2100 183Z' opacity='0.23' mask='url(%23f)'/%3E%3Cpath d='M2130 524L2161 520 2161 177 2130 180Z' opacity='0.22' mask='url(%23f)'/%3E%3Cpath d='M2160 520L2191 516 2191 173 2160 177Z' opacity='0.22' mask='url(%23f)'/%3E%3Cpath d='M2190 516L2221 511 2221 169 2190 173Z' opacity='0.22' mask='url(%23f)'/%3E%3Cpath d='M2220 511L2251 506 2251 165 2220 169Z' opacity='0.22' mask='url(%23f)'/%3E%3Cpath d='M2250 506L2281 503 2281 162 2250 165Z' opacity='0.24' mask='url(%23f)'/%3E%3Cpath d='M2280 503L2311 500 2311 160 2280 162Z' opacity='0.26' mask='url(%23f)'/%3E%3Cpath d='M2310 500L2341 499 2341 159 2310 160Z' opacity='0.30' mask='url(%23f)'/%3E%3Cpath d='M2340 499L2371 498 2371 159 2340 159Z' opacity='0.34' mask='url(%23f)'/%3E%3Cpath d='M2370 498L2401 496 2401 157 2370 159Z' opacity='0.37' mask='url(%23f)'/%3E%3C/g%3E%3C/defs%3E%3Cuse href='%23sl' opacity='.17'/%3E%3Cg mask='url(%23rm)'%3E%3Cuse href='%23sl'/%3E%3C/g%3E%3Cdefs%3E%3Cg id='hm'%3E%3Cpath d='M0 436L31 432' opacity='0.26'/%3E%3Cpath d='M30 432L61 433' opacity='0.27'/%3E%3Cpath d='M60 433L91 441' opacity='0.31'/%3E%3Cpath d='M90 441L121 454' opacity='0.37'/%3E%3Cpath d='M120 454L151 470' opacity='0.45'/%3E%3Cpath d='M150 470L181 485' opacity='0.54'/%3E%3Cpath d='M180 485L211 499' opacity='0.61'/%3E%3Cpath d='M210 499L241 507' opacity='0.65'/%3E%3Cpath d='M240 507L271 511' opacity='0.65'/%3E%3Cpath d='M270 511L301 510' opacity='0.64'/%3E%3Cpath d='M300 510L331 506' opacity='0.63'/%3E%3Cpath d='M330 506L361 502' opacity='0.62'/%3E%3Cpath d='M360 502L391 500' opacity='0.61'/%3E%3Cpath d='M390 500L421 502' opacity='0.60'/%3E%3Cpath d='M420 502L451 507' opacity='0.60'/%3E%3Cpath d='M450 507L481 516' opacity='0.60'/%3E%3Cpath d='M480 516L511 526' opacity='0.58'/%3E%3Cpath d='M510 526L541 537' opacity='0.56'/%3E%3Cpath d='M540 537L571 547' opacity='0.53'/%3E%3Cpath d='M570 547L601 555' opacity='0.50'/%3E%3Cpath d='M600 555L631 562' opacity='0.48'/%3E%3Cpath d='M630 562L661 567' opacity='0.46'/%3E%3Cpath d='M660 567L691 573' opacity='0.46'/%3E%3Cpath d='M690 573L721 578' opacity='0.45'/%3E%3Cpath d='M720 578L751 582' opacity='0.42'/%3E%3Cpath d='M750 582L781 585' opacity='0.38'/%3E%3Cpath d='M780 585L811 583' opacity='0.34'/%3E%3Cpath d='M810 583L841 577' opacity='0.31'/%3E%3Cpath d='M840 577L871 565' opacity='0.29'/%3E%3Cpath d='M870 565L901 548' opacity='0.29'/%3E%3Cpath d='M900 548L931 527' opacity='0.30'/%3E%3Cpath d='M930 527L961 505' opacity='0.34'/%3E%3Cpath d='M960 505L991 485' opacity='0.41'/%3E%3Cpath d='M990 485L1021 470' opacity='0.51'/%3E%3Cpath d='M1020 470L1051 462' opacity='0.62'/%3E%3Cpath d='M1050 462L1081 459' opacity='0.71'/%3E%3Cpath d='M1080 459L1111 462' opacity='0.75'/%3E%3Cpath d='M1110 462L1141 468' opacity='0.76'/%3E%3Cpath d='M1140 468L1171 474' opacity='0.76'/%3E%3Cpath d='M1170 474L1201 479' opacity='0.76'/%3E%3Cpath d='M1200 479L1231 481' opacity='0.77'/%3E%3Cpath d='M1230 481L1261 481' opacity='0.77'/%3E%3Cpath d='M1260 481L1291 478' opacity='0.77'/%3E%3Cpath d='M1290 478L1321 474' opacity='0.77'/%3E%3Cpath d='M1320 474L1351 472' opacity='0.77'/%3E%3Cpath d='M1350 472L1381 470' opacity='0.75'/%3E%3Cpath d='M1380 470L1411 471' opacity='0.70'/%3E%3Cpath d='M1410 471L1441 473' opacity='0.64'/%3E%3Cpath d='M1440 473L1471 475' opacity='0.58'/%3E%3Cpath d='M1470 475L1501 478' opacity='0.53'/%3E%3Cpath d='M1500 478L1531 480' opacity='0.50'/%3E%3Cpath d='M1530 480L1561 482' opacity='0.49'/%3E%3Cpath d='M1560 482L1591 486' opacity='0.49'/%3E%3Cpath d='M1590 486L1621 494' opacity='0.49'/%3E%3Cpath d='M1620 494L1651 505' opacity='0.49'/%3E%3Cpath d='M1650 505L1681 520' opacity='0.48'/%3E%3Cpath d='M1680 520L1711 539' opacity='0.48'/%3E%3Cpath d='M1710 539L1741 559' opacity='0.48'/%3E%3Cpath d='M1740 559L1771 577' opacity='0.48'/%3E%3Cpath d='M1770 577L1801 591' opacity='0.47'/%3E%3Cpath d='M1800 591L1831 599' opacity='0.45'/%3E%3Cpath d='M1830 599L1861 599' opacity='0.41'/%3E%3Cpath d='M1860 599L1891 592' opacity='0.37'/%3E%3Cpath d='M1890 592L1921 579' opacity='0.34'/%3E%3Cpath d='M1920 579L1951 565' opacity='0.31'/%3E%3Cpath d='M1950 565L1981 550' opacity='0.30'/%3E%3Cpath d='M1980 550L2011 538' opacity='0.30'/%3E%3Cpath d='M2010 538L2041 529' opacity='0.28'/%3E%3Cpath d='M2040 529L2071 523' opacity='0.27'/%3E%3Cpath d='M2070 523L2101 519' opacity='0.25'/%3E%3Cpath d='M2100 519L2131 516' opacity='0.23'/%3E%3Cpath d='M2130 516L2161 512' opacity='0.22'/%3E%3Cpath d='M2160 512L2191 508' opacity='0.22'/%3E%3Cpath d='M2190 508L2221 503' opacity='0.22'/%3E%3Cpath d='M2220 503L2251 498' opacity='0.22'/%3E%3Cpath d='M2250 498L2281 495' opacity='0.24'/%3E%3Cpath d='M2280 495L2311 492' opacity='0.26'/%3E%3Cpath d='M2310 492L2341 491' opacity='0.30'/%3E%3Cpath d='M2340 491L2371 490' opacity='0.34'/%3E%3Cpath d='M2370 490L2401 488' opacity='0.37'/%3E%3C/g%3E%3C/defs%3E%3Cg fill='none' stroke='%233fe6c8' stroke-linecap='round'%3E%3Cuse href='%23hm' stroke-width='40' opacity='.06'/%3E%3Cuse href='%23hm' stroke-width='14' opacity='.12'/%3E%3C/g%3E%3C/svg%3E\") center / 100% 100% no-repeat;\ntransform-origin: 50% 60%;\nopacity: 0.55;\ntransition: opacity 3s ease;\nanimation: aur-au-sway 41s steps(1230) infinite alternate-reverse;\n}\n.aur-root[data-fx=\"aurora\"][data-gap=\"on\"] .aur-fx-b { opacity: 0.68; }\n.aur-root[data-fx=\"aurora\"] .aur-fx-c {\ndisplay: block;\nleft: 0;\nright: 0;\nbottom: 0;\nheight: 13vh;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2400 200' preserveAspectRatio='none'%3E%3ClinearGradient id='h' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='.35' stop-color='%230a1418'/%3E%3Cstop offset='1' stop-color='%23040709'/%3E%3C/linearGradient%3E%3Cpath d='M0 200 1 121 13 76 25 121 24 112 38 107 44 113 54 67 65 113 59 120 73 69 87 120 84 125 98 116 115 120 121 128 135 74 149 128 152 134 158 110 164 134 182 133 187 133 196 100 205 133 214 141 237 147 256 141 280 148 300 143 301 139 318 84 335 139 323 145 329 120 335 145 340 151 350 106 360 151 370 148 394 148 408 141 408 135 419 91 429 135 412 142 429 82 447 142 432 141 444 95 457 141 462 143 479 142 493 139 500 140 510 103 520 140 520 142 519 144 531 96 543 144 545 148 551 128 557 148 564 144 575 100 585 144 579 140 590 96 600 140 593 145 605 102 617 145 619 140 621 135 633 86 644 135 647 132 654 138 663 105 672 138 679 137 686 114 692 137 698 143 711 139 724 144 730 120 736 144 742 140 751 104 760 140 761 148 767 129 772 148 771 156 789 97 807 156 802 161 814 161 821 128 829 161 820 163 832 109 844 163 855 166 878 170 879 170 888 139 896 170 905 168 909 166 924 110 938 166 933 163 945 121 956 163 957 168 965 170 978 124 991 170 979 166 989 125 999 166 1001 170 1006 150 1010 170 1017 162 1032 155 1039 123 1047 155 1054 157 1063 152 1069 128 1075 152 1083 150 1089 124 1096 150 1093 155 1108 102 1122 155 1111 153 1124 104 1136 153 1132 152 1144 110 1155 152 1138 150 1155 94 1171 150 1170 158 1169 157 1183 103 1198 157 1206 162 1216 163 1226 120 1236 163 1233 168 1238 146 1243 168 1248 163 1260 108 1273 163 1282 166 1306 167 1305 170 1316 121 1327 170 1328 170 1337 138 1345 170 1350 165 1358 136 1366 165 1370 163 1379 128 1388 163 1379 156 1395 95 1410 156 1415 150 1425 153 1436 114 1446 153 1443 147 1458 96 1473 147 1475 146 1477 141 1488 98 1499 141 1501 145 1501 149 1515 93 1530 149 1519 143 1529 104 1539 143 1530 141 1542 89 1554 141 1566 141 1582 147 1600 146 1622 145 1637 144 1645 116 1653 144 1665 152 1671 147 1678 120 1685 147 1686 154 1700 98 1714 154 1710 158 1716 136 1722 158 1730 155 1740 146 1750 109 1759 146 1763 148 1770 149 1778 119 1786 149 1790 156 1786 164 1801 112 1816 164 1815 167 1836 163 1854 166 1860 143 1866 166 1875 170 1893 164 1912 158 1931 151 1943 148 1961 149 1972 146 1977 125 1983 146 1998 147 2000 143 2013 86 2026 143 2030 138 2033 135 2045 93 2057 135 2053 141 2060 111 2067 141 2072 146 2070 141 2084 90 2099 141 2096 142 2105 107 2113 142 2114 144 2122 115 2130 144 2132 149 2156 147 2174 149 2194 146 2210 148 2220 152 2230 153 2237 126 2244 153 2248 153 2264 154 2286 147 2299 139 2305 111 2312 139 2307 147 2323 91 2338 147 2335 154 2358 157 2372 163 2394 162 2406 155 2411 133 2416 155 2400 200Z' fill='url(%23h)'/%3E%3C/svg%3E\") center bottom / 100% 100% no-repeat;\nopacity: 0.92;\n}\n.aur-root[data-fx=\"blackmetal\"] {\n--bm-moon-x: 78vw;\n--bm-moon-y: 17vh;\n--bm-moon: 8.6vmin;\n}\n.aur-root[data-fx=\"blackmetal\"] .aur-fx {\nbackground: linear-gradient(to bottom, rgba(3, 5, 8, 0.95) 0%, rgba(8, 12, 17, 0.92) 30%, rgba(19, 27, 35, 0.9) 54%, rgba(40, 50, 61, 0.88) 68%, rgba(14, 18, 22, 0.96) 84%, #050608 100%);\n}\n.aur-root[data-fx=\"blackmetal\"] .aur-fx::before {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground:\nurl(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'%3E %3Cdefs%3E %3CradialGradient id='g' cx='43%25' cy='40%25' r='64%25'%3E%3Cstop offset='0' stop-color='%23f6f8fa'/%3E%3Cstop offset='.62' stop-color='%23dfe6ec'/%3E%3Cstop offset='1' stop-color='%23a9b7c3'/%3E%3C/radialGradient%3E %3CradialGradient id='sh' cx='30%25' cy='70%25' r='75%25'%3E%3Cstop offset='.55' stop-color='%231b232b' stop-opacity='0'/%3E%3Cstop offset='1' stop-color='%231b232b' stop-opacity='.55'/%3E%3C/radialGradient%3E %3Cfilter id='m' x='0' y='0' width='100%25' height='100%25'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.03' numOctaves='4' seed='9'/%3E%3CfeColorMatrix values='0 0 0 0 .42 0 0 0 0 .47 0 0 0 0 .53 -2.7 0 0 0 1.55'/%3E%3C/filter%3E %3Cfilter id='n' x='0' y='0' width='100%25' height='100%25'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.5' numOctaves='2' seed='2'/%3E%3CfeColorMatrix values='0 0 0 0 .3 0 0 0 0 .34 0 0 0 0 .38 -1.4 0 0 0 .9'/%3E%3C/filter%3E %3CclipPath id='c'%3E%3Ccircle cx='100' cy='100' r='98'/%3E%3C/clipPath%3E %3C/defs%3E %3Ccircle cx='100' cy='100' r='98' fill='url(%23g)'/%3E %3Cg clip-path='url(%23c)'%3E %3Crect width='200' height='200' filter='url(%23m)' opacity='.62'/%3E %3Crect width='200' height='200' filter='url(%23n)' opacity='.25'/%3E %3Cg fill='none' stroke='%237e8b97' stroke-opacity='.4' stroke-width='1.4'%3E%3Ccircle cx='128' cy='142' r='9'/%3E%3Ccircle cx='62' cy='58' r='5'/%3E%3Ccircle cx='150' cy='76' r='4'/%3E%3Ccircle cx='88' cy='160' r='3.5'/%3E%3C/g%3E %3Cg fill='%23f7f9fb' fill-opacity='.5'%3E%3Ccircle cx='129' cy='140' r='2.2'/%3E%3Ccircle cx='61' cy='56' r='1.2'/%3E%3C/g%3E %3Ccircle cx='100' cy='100' r='98' fill='url(%23sh)'/%3E %3C/g%3E %3C/svg%3E\") calc(var(--bm-moon-x) - var(--bm-moon) / 2) calc(var(--bm-moon-y) - var(--bm-moon) / 2) / var(--bm-moon) var(--bm-moon) no-repeat,\nradial-gradient(circle at var(--bm-moon-x) var(--bm-moon-y), rgba(214, 226, 236, 0.32) calc(var(--bm-moon) * 0.5), rgba(170, 188, 204, 0.12) calc(var(--bm-moon) * 1.4), rgba(140, 158, 176, 0.05) calc(var(--bm-moon) * 3), transparent calc(var(--bm-moon) * 5.5)),\nradial-gradient(1.1px 1.1px at 12% 9%, rgba(255, 255, 255, 0.7), transparent),\nradial-gradient(1px 1px at 23% 21%, rgba(255, 255, 255, 0.5), transparent),\nradial-gradient(1.3px 1.3px at 37% 6%, rgba(255, 255, 255, 0.65), transparent),\nradial-gradient(0.9px 0.9px at 49% 15%, rgba(255, 255, 255, 0.45), transparent),\nradial-gradient(1.2px 1.2px at 58% 4%, rgba(255, 255, 255, 0.6), transparent),\nradial-gradient(1px 1px at 66% 27%, rgba(255, 255, 255, 0.4), transparent),\nradial-gradient(1.1px 1.1px at 91% 8%, rgba(255, 255, 255, 0.55), transparent),\nradial-gradient(0.9px 0.9px at 5% 31%, rgba(255, 255, 255, 0.4), transparent);\n}\n.aur-root[data-fx=\"blackmetal\"] .aur-fx-a {\ndisplay: block;\nleft: -6%;\nright: -6%;\ntop: 0;\nheight: 78%;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2400 1000' preserveAspectRatio='none'%3E%3Cdefs%3E%3CradialGradient id='d'%3E%3Cstop offset='0' stop-color='%231d252c' stop-opacity='.95'/%3E%3Cstop offset='.55' stop-color='%231a2128' stop-opacity='.55'/%3E%3Cstop offset='1' stop-color='%23161c22' stop-opacity='0'/%3E%3C/radialGradient%3E%3CradialGradient id='l'%3E%3Cstop offset='0' stop-color='%23b3c2ce' stop-opacity='.5'/%3E%3Cstop offset='.6' stop-color='%238e9eab' stop-opacity='.18'/%3E%3Cstop offset='1' stop-color='%238e9eab' stop-opacity='0'/%3E%3C/radialGradient%3E%3C/defs%3E%3Cellipse cx='706.5' cy='196.8' rx='142.5' ry='37.6' fill='url(%23d)' opacity='0.56'/%3E%3Cellipse cx='2597.3' cy='146.9' rx='197.9' ry='15.3' fill='url(%23d)' opacity='0.40'/%3E%3Cellipse cx='2589.6' cy='147.6' rx='168.2' ry='8.4' fill='url(%23l)' opacity='0.05'/%3E%3Cellipse cx='-132.3' cy='206.8' rx='246' ry='33.6' fill='url(%23d)' opacity='0.54'/%3E%3Cellipse cx='778.1' cy='133.4' rx='240.8' ry='14.7' fill='url(%23d)' opacity='0.51'/%3E%3Cellipse cx='331.4' cy='130.8' rx='397.6' ry='24.5' fill='url(%23d)' opacity='0.59'/%3E%3Cellipse cx='2544.8' cy='203' rx='212.4' ry='17.5' fill='url(%23d)' opacity='0.41'/%3E%3Cellipse cx='2536' cy='203.2' rx='180.6' ry='9.6' fill='url(%23l)' opacity='0.09'/%3E%3Cellipse cx='1862.6' cy='181.7' rx='226.4' ry='14.4' fill='url(%23d)' opacity='0.44'/%3E%3Cellipse cx='1856.3' cy='185.6' rx='192.4' ry='7.9' fill='url(%23l)' opacity='0.75'/%3E%3Cellipse cx='899.7' cy='119.7' rx='212.4' ry='21.1' fill='url(%23d)' opacity='0.45'/%3E%3Cellipse cx='1182.9' cy='189.2' rx='386.4' ry='21.1' fill='url(%23d)' opacity='0.37'/%3E%3Cellipse cx='1193.5' cy='189.7' rx='328.4' ry='11.6' fill='url(%23l)' opacity='0.19'/%3E%3Cellipse cx='648.9' cy='140.2' rx='306.9' ry='25.4' fill='url(%23d)' opacity='0.43'/%3E%3Cellipse cx='65.4' cy='215.1' rx='321' ry='29' fill='url(%23d)' opacity='0.53'/%3E%3Cellipse cx='2193.7' cy='114.9' rx='194.7' ry='25.3' fill='url(%23d)' opacity='0.53'/%3E%3Cellipse cx='2181.5' cy='118.4' rx='165.5' ry='13.9' fill='url(%23l)' opacity='0.37'/%3E%3Cellipse cx='1211.7' cy='180.7' rx='229.1' ry='19.9' fill='url(%23d)' opacity='0.57'/%3E%3Cellipse cx='1221.6' cy='181.4' rx='194.7' ry='10.9' fill='url(%23l)' opacity='0.21'/%3E%3Cellipse cx='2551.9' cy='180' rx='275.6' ry='17.1' fill='url(%23d)' opacity='0.50'/%3E%3Cellipse cx='2543.3' cy='180.4' rx='234.2' ry='9.4' fill='url(%23l)' opacity='0.08'/%3E%3Cellipse cx='392.9' cy='197.6' rx='220.8' ry='25.2' fill='url(%23d)' opacity='0.57'/%3E%3Cellipse cx='672.9' cy='184.9' rx='232.4' ry='25.7' fill='url(%23d)' opacity='0.57'/%3E%3Cellipse cx='1178.8' cy='532.6' rx='330.5' ry='86.3' fill='url(%23d)' opacity='0.64'/%3E%3Cellipse cx='1217.3' cy='511.1' rx='280.9' ry='47.5' fill='url(%23l)' opacity='0.05'/%3E%3Cellipse cx='1203.1' cy='471.1' rx='293' ry='51.1' fill='url(%23d)' opacity='0.58'/%3E%3Cellipse cx='1226.6' cy='460.1' rx='249' ry='28.1' fill='url(%23l)' opacity='0.10'/%3E%3Cellipse cx='-19.8' cy='382.1' rx='391.3' ry='105.2' fill='url(%23d)' opacity='0.72'/%3E%3Cellipse cx='1699.7' cy='446.6' rx='310.2' ry='88.2' fill='url(%23d)' opacity='0.54'/%3E%3Cellipse cx='1717.4' cy='402.2' rx='263.7' ry='48.5' fill='url(%23l)' opacity='0.42'/%3E%3Cellipse cx='87.1' cy='442.3' rx='401.9' ry='74.6' fill='url(%23d)' opacity='0.67'/%3E%3Cellipse cx='1283.8' cy='395' rx='472.4' ry='51.8' fill='url(%23d)' opacity='0.53'/%3E%3Cellipse cx='1308.3' cy='385.7' rx='401.6' ry='28.5' fill='url(%23l)' opacity='0.21'/%3E%3Cellipse cx='698.8' cy='471.3' rx='280.8' ry='128.6' fill='url(%23d)' opacity='0.48'/%3E%3Cellipse cx='1060' cy='428.6' rx='438.2' ry='70.3' fill='url(%23d)' opacity='0.50'/%3E%3Cellipse cx='1093.8' cy='418' rx='372.5' ry='38.7' fill='url(%23l)' opacity='0.04'/%3E%3Cellipse cx='1883.6' cy='495.3' rx='384.1' ry='122.2' fill='url(%23d)' opacity='0.57'/%3E%3Cellipse cx='1865.9' cy='430.9' rx='326.5' ry='67.2' fill='url(%23l)' opacity='0.34'/%3E%3Cellipse cx='1057.7' cy='434.7' rx='240.6' ry='116.2' fill='url(%23d)' opacity='0.47'/%3E%3Cellipse cx='1113.5' cy='416.8' rx='204.5' ry='63.9' fill='url(%23l)' opacity='0.04'/%3E%3Cellipse cx='16.3' cy='521.2' rx='344.6' ry='61.7' fill='url(%23d)' opacity='0.72'/%3E%3Cellipse cx='331.1' cy='425.2' rx='204.6' ry='61.5' fill='url(%23d)' opacity='0.59'/%3E%3Cellipse cx='1762.4' cy='357.2' rx='443.7' ry='101.6' fill='url(%23d)' opacity='0.65'/%3E%3Cellipse cx='1775.6' cy='303.2' rx='377.2' ry='55.9' fill='url(%23l)' opacity='0.58'/%3E%3Cellipse cx='2502.5' cy='430.9' rx='201.5' ry='54.5' fill='url(%23d)' opacity='0.71'/%3E%3Cellipse cx='2476.4' cy='422.2' rx='171.3' ry='30' fill='url(%23l)' opacity='0.06'/%3E%3Cellipse cx='103.4' cy='387.4' rx='409' ry='109' fill='url(%23d)' opacity='0.68'/%3E%3Cellipse cx='1366' cy='398.6' rx='488.5' ry='51.5' fill='url(%23d)' opacity='0.53'/%3E%3Cellipse cx='1389.8' cy='387.8' rx='415.2' ry='28.3' fill='url(%23l)' opacity='0.28'/%3E%3Cellipse cx='2563.7' cy='369.5' rx='469.3' ry='98.1' fill='url(%23d)' opacity='0.64'/%3E%3Cellipse cx='2515.6' cy='359' rx='398.9' ry='54' fill='url(%23l)' opacity='0.05'/%3E%3Cellipse cx='1572.5' cy='424.4' rx='469' ry='54.8' fill='url(%23d)' opacity='0.54'/%3E%3Cellipse cx='1592.8' cy='404.2' rx='398.6' ry='30.1' fill='url(%23l)' opacity='0.39'/%3E%3Cellipse cx='1960' cy='484.9' rx='405.3' ry='105.2' fill='url(%23d)' opacity='0.54'/%3E%3Cellipse cx='1933' cy='435.3' rx='344.5' ry='57.8' fill='url(%23l)' opacity='0.34'/%3E%3Cellipse cx='1483' cy='449.7' rx='460.6' ry='68.4' fill='url(%23d)' opacity='0.54'/%3E%3Cellipse cx='1510.6' cy='427.5' rx='391.5' ry='37.6' fill='url(%23l)' opacity='0.31'/%3E%3Cellipse cx='698.2' cy='373.4' rx='433' ry='89.3' fill='url(%23d)' opacity='0.47'/%3E%3Cellipse cx='2299' cy='439.9' rx='463.4' ry='109.6' fill='url(%23d)' opacity='0.57'/%3E%3Cellipse cx='2249' cy='415.4' rx='393.9' ry='60.3' fill='url(%23l)' opacity='0.19'/%3E%3Cellipse cx='697.3' cy='647.9' rx='579.8' ry='108.1' fill='url(%23d)' opacity='0.79'/%3E%3Cellipse cx='1401.7' cy='647.2' rx='362.1' ry='92.9' fill='url(%23d)' opacity='0.67'/%3E%3Cellipse cx='1433.3' cy='609.7' rx='307.8' ry='51.1' fill='url(%23l)' opacity='0.05'/%3E%3Cellipse cx='1934.1' cy='694' rx='566.4' ry='75.2' fill='url(%23d)' opacity='0.69'/%3E%3Cellipse cx='1923.9' cy='654.2' rx='481.4' ry='41.4' fill='url(%23l)' opacity='0.07'/%3E%3Cellipse cx='-14.5' cy='604.9' rx='465.4' ry='60.1' fill='url(%23d)' opacity='0.76'/%3E%3Cellipse cx='1309.2' cy='598.2' rx='403.4' ry='105.2' fill='url(%23d)' opacity='0.53'/%3E%3Cellipse cx='1350.8' cy='562.8' rx='342.9' ry='57.8' fill='url(%23l)' opacity='0.06'/%3E%3Cellipse cx='2352' cy='665.2' rx='439.8' ry='71.5' fill='url(%23d)' opacity='0.69'/%3E%3Cellipse cx='421.7' cy='571.1' rx='549.7' ry='81' fill='url(%23d)' opacity='0.73'/%3E%3Cellipse cx='1155.1' cy='650.1' rx='391.5' ry='109.2' fill='url(%23d)' opacity='0.73'/%3E%3Cellipse cx='886.9' cy='649.1' rx='353.5' ry='114.6' fill='url(%23d)' opacity='0.64'/%3E%3Cellipse cx='1483.5' cy='651.9' rx='293.3' ry='80' fill='url(%23d)' opacity='0.73'/%3E%3Cellipse cx='1507.1' cy='616.4' rx='249.3' ry='44' fill='url(%23l)' opacity='0.07'/%3E%3Cellipse cx='1449.3' cy='599.2' rx='316.2' ry='112.1' fill='url(%23d)' opacity='0.74'/%3E%3Cellipse cx='1487.3' cy='553.9' rx='268.8' ry='61.6' fill='url(%23l)' opacity='0.12'/%3E%3Cellipse cx='2277' cy='588.3' rx='446.5' ry='86.3' fill='url(%23d)' opacity='0.63'/%3E%3Cellipse cx='2243' cy='559.2' rx='379.6' ry='47.5' fill='url(%23l)' opacity='0.08'/%3E%3Cellipse cx='810.6' cy='662.5' rx='454.7' ry='64.4' fill='url(%23d)' opacity='0.51'/%3E%3Cellipse cx='295.3' cy='689.7' rx='552.7' ry='100.3' fill='url(%23d)' opacity='0.61'/%3E%3C/svg%3E\") center / 100% 100% no-repeat;\nanimation: aur-bm-clouds 160s steps(3200) infinite alternate;\n}\n@keyframes aur-bm-clouds { from { transform: translate3d(-2.5%, 0, 0); } to { transform: translate3d(2.5%, 0, 0); } }\n.aur-root[data-fx=\"blackmetal\"] .aur-fx-a::after {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: radial-gradient(38% 34% at 26% 42%, rgba(205, 220, 236, 0.34), transparent 70%), radial-gradient(30% 26% at 62% 30%, rgba(205, 220, 236, 0.2), transparent 70%);\nopacity: 0;\nanimation: aur-bm-lightning 23s linear infinite;\n}\n.aur-root[data-fx=\"blackmetal\"][data-gap=\"on\"] .aur-fx-a::after { animation-duration: 8s; }\n@keyframes aur-bm-lightning {\n0%, 93.9%, 94.6%, 95.4%, 96.6%, 100% { opacity: 0; }\n94.2% { opacity: 1; }\n95.1% { opacity: 0.45; }\n95.9% { opacity: 0.8; }\n}\n.aur-root[data-fx=\"blackmetal\"] .aur-fx-b {\ndisplay: block;\nleft: 0;\nright: 0;\nbottom: 7vh;\nheight: 50vh;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2400 600' preserveAspectRatio='none'%3E%3Cdefs%3E%3ClinearGradient id='fr' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%234c5864'/%3E%3Cstop offset='.45' stop-color='%232b343d'/%3E%3Cstop offset='1' stop-color='%231a2026'/%3E%3C/linearGradient%3E%3ClinearGradient id='mr' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%23e2e9ef'/%3E%3Cstop offset='.1' stop-color='%23b4c2cd'/%3E%3Cstop offset='.24' stop-color='%235a6671'/%3E%3Cstop offset='.42' stop-color='%2328313a'/%3E%3Cstop offset='1' stop-color='%230d1115'/%3E%3C/linearGradient%3E%3ClinearGradient id='hz' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='.45' stop-color='%239fb0bf' stop-opacity='0'/%3E%3Cstop offset='1' stop-color='%239fb0bf' stop-opacity='.22'/%3E%3C/linearGradient%3E%3Cpath id='f' d='M0 600L0 290 19 293 38 292 56 288 75 287 94 287 112 286 131 286 150 296 169 298 188 310 206 308 225 312 244 329 262 339 281 349 300 365 319 374 338 380 356 388 375 390 394 400 412 404 431 412 450 422 469 423 488 425 506 421 525 415 544 417 562 413 581 406 600 404 619 408 638 409 656 407 675 401 694 400 712 393 731 380 750 375 769 373 788 364 806 360 825 363 844 355 862 350 881 349 900 346 919 345 938 337 956 339 975 343 994 351 1012 351 1031 362 1050 373 1069 371 1088 373 1106 379 1125 387 1144 384 1162 385 1181 384 1200 388 1219 390 1238 395 1256 398 1275 397 1294 401 1312 397 1331 400 1350 406 1369 406 1388 412 1406 415 1425 412 1444 411 1462 408 1481 408 1500 409 1519 397 1538 389 1556 383 1575 375 1594 377 1612 375 1631 371 1650 368 1669 361 1688 356 1706 348 1725 349 1744 356 1762 356 1781 360 1800 372 1819 373 1838 375 1856 380 1875 380 1894 377 1912 380 1931 379 1950 375 1969 377 1988 372 2006 376 2025 377 2044 384 2062 386 2081 380 2100 378 2119 373 2138 367 2156 363 2175 362 2194 363 2212 359 2231 352 2250 348 2269 346 2288 346 2306 345 2325 336 2344 327 2362 312 2381 313 2400 306 2400 600Z'/%3E%3Cpath id='m' d='M0 600L0 368 19 362 38 355 56 347 75 343 94 327 112 311 131 299 150 289 169 270 188 244 206 220 225 204 244 192 262 179 281 160 300 150 319 145 338 136 356 133 375 146 394 140 412 143 431 135 450 134 469 125 488 113 506 110 525 124 544 130 562 138 581 152 600 175 619 182 638 196 656 199 675 203 694 213 712 212 731 219 750 227 769 237 788 237 806 240 825 251 844 266 862 271 881 277 900 285 919 294 938 307 956 320 975 327 994 339 1012 344 1031 349 1050 361 1069 363 1088 369 1106 380 1125 387 1144 389 1162 392 1181 390 1200 390 1219 389 1238 393 1256 385 1275 383 1294 389 1312 393 1331 395 1350 390 1369 388 1388 379 1406 370 1425 361 1444 352 1462 350 1481 345 1500 342 1519 338 1538 327 1556 325 1575 315 1594 304 1612 290 1631 270 1650 255 1669 250 1688 245 1706 237 1725 230 1744 222 1762 212 1781 210 1800 217 1819 206 1838 181 1856 178 1875 164 1894 156 1912 161 1931 162 1950 171 1969 184 1988 187 2006 193 2025 207 2044 219 2062 219 2081 218 2100 219 2119 237 2138 249 2156 267 2175 279 2194 279 2212 285 2231 296 2250 310 2269 322 2288 339 2306 349 2325 355 2344 371 2362 382 2381 392 2400 406 2400 600Z'/%3E%3C/defs%3E%3Cuse href='%23f' fill='url(%23fr)' opacity='.85'/%3E%3Cuse href='%23f' fill='url(%23hz)'/%3E%3Cuse href='%23m' fill='url(%23mr)'/%3E%3Cpath d='M342 163L 336 174 329 183 320 198 M376 169L 383 183 388 192 399 203 405 220 414 229 M391 145L 396 156 400 167 406 177 M469 139L 458 156 448 173 439 186 430 203 420 214 M520 149L 526 166 537 178 541 190 551 202 555 212 564 226 M536 127L 546 144 550 153 560 163 M480 122L 472 140 464 148 453 161 M1886 178L 1880 195 1873 211 1867 221 1859 230 1852 243 1845 258 M1898 167L 1904 179 1910 190 1920 198 1927 210 M1912 174L 1916 184 1925 197 1935 209 1945 218 1953 228 1959 245 M1874 191L 1868 203 1862 215 1854 230 1847 243 1839 260' fill='none' stroke='%230c1014' stroke-opacity='.32' stroke-width='1.3' stroke-linejoin='round' vector-effect='non-scaling-stroke'/%3E%3Cpath d='M383 168L 390 185 398 198 409 215 420 226 428 239 M341 150L 334 162 326 176 319 190 309 202 301 217 M527 135L 535 147 545 160 549 172 558 183 567 194 M492 139L 482 151 472 169 462 184 454 197 444 212 M543 145L 550 161 559 171 566 186 573 194 M1929 196L 1939 208 1945 220 1952 235 M1880 188L 1870 199 1864 207 1859 224 1854 241 M1911 180L 1917 188 1922 200 1929 210 1936 225 1941 235' fill='none' stroke='%23e6edf2' stroke-opacity='.22' stroke-width='1.1' stroke-linejoin='round' vector-effect='non-scaling-stroke'/%3E%3Cpath d='M356 133L375 146 M394 140L412 143 M506 110L525 124 M525 124L544 130 M544 130L562 138 M562 138L581 152 M581 152L600 175 M600 175L619 182 M619 182L638 196 M638 196L656 199 M656 199L675 203 M675 203L694 213 M712 212L731 219 M731 219L750 227 M750 227L769 237 M788 237L806 240 M806 240L825 251 M825 251L844 266 M844 266L862 271 M862 271L881 277 M881 277L900 285 M900 285L919 294 M919 294L938 307 M938 307L956 320 M956 320L975 327 M975 327L994 339 M994 339L1012 344 M1012 344L1031 349 M1031 349L1050 361 M1050 361L1069 363 M1069 363L1088 369 M1088 369L1106 380 M1106 380L1125 387 M1125 387L1144 389 M1144 389L1162 392 M1181 390L1200 390 M1219 389L1238 393 M1275 383L1294 389 M1294 389L1312 393 M1312 393L1331 395 M1781 210L1800 217 M1894 156L1912 161 M1912 161L1931 162 M1931 162L1950 171 M1950 171L1969 184 M1969 184L1988 187 M1988 187L2006 193 M2006 193L2025 207 M2025 207L2044 219 M2081 218L2100 219 M2100 219L2119 237 M2119 237L2138 249 M2138 249L2156 267 M2156 267L2175 279 M2194 279L2212 285 M2212 285L2231 296 M2231 296L2250 310 M2250 310L2269 322 M2269 322L2288 339 M2288 339L2306 349 M2306 349L2325 355 M2325 355L2344 371 M2344 371L2362 382 M2362 382L2381 392 M2381 392L2400 406' fill='none' stroke='%23eef3f7' stroke-opacity='.55' stroke-width='1.3' stroke-linecap='round' vector-effect='non-scaling-stroke'/%3E%3Cuse href='%23m' fill='url(%23hz)'/%3E%3C/svg%3E\") center bottom / 100% 100% no-repeat;\n}\n.aur-root[data-fx=\"blackmetal\"] .aur-fx-b::before {\ncontent: \"\";\nposition: absolute;\nleft: 0;\nright: 0;\nbottom: -7vh;\nheight: 34vh;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2400 700'%3E%3Cdefs%3E%3Cpath id='t0' d='M0 0 -17 102 -13 96 -10 97 -7 95 -4 103 -33 162 -26 157 -20 167 -16 159 -8 166 -52 236 -40 228 -33 234 -25 218 -15 232 -61 304 -49 286 -38 295 -30 287 -18 299 -90 369 -68 360 -56 369 -43 358 -27 368 -99 442 -77 428 -62 441 -44 424 -26 437 -103 510 -81 498 -61 511 -50 495 -24 508 -112 584 -88 574 -70 583 -50 568 -31 580 -149 665 -115 645 -89 656 -68 639 -39 652 -148 742 -114 717 -88 734 -70 717 -35 725 -162 809 -127 787 -95 803 -73 785 -48 798 -157 879 -118 868 -98 880 -77 864 -38 872 -218 966 -161 941 -128 959 -105 941 -61 947 -14 950 -14 1000 14 1000 14 950 49 947 76 934 107 953 123 938 170 962 43 872 78 862 108 882 133 864 176 888 33 798 71 787 97 804 117 794 157 806 28 725 65 718 86 727 109 722 137 739 34 652 69 644 99 658 124 649 156 663 29 580 60 574 70 587 96 569 121 586 31 508 55 495 77 511 91 502 122 510 27 437 45 426 59 440 73 428 98 440 15 368 34 358 45 365 59 360 74 369 13 299 29 286 37 298 47 286 62 297 11 232 26 225 32 227 42 224 54 230 10 166 18 154 25 164 28 155 39 162 5 103 10 94 13 103 16 91 20 101Z'/%3E%3Cpath id='s0' d='M0 0Q-12 43 -17 102 M-8 166Q-38 194 -52 236 M-27 368Q-71 401 -99 442 M-26 437Q-69 467 -103 510 M-24 508Q-72 542 -112 584 M-31 580Q-94 616 -149 665 M-35 725Q-106 764 -162 809 M-38 872Q-134 913 -218 966 M0 0Q12 44 20 101 M5 103Q26 129 39 162 M10 166Q38 193 54 230 M13 299Q49 328 74 369 M31 508Q84 539 121 586 M29 580Q96 616 156 663 M34 652Q89 692 137 739 M28 725Q98 759 157 806 M33 798Q112 836 176 888' fill='none' stroke='%238f9daa' stroke-width='6' stroke-linecap='round' stroke-opacity='0.3'/%3E%3Cpath id='t1' d='M0 0 -18 103 -15 92 -12 102 -9 89 -4 103 -40 163 -30 161 -24 163 -18 159 -10 166 -51 236 -39 222 -31 233 -23 222 -13 232 -70 299 -51 296 -45 295 -33 290 -17 299 -91 366 -71 363 -56 368 -41 354 -24 368 -90 438 -67 425 -56 440 -42 430 -21 437 -119 513 -90 501 -73 511 -52 496 -35 508 -106 587 -83 570 -66 587 -52 569 -22 580 -148 657 -111 644 -91 655 -70 640 -31 652 -136 736 -100 719 -82 733 -67 719 -33 725 -166 808 -131 791 -98 809 -74 788 -46 798 -164 891 -129 866 -98 877 -76 866 -36 872 -217 969 -160 943 -131 956 -98 939 -60 947 -14 950 -14 1000 14 1000 14 950 55 947 95 941 120 955 160 944 203 954 43 872 77 867 93 879 118 866 156 888 42 798 77 792 92 802 124 792 156 816 37 725 76 713 103 733 123 721 166 733 32 652 57 642 79 654 93 650 125 658 27 580 51 572 74 583 88 576 115 585 30 508 49 499 58 511 76 503 100 511 25 437 47 427 59 438 79 432 99 440 18 368 34 357 44 369 56 360 72 369 18 299 31 289 37 297 47 287 63 298 13 232 25 223 35 229 42 227 57 231 9 166 18 159 22 166 27 156 38 169 5 103 8 95 11 104 14 99 18 100Z'/%3E%3Cpath id='s1' d='M0 0Q-14 45 -18 103 M-13 232Q-48 258 -70 299 M-17 299Q-57 327 -91 366 M-24 368Q-62 395 -90 438 M-35 508Q-76 545 -106 587 M-22 580Q-88 612 -148 657 M-46 798Q-109 843 -164 891 M-36 872Q-134 916 -217 969 M0 0Q12 44 18 100 M5 103Q28 129 38 169 M13 232Q46 258 63 298 M18 299Q53 327 72 369 M30 508Q79 539 115 585 M32 652Q102 691 166 733 M37 725Q104 764 156 816 M42 798Q102 840 156 888' fill='none' stroke='%238f9daa' stroke-width='6' stroke-linecap='round' stroke-opacity='0.3'/%3E%3Cpath id='t2' d='M0 0 -19 98 -14 92 -12 102 -9 89 -5 103 -40 164 -29 154 -25 165 -19 157 -10 166 -52 231 -39 220 -31 234 -25 222 -11 232 -73 299 -57 290 -46 299 -33 286 -19 299 -93 371 -74 363 -54 370 -45 358 -21 368 -103 442 -81 430 -60 438 -45 431 -30 437 -107 510 -82 503 -63 510 -54 499 -26 508 -113 582 -90 573 -69 586 -55 567 -24 580 -128 667 -96 649 -78 654 -64 645 -38 652 -155 738 -114 716 -99 732 -73 717 -32 725 -162 811 -124 797 -96 807 -74 788 -43 798 -199 888 -153 871 -123 877 -97 861 -53 872 -189 956 -136 944 -117 954 -92 938 -46 947 -14 950 -14 1000 14 1000 14 950 61 947 100 941 129 953 172 942 218 962 39 872 76 861 99 878 117 868 158 886 42 798 66 792 84 803 115 797 144 809 39 725 62 712 84 732 99 715 136 742 34 652 63 644 83 661 104 641 138 656 29 580 65 568 80 583 106 569 133 589 30 508 47 501 61 512 77 498 104 515 26 437 52 424 62 442 77 430 106 447 18 368 39 360 48 366 63 357 79 376 18 299 28 289 37 295 51 291 64 298 13 232 26 217 37 233 44 225 58 233 8 166 17 154 24 160 30 158 38 166 4 103 8 88 9 101 12 95 16 99Z'/%3E%3Cpath id='s2' d='M0 0Q-12 46 -19 98 M-5 103Q-30 129 -40 164 M-10 166Q-38 196 -52 231 M-19 299Q-62 332 -93 371 M-21 368Q-69 401 -103 442 M-30 437Q-74 471 -107 510 M-26 508Q-74 540 -113 582 M-24 580Q-83 616 -128 667 M-43 798Q-129 841 -199 888 M0 0Q14 45 16 99 M4 103Q25 132 38 166 M13 232Q43 262 64 298 M18 299Q54 332 79 376 M30 508Q86 544 133 589 M34 652Q89 691 136 742 M39 725Q99 763 144 809 M42 798Q107 835 158 886 M39 872Q136 910 218 962' fill='none' stroke='%238f9daa' stroke-width='6' stroke-linecap='round' stroke-opacity='0.3'/%3E%3ClinearGradient id='fg' x1='0' y1='0' x2='0' y2='700' gradientUnits='userSpaceOnUse'%3E%3Cstop offset='.55' stop-color='%2346525c'/%3E%3Cstop offset='.8' stop-color='%23303a43'/%3E%3C/linearGradient%3E%3ClinearGradient id='mg' x1='0' y1='0' x2='0' y2='700' gradientUnits='userSpaceOnUse'%3E%3Cstop offset='.45' stop-color='%2326303a'/%3E%3Cstop offset='1' stop-color='%230d1115'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cg fill='url(%23fg)'%3E%3Cpath d='M0 700L0 520 -8 520 16 407 39 520 13 514 30 452 47 514 34 517 51 440 69 517 46 515 67 411 88 515 66 522 80 458 95 522 87 523 98 470 110 523 92 519 112 431 132 519 107 519 129 426 151 519 136 513 154 427 172 513 162 522 179 443 196 522 175 515 200 419 225 515 195 520 217 414 240 520 209 522 232 429 255 522 239 514 256 433 273 514 259 522 276 441 292 522 275 515 295 421 315 515 293 517 308 448 323 517 299 514 326 411 353 514 330 523 344 466 358 523 338 512 360 413 382 512 368 517 383 448 398 517 382 517 399 443 416 517 406 513 420 448 433 513 416 521 434 439 452 521 428 513 454 418 479 513 454 518 467 463 479 518 471 512 489 442 508 512 498 512 513 453 529 512 512 518 539 420 565 518 528 513 554 400 580 513 556 514 575 434 594 514 570 513 590 428 609 513 584 517 608 421 632 517 611 514 626 444 642 514 632 520 645 467 658 520 656 517 666 470 677 517 652 518 680 405 709 518 690 518 703 459 715 518 707 519 725 428 743 519 724 523 750 426 776 523 750 523 766 457 782 523 755 518 784 407 813 518 776 515 805 403 833 515 816 523 829 464 842 523 838 519 853 452 868 519 852 520 877 427 902 520 881 517 901 429 920 517 899 515 920 433 941 515 913 517 934 420 955 517 926 515 948 412 971 515 954 522 972 441 989 522 971 521 990 450 1009 521 997 519 1013 456 1029 519 1019 521 1037 450 1055 521 1032 523 1055 432 1078 523 1059 519 1080 419 1101 519 1090 522 1102 470 1113 522 1104 519 1126 409 1149 519 1130 512 1151 422 1171 512 1150 516 1176 411 1201 516 1174 519 1199 417 1225 519 1202 516 1216 450 1231 516 1223 516 1236 463 1249 516 1237 517 1251 454 1266 517 1263 515 1274 463 1286 515 1270 513 1290 415 1310 513 1285 518 1310 422 1335 518 1300 517 1327 411 1354 517 1318 522 1348 412 1377 522 1347 514 1362 446 1378 514 1372 518 1385 469 1398 518 1386 518 1406 444 1426 518 1404 523 1431 413 1458 523 1432 518 1450 447 1468 518 1446 513 1467 421 1489 513 1470 518 1491 438 1513 518 1502 518 1516 453 1530 518 1514 513 1539 411 1564 513 1547 522 1557 475 1568 522 1552 514 1575 420 1598 514 1586 518 1597 468 1608 518 1586 519 1611 406 1637 519 1623 512 1637 460 1651 512 1633 516 1658 425 1682 516 1662 514 1683 423 1704 514 1683 516 1699 446 1715 516 1705 512 1723 441 1740 512 1713 515 1738 421 1762 515 1737 516 1751 455 1765 516 1755 521 1771 455 1787 521 1771 515 1794 418 1818 515 1801 517 1818 452 1835 517 1820 516 1840 436 1859 516 1838 519 1860 422 1882 519 1861 518 1879 440 1897 518 1889 521 1901 464 1913 521 1890 514 1915 414 1941 514 1920 514 1937 451 1953 514 1939 514 1951 467 1963 514 1940 520 1968 407 1997 520 1971 521 1989 431 2007 521 1982 522 2006 417 2030 522 1996 518 2019 404 2043 518 2010 523 2038 409 2067 523 2047 514 2063 439 2079 514 2058 516 2085 404 2113 516 2086 520 2106 429 2126 520 2112 517 2122 470 2131 517 2130 520 2144 459 2158 520 2140 516 2160 435 2180 516 2153 514 2176 421 2199 514 2176 521 2199 430 2223 521 2198 519 2219 424 2240 519 2217 522 2233 453 2249 522 2226 523 2255 414 2283 523 2255 514 2276 426 2296 514 2281 515 2299 427 2318 515 2292 514 2315 419 2338 514 2318 517 2337 432 2355 517 2351 519 2363 464 2375 519 2362 520 2387 411 2412 520 2383 519 2401 447 2420 519 2400 520 2400 700Z'/%3E%3C/g%3E%3Crect y='515' width='2400' height='185' fill='%232a333c' opacity='.9'/%3E%3Cg fill='url(%23mg)'%3E%3Cuse href='%23t2' transform='translate(58 415) scale(-0.315 0.291)'/%3E%3Cuse href='%23s2' transform='translate(58 415) scale(-0.315 0.291)'/%3E%3Cuse href='%23t2' transform='translate(126 516) scale(-0.182 0.184)'/%3E%3Cuse href='%23s2' transform='translate(126 516) scale(-0.182 0.184)'/%3E%3Cuse href='%23t2' transform='translate(157 446) scale(0.226 0.261)'/%3E%3Cuse href='%23s2' transform='translate(157 446) scale(0.226 0.261)'/%3E%3Cuse href='%23t0' transform='translate(210 511) scale(-0.164 0.189)'/%3E%3Cuse href='%23s0' transform='translate(210 511) scale(-0.164 0.189)'/%3E%3Cuse href='%23t1' transform='translate(257 469) scale(-0.260 0.235)'/%3E%3Cuse href='%23s1' transform='translate(257 469) scale(-0.260 0.235)'/%3E%3Cuse href='%23t0' transform='translate(322 500) scale(0.206 0.211)'/%3E%3Cuse href='%23s0' transform='translate(322 500) scale(0.206 0.211)'/%3E%3Cuse href='%23t2' transform='translate(373 407) scale(-0.259 0.300)'/%3E%3Cuse href='%23s2' transform='translate(373 407) scale(-0.259 0.300)'/%3E%3Cuse href='%23t2' transform='translate(424 453) scale(0.276 0.258)'/%3E%3Cuse href='%23s2' transform='translate(424 453) scale(0.276 0.258)'/%3E%3Cuse href='%23t2' transform='translate(453 535) scale(-0.158 0.176)'/%3E%3Cuse href='%23s2' transform='translate(453 535) scale(-0.158 0.176)'/%3E%3Cuse href='%23t1' transform='translate(510 510) scale(-0.191 0.197)'/%3E%3Cuse href='%23s1' transform='translate(510 510) scale(-0.191 0.197)'/%3E%3Cuse href='%23t1' transform='translate(555 536) scale(0.150 0.174)'/%3E%3Cuse href='%23s1' transform='translate(555 536) scale(0.150 0.174)'/%3E%3Cuse href='%23t0' transform='translate(614 422) scale(-0.291 0.279)'/%3E%3Cuse href='%23s0' transform='translate(614 422) scale(-0.291 0.279)'/%3E%3Cuse href='%23t0' transform='translate(675 507) scale(0.175 0.201)'/%3E%3Cuse href='%23s0' transform='translate(675 507) scale(0.175 0.201)'/%3E%3Cuse href='%23t1' transform='translate(703 448) scale(0.224 0.253)'/%3E%3Cuse href='%23s1' transform='translate(703 448) scale(0.224 0.253)'/%3E%3Cuse href='%23t2' transform='translate(758 508) scale(0.183 0.199)'/%3E%3Cuse href='%23s2' transform='translate(758 508) scale(0.183 0.199)'/%3E%3Cuse href='%23t2' transform='translate(816 506) scale(-0.198 0.198)'/%3E%3Cuse href='%23s2' transform='translate(816 506) scale(-0.198 0.198)'/%3E%3Cuse href='%23t1' transform='translate(874 522) scale(-0.160 0.182)'/%3E%3Cuse href='%23s1' transform='translate(874 522) scale(-0.160 0.182)'/%3E%3Cuse href='%23t2' transform='translate(935 532) scale(-0.149 0.174)'/%3E%3Cuse href='%23s2' transform='translate(935 532) scale(-0.149 0.174)'/%3E%3Cuse href='%23t2' transform='translate(959 530) scale(-0.168 0.174)'/%3E%3Cuse href='%23s2' transform='translate(959 530) scale(-0.168 0.174)'/%3E%3Cuse href='%23t2' transform='translate(1009 550) scale(0.143 0.161)'/%3E%3Cuse href='%23s2' transform='translate(1009 550) scale(0.143 0.161)'/%3E%3Cuse href='%23t1' transform='translate(1058 570) scale(-0.146 0.135)'/%3E%3Cuse href='%23s1' transform='translate(1058 570) scale(-0.146 0.135)'/%3E%3Cuse href='%23t2' transform='translate(1136 498) scale(0.223 0.204)'/%3E%3Cuse href='%23s2' transform='translate(1136 498) scale(0.223 0.204)'/%3E%3Cuse href='%23t2' transform='translate(1192 567) scale(0.153 0.142)'/%3E%3Cuse href='%23s2' transform='translate(1192 567) scale(0.153 0.142)'/%3E%3Cuse href='%23t1' transform='translate(1222 522) scale(-0.182 0.180)'/%3E%3Cuse href='%23s1' transform='translate(1222 522) scale(-0.182 0.180)'/%3E%3Cuse href='%23t0' transform='translate(1290 575) scale(-0.133 0.135)'/%3E%3Cuse href='%23s0' transform='translate(1290 575) scale(-0.133 0.135)'/%3E%3Cuse href='%23t2' transform='translate(1340 527) scale(0.152 0.174)'/%3E%3Cuse href='%23s2' transform='translate(1340 527) scale(0.152 0.174)'/%3E%3Cuse href='%23t2' transform='translate(1375 531) scale(0.189 0.173)'/%3E%3Cuse href='%23s2' transform='translate(1375 531) scale(0.189 0.173)'/%3E%3Cuse href='%23t0' transform='translate(1412 484) scale(-0.229 0.225)'/%3E%3Cuse href='%23s0' transform='translate(1412 484) scale(-0.229 0.225)'/%3E%3Cuse href='%23t2' transform='translate(1484 533) scale(0.180 0.176)'/%3E%3Cuse href='%23s2' transform='translate(1484 533) scale(0.180 0.176)'/%3E%3Cuse href='%23t0' transform='translate(1518 570) scale(-0.117 0.136)'/%3E%3Cuse href='%23s0' transform='translate(1518 570) scale(-0.117 0.136)'/%3E%3Cuse href='%23t1' transform='translate(1594 530) scale(-0.164 0.173)'/%3E%3Cuse href='%23s1' transform='translate(1594 530) scale(-0.164 0.173)'/%3E%3Cuse href='%23t0' transform='translate(1631 505) scale(-0.222 0.205)'/%3E%3Cuse href='%23s0' transform='translate(1631 505) scale(-0.222 0.205)'/%3E%3Cuse href='%23t2' transform='translate(1696 495) scale(-0.178 0.208)'/%3E%3Cuse href='%23s2' transform='translate(1696 495) scale(-0.178 0.208)'/%3E%3Cuse href='%23t2' transform='translate(1715 460) scale(0.272 0.244)'/%3E%3Cuse href='%23s2' transform='translate(1715 460) scale(0.272 0.244)'/%3E%3Cuse href='%23t2' transform='translate(1798 435) scale(0.276 0.271)'/%3E%3Cuse href='%23s2' transform='translate(1798 435) scale(0.276 0.271)'/%3E%3Cuse href='%23t2' transform='translate(1850 448) scale(-0.236 0.264)'/%3E%3Cuse href='%23s2' transform='translate(1850 448) scale(-0.236 0.264)'/%3E%3Cuse href='%23t0' transform='translate(1891 440) scale(-0.278 0.260)'/%3E%3Cuse href='%23s0' transform='translate(1891 440) scale(-0.278 0.260)'/%3E%3Cuse href='%23t2' transform='translate(1927 533) scale(0.158 0.178)'/%3E%3Cuse href='%23s2' transform='translate(1927 533) scale(0.158 0.178)'/%3E%3Cuse href='%23t1' transform='translate(1969 469) scale(0.249 0.238)'/%3E%3Cuse href='%23s1' transform='translate(1969 469) scale(0.249 0.238)'/%3E%3Cuse href='%23t1' transform='translate(2042 493) scale(-0.226 0.219)'/%3E%3Cuse href='%23s1' transform='translate(2042 493) scale(-0.226 0.219)'/%3E%3Cuse href='%23t0' transform='translate(2082 469) scale(-0.259 0.238)'/%3E%3Cuse href='%23s0' transform='translate(2082 469) scale(-0.259 0.238)'/%3E%3Cuse href='%23t2' transform='translate(2142 449) scale(0.262 0.261)'/%3E%3Cuse href='%23s2' transform='translate(2142 449) scale(0.262 0.261)'/%3E%3Cuse href='%23t2' transform='translate(2194 385) scale(0.273 0.320)'/%3E%3Cuse href='%23s2' transform='translate(2194 385) scale(0.273 0.320)'/%3E%3Cuse href='%23t2' transform='translate(2242 416) scale(-0.298 0.296)'/%3E%3Cuse href='%23s2' transform='translate(2242 416) scale(-0.298 0.296)'/%3E%3Cuse href='%23t2' transform='translate(2279 516) scale(-0.201 0.184)'/%3E%3Cuse href='%23s2' transform='translate(2279 516) scale(-0.201 0.184)'/%3E%3Cuse href='%23t1' transform='translate(2352 422) scale(-0.315 0.285)'/%3E%3Cuse href='%23s1' transform='translate(2352 422) scale(-0.315 0.285)'/%3E%3C/g%3E%3C/svg%3E\") left bottom / auto 100% repeat-x;\n}\n.aur-root[data-fx=\"blackmetal\"] .aur-fx-b::after {\ncontent: \"\";\nposition: absolute;\nleft: -25%;\nright: -25%;\nbottom: -7vh;\nheight: 44vh;\nbackground:\nradial-gradient(18% 11% at 39% 38%, rgba(186, 199, 211, 0.075), transparent 70%),\nradial-gradient(20% 21% at 83% 68%, rgba(186, 199, 211, 0.088), transparent 70%),\nradial-gradient(23% 13% at 14% 35%, rgba(186, 199, 211, 0.087), transparent 70%),\nradial-gradient(29% 20% at 84% 70%, rgba(186, 199, 211, 0.085), transparent 70%),\nradial-gradient(19% 18% at 76% 73%, rgba(186, 199, 211, 0.140), transparent 70%),\nradial-gradient(15% 17% at 69% 55%, rgba(186, 199, 211, 0.084), transparent 70%),\nradial-gradient(22% 11% at 98% 73%, rgba(186, 199, 211, 0.114), transparent 70%),\nradial-gradient(19% 21% at 58% 74%, rgba(186, 199, 211, 0.138), transparent 70%),\nradial-gradient(22% 15% at 61% 52%, rgba(186, 199, 211, 0.083), transparent 70%),\nradial-gradient(19% 20% at -0% 32%, rgba(186, 199, 211, 0.120), transparent 70%),\nradial-gradient(18% 16% at 47% 47%, rgba(186, 199, 211, 0.150), transparent 70%),\nradial-gradient(17% 15% at 17% 62%, rgba(186, 199, 211, 0.092), transparent 70%);\ntransform-origin: 50% 100%;\nanimation: aur-bm-fog 90s steps(2700) infinite alternate;\n}\n@keyframes aur-bm-fog { from { transform: translate3d(-6%, 0, 0); } to { transform: translate3d(6%, 0, 0); } }\n.aur-root[data-fx=\"blackmetal\"] .aur-fx-c {\ndisplay: block;\ninset: 0;\nbackground:\nradial-gradient(ellipse at 50% 44%, transparent 42%, rgba(1, 2, 3, 0.6) 82%, rgba(1, 2, 3, 0.86) 100%),\nurl(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 900 1400'%3E%3Cdefs%3E%3Cpath id='t0' d='M0 0 -17 102 -13 96 -10 97 -7 95 -4 103 -33 162 -26 157 -20 167 -16 159 -8 166 -52 236 -40 228 -33 234 -25 218 -15 232 -61 304 -49 286 -38 295 -30 287 -18 299 -90 369 -68 360 -56 369 -43 358 -27 368 -99 442 -77 428 -62 441 -44 424 -26 437 -103 510 -81 498 -61 511 -50 495 -24 508 -112 584 -88 574 -70 583 -50 568 -31 580 -149 665 -115 645 -89 656 -68 639 -39 652 -148 742 -114 717 -88 734 -70 717 -35 725 -162 809 -127 787 -95 803 -73 785 -48 798 -157 879 -118 868 -98 880 -77 864 -38 872 -218 966 -161 941 -128 959 -105 941 -61 947 -14 950 -14 1000 14 1000 14 950 49 947 76 934 107 953 123 938 170 962 43 872 78 862 108 882 133 864 176 888 33 798 71 787 97 804 117 794 157 806 28 725 65 718 86 727 109 722 137 739 34 652 69 644 99 658 124 649 156 663 29 580 60 574 70 587 96 569 121 586 31 508 55 495 77 511 91 502 122 510 27 437 45 426 59 440 73 428 98 440 15 368 34 358 45 365 59 360 74 369 13 299 29 286 37 298 47 286 62 297 11 232 26 225 32 227 42 224 54 230 10 166 18 154 25 164 28 155 39 162 5 103 10 94 13 103 16 91 20 101Z'/%3E%3Cpath id='s0' d='M0 0Q-12 43 -17 102 M-8 166Q-38 194 -52 236 M-27 368Q-71 401 -99 442 M-26 437Q-69 467 -103 510 M-24 508Q-72 542 -112 584 M-31 580Q-94 616 -149 665 M-35 725Q-106 764 -162 809 M-38 872Q-134 913 -218 966 M0 0Q12 44 20 101 M5 103Q26 129 39 162 M10 166Q38 193 54 230 M13 299Q49 328 74 369 M31 508Q84 539 121 586 M29 580Q96 616 156 663 M34 652Q89 692 137 739 M28 725Q98 759 157 806 M33 798Q112 836 176 888' fill='none' stroke='%23c9d4dd' stroke-width='5' stroke-linecap='round' stroke-opacity='0.36'/%3E%3Cpath id='t1' d='M0 0 -18 103 -15 92 -12 102 -9 89 -4 103 -40 163 -30 161 -24 163 -18 159 -10 166 -51 236 -39 222 -31 233 -23 222 -13 232 -70 299 -51 296 -45 295 -33 290 -17 299 -91 366 -71 363 -56 368 -41 354 -24 368 -90 438 -67 425 -56 440 -42 430 -21 437 -119 513 -90 501 -73 511 -52 496 -35 508 -106 587 -83 570 -66 587 -52 569 -22 580 -148 657 -111 644 -91 655 -70 640 -31 652 -136 736 -100 719 -82 733 -67 719 -33 725 -166 808 -131 791 -98 809 -74 788 -46 798 -164 891 -129 866 -98 877 -76 866 -36 872 -217 969 -160 943 -131 956 -98 939 -60 947 -14 950 -14 1000 14 1000 14 950 55 947 95 941 120 955 160 944 203 954 43 872 77 867 93 879 118 866 156 888 42 798 77 792 92 802 124 792 156 816 37 725 76 713 103 733 123 721 166 733 32 652 57 642 79 654 93 650 125 658 27 580 51 572 74 583 88 576 115 585 30 508 49 499 58 511 76 503 100 511 25 437 47 427 59 438 79 432 99 440 18 368 34 357 44 369 56 360 72 369 18 299 31 289 37 297 47 287 63 298 13 232 25 223 35 229 42 227 57 231 9 166 18 159 22 166 27 156 38 169 5 103 8 95 11 104 14 99 18 100Z'/%3E%3Cpath id='s1' d='M0 0Q-14 45 -18 103 M-13 232Q-48 258 -70 299 M-17 299Q-57 327 -91 366 M-24 368Q-62 395 -90 438 M-35 508Q-76 545 -106 587 M-22 580Q-88 612 -148 657 M-46 798Q-109 843 -164 891 M-36 872Q-134 916 -217 969 M0 0Q12 44 18 100 M5 103Q28 129 38 169 M13 232Q46 258 63 298 M18 299Q53 327 72 369 M30 508Q79 539 115 585 M32 652Q102 691 166 733 M37 725Q104 764 156 816 M42 798Q102 840 156 888' fill='none' stroke='%23c9d4dd' stroke-width='5' stroke-linecap='round' stroke-opacity='0.36'/%3E%3Cpath id='t2' d='M0 0 -19 98 -14 92 -12 102 -9 89 -5 103 -40 164 -29 154 -25 165 -19 157 -10 166 -52 231 -39 220 -31 234 -25 222 -11 232 -73 299 -57 290 -46 299 -33 286 -19 299 -93 371 -74 363 -54 370 -45 358 -21 368 -103 442 -81 430 -60 438 -45 431 -30 437 -107 510 -82 503 -63 510 -54 499 -26 508 -113 582 -90 573 -69 586 -55 567 -24 580 -128 667 -96 649 -78 654 -64 645 -38 652 -155 738 -114 716 -99 732 -73 717 -32 725 -162 811 -124 797 -96 807 -74 788 -43 798 -199 888 -153 871 -123 877 -97 861 -53 872 -189 956 -136 944 -117 954 -92 938 -46 947 -14 950 -14 1000 14 1000 14 950 61 947 100 941 129 953 172 942 218 962 39 872 76 861 99 878 117 868 158 886 42 798 66 792 84 803 115 797 144 809 39 725 62 712 84 732 99 715 136 742 34 652 63 644 83 661 104 641 138 656 29 580 65 568 80 583 106 569 133 589 30 508 47 501 61 512 77 498 104 515 26 437 52 424 62 442 77 430 106 447 18 368 39 360 48 366 63 357 79 376 18 299 28 289 37 295 51 291 64 298 13 232 26 217 37 233 44 225 58 233 8 166 17 154 24 160 30 158 38 166 4 103 8 88 9 101 12 95 16 99Z'/%3E%3Cpath id='s2' d='M0 0Q-12 46 -19 98 M-5 103Q-30 129 -40 164 M-10 166Q-38 196 -52 231 M-19 299Q-62 332 -93 371 M-21 368Q-69 401 -103 442 M-30 437Q-74 471 -107 510 M-26 508Q-74 540 -113 582 M-24 580Q-83 616 -128 667 M-43 798Q-129 841 -199 888 M0 0Q14 45 16 99 M4 103Q25 132 38 166 M13 232Q43 262 64 298 M18 299Q54 332 79 376 M30 508Q86 544 133 589 M34 652Q89 691 136 742 M39 725Q99 763 144 809 M42 798Q107 835 158 886 M39 872Q136 910 218 962' fill='none' stroke='%23c9d4dd' stroke-width='5' stroke-linecap='round' stroke-opacity='0.36'/%3E%3C/defs%3E%3Cg fill='%23030405'%3E%3Cuse href='%23t1' transform='translate(1 238) scale(1.169 1.172)'/%3E%3Cuse href='%23s1' transform='translate(1 238) scale(1.169 1.172)'/%3E%3Cuse href='%23t0' transform='translate(316 404) scale(1.039 1.006)'/%3E%3Cuse href='%23s0' transform='translate(316 404) scale(1.039 1.006)'/%3E%3Cuse href='%23t1' transform='translate(496 706) scale(0.752 0.704)'/%3E%3Cuse href='%23s1' transform='translate(496 706) scale(0.752 0.704)'/%3E%3Cuse href='%23t0' transform='translate(645 865) scale(-0.541 0.545)'/%3E%3Cuse href='%23s0' transform='translate(645 865) scale(-0.541 0.545)'/%3E%3Cuse href='%23t0' transform='translate(805 1124) scale(-0.245 0.286)'/%3E%3Cuse href='%23s0' transform='translate(805 1124) scale(-0.245 0.286)'/%3E%3C/g%3E%3C/svg%3E\") left bottom / auto 76vh no-repeat,\nurl(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 900 1400'%3E%3Cdefs%3E%3Cpath id='t0' d='M0 0 -17 102 -13 96 -10 97 -7 95 -4 103 -33 162 -26 157 -20 167 -16 159 -8 166 -52 236 -40 228 -33 234 -25 218 -15 232 -61 304 -49 286 -38 295 -30 287 -18 299 -90 369 -68 360 -56 369 -43 358 -27 368 -99 442 -77 428 -62 441 -44 424 -26 437 -103 510 -81 498 -61 511 -50 495 -24 508 -112 584 -88 574 -70 583 -50 568 -31 580 -149 665 -115 645 -89 656 -68 639 -39 652 -148 742 -114 717 -88 734 -70 717 -35 725 -162 809 -127 787 -95 803 -73 785 -48 798 -157 879 -118 868 -98 880 -77 864 -38 872 -218 966 -161 941 -128 959 -105 941 -61 947 -14 950 -14 1000 14 1000 14 950 49 947 76 934 107 953 123 938 170 962 43 872 78 862 108 882 133 864 176 888 33 798 71 787 97 804 117 794 157 806 28 725 65 718 86 727 109 722 137 739 34 652 69 644 99 658 124 649 156 663 29 580 60 574 70 587 96 569 121 586 31 508 55 495 77 511 91 502 122 510 27 437 45 426 59 440 73 428 98 440 15 368 34 358 45 365 59 360 74 369 13 299 29 286 37 298 47 286 62 297 11 232 26 225 32 227 42 224 54 230 10 166 18 154 25 164 28 155 39 162 5 103 10 94 13 103 16 91 20 101Z'/%3E%3Cpath id='s0' d='M0 0Q-12 43 -17 102 M-8 166Q-38 194 -52 236 M-27 368Q-71 401 -99 442 M-26 437Q-69 467 -103 510 M-24 508Q-72 542 -112 584 M-31 580Q-94 616 -149 665 M-35 725Q-106 764 -162 809 M-38 872Q-134 913 -218 966 M0 0Q12 44 20 101 M5 103Q26 129 39 162 M10 166Q38 193 54 230 M13 299Q49 328 74 369 M31 508Q84 539 121 586 M29 580Q96 616 156 663 M34 652Q89 692 137 739 M28 725Q98 759 157 806 M33 798Q112 836 176 888' fill='none' stroke='%23c9d4dd' stroke-width='5' stroke-linecap='round' stroke-opacity='0.36'/%3E%3Cpath id='t1' d='M0 0 -18 103 -15 92 -12 102 -9 89 -4 103 -40 163 -30 161 -24 163 -18 159 -10 166 -51 236 -39 222 -31 233 -23 222 -13 232 -70 299 -51 296 -45 295 -33 290 -17 299 -91 366 -71 363 -56 368 -41 354 -24 368 -90 438 -67 425 -56 440 -42 430 -21 437 -119 513 -90 501 -73 511 -52 496 -35 508 -106 587 -83 570 -66 587 -52 569 -22 580 -148 657 -111 644 -91 655 -70 640 -31 652 -136 736 -100 719 -82 733 -67 719 -33 725 -166 808 -131 791 -98 809 -74 788 -46 798 -164 891 -129 866 -98 877 -76 866 -36 872 -217 969 -160 943 -131 956 -98 939 -60 947 -14 950 -14 1000 14 1000 14 950 55 947 95 941 120 955 160 944 203 954 43 872 77 867 93 879 118 866 156 888 42 798 77 792 92 802 124 792 156 816 37 725 76 713 103 733 123 721 166 733 32 652 57 642 79 654 93 650 125 658 27 580 51 572 74 583 88 576 115 585 30 508 49 499 58 511 76 503 100 511 25 437 47 427 59 438 79 432 99 440 18 368 34 357 44 369 56 360 72 369 18 299 31 289 37 297 47 287 63 298 13 232 25 223 35 229 42 227 57 231 9 166 18 159 22 166 27 156 38 169 5 103 8 95 11 104 14 99 18 100Z'/%3E%3Cpath id='s1' d='M0 0Q-14 45 -18 103 M-13 232Q-48 258 -70 299 M-17 299Q-57 327 -91 366 M-24 368Q-62 395 -90 438 M-35 508Q-76 545 -106 587 M-22 580Q-88 612 -148 657 M-46 798Q-109 843 -164 891 M-36 872Q-134 916 -217 969 M0 0Q12 44 18 100 M5 103Q28 129 38 169 M13 232Q46 258 63 298 M18 299Q53 327 72 369 M30 508Q79 539 115 585 M32 652Q102 691 166 733 M37 725Q104 764 156 816 M42 798Q102 840 156 888' fill='none' stroke='%23c9d4dd' stroke-width='5' stroke-linecap='round' stroke-opacity='0.36'/%3E%3Cpath id='t2' d='M0 0 -19 98 -14 92 -12 102 -9 89 -5 103 -40 164 -29 154 -25 165 -19 157 -10 166 -52 231 -39 220 -31 234 -25 222 -11 232 -73 299 -57 290 -46 299 -33 286 -19 299 -93 371 -74 363 -54 370 -45 358 -21 368 -103 442 -81 430 -60 438 -45 431 -30 437 -107 510 -82 503 -63 510 -54 499 -26 508 -113 582 -90 573 -69 586 -55 567 -24 580 -128 667 -96 649 -78 654 -64 645 -38 652 -155 738 -114 716 -99 732 -73 717 -32 725 -162 811 -124 797 -96 807 -74 788 -43 798 -199 888 -153 871 -123 877 -97 861 -53 872 -189 956 -136 944 -117 954 -92 938 -46 947 -14 950 -14 1000 14 1000 14 950 61 947 100 941 129 953 172 942 218 962 39 872 76 861 99 878 117 868 158 886 42 798 66 792 84 803 115 797 144 809 39 725 62 712 84 732 99 715 136 742 34 652 63 644 83 661 104 641 138 656 29 580 65 568 80 583 106 569 133 589 30 508 47 501 61 512 77 498 104 515 26 437 52 424 62 442 77 430 106 447 18 368 39 360 48 366 63 357 79 376 18 299 28 289 37 295 51 291 64 298 13 232 26 217 37 233 44 225 58 233 8 166 17 154 24 160 30 158 38 166 4 103 8 88 9 101 12 95 16 99Z'/%3E%3Cpath id='s2' d='M0 0Q-12 46 -19 98 M-5 103Q-30 129 -40 164 M-10 166Q-38 196 -52 231 M-19 299Q-62 332 -93 371 M-21 368Q-69 401 -103 442 M-30 437Q-74 471 -107 510 M-26 508Q-74 540 -113 582 M-24 580Q-83 616 -128 667 M-43 798Q-129 841 -199 888 M0 0Q14 45 16 99 M4 103Q25 132 38 166 M13 232Q43 262 64 298 M18 299Q54 332 79 376 M30 508Q86 544 133 589 M34 652Q89 691 136 742 M39 725Q99 763 144 809 M42 798Q107 835 158 886 M39 872Q136 910 218 962' fill='none' stroke='%23c9d4dd' stroke-width='5' stroke-linecap='round' stroke-opacity='0.36'/%3E%3C/defs%3E%3Cg fill='%23030405'%3E%3Cuse href='%23t2' transform='translate(923 219) scale(-1.270 1.191)'/%3E%3Cuse href='%23s2' transform='translate(923 219) scale(-1.270 1.191)'/%3E%3Cuse href='%23t0' transform='translate(581 481) scale(-0.844 0.929)'/%3E%3Cuse href='%23s0' transform='translate(581 481) scale(-0.844 0.929)'/%3E%3Cuse href='%23t0' transform='translate(366 618) scale(-0.692 0.792)'/%3E%3Cuse href='%23s0' transform='translate(366 618) scale(-0.692 0.792)'/%3E%3Cuse href='%23t2' transform='translate(226 919) scale(0.489 0.491)'/%3E%3Cuse href='%23s2' transform='translate(226 919) scale(0.489 0.491)'/%3E%3Cuse href='%23t1' transform='translate(94 1126) scale(0.302 0.284)'/%3E%3Cuse href='%23s1' transform='translate(94 1126) scale(0.302 0.284)'/%3E%3C/g%3E%3C/svg%3E\") right bottom / auto 76vh no-repeat;\n}\n.aur-root[data-fx=\"blackmetal\"] .aur-fx-c::before {\ncontent: \"\";\nposition: absolute;\nleft: -25%;\nright: -25%;\nbottom: 0;\nheight: 30vh;\nbackground:\nradial-gradient(25% 24% at 10% 94%, rgba(186, 199, 211, 0.050), transparent 70%),\nradial-gradient(26% 32% at 4% 80%, rgba(186, 199, 211, 0.087), transparent 70%),\nradial-gradient(19% 24% at 72% 75%, rgba(186, 199, 211, 0.094), transparent 70%),\nradial-gradient(21% 22% at 7% 78%, rgba(186, 199, 211, 0.105), transparent 70%),\nradial-gradient(27% 30% at 37% 89%, rgba(186, 199, 211, 0.056), transparent 70%),\nradial-gradient(23% 29% at 75% 74%, rgba(186, 199, 211, 0.055), transparent 70%),\nradial-gradient(22% 21% at 26% 91%, rgba(186, 199, 211, 0.062), transparent 70%),\nradial-gradient(32% 32% at 1% 72%, rgba(186, 199, 211, 0.080), transparent 70%),\nradial-gradient(18% 25% at 95% 60%, rgba(186, 199, 211, 0.086), transparent 70%),\nlinear-gradient(to top, rgba(160, 174, 188, 0.1), transparent 70%);\nanimation: aur-bm-fog 70s steps(2100) infinite alternate-reverse;\n}\n.aur-root[data-fx=\"blackmetal\"] .aur-fx-c::after,\n.aur-root[data-fx=\"blackmetal\"] .aur-fx::after {\ncontent: \"\";\nposition: absolute;\nleft: -10%;\nright: -10%;\ntop: -520px;\nbottom: 0;\npointer-events: none;\n}\n.aur-root[data-fx=\"blackmetal\"] .aur-fx-c::after {\nbackground: radial-gradient(8.2px 8.2px at 252px 136px, rgba(235, 242, 248, 0.51), rgba(235, 242, 248, 0.18) 45%, transparent 100%),\nradial-gradient(5.0px 5.0px at 245px 395px, rgba(235, 242, 248, 0.48), rgba(235, 242, 248, 0.17) 45%, transparent 100%),\nradial-gradient(6.5px 6.5px at 142px 417px, rgba(235, 242, 248, 0.50), rgba(235, 242, 248, 0.18) 45%, transparent 100%),\nradial-gradient(7.9px 7.9px at 280px 355px, rgba(235, 242, 248, 0.43), rgba(235, 242, 248, 0.15) 45%, transparent 100%),\nradial-gradient(5.8px 5.8px at 419px 138px, rgba(235, 242, 248, 0.46), rgba(235, 242, 248, 0.16) 45%, transparent 100%);\nbackground-size: 520px 520px;\nanimation: aur-bm-snow-near 7s steps(210) infinite;\n}\n.aur-root[data-fx=\"blackmetal\"] .aur-fx::after {\nbackground:\nradial-gradient(2.1px 2.1px at 254px 302px, rgba(235, 242, 248, 0.76), transparent),\nradial-gradient(2.2px 2.2px at 9px 149px, rgba(235, 242, 248, 0.82), transparent),\nradial-gradient(2.3px 2.3px at 288px 36px, rgba(235, 242, 248, 0.73), transparent),\nradial-gradient(1.9px 1.9px at 174px 184px, rgba(235, 242, 248, 0.59), transparent),\nradial-gradient(1.5px 1.5px at 89px 293px, rgba(235, 242, 248, 0.58), transparent),\nradial-gradient(2.2px 2.2px at 255px 44px, rgba(235, 242, 248, 0.56), transparent),\nradial-gradient(2.1px 2.1px at 1px 279px, rgba(235, 242, 248, 0.54), transparent),\nradial-gradient(1.7px 1.7px at 314px 279px, rgba(235, 242, 248, 0.58), transparent),\nradial-gradient(1.8px 1.8px at 173px 217px, rgba(235, 242, 248, 0.84), transparent),\nradial-gradient(1.7px 1.7px at 221px 309px, rgba(235, 242, 248, 0.83), transparent),\nradial-gradient(2.3px 2.3px at 116px 53px, rgba(235, 242, 248, 0.60), transparent),\nradial-gradient(0.9px 0.9px at 40px 226px, rgba(235, 242, 248, 0.59), transparent),\nradial-gradient(0.9px 0.9px at 320px 67px, rgba(235, 242, 248, 0.37), transparent),\nradial-gradient(1.2px 1.2px at 145px 158px, rgba(235, 242, 248, 0.44), transparent),\nradial-gradient(0.9px 0.9px at 29px 75px, rgba(235, 242, 248, 0.55), transparent),\nradial-gradient(0.8px 0.8px at 130px 289px, rgba(235, 242, 248, 0.38), transparent),\nradial-gradient(1.0px 1.0px at 83px 317px, rgba(235, 242, 248, 0.33), transparent),\nradial-gradient(0.8px 0.8px at 121px 211px, rgba(235, 242, 248, 0.49), transparent),\nradial-gradient(1.0px 1.0px at 159px 208px, rgba(235, 242, 248, 0.51), transparent),\nradial-gradient(1.3px 1.3px at 45px 21px, rgba(235, 242, 248, 0.47), transparent),\nradial-gradient(1.4px 1.4px at 62px 303px, rgba(235, 242, 248, 0.45), transparent),\nradial-gradient(1.1px 1.1px at 282px 91px, rgba(235, 242, 248, 0.52), transparent),\nradial-gradient(1.0px 1.0px at 43px 245px, rgba(235, 242, 248, 0.56), transparent),\nradial-gradient(0.9px 0.9px at 225px 304px, rgba(235, 242, 248, 0.51), transparent),\nradial-gradient(1.3px 1.3px at 63px 48px, rgba(235, 242, 248, 0.45), transparent),\nradial-gradient(1.1px 1.1px at 23px 289px, rgba(235, 242, 248, 0.45), transparent),\nradial-gradient(1.1px 1.1px at 70px 78px, rgba(235, 242, 248, 0.51), transparent);\nbackground-size: 320px 320px;\nanimation: aur-bm-snow 12s steps(360) infinite;\n}\n.aur-root[data-fx=\"blackmetal\"][data-gap=\"on\"] .aur-fx-c::after { animation-duration: 3.5s; }\n.aur-root[data-fx=\"blackmetal\"][data-gap=\"on\"] .aur-fx::after { animation-duration: 5.5s; }\n@keyframes aur-bm-snow-near { to { transform: translate3d(-110px, 520px, 0); } }\n@keyframes aur-bm-snow { to { transform: translate3d(-50px, 320px, 0); } }\n.aur-root[data-fx=\"blackmetal\"] .aur-bg-grain { inset: -120px; opacity: 0.1; animation: aur-bm-grain 0.42s steps(1) infinite; }\n.aur-root[data-fx=\"blackmetal\"][data-bganim=\"off\"] .aur-bg-grain { animation: none; }\n@keyframes aur-bm-grain {\n0% { transform: translate3d(0, 0, 0); }\n25% { transform: translate3d(-47px, 31px, 0); }\n50% { transform: translate3d(29px, -53px, 0); }\n75% { transform: translate3d(-18px, -22px, 0); }\n}\n.aur-root[data-look=\"blackmetal\"] .aur-blob { filter: blur(var(--aur-bg-blur)) grayscale(1) sepia(0.25) hue-rotate(170deg) saturate(1.3) contrast(1.3) brightness(0.42); }\n.aur-root[data-look=\"blackmetal\"] :is(.aur-art, .aur-cover, .aur-message-art) { filter: grayscale(1) sepia(0.15) hue-rotate(170deg) contrast(1.18) brightness(0.9); }\n.aur-root[data-look=\"blackmetal\"] .aur-bg-gradient { filter: grayscale(1); }\n.aur-root[data-look=\"blackmetal\"] {\n--aur-glow-tint: #cfe0ee;\n--aur-green: #dfe8ef;\n--bm-specks: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='x'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.05' numOctaves='1' seed='4' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .06 0 0 0 0 .07 0 0 0 0 .09 3.4 0 0 0 -2.35'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23x)'/%3E%3C/svg%3E\");\n--bm-thorn: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 600 40'%3E%3Cg fill='%23eef3f6'%3E%3Cpath d='M20 20 Q160 18.4 300 17.6 Q440 18.4 580 20 Q440 21.6 300 22.4 Q160 21.6 20 20Z'/%3E%3Cpath d='M270.9 20 L254.9 7 L262.4 20Z'/%3E%3Cpath d='M239.9 20 L225.3 31.8 L232 20Z'/%3E%3Cpath d='M212.3 20 L199.2 9.4 L205 20Z'/%3E%3Cpath d='M183.3 20 L171.7 29.5 L176.7 20Z'/%3E%3Cpath d='M161 20 L150.8 11.7 L155 20Z'/%3E%3Cpath d='M133 20 L124.2 27.1 L127.7 20Z'/%3E%3Cpath d='M106 20 L98.7 14.1 L101.3 20Z'/%3E%3Cpath d='M77.7 20 L71.9 24.7 L73.7 20Z'/%3E%3Cpath d='M46 20 L41.7 16.5 L42.6 20Z'/%3E%3Cpath d='M328 20 L344 7 L336.5 20Z'/%3E%3Cpath d='M358.9 20 L373.4 31.8 L366.8 20Z'/%3E%3Cpath d='M384 20 L397.1 9.4 L391.2 20Z'/%3E%3Cpath d='M412.3 20 L423.9 29.5 L418.9 20Z'/%3E%3Cpath d='M441 20 L451.2 11.7 L447 20Z'/%3E%3Cpath d='M471.9 20 L480.6 27.1 L477.2 20Z'/%3E%3Cpath d='M497.7 20 L505 14.1 L502.4 20Z'/%3E%3Cpath d='M520.6 20 L526.4 24.7 L524.6 20Z'/%3E%3Cpath d='M550.3 20 L554.7 16.5 L553.7 20Z'/%3E%3Cpath d='M300 1 L304 16 L300 20 L296 16Z M300 39 L304 24 L300 20 L296 24Z M285 20 L296 17.5 L300 20 L296 22.5Z M315 20 L304 17.5 L300 20 L304 22.5Z'/%3E%3Cpath d='M300 20 L310 8 L303 18Z M300 20 L290 8 L297 18Z M300 20 L310 32 L303 22Z M300 20 L290 32 L297 22Z' opacity='.7'/%3E%3C/g%3E%3C/svg%3E\");\n--bm-frost: linear-gradient(180deg, #ffffff 8%, #edf3f7 55%, #b3c6d6 100%);\n}\n.aur-root[data-look=\"blackmetal\"][data-color=\"white\"] { --aur-hi: #e9eff3; }\n.aur-root[data-look=\"blackmetal\"][data-words=\"on\"] .aur-stage .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--bm-a: clamp(0, var(--e) * 2.2, 1);\ncolor: transparent;\nbackground-image:\nvar(--bm-specks),\nlinear-gradient(180deg, color-mix(in srgb, #ffffff calc(var(--bm-a) * 100%), rgba(150, 168, 186, 0.42)) 8%, color-mix(in srgb, #edf3f7 calc(var(--bm-a) * 100%), rgba(150, 168, 186, 0.38)) 55%, color-mix(in srgb, #b3c6d6 calc(var(--bm-a) * 100%), rgba(150, 168, 186, 0.34)) 100%);\nbackground-size: 160px 160px, 100% 100%;\n-webkit-background-clip: text;\nbackground-clip: text;\ntransform: translateY(calc(0.03em - var(--bm-a) * 0.05em)) scale(calc(0.965 + 0.035 * var(--bm-a)));\nfilter: blur(calc((1 - var(--bm-a)) * 0.05em)) drop-shadow(0 0 0.32em color-mix(in oklab, #bcd6ea calc(34% * var(--bm-a) * var(--aur-glow-k)), transparent));\n}\n.aur-root[data-look=\"blackmetal\"] .aur-stage .aur-line.is-active:not(.has-words) .aur-main,\n.aur-root[data-look=\"blackmetal\"][data-words=\"off\"] .aur-stage .aur-line.is-active .aur-main {\ncolor: transparent;\nbackground-image: var(--bm-specks), var(--bm-frost);\nbackground-size: 160px 160px, 100% 100%;\n-webkit-background-clip: text;\nbackground-clip: text;\ntext-shadow: none;\nfilter: drop-shadow(0 0 0.32em rgba(188, 214, 234, 0.3));\n}\n.aur-root[data-look=\"blackmetal\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-gap) .aur-main::after {\ncontent: \"\";\nposition: absolute;\nleft: calc(var(--hx, 0px) + var(--hw, 100%) / 2 - 4.2em);\ntop: calc(var(--hy, 0px) + var(--hh, 100%) + 0.02em);\nwidth: 8.4em;\nheight: 0.56em;\nbackground: var(--bm-thorn) center / 100% 100% no-repeat;\nfilter: drop-shadow(0 0 0.2em rgba(190, 214, 234, 0.35));\nopacity: 0;\ntransform: scaleX(0.5);\ntransition: opacity 0.9s ease 0.15s, transform 1.2s var(--aur-ease) 0.15s;\npointer-events: none;\n}\n.aur-root[data-look=\"blackmetal\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active .aur-main::after { opacity: 0.85; transform: none; }\n.aur-root[data-look=\"blackmetal\"] .aur-dots { gap: 0.36em; }\n.aur-root[data-look=\"blackmetal\"] .aur-dots i { width: 2px; height: 0.6em; border-radius: 1px; background: linear-gradient(#fff, rgba(255, 255, 255, 0.15)); }\n.aur-root[data-fx=\"lounge\"] .aur-fx-a {\ndisplay: block;\ninset: 0;\nbackground: radial-gradient(ellipse at 28% 18%, rgba(255, 170, 90, 0.22), transparent 60%), linear-gradient(rgba(120, 60, 20, 0.1), rgba(40, 15, 5, 0.28));\nanimation: aur-fx-candle 6s ease-in-out infinite;\n}\n@keyframes aur-fx-candle {\n0%, 100% { opacity: 1; }\n12% { opacity: 0.88; }\n19% { opacity: 0.97; }\n34% { opacity: 0.84; }\n47% { opacity: 1; }\n63% { opacity: 0.9; }\n71% { opacity: 0.96; }\n86% { opacity: 0.86; }\n}\n.aur-root[data-fx=\"lounge\"] .aur-fx-b {\ndisplay: block;\ninset: -30% 0 0;\nbackground-image:\nradial-gradient(1.6px 1.6px at 40px 60px, rgba(255, 228, 196, 0.55), transparent),\nradial-gradient(1.2px 1.2px at 170px 210px, rgba(255, 228, 196, 0.45), transparent),\nradial-gradient(2px 2px at 260px 90px, rgba(255, 228, 196, 0.35), transparent),\nradial-gradient(1.3px 1.3px at 110px 280px, rgba(255, 228, 196, 0.4), transparent);\nbackground-size: 320px 320px;\nanimation: aur-fx-rise 60s linear infinite;\n}\n@keyframes aur-fx-rise { to { transform: translateY(-320px); } }\n.aur-root[data-fx=\"lounge\"] .aur-fx-c {\ndisplay: block;\ninset: -25%;\nbackground:\nradial-gradient(30% 18% at 30% 60%, rgba(255, 225, 190, 0.1), transparent 70%),\nradial-gradient(26% 14% at 68% 40%, rgba(255, 215, 175, 0.08), transparent 70%),\nradial-gradient(40% 20% at 50% 78%, rgba(255, 230, 200, 0.07), transparent 70%);\nopacity: 0.8;\ntransition: opacity 3s ease;\nanimation: aur-fx-smoke 45s ease-in-out infinite alternate;\n}\n.aur-root[data-fx=\"lounge\"][data-gap=\"on\"] .aur-fx-c { opacity: 1; }\n.aur-root[data-fx=\"lounge\"][data-bganim=\"on\"][data-lb=\"a\"] .aur-fx-c { animation: aur-fx-smoke 45s ease-in-out infinite alternate, aur-fx-stir-a 3s ease-out; }\n.aur-root[data-fx=\"lounge\"][data-bganim=\"on\"][data-lb=\"b\"] .aur-fx-c { animation: aur-fx-smoke 45s ease-in-out infinite alternate, aur-fx-stir-b 3s ease-out; }\n@keyframes aur-fx-smoke {\nfrom { transform: translate3d(-6%, 3%, 0) scale(1); }\nto { transform: translate3d(7%, -4%, 0) scale(1.15); }\n}\n@keyframes aur-fx-stir-a { from { opacity: 1; } }\n@keyframes aur-fx-stir-b { from { opacity: 1; } }\n.aur-root[data-look=\"lounge\"][data-color=\"white\"] { --aur-hi: #f7e8cf; }\n.aur-root[data-look=\"lounge\"] { --aur-glow-tint: color-mix(in oklab, #ffb070 55%, #fff); }\n@media (min-width: 900px) and (min-height: 540px) {\n.aur-root[data-look=\"lounge\"][data-view=\"vinyl\"] .aur-art-wrap::before,\n.aur-root[data-look=\"lounge\"][data-view=\"vinyl\"] .aur-art-wrap::after {\ncontent: \"\";\nposition: absolute;\nz-index: 2;\npointer-events: none;\n}\n.aur-root[data-look=\"lounge\"][data-view=\"vinyl\"] .aur-art-wrap::before {\nright: -5%;\ntop: -5%;\nwidth: 14%;\nheight: 14%;\nborder-radius: 50%;\nbackground: radial-gradient(circle at 40% 35%, #f3eee4, #9c968c 45%, #4a4640 72%, #2a2826);\nbox-shadow: 0 6px 16px rgba(0, 0, 0, 0.55), inset 0 0 0 1px rgba(255, 255, 255, 0.15);\n}\n.aur-root[data-look=\"lounge\"][data-view=\"vinyl\"] .aur-art-wrap::after {\nleft: 95%;\ntop: 2%;\nwidth: 6%;\nheight: 62%;\nborder-radius: 3px;\nbackground:\nlinear-gradient(#2c2c31, #3d3d44) bottom / 100% 11% no-repeat,\nlinear-gradient(90deg, transparent 38%, #8a857c 38%, #f1ece2 50%, #8a857c 62%, transparent 62%) top / 100% 90% no-repeat;\nfilter: drop-shadow(-6px 10px 8px rgba(0, 0, 0, 0.5));\ntransform-origin: 50% 0;\ntransform: rotate(18deg);\ntransition: transform 1.4s var(--aur-ease);\n}\n.aur-root[data-look=\"lounge\"][data-view=\"vinyl\"][data-playing=\"false\"] .aur-art-wrap::after { transform: rotate(-5deg); }\n}\n.aur-root[data-fx=\"retro\"] .aur-fx-a {\ndisplay: block;\ninset: 0;\nbackground: repeating-linear-gradient(to bottom, rgba(0, 0, 0, 0.3) 0 1px, transparent 1px 3px);\nopacity: 0.55;\nanimation: aur-fx-flicker 0.12s steps(2) infinite;\n}\n@keyframes aur-fx-flicker { 50% { opacity: 0.47; } }\n.aur-root[data-fx=\"retro\"] .aur-fx-b {\ndisplay: block;\ninset: 10px;\nborder-radius: 4.5vmin;\nbackground: radial-gradient(ellipse at 50% 45%, color-mix(in oklab, var(--aur-accent) 10%, transparent), transparent 65%), radial-gradient(ellipse at 50% 50%, transparent 55%, rgba(0, 0, 0, 0.6) 100%);\nbox-shadow:\n0 0 0 40px #050300,\ninset 0 0 3vmin color-mix(in oklab, var(--aur-accent) 12%, transparent),\ninset 0 0 0 1px color-mix(in oklab, var(--aur-accent) 10%, transparent);\n}\n.aur-root[data-fx=\"retro\"] .aur-fx-c {\ndisplay: block;\nleft: 0;\nright: 0;\ntop: 0;\nheight: 22%;\nbackground: linear-gradient(transparent, color-mix(in oklab, var(--aur-accent) 7%, transparent), transparent);\nanimation: aur-fx-roll 8s linear infinite;\n}\n@keyframes aur-fx-roll { from { transform: translateY(-30vh); } to { transform: translateY(130vh); } }\n.aur-root[data-fx=\"retro\"] .aur-bg-grain { opacity: 0.06; }\n.aur-root[data-look=\"retro\"] .aur-stage .aur-line .aur-main {\ntext-shadow:\n0 0 0.08em color-mix(in oklab, var(--aur-accent) 55%, transparent),\n0 0 0.45em color-mix(in oklab, var(--aur-accent) 22%, transparent);\n}\n.aur-root[data-look=\"retro\"][data-motion=\"full\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active .aur-main { animation: aur-fx-glitch 0.32s steps(1); }\n@keyframes aur-fx-glitch {\n0% { transform: translateX(0.06em); text-shadow: -0.05em 0 rgba(255, 40, 90, 0.7), 0.05em 0 rgba(40, 200, 255, 0.7); }\n25% { transform: translateX(-0.04em) skewX(-4deg); }\n50% { transform: translateX(0.02em); text-shadow: 0.03em 0 rgba(255, 40, 90, 0.5), -0.03em 0 rgba(40, 200, 255, 0.5); }\n75%, 100% { transform: none; }\n}\n.aur-root[data-look=\"retro\"][data-words=\"on\"][data-wordanim=\"typewriter\"] .is-active.has-words .aur-w .aur-c::after {\ntop: 0.12em;\nbottom: 0.06em;\nright: -0.6em;\nwidth: 0.52em;\nborder-radius: 0;\nbackground: color-mix(in oklab, var(--aur-accent) 75%, transparent);\n}\n.aur-root[data-look=\"retro\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active:not(.is-gap) .aur-main::after {\ncontent: \"\";\ndisplay: inline-block;\nwidth: 0.5em;\nheight: 0.82em;\nmargin-left: 0.12em;\nvertical-align: -0.08em;\nbackground: var(--aur-hi);\nbox-shadow: 0 0 0.3em color-mix(in oklab, var(--aur-accent) 50%, transparent);\nanimation: aur-fx-blink 1.05s steps(1) infinite;\n}\n.aur-root[data-look=\"retro\"][data-words=\"on\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active.has-words:not(.is-sung) .aur-main::after { opacity: 0; }\n@keyframes aur-fx-blink { 50% { background: transparent; box-shadow: none; } }\n.aur-root[data-look=\"retro\"] .aur-dots i { width: 0.34em; height: 0.56em; border-radius: 0; }\n@property --sw-ph { syntax: \"<number>\"; inherits: false; initial-value: 0; }\n.aur-root[data-fx=\"synthwave\"] {\n--sw-horizon: 74%;\n--sw-d: min(46vmin, 60vw);\n}\n.aur-root[data-fx=\"synthwave\"] .aur-fx {\nbackground: linear-gradient(\nto bottom,\nrgba(5, 3, 20, 0.9) 0%,\nrgba(20, 8, 52, 0.84) 30%,\nrgba(70, 14, 92, 0.76) 52%,\nrgba(170, 34, 118, 0.7) 66%,\nrgba(255, 96, 128, 0.72) calc(var(--sw-horizon) - 0.4%),\nrgba(12, 4, 30, 0.97) var(--sw-horizon),\nrgba(6, 2, 18, 0.98) 100%\n);\n}\n.aur-root[data-fx=\"synthwave\"] .aur-fx::before {\ncontent: \"\";\nposition: absolute;\ninset: 0 0 30% 0;\nbackground:\nradial-gradient(1px 1px at 24.8% 32.5%, rgba(255, 220, 250, 1), transparent),\nradial-gradient(0.8px 0.8px at 62.1% 5.7%, rgba(255, 220, 250, 0.9), transparent),\nradial-gradient(1.7px 1.7px at 54.9% 12.7%, rgba(210, 225, 255, 0.9), transparent),\nradial-gradient(1.7px 1.7px at 82.3% 28.7%, rgba(255, 255, 255, 0.6), transparent),\nradial-gradient(1.4px 1.4px at 62.9% 50.6%, rgba(210, 225, 255, 0.9), transparent),\nradial-gradient(1px 1px at 3.5% 45.5%, rgba(255, 255, 255, 1), transparent),\nradial-gradient(1px 1px at 30.9% 3.7%, rgba(210, 225, 255, 0.9), transparent),\nradial-gradient(1.7px 1.7px at 71.0% 51.2%, rgba(255, 220, 250, 0.9), transparent),\nradial-gradient(1px 1px at 71.9% 34.3%, rgba(255, 255, 255, 0.75), transparent),\nradial-gradient(1px 1px at 5.4% 29.7%, rgba(210, 225, 255, 0.9), transparent),\nradial-gradient(1.2px 1.2px at 84.1% 25.6%, rgba(255, 220, 250, 1), transparent),\nradial-gradient(1px 1px at 53.3% 24.8%, rgba(210, 225, 255, 0.75), transparent),\nradial-gradient(1px 1px at 89.9% 3.6%, rgba(210, 225, 255, 1), transparent),\nradial-gradient(1px 1px at 68.8% 41.1%, rgba(210, 225, 255, 1), transparent),\nradial-gradient(1px 1px at 56.6% 42.0%, rgba(255, 220, 250, 1), transparent),\nradial-gradient(1.7px 1.7px at 29.4% 5.6%, rgba(255, 255, 255, 0.9), transparent),\nradial-gradient(1px 1px at 35.0% 5.7%, rgba(255, 220, 250, 0.5), transparent),\nradial-gradient(0.8px 0.8px at 43.0% 25.3%, rgba(210, 225, 255, 0.5), transparent),\nradial-gradient(1.7px 1.7px at 61.0% 4.5%, rgba(255, 220, 250, 1), transparent),\nradial-gradient(1px 1px at 54.9% 53.6%, rgba(255, 255, 255, 1), transparent),\nradial-gradient(0.8px 0.8px at 97.9% 19.3%, rgba(210, 225, 255, 0.5), transparent),\nradial-gradient(1.2px 1.2px at 53.4% 55.1%, rgba(210, 225, 255, 0.75), transparent),\nradial-gradient(1px 1px at 27.3% 40.6%, rgba(255, 220, 250, 0.75), transparent),\nradial-gradient(1.2px 1.2px at 94.0% 52.2%, rgba(255, 220, 250, 0.9), transparent),\nradial-gradient(1.4px 1.4px at 85.5% 23.6%, rgba(255, 255, 255, 1), transparent),\nradial-gradient(1.4px 1.4px at 61.5% 54.7%, rgba(255, 220, 250, 0.75), transparent),\nradial-gradient(1px 1px at 62.9% 42.1%, rgba(255, 220, 250, 0.9), transparent),\nradial-gradient(0.8px 0.8px at 52.0% 32.7%, rgba(210, 225, 255, 0.9), transparent),\nradial-gradient(1.4px 1.4px at 32.2% 23.1%, rgba(255, 255, 255, 0.6), transparent),\nradial-gradient(1px 1px at 62.8% 20.6%, rgba(210, 225, 255, 0.75), transparent),\nradial-gradient(0.8px 0.8px at 69.9% 43.3%, rgba(255, 255, 255, 1), transparent),\nradial-gradient(1px 1px at 93.7% 3.2%, rgba(210, 225, 255, 0.75), transparent),\nradial-gradient(1px 1px at 45.8% 35.2%, rgba(255, 220, 250, 0.6), transparent),\nradial-gradient(1.4px 1.4px at 19.8% 44.5%, rgba(255, 220, 250, 0.75), transparent);\n-webkit-mask-image: linear-gradient(#000 40%, transparent 85%);\nmask-image: linear-gradient(#000 40%, transparent 85%);\nanimation: aur-sw-twinkle 7s steps(42) infinite alternate;\n}\n@keyframes aur-sw-twinkle { from { opacity: 0.55; } to { opacity: 0.95; } }\n.aur-root[data-fx=\"synthwave\"] .aur-fx-a {\ndisplay: block;\nleft: 50%;\nwidth: var(--sw-d);\nheight: calc(var(--sw-d) * 0.7);\nmargin-left: calc(var(--sw-d) / -2);\ntop: calc(var(--sw-horizon) - var(--sw-d) * 0.7);\noverflow: hidden;\n}\n.aur-root[data-fx=\"synthwave\"] .aur-fx-a::before {\ncontent: \"\";\nposition: absolute;\nleft: 0;\ntop: 0;\nwidth: 100%;\naspect-ratio: 1;\nborder-radius: 50%;\nbackground: linear-gradient(to bottom, #fff4b0 0%, #ffd86b 20%, #ffa04f 40%, #ff5a86 60%, #d92fc6 80%);\n-webkit-mask-image: linear-gradient(to bottom, #000 0 44%, transparent 44% 46%, #000 46% 52%, transparent 52% 55%, #000 55% 60%, transparent 60% 64%, #000 64% 68%, transparent 68% 73%);\nmask-image: linear-gradient(to bottom, #000 0 44%, transparent 44% 46%, #000 46% 52%, transparent 52% 55%, #000 55% 60%, transparent 60% 64%, #000 64% 68%, transparent 68% 73%);\nopacity: 0.86;\n}\n.aur-root[data-fx=\"synthwave\"] .aur-fx-b {\n--sw-line: color-mix(in oklab, var(--aur-accent) 78%, #fff);\n--sw-line-soft: color-mix(in oklab, var(--aur-accent) 30%, transparent);\ndisplay: block;\nleft: 0;\nright: 0;\ntop: var(--sw-horizon);\nbottom: 0;\nbackground:\nradial-gradient(22% 120% at 50% 0%, rgba(255, 130, 170, 0.22), transparent 70%),\nconic-gradient(from 0deg at 50% 0%, transparent 0deg, transparent 99.16deg, var(--sw-line-soft) 99.51deg, var(--sw-line) 99.51deg 99.79deg, var(--sw-line-soft) 99.79deg, transparent 100.14deg, transparent 99.89deg, var(--sw-line-soft) 100.24deg, var(--sw-line) 100.24deg 100.52deg, var(--sw-line-soft) 100.52deg, transparent 100.87deg, transparent 100.73deg, var(--sw-line-soft) 101.08deg, var(--sw-line) 101.08deg 101.36deg, var(--sw-line-soft) 101.36deg, transparent 101.71deg, transparent 101.72deg, var(--sw-line-soft) 102.07deg, var(--sw-line) 102.07deg 102.35deg, var(--sw-line-soft) 102.35deg, transparent 102.70deg, transparent 102.90deg, var(--sw-line-soft) 103.25deg, var(--sw-line) 103.25deg 103.53deg, var(--sw-line-soft) 103.53deg, transparent 103.88deg, transparent 104.33deg, var(--sw-line-soft) 104.68deg, var(--sw-line) 104.68deg 104.96deg, var(--sw-line-soft) 104.96deg, transparent 105.31deg, transparent 106.08deg, var(--sw-line-soft) 106.43deg, var(--sw-line) 106.43deg 106.71deg, var(--sw-line-soft) 106.71deg, transparent 107.06deg, transparent 108.30deg, var(--sw-line-soft) 108.65deg, var(--sw-line) 108.65deg 108.93deg, var(--sw-line-soft) 108.93deg, transparent 109.28deg, transparent 111.15deg, var(--sw-line-soft) 111.50deg, var(--sw-line) 111.50deg 111.78deg, var(--sw-line-soft) 111.78deg, transparent 112.13deg, transparent 114.97deg, var(--sw-line-soft) 115.32deg, var(--sw-line) 115.32deg 115.60deg, var(--sw-line-soft) 115.60deg, transparent 115.95deg, transparent 120.27deg, var(--sw-line-soft) 120.62deg, var(--sw-line) 120.62deg 120.90deg, var(--sw-line-soft) 120.90deg, transparent 121.25deg, transparent 127.95deg, var(--sw-line-soft) 128.30deg, var(--sw-line) 128.30deg 128.58deg, var(--sw-line-soft) 128.58deg, transparent 128.93deg, transparent 139.48deg, var(--sw-line-soft) 139.83deg, var(--sw-line) 139.83deg 140.11deg, var(--sw-line-soft) 140.11deg, transparent 140.46deg, transparent 156.73deg, var(--sw-line-soft) 157.08deg, var(--sw-line) 157.08deg 157.36deg, var(--sw-line-soft) 157.36deg, transparent 157.71deg, transparent 179.51deg, var(--sw-line-soft) 179.86deg, var(--sw-line) 179.86deg 180.14deg, var(--sw-line-soft) 180.14deg, transparent 180.49deg, transparent 202.29deg, var(--sw-line-soft) 202.64deg, var(--sw-line) 202.64deg 202.92deg, var(--sw-line-soft) 202.92deg, transparent 203.27deg, transparent 219.54deg, var(--sw-line-soft) 219.89deg, var(--sw-line) 219.89deg 220.17deg, var(--sw-line-soft) 220.17deg, transparent 220.52deg, transparent 231.07deg, var(--sw-line-soft) 231.42deg, var(--sw-line) 231.42deg 231.70deg, var(--sw-line-soft) 231.70deg, transparent 232.05deg, transparent 238.75deg, var(--sw-line-soft) 239.10deg, var(--sw-line) 239.10deg 239.38deg, var(--sw-line-soft) 239.38deg, transparent 239.73deg, transparent 244.05deg, var(--sw-line-soft) 244.40deg, var(--sw-line) 244.40deg 244.68deg, var(--sw-line-soft) 244.68deg, transparent 245.03deg, transparent 247.87deg, var(--sw-line-soft) 248.22deg, var(--sw-line) 248.22deg 248.50deg, var(--sw-line-soft) 248.50deg, transparent 248.85deg, transparent 250.72deg, var(--sw-line-soft) 251.07deg, var(--sw-line) 251.07deg 251.35deg, var(--sw-line-soft) 251.35deg, transparent 251.70deg, transparent 252.94deg, var(--sw-line-soft) 253.29deg, var(--sw-line) 253.29deg 253.57deg, var(--sw-line-soft) 253.57deg, transparent 253.92deg, transparent 254.69deg, var(--sw-line-soft) 255.04deg, var(--sw-line) 255.04deg 255.32deg, var(--sw-line-soft) 255.32deg, transparent 255.67deg, transparent 256.12deg, var(--sw-line-soft) 256.47deg, var(--sw-line) 256.47deg 256.75deg, var(--sw-line-soft) 256.75deg, transparent 257.10deg, transparent 257.30deg, var(--sw-line-soft) 257.65deg, var(--sw-line) 257.65deg 257.93deg, var(--sw-line-soft) 257.93deg, transparent 258.28deg, transparent 258.29deg, var(--sw-line-soft) 258.64deg, var(--sw-line) 258.64deg 258.92deg, var(--sw-line-soft) 258.92deg, transparent 259.27deg, transparent 259.13deg, var(--sw-line-soft) 259.48deg, var(--sw-line) 259.48deg 259.76deg, var(--sw-line-soft) 259.76deg, transparent 260.11deg, transparent 259.86deg, var(--sw-line-soft) 260.21deg, var(--sw-line) 260.21deg 260.49deg, var(--sw-line-soft) 260.49deg, transparent 260.84deg);\n-webkit-mask-image: linear-gradient(to bottom, rgba(0, 0, 0, 0.15), #000 45%);\nmask-image: linear-gradient(to bottom, rgba(0, 0, 0, 0.15), #000 45%);\nopacity: 0.85;\n}\n.aur-root[data-fx=\"synthwave\"] .aur-fx-b::before {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground:\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (1 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (1 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (1 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (1 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (1 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (1 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (1 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (1 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (1 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (1 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (1 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (1 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (1 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (2 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (2 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (2 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (2 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (2 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (2 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (2 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (2 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (2 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (2 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (2 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (2 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (2 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (3 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (3 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (3 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (3 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (3 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (3 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (3 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (3 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (3 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (3 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (3 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (3 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (3 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (4 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (4 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (4 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (4 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (4 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (4 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (4 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (4 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (4 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (4 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (4 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (4 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (4 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (5 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (5 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (5 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (5 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (5 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (5 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (5 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (5 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (5 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (5 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (5 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (5 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (5 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (6 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (6 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (6 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (6 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (6 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (6 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (6 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (6 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (6 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (6 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (6 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (6 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (6 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (7 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (7 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (7 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (7 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (7 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (7 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (7 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (7 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (7 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (7 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (7 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (7 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (7 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (8 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (8 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (8 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (8 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (8 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (8 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (8 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (8 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (8 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (8 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (8 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (8 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (8 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (9 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (9 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (9 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (9 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (9 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (9 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (9 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (9 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (9 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (9 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (9 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (9 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (9 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (10 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (10 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (10 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (10 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (10 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (10 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (10 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (10 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (10 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (10 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (10 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (10 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (10 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (11 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (11 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (11 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (11 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (11 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (11 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (11 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (11 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (11 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (11 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (11 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (11 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (11 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (12 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (12 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (12 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (12 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (12 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (12 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (12 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (12 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (12 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (12 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (12 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (12 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (12 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (13 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (13 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (13 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (13 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (13 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (13 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (13 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (13 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (13 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (13 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (13 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (13 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (13 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (14 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (14 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (14 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (14 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (14 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (14 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (14 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (14 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (14 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (14 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (14 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (14 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (14 - var(--sw-ph)) * 0.36)) + 4px));\nanimation: aur-sw-grid 1.3s steps(40) infinite;\n}\n.aur-root[data-fx=\"synthwave\"][data-gap=\"on\"] .aur-fx-b::before { animation-duration: 0.65s; }\n@keyframes aur-sw-grid { to { --sw-ph: 1; } }\n.aur-root[data-fx=\"synthwave\"] .aur-fx-c {\ndisplay: block;\nleft: 0;\nright: 0;\ntop: var(--sw-horizon);\nheight: 1.5px;\nbackground: linear-gradient(90deg, transparent, color-mix(in oklab, var(--aur-accent) 50%, #fff) 20%, #fff 50%, color-mix(in oklab, var(--aur-accent) 50%, #fff) 80%, transparent);\nfilter: drop-shadow(0 -1px 0 color-mix(in oklab, var(--aur-accent) 55%, #fff)) drop-shadow(0 0 5px color-mix(in oklab, var(--aur-accent) 55%, transparent));\n}\n.aur-root[data-fx=\"synthwave\"] .aur-fx-c::before,\n.aur-root[data-fx=\"synthwave\"] .aur-fx-c::after {\ncontent: \"\";\nposition: absolute;\nleft: -1%;\nright: -1%;\nbottom: 100%;\n}\n.aur-root[data-fx=\"synthwave\"] .aur-fx-c::before {\nheight: 15vh;\nbackground: linear-gradient(to bottom, #3a1a6c, #1e0c40 70%, #170932);\nclip-path: polygon(0% 100%, 0.0% 28.7%, 3.0% 40.2%, 5.8% 42.9%, 9.5% 9.3%, 13.8% 8.0%, 17.7% 8.0%, 20.6% 8.0%, 25.9% 8.0%, 29.1% 17.7%, 34.8% 78.1%, 38.7% 81.5%, 41.4% 83.4%, 44.9% 81.9%, 47.8% 79.0%, 53.0% 79.7%, 57.5% 83.4%, 61.3% 81.5%, 64.0% 78.8%, 67.2% 72.0%, 71.2% 57.9%, 75.7% 54.3%, 79.2% 72.0%, 84.1% 52.6%, 88.5% 54.5%, 94.0% 71.9%, 97.5% 72.0%, 100% 100%);\n}\n.aur-root[data-fx=\"synthwave\"] .aur-fx-c::after {\nheight: 9vh;\nbackground: linear-gradient(to bottom, #1a0a34, #09040f);\nclip-path: polygon(0% 100%, 0.0% 32.9%, 6.3% 43.1%, 11.7% 22.0%, 18.5% 45.4%, 24.1% 45.8%, 28.4% 22.0%, 33.0% 100%, 67.0% 100%, 72.5% 28.5%, 76.1% 50.8%, 80.4% 30.5%, 83.9% 68.3%, 90.5% 88.0%, 96.5% 52.6%, 100% 100%);\n}\n.aur-root[data-fx=\"synthwave\"] .aur-fx::after {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground:\nradial-gradient(circle at 50% calc(var(--sw-horizon) - var(--sw-d) * 0.2), rgba(255, 130, 150, 0.2), rgba(255, 70, 170, 0.07) calc(var(--sw-d) * 0.62), transparent calc(var(--sw-d) * 1.05)),\nlinear-gradient(to bottom, transparent calc(var(--sw-horizon) - 8%), rgba(255, 80, 170, 0.14) calc(var(--sw-horizon) - 1%), rgba(255, 150, 200, 0.3) var(--sw-horizon), rgba(140, 40, 170, 0.14) calc(var(--sw-horizon) + 2.5%), transparent calc(var(--sw-horizon) + 10%));\nopacity: 0.85;\ntransition: opacity 2s ease;\n}\n.aur-root[data-fx=\"synthwave\"][data-gap=\"on\"] .aur-fx::after { opacity: 1; }\n.aur-root[data-fx=\"synthwave\"] .aur-bg-grain { opacity: 0.025; }\n.aur-root[data-look=\"synthwave\"] {\n--sw-chrome: linear-gradient(180deg, #f6fbff 0%, #cfe8ff 24%, #7fbcff 46%, #231650 50%, #3b1d6e 52%, #ff5fb4 58%, #ffb46e 80%, #fff0d8 100%);\n--sw-todo: #8f80c9;\n}\n.aur-root[data-look=\"synthwave\"][data-color=\"white\"] { --aur-hi: #d8cdff; }\n.aur-root[data-look=\"synthwave\"] .aur-stage {\n-webkit-mask-image: linear-gradient(to bottom, transparent 0, transparent 72px, #000 calc(72px + 12%), #000 50%, transparent 66%);\nmask-image: linear-gradient(to bottom, transparent 0, transparent 72px, #000 calc(72px + 12%), #000 50%, transparent 66%);\n}\n.aur-root[data-look=\"synthwave\"] .aur-stage .aur-main { transform: skewX(-8deg); }\n.aur-root[data-look=\"synthwave\"][data-words=\"on\"]:is([data-wordanim=\"fill\"], [data-wordanim=\"rise\"], [data-wordanim=\"karaoke\"], [data-wordanim=\"letters\"]) .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--edge: 0.35em;\ncolor: transparent;\nbackground-image: linear-gradient(90deg, transparent calc(var(--p) * (100% + var(--edge)) - var(--edge)), var(--sw-todo) calc(var(--p) * (100% + var(--edge)))), var(--sw-chrome);\n-webkit-background-clip: text;\nbackground-clip: text;\nfilter: drop-shadow(0 0.05em 0 color-mix(in srgb, #ff2d95 calc(var(--e) * 85%), transparent)) drop-shadow(0 0 0.3em color-mix(in oklab, var(--aur-accent) calc(var(--e) * 40%), transparent));\n}\n.aur-root[data-look=\"synthwave\"] .aur-stage .aur-line.is-active:not(.has-words) .aur-main,\n.aur-root[data-look=\"synthwave\"][data-words=\"off\"] .aur-stage .aur-line.is-active .aur-main {\ncolor: transparent;\nbackground-image: var(--sw-chrome);\n-webkit-background-clip: text;\nbackground-clip: text;\ntext-shadow: none;\nfilter: drop-shadow(0 0.05em 0 rgba(255, 45, 149, 0.85)) drop-shadow(0 0 0.3em color-mix(in oklab, var(--aur-accent) 40%, transparent));\n}\n.aur-root[data-look=\"synthwave\"] .aur-dots i { background: color-mix(in oklab, var(--aur-accent) 70%, #fff); box-shadow: 0 0 0.3em var(--aur-accent); }\n.aur-root[data-fx=\"zen\"] .aur-fx-a {\ndisplay: block;\ninset: -20%;\nbackground: radial-gradient(40% 40% at 50% 45%, color-mix(in oklab, var(--aur-accent) 20%, transparent), transparent 70%);\nopacity: 0.8;\ntransition: opacity 3s ease;\nanimation: aur-fx-breathe 14s ease-in-out infinite;\n}\n.aur-root[data-fx=\"zen\"][data-gap=\"on\"] .aur-fx-a { opacity: 1; }\n.aur-root[data-fx=\"zen\"] .aur-fx-b {\ndisplay: block;\nleft: 50%;\ntop: 45%;\nwidth: 70vmin;\nheight: 70vmin;\nmargin: -35vmin 0 0 -35vmin;\nborder-radius: 50%;\nbackground:\nradial-gradient(circle, transparent 60%, color-mix(in oklab, var(--aur-accent) 24%, transparent) 66%, transparent 71%),\nradial-gradient(circle, transparent 41%, color-mix(in oklab, var(--aur-accent) 14%, transparent) 46%, transparent 51%);\nopacity: 0;\n}\n.aur-root[data-fx=\"zen\"][data-bganim=\"on\"][data-lb=\"a\"] .aur-fx-b { animation: aur-fx-ripple-a 5s cubic-bezier(0.2, 0.6, 0.3, 1); }\n.aur-root[data-fx=\"zen\"][data-bganim=\"on\"][data-lb=\"b\"] .aur-fx-b { animation: aur-fx-ripple-b 5s cubic-bezier(0.2, 0.6, 0.3, 1); }\n@keyframes aur-fx-ripple-a { from { transform: scale(0.25); opacity: 0.9; } to { transform: scale(1.5); opacity: 0; } }\n@keyframes aur-fx-ripple-b { from { transform: scale(0.25); opacity: 0.9; } to { transform: scale(1.5); opacity: 0; } }\n.aur-root[data-fx=\"zen\"] .aur-fx-c {\ndisplay: block;\ninset: -400px 0 0 -100px;\nbackground-image:\nradial-gradient(3px 3px at 60px 80px, color-mix(in oklab, var(--aur-accent) 50%, #fff), transparent),\nradial-gradient(2px 2px at 250px 190px, rgba(255, 255, 255, 0.7), transparent),\nradial-gradient(2.5px 2.5px at 150px 330px, color-mix(in oklab, var(--aur-accent) 40%, #fff), transparent),\nradial-gradient(2px 2px at 40px 210px, rgba(255, 255, 255, 0.6), transparent),\nradial-gradient(3px 3px at 230px 60px, color-mix(in oklab, var(--aur-accent) 45%, #fff), transparent);\nbackground-size: 400px 400px, 400px 400px, 400px 400px, 290px 330px, 290px 330px;\nopacity: 0.35;\nanimation: aur-fx-motes 80s linear infinite;\n}\n@keyframes aur-fx-motes { to { transform: translate3d(100px, 400px, 0); } }\n.aur-root[data-fx=\"zen\"] .aur-bg-grain { opacity: 0.02; }\n.aur-root[data-look=\"zen\"][data-color=\"white\"] { --aur-hi: color-mix(in oklab, var(--aur-accent) 16%, #fff); }\n.aur-root[data-look=\"zen\"] .aur-stage .aur-line { letter-spacing: 0.015em; }\n.aur-root[data-look=\"zen\"][data-motion=\"full\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active .aur-main { animation: aur-fx-settle 1.8s var(--aur-ease); }\n@keyframes aur-fx-settle { from { opacity: 0.35; filter: blur(5px); } }\n.aur-root[data-fx=\"sunset\"] .aur-fx::before {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: linear-gradient(to bottom, rgba(60, 20, 90, 0.3), rgba(160, 50, 90, 0.18) 45%, rgba(255, 120, 60, 0.26) 71%, rgba(255, 150, 80, 0.3) 72%, rgba(40, 15, 45, 0.3) 73%);\n}\n.aur-root[data-fx=\"sunset\"] .aur-fx::after {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: linear-gradient(to bottom, #0b1030, rgba(20, 20, 60, 0.6) 70%, rgba(10, 10, 30, 0.5));\nopacity: calc(var(--aur-song, 0) * 0.5);\ntransition: opacity 1s linear;\n}\n.aur-root[data-fx=\"sunset\"] .aur-fx-a {\ndisplay: block;\nleft: -10%;\nright: -10%;\ntop: 30%;\nheight: 84%;\nbackground: radial-gradient(50% 50% at 50% 50%, rgba(255, 150, 70, 0.38), rgba(255, 80, 120, 0.16) 45%, transparent 75%);\ntranslate: 0 calc(var(--aur-song, 0) * 14vh);\nopacity: 0.85;\ntransition: translate 1s linear, opacity 3s ease;\nanimation: aur-fx-breathe 16s ease-in-out infinite;\n}\n.aur-root[data-fx=\"sunset\"][data-gap=\"on\"] .aur-fx-a { opacity: 1; }\n.aur-root[data-fx=\"sunset\"] .aur-fx-b {\ndisplay: block;\nleft: 0;\nright: 0;\ntop: 0;\nheight: 72%;\noverflow: hidden;\n}\n.aur-root[data-fx=\"sunset\"] .aur-fx-b::before {\ncontent: \"\";\nposition: absolute;\nleft: 50%;\nbottom: -8vmin;\nwidth: 34vmin;\nheight: 34vmin;\nmargin-left: -17vmin;\nborder-radius: 50%;\nbackground: radial-gradient(circle, #ffd9a0 0 30%, #ffb45e 48%, #ff8a4c 64%, rgba(255, 100, 80, 0) 71%);\nopacity: 0.6;\ntranslate: 0 calc(var(--aur-song, 0) * 26vmin);\ntransition: translate 1s linear;\n}\n.aur-root[data-fx=\"sunset\"][data-bganim=\"on\"][data-lb=\"a\"] .aur-fx-b::before { animation: aur-fx-sunglow-a 2.2s ease-out; }\n.aur-root[data-fx=\"sunset\"][data-bganim=\"on\"][data-lb=\"b\"] .aur-fx-b::before { animation: aur-fx-sunglow-b 2.2s ease-out; }\n@keyframes aur-fx-sunglow-a { from { opacity: 0.8; scale: 1.05; } }\n@keyframes aur-fx-sunglow-b { from { opacity: 0.8; scale: 1.05; } }\n.aur-root[data-fx=\"sunset\"] .aur-fx-c {\ndisplay: block;\nleft: 0;\nright: 0;\ntop: 72%;\nbottom: 0;\nbackground: linear-gradient(rgba(60, 25, 60, 0.35), rgba(15, 8, 25, 0.5));\n}\n.aur-root[data-fx=\"sunset\"] .aur-fx-c::before {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: repeating-linear-gradient(to bottom, transparent 0 7px, rgba(255, 190, 110, 0.55) 7px 9px, transparent 9px 13px, rgba(255, 150, 90, 0.35) 13px 14px);\n-webkit-mask-image: radial-gradient(22% 120% at 50% 0%, #000 20%, transparent 100%);\nmask-image: radial-gradient(22% 120% at 50% 0%, #000 20%, transparent 100%);\nopacity: calc(0.9 - var(--aur-song, 0) * 0.75);\ntransition: opacity 1s linear;\nanimation: aur-fx-glitter 1.8s steps(4) infinite;\n}\n@keyframes aur-fx-glitter { to { background-position: 0 14px; } }\n.aur-root[data-look=\"sunset\"] { --aur-glow-tint: color-mix(in oklab, #ffb46b 60%, #fff); }\n.aur-root[data-fx=\"midnight\"] :is(.aur-fx-a, .aur-fx-b) {\ndisplay: block;\ninset: 0;\nbackground-image:\nradial-gradient(1.3px 1.3px at 30px 40px, rgba(255, 255, 255, 0.9), transparent),\nradial-gradient(1px 1px at 120px 150px, rgba(255, 255, 255, 0.7), transparent),\nradial-gradient(1.6px 1.6px at 260px 70px, rgba(220, 230, 255, 0.85), transparent),\nradial-gradient(1px 1px at 330px 260px, rgba(255, 255, 255, 0.6), transparent),\nradial-gradient(1.2px 1.2px at 190px 330px, rgba(255, 255, 255, 0.75), transparent),\nradial-gradient(0.9px 0.9px at 70px 250px, rgba(255, 255, 255, 0.6), transparent);\nbackground-size: 380px 380px;\nopacity: 0.55;\nanimation: aur-fx-twinkle 5s ease-in-out infinite alternate;\n}\n.aur-root[data-fx=\"midnight\"] .aur-fx-b { background-size: 260px 260px; background-position: 90px 130px; animation-duration: 7s; animation-delay: -3s; }\n.aur-root[data-fx=\"midnight\"][data-bganim=\"on\"][data-lb=\"a\"] .aur-fx-b { animation: aur-fx-twinkle 7s ease-in-out -3s infinite alternate, aur-fx-starflare-a 1.6s ease-out; }\n.aur-root[data-fx=\"midnight\"][data-bganim=\"on\"][data-lb=\"b\"] .aur-fx-b { animation: aur-fx-twinkle 7s ease-in-out -3s infinite alternate, aur-fx-starflare-b 1.6s ease-out; }\n@keyframes aur-fx-twinkle { from { opacity: 0.4; } to { opacity: 0.95; } }\n@keyframes aur-fx-starflare-a { from { opacity: 1; } }\n@keyframes aur-fx-starflare-b { from { opacity: 1; } }\n.aur-root[data-fx=\"midnight\"] .aur-fx-c {\ndisplay: block;\nright: 7%;\ntop: 3%;\nwidth: 8vmin;\nheight: 8vmin;\nborder-radius: 50%;\nbox-shadow: inset -1.9vmin 1.1vmin 0 0 #eef2ff;\nfilter: drop-shadow(0 0 1.6vmin rgba(200, 220, 255, 0.55));\nrotate: -18deg;\ntranslate: 0 calc((1 - var(--aur-song, 0)) * 12vh);\ntransition: translate 1s linear;\n}\n.aur-root[data-fx=\"midnight\"] .aur-fx-c::before {\ncontent: \"\";\nposition: absolute;\ninset: -260%;\nborder-radius: 50%;\nbackground: radial-gradient(circle, rgba(200, 220, 255, 0.16), transparent 60%);\n}\n.aur-root[data-fx=\"midnight\"] .aur-fx::after {\ncontent: \"\";\nposition: absolute;\ntop: 0;\nbottom: 30%;\nleft: -60%;\nright: -60%;\nbackground:\nradial-gradient(18% 7% at 30% 28%, rgba(16, 22, 48, 0.55), transparent 70%),\nradial-gradient(14% 5% at 38% 31%, rgba(16, 22, 48, 0.45), transparent 70%),\nradial-gradient(20% 6% at 72% 18%, rgba(16, 22, 48, 0.5), transparent 70%);\nanimation: aur-fx-clouds 140s linear infinite alternate;\n}\n@keyframes aur-fx-clouds { from { transform: translate3d(-18%, 0, 0); } to { transform: translate3d(18%, 0, 0); } }\n.aur-root[data-fx=\"midnight\"] .aur-fx::before {\ncontent: \"\";\nposition: absolute;\nleft: 72%;\ntop: 8%;\nwidth: 180px;\nheight: 2px;\nborder-radius: 2px;\nbackground: linear-gradient(90deg, #fff, rgba(200, 220, 255, 0.5) 30%, transparent);\nrotate: -28deg;\ntransform-origin: 0 50%;\nopacity: 0;\nanimation: aur-fx-meteor 13s ease-in infinite;\n}\n.aur-root[data-fx=\"midnight\"][data-gap=\"on\"] .aur-fx::before { animation-duration: 5s; }\n@keyframes aur-fx-meteor {\n0%, 90% { opacity: 0; transform: translateX(0) scaleX(0.3); }\n92% { opacity: 1; }\n100% { opacity: 0; transform: translateX(-40vw) scaleX(1); }\n}\n.aur-root[data-look=\"midnight\"] { --aur-glow-tint: color-mix(in oklab, #b9ccff 60%, #fff); }\n.aur-root[data-fx=\"vaporwave\"] {\n--vw-h: 64%;\n--vw-wr: 3vw;\n--vw-wt: calc(var(--aur-safe-top) + 3vh);\n--vw-ww: min(27vmin, 300px);\n--vw-wh: calc(var(--vw-ww) * 0.62);\n--vw-wb: max(15px, 3.4vmin);\n}\n.aur-root[data-fx=\"vaporwave\"] .aur-fx {\nbackground:\nradial-gradient(70% 28% at 50% var(--vw-h), rgba(255, 220, 190, 0.55), transparent 72%),\nlinear-gradient(to bottom, rgba(26, 14, 77, 0.94) 0%, rgba(61, 31, 140, 0.92) 24%, rgba(142, 63, 196, 0.9) 44%, rgba(255, 110, 196, 0.9) 58%, rgba(255, 183, 202, 0.92) var(--vw-h), #241063 var(--vw-h));\n}\n.aur-root[data-fx=\"vaporwave\"] .aur-fx::before {\ncontent: \"\";\nposition: absolute;\nleft: 46%;\ntop: 6%;\nwidth: 26vmin;\nheight: 17.5vmin;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 480 320' preserveAspectRatio='xMidYMid meet'%3E%3Cdefs%3E%3ClinearGradient id='p' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%23fff0a8'/%3E%3Cstop offset='0.42' stop-color='%23ff9fd4'/%3E%3Cstop offset='1' stop-color='%238d6bff'/%3E%3C/linearGradient%3E%3ClinearGradient id='g'%3E%3Cstop offset='0' stop-color='%235ff2ff'/%3E%3Cstop offset='0.5' stop-color='%23ff7ed2'/%3E%3Cstop offset='1' stop-color='%23b48cff'/%3E%3C/linearGradient%3E%3CradialGradient id='h' cx='.3' cy='.28' r='.6'%3E%3Cstop offset='0' stop-color='%23fff' stop-opacity='0.7'/%3E%3Cstop offset='1' stop-color='%23fff' stop-opacity='0'/%3E%3C/radialGradient%3E%3CradialGradient id='s' cx='.72' cy='.74' r='.72'%3E%3Cstop offset='0' stop-color='%232a0f6b' stop-opacity='0'/%3E%3Cstop offset='0.55' stop-color='%232a0f6b' stop-opacity='0.1'/%3E%3Cstop offset='1' stop-color='%232a0f6b' stop-opacity='0.55'/%3E%3C/radialGradient%3E%3CclipPath id='c'%3E%3Ccircle cx='240' cy='166' r='104'/%3E%3C/clipPath%3E%3C/defs%3E%3Cg transform='rotate(-16 240 166)'%3E%3Cellipse cx='240' cy='166' rx='216' ry='46' fill='none' stroke='url(%23g)' stroke-width='15' stroke-opacity='.85'/%3E%3C/g%3E%3Ccircle cx='240' cy='166' r='104' fill='url(%23p)'/%3E%3Cg clip-path='url(%23c)'%3E%3Cpath d='M136 114Q240 128 344 114' fill='none' stroke='%23fff' stroke-opacity='0.22' stroke-width='9'/%3E%3Cpath d='M136 144Q240 164 344 144' fill='none' stroke='%237a4bd8' stroke-opacity='0.2' stroke-width='14'/%3E%3Cpath d='M136 176Q240 200 344 176' fill='none' stroke='%23fff' stroke-opacity='0.16' stroke-width='8'/%3E%3Cpath d='M136 206Q240 228 344 206' fill='none' stroke='%237a4bd8' stroke-opacity='0.22' stroke-width='16'/%3E%3Cpath d='M136 240Q240 254 344 240' fill='none' stroke='%23fff' stroke-opacity='0.14' stroke-width='7'/%3E%3C/g%3E%3Ccircle cx='240' cy='166' r='104' fill='url(%23s)'/%3E%3Ccircle cx='240' cy='166' r='104' fill='url(%23h)'/%3E%3Cg transform='rotate(-16 240 166)'%3E%3Cpath d='M24 166A216 46 0 0 0 456 166' fill='none' stroke='url(%23g)' stroke-width='15'/%3E%3Cpath d='M34 169A206 41 0 0 0 446 169' fill='none' stroke='%23fff' stroke-opacity='.35' stroke-width='2'/%3E%3C/g%3E%3C/svg%3E\") center / contain no-repeat;\ntransform-origin: 50% 60%;\nanimation: aur-vw-bob 9s ease-in-out infinite alternate;\n}\n@keyframes aur-vw-bob { from { transform: translateY(-1.2vmin) rotate(-2deg); } to { transform: translateY(1.2vmin) rotate(2deg); } }\n.aur-root[data-fx=\"vaporwave\"][data-bganim=\"on\"][data-lb=\"a\"] .aur-fx::before { animation: aur-vw-bob 9s ease-in-out infinite alternate, aur-fx-swell-a 1.4s ease-out; }\n.aur-root[data-fx=\"vaporwave\"][data-bganim=\"on\"][data-lb=\"b\"] .aur-fx::before { animation: aur-vw-bob 9s ease-in-out infinite alternate, aur-fx-swell-b 1.4s ease-out; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx::after {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground:\nrepeating-linear-gradient(to bottom, transparent 0 2px, rgba(20, 4, 50, 0.13) 2px 3px),\nradial-gradient(120% 100% at 50% 50%, transparent 56%, rgba(14, 2, 44, 0.55));\n}\n.aur-root[data-fx=\"vaporwave\"] :is(.aur-fx-a, .aur-fx-b) {\ndisplay: block;\nleft: 0;\nwidth: calc(100% + 1600px);\n}\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-a {\ntop: 36%;\nheight: 28%;\nopacity: 0.78;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 400' preserveAspectRatio='none'%3E%3Cdefs%3E%3ClinearGradient id='g0' gradientUnits='userSpaceOnUse' x1='0' y1='180' x2='0' y2='284'%3E%3Cstop offset='0' stop-color='%23cdbbff'/%3E%3Cstop offset='1' stop-color='%23ffb6e8'/%3E%3C/linearGradient%3E%3CclipPath id='u0'%3E%3Ccircle cx='-139' cy='-20' r='33'/%3E%3Ccircle cx='-70' cy='-36' r='59'/%3E%3Ccircle cx='0' cy='-46' r='74'/%3E%3Ccircle cx='70' cy='-38' r='61'/%3E%3Ccircle cx='139' cy='-21' r='35'/%3E%3C/clipPath%3E%3CclipPath id='f0'%3E%3Crect x='-348' y='-139' width='696' height='139'/%3E%3C/clipPath%3E%3ClinearGradient id='g1' gradientUnits='userSpaceOnUse' x1='0' y1='277' x2='0' y2='363'%3E%3Cstop offset='0' stop-color='%23cdbbff'/%3E%3Cstop offset='1' stop-color='%23ffb6e8'/%3E%3C/linearGradient%3E%3CclipPath id='u1'%3E%3Ccircle cx='-115' cy='-17' r='28'/%3E%3Ccircle cx='-58' cy='-30' r='49'/%3E%3Ccircle cx='0' cy='-37' r='59'/%3E%3Ccircle cx='58' cy='-28' r='44'/%3E%3Ccircle cx='115' cy='-21' r='33'/%3E%3C/clipPath%3E%3CclipPath id='f1'%3E%3Crect x='-288' y='-116' width='576' height='116'/%3E%3C/clipPath%3E%3ClinearGradient id='g2' gradientUnits='userSpaceOnUse' x1='0' y1='167' x2='0' y2='262'%3E%3Cstop offset='0' stop-color='%23cdbbff'/%3E%3Cstop offset='1' stop-color='%23ffb6e8'/%3E%3C/linearGradient%3E%3CclipPath id='u2'%3E%3Ccircle cx='-154' cy='-19' r='31'/%3E%3Ccircle cx='-110' cy='-26' r='42'/%3E%3Ccircle cx='-66' cy='-29' r='46'/%3E%3Ccircle cx='-22' cy='-33' r='53'/%3E%3Ccircle cx='22' cy='-38' r='61'/%3E%3Ccircle cx='66' cy='-31' r='50'/%3E%3Ccircle cx='110' cy='-30' r='49'/%3E%3Ccircle cx='154' cy='-18' r='29'/%3E%3C/clipPath%3E%3CclipPath id='f2'%3E%3Crect x='-352' y='-127' width='704' height='127'/%3E%3C/clipPath%3E%3ClinearGradient id='g3' gradientUnits='userSpaceOnUse' x1='0' y1='275' x2='0' y2='371'%3E%3Cstop offset='0' stop-color='%23cdbbff'/%3E%3Cstop offset='1' stop-color='%23ffb6e8'/%3E%3C/linearGradient%3E%3CclipPath id='u3'%3E%3Ccircle cx='-132' cy='-20' r='32'/%3E%3Ccircle cx='-79' cy='-32' r='52'/%3E%3Ccircle cx='-26' cy='-39' r='62'/%3E%3Ccircle cx='26' cy='-40' r='64'/%3E%3Ccircle cx='79' cy='-35' r='57'/%3E%3Ccircle cx='132' cy='-17' r='27'/%3E%3C/clipPath%3E%3CclipPath id='f3'%3E%3Crect x='-318' y='-129' width='636' height='129'/%3E%3C/clipPath%3E%3ClinearGradient id='g4' gradientUnits='userSpaceOnUse' x1='0' y1='233' x2='0' y2='327'%3E%3Cstop offset='0' stop-color='%23cdbbff'/%3E%3Cstop offset='1' stop-color='%23ffb6e8'/%3E%3C/linearGradient%3E%3CclipPath id='u4'%3E%3Ccircle cx='-123' cy='-20' r='33'/%3E%3Ccircle cx='-62' cy='-34' r='54'/%3E%3Ccircle cx='0' cy='-33' r='53'/%3E%3Ccircle cx='62' cy='-33' r='53'/%3E%3Ccircle cx='123' cy='-19' r='30'/%3E%3C/clipPath%3E%3CclipPath id='f4'%3E%3Crect x='-308' y='-124' width='617' height='124'/%3E%3C/clipPath%3E%3ClinearGradient id='g5' gradientUnits='userSpaceOnUse' x1='0' y1='239' x2='0' y2='328'%3E%3Cstop offset='0' stop-color='%23cdbbff'/%3E%3Cstop offset='1' stop-color='%23ffb6e8'/%3E%3C/linearGradient%3E%3CclipPath id='u5'%3E%3Ccircle cx='-107' cy='-17' r='28'/%3E%3Ccircle cx='-54' cy='-27' r='44'/%3E%3Ccircle cx='0' cy='-36' r='57'/%3E%3Ccircle cx='54' cy='-31' r='50'/%3E%3Ccircle cx='107' cy='-20' r='33'/%3E%3C/clipPath%3E%3CclipPath id='f5'%3E%3Crect x='-268' y='-118' width='537' height='118'/%3E%3C/clipPath%3E%3ClinearGradient id='g6' gradientUnits='userSpaceOnUse' x1='0' y1='181' x2='0' y2='288'%3E%3Cstop offset='0' stop-color='%23cdbbff'/%3E%3Cstop offset='1' stop-color='%23ffb6e8'/%3E%3C/linearGradient%3E%3CclipPath id='u6'%3E%3Ccircle cx='-117' cy='-17' r='28'/%3E%3Ccircle cx='-84' cy='-29' r='47'/%3E%3Ccircle cx='-50' cy='-40' r='64'/%3E%3Ccircle cx='-17' cy='-39' r='63'/%3E%3Ccircle cx='17' cy='-47' r='75'/%3E%3Ccircle cx='50' cy='-34' r='55'/%3E%3Ccircle cx='84' cy='-34' r='55'/%3E%3Ccircle cx='117' cy='-22' r='36'/%3E%3C/clipPath%3E%3CclipPath id='f6'%3E%3Crect x='-267' y='-142' width='535' height='142'/%3E%3C/clipPath%3E%3ClinearGradient id='g7' gradientUnits='userSpaceOnUse' x1='0' y1='256' x2='0' y2='358'%3E%3Cstop offset='0' stop-color='%23cdbbff'/%3E%3Cstop offset='1' stop-color='%23ffb6e8'/%3E%3C/linearGradient%3E%3CclipPath id='u7'%3E%3Ccircle cx='-144' cy='-22' r='36'/%3E%3Ccircle cx='-72' cy='-34' r='56'/%3E%3Ccircle cx='0' cy='-42' r='67'/%3E%3Ccircle cx='72' cy='-34' r='54'/%3E%3Ccircle cx='144' cy='-19' r='31'/%3E%3C/clipPath%3E%3CclipPath id='f7'%3E%3Crect x='-360' y='-136' width='720' height='136'/%3E%3C/clipPath%3E%3ClinearGradient id='g8' gradientUnits='userSpaceOnUse' x1='0' y1='248' x2='0' y2='352'%3E%3Cstop offset='0' stop-color='%23cdbbff'/%3E%3Cstop offset='1' stop-color='%23ffb6e8'/%3E%3C/linearGradient%3E%3CclipPath id='u8'%3E%3Ccircle cx='-103' cy='-18' r='29'/%3E%3Ccircle cx='-62' cy='-33' r='54'/%3E%3Ccircle cx='-21' cy='-36' r='59'/%3E%3Ccircle cx='21' cy='-43' r='69'/%3E%3Ccircle cx='62' cy='-30' r='48'/%3E%3Ccircle cx='103' cy='-21' r='34'/%3E%3C/clipPath%3E%3CclipPath id='f8'%3E%3Crect x='-248' y='-139' width='496' height='139'/%3E%3C/clipPath%3E%3C/defs%3E%3Cg fill-opacity='0.8' opacity='0.8'%3E%3Cg transform='translate(125 284)'%3E%3Cg clip-path='url(%23f0)'%3E%3Cg fill='url(%23g0)'%3E%3Ccircle cx='-139' cy='-20' r='33'/%3E%3Ccircle cx='-70' cy='-36' r='59'/%3E%3Ccircle cx='0' cy='-46' r='74'/%3E%3Ccircle cx='70' cy='-38' r='61'/%3E%3Ccircle cx='139' cy='-21' r='35'/%3E%3C/g%3E%3Crect x='-348' y='-25' width='696' height='69' fill='%235b2aa8' fill-opacity='.32' clip-path='url(%23u0)'/%3E%3C/g%3E%3C/g%3E%3Cg transform='translate(1725 284)'%3E%3Cg clip-path='url(%23f0)'%3E%3Cg fill='url(%23g0)'%3E%3Ccircle cx='-139' cy='-20' r='33'/%3E%3Ccircle cx='-70' cy='-36' r='59'/%3E%3Ccircle cx='0' cy='-46' r='74'/%3E%3Ccircle cx='70' cy='-38' r='61'/%3E%3Ccircle cx='139' cy='-21' r='35'/%3E%3C/g%3E%3Crect x='-348' y='-25' width='696' height='69' fill='%235b2aa8' fill-opacity='.32' clip-path='url(%23u0)'/%3E%3C/g%3E%3C/g%3E%3Cg transform='translate(207 363)'%3E%3Cg clip-path='url(%23f1)'%3E%3Cg fill='url(%23g1)'%3E%3Ccircle cx='-115' cy='-17' r='28'/%3E%3Ccircle cx='-58' cy='-30' r='49'/%3E%3Ccircle cx='0' cy='-37' r='59'/%3E%3Ccircle cx='58' cy='-28' r='44'/%3E%3Ccircle cx='115' cy='-21' r='33'/%3E%3C/g%3E%3Crect x='-288' y='-21' width='576' height='58' fill='%235b2aa8' fill-opacity='.32' clip-path='url(%23u1)'/%3E%3C/g%3E%3C/g%3E%3Cg transform='translate(468 262)'%3E%3Cg clip-path='url(%23f2)'%3E%3Cg fill='url(%23g2)'%3E%3Ccircle cx='-154' cy='-19' r='31'/%3E%3Ccircle cx='-110' cy='-26' r='42'/%3E%3Ccircle cx='-66' cy='-29' r='46'/%3E%3Ccircle cx='-22' cy='-33' r='53'/%3E%3Ccircle cx='22' cy='-38' r='61'/%3E%3Ccircle cx='66' cy='-31' r='50'/%3E%3Ccircle cx='110' cy='-30' r='49'/%3E%3Ccircle cx='154' cy='-18' r='29'/%3E%3C/g%3E%3Crect x='-352' y='-23' width='704' height='63' fill='%235b2aa8' fill-opacity='.32' clip-path='url(%23u2)'/%3E%3C/g%3E%3C/g%3E%3Cg transform='translate(585 371)'%3E%3Cg clip-path='url(%23f3)'%3E%3Cg fill='url(%23g3)'%3E%3Ccircle cx='-132' cy='-20' r='32'/%3E%3Ccircle cx='-79' cy='-32' r='52'/%3E%3Ccircle cx='-26' cy='-39' r='62'/%3E%3Ccircle cx='26' cy='-40' r='64'/%3E%3Ccircle cx='79' cy='-35' r='57'/%3E%3Ccircle cx='132' cy='-17' r='27'/%3E%3C/g%3E%3Crect x='-318' y='-23' width='636' height='64' fill='%235b2aa8' fill-opacity='.32' clip-path='url(%23u3)'/%3E%3C/g%3E%3C/g%3E%3Cg transform='translate(783 327)'%3E%3Cg clip-path='url(%23f4)'%3E%3Cg fill='url(%23g4)'%3E%3Ccircle cx='-123' cy='-20' r='33'/%3E%3Ccircle cx='-62' cy='-34' r='54'/%3E%3Ccircle cx='0' cy='-33' r='53'/%3E%3Ccircle cx='62' cy='-33' r='53'/%3E%3Ccircle cx='123' cy='-19' r='30'/%3E%3C/g%3E%3Crect x='-308' y='-22' width='617' height='62' fill='%235b2aa8' fill-opacity='.32' clip-path='url(%23u4)'/%3E%3C/g%3E%3C/g%3E%3Cg transform='translate(1005 328)'%3E%3Cg clip-path='url(%23f5)'%3E%3Cg fill='url(%23g5)'%3E%3Ccircle cx='-107' cy='-17' r='28'/%3E%3Ccircle cx='-54' cy='-27' r='44'/%3E%3Ccircle cx='0' cy='-36' r='57'/%3E%3Ccircle cx='54' cy='-31' r='50'/%3E%3Ccircle cx='107' cy='-20' r='33'/%3E%3C/g%3E%3Crect x='-268' y='-21' width='537' height='59' fill='%235b2aa8' fill-opacity='.32' clip-path='url(%23u5)'/%3E%3C/g%3E%3C/g%3E%3Cg transform='translate(1170 288)'%3E%3Cg clip-path='url(%23f6)'%3E%3Cg fill='url(%23g6)'%3E%3Ccircle cx='-117' cy='-17' r='28'/%3E%3Ccircle cx='-84' cy='-29' r='47'/%3E%3Ccircle cx='-50' cy='-40' r='64'/%3E%3Ccircle cx='-17' cy='-39' r='63'/%3E%3Ccircle cx='17' cy='-47' r='75'/%3E%3Ccircle cx='50' cy='-34' r='55'/%3E%3Ccircle cx='84' cy='-34' r='55'/%3E%3Ccircle cx='117' cy='-22' r='36'/%3E%3C/g%3E%3Crect x='-267' y='-26' width='535' height='71' fill='%235b2aa8' fill-opacity='.32' clip-path='url(%23u6)'/%3E%3C/g%3E%3C/g%3E%3Cg transform='translate(1355 358)'%3E%3Cg clip-path='url(%23f7)'%3E%3Cg fill='url(%23g7)'%3E%3Ccircle cx='-144' cy='-22' r='36'/%3E%3Ccircle cx='-72' cy='-34' r='56'/%3E%3Ccircle cx='0' cy='-42' r='67'/%3E%3Ccircle cx='72' cy='-34' r='54'/%3E%3Ccircle cx='144' cy='-19' r='31'/%3E%3C/g%3E%3Crect x='-360' y='-24' width='720' height='68' fill='%235b2aa8' fill-opacity='.32' clip-path='url(%23u7)'/%3E%3C/g%3E%3C/g%3E%3Cg transform='translate(1542 352)'%3E%3Cg clip-path='url(%23f8)'%3E%3Cg fill='url(%23g8)'%3E%3Ccircle cx='-103' cy='-18' r='29'/%3E%3Ccircle cx='-62' cy='-33' r='54'/%3E%3Ccircle cx='-21' cy='-36' r='59'/%3E%3Ccircle cx='21' cy='-43' r='69'/%3E%3Ccircle cx='62' cy='-30' r='48'/%3E%3Ccircle cx='103' cy='-21' r='34'/%3E%3C/g%3E%3Crect x='-248' y='-25' width='496' height='70' fill='%235b2aa8' fill-opacity='.32' clip-path='url(%23u8)'/%3E%3C/g%3E%3C/g%3E%3Cg transform='translate(-58 352)'%3E%3Cg clip-path='url(%23f8)'%3E%3Cg fill='url(%23g8)'%3E%3Ccircle cx='-103' cy='-18' r='29'/%3E%3Ccircle cx='-62' cy='-33' r='54'/%3E%3Ccircle cx='-21' cy='-36' r='59'/%3E%3Ccircle cx='21' cy='-43' r='69'/%3E%3Ccircle cx='62' cy='-30' r='48'/%3E%3Ccircle cx='103' cy='-21' r='34'/%3E%3C/g%3E%3Crect x='-248' y='-25' width='496' height='70' fill='%235b2aa8' fill-opacity='.32' clip-path='url(%23u8)'/%3E%3C/g%3E%3C/g%3E%3C/g%3E%3C/svg%3E\") 0 0 / 1600px 100% repeat-x;\nanimation: aur-vw-drift 320s linear infinite;\n}\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-b {\ntop: 46%;\nheight: 18%;\nopacity: 0.92;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 400' preserveAspectRatio='none'%3E%3Cdefs%3E%3ClinearGradient id='g0' gradientUnits='userSpaceOnUse' x1='0' y1='133' x2='0' y2='313'%3E%3Cstop offset='0' stop-color='%23ffe4f6'/%3E%3Cstop offset='1' stop-color='%23ff9fd0'/%3E%3C/linearGradient%3E%3CclipPath id='u0'%3E%3Ccircle cx='-191' cy='-45' r='73'/%3E%3Ccircle cx='-96' cy='-61' r='99'/%3E%3Ccircle cx='0' cy='-72' r='117'/%3E%3Ccircle cx='96' cy='-61' r='98'/%3E%3Ccircle cx='191' cy='-44' r='70'/%3E%3C/clipPath%3E%3CclipPath id='f0'%3E%3Crect x='-478' y='-240' width='956' height='240'/%3E%3C/clipPath%3E%3ClinearGradient id='g1' gradientUnits='userSpaceOnUse' x1='0' y1='212' x2='0' y2='388'%3E%3Cstop offset='0' stop-color='%23ffe4f6'/%3E%3Cstop offset='1' stop-color='%23ff9fd0'/%3E%3C/linearGradient%3E%3CclipPath id='u1'%3E%3Ccircle cx='-137' cy='-31' r='49'/%3E%3Ccircle cx='-92' cy='-59' r='95'/%3E%3Ccircle cx='-46' cy='-55' r='89'/%3E%3Ccircle cx='0' cy='-74' r='120'/%3E%3Ccircle cx='46' cy='-55' r='89'/%3E%3Ccircle cx='92' cy='-55' r='89'/%3E%3Ccircle cx='137' cy='-32' r='52'/%3E%3C/clipPath%3E%3CclipPath id='f1'%3E%3Crect x='-320' y='-235' width='641' height='235'/%3E%3C/clipPath%3E%3ClinearGradient id='g2' gradientUnits='userSpaceOnUse' x1='0' y1='184' x2='0' y2='305'%3E%3Cstop offset='0' stop-color='%23ffe4f6'/%3E%3Cstop offset='1' stop-color='%23ff9fd0'/%3E%3C/linearGradient%3E%3CclipPath id='u2'%3E%3Ccircle cx='-218' cy='-22' r='35'/%3E%3Ccircle cx='-131' cy='-44' r='72'/%3E%3Ccircle cx='-44' cy='-52' r='84'/%3E%3Ccircle cx='44' cy='-40' r='65'/%3E%3Ccircle cx='131' cy='-38' r='61'/%3E%3Ccircle cx='218' cy='-22' r='36'/%3E%3C/clipPath%3E%3CclipPath id='f2'%3E%3Crect x='-522' y='-162' width='1044' height='162'/%3E%3C/clipPath%3E%3ClinearGradient id='g3' gradientUnits='userSpaceOnUse' x1='0' y1='228' x2='0' y2='363'%3E%3Cstop offset='0' stop-color='%23ffe4f6'/%3E%3Cstop offset='1' stop-color='%23ff9fd0'/%3E%3C/linearGradient%3E%3CclipPath id='u3'%3E%3Ccircle cx='-188' cy='-30' r='48'/%3E%3Ccircle cx='-94' cy='-46' r='74'/%3E%3Ccircle cx='0' cy='-45' r='73'/%3E%3Ccircle cx='94' cy='-48' r='77'/%3E%3Ccircle cx='188' cy='-31' r='50'/%3E%3C/clipPath%3E%3CclipPath id='f3'%3E%3Crect x='-469' y='-180' width='938' height='180'/%3E%3C/clipPath%3E%3ClinearGradient id='g4' gradientUnits='userSpaceOnUse' x1='0' y1='189' x2='0' y2='358'%3E%3Cstop offset='0' stop-color='%23ffe4f6'/%3E%3Cstop offset='1' stop-color='%23ff9fd0'/%3E%3C/linearGradient%3E%3CclipPath id='u4'%3E%3Ccircle cx='-186' cy='-42' r='68'/%3E%3Ccircle cx='-93' cy='-66' r='107'/%3E%3Ccircle cx='0' cy='-68' r='110'/%3E%3Ccircle cx='93' cy='-55' r='89'/%3E%3Ccircle cx='186' cy='-35' r='57'/%3E%3C/clipPath%3E%3CclipPath id='f4'%3E%3Crect x='-466' y='-225' width='932' height='225'/%3E%3C/clipPath%3E%3ClinearGradient id='g5' gradientUnits='userSpaceOnUse' x1='0' y1='191' x2='0' y2='321'%3E%3Cstop offset='0' stop-color='%23ffe4f6'/%3E%3Cstop offset='1' stop-color='%23ff9fd0'/%3E%3C/linearGradient%3E%3CclipPath id='u5'%3E%3Ccircle cx='-206' cy='-24' r='39'/%3E%3Ccircle cx='-138' cy='-40' r='64'/%3E%3Ccircle cx='-69' cy='-51' r='82'/%3E%3Ccircle cx='0' cy='-45' r='73'/%3E%3Ccircle cx='69' cy='-45' r='73'/%3E%3Ccircle cx='138' cy='-43' r='69'/%3E%3Ccircle cx='206' cy='-22' r='35'/%3E%3C/clipPath%3E%3CclipPath id='f5'%3E%3Crect x='-482' y='-174' width='963' height='174'/%3E%3C/clipPath%3E%3C/defs%3E%3Cg fill-opacity='0.93' opacity='0.93'%3E%3Cg transform='translate(129 313)'%3E%3Cg clip-path='url(%23f0)'%3E%3Cg fill='url(%23g0)'%3E%3Ccircle cx='-191' cy='-45' r='73'/%3E%3Ccircle cx='-96' cy='-61' r='99'/%3E%3Ccircle cx='0' cy='-72' r='117'/%3E%3Ccircle cx='96' cy='-61' r='98'/%3E%3Ccircle cx='191' cy='-44' r='70'/%3E%3C/g%3E%3Crect x='-478' y='-43' width='956' height='120' fill='%235b2aa8' fill-opacity='.32' clip-path='url(%23u0)'/%3E%3C/g%3E%3C/g%3E%3Cg transform='translate(1729 313)'%3E%3Cg clip-path='url(%23f0)'%3E%3Cg fill='url(%23g0)'%3E%3Ccircle cx='-191' cy='-45' r='73'/%3E%3Ccircle cx='-96' cy='-61' r='99'/%3E%3Ccircle cx='0' cy='-72' r='117'/%3E%3Ccircle cx='96' cy='-61' r='98'/%3E%3Ccircle cx='191' cy='-44' r='70'/%3E%3C/g%3E%3Crect x='-478' y='-43' width='956' height='120' fill='%235b2aa8' fill-opacity='.32' clip-path='url(%23u0)'/%3E%3C/g%3E%3C/g%3E%3Cg transform='translate(349 388)'%3E%3Cg clip-path='url(%23f1)'%3E%3Cg fill='url(%23g1)'%3E%3Ccircle cx='-137' cy='-31' r='49'/%3E%3Ccircle cx='-92' cy='-59' r='95'/%3E%3Ccircle cx='-46' cy='-55' r='89'/%3E%3Ccircle cx='0' cy='-74' r='120'/%3E%3Ccircle cx='46' cy='-55' r='89'/%3E%3Ccircle cx='92' cy='-55' r='89'/%3E%3Ccircle cx='137' cy='-32' r='52'/%3E%3C/g%3E%3Crect x='-320' y='-42' width='641' height='117' fill='%235b2aa8' fill-opacity='.32' clip-path='url(%23u1)'/%3E%3C/g%3E%3C/g%3E%3Cg transform='translate(649 305)'%3E%3Cg clip-path='url(%23f2)'%3E%3Cg fill='url(%23g2)'%3E%3Ccircle cx='-218' cy='-22' r='35'/%3E%3Ccircle cx='-131' cy='-44' r='72'/%3E%3Ccircle cx='-44' cy='-52' r='84'/%3E%3Ccircle cx='44' cy='-40' r='65'/%3E%3Ccircle cx='131' cy='-38' r='61'/%3E%3Ccircle cx='218' cy='-22' r='36'/%3E%3C/g%3E%3Crect x='-522' y='-29' width='1044' height='81' fill='%235b2aa8' fill-opacity='.32' clip-path='url(%23u2)'/%3E%3C/g%3E%3C/g%3E%3Cg transform='translate(898 363)'%3E%3Cg clip-path='url(%23f3)'%3E%3Cg fill='url(%23g3)'%3E%3Ccircle cx='-188' cy='-30' r='48'/%3E%3Ccircle cx='-94' cy='-46' r='74'/%3E%3Ccircle cx='0' cy='-45' r='73'/%3E%3Ccircle cx='94' cy='-48' r='77'/%3E%3Ccircle cx='188' cy='-31' r='50'/%3E%3C/g%3E%3Crect x='-469' y='-32' width='938' height='90' fill='%235b2aa8' fill-opacity='.32' clip-path='url(%23u3)'/%3E%3C/g%3E%3C/g%3E%3Cg transform='translate(1194 358)'%3E%3Cg clip-path='url(%23f4)'%3E%3Cg fill='url(%23g4)'%3E%3Ccircle cx='-186' cy='-42' r='68'/%3E%3Ccircle cx='-93' cy='-66' r='107'/%3E%3Ccircle cx='0' cy='-68' r='110'/%3E%3Ccircle cx='93' cy='-55' r='89'/%3E%3Ccircle cx='186' cy='-35' r='57'/%3E%3C/g%3E%3Crect x='-466' y='-40' width='932' height='112' fill='%235b2aa8' fill-opacity='.32' clip-path='url(%23u4)'/%3E%3C/g%3E%3C/g%3E%3Cg transform='translate(1502 321)'%3E%3Cg clip-path='url(%23f5)'%3E%3Cg fill='url(%23g5)'%3E%3Ccircle cx='-206' cy='-24' r='39'/%3E%3Ccircle cx='-138' cy='-40' r='64'/%3E%3Ccircle cx='-69' cy='-51' r='82'/%3E%3Ccircle cx='0' cy='-45' r='73'/%3E%3Ccircle cx='69' cy='-45' r='73'/%3E%3Ccircle cx='138' cy='-43' r='69'/%3E%3Ccircle cx='206' cy='-22' r='35'/%3E%3C/g%3E%3Crect x='-482' y='-31' width='963' height='87' fill='%235b2aa8' fill-opacity='.32' clip-path='url(%23u5)'/%3E%3C/g%3E%3C/g%3E%3Cg transform='translate(-98 321)'%3E%3Cg clip-path='url(%23f5)'%3E%3Cg fill='url(%23g5)'%3E%3Ccircle cx='-206' cy='-24' r='39'/%3E%3Ccircle cx='-138' cy='-40' r='64'/%3E%3Ccircle cx='-69' cy='-51' r='82'/%3E%3Ccircle cx='0' cy='-45' r='73'/%3E%3Ccircle cx='69' cy='-45' r='73'/%3E%3Ccircle cx='138' cy='-43' r='69'/%3E%3Ccircle cx='206' cy='-22' r='35'/%3E%3C/g%3E%3Crect x='-482' y='-31' width='963' height='87' fill='%235b2aa8' fill-opacity='.32' clip-path='url(%23u5)'/%3E%3C/g%3E%3C/g%3E%3C/g%3E%3C/svg%3E\") 0 0 / 1600px 100% repeat-x;\nanimation: aur-vw-drift 170s linear infinite;\n}\n@keyframes aur-vw-drift { to { transform: translateX(-1600px); } }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-c {\n--vw-p: 70vmin;\n--vw-cell: 4.4vmin;\ndisplay: block;\nleft: 0;\nright: 0;\ntop: var(--vw-h);\nbottom: 0;\noverflow: hidden;\nperspective: var(--vw-p);\nperspective-origin: 50% calc(var(--vw-p) * 0.287);\n}\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-c::before {\ncontent: \"\";\nposition: absolute;\nleft: -300%;\nright: -300%;\ntop: calc(var(--vw-p) * 0.287 - 1500px);\nheight: 3000px;\ntransform-origin: 50% 1500px;\ntransform: rotateX(74deg);\nbackground:\nlinear-gradient(rgba(255, 255, 255, 0.2) 0 2px, transparent 2px) 0 0 / var(--vw-cell) var(--vw-cell),\nlinear-gradient(90deg, rgba(255, 255, 255, 0.2) 0 2px, transparent 2px) 0 0 / var(--vw-cell) var(--vw-cell),\nconic-gradient(rgba(255, 120, 204, 0.62) 25%, rgba(52, 18, 122, 0.94) 0 50%, rgba(255, 120, 204, 0.62) 0 75%, rgba(52, 18, 122, 0.94) 0) 0 0 / calc(var(--vw-cell) * 2) calc(var(--vw-cell) * 2);\nanimation: aur-vw-roll calc(var(--aur-beat, 0.75s) * 4) linear infinite;\n}\n@keyframes aur-vw-roll {\nfrom { transform: rotateX(74deg) translateY(0); }\nto { transform: rotateX(74deg) translateY(8.8vmin); }\n}\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-c::after {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: linear-gradient(to bottom, rgba(255, 196, 208, 0.98), rgba(255, 150, 206, 0.7) 8%, rgba(150, 70, 200, 0.28) 26%, rgba(60, 20, 130, 0.08) 52%, transparent 75%);\n}\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-d {\ndisplay: block;\nright: var(--vw-wr);\ntop: var(--vw-wt);\nwidth: var(--vw-ww);\nheight: var(--vw-wh);\nbackground: #d6d2ea;\nbox-shadow: 0 0 0 1px #1a1030, inset 0 0 0 1px #fff, 0.9vmin 0.9vmin 0 rgba(30, 10, 80, 0.45);\n}\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-d::before {\ncontent: \"ｓｐｅｃｔｒｕｍ．ｅｘｅ\";\nposition: absolute;\nleft: 3px;\nright: 3px;\ntop: 3px;\nheight: var(--vw-wb);\ndisplay: flex;\nalign-items: center;\npadding-left: 0.7em;\ncolor: #fff;\nfont: 700 calc(var(--vw-wb) * 0.5) / 1 var(--aur-ui-font);\nletter-spacing: 0.06em;\nwhite-space: nowrap;\noverflow: hidden;\nbackground:\nlinear-gradient(#d6d2ea, #d6d2ea) right 0.5em center / calc(var(--vw-wb) * 0.62) calc(var(--vw-wb) * 0.62) no-repeat,\nlinear-gradient(#d6d2ea, #d6d2ea) right calc(0.5em + var(--vw-wb) * 0.8) center / calc(var(--vw-wb) * 0.62) calc(var(--vw-wb) * 0.62) no-repeat,\nlinear-gradient(90deg, #ff71ce, #b967ff 55%, #01cdfe);\n}\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-d::after {\ncontent: \"\";\nposition: absolute;\nleft: 3px;\nright: 3px;\ntop: calc(6px + var(--vw-wb));\nbottom: 3px;\nbackground:\nrepeating-linear-gradient(to bottom, transparent 0 calc(100% / 6 - 1px), rgba(255, 255, 255, 0.07) calc(100% / 6 - 1px) calc(100% / 6)),\n#100826;\nbox-shadow: inset 0 0 0 1px #6f6a8c;\n}\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e { display: block; inset: 0; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i { position: absolute; display: block; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(-n + 12) {\n--bh: calc(var(--vw-wh) - var(--vw-wb) - 14px);\nleft: calc(100% - var(--vw-wr) - var(--vw-ww) + 3px + 0.9vmin + var(--k) * (var(--vw-ww) - 6px - 1.8vmin) / 12);\ntop: calc(var(--vw-wt) + var(--vw-wh) - 7px - var(--bh));\nwidth: calc((var(--vw-ww) - 6px - 1.8vmin) / 12 * 0.66);\nheight: var(--bh);\nborder-radius: 2px 2px 0 0;\ntransform-origin: 50% 100%;\nbackground: linear-gradient(to top, #01cdfe, #b967ff 55%, #ff71ce 90%, #fff);\nbox-shadow: 0 0 0.9vmin rgba(255, 113, 206, 0.5);\n}\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(1) { --k: 0; --pk: 0.58; animation: aur-vw-eq-2 calc(var(--aur-beat, 0.6s) * 2) ease-in-out -0.87s infinite; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(2) { --k: 1; --pk: 0.72; animation: aur-vw-eq-2 calc(var(--aur-beat, 0.6s) * 3) ease-in-out -0.33s infinite; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(3) { --k: 2; --pk: 0.66; animation: aur-vw-eq-3 calc(var(--aur-beat, 0.6s) * 2) ease-in-out -0.76s infinite; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(4) { --k: 3; --pk: 0.85; animation: aur-vw-eq-3 calc(var(--aur-beat, 0.6s) * 2) ease-in-out -0.41s infinite; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(5) { --k: 4; --pk: 0.95; animation: aur-vw-eq-1 calc(var(--aur-beat, 0.6s) * 1) ease-in-out -0.45s infinite; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(6) { --k: 5; --pk: 0.98; animation: aur-vw-eq-1 calc(var(--aur-beat, 0.6s) * 3) ease-in-out -0.99s infinite; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(7) { --k: 6; --pk: 0.77; animation: aur-vw-eq-2 calc(var(--aur-beat, 0.6s) * 1) ease-in-out -1.23s infinite; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(8) { --k: 7; --pk: 0.76; animation: aur-vw-eq-1 calc(var(--aur-beat, 0.6s) * 2) ease-in-out -2.05s infinite; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(9) { --k: 8; --pk: 0.65; animation: aur-vw-eq-2 calc(var(--aur-beat, 0.6s) * 3) ease-in-out -0.05s infinite; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(10) { --k: 9; --pk: 0.55; animation: aur-vw-eq-2 calc(var(--aur-beat, 0.6s) * 1) ease-in-out -0.15s infinite; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(11) { --k: 10; --pk: 0.48; animation: aur-vw-eq-0 calc(var(--aur-beat, 0.6s) * 3) ease-in-out -2.60s infinite; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(12) { --k: 11; --pk: 0.34; animation: aur-vw-eq-1 calc(var(--aur-beat, 0.6s) * 3) ease-in-out -2.87s infinite; }\n@keyframes aur-vw-eq-0 {\n0% { scale: 1 calc(var(--pk) * 0.62); }\n14% { scale: 1 calc(var(--pk) * 0.49); }\n28% { scale: 1 calc(var(--pk) * 0.41); }\n42% { scale: 1 calc(var(--pk) * 0.83); }\n57% { scale: 1 calc(var(--pk) * 0.35); }\n71% { scale: 1 calc(var(--pk) * 0.68); }\n85% { scale: 1 calc(var(--pk) * 0.64); }\n100% { scale: 1 calc(var(--pk) * 0.64); }\n}\n@keyframes aur-vw-eq-1 {\n0% { scale: 1 calc(var(--pk) * 0.30); }\n14% { scale: 1 calc(var(--pk) * 0.73); }\n28% { scale: 1 calc(var(--pk) * 0.93); }\n42% { scale: 1 calc(var(--pk) * 0.46); }\n57% { scale: 1 calc(var(--pk) * 0.47); }\n71% { scale: 1 calc(var(--pk) * 0.93); }\n85% { scale: 1 calc(var(--pk) * 0.66); }\n100% { scale: 1 calc(var(--pk) * 0.42); }\n}\n@keyframes aur-vw-eq-2 {\n0% { scale: 1 calc(var(--pk) * 0.21); }\n14% { scale: 1 calc(var(--pk) * 0.80); }\n28% { scale: 1 calc(var(--pk) * 0.48); }\n42% { scale: 1 calc(var(--pk) * 0.57); }\n57% { scale: 1 calc(var(--pk) * 0.42); }\n71% { scale: 1 calc(var(--pk) * 0.71); }\n85% { scale: 1 calc(var(--pk) * 0.78); }\n100% { scale: 1 calc(var(--pk) * 0.45); }\n}\n@keyframes aur-vw-eq-3 {\n0% { scale: 1 calc(var(--pk) * 0.26); }\n14% { scale: 1 calc(var(--pk) * 0.99); }\n28% { scale: 1 calc(var(--pk) * 0.93); }\n42% { scale: 1 calc(var(--pk) * 0.22); }\n57% { scale: 1 calc(var(--pk) * 0.65); }\n71% { scale: 1 calc(var(--pk) * 0.75); }\n85% { scale: 1 calc(var(--pk) * 0.52); }\n100% { scale: 1 calc(var(--pk) * 0.79); }\n}\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(13) {\nleft: 0;\nright: 0;\ntop: 0;\nheight: 7vh;\nbackground: linear-gradient(to bottom, transparent, rgba(255, 255, 255, 0.16) 42%, rgba(255, 130, 220, 0.16) 58%, transparent);\nopacity: 0;\nanimation: aur-vw-track 13s linear infinite;\n}\n@keyframes aur-vw-track {\n0%, 90% { opacity: 0; transform: translateY(-8vh); }\n90.1% { opacity: 1; transform: translateY(-8vh); }\n100% { opacity: 0.9; transform: translateY(104vh); }\n}\n.aur-root[data-fx=\"vaporwave\"][data-gap=\"on\"] .aur-fx-e > i:nth-child(13) { animation-duration: 6.5s; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(n + 14) {\nleft: var(--x);\ntop: var(--y);\nwidth: var(--s);\nheight: var(--s);\nmargin: calc(var(--s) / -2) 0 0 calc(var(--s) / -2);\nbackground: #fff;\nclip-path: polygon(50% 0, 58% 42%, 100% 50%, 58% 58%, 50% 100%, 42% 58%, 0 50%, 42% 42%);\nopacity: 0.9;\nanimation: aur-vw-glint var(--d) ease-in-out var(--dl) infinite;\n}\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(14) { --x: 39.1%; --y: 15.8%; --s: 1.73vmin; --d: 4.8s; --dl: -2.9s; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(15) { --x: 67.5%; --y: 31.0%; --s: 2.17vmin; --d: 4.2s; --dl: -2.9s; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(16) { --x: 75.9%; --y: 36.1%; --s: 3.08vmin; --d: 3.4s; --dl: -0.8s; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(17) { --x: 17.8%; --y: 39.0%; --s: 1.74vmin; --d: 4.0s; --dl: -3.1s; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(18) { --x: 9.5%; --y: 41.9%; --s: 1.47vmin; --d: 4.6s; --dl: -4.2s; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(19) { --x: 23.9%; --y: 39.1%; --s: 2.86vmin; --d: 2.6s; --dl: -3.3s; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(20) { --x: 15.4%; --y: 47.9%; --s: 2.78vmin; --d: 4.9s; --dl: -0.3s; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(21) { --x: 33.2%; --y: 34.1%; --s: 2.62vmin; --d: 2.7s; --dl: -4.4s; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(22) { --x: 81.9%; --y: 19.2%; --s: 1.69vmin; --d: 4.1s; --dl: -2.0s; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(23) { --x: 65.0%; --y: 28.2%; --s: 2.19vmin; --d: 2.3s; --dl: -0.7s; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e > i:nth-child(24) { --x: 46.2%; --y: 39.2%; --s: 2.25vmin; --d: 4.3s; --dl: -2.7s; }\n@keyframes aur-vw-glint { 0%, 100% { scale: 0.35; opacity: 0.35; } 50% { scale: 1; opacity: 1; } }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e::before {\ncontent: \"\";\nposition: absolute;\nleft: 0;\nright: 0;\ntop: calc(var(--vw-h) - 26vh);\nheight: 26vh;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 360' preserveAspectRatio='xMidYMax slice'%3E%3Cg fill='%231b0a44'%3E%3Cpath d='M47.0 360.1 47.2 342.3 47.6 324.8 48.1 307.6 48.8 290.7 49.6 274.1 50.5 257.8 51.6 241.8 52.9 226.1 54.2 210.7 55.8 195.6 57.4 180.8 59.2 166.3 61.2 152.0 63.3 138.1 65.5 124.5 67.9 111.2 70.4 98.1 73.1 85.4 75.9 72.9 78.9 60.8 73.1 59.2 69.7 71.4 66.5 83.8 63.4 96.6 60.5 109.6 57.7 123.0 55.0 136.7 52.5 150.7 50.1 164.9 47.9 179.5 45.8 194.4 43.9 209.6 42.1 225.1 40.5 240.9 39.0 257.0 37.6 273.4 36.4 290.1 35.3 307.1 34.4 324.4 33.6 342.0 33.0 359.9Z'/%3E%3Cpath d='M76.0 60.0Q-21.9 -9.3 -102.0 128.2Q-21.9 24.7 76.0 60.0Z'/%3E%3Cpath d='M76.0 60.0Q-12.6 -64.7 -85.1 79.1Q-12.6 -30.7 76.0 60.0Z'/%3E%3Cpath d='M76.0 60.0Q12.9 -98.8 -38.8 31.0Q12.9 -64.8 76.0 60.0Z'/%3E%3Cpath d='M76.0 60.0Q34.7 -89.1 0.8 18.3Q34.7 -55.1 76.0 60.0Z'/%3E%3Cpath d='M76.0 60.0Q87.9 -111.6 97.7 -24.9Q87.9 -77.6 76.0 60.0Z'/%3E%3Cpath d='M76.0 60.0Q109.7 -73.6 137.4 22.7Q109.7 -39.6 76.0 60.0Z'/%3E%3Cpath d='M76.0 60.0Q127.5 -66.2 169.7 44.3Q127.5 -32.2 76.0 60.0Z'/%3E%3Cpath d='M76.0 60.0Q157.6 -43.5 224.4 88.4Q157.6 -9.5 76.0 60.0Z'/%3E%3Cpath d='M76.0 60.0Q152.0 -14.3 214.2 104.7Q152.0 19.7 76.0 60.0Z'/%3E%3Cpath d='M123.0 359.9 122.6 347.7 122.1 335.7 121.5 323.8 120.9 312.2 120.1 300.8 119.3 289.6 118.3 278.6 117.3 267.8 116.2 257.2 115.0 246.9 113.7 236.7 112.3 226.7 110.8 217.0 109.3 207.4 107.6 198.1 105.9 189.0 104.1 180.0 102.2 171.3 100.2 162.8 98.1 154.5 93.9 155.5 95.7 163.8 97.4 172.3 99.0 181.0 100.5 189.9 102.0 199.0 103.3 208.4 104.6 217.9 105.7 227.6 106.8 237.5 107.8 247.6 108.7 258.0 109.6 268.5 110.3 279.2 110.9 290.2 111.5 301.3 112.0 312.7 112.3 324.2 112.6 336.0 112.8 347.9 113.0 360.1Z'/%3E%3Cpath d='M96.0 155.0Q18.4 112.7 -45.1 216.2Q18.4 137.2 96.0 155.0Z'/%3E%3Cpath d='M96.0 155.0Q33.2 80.4 -18.2 179.0Q33.2 104.8 96.0 155.0Z'/%3E%3Cpath d='M96.0 155.0Q58.2 64.9 27.3 144.9Q58.2 89.4 96.0 155.0Z'/%3E%3Cpath d='M96.0 155.0Q92.7 47.5 90.1 100.8Q92.7 72.0 96.0 155.0Z'/%3E%3Cpath d='M96.0 155.0Q111.0 40.4 123.3 106.2Q111.0 64.8 96.0 155.0Z'/%3E%3Cpath d='M96.0 155.0Q131.5 50.9 160.6 132.6Q131.5 75.4 96.0 155.0Z'/%3E%3Cpath d='M96.0 155.0Q154.2 62.0 201.8 161.3Q154.2 86.5 96.0 155.0Z'/%3E%3Cpath d='M96.0 155.0Q151.2 101.3 196.3 187.4Q151.2 125.8 96.0 155.0Z'/%3E%3Cpath d='M1569.0 359.8 1568.2 341.3 1567.3 323.1 1566.2 305.2 1564.9 287.7 1563.4 270.4 1561.7 253.4 1559.8 236.8 1557.8 220.5 1555.6 204.5 1553.1 188.8 1550.5 173.4 1547.8 158.3 1544.8 143.5 1541.6 129.1 1538.3 115.0 1534.8 101.2 1531.1 87.7 1527.2 74.5 1523.1 61.6 1518.8 49.1 1513.2 50.9 1517.0 63.5 1520.6 76.4 1524.1 89.5 1527.4 103.0 1530.5 116.8 1533.4 130.9 1536.2 145.2 1538.7 159.9 1541.1 174.9 1543.3 190.2 1545.3 205.8 1547.1 221.8 1548.7 238.0 1550.2 254.5 1551.4 271.4 1552.5 288.5 1553.4 306.0 1554.1 323.7 1554.7 341.8 1555.0 360.2Z'/%3E%3Cpath d='M1516.0 50.0Q1418.7 -5.3 1339.1 128.0Q1418.7 28.7 1516.0 50.0Z'/%3E%3Cpath d='M1516.0 50.0Q1428.6 -68.3 1357.0 72.8Q1428.6 -34.3 1516.0 50.0Z'/%3E%3Cpath d='M1516.0 50.0Q1459.1 -68.5 1412.6 44.9Q1459.1 -34.5 1516.0 50.0Z'/%3E%3Cpath d='M1516.0 50.0Q1481.3 -89.6 1452.9 9.3Q1481.3 -55.6 1516.0 50.0Z'/%3E%3Cpath d='M1516.0 50.0Q1521.0 -95.1 1525.1 -21.8Q1521.0 -61.1 1516.0 50.0Z'/%3E%3Cpath d='M1516.0 50.0Q1543.9 -92.8 1566.8 0.7Q1543.9 -58.8 1516.0 50.0Z'/%3E%3Cpath d='M1516.0 50.0Q1568.7 -87.3 1611.8 27.3Q1568.7 -53.3 1516.0 50.0Z'/%3E%3Cpath d='M1516.0 50.0Q1602.3 -44.9 1672.9 89.0Q1602.3 -10.9 1516.0 50.0Z'/%3E%3Cpath d='M1516.0 50.0Q1594.2 -25.2 1658.2 96.0Q1594.2 8.8 1516.0 50.0Z'/%3E%3Cpath d='M1488.9 360.1 1489.1 347.6 1489.3 335.4 1489.7 323.4 1490.2 311.5 1490.8 299.9 1491.5 288.5 1492.3 277.3 1493.2 266.3 1494.2 255.5 1495.3 244.9 1496.5 234.6 1497.8 224.4 1499.2 214.4 1500.7 204.7 1502.3 195.2 1504.1 185.8 1505.9 176.7 1507.8 167.8 1509.9 159.1 1512.0 150.6 1508.0 149.4 1505.5 157.9 1503.2 166.7 1501.0 175.6 1498.9 184.7 1496.9 194.1 1494.9 203.7 1493.1 213.4 1491.4 223.4 1489.8 233.7 1488.3 244.1 1486.9 254.7 1485.6 265.5 1484.5 276.6 1483.4 287.9 1482.4 299.3 1481.5 311.0 1480.8 322.9 1480.1 335.0 1479.6 347.4 1479.1 359.9Z'/%3E%3Cpath d='M1510.0 150.0Q1441.7 111.7 1385.9 205.0Q1441.7 135.5 1510.0 150.0Z'/%3E%3Cpath d='M1510.0 150.0Q1459.0 70.9 1417.3 159.4Q1459.0 94.7 1510.0 150.0Z'/%3E%3Cpath d='M1510.0 150.0Q1465.7 44.9 1429.5 134.2Q1465.7 68.7 1510.0 150.0Z'/%3E%3Cpath d='M1510.0 150.0Q1503.0 34.7 1497.2 92.9Q1503.0 58.5 1510.0 150.0Z'/%3E%3Cpath d='M1510.0 150.0Q1521.1 45.9 1530.2 104.8Q1521.1 69.7 1510.0 150.0Z'/%3E%3Cpath d='M1510.0 150.0Q1536.1 47.6 1557.5 119.7Q1536.1 71.4 1510.0 150.0Z'/%3E%3Cpath d='M1510.0 150.0Q1553.8 83.4 1589.7 162.1Q1553.8 107.2 1510.0 150.0Z'/%3E%3Cpath d='M1510.0 150.0Q1565.9 112.5 1611.7 194.4Q1565.9 136.3 1510.0 150.0Z'/%3E%3C/g%3E%3C/svg%3E\") center bottom / 100% 100% no-repeat;\ntransform-origin: 50% 100%;\nanimation: aur-vw-sway 11s ease-in-out infinite alternate;\n}\n@keyframes aur-vw-sway { from { transform: skewX(-0.7deg); } to { transform: skewX(0.8deg); } }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-e::after {\ncontent: \"\";\nposition: absolute;\ninset: -240px;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 240' preserveAspectRatio='none'%3E%3Cdefs%3E%3Cfilter id='n' x='0' y='0' width='240' height='240' filterUnits='userSpaceOnUse'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' seed='4' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 1.9 0 0 0 -.78'/%3E%3C/filter%3E%3C/defs%3E%3Crect width='240' height='240' filter='url(%23n)'/%3E%3C/svg%3E\") 0 0 / 240px 240px repeat;\nopacity: 0.16;\nanimation: aur-vw-grain 0.6s steps(1) infinite;\n}\n@keyframes aur-vw-grain {\n0% { translate: 0 0; }\n20% { translate: -70px 40px; }\n40% { translate: 50px -90px; }\n60% { translate: -30px -20px; }\n80% { translate: 90px 70px; }\n}\n.aur-root[data-fx=\"vaporwave\"][data-bganim=\"on\"] .aur-bg[data-bar=\"a\"] .aur-fx-c::after { animation: aur-fx-flash-a 0.8s ease-out; }\n.aur-root[data-fx=\"vaporwave\"][data-bganim=\"on\"] .aur-bg[data-bar=\"b\"] .aur-fx-c::after { animation: aur-fx-flash-b 0.8s ease-out; }\n.aur-root[data-look=\"vaporwave\"]:is([data-view=\"split\"], [data-view=\"mirror\"], [data-view=\"captions\"], [data-view=\"stage\"]) .aur-art-wrap,\n.aur-root[data-look=\"vaporwave\"]:is([data-view=\"split\"], [data-view=\"mirror\"], [data-view=\"captions\"], [data-view=\"stage\"])[data-playing=\"false\"] .aur-art-wrap {\n--vw-bar: max(15px, 3.4vmin);\nborder-radius: 0;\nbox-shadow:\n0 0 0 1px #6f6a8c,\n0 0 0 6px #d6d2ea,\n0 0 0 7px #fff,\n0 0 0 8px #1a1030,\n1.1vmin 1.1vmin 0 8px rgba(30, 10, 80, 0.5);\n}\n.aur-root[data-look=\"vaporwave\"]:is([data-view=\"split\"], [data-view=\"mirror\"], [data-view=\"captions\"], [data-view=\"stage\"]) .aur-art-wrap::before {\ncontent: \"ａｌｂｕｍ．ｂｍｐ\";\nposition: absolute;\nleft: -8px;\nright: -8px;\nbottom: calc(100% + 8px);\nheight: calc(var(--vw-bar) + 9px);\nbox-sizing: border-box;\npadding: 3px 3px 0 3px;\ndisplay: flex;\nalign-items: center;\npadding-left: calc(0.7em + 3px);\ncolor: #fff;\nfont: 700 calc(var(--vw-bar) * 0.5) / 1 var(--aur-ui-font);\nletter-spacing: 0.06em;\nwhite-space: nowrap;\noverflow: hidden;\nbackground:\nlinear-gradient(#d6d2ea, #d6d2ea) right calc(0.5em + 3px) top 50% / calc(var(--vw-bar) * 0.62) calc(var(--vw-bar) * 0.62) no-repeat,\nlinear-gradient(#d6d2ea, #d6d2ea) right calc(0.5em + var(--vw-bar) * 0.8 + 3px) top 50% / calc(var(--vw-bar) * 0.62) calc(var(--vw-bar) * 0.62) no-repeat,\nlinear-gradient(90deg, #ff71ce, #b967ff 55%, #01cdfe) content-box,\n#d6d2ea;\nbackground-clip: border-box, border-box, content-box, border-box;\nborder: 1px solid #1a1030;\nborder-bottom: 0;\nbox-shadow: inset 1px 1px 0 #fff;\n}\n.aur-root[data-look=\"vaporwave\"] :is(.aur-side-title, .aur-side-artist, .aur-side-album) { text-shadow: 0 0.06em 0.4em rgba(46, 8, 110, 0.85); }\n.aur-root[data-look=\"vaporwave\"] { --aur-glow-tint: #ff8ee0; --vw-ink: #fff4fc; --vw-ghost: rgba(240, 226, 255, 0.55); }\n.aur-root[data-look=\"vaporwave\"][data-color=\"white\"] { --aur-hi: var(--vw-ink); }\n.aur-root[data-look=\"vaporwave\"] .aur-stage .aur-line { letter-spacing: 0.03em; font-size: calc(var(--aur-size) * 0.86); }\n.aur-root[data-look=\"vaporwave\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-active) .aur-main { color: var(--vw-ghost); text-shadow: 0 0.03em 0.32em rgba(46, 8, 110, 0.8), 0 0 0.08em rgba(46, 8, 110, 0.5); }\n.aur-root[data-look=\"vaporwave\"][data-words=\"on\"] .aur-stage .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\ncolor: color-mix(in srgb, var(--vw-ink) calc(var(--e) * 100%), var(--vw-ghost));\nbackground: none;\ntext-shadow:\ncalc(var(--e) * 0.045em) 0 0 color-mix(in srgb, #ff50c8 calc(var(--e) * 75%), transparent),\ncalc(var(--e) * -0.045em) 0 0 color-mix(in srgb, #00e5ff calc(var(--e) * 65%), transparent),\n0 0.04em 0.45em rgba(60, 10, 120, 0.6);\nfilter: none;\n}\n.aur-root[data-look=\"vaporwave\"] .aur-stage .is-active:not(.has-words) .aur-main,\n.aur-root[data-look=\"vaporwave\"][data-words=\"off\"] .aur-stage .is-active .aur-main {\ncolor: var(--vw-ink);\ntext-shadow: 0.045em 0 0 rgba(255, 80, 200, 0.75), -0.045em 0 0 rgba(0, 229, 255, 0.65), 0 0.04em 0.45em rgba(60, 10, 120, 0.6);\n}\n.aur-root[data-look=\"vaporwave\"][data-motion=\"full\"][data-lb=\"a\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active .aur-main { animation: aur-vw-shudder-a 0.4s steps(1); }\n.aur-root[data-look=\"vaporwave\"][data-motion=\"full\"][data-lb=\"b\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active .aur-main { animation: aur-vw-shudder-b 0.4s steps(1); }\n@keyframes aur-vw-shudder-a { 0% { translate: 0.05em 0; } 20% { translate: -0.06em -0.01em; } 40% { translate: 0.04em 0.01em; } 60% { translate: -0.02em 0; } 80% { translate: 0.01em 0; } 100% { translate: 0 0; } }\n@keyframes aur-vw-shudder-b { 0% { translate: 0.05em 0; } 20% { translate: -0.06em -0.01em; } 40% { translate: 0.04em 0.01em; } 60% { translate: -0.02em 0; } 80% { translate: 0.01em 0; } 100% { translate: 0 0; } }\n.aur-root[data-look=\"vaporwave\"] .aur-dots i { background: color-mix(in oklab, var(--aur-accent) 60%, #fff); box-shadow: 0 0 0.3em var(--aur-accent), 0.1em 0 0 rgba(0, 229, 255, 0.6); }\n.aur-root[data-fx=\"ocean\"] .aur-fx {\nbackground:\nlinear-gradient(to bottom,\ncolor-mix(in oklab, rgb(30, 172, 214) calc((1 - var(--aur-song, 0)) * 100%), rgb(8, 72, 130)) 0%,\ncolor-mix(in oklab, rgb(12, 114, 172) calc((1 - var(--aur-song, 0)) * 100%), rgb(5, 44, 98)) 34%,\ncolor-mix(in oklab, rgb(6, 68, 130) calc((1 - var(--aur-song, 0)) * 100%), rgb(3, 24, 68)) 68%,\ncolor-mix(in oklab, rgb(3, 36, 86) calc((1 - var(--aur-song, 0)) * 100%), rgb(2, 10, 36)) 100%);\n}\n.aur-root[data-fx=\"ocean\"] .aur-fx::before {\ncontent: \"\";\nposition: absolute;\nleft: 0;\ntop: 0;\nwidth: 200%;\nheight: 18%;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2400 240' preserveAspectRatio='none'%3E%3Cdefs%3E%3ClinearGradient id='w' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%23f2ffff' stop-opacity='0.9'/%3E%3Cstop offset='0.5' stop-color='%239be8ff' stop-opacity='0.28'/%3E%3Cstop offset='1' stop-color='%235fd0ff' stop-opacity='0'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath d='M0 0H2400V56L2400 56.0 2392 50.0 2384 44.4 2376 39.6 2368 35.9 2360 33.4 2352 32.3 2344 32.3 2336 33.2 2328 34.8 2320 36.7 2312 38.5 2304 39.9 2296 40.7 2288 40.7 2280 40.2 2272 39.1 2264 37.7 2256 36.4 2248 35.6 2240 35.5 2232 36.4 2224 38.5 2216 41.9 2208 46.3 2200 51.7 2192 57.6 2184 63.6 2176 69.3 2168 74.3 2160 78.3 2152 81.1 2144 82.5 2136 82.6 2128 81.6 2120 79.7 2112 77.4 2104 75.0 2096 72.9 2088 71.2 2080 70.2 2072 70.0 2064 70.3 2056 71.1 2048 72.1 2040 72.8 2032 72.9 2024 72.2 2016 70.5 2008 67.5 2000 63.5 1992 58.5 1984 52.9 1976 47.0 1968 41.3 1960 36.1 1952 31.9 1944 28.9 1936 27.3 1928 27.1 1920 28.1 1912 30.1 1904 32.8 1896 35.7 1888 38.6 1880 41.1 1872 42.9 1864 44.0 1856 44.4 1848 44.2 1840 43.7 1832 43.2 1824 43.0 1816 43.5 1808 44.9 1800 47.4 1792 50.9 1784 55.4 1776 60.7 1768 66.3 1760 71.9 1752 77.1 1744 81.4 1736 84.5 1728 86.3 1720 86.7 1712 85.7 1704 83.6 1696 80.7 1688 77.3 1680 73.7 1672 70.5 1664 67.9 1656 65.9 1648 64.8 1640 64.3 1632 64.4 1624 64.7 1616 64.8 1608 64.5 1600 63.5 1592 61.5 1584 58.5 1576 54.6 1568 49.8 1560 44.6 1552 39.2 1544 34.2 1536 29.8 1528 26.5 1520 24.6 1512 24.1 1504 25.0 1496 27.1 1488 30.3 1480 34.1 1472 38.1 1464 42.0 1456 45.5 1448 48.2 1440 50.1 1432 51.2 1424 51.6 1416 51.7 1408 51.6 1400 51.7 1392 52.4 1384 53.8 1376 56.2 1368 59.5 1360 63.7 1352 68.4 1344 73.4 1336 78.2 1328 82.5 1320 85.8 1312 87.9 1304 88.6 1296 87.8 1288 85.6 1280 82.3 1272 78.3 1264 73.8 1256 69.3 1248 65.1 1240 61.7 1232 59.0 1224 57.3 1216 56.3 1208 56.0 1200 56.0 1192 56.0 1184 55.7 1176 54.7 1168 53.0 1160 50.3 1152 46.9 1144 42.7 1136 38.2 1128 33.7 1120 29.7 1112 26.4 1104 24.2 1096 23.4 1088 24.1 1080 26.2 1072 29.5 1064 33.8 1056 38.6 1048 43.6 1040 48.3 1032 52.5 1024 55.8 1016 58.2 1008 59.6 1000 60.3 992 60.4 984 60.3 976 60.4 968 60.8 960 61.9 952 63.8 944 66.5 936 70.0 928 73.9 920 77.9 912 81.7 904 84.9 896 87.0 888 87.9 880 87.4 872 85.5 864 82.2 856 77.8 848 72.8 840 67.4 832 62.2 824 57.4 816 53.5 808 50.5 800 48.5 792 47.5 784 47.2 776 47.3 768 47.6 760 47.7 752 47.2 744 46.1 736 44.1 728 41.5 720 38.3 712 34.7 704 31.3 696 28.4 688 26.3 680 25.3 672 25.7 664 27.5 656 30.6 648 34.9 640 40.1 632 45.7 624 51.3 616 56.6 608 61.1 600 64.6 592 67.1 584 68.5 576 69.0 568 68.8 560 68.3 552 67.8 544 67.6 536 68.0 528 69.1 520 70.9 512 73.4 504 76.3 496 79.2 488 81.9 480 83.9 472 84.9 464 84.7 456 83.1 448 80.1 440 75.9 432 70.7 424 65.0 416 59.1 408 53.5 400 48.5 392 44.5 384 41.5 376 39.8 368 39.1 360 39.2 352 39.9 344 40.9 336 41.7 328 42.0 320 41.8 312 40.8 304 39.1 296 37.0 288 34.6 280 32.3 272 30.4 264 29.4 256 29.5 248 30.9 240 33.7 232 37.7 224 42.7 216 48.4 208 54.4 200 60.3 192 65.7 184 70.1 176 73.5 168 75.6 160 76.5 152 76.4 144 75.6 136 74.3 128 72.9 120 71.8 112 71.3 104 71.3 96 72.1 88 73.5 80 75.3 72 77.2 64 78.8 56 79.7 48 79.7 40 78.6 32 76.1 24 72.4 16 67.6 8 62.0 0 56.0Z' fill='url(%23w)'/%3E%3Cpath d='M0 56.0 8 62.0 16 67.6 24 72.4 32 76.1 40 78.6 48 79.7 56 79.7 64 78.8 72 77.2 80 75.3 88 73.5 96 72.1 104 71.3 112 71.3 120 71.8 128 72.9 136 74.3 144 75.6 152 76.4 160 76.5 168 75.6 176 73.5 184 70.1 192 65.7 200 60.3 208 54.4 216 48.4 224 42.7 232 37.7 240 33.7 248 30.9 256 29.5 264 29.4 272 30.4 280 32.3 288 34.6 296 37.0 304 39.1 312 40.8 320 41.8 328 42.0 336 41.7 344 40.9 352 39.9 360 39.2 368 39.1 376 39.8 384 41.5 392 44.5 400 48.5 408 53.5 416 59.1 424 65.0 432 70.7 440 75.9 448 80.1 456 83.1 464 84.7 472 84.9 480 83.9 488 81.9 496 79.2 504 76.3 512 73.4 520 70.9 528 69.1 536 68.0 544 67.6 552 67.8 560 68.3 568 68.8 576 69.0 584 68.5 592 67.1 600 64.6 608 61.1 616 56.6 624 51.3 632 45.7 640 40.1 648 34.9 656 30.6 664 27.5 672 25.7 680 25.3 688 26.3 696 28.4 704 31.3 712 34.7 720 38.3 728 41.5 736 44.1 744 46.1 752 47.2 760 47.7 768 47.6 776 47.3 784 47.2 792 47.5 800 48.5 808 50.5 816 53.5 824 57.4 832 62.2 840 67.4 848 72.8 856 77.8 864 82.2 872 85.5 880 87.4 888 87.9 896 87.0 904 84.9 912 81.7 920 77.9 928 73.9 936 70.0 944 66.5 952 63.8 960 61.9 968 60.8 976 60.4 984 60.3 992 60.4 1000 60.3 1008 59.6 1016 58.2 1024 55.8 1032 52.5 1040 48.3 1048 43.6 1056 38.6 1064 33.8 1072 29.5 1080 26.2 1088 24.1 1096 23.4 1104 24.2 1112 26.4 1120 29.7 1128 33.7 1136 38.2 1144 42.7 1152 46.9 1160 50.3 1168 53.0 1176 54.7 1184 55.7 1192 56.0 1200 56.0 1208 56.0 1216 56.3 1224 57.3 1232 59.0 1240 61.7 1248 65.1 1256 69.3 1264 73.8 1272 78.3 1280 82.3 1288 85.6 1296 87.8 1304 88.6 1312 87.9 1320 85.8 1328 82.5 1336 78.2 1344 73.4 1352 68.4 1360 63.7 1368 59.5 1376 56.2 1384 53.8 1392 52.4 1400 51.7 1408 51.6 1416 51.7 1424 51.6 1432 51.2 1440 50.1 1448 48.2 1456 45.5 1464 42.0 1472 38.1 1480 34.1 1488 30.3 1496 27.1 1504 25.0 1512 24.1 1520 24.6 1528 26.5 1536 29.8 1544 34.2 1552 39.2 1560 44.6 1568 49.8 1576 54.6 1584 58.5 1592 61.5 1600 63.5 1608 64.5 1616 64.8 1624 64.7 1632 64.4 1640 64.3 1648 64.8 1656 65.9 1664 67.9 1672 70.5 1680 73.7 1688 77.3 1696 80.7 1704 83.6 1712 85.7 1720 86.7 1728 86.3 1736 84.5 1744 81.4 1752 77.1 1760 71.9 1768 66.3 1776 60.7 1784 55.4 1792 50.9 1800 47.4 1808 44.9 1816 43.5 1824 43.0 1832 43.2 1840 43.7 1848 44.2 1856 44.4 1864 44.0 1872 42.9 1880 41.1 1888 38.6 1896 35.7 1904 32.8 1912 30.1 1920 28.1 1928 27.1 1936 27.3 1944 28.9 1952 31.9 1960 36.1 1968 41.3 1976 47.0 1984 52.9 1992 58.5 2000 63.5 2008 67.5 2016 70.5 2024 72.2 2032 72.9 2040 72.8 2048 72.1 2056 71.1 2064 70.3 2072 70.0 2080 70.2 2088 71.2 2096 72.9 2104 75.0 2112 77.4 2120 79.7 2128 81.6 2136 82.6 2144 82.5 2152 81.1 2160 78.3 2168 74.3 2176 69.3 2184 63.6 2192 57.6 2200 51.7 2208 46.3 2216 41.9 2224 38.5 2232 36.4 2240 35.5 2248 35.6 2256 36.4 2264 37.7 2272 39.1 2280 40.2 2288 40.7 2296 40.7 2304 39.9 2312 38.5 2320 36.7 2328 34.8 2336 33.2 2344 32.3 2352 32.3 2360 33.4 2368 35.9 2376 39.6 2384 44.4 2392 50.0 2400 56.0' fill='none' stroke='%23f2ffff' stroke-opacity='0.9' stroke-width='5'/%3E%3Cpath d='M0 104.4 8 101.6 16 99.1 24 97.2 32 96.0 40 95.4 48 95.4 56 95.4 64 95.0 72 94.0 80 92.0 88 89.1 96 85.3 104 81.0 112 76.7 120 72.8 128 70.0 136 68.5 144 68.5 152 70.1 160 72.8 168 76.4 176 80.3 184 84.0 192 87.1 200 89.4 208 90.8 216 91.5 224 91.7 232 91.9 240 92.4 248 93.6 256 95.6 264 98.3 272 101.6 280 105.0 288 108.0 296 110.2 304 111.1 312 110.6 320 108.5 328 105.1 336 100.8 344 96.1 352 91.6 360 87.6 368 84.5 376 82.6 384 81.6 392 81.5 400 81.8 408 82.0 416 81.9 424 81.1 432 79.7 440 77.7 448 75.5 456 73.4 464 72.0 472 71.6 480 72.6 488 75.0 496 78.7 504 83.4 512 88.5 520 93.5 528 97.9 536 101.3 544 103.5 552 104.4 560 104.2 568 103.3 576 102.1 584 101.0 592 100.3 600 100.3 608 100.9 616 101.9 624 103.0 632 103.6 640 103.5 648 102.4 656 99.9 664 96.3 672 91.7 680 86.6 688 81.6 696 77.2 704 73.8 712 71.7 720 71.1 728 71.8 736 73.5 744 75.8 752 78.2 760 80.3 768 81.8 776 82.5 784 82.7 792 82.5 800 82.4 808 82.7 816 83.8 824 86.0 832 89.2 840 93.2 848 97.8 856 102.4 864 106.4 872 109.4 880 111.1 888 111.2 896 109.9 904 107.4 912 104.1 920 100.5 928 97.2 936 94.4 944 92.5 952 91.4 960 90.9 968 90.7 976 90.4 984 89.7 992 88.2 1000 85.9 1008 82.7 1016 79.1 1024 75.3 1032 72.0 1040 69.6 1048 68.5 1056 68.9 1064 70.8 1072 74.0 1080 78.1 1088 82.5 1096 86.9 1104 90.6 1112 93.4 1120 95.2 1128 96.1 1136 96.3 1144 96.2 1152 96.3 1160 96.8 1168 98.0 1176 99.9 1184 102.3 1192 104.9 1200 107.3 1208 109.0 1216 109.5 1224 108.7 1232 106.3 1240 102.7 1248 98.2 1256 93.1 1264 88.2 1272 83.9 1280 80.5 1288 78.4 1296 77.5 1304 77.5 1312 78.2 1320 79.1 1328 79.8 1336 79.9 1344 79.5 1352 78.4 1360 77.0 1368 75.6 1376 74.7 1384 74.7 1392 75.8 1400 78.3 1408 82.0 1416 86.6 1424 91.8 1432 96.8 1440 101.3 1448 104.8 1456 106.9 1464 107.6 1472 107.1 1480 105.7 1488 103.7 1496 101.8 1504 100.1 1512 99.1 1520 98.8 1528 99.0 1536 99.5 1544 99.8 1552 99.5 1560 98.3 1568 96.0 1576 92.6 1584 88.4 1592 83.6 1600 78.8 1608 74.6 1616 71.4 1624 69.6 1632 69.3 1640 70.4 1648 72.7 1656 75.6 1664 78.8 1672 81.8 1680 84.1 1688 85.7 1696 86.6 1704 86.9 1712 87.0 1720 87.3 1728 88.2 1736 89.9 1744 92.6 1752 96.1 1760 100.1 1768 104.1 1776 107.7 1784 110.3 1792 111.7 1800 111.4 1808 109.7 1816 106.7 1824 102.9 1832 98.7 1840 94.6 1848 91.2 1856 88.6 1864 87.0 1872 86.2 1880 86.0 1888 85.9 1896 85.6 1904 84.7 1912 83.1 1920 80.8 1928 77.9 1936 74.9 1944 72.2 1952 70.3 1960 69.5 1968 70.3 1976 72.5 1984 76.0 1992 80.4 2000 85.3 2008 90.1 2016 94.3 2024 97.5 2032 99.6 2040 100.5 2048 100.6 2056 100.1 2064 99.6 2072 99.3 2080 99.6 2088 100.5 2096 102.1 2104 103.9 2112 105.6 2120 106.8 2128 107.0 2136 105.9 2144 103.4 2152 99.7 2160 95.0 2168 89.9 2176 84.8 2184 80.3 2192 76.9 2200 74.7 2208 73.9 2216 74.2 2224 75.4 2232 77.0 2240 78.5 2248 79.6 2256 80.2 2264 80.0 2272 79.4 2280 78.7 2288 78.2 2296 78.4 2304 79.6 2312 82.0 2320 85.6 2328 90.0 2336 94.9 2344 99.9 2352 104.2 2360 107.5 2368 109.5 2376 109.9 2384 109.0 2392 107.0 2400 104.4' fill='none' stroke='%23f2ffff' stroke-opacity='0.55' stroke-width='3.5'/%3E%3Cpath d='M0 124.1 8 124.1 16 123.9 24 123.7 32 123.2 40 122.6 48 121.7 56 120.5 64 119.2 72 117.6 80 115.9 88 114.2 96 112.6 104 111.0 112 109.7 120 108.7 128 108.1 136 107.9 144 108.1 152 108.8 160 109.9 168 111.4 176 113.2 184 115.2 192 117.3 200 119.4 208 121.5 216 123.4 224 125.1 232 126.6 240 127.7 248 128.5 256 129.1 264 129.4 272 129.5 280 129.5 288 129.4 296 129.3 304 129.4 312 129.5 320 129.9 328 130.4 336 131.2 344 132.1 352 133.2 360 134.3 368 135.4 376 136.5 384 137.3 392 137.9 400 138.2 408 138.1 416 137.6 424 136.6 432 135.3 440 133.6 448 131.6 456 129.3 464 127.0 472 124.6 480 122.3 488 120.1 496 118.2 504 116.5 512 115.3 520 114.4 528 113.8 536 113.6 544 113.7 552 114.0 560 114.4 568 114.9 576 115.4 584 115.9 592 116.2 600 116.3 608 116.3 616 116.0 624 115.7 632 115.2 640 114.6 648 114.1 656 113.7 664 113.4 672 113.5 680 113.8 688 114.5 696 115.5 704 116.9 712 118.7 720 120.7 728 122.9 736 125.3 744 127.7 752 130.0 760 132.2 768 134.1 776 135.7 784 136.9 792 137.7 800 138.0 808 138.0 816 137.6 824 137.0 832 136.1 840 135.0 848 133.9 856 132.8 864 131.8 872 131.0 880 130.3 888 129.9 896 129.6 904 129.5 912 129.5 920 129.6 928 129.7 936 129.7 944 129.5 952 129.1 960 128.5 968 127.5 976 126.3 984 124.7 992 122.9 1000 120.9 1008 118.8 1016 116.6 1024 114.5 1032 112.6 1040 110.9 1048 109.6 1056 108.6 1064 108.1 1072 108.0 1080 108.3 1088 109.1 1096 110.2 1104 111.5 1112 113.1 1120 114.8 1128 116.5 1136 118.1 1144 119.6 1152 120.8 1160 121.9 1168 122.6 1176 123.2 1184 123.6 1192 123.8 1200 123.9 1208 123.9 1216 124.1 1224 124.3 1232 124.8 1240 125.4 1248 126.3 1256 127.5 1264 128.8 1272 130.4 1280 132.1 1288 133.8 1296 135.4 1304 137.0 1312 138.3 1320 139.3 1328 139.9 1336 140.1 1344 139.9 1352 139.2 1360 138.1 1368 136.6 1376 134.8 1384 132.8 1392 130.7 1400 128.6 1408 126.5 1416 124.6 1424 122.9 1432 121.4 1440 120.3 1448 119.5 1456 118.9 1464 118.6 1472 118.5 1480 118.5 1488 118.6 1496 118.7 1504 118.6 1512 118.5 1520 118.1 1528 117.6 1536 116.8 1544 115.9 1552 114.8 1560 113.7 1568 112.6 1576 111.5 1584 110.7 1592 110.1 1600 109.8 1608 109.9 1616 110.4 1624 111.4 1632 112.7 1640 114.4 1648 116.4 1656 118.7 1664 121.0 1672 123.4 1680 125.7 1688 127.9 1696 129.8 1704 131.5 1712 132.7 1720 133.6 1728 134.2 1736 134.4 1744 134.3 1752 134.0 1760 133.6 1768 133.1 1776 132.6 1784 132.1 1792 131.8 1800 131.7 1808 131.7 1816 132.0 1824 132.3 1832 132.8 1840 133.4 1848 133.9 1856 134.3 1864 134.6 1872 134.5 1880 134.2 1888 133.5 1896 132.5 1904 131.1 1912 129.3 1920 127.3 1928 125.1 1936 122.7 1944 120.3 1952 118.0 1960 115.8 1968 113.9 1976 112.3 1984 111.1 1992 110.3 2000 110.0 2008 110.0 2016 110.4 2024 111.0 2032 111.9 2040 113.0 2048 114.1 2056 115.2 2064 116.2 2072 117.0 2080 117.7 2088 118.1 2096 118.4 2104 118.5 2112 118.5 2120 118.4 2128 118.3 2136 118.3 2144 118.5 2152 118.9 2160 119.5 2168 120.5 2176 121.7 2184 123.3 2192 125.1 2200 127.1 2208 129.2 2216 131.4 2224 133.5 2232 135.4 2240 137.1 2248 138.4 2256 139.4 2264 139.9 2272 140.0 2280 139.7 2288 138.9 2296 137.8 2304 136.5 2312 134.9 2320 133.2 2328 131.5 2336 129.9 2344 128.4 2352 127.2 2360 126.1 2368 125.4 2376 124.8 2384 124.4 2392 124.2 2400 124.1' fill='none' stroke='%23f2ffff' stroke-opacity='0.35' stroke-width='2.5'/%3E%3C/svg%3E\") 0 0 / 50% 100% repeat-x;\nopacity: calc(0.95 - var(--aur-song, 0) * 0.55);\ntransition: opacity 1.5s linear;\nanimation: aur-oc-waves 46s linear infinite;\n}\n@keyframes aur-oc-waves { to { transform: translateX(-50%); } }\n.aur-root[data-fx=\"ocean\"] .aur-fx::after {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: radial-gradient(130% 110% at 50% 40%, transparent 50%, rgba(0, 8, 28, 0.55));\n}\n.aur-root[data-fx=\"ocean\"] .aur-fx-a {\ndisplay: block;\nleft: -10%;\nright: -10%;\ntop: -6%;\nheight: 100%;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 1000' preserveAspectRatio='none'%3E%3Cdefs%3E%3ClinearGradient id='b' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%23f2ffff'/%3E%3Cstop offset='0.3' stop-color='%23a6ecff' stop-opacity='0.6'/%3E%3Cstop offset='0.7' stop-color='%2356c8ff' stop-opacity='0.2'/%3E%3Cstop offset='1' stop-color='%233aa8e0' stop-opacity='0'/%3E%3C/linearGradient%3E%3Cfilter id='f' x='-10%25' y='-10%25' width='120%25' height='120%25'%3E%3CfeGaussianBlur stdDeviation='10'/%3E%3C/filter%3E%3C/defs%3E%3Cg fill='url(%23b)' filter='url(%23f)'%3E%3Cpath d='M1169 0L1275 0 1693 1000 1253 1000Z' fill-opacity='0.35'/%3E%3Cpath d='M961 0L1038 0 1572 1000 1160 1000Z' fill-opacity='0.85'/%3E%3Cpath d='M336 0L440 0 999 1000 523 1000Z' fill-opacity='0.70'/%3E%3Cpath d='M991 0L1047 0 1584 1000 1104 1000Z' fill-opacity='0.52'/%3E%3Cpath d='M1185 0L1280 0 1857 1000 1420 1000Z' fill-opacity='0.41'/%3E%3Cpath d='M1180 0L1285 0 1641 1000 1247 1000Z' fill-opacity='0.48'/%3E%3Cpath d='M916 0L979 0 1635 1000 1195 1000Z' fill-opacity='0.48'/%3E%3C/g%3E%3C/svg%3E\") center top / 100% 100% no-repeat;\ntransform-origin: 50% 0;\nopacity: calc(0.9 - var(--aur-song, 0) * 0.72);\ntransition: opacity 1.5s linear;\nanimation: aur-oc-sway 24s ease-in-out infinite alternate;\n}\n.aur-root[data-fx=\"ocean\"] .aur-fx-a::before {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 1000' preserveAspectRatio='none'%3E%3Cdefs%3E%3ClinearGradient id='b' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%23f2ffff'/%3E%3Cstop offset='0.3' stop-color='%23a6ecff' stop-opacity='0.6'/%3E%3Cstop offset='0.7' stop-color='%2356c8ff' stop-opacity='0.2'/%3E%3Cstop offset='1' stop-color='%233aa8e0' stop-opacity='0'/%3E%3C/linearGradient%3E%3Cfilter id='f' x='-10%25' y='-10%25' width='120%25' height='120%25'%3E%3CfeGaussianBlur stdDeviation='16'/%3E%3C/filter%3E%3C/defs%3E%3Cg fill='url(%23b)' filter='url(%23f)'%3E%3Cpath d='M659 0L752 0 1201 1000 819 1000Z' fill-opacity='0.27'/%3E%3Cpath d='M500 0L562 0 1183 1000 720 1000Z' fill-opacity='0.56'/%3E%3Cpath d='M793 0L886 0 1194 1000 734 1000Z' fill-opacity='0.34'/%3E%3Cpath d='M1350 0L1394 0 1842 1000 1573 1000Z' fill-opacity='0.60'/%3E%3Cpath d='M439 0L512 0 983 1000 673 1000Z' fill-opacity='0.29'/%3E%3C/g%3E%3C/svg%3E\") center top / 100% 100% no-repeat;\nanimation: aur-oc-sway 33s ease-in-out infinite alternate-reverse;\n}\n@keyframes aur-oc-sway {\nfrom { transform: rotate(-2.6deg) translate3d(-2%, 0, 0); }\nto { transform: rotate(2.6deg) translate3d(2%, 0, 0); }\n}\n.aur-root[data-fx=\"ocean\"][data-gap=\"on\"] .aur-fx-a { opacity: calc(1 - var(--aur-song, 0) * 0.5); }\n.aur-root[data-fx=\"ocean\"][data-bganim=\"on\"][data-lb=\"a\"] .aur-fx-a { animation: aur-oc-sway 24s ease-in-out infinite alternate, aur-fx-flash-a 2.2s ease-out; }\n.aur-root[data-fx=\"ocean\"][data-bganim=\"on\"][data-lb=\"b\"] .aur-fx-a { animation: aur-oc-sway 24s ease-in-out infinite alternate, aur-fx-flash-b 2.2s ease-out; }\n.aur-root[data-fx=\"ocean\"] .aur-fx-b {\ndisplay: block;\nleft: 0;\nright: 0;\ntop: 0;\nheight: calc(100% + 700px);\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 700 700' preserveAspectRatio='none'%3E%3Cdefs%3E%3CradialGradient id='d'%3E%3Cstop offset='0' stop-color='%23e8fbff'/%3E%3Cstop offset='1' stop-color='%23e8fbff' stop-opacity='0'/%3E%3C/radialGradient%3E%3C/defs%3E%3Ccircle cx='166.6' cy='381.0' r='0.9' fill='%23e8fbff' fill-opacity='0.52'/%3E%3Ccircle cx='438.0' cy='45.9' r='0.6' fill='%23e8fbff' fill-opacity='0.63'/%3E%3Ccircle cx='181.5' cy='164.0' r='1.5' fill='%23e8fbff' fill-opacity='0.46'/%3E%3Ccircle cx='585.5' cy='333.4' r='1.2' fill='%23e8fbff' fill-opacity='0.31'/%3E%3Ccircle cx='444.4' cy='607.6' r='1.1' fill='%23e8fbff' fill-opacity='0.58'/%3E%3Ccircle cx='470.0' cy='44.8' r='1.3' fill='%23e8fbff' fill-opacity='0.51'/%3E%3Ccircle cx='210.9' cy='21.7' r='1.4' fill='%23e8fbff' fill-opacity='0.46'/%3E%3Ccircle cx='503.2' cy='615.2' r='1.2' fill='%23e8fbff' fill-opacity='0.66'/%3E%3Ccircle cx='276.5' cy='560.6' r='1.0' fill='%23e8fbff' fill-opacity='0.67'/%3E%3Ccircle cx='615.2' cy='68.2' r='0.7' fill='%23e8fbff' fill-opacity='0.34'/%3E%3Ccircle cx='675.8' cy='305.3' r='1.2' fill='%23e8fbff' fill-opacity='0.38'/%3E%3Ccircle cx='355.1' cy='270.1' r='0.9' fill='%23e8fbff' fill-opacity='0.51'/%3E%3Ccircle cx='409.0' cy='632.9' r='1.2' fill='%23e8fbff' fill-opacity='0.67'/%3E%3Ccircle cx='599.5' cy='693.7' r='1.2' fill='%23e8fbff' fill-opacity='0.32'/%3E%3Ccircle cx='602.4' cy='675.2' r='1.4' fill='%23e8fbff' fill-opacity='0.50'/%3E%3Ccircle cx='499.7' cy='147.8' r='1.3' fill='%23e8fbff' fill-opacity='0.51'/%3E%3Ccircle cx='199.5' cy='44.4' r='1.4' fill='%23e8fbff' fill-opacity='0.70'/%3E%3Ccircle cx='62.0' cy='560.4' r='1.0' fill='%23e8fbff' fill-opacity='0.31'/%3E%3Ccircle cx='205.7' cy='538.2' r='1.4' fill='%23e8fbff' fill-opacity='0.27'/%3E%3Ccircle cx='430.2' cy='31.5' r='1.2' fill='%23e8fbff' fill-opacity='0.40'/%3E%3Ccircle cx='616.6' cy='686.4' r='1.1' fill='%23e8fbff' fill-opacity='0.70'/%3E%3Ccircle cx='216.8' cy='53.9' r='1.1' fill='%23e8fbff' fill-opacity='0.26'/%3E%3Ccircle cx='138.2' cy='285.6' r='1.1' fill='%23e8fbff' fill-opacity='0.32'/%3E%3Ccircle cx='29.7' cy='607.4' r='0.9' fill='%23e8fbff' fill-opacity='0.68'/%3E%3Ccircle cx='627.7' cy='264.5' r='1.0' fill='%23e8fbff' fill-opacity='0.48'/%3E%3Ccircle cx='450.7' cy='417.0' r='1.1' fill='%23e8fbff' fill-opacity='0.53'/%3E%3Ccircle cx='658.4' cy='354.9' r='1.0' fill='%23e8fbff' fill-opacity='0.57'/%3E%3Ccircle cx='166.3' cy='210.8' r='1.5' fill='%23e8fbff' fill-opacity='0.48'/%3E%3Ccircle cx='383.9' cy='8.0' r='1.0' fill='%23e8fbff' fill-opacity='0.51'/%3E%3Ccircle cx='14.0' cy='431.1' r='1.2' fill='%23e8fbff' fill-opacity='0.27'/%3E%3Ccircle cx='439.1' cy='326.4' r='1.2' fill='%23e8fbff' fill-opacity='0.41'/%3E%3Ccircle cx='494.9' cy='516.6' r='0.6' fill='%23e8fbff' fill-opacity='0.27'/%3E%3Ccircle cx='473.2' cy='674.3' r='0.8' fill='%23e8fbff' fill-opacity='0.45'/%3E%3Ccircle cx='414.9' cy='224.0' r='0.9' fill='%23e8fbff' fill-opacity='0.39'/%3E%3Ccircle cx='258.4' cy='416.9' r='0.9' fill='%23e8fbff' fill-opacity='0.42'/%3E%3Ccircle cx='540.6' cy='18.8' r='1.1' fill='%23e8fbff' fill-opacity='0.58'/%3E%3Ccircle cx='217.0' cy='155.8' r='1.3' fill='%23e8fbff' fill-opacity='0.35'/%3E%3Ccircle cx='131.2' cy='304.7' r='1.2' fill='%23e8fbff' fill-opacity='0.29'/%3E%3Ccircle cx='225.4' cy='233.6' r='1.4' fill='%23e8fbff' fill-opacity='0.44'/%3E%3Ccircle cx='598.9' cy='118.5' r='0.9' fill='%23e8fbff' fill-opacity='0.54'/%3E%3Ccircle cx='619.4' cy='315.8' r='0.8' fill='%23e8fbff' fill-opacity='0.30'/%3E%3Ccircle cx='370.7' cy='133.6' r='1.3' fill='%23e8fbff' fill-opacity='0.63'/%3E%3Ccircle cx='128.5' cy='195.0' r='1.3' fill='%23e8fbff' fill-opacity='0.54'/%3E%3Ccircle cx='564.4' cy='241.7' r='0.7' fill='%23e8fbff' fill-opacity='0.38'/%3E%3Ccircle cx='555.7' cy='189.8' r='0.9' fill='%23e8fbff' fill-opacity='0.43'/%3E%3Ccircle cx='293.8' cy='286.7' r='1.4' fill='%23e8fbff' fill-opacity='0.32'/%3E%3Ccircle cx='3.3' cy='660.3' r='1.4' fill='%23e8fbff' fill-opacity='0.69'/%3E%3Ccircle cx='304.0' cy='665.1' r='1.4' fill='%23e8fbff' fill-opacity='0.35'/%3E%3Ccircle cx='521.9' cy='585.7' r='1.2' fill='%23e8fbff' fill-opacity='0.48'/%3E%3Ccircle cx='202.3' cy='238.7' r='0.8' fill='%23e8fbff' fill-opacity='0.28'/%3E%3Ccircle cx='412.1' cy='200.9' r='1.3' fill='%23e8fbff' fill-opacity='0.27'/%3E%3Ccircle cx='632.5' cy='485.6' r='1.4' fill='%23e8fbff' fill-opacity='0.65'/%3E%3Ccircle cx='629.8' cy='403.9' r='0.6' fill='%23e8fbff' fill-opacity='0.58'/%3E%3Ccircle cx='120.3' cy='209.9' r='1.2' fill='%23e8fbff' fill-opacity='0.48'/%3E%3Ccircle cx='289.6' cy='657.3' r='1.2' fill='%23e8fbff' fill-opacity='0.40'/%3E%3Ccircle cx='176.7' cy='603.2' r='1.0' fill='%23e8fbff' fill-opacity='0.60'/%3E%3Ccircle cx='246.3' cy='138.1' r='1.1' fill='%23e8fbff' fill-opacity='0.62'/%3E%3Ccircle cx='119.9' cy='554.2' r='1.4' fill='%23e8fbff' fill-opacity='0.61'/%3E%3Ccircle cx='576.4' cy='5.3' r='1.2' fill='%23e8fbff' fill-opacity='0.64'/%3E%3Ccircle cx='35.0' cy='190.0' r='0.8' fill='%23e8fbff' fill-opacity='0.48'/%3E%3Ccircle cx='296.1' cy='331.0' r='1.3' fill='%23e8fbff' fill-opacity='0.25'/%3E%3Ccircle cx='38.4' cy='88.8' r='0.7' fill='%23e8fbff' fill-opacity='0.28'/%3E%3Ccircle cx='682.3' cy='598.1' r='0.7' fill='%23e8fbff' fill-opacity='0.47'/%3E%3Ccircle cx='221.1' cy='220.2' r='0.9' fill='%23e8fbff' fill-opacity='0.54'/%3E%3Ccircle cx='410.6' cy='252.6' r='0.8' fill='%23e8fbff' fill-opacity='0.39'/%3E%3Ccircle cx='86.6' cy='388.9' r='1.2' fill='%23e8fbff' fill-opacity='0.42'/%3E%3Ccircle cx='55.9' cy='125.0' r='0.9' fill='%23e8fbff' fill-opacity='0.52'/%3E%3Ccircle cx='547.8' cy='266.2' r='1.3' fill='%23e8fbff' fill-opacity='0.53'/%3E%3Ccircle cx='302.1' cy='260.7' r='1.0' fill='%23e8fbff' fill-opacity='0.56'/%3E%3Ccircle cx='294.4' cy='485.9' r='1.0' fill='%23e8fbff' fill-opacity='0.36'/%3E%3Ccircle cx='375.1' cy='486.6' r='0.7' fill='%23e8fbff' fill-opacity='0.44'/%3E%3Ccircle cx='298.1' cy='615.8' r='1.4' fill='%23e8fbff' fill-opacity='0.42'/%3E%3Ccircle cx='628.5' cy='553.6' r='0.8' fill='%23e8fbff' fill-opacity='0.46'/%3E%3Ccircle cx='86.2' cy='569.3' r='1.2' fill='%23e8fbff' fill-opacity='0.65'/%3E%3Ccircle cx='554.7' cy='467.3' r='1.3' fill='%23e8fbff' fill-opacity='0.50'/%3E%3Ccircle cx='72.2' cy='411.4' r='0.6' fill='%23e8fbff' fill-opacity='0.31'/%3E%3Ccircle cx='542.0' cy='31.0' r='0.7' fill='%23e8fbff' fill-opacity='0.29'/%3E%3Ccircle cx='616.3' cy='125.4' r='0.6' fill='%23e8fbff' fill-opacity='0.63'/%3E%3Ccircle cx='84.9' cy='590.8' r='1.2' fill='%23e8fbff' fill-opacity='0.63'/%3E%3Ccircle cx='666.7' cy='405.4' r='1.3' fill='%23e8fbff' fill-opacity='0.26'/%3E%3Ccircle cx='537.2' cy='357.9' r='1.2' fill='%23e8fbff' fill-opacity='0.29'/%3E%3Ccircle cx='524.3' cy='654.2' r='0.7' fill='%23e8fbff' fill-opacity='0.39'/%3E%3Ccircle cx='394.8' cy='579.6' r='0.8' fill='%23e8fbff' fill-opacity='0.33'/%3E%3Ccircle cx='175.0' cy='431.2' r='1.3' fill='%23e8fbff' fill-opacity='0.42'/%3E%3Ccircle cx='257.2' cy='277.6' r='0.9' fill='%23e8fbff' fill-opacity='0.44'/%3E%3Ccircle cx='58.3' cy='350.2' r='1.5' fill='%23e8fbff' fill-opacity='0.43'/%3E%3Ccircle cx='523.2' cy='112.4' r='1.2' fill='%23e8fbff' fill-opacity='0.59'/%3E%3Ccircle cx='471.7' cy='362.0' r='1.0' fill='%23e8fbff' fill-opacity='0.54'/%3E%3Ccircle cx='628.2' cy='104.5' r='0.7' fill='%23e8fbff' fill-opacity='0.59'/%3E%3Ccircle cx='641.6' cy='362.1' r='1.0' fill='%23e8fbff' fill-opacity='0.57'/%3E%3C/svg%3E\") 0 0 / 700px 700px repeat;\nopacity: calc(0.35 + var(--aur-song, 0) * 0.55);\ntransition: opacity 1.5s linear;\nanimation: aur-oc-snow-far 120s linear infinite;\n}\n.aur-root[data-fx=\"ocean\"] .aur-fx-b::before {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 800' preserveAspectRatio='none'%3E%3Cdefs%3E%3CradialGradient id='d'%3E%3Cstop offset='0' stop-color='%23e8fbff'/%3E%3Cstop offset='1' stop-color='%23e8fbff' stop-opacity='0'/%3E%3C/radialGradient%3E%3C/defs%3E%3Ccircle cx='498.3' cy='593.4' r='6.2' fill='url(%23d)' fill-opacity='0.39'/%3E%3Ccircle cx='591.9' cy='737.9' r='3.1' fill='url(%23d)' fill-opacity='0.26'/%3E%3Ccircle cx='754.7' cy='519.2' r='6.6' fill='url(%23d)' fill-opacity='0.17'/%3E%3Ccircle cx='375.3' cy='197.3' r='5.2' fill='url(%23d)' fill-opacity='0.29'/%3E%3Ccircle cx='10.5' cy='173.4' r='4.1' fill='url(%23d)' fill-opacity='0.38'/%3E%3Ccircle cx='612.6' cy='127.7' r='6.2' fill='url(%23d)' fill-opacity='0.18'/%3E%3Ccircle cx='494.0' cy='101.4' r='3.0' fill='url(%23d)' fill-opacity='0.37'/%3E%3Ccircle cx='167.6' cy='172.4' r='6.9' fill='url(%23d)' fill-opacity='0.37'/%3E%3Ccircle cx='231.4' cy='769.2' r='5.2' fill='url(%23d)' fill-opacity='0.32'/%3E%3Ccircle cx='163.8' cy='752.8' r='5.8' fill='url(%23d)' fill-opacity='0.39'/%3E%3Ccircle cx='715.0' cy='239.0' r='4.4' fill='url(%23d)' fill-opacity='0.18'/%3E%3Ccircle cx='116.6' cy='52.1' r='4.2' fill='url(%23d)' fill-opacity='0.30'/%3E%3Ccircle cx='2.7' cy='542.3' r='4.4' fill='url(%23d)' fill-opacity='0.22'/%3E%3Ccircle cx='802.7' cy='542.3' r='4.4' fill='url(%23d)' fill-opacity='0.22'/%3E%3Ccircle cx='654.8' cy='384.6' r='4.3' fill='url(%23d)' fill-opacity='0.27'/%3E%3Ccircle cx='563.7' cy='45.6' r='6.9' fill='url(%23d)' fill-opacity='0.15'/%3E%3Ccircle cx='599.8' cy='675.9' r='3.1' fill='url(%23d)' fill-opacity='0.34'/%3E%3Ccircle cx='292.9' cy='462.8' r='3.0' fill='url(%23d)' fill-opacity='0.15'/%3E%3Ccircle cx='144.7' cy='764.1' r='3.8' fill='url(%23d)' fill-opacity='0.34'/%3E%3Ccircle cx='743.7' cy='753.6' r='4.4' fill='url(%23d)' fill-opacity='0.23'/%3E%3Ccircle cx='419.8' cy='620.5' r='3.4' fill='url(%23d)' fill-opacity='0.33'/%3E%3Ccircle cx='637.8' cy='687.8' r='3.1' fill='url(%23d)' fill-opacity='0.39'/%3E%3Ccircle cx='72.9' cy='272.6' r='5.4' fill='url(%23d)' fill-opacity='0.38'/%3E%3C/svg%3E\") 0 0 / 800px 800px repeat;\nanimation: aur-oc-snow-near 95s linear infinite;\n}\n@keyframes aur-oc-snow-far { to { transform: translateY(-700px); } }\n@keyframes aur-oc-snow-near { to { transform: translateY(-800px); } }\n.aur-root[data-fx=\"ocean\"] .aur-fx-c {\ndisplay: block;\nleft: -34vw;\ntop: 5%;\nwidth: 33vw;\nheight: 13.75vw;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 720 300' preserveAspectRatio='xMidYMid meet'%3E%3Cdefs%3E%3ClinearGradient id='b' x1='0' y1='0' x2='1' y2='0'%3E%3Cstop offset='0' stop-color='%23051f38'/%3E%3Cstop offset='0.55' stop-color='%230a3a62'/%3E%3Cstop offset='1' stop-color='%230b4573'/%3E%3C/linearGradient%3E%3CradialGradient id='v' cx='.6' cy='.5' r='.5'%3E%3Cstop offset='0' stop-color='%236fb4de' stop-opacity='0.45'/%3E%3Cstop offset='1' stop-color='%236fb4de' stop-opacity='0'/%3E%3C/radialGradient%3E%3C/defs%3E%3Cpath d='M186 150C120 150 70 146 14 136' fill='none' stroke='%23051f38' stroke-width='6' stroke-linecap='round'/%3E%3Cpath d='M600 150C570 120 470 74 350 40C320 32 290 20 262 8C268 50 244 96 206 122C196 130 190 140 186 150C190 160 196 170 206 178C244 204 268 250 262 292C290 280 320 268 350 260C470 226 570 180 600 150Z' fill='url(%23b)'/%3E%3Cpath d='M600 148C620 142 640 140 656 146C640 146 620 152 604 154Z' fill='%23051f38'/%3E%3Cpath d='M600 152C620 158 640 160 656 154C640 154 620 148 604 146Z' fill='%23051f38'/%3E%3Cellipse cx='400' cy='150' rx='150' ry='50' fill='url(%23v)'/%3E%3Cg fill='none' stroke='%238fd0f2' stroke-opacity='.25' stroke-width='2.5' stroke-linecap='round'%3E%3Cpath d='M330 132q10 8 0 16M352 130q10 10 0 20M374 130q10 10 0 20'/%3E%3Cpath d='M330 168q10 -8 0 -16M352 170q10 -10 0 -20M374 170q10 -10 0 -20'/%3E%3C/g%3E%3C/svg%3E\") center / contain no-repeat;\nopacity: calc(0.72 - var(--aur-song, 0) * 0.3);\ntransform-origin: 30% 50%;\nanimation: aur-oc-cruise 84s linear -12s infinite, aur-oc-flap 3.4s ease-in-out infinite alternate, aur-oc-bank 7s ease-in-out infinite alternate;\n}\n@keyframes aur-oc-cruise { to { translate: 170vw 0; } }\n@keyframes aur-oc-flap { from { scale: 1 1; } to { scale: 1 0.84; } }\n@keyframes aur-oc-bank { from { rotate: -2.5deg; } to { rotate: 2.5deg; } }\n.aur-root[data-fx=\"ocean\"] .aur-fx-d {\ndisplay: block;\nleft: 0;\nright: 0;\ntop: 0;\nheight: calc(100% + 700px);\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 700 700' preserveAspectRatio='none'%3E%3Cdefs%3E%3CradialGradient id='q'%3E%3Cstop offset='0.55' stop-color='%23bfeeff' stop-opacity='0.02'/%3E%3Cstop offset='0.88' stop-color='%23d8f6ff' stop-opacity='0.4'/%3E%3Cstop offset='1' stop-color='%23fff' stop-opacity='0.75'/%3E%3C/radialGradient%3E%3CradialGradient id='g'%3E%3Cstop offset='0' stop-color='%23fff' stop-opacity='0.95'/%3E%3Cstop offset='1' stop-color='%23fff' stop-opacity='0'/%3E%3C/radialGradient%3E%3C/defs%3E%3Ccircle cx='669.2' cy='663.5' r='6.9' fill='url(%23q)'/%3E%3Cellipse cx='667.0' cy='661.0' rx='1.5' ry='1.0' fill='url(%23g)' transform='rotate(-35 667.0 661.0)'/%3E%3Ccircle cx='59.4' cy='584.8' r='17.8' fill='url(%23q)'/%3E%3Cellipse cx='53.7' cy='578.5' rx='3.9' ry='2.5' fill='url(%23g)' transform='rotate(-35 53.7 578.5)'/%3E%3Ccircle cx='468.8' cy='215.7' r='15.7' fill='url(%23q)'/%3E%3Cellipse cx='463.8' cy='210.0' rx='3.5' ry='2.2' fill='url(%23g)' transform='rotate(-35 463.8 210.0)'/%3E%3Ccircle cx='424.8' cy='406.8' r='8.5' fill='url(%23q)'/%3E%3Cellipse cx='422.0' cy='403.8' rx='1.9' ry='1.2' fill='url(%23g)' transform='rotate(-35 422.0 403.8)'/%3E%3Ccircle cx='301.5' cy='275.5' r='17.6' fill='url(%23q)'/%3E%3Cellipse cx='295.8' cy='269.1' rx='3.9' ry='2.5' fill='url(%23g)' transform='rotate(-35 295.8 269.1)'/%3E%3Ccircle cx='696.4' cy='664.6' r='14.7' fill='url(%23q)'/%3E%3Cellipse cx='691.7' cy='659.3' rx='3.2' ry='2.1' fill='url(%23g)' transform='rotate(-35 691.7 659.3)'/%3E%3Ccircle cx='-3.6' cy='664.6' r='14.7' fill='url(%23q)'/%3E%3Cellipse cx='-8.3' cy='659.3' rx='3.2' ry='2.1' fill='url(%23g)' transform='rotate(-35 -8.3 659.3)'/%3E%3Ccircle cx='311.4' cy='187.8' r='6.6' fill='url(%23q)'/%3E%3Cellipse cx='309.3' cy='185.4' rx='1.4' ry='0.9' fill='url(%23g)' transform='rotate(-35 309.3 185.4)'/%3E%3Ccircle cx='19.2' cy='325.4' r='11.1' fill='url(%23q)'/%3E%3Cellipse cx='15.7' cy='321.4' rx='2.4' ry='1.6' fill='url(%23g)' transform='rotate(-35 15.7 321.4)'/%3E%3Ccircle cx='266.0' cy='624.3' r='14.4' fill='url(%23q)'/%3E%3Cellipse cx='261.4' cy='619.1' rx='3.2' ry='2.0' fill='url(%23g)' transform='rotate(-35 261.4 619.1)'/%3E%3Ccircle cx='392.4' cy='165.3' r='6.4' fill='url(%23q)'/%3E%3Cellipse cx='390.3' cy='163.0' rx='1.4' ry='0.9' fill='url(%23g)' transform='rotate(-35 390.3 163.0)'/%3E%3Ccircle cx='227.6' cy='95.7' r='14.2' fill='url(%23q)'/%3E%3Cellipse cx='223.1' cy='90.6' rx='3.1' ry='2.0' fill='url(%23g)' transform='rotate(-35 223.1 90.6)'/%3E%3Ccircle cx='699.1' cy='472.1' r='8.9' fill='url(%23q)'/%3E%3Cellipse cx='696.2' cy='468.9' rx='2.0' ry='1.2' fill='url(%23g)' transform='rotate(-35 696.2 468.9)'/%3E%3Ccircle cx='-0.9' cy='472.1' r='8.9' fill='url(%23q)'/%3E%3Cellipse cx='-3.8' cy='468.9' rx='2.0' ry='1.2' fill='url(%23g)' transform='rotate(-35 -3.8 468.9)'/%3E%3Ccircle cx='625.5' cy='557.7' r='17.8' fill='url(%23q)'/%3E%3Cellipse cx='619.8' cy='551.3' rx='3.9' ry='2.5' fill='url(%23g)' transform='rotate(-35 619.8 551.3)'/%3E%3Ccircle cx='634.6' cy='534.0' r='18.6' fill='url(%23q)'/%3E%3Cellipse cx='628.7' cy='527.3' rx='4.1' ry='2.6' fill='url(%23g)' transform='rotate(-35 628.7 527.3)'/%3E%3Ccircle cx='247.7' cy='686.7' r='21.4' fill='url(%23q)'/%3E%3Cellipse cx='240.8' cy='679.0' rx='4.7' ry='3.0' fill='url(%23g)' transform='rotate(-35 240.8 679.0)'/%3E%3Ccircle cx='247.7' cy='-13.3' r='21.4' fill='url(%23q)'/%3E%3Cellipse cx='240.8' cy='-21.0' rx='4.7' ry='3.0' fill='url(%23g)' transform='rotate(-35 240.8 -21.0)'/%3E%3Ccircle cx='112.8' cy='527.8' r='17.4' fill='url(%23q)'/%3E%3Cellipse cx='107.2' cy='521.5' rx='3.8' ry='2.4' fill='url(%23g)' transform='rotate(-35 107.2 521.5)'/%3E%3Ccircle cx='323.0' cy='371.2' r='13.8' fill='url(%23q)'/%3E%3Cellipse cx='318.6' cy='366.3' rx='3.0' ry='1.9' fill='url(%23g)' transform='rotate(-35 318.6 366.3)'/%3E%3Ccircle cx='647.4' cy='350.6' r='19.3' fill='url(%23q)'/%3E%3Cellipse cx='641.2' cy='343.6' rx='4.2' ry='2.7' fill='url(%23g)' transform='rotate(-35 641.2 343.6)'/%3E%3C/svg%3E\") 0 0 / 700px 700px repeat;\nanimation: aur-oc-bubbles 48s linear infinite;\n}\n.aur-root[data-fx=\"ocean\"] .aur-fx-d::before {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 500 500' preserveAspectRatio='none'%3E%3Cdefs%3E%3CradialGradient id='q'%3E%3Cstop offset='0.55' stop-color='%23bfeeff' stop-opacity='0.02'/%3E%3Cstop offset='0.88' stop-color='%23d8f6ff' stop-opacity='0.4'/%3E%3Cstop offset='1' stop-color='%23fff' stop-opacity='0.75'/%3E%3C/radialGradient%3E%3CradialGradient id='g'%3E%3Cstop offset='0' stop-color='%23fff' stop-opacity='0.95'/%3E%3Cstop offset='1' stop-color='%23fff' stop-opacity='0'/%3E%3C/radialGradient%3E%3C/defs%3E%3Ccircle cx='311.5' cy='370.9' r='6.1' fill='url(%23q)'/%3E%3Cellipse cx='309.5' cy='368.7' rx='1.3' ry='0.9' fill='url(%23g)' transform='rotate(-35 309.5 368.7)'/%3E%3Ccircle cx='471.2' cy='369.9' r='6.7' fill='url(%23q)'/%3E%3Cellipse cx='469.1' cy='367.6' rx='1.5' ry='0.9' fill='url(%23g)' transform='rotate(-35 469.1 367.6)'/%3E%3Ccircle cx='14.5' cy='232.8' r='6.7' fill='url(%23q)'/%3E%3Cellipse cx='12.3' cy='230.4' rx='1.5' ry='0.9' fill='url(%23g)' transform='rotate(-35 12.3 230.4)'/%3E%3Ccircle cx='324.5' cy='450.5' r='3.0' fill='url(%23q)'/%3E%3Cellipse cx='323.5' cy='449.4' rx='0.7' ry='0.4' fill='url(%23g)' transform='rotate(-35 323.5 449.4)'/%3E%3Ccircle cx='234.5' cy='123.3' r='4.9' fill='url(%23q)'/%3E%3Cellipse cx='233.0' cy='121.5' rx='1.1' ry='0.7' fill='url(%23g)' transform='rotate(-35 233.0 121.5)'/%3E%3Ccircle cx='287.0' cy='6.6' r='3.5' fill='url(%23q)'/%3E%3Cellipse cx='285.9' cy='5.3' rx='0.8' ry='0.5' fill='url(%23g)' transform='rotate(-35 285.9 5.3)'/%3E%3Ccircle cx='139.7' cy='458.2' r='5.9' fill='url(%23q)'/%3E%3Cellipse cx='137.8' cy='456.0' rx='1.3' ry='0.8' fill='url(%23g)' transform='rotate(-35 137.8 456.0)'/%3E%3Ccircle cx='79.8' cy='398.6' r='3.1' fill='url(%23q)'/%3E%3Cellipse cx='78.8' cy='397.4' rx='0.7' ry='0.4' fill='url(%23g)' transform='rotate(-35 78.8 397.4)'/%3E%3Ccircle cx='308.7' cy='63.3' r='2.5' fill='url(%23q)'/%3E%3Cellipse cx='307.9' cy='62.4' rx='0.6' ry='0.4' fill='url(%23g)' transform='rotate(-35 307.9 62.4)'/%3E%3Ccircle cx='435.7' cy='104.7' r='3.5' fill='url(%23q)'/%3E%3Cellipse cx='434.6' cy='103.5' rx='0.8' ry='0.5' fill='url(%23g)' transform='rotate(-35 434.6 103.5)'/%3E%3Ccircle cx='491.2' cy='436.2' r='3.8' fill='url(%23q)'/%3E%3Cellipse cx='490.0' cy='434.8' rx='0.8' ry='0.5' fill='url(%23g)' transform='rotate(-35 490.0 434.8)'/%3E%3Ccircle cx='480.7' cy='269.6' r='5.6' fill='url(%23q)'/%3E%3Cellipse cx='479.0' cy='267.6' rx='1.2' ry='0.8' fill='url(%23g)' transform='rotate(-35 479.0 267.6)'/%3E%3Ccircle cx='102.4' cy='470.5' r='5.6' fill='url(%23q)'/%3E%3Cellipse cx='100.6' cy='468.5' rx='1.2' ry='0.8' fill='url(%23g)' transform='rotate(-35 100.6 468.5)'/%3E%3Ccircle cx='483.3' cy='446.9' r='3.8' fill='url(%23q)'/%3E%3Cellipse cx='482.1' cy='445.5' rx='0.8' ry='0.5' fill='url(%23g)' transform='rotate(-35 482.1 445.5)'/%3E%3Ccircle cx='180.6' cy='83.0' r='3.2' fill='url(%23q)'/%3E%3Cellipse cx='179.6' cy='81.8' rx='0.7' ry='0.4' fill='url(%23g)' transform='rotate(-35 179.6 81.8)'/%3E%3Ccircle cx='32.6' cy='150.7' r='5.2' fill='url(%23q)'/%3E%3Cellipse cx='30.9' cy='148.8' rx='1.1' ry='0.7' fill='url(%23g)' transform='rotate(-35 30.9 148.8)'/%3E%3Ccircle cx='1.7' cy='339.0' r='4.0' fill='url(%23q)'/%3E%3Cellipse cx='0.4' cy='337.5' rx='0.9' ry='0.6' fill='url(%23g)' transform='rotate(-35 0.4 337.5)'/%3E%3Ccircle cx='501.7' cy='339.0' r='4.0' fill='url(%23q)'/%3E%3Cellipse cx='500.4' cy='337.5' rx='0.9' ry='0.6' fill='url(%23g)' transform='rotate(-35 500.4 337.5)'/%3E%3Ccircle cx='155.0' cy='409.3' r='4.7' fill='url(%23q)'/%3E%3Cellipse cx='153.5' cy='407.6' rx='1.0' ry='0.7' fill='url(%23g)' transform='rotate(-35 153.5 407.6)'/%3E%3Ccircle cx='157.9' cy='240.6' r='5.7' fill='url(%23q)'/%3E%3Cellipse cx='156.1' cy='238.6' rx='1.2' ry='0.8' fill='url(%23g)' transform='rotate(-35 156.1 238.6)'/%3E%3Ccircle cx='28.5' cy='487.5' r='2.6' fill='url(%23q)'/%3E%3Cellipse cx='27.7' cy='486.6' rx='0.6' ry='0.4' fill='url(%23g)' transform='rotate(-35 27.7 486.6)'/%3E%3Ccircle cx='374.9' cy='422.4' r='2.6' fill='url(%23q)'/%3E%3Cellipse cx='374.1' cy='421.5' rx='0.6' ry='0.4' fill='url(%23g)' transform='rotate(-35 374.1 421.5)'/%3E%3Ccircle cx='393.9' cy='183.1' r='5.1' fill='url(%23q)'/%3E%3Cellipse cx='392.2' cy='181.3' rx='1.1' ry='0.7' fill='url(%23g)' transform='rotate(-35 392.2 181.3)'/%3E%3Ccircle cx='4.5' cy='23.4' r='3.3' fill='url(%23q)'/%3E%3Cellipse cx='3.5' cy='22.2' rx='0.7' ry='0.5' fill='url(%23g)' transform='rotate(-35 3.5 22.2)'/%3E%3Ccircle cx='477.6' cy='98.3' r='5.9' fill='url(%23q)'/%3E%3Cellipse cx='475.7' cy='96.1' rx='1.3' ry='0.8' fill='url(%23g)' transform='rotate(-35 475.7 96.1)'/%3E%3Ccircle cx='464.8' cy='471.0' r='4.0' fill='url(%23q)'/%3E%3Cellipse cx='463.5' cy='469.6' rx='0.9' ry='0.6' fill='url(%23g)' transform='rotate(-35 463.5 469.6)'/%3E%3Ccircle cx='177.4' cy='262.4' r='6.0' fill='url(%23q)'/%3E%3Cellipse cx='175.5' cy='260.2' rx='1.3' ry='0.8' fill='url(%23g)' transform='rotate(-35 175.5 260.2)'/%3E%3Ccircle cx='54.0' cy='374.2' r='6.1' fill='url(%23q)'/%3E%3Cellipse cx='52.1' cy='372.0' rx='1.3' ry='0.9' fill='url(%23g)' transform='rotate(-35 52.1 372.0)'/%3E%3Ccircle cx='429.8' cy='18.3' r='6.8' fill='url(%23q)'/%3E%3Cellipse cx='427.7' cy='15.9' rx='1.5' ry='0.9' fill='url(%23g)' transform='rotate(-35 427.7 15.9)'/%3E%3C/svg%3E\") 0 0 / 500px 500px repeat;\nanimation: aur-oc-bubbles-s 21s linear infinite;\n}\n@keyframes aur-oc-bubbles { to { transform: translateY(-700px); } }\n@keyframes aur-oc-bubbles-s { to { transform: translateY(-500px); } }\n.aur-root[data-fx=\"ocean\"] .aur-fx-e { display: block; inset: 0; }\n.aur-root[data-fx=\"ocean\"] .aur-fx-e > i { position: absolute; display: block; }\n.aur-root[data-fx=\"ocean\"] .aur-fx-e > i:nth-child(n + 11) { display: none; }\n.aur-root[data-fx=\"ocean\"] .aur-fx-e > i:nth-child(-n + 8) {\nleft: var(--x);\ntop: 0;\nwidth: var(--w);\nheight: calc(var(--w) * 1.72);\nopacity: calc(0.28 + var(--aur-song, 0) * 0.72);\ntransition: opacity 1.2s linear;\nanimation: aur-oc-rise var(--dur) linear var(--dl) infinite, aur-oc-wander var(--sway) ease-in-out infinite alternate;\n}\n@keyframes aur-oc-rise { from { translate: 0 108vh; } to { translate: 0 calc(var(--w) * -2 - 6vh); } }\n@keyframes aur-oc-wander { from { transform: translateX(-2.2vw) rotate(-3deg); } to { transform: translateX(2.2vw) rotate(3deg); } }\n.aur-root[data-fx=\"ocean\"] .aur-fx-e > i:nth-child(-n + 8)::before {\ncontent: \"\";\nposition: absolute;\nleft: 0;\ntop: 0;\nwidth: 100%;\nheight: calc(var(--w) * 0.65);\nbackground: var(--bell) center / 100% 100% no-repeat;\ntransform-origin: 50% 20%;\nanimation: aur-oc-pulse calc(var(--aur-beat, 0.6s) * var(--m)) ease-in-out infinite;\n}\n.aur-root[data-fx=\"ocean\"] .aur-fx-e > i:nth-child(-n + 8)::after {\ncontent: \"\";\nposition: absolute;\nleft: 0;\ntop: calc(var(--w) * 0.52);\nwidth: 100%;\nheight: calc(var(--w) * 1.2);\nbackground: var(--tent) center top / 100% 100% no-repeat;\ntransform-origin: 50% 0;\nanimation: aur-oc-trail calc(var(--aur-beat, 0.6s) * var(--m)) ease-in-out infinite;\n}\n@keyframes aur-oc-pulse { 0%, 100% { scale: 1 1; } 30% { scale: 1.1 0.84; } 62% { scale: 0.97 1.04; } }\n@keyframes aur-oc-trail { 0%, 100% { scale: 1 1; } 30% { scale: 0.93 1.08; } 62% { scale: 1.03 0.96; } }\n.aur-root[data-fx=\"ocean\"] {\n--bell-a: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 130' preserveAspectRatio='xMidYMin meet'%3E%3Cdefs%3E%3CradialGradient id='h' cx='.5' cy='.5' r='.5'%3E%3Cstop offset='0' stop-color='%235ff4ff' stop-opacity='0.42'/%3E%3Cstop offset='0.55' stop-color='%232c9dff' stop-opacity='0.16'/%3E%3Cstop offset='1' stop-color='%232c9dff' stop-opacity='0'/%3E%3C/radialGradient%3E%3CradialGradient id='b' cx='.5' cy='.85' r='.95'%3E%3Cstop offset='0' stop-color='%23b6fbff' stop-opacity='0.5'/%3E%3Cstop offset='0.55' stop-color='%235ff4ff' stop-opacity='0.34'/%3E%3Cstop offset='1' stop-color='%232c9dff' stop-opacity='0.55'/%3E%3C/radialGradient%3E%3C/defs%3E%3Cellipse cx='100' cy='70' rx='100' ry='66' fill='url(%23h)'/%3E%3Cpath d='M22 108C22 44 58 12 100 12C142 12 178 44 178 108C164 102 152 114 138 106C128 120 112 118 100 108C88 118 72 120 62 106C48 114 36 102 22 108Z' fill='url(%23b)' stroke='%23b6fbff' stroke-opacity='.75' stroke-width='2.5'/%3E%3Cpath d='M46 96C48 58 70 32 100 30C130 32 152 58 154 96' fill='none' stroke='%23b6fbff' stroke-opacity='.4' stroke-width='2'/%3E%3Cpath d='M74 92C76 66 88 52 100 52C112 52 124 66 126 92' fill='none' stroke='%23b6fbff' stroke-opacity='.5' stroke-width='3'/%3E%3Cellipse cx='100' cy='88' rx='16' ry='10' fill='%23b6fbff' fill-opacity='.55'/%3E%3Cellipse cx='72' cy='40' rx='16' ry='6' fill='%23fff' fill-opacity='.4' transform='rotate(-28 72 40)'/%3E%3C/svg%3E\");\n--tent-a0: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 240' preserveAspectRatio='xMidYMin meet'%3E%3Cpath d='M34.1 0.0 36.8 22.1 40.7 44.3 44.3 66.4 45.8 88.6 44.0 110.7 38.9 132.8 31.5 155.0 24.2 177.1 19.5 199.3' fill='none' stroke='%235ff4ff' stroke-opacity='0.60' stroke-width='2.0' stroke-linecap='round'/%3E%3Cpath d='M50.2 0.0 49.1 22.1 49.8 44.3 52.6 66.4 56.9 88.6 61.5 110.7 64.5 132.9 64.4 155.0 60.7 177.2 54.1 199.3' fill='none' stroke='%235ff4ff' stroke-opacity='0.43' stroke-width='2.4' stroke-linecap='round'/%3E%3Cpath d='M67.1 0.0 68.2 18.1 71.8 36.3 77.0 54.4 82.1 72.6 84.9 90.7 83.7 108.9 78.1 127.0 69.1 145.2 59.4 163.3' fill='none' stroke='%235ff4ff' stroke-opacity='0.55' stroke-width='1.9' stroke-linecap='round'/%3E%3Cpath d='M87.3 0.0 87.8 19.8 89.7 39.7 92.6 59.5 95.4 79.4 97.0 99.2 96.5 119.1 93.6 138.9 88.8 158.8 83.5 178.6' fill='none' stroke='%235ff4ff' stroke-opacity='0.61' stroke-width='2.6' stroke-linecap='round'/%3E%3Cpath d='M112.4 0.0 111.6 18.6 108.6 37.3 104.1 55.9 99.5 74.5 96.7 93.1 97.4 111.8 102.0 130.4 109.6 149.0 118.2 167.6' fill='none' stroke='%235ff4ff' stroke-opacity='0.63' stroke-width='1.7' stroke-linecap='round'/%3E%3Cpath d='M131.5 0.0 131.8 17.6 129.4 35.1 124.5 52.7 118.5 70.3 113.4 87.8 111.6 105.4 114.6 123.0 122.1 140.5 132.4 158.1' fill='none' stroke='%235ff4ff' stroke-opacity='0.61' stroke-width='2.2' stroke-linecap='round'/%3E%3Cpath d='M147.6 0.0 149.1 20.9 149.1 41.8 146.8 62.7 142.5 83.6 137.6 104.5 133.7 125.4 132.5 146.3 135.2 167.2 141.3 188.1' fill='none' stroke='%235ff4ff' stroke-opacity='0.60' stroke-width='1.9' stroke-linecap='round'/%3E%3Cpath d='M162.5 0.0 161.0 21.9 159.1 43.8 157.6 65.7 157.3 87.7 158.8 109.6 161.8 131.5 165.6 153.4 168.9 175.3 170.5 197.2' fill='none' stroke='%235ff4ff' stroke-opacity='0.41' stroke-width='1.7' stroke-linecap='round'/%3E%3Cpath d='M79.6 0.0 82.2 11.3 84.1 22.7 85.3 34.0 85.8 45.3 85.4 56.7 84.4 68.0 82.8 79.3 80.7 90.7 78.4 102.0 76.1 113.3 74.0 124.7 72.3 136.0 71.2 147.3 70.7 158.7 71.0 170.0 73.0 170.0 73.7 158.7 75.0 147.3 77.1 136.0 79.7 124.7 82.8 113.3 86.0 102.0 89.2 90.7 92.2 79.3 94.8 68.0 96.8 56.7 98.0 45.3 98.5 34.0 98.2 22.7 97.2 11.3 95.6 0.0Z' fill='%23b6fbff' fill-opacity='.4'/%3E%3Cpath d='M116.8 0.0 114.9 11.3 112.7 22.7 110.4 34.0 108.2 45.3 106.2 56.7 104.7 68.0 103.9 79.3 103.8 90.7 104.4 102.0 105.8 113.3 107.9 124.7 110.6 136.0 113.7 147.3 116.9 158.7 120.1 170.0 122.1 170.0 119.8 158.7 117.5 147.3 115.4 136.0 113.7 124.7 112.5 113.3 112.0 102.0 112.3 90.7 113.3 79.3 115.1 68.0 117.5 56.7 120.4 45.3 123.6 34.0 126.9 22.7 130.0 11.3 132.8 0.0Z' fill='%23b6fbff' fill-opacity='.4'/%3E%3C/svg%3E\");\n--tent-a1: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 240' preserveAspectRatio='xMidYMin meet'%3E%3Cpath d='M39.8 0.0 42.2 23.2 42.8 46.5 40.8 69.7 36.2 92.9 30.1 116.2 24.5 139.4 21.8 162.6 23.4 185.9 29.7 209.1' fill='none' stroke='%235ff4ff' stroke-opacity='0.60' stroke-width='1.8' stroke-linecap='round'/%3E%3Cpath d='M58.0 0.0 57.3 24.7 54.6 49.4 50.5 74.2 46.3 98.9 43.8 123.6 44.4 148.3 48.5 173.0 55.4 197.7 63.1 222.5' fill='none' stroke='%235ff4ff' stroke-opacity='0.61' stroke-width='2.5' stroke-linecap='round'/%3E%3Cpath d='M75.0 0.0 77.4 19.8 78.6 39.5 77.4 59.3 73.7 79.0 68.2 98.8 62.6 118.6 59.1 138.3 59.3 158.1 64.0 177.8' fill='none' stroke='%235ff4ff' stroke-opacity='0.52' stroke-width='2.1' stroke-linecap='round'/%3E%3Cpath d='M88.3 0.0 86.5 20.3 85.4 40.6 85.9 60.9 88.1 81.2 91.8 101.5 95.8 121.8 98.6 142.1 99.0 162.4 96.4 182.7' fill='none' stroke='%235ff4ff' stroke-opacity='0.48' stroke-width='1.7' stroke-linecap='round'/%3E%3Cpath d='M112.4 0.0 113.3 25.0 112.2 50.0 108.7 74.9 103.8 99.9 98.9 124.9 96.1 149.9 96.9 174.9 101.7 199.8 109.6 224.8' fill='none' stroke='%235ff4ff' stroke-opacity='0.45' stroke-width='2.5' stroke-linecap='round'/%3E%3Cpath d='M130.2 0.0 131.0 16.3 129.8 32.7 126.4 49.0 121.7 65.4 117.2 81.7 114.7 98.1 115.7 114.4 120.5 130.7 128.1 147.1' fill='none' stroke='%235ff4ff' stroke-opacity='0.40' stroke-width='2.6' stroke-linecap='round'/%3E%3Cpath d='M148.2 0.0 148.7 23.0 147.2 46.0 143.7 69.1 139.1 92.1 134.9 115.1 133.0 138.1 134.5 161.2 139.7 184.2 147.3 207.2' fill='none' stroke='%235ff4ff' stroke-opacity='0.61' stroke-width='2.4' stroke-linecap='round'/%3E%3Cpath d='M162.4 0.0 164.9 16.2 167.5 32.4 168.8 48.7 167.8 64.9 164.3 81.1 159.1 97.3 153.7 113.5 150.0 129.7 149.8 146.0' fill='none' stroke='%235ff4ff' stroke-opacity='0.49' stroke-width='1.7' stroke-linecap='round'/%3E%3Cpath d='M79.6 0.0 82.2 11.3 84.1 22.7 85.3 34.0 85.8 45.3 85.4 56.7 84.4 68.0 82.8 79.3 80.7 90.7 78.4 102.0 76.1 113.3 74.0 124.7 72.3 136.0 71.2 147.3 70.7 158.7 71.0 170.0 73.0 170.0 73.7 158.7 75.0 147.3 77.1 136.0 79.7 124.7 82.8 113.3 86.0 102.0 89.2 90.7 92.2 79.3 94.8 68.0 96.8 56.7 98.0 45.3 98.5 34.0 98.2 22.7 97.2 11.3 95.6 0.0Z' fill='%23b6fbff' fill-opacity='.4'/%3E%3Cpath d='M116.8 0.0 114.9 11.3 112.7 22.7 110.4 34.0 108.2 45.3 106.2 56.7 104.7 68.0 103.9 79.3 103.8 90.7 104.4 102.0 105.8 113.3 107.9 124.7 110.6 136.0 113.7 147.3 116.9 158.7 120.1 170.0 122.1 170.0 119.8 158.7 117.5 147.3 115.4 136.0 113.7 124.7 112.5 113.3 112.0 102.0 112.3 90.7 113.3 79.3 115.1 68.0 117.5 56.7 120.4 45.3 123.6 34.0 126.9 22.7 130.0 11.3 132.8 0.0Z' fill='%23b6fbff' fill-opacity='.4'/%3E%3C/svg%3E\");\n--bell-b: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 130' preserveAspectRatio='xMidYMin meet'%3E%3Cdefs%3E%3CradialGradient id='h' cx='.5' cy='.5' r='.5'%3E%3Cstop offset='0' stop-color='%23ff7ad9' stop-opacity='0.42'/%3E%3Cstop offset='0.55' stop-color='%23a05bff' stop-opacity='0.16'/%3E%3Cstop offset='1' stop-color='%23a05bff' stop-opacity='0'/%3E%3C/radialGradient%3E%3CradialGradient id='b' cx='.5' cy='.85' r='.95'%3E%3Cstop offset='0' stop-color='%23ffc9f0' stop-opacity='0.5'/%3E%3Cstop offset='0.55' stop-color='%23ff7ad9' stop-opacity='0.34'/%3E%3Cstop offset='1' stop-color='%23a05bff' stop-opacity='0.55'/%3E%3C/radialGradient%3E%3C/defs%3E%3Cellipse cx='100' cy='70' rx='100' ry='66' fill='url(%23h)'/%3E%3Cpath d='M22 108C22 44 58 12 100 12C142 12 178 44 178 108C164 102 152 114 138 106C128 120 112 118 100 108C88 118 72 120 62 106C48 114 36 102 22 108Z' fill='url(%23b)' stroke='%23ffc9f0' stroke-opacity='.75' stroke-width='2.5'/%3E%3Cpath d='M46 96C48 58 70 32 100 30C130 32 152 58 154 96' fill='none' stroke='%23ffc9f0' stroke-opacity='.4' stroke-width='2'/%3E%3Cpath d='M74 92C76 66 88 52 100 52C112 52 124 66 126 92' fill='none' stroke='%23ffc9f0' stroke-opacity='.5' stroke-width='3'/%3E%3Cellipse cx='100' cy='88' rx='16' ry='10' fill='%23ffc9f0' fill-opacity='.55'/%3E%3Cellipse cx='72' cy='40' rx='16' ry='6' fill='%23fff' fill-opacity='.4' transform='rotate(-28 72 40)'/%3E%3C/svg%3E\");\n--tent-b0: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 240' preserveAspectRatio='xMidYMin meet'%3E%3Cpath d='M39.7 0.0 41.0 17.3 40.6 34.6 38.0 51.9 33.7 69.3 29.0 86.6 25.6 103.9 25.2 121.2 28.3 138.5 34.7 155.8' fill='none' stroke='%23ff7ad9' stroke-opacity='0.57' stroke-width='2.0' stroke-linecap='round'/%3E%3Cpath d='M57.5 0.0 55.3 21.6 51.2 43.2 46.5 64.7 43.2 86.3 42.9 107.9 46.6 129.5 53.8 151.0 62.6 172.6 70.1 194.2' fill='none' stroke='%23ff7ad9' stroke-opacity='0.55' stroke-width='1.9' stroke-linecap='round'/%3E%3Cpath d='M77.4 0.0 76.8 21.5 73.7 43.0 68.4 64.5 62.7 86.0 58.8 107.5 58.7 129.0 63.3 150.6 71.9 172.1 82.1 193.6' fill='none' stroke='%23ff7ad9' stroke-opacity='0.46' stroke-width='2.1' stroke-linecap='round'/%3E%3Cpath d='M92.6 0.0 91.5 24.2 89.0 48.3 85.9 72.5 83.3 96.7 82.5 120.8 84.1 145.0 88.3 169.2 93.9 193.4 99.3 217.5' fill='none' stroke='%23ff7ad9' stroke-opacity='0.49' stroke-width='1.8' stroke-linecap='round'/%3E%3Cpath d='M111.9 0.0 113.2 17.8 112.6 35.6 109.8 53.5 105.3 71.3 100.4 89.1 97.0 106.9 96.8 124.7 100.4 142.6 107.3 160.4' fill='none' stroke='%23ff7ad9' stroke-opacity='0.44' stroke-width='1.7' stroke-linecap='round'/%3E%3Cpath d='M123.4 0.0 121.7 19.1 121.2 38.2 122.5 57.3 125.8 76.4 130.0 95.5 134.0 114.5 136.0 133.6 134.9 152.7 130.6 171.8' fill='none' stroke='%23ff7ad9' stroke-opacity='0.43' stroke-width='1.9' stroke-linecap='round'/%3E%3Cpath d='M143.9 0.0 140.5 17.7 136.9 35.4 134.9 53.2 135.8 70.9 140.1 88.6 146.9 106.3 154.3 124.1 159.6 141.8 160.6 159.5' fill='none' stroke='%23ff7ad9' stroke-opacity='0.61' stroke-width='2.2' stroke-linecap='round'/%3E%3Cpath d='M163.7 0.0 160.8 15.9 156.8 31.7 153.4 47.6 152.1 63.5 154.3 79.3 159.8 95.2 167.4 111.1 174.7 127.0 179.0 142.8' fill='none' stroke='%23ff7ad9' stroke-opacity='0.46' stroke-width='1.8' stroke-linecap='round'/%3E%3Cpath d='M79.6 0.0 82.2 11.3 84.1 22.7 85.3 34.0 85.8 45.3 85.4 56.7 84.4 68.0 82.8 79.3 80.7 90.7 78.4 102.0 76.1 113.3 74.0 124.7 72.3 136.0 71.2 147.3 70.7 158.7 71.0 170.0 73.0 170.0 73.7 158.7 75.0 147.3 77.1 136.0 79.7 124.7 82.8 113.3 86.0 102.0 89.2 90.7 92.2 79.3 94.8 68.0 96.8 56.7 98.0 45.3 98.5 34.0 98.2 22.7 97.2 11.3 95.6 0.0Z' fill='%23ffc9f0' fill-opacity='.4'/%3E%3Cpath d='M116.8 0.0 114.9 11.3 112.7 22.7 110.4 34.0 108.2 45.3 106.2 56.7 104.7 68.0 103.9 79.3 103.8 90.7 104.4 102.0 105.8 113.3 107.9 124.7 110.6 136.0 113.7 147.3 116.9 158.7 120.1 170.0 122.1 170.0 119.8 158.7 117.5 147.3 115.4 136.0 113.7 124.7 112.5 113.3 112.0 102.0 112.3 90.7 113.3 79.3 115.1 68.0 117.5 56.7 120.4 45.3 123.6 34.0 126.9 22.7 130.0 11.3 132.8 0.0Z' fill='%23ffc9f0' fill-opacity='.4'/%3E%3C/svg%3E\");\n--tent-b1: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 240' preserveAspectRatio='xMidYMin meet'%3E%3Cpath d='M33.0 0.0 31.8 24.2 31.9 48.4 33.9 72.5 37.4 96.7 41.4 120.9 44.5 145.1 45.3 169.2 43.0 193.4 37.9 217.6' fill='none' stroke='%23ff7ad9' stroke-opacity='0.45' stroke-width='2.5' stroke-linecap='round'/%3E%3Cpath d='M53.2 0.0 54.8 22.2 57.0 44.4 58.7 66.6 59.2 88.9 57.9 111.1 54.8 133.3 50.6 155.5 46.8 177.7 44.8 199.9' fill='none' stroke='%23ff7ad9' stroke-opacity='0.42' stroke-width='2.5' stroke-linecap='round'/%3E%3Cpath d='M67.2 0.0 65.9 16.1 66.9 32.3 70.5 48.4 76.0 64.5 81.7 80.6 85.2 96.8 84.9 112.9 80.0 129.0 71.5 145.2' fill='none' stroke='%23ff7ad9' stroke-opacity='0.43' stroke-width='2.3' stroke-linecap='round'/%3E%3Cpath d='M90.5 0.0 88.5 23.6 86.1 47.1 84.3 70.7 84.2 94.3 86.2 117.8 90.1 141.4 95.0 165.0 99.1 188.5 100.8 212.1' fill='none' stroke='%23ff7ad9' stroke-opacity='0.41' stroke-width='2.0' stroke-linecap='round'/%3E%3Cpath d='M112.3 0.0 111.5 16.1 108.6 32.1 104.2 48.2 99.7 64.3 97.0 80.3 97.7 96.4 102.1 112.4 109.6 128.5 117.9 144.6' fill='none' stroke='%23ff7ad9' stroke-opacity='0.60' stroke-width='1.9' stroke-linecap='round'/%3E%3Cpath d='M120.6 0.0 120.4 24.9 122.8 49.7 127.6 74.6 133.5 99.5 138.3 124.4 139.9 149.2 136.9 174.1 129.5 199.0 119.5 223.8' fill='none' stroke='%23ff7ad9' stroke-opacity='0.60' stroke-width='2.4' stroke-linecap='round'/%3E%3Cpath d='M147.8 0.0 147.6 21.2 145.6 42.4 141.9 63.7 137.8 84.9 134.8 106.1 134.4 127.3 137.3 148.6 143.1 169.8 150.4 191.0' fill='none' stroke='%23ff7ad9' stroke-opacity='0.39' stroke-width='2.1' stroke-linecap='round'/%3E%3Cpath d='M162.4 0.0 165.7 16.9 169.0 33.9 170.7 50.8 169.5 67.7 165.1 84.7 158.4 101.6 151.5 118.5 146.7 135.5 146.3 152.4' fill='none' stroke='%23ff7ad9' stroke-opacity='0.50' stroke-width='2.3' stroke-linecap='round'/%3E%3Cpath d='M79.6 0.0 82.2 11.3 84.1 22.7 85.3 34.0 85.8 45.3 85.4 56.7 84.4 68.0 82.8 79.3 80.7 90.7 78.4 102.0 76.1 113.3 74.0 124.7 72.3 136.0 71.2 147.3 70.7 158.7 71.0 170.0 73.0 170.0 73.7 158.7 75.0 147.3 77.1 136.0 79.7 124.7 82.8 113.3 86.0 102.0 89.2 90.7 92.2 79.3 94.8 68.0 96.8 56.7 98.0 45.3 98.5 34.0 98.2 22.7 97.2 11.3 95.6 0.0Z' fill='%23ffc9f0' fill-opacity='.4'/%3E%3Cpath d='M116.8 0.0 114.9 11.3 112.7 22.7 110.4 34.0 108.2 45.3 106.2 56.7 104.7 68.0 103.9 79.3 103.8 90.7 104.4 102.0 105.8 113.3 107.9 124.7 110.6 136.0 113.7 147.3 116.9 158.7 120.1 170.0 122.1 170.0 119.8 158.7 117.5 147.3 115.4 136.0 113.7 124.7 112.5 113.3 112.0 102.0 112.3 90.7 113.3 79.3 115.1 68.0 117.5 56.7 120.4 45.3 123.6 34.0 126.9 22.7 130.0 11.3 132.8 0.0Z' fill='%23ffc9f0' fill-opacity='.4'/%3E%3C/svg%3E\");\n--bell-c: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 130' preserveAspectRatio='xMidYMin meet'%3E%3Cdefs%3E%3CradialGradient id='h' cx='.5' cy='.5' r='.5'%3E%3Cstop offset='0' stop-color='%239d8bff' stop-opacity='0.42'/%3E%3Cstop offset='0.55' stop-color='%234a5bff' stop-opacity='0.16'/%3E%3Cstop offset='1' stop-color='%234a5bff' stop-opacity='0'/%3E%3C/radialGradient%3E%3CradialGradient id='b' cx='.5' cy='.85' r='.95'%3E%3Cstop offset='0' stop-color='%23d5ceff' stop-opacity='0.5'/%3E%3Cstop offset='0.55' stop-color='%239d8bff' stop-opacity='0.34'/%3E%3Cstop offset='1' stop-color='%234a5bff' stop-opacity='0.55'/%3E%3C/radialGradient%3E%3C/defs%3E%3Cellipse cx='100' cy='70' rx='100' ry='66' fill='url(%23h)'/%3E%3Cpath d='M22 108C22 44 58 12 100 12C142 12 178 44 178 108C164 102 152 114 138 106C128 120 112 118 100 108C88 118 72 120 62 106C48 114 36 102 22 108Z' fill='url(%23b)' stroke='%23d5ceff' stroke-opacity='.75' stroke-width='2.5'/%3E%3Cpath d='M46 96C48 58 70 32 100 30C130 32 152 58 154 96' fill='none' stroke='%23d5ceff' stroke-opacity='.4' stroke-width='2'/%3E%3Cpath d='M74 92C76 66 88 52 100 52C112 52 124 66 126 92' fill='none' stroke='%23d5ceff' stroke-opacity='.5' stroke-width='3'/%3E%3Cellipse cx='100' cy='88' rx='16' ry='10' fill='%23d5ceff' fill-opacity='.55'/%3E%3Cellipse cx='72' cy='40' rx='16' ry='6' fill='%23fff' fill-opacity='.4' transform='rotate(-28 72 40)'/%3E%3C/svg%3E\");\n--tent-c0: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 240' preserveAspectRatio='xMidYMin meet'%3E%3Cpath d='M34.2 0.0 37.0 20.8 41.0 41.6 44.4 62.4 45.8 83.2 43.8 104.0 38.5 124.9 31.0 145.7 23.7 166.5 19.3 187.3' fill='none' stroke='%239d8bff' stroke-opacity='0.36' stroke-width='1.9' stroke-linecap='round'/%3E%3Cpath d='M56.5 0.0 57.7 16.7 57.9 33.3 56.4 50.0 53.4 66.7 49.7 83.3 46.7 100.0 45.5 116.6 47.1 133.3 51.3 150.0' fill='none' stroke='%239d8bff' stroke-opacity='0.47' stroke-width='2.1' stroke-linecap='round'/%3E%3Cpath d='M75.4 0.0 74.6 22.7 72.2 45.3 68.7 68.0 65.2 90.6 63.3 113.3 64.0 135.9 67.7 158.6 73.8 181.3 80.3 203.9' fill='none' stroke='%239d8bff' stroke-opacity='0.52' stroke-width='2.1' stroke-linecap='round'/%3E%3Cpath d='M94.5 0.0 92.7 23.1 88.5 46.2 83.2 69.2 78.8 92.3 77.2 115.4 79.9 138.5 86.8 161.5 96.3 184.6 105.4 207.7' fill='none' stroke='%239d8bff' stroke-opacity='0.62' stroke-width='1.9' stroke-linecap='round'/%3E%3Cpath d='M107.4 0.0 104.4 19.8 101.4 39.6 99.9 59.5 101.2 79.3 105.5 99.1 111.8 118.9 118.2 138.8 122.4 158.6 122.5 178.4' fill='none' stroke='%239d8bff' stroke-opacity='0.54' stroke-width='2.6' stroke-linecap='round'/%3E%3Cpath d='M126.4 0.0 128.7 23.0 131.0 45.9 132.1 68.9 131.2 91.8 128.0 114.8 123.2 137.7 118.3 160.7 115.1 183.6 115.0 206.6' fill='none' stroke='%239d8bff' stroke-opacity='0.48' stroke-width='1.8' stroke-linecap='round'/%3E%3Cpath d='M142.4 0.0 144.6 23.6 147.8 47.1 150.7 70.7 152.0 94.2 150.6 117.8 146.5 141.3 140.5 164.9 134.5 188.4 130.6 212.0' fill='none' stroke='%239d8bff' stroke-opacity='0.54' stroke-width='2.0' stroke-linecap='round'/%3E%3Cpath d='M159.6 0.0 157.0 21.2 155.5 42.4 156.1 63.6 159.3 84.8 164.5 106.1 170.2 127.3 174.2 148.5 174.9 169.7 171.2 190.9' fill='none' stroke='%239d8bff' stroke-opacity='0.59' stroke-width='2.3' stroke-linecap='round'/%3E%3Cpath d='M79.6 0.0 82.2 11.3 84.1 22.7 85.3 34.0 85.8 45.3 85.4 56.7 84.4 68.0 82.8 79.3 80.7 90.7 78.4 102.0 76.1 113.3 74.0 124.7 72.3 136.0 71.2 147.3 70.7 158.7 71.0 170.0 73.0 170.0 73.7 158.7 75.0 147.3 77.1 136.0 79.7 124.7 82.8 113.3 86.0 102.0 89.2 90.7 92.2 79.3 94.8 68.0 96.8 56.7 98.0 45.3 98.5 34.0 98.2 22.7 97.2 11.3 95.6 0.0Z' fill='%23d5ceff' fill-opacity='.4'/%3E%3Cpath d='M116.8 0.0 114.9 11.3 112.7 22.7 110.4 34.0 108.2 45.3 106.2 56.7 104.7 68.0 103.9 79.3 103.8 90.7 104.4 102.0 105.8 113.3 107.9 124.7 110.6 136.0 113.7 147.3 116.9 158.7 120.1 170.0 122.1 170.0 119.8 158.7 117.5 147.3 115.4 136.0 113.7 124.7 112.5 113.3 112.0 102.0 112.3 90.7 113.3 79.3 115.1 68.0 117.5 56.7 120.4 45.3 123.6 34.0 126.9 22.7 130.0 11.3 132.8 0.0Z' fill='%23d5ceff' fill-opacity='.4'/%3E%3C/svg%3E\");\n--tent-c1: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 240' preserveAspectRatio='xMidYMin meet'%3E%3Cpath d='M39.9 0.0 41.7 17.6 41.7 35.2 39.2 52.8 34.5 70.5 29.0 88.1 24.6 105.7 23.3 123.3 26.1 140.9 32.8 158.5' fill='none' stroke='%239d8bff' stroke-opacity='0.40' stroke-width='2.3' stroke-linecap='round'/%3E%3Cpath d='M55.8 0.0 52.7 20.1 48.5 40.3 44.8 60.4 43.5 80.5 45.8 100.7 51.7 120.8 59.8 140.9 67.6 161.1 72.1 181.2' fill='none' stroke='%239d8bff' stroke-opacity='0.51' stroke-width='2.3' stroke-linecap='round'/%3E%3Cpath d='M75.1 0.0 77.4 18.3 78.3 36.6 76.8 54.9 72.9 73.2 67.5 91.5 62.3 109.8 59.3 128.1 60.1 146.4 65.2 164.7' fill='none' stroke='%239d8bff' stroke-opacity='0.63' stroke-width='2.2' stroke-linecap='round'/%3E%3Cpath d='M90.2 0.0 87.7 24.1 84.9 48.2 83.1 72.3 83.4 96.4 86.3 120.5 91.3 144.7 97.0 168.8 101.5 192.9 102.8 217.0' fill='none' stroke='%239d8bff' stroke-opacity='0.54' stroke-width='1.9' stroke-linecap='round'/%3E%3Cpath d='M103.7 0.0 103.0 15.9 104.5 31.9 108.1 47.8 112.9 63.8 117.4 79.7 119.6 95.6 118.1 111.6 112.9 127.5 105.0 143.5' fill='none' stroke='%239d8bff' stroke-opacity='0.40' stroke-width='2.5' stroke-linecap='round'/%3E%3Cpath d='M128.3 0.0 127.3 22.2 125.0 44.5 122.2 66.7 119.9 89.0 119.2 111.2 120.8 133.5 124.7 155.7 129.7 178.0 134.5 200.2' fill='none' stroke='%239d8bff' stroke-opacity='0.53' stroke-width='1.8' stroke-linecap='round'/%3E%3Cpath d='M146.2 0.0 145.3 20.3 143.1 40.5 140.5 60.8 138.3 81.0 137.6 101.3 139.1 121.5 142.6 141.8 147.5 162.0 152.0 182.3' fill='none' stroke='%239d8bff' stroke-opacity='0.60' stroke-width='2.0' stroke-linecap='round'/%3E%3Cpath d='M159.8 0.0 158.2 25.1 157.5 50.2 158.5 75.3 161.2 100.4 165.1 125.5 168.8 150.6 171.0 175.8 170.5 200.9 167.0 226.0' fill='none' stroke='%239d8bff' stroke-opacity='0.43' stroke-width='1.6' stroke-linecap='round'/%3E%3Cpath d='M79.6 0.0 82.2 11.3 84.1 22.7 85.3 34.0 85.8 45.3 85.4 56.7 84.4 68.0 82.8 79.3 80.7 90.7 78.4 102.0 76.1 113.3 74.0 124.7 72.3 136.0 71.2 147.3 70.7 158.7 71.0 170.0 73.0 170.0 73.7 158.7 75.0 147.3 77.1 136.0 79.7 124.7 82.8 113.3 86.0 102.0 89.2 90.7 92.2 79.3 94.8 68.0 96.8 56.7 98.0 45.3 98.5 34.0 98.2 22.7 97.2 11.3 95.6 0.0Z' fill='%23d5ceff' fill-opacity='.4'/%3E%3Cpath d='M116.8 0.0 114.9 11.3 112.7 22.7 110.4 34.0 108.2 45.3 106.2 56.7 104.7 68.0 103.9 79.3 103.8 90.7 104.4 102.0 105.8 113.3 107.9 124.7 110.6 136.0 113.7 147.3 116.9 158.7 120.1 170.0 122.1 170.0 119.8 158.7 117.5 147.3 115.4 136.0 113.7 124.7 112.5 113.3 112.0 102.0 112.3 90.7 113.3 79.3 115.1 68.0 117.5 56.7 120.4 45.3 123.6 34.0 126.9 22.7 130.0 11.3 132.8 0.0Z' fill='%23d5ceff' fill-opacity='.4'/%3E%3C/svg%3E\");\n}\n.aur-root[data-fx=\"ocean\"] .aur-fx-e > i:nth-child(1) { --x: 4.8%; --w: 11.6vmin; --dur: 77s; --dl: -67s; --m: 4; --sway: 4.4s; --bell: var(--bell-a); --tent: var(--tent-a0); }\n.aur-root[data-fx=\"ocean\"] .aur-fx-e > i:nth-child(2) { --x: 16.3%; --w: 13.2vmin; --dur: 87s; --dl: -81s; --m: 6; --sway: 3.2s; --bell: var(--bell-b); --tent: var(--tent-b1); }\n.aur-root[data-fx=\"ocean\"] .aur-fx-e > i:nth-child(3) { --x: 27.3%; --w: 13.9vmin; --dur: 93s; --dl: -67s; --m: 4; --sway: 3.7s; --bell: var(--bell-c); --tent: var(--tent-c0); }\n.aur-root[data-fx=\"ocean\"] .aur-fx-e > i:nth-child(4) { --x: 36.8%; --w: 9.9vmin; --dur: 114s; --dl: -113s; --m: 4; --sway: 6.1s; --bell: var(--bell-a); --tent: var(--tent-a1); }\n.aur-root[data-fx=\"ocean\"] .aur-fx-e > i:nth-child(5) { --x: 50.3%; --w: 14.2vmin; --dur: 75s; --dl: -22s; --m: 6; --sway: 3.9s; --bell: var(--bell-b); --tent: var(--tent-b0); }\n.aur-root[data-fx=\"ocean\"] .aur-fx-e > i:nth-child(6) { --x: 64.3%; --w: 15.2vmin; --dur: 109s; --dl: -99s; --m: 5; --sway: 4.1s; --bell: var(--bell-c); --tent: var(--tent-c1); }\n.aur-root[data-fx=\"ocean\"] .aur-fx-e > i:nth-child(7) { --x: 75.9%; --w: 10.4vmin; --dur: 114s; --dl: -101s; --m: 4; --sway: 6.6s; --bell: var(--bell-a); --tent: var(--tent-a0); }\n.aur-root[data-fx=\"ocean\"] .aur-fx-e > i:nth-child(8) { --x: 87.6%; --w: 10.0vmin; --dur: 82s; --dl: -60s; --m: 4; --sway: 6.9s; --bell: var(--bell-b); --tent: var(--tent-b1); }\n.aur-root[data-fx=\"ocean\"][data-bganim=\"on\"] .aur-bg[data-bar=\"a\"] .aur-fx-e > i:nth-child(-n + 8) { animation: aur-oc-rise var(--dur) linear var(--dl) infinite, aur-oc-wander var(--sway) ease-in-out infinite alternate, aur-fx-flash-a 1s ease-out; }\n.aur-root[data-fx=\"ocean\"][data-bganim=\"on\"] .aur-bg[data-bar=\"b\"] .aur-fx-e > i:nth-child(-n + 8) { animation: aur-oc-rise var(--dur) linear var(--dl) infinite, aur-oc-wander var(--sway) ease-in-out infinite alternate, aur-fx-flash-b 1s ease-out; }\n.aur-root[data-fx=\"ocean\"] .aur-fx-e > i:nth-child(9) {\nleft: 0;\nright: 0;\ntop: 0;\nheight: 58%;\noverflow: hidden;\n-webkit-mask-image: linear-gradient(to bottom, #000 25%, transparent 100%);\nmask-image: linear-gradient(to bottom, #000 25%, transparent 100%);\nopacity: calc(0.85 - var(--aur-song, 0) * 0.75);\ntransition: opacity 1.5s linear;\n}\n.aur-root[data-fx=\"ocean\"] .aur-fx-e > i:nth-child(9)::before,\n.aur-root[data-fx=\"ocean\"] .aur-fx-e > i:nth-child(9)::after {\ncontent: \"\";\nposition: absolute;\ntop: -640px;\nleft: -640px;\nwidth: calc(100% + 640px);\nheight: calc(100% + 640px);\nopacity: 0.5;\n}\n.aur-root[data-fx=\"ocean\"] .aur-fx-e > i:nth-child(9)::before { background: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 640' preserveAspectRatio='none'%3E%3Cdefs%3E%3Cfilter id='c' x='0' y='0' width='640' height='640' filterUnits='userSpaceOnUse'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.011 .016' numOctaves='3' seed='8' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .78 0 0 0 0 1 0 0 0 0 1 1 0 0 0 0'/%3E%3CfeComponentTransfer%3E%3CfeFuncA type='table' tableValues='0 0 0 0 .1 .55 1 .55 .1 0 0 0 0'/%3E%3C/feComponentTransfer%3E%3C/filter%3E%3C/defs%3E%3Crect width='640' height='640' filter='url(%23c)'/%3E%3C/svg%3E\") 0 0 / 640px 640px repeat; animation: aur-oc-caustic-a 40s linear infinite; }\n.aur-root[data-fx=\"ocean\"] .aur-fx-e > i:nth-child(9)::after { background: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 640' preserveAspectRatio='none'%3E%3Cdefs%3E%3Cfilter id='c' x='0' y='0' width='640' height='640' filterUnits='userSpaceOnUse'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.011 .016' numOctaves='3' seed='8' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .78 0 0 0 0 1 0 0 0 0 1 1 0 0 0 0'/%3E%3CfeComponentTransfer%3E%3CfeFuncA type='table' tableValues='0 0 0 0 .1 .55 1 .55 .1 0 0 0 0'/%3E%3C/feComponentTransfer%3E%3C/filter%3E%3C/defs%3E%3Crect width='640' height='640' filter='url(%23c)'/%3E%3C/svg%3E\") 0 0 / 640px 640px repeat; opacity: 0.4; scale: 0.75; transform-origin: 0 0; animation: aur-oc-caustic-b 55s linear infinite; }\n@keyframes aur-oc-caustic-a { to { transform: translate(640px, 640px); } }\n@keyframes aur-oc-caustic-b { to { transform: translate(-640px, 640px); } }\n.aur-root[data-fx=\"ocean\"] .aur-fx-e > i:nth-child(10) {\nleft: -46vw;\ntop: 44%;\nwidth: 42vw;\nheight: 14vw;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 900 300' preserveAspectRatio='xMidYMid meet'%3E%3Cg fill='%2303294a' fill-opacity='.7'%3E%3Cpath d='M137 138Q166 118 202 138Q166 157 137 138ZM137 138L113 122 113 154Z'/%3E%3Cpath d='M374 233Q401 215 433 233Q401 250 374 233ZM374 233L353 218 353 247Z'/%3E%3Cpath d='M399 127Q418 115 440 127Q418 140 399 127ZM399 127L385 117 385 138Z'/%3E%3Cpath d='M224 206Q245 192 271 206Q245 220 224 206ZM224 206L208 194 208 217Z'/%3E%3Cpath d='M269 149Q297 131 331 149Q297 168 269 149ZM269 149L247 134 247 165Z'/%3E%3Cpath d='M646 130Q676 111 712 130Q676 150 646 130ZM646 130L622 114 622 147Z'/%3E%3Cpath d='M744 184Q772 165 807 184Q772 202 744 184ZM744 184L721 168 721 199Z'/%3E%3Cpath d='M620 216Q645 200 675 216Q645 232 620 216ZM620 216L601 202 601 230Z'/%3E%3Cpath d='M586 139Q610 123 640 139Q610 155 586 139ZM586 139L566 126 566 153Z'/%3E%3Cpath d='M653 99Q675 84 701 99Q675 113 653 99ZM653 99L636 87 636 111Z'/%3E%3Cpath d='M752 197Q775 182 804 197Q775 213 752 197ZM752 197L733 184 733 210Z'/%3E%3Cpath d='M561 149Q589 131 623 149Q589 168 561 149ZM561 149L539 134 539 165Z'/%3E%3Cpath d='M583 62Q601 50 623 62Q601 74 583 62ZM583 62L568 52 568 72Z'/%3E%3Cpath d='M408 162Q435 144 467 162Q435 180 408 162ZM408 162L386 147 386 177Z'/%3E%3Cpath d='M235 227Q258 212 285 227Q258 242 235 227ZM235 227L217 215 217 240Z'/%3E%3Cpath d='M500 59Q521 45 547 59Q521 73 500 59ZM500 59L484 48 484 71Z'/%3E%3Cpath d='M121 116Q146 100 175 116Q146 132 121 116ZM121 116L102 103 102 129Z'/%3E%3Cpath d='M346 185Q373 167 407 185Q373 203 346 185ZM346 185L325 170 325 200Z'/%3E%3Cpath d='M544 219Q568 203 598 219Q568 235 544 219ZM544 219L524 206 524 233Z'/%3E%3Cpath d='M350 140Q376 123 407 140Q376 157 350 140ZM350 140L330 126 330 155Z'/%3E%3C/g%3E%3C/svg%3E\") center / contain no-repeat;\nopacity: calc(0.75 - var(--aur-song, 0) * 0.4);\nanimation: aur-oc-school 100s linear -38s infinite, aur-oc-weave 5s ease-in-out infinite alternate;\n}\n@keyframes aur-oc-school { to { translate: 200vw 0; } }\n@keyframes aur-oc-weave { from { rotate: -3deg; } to { rotate: 3deg; } }\n.aur-root[data-look=\"ocean\"]:is([data-view=\"split\"], [data-view=\"mirror\"], [data-view=\"captions\"], [data-view=\"stage\"]) .aur-art-wrap,\n.aur-root[data-look=\"ocean\"]:is([data-view=\"split\"], [data-view=\"mirror\"], [data-view=\"captions\"], [data-view=\"stage\"])[data-playing=\"false\"] .aur-art-wrap {\n--oc-rim: max(12px, 2.4vmin);\nborder-radius: 50%;\nbox-shadow: 0 0 0 max(3px, 0.5vmin) #06131c, 0 2vmin 5vmin rgba(0, 12, 30, 0.6);\n}\n.aur-root[data-look=\"ocean\"]:is([data-view=\"split\"], [data-view=\"mirror\"], [data-view=\"captions\"], [data-view=\"stage\"]) .aur-art-wrap::before {\ncontent: \"\";\nposition: absolute;\ninset: calc(var(--oc-rim) * -1 - max(3px, 0.5vmin));\nborder-radius: 50%;\nbackground:\nrepeating-conic-gradient(from 0deg, rgba(8, 20, 28, 0.8) 0 1.4deg, transparent 1.4deg 30deg),\nconic-gradient(from 25deg, #b3c3cc, #6d7f89, #c9d6dd, #56666f, #aebdc6, #64747d, #b3c3cc);\n-webkit-mask: radial-gradient(farthest-side, transparent calc(100% - var(--oc-rim)), #000 calc(100% - var(--oc-rim) + 1px));\nmask: radial-gradient(farthest-side, transparent calc(100% - var(--oc-rim)), #000 calc(100% - var(--oc-rim) + 1px));\nbox-shadow: 0 0 0 1px rgba(255, 255, 255, 0.18);\n}\n.aur-root[data-look=\"ocean\"]:is([data-view=\"split\"], [data-view=\"mirror\"], [data-view=\"captions\"], [data-view=\"stage\"]) .aur-art-wrap::after {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nborder-radius: 50%;\npointer-events: none;\nbackground:\nlinear-gradient(135deg, rgba(255, 255, 255, 0.34) 0, rgba(255, 255, 255, 0.06) 30%, transparent 31%),\nradial-gradient(circle, transparent 60%, rgba(0, 30, 60, 0.42));\n}\n.aur-root[data-look=\"ocean\"] { --aur-glow-tint: #7fe0ff; }\n.aur-root[data-look=\"ocean\"][data-color=\"white\"] { --aur-hi: #e6fbff; }\n.aur-root[data-look=\"ocean\"][data-motion=\"full\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active .aur-main { animation: aur-oc-line 1.6s var(--aur-ease); }\n@keyframes aur-oc-line { from { opacity: 0.3; transform: translateY(0.3em); } }\n.aur-root[data-fx=\"rain\"] .aur-fx {\nbackground:\nurl(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 900' preserveAspectRatio='xMidYMax slice'%3E%3Cdefs%3E%3Cfilter id='b' x='-5%25' y='-5%25' width='110%25' height='110%25'%3E%3CfeGaussianBlur stdDeviation='6'/%3E%3C/filter%3E%3C/defs%3E%3Cg filter='url(%23b)'%3E%3Crect x='-20' y='783' width='128' height='117' fill='%23131d33'/%3E%3Crect x='115' y='500' width='86' height='400' fill='%23101a2e'/%3E%3Crect x='198' y='635' width='125' height='265' fill='%23131d33'/%3E%3Crect x='328' y='569' width='127' height='331' fill='%23131d33'/%3E%3Crect x='463' y='645' width='104' height='255' fill='%230a101d'/%3E%3Crect x='574' y='710' width='74' height='190' fill='%23131d33'/%3E%3Crect x='657' y='825' width='125' height='75' fill='%23131d33'/%3E%3Crect x='783' y='793' width='97' height='107' fill='%23131d33'/%3E%3Crect x='878' y='740' width='83' height='160' fill='%230a101d'/%3E%3Crect x='958' y='780' width='100' height='120' fill='%230a101d'/%3E%3Crect x='1054' y='589' width='124' height='311' fill='%230c1424'/%3E%3Crect x='1172' y='628' width='114' height='272' fill='%230c1424'/%3E%3Crect x='1291' y='660' width='124' height='240' fill='%230c1424'/%3E%3Crect x='1415' y='649' width='60' height='251' fill='%23131d33'/%3E%3Crect x='1472' y='820' width='66' height='80' fill='%23101a2e'/%3E%3Crect x='1543' y='768' width='112' height='132' fill='%23131d33'/%3E%3Cpath d='M84 791h7v9h-7zM121 688h7v9h-7zM121 728h7v9h-7zM135 628h7v9h-7zM163 648h7v9h-7zM163 868h7v9h-7zM218 643h7v9h-7zM218 703h7v9h-7zM232 683h7v9h-7zM260 683h7v9h-7zM288 663h7v9h-7zM288 723h7v9h-7zM302 883h7v9h-7zM376 597h7v9h-7zM404 797h7v9h-7zM418 777h7v9h-7zM446 637h7v9h-7zM511 693h7v9h-7zM511 713h7v9h-7zM525 813h7v9h-7zM580 758h7v9h-7zM580 798h7v9h-7zM594 778h7v9h-7zM608 858h7v9h-7zM705 873h7v9h-7zM761 873h7v9h-7zM789 881h7v9h-7zM884 868h7v9h-7zM898 848h7v9h-7zM926 788h7v9h-7zM1006 868h7v9h-7zM1074 597h7v9h-7zM1116 737h7v9h-7zM1116 817h7v9h-7zM1130 717h7v9h-7zM1178 776h7v9h-7zM1206 636h7v9h-7zM1206 856h7v9h-7zM1220 736h7v9h-7zM1220 876h7v9h-7zM1234 716h7v9h-7zM1248 696h7v9h-7zM1248 816h7v9h-7zM1325 668h7v9h-7zM1339 728h7v9h-7zM1421 837h7v9h-7zM1435 657h7v9h-7zM1549 776h7v9h-7zM1563 776h7v9h-7z' fill='rgb(255,205,130)' fill-opacity='.7'/%3E%3Cpath d='M-14 831h7v9h-7zM42 851h7v9h-7zM84 831h7v9h-7zM98 871h7v9h-7zM121 748h7v9h-7zM121 888h7v9h-7zM135 508h7v9h-7zM135 828h7v9h-7zM135 868h7v9h-7zM163 528h7v9h-7zM204 823h7v9h-7zM260 803h7v9h-7zM260 883h7v9h-7zM274 643h7v9h-7zM288 883h7v9h-7zM302 643h7v9h-7zM376 617h7v9h-7zM390 637h7v9h-7zM404 817h7v9h-7zM418 857h7v9h-7zM446 777h7v9h-7zM446 877h7v9h-7zM469 813h7v9h-7zM483 813h7v9h-7zM525 853h7v9h-7zM553 653h7v9h-7zM622 798h7v9h-7zM636 838h7v9h-7zM803 881h7v9h-7zM817 861h7v9h-7zM884 748h7v9h-7zM964 788h7v9h-7zM992 848h7v9h-7zM1006 808h7v9h-7zM1020 808h7v9h-7zM1060 697h7v9h-7zM1074 817h7v9h-7zM1102 637h7v9h-7zM1130 637h7v9h-7zM1144 617h7v9h-7zM1144 697h7v9h-7zM1158 777h7v9h-7zM1192 876h7v9h-7zM1234 736h7v9h-7zM1234 816h7v9h-7zM1248 676h7v9h-7zM1297 668h7v9h-7zM1297 788h7v9h-7zM1311 748h7v9h-7zM1339 808h7v9h-7zM1353 788h7v9h-7zM1367 668h7v9h-7zM1395 808h7v9h-7zM1421 817h7v9h-7zM1435 677h7v9h-7zM1449 737h7v9h-7zM1449 757h7v9h-7zM1463 657h7v9h-7zM1463 777h7v9h-7zM1577 836h7v9h-7z' fill='rgb(255,190,110)' fill-opacity='.7'/%3E%3Cpath d='M135 608h7v9h-7zM191 628h7v9h-7zM191 688h7v9h-7zM204 783h7v9h-7zM218 723h7v9h-7zM232 863h7v9h-7zM246 803h7v9h-7zM246 843h7v9h-7zM260 743h7v9h-7zM334 697h7v9h-7zM376 577h7v9h-7zM376 817h7v9h-7zM390 877h7v9h-7zM404 637h7v9h-7zM432 597h7v9h-7zM432 657h7v9h-7zM432 817h7v9h-7zM525 713h7v9h-7zM525 833h7v9h-7zM539 713h7v9h-7zM539 833h7v9h-7zM553 853h7v9h-7zM580 778h7v9h-7zM594 798h7v9h-7zM733 853h7v9h-7zM845 821h7v9h-7zM884 828h7v9h-7zM884 848h7v9h-7zM898 868h7v9h-7zM992 828h7v9h-7zM1130 677h7v9h-7zM1158 797h7v9h-7zM1178 676h7v9h-7zM1192 836h7v9h-7zM1206 756h7v9h-7zM1220 716h7v9h-7zM1248 876h7v9h-7zM1262 696h7v9h-7zM1262 876h7v9h-7zM1276 756h7v9h-7zM1421 797h7v9h-7zM1605 816h7v9h-7zM1619 796h7v9h-7zM1619 836h7v9h-7zM1633 796h7v9h-7z' fill='rgb(255,230,170)' fill-opacity='.7'/%3E%3Cpath d='M-14 851h7v9h-7zM0 831h7v9h-7zM14 791h7v9h-7zM121 768h7v9h-7zM121 828h7v9h-7zM149 608h7v9h-7zM149 708h7v9h-7zM177 708h7v9h-7zM177 748h7v9h-7zM204 863h7v9h-7zM232 703h7v9h-7zM260 823h7v9h-7zM274 863h7v9h-7zM334 737h7v9h-7zM376 757h7v9h-7zM390 657h7v9h-7zM390 837h7v9h-7zM404 577h7v9h-7zM404 617h7v9h-7zM418 657h7v9h-7zM418 837h7v9h-7zM432 617h7v9h-7zM446 657h7v9h-7zM511 773h7v9h-7zM525 673h7v9h-7zM553 733h7v9h-7zM553 813h7v9h-7zM594 738h7v9h-7zM608 878h7v9h-7zM622 718h7v9h-7zM964 868h7v9h-7zM1020 828h7v9h-7zM1060 877h7v9h-7zM1102 677h7v9h-7zM1102 717h7v9h-7zM1102 777h7v9h-7zM1116 717h7v9h-7zM1130 797h7v9h-7zM1144 777h7v9h-7zM1206 676h7v9h-7zM1220 676h7v9h-7zM1220 796h7v9h-7zM1234 656h7v9h-7zM1276 836h7v9h-7zM1276 856h7v9h-7zM1325 768h7v9h-7zM1381 708h7v9h-7zM1381 788h7v9h-7zM1395 748h7v9h-7zM1435 877h7v9h-7zM1478 868h7v9h-7zM1577 876h7v9h-7zM1633 836h7v9h-7z' fill='rgb(170,210,255)' fill-opacity='.7'/%3E%3Ccircle cx='182' cy='504' r='5' fill='%23ff4a3d'/%3E%3Ccircle cx='496' cy='479' r='5' fill='%23ff4a3d'/%3E%3Ccircle cx='197' cy='555' r='5' fill='%23ff4a3d'/%3E%3Ccircle cx='984' cy='483' r='5' fill='%23ff4a3d'/%3E%3C/g%3E%3C/svg%3E\") center bottom / cover no-repeat,\nlinear-gradient(to bottom, rgba(8, 13, 26, 0.9), rgba(12, 20, 38, 0.84) 60%, rgba(18, 26, 46, 0.78));\n}\n.aur-root[data-fx=\"rain\"] .aur-fx-a {\ndisplay: block;\ninset: 0;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 900' preserveAspectRatio='xMidYMid slice'%3E%3Cdefs%3E%3Cfilter id='b' x='-50%25' y='-50%25' width='200%25' height='200%25'%3E%3CfeGaussianBlur stdDeviation='8'/%3E%3C/filter%3E%3C/defs%3E%3Ccircle cx='1463' cy='836' r='41' fill='rgb(255,190,110)' fill-opacity='0.12' filter='url(%23b)'/%3E%3Ccircle cx='499' cy='574' r='23' fill='rgb(190,240,230)' fill-opacity='0.17' filter='url(%23b)'/%3E%3Ccircle cx='714' cy='502' r='27' fill='rgb(255,190,110)' fill-opacity='0.15' filter='url(%23b)'/%3E%3Ccircle cx='1551' cy='629' r='13' fill='rgb(190,240,230)' fill-opacity='0.30' filter='url(%23b)'/%3E%3Ccircle cx='580' cy='426' r='37' fill='rgb(255,120,120)' fill-opacity='0.21' filter='url(%23b)'/%3E%3Ccircle cx='288' cy='499' r='36' fill='rgb(255,120,120)' fill-opacity='0.30' filter='url(%23b)'/%3E%3Ccircle cx='595' cy='663' r='33' fill='rgb(255,210,150)' fill-opacity='0.26' filter='url(%23b)'/%3E%3Ccircle cx='1290' cy='482' r='27' fill='rgb(255,235,190)' fill-opacity='0.23' filter='url(%23b)'/%3E%3Ccircle cx='1022' cy='484' r='18' fill='rgb(255,210,150)' fill-opacity='0.28' filter='url(%23b)'/%3E%3Ccircle cx='831' cy='668' r='15' fill='rgb(120,190,240)' fill-opacity='0.13' filter='url(%23b)'/%3E%3Ccircle cx='450' cy='663' r='38' fill='rgb(255,210,150)' fill-opacity='0.15' filter='url(%23b)'/%3E%3Ccircle cx='1424' cy='649' r='41' fill='rgb(120,190,240)' fill-opacity='0.25' filter='url(%23b)'/%3E%3Ccircle cx='423' cy='449' r='37' fill='rgb(190,240,230)' fill-opacity='0.31' filter='url(%23b)'/%3E%3Ccircle cx='789' cy='551' r='17' fill='rgb(190,240,230)' fill-opacity='0.26' filter='url(%23b)'/%3E%3Ccircle cx='1495' cy='477' r='43' fill='rgb(255,190,110)' fill-opacity='0.27' filter='url(%23b)'/%3E%3Ccircle cx='634' cy='475' r='19' fill='rgb(255,190,110)' fill-opacity='0.35' filter='url(%23b)'/%3E%3Ccircle cx='1276' cy='836' r='29' fill='rgb(120,190,240)' fill-opacity='0.30' filter='url(%23b)'/%3E%3Ccircle cx='560' cy='848' r='24' fill='rgb(255,160,90)' fill-opacity='0.13' filter='url(%23b)'/%3E%3Ccircle cx='432' cy='652' r='36' fill='rgb(120,190,240)' fill-opacity='0.35' filter='url(%23b)'/%3E%3Ccircle cx='357' cy='448' r='29' fill='rgb(255,160,90)' fill-opacity='0.29' filter='url(%23b)'/%3E%3Ccircle cx='890' cy='510' r='15' fill='rgb(255,160,90)' fill-opacity='0.34' filter='url(%23b)'/%3E%3Ccircle cx='714' cy='558' r='41' fill='rgb(255,235,190)' fill-opacity='0.16' filter='url(%23b)'/%3E%3Ccircle cx='983' cy='773' r='14' fill='rgb(255,235,190)' fill-opacity='0.34' filter='url(%23b)'/%3E%3Ccircle cx='1183' cy='651' r='26' fill='rgb(255,210,150)' fill-opacity='0.31' filter='url(%23b)'/%3E%3Ccircle cx='889' cy='653' r='38' fill='rgb(255,190,110)' fill-opacity='0.13' filter='url(%23b)'/%3E%3Ccircle cx='237' cy='844' r='35' fill='rgb(120,190,240)' fill-opacity='0.18' filter='url(%23b)'/%3E%3Ccircle cx='1504' cy='436' r='30' fill='rgb(255,120,120)' fill-opacity='0.15' filter='url(%23b)'/%3E%3Ccircle cx='1404' cy='841' r='38' fill='rgb(190,240,230)' fill-opacity='0.19' filter='url(%23b)'/%3E%3Ccircle cx='548' cy='411' r='43' fill='rgb(190,240,230)' fill-opacity='0.33' filter='url(%23b)'/%3E%3Ccircle cx='338' cy='713' r='18' fill='rgb(120,190,240)' fill-opacity='0.30' filter='url(%23b)'/%3E%3Ccircle cx='1509' cy='593' r='21' fill='rgb(255,120,120)' fill-opacity='0.29' filter='url(%23b)'/%3E%3Ccircle cx='861' cy='656' r='29' fill='rgb(255,210,150)' fill-opacity='0.18' filter='url(%23b)'/%3E%3Ccircle cx='1570' cy='504' r='14' fill='rgb(120,190,240)' fill-opacity='0.21' filter='url(%23b)'/%3E%3Ccircle cx='48' cy='610' r='25' fill='rgb(190,240,230)' fill-opacity='0.20' filter='url(%23b)'/%3E%3C/svg%3E\") center / cover no-repeat;\nopacity: 0.75;\ntransition: opacity 2s ease;\nanimation: aur-rn-glow 9s steps(54) infinite alternate;\n}\n.aur-root[data-fx=\"rain\"][data-gap=\"on\"] .aur-fx-a { opacity: 0.95; }\n.aur-root[data-fx=\"rain\"][data-bganim=\"on\"][data-lb=\"a\"] .aur-fx-a { animation: aur-rn-glow 9s steps(54) infinite alternate, aur-fx-flash-a 1.6s ease-out; }\n.aur-root[data-fx=\"rain\"][data-bganim=\"on\"][data-lb=\"b\"] .aur-fx-a { animation: aur-rn-glow 9s steps(54) infinite alternate, aur-fx-flash-b 1.6s ease-out; }\n@keyframes aur-rn-glow { from { opacity: 0.6; } to { opacity: 0.9; } }\n.aur-root[data-fx=\"rain\"] .aur-fx-a::before,\n.aur-root[data-fx=\"rain\"] .aur-fx-a::after {\ncontent: \"\";\nposition: absolute;\nleft: 0;\nright: 0;\ntop: 64%;\nheight: 30%;\n}\n.aur-root[data-fx=\"rain\"] .aur-fx-a::before { background: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 300' preserveAspectRatio='none'%3E%3Cdefs%3E%3Cfilter id='b' x='-100%25' y='-100%25' width='300%25' height='300%25'%3E%3CfeGaussianBlur stdDeviation='6'/%3E%3C/filter%3E%3Cfilter id='c' x='-100%25' y='-100%25' width='300%25' height='300%25'%3E%3CfeGaussianBlur stdDeviation='2'/%3E%3C/filter%3E%3C/defs%3E%3Ccircle cx='982' cy='189' r='17' fill='rgb(255,236,190)' fill-opacity='.55' filter='url(%23b)'/%3E%3Ccircle cx='982' cy='189' r='6' fill='%23fff' fill-opacity='.5' filter='url(%23c)'/%3E%3Ccircle cx='1037' cy='189' r='17' fill='rgb(255,236,190)' fill-opacity='.55' filter='url(%23b)'/%3E%3Ccircle cx='1037' cy='189' r='6' fill='%23fff' fill-opacity='.5' filter='url(%23c)'/%3E%3Ccircle cx='1155' cy='218' r='13' fill='rgb(255,236,190)' fill-opacity='.55' filter='url(%23b)'/%3E%3Ccircle cx='1155' cy='218' r='4' fill='%23fff' fill-opacity='.5' filter='url(%23c)'/%3E%3Ccircle cx='1190' cy='218' r='13' fill='rgb(255,236,190)' fill-opacity='.55' filter='url(%23b)'/%3E%3Ccircle cx='1190' cy='218' r='4' fill='%23fff' fill-opacity='.5' filter='url(%23c)'/%3E%3Ccircle cx='1456' cy='174' r='10' fill='rgb(255,236,190)' fill-opacity='.55' filter='url(%23b)'/%3E%3Ccircle cx='1456' cy='174' r='3' fill='%23fff' fill-opacity='.5' filter='url(%23c)'/%3E%3Ccircle cx='1514' cy='174' r='10' fill='rgb(255,236,190)' fill-opacity='.55' filter='url(%23b)'/%3E%3Ccircle cx='1514' cy='174' r='3' fill='%23fff' fill-opacity='.5' filter='url(%23c)'/%3E%3Ccircle cx='754' cy='109' r='14' fill='rgb(255,236,190)' fill-opacity='.55' filter='url(%23b)'/%3E%3Ccircle cx='754' cy='109' r='5' fill='%23fff' fill-opacity='.5' filter='url(%23c)'/%3E%3Ccircle cx='802' cy='109' r='14' fill='rgb(255,236,190)' fill-opacity='.55' filter='url(%23b)'/%3E%3Ccircle cx='802' cy='109' r='5' fill='%23fff' fill-opacity='.5' filter='url(%23c)'/%3E%3C/svg%3E\") 0 0 / 100% 100% no-repeat; animation: aur-rn-cars-r 52s steps(780) infinite linear; }\n.aur-root[data-fx=\"rain\"] .aur-fx-a::after { background: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 300' preserveAspectRatio='none'%3E%3Cdefs%3E%3Cfilter id='b' x='-100%25' y='-100%25' width='300%25' height='300%25'%3E%3CfeGaussianBlur stdDeviation='6'/%3E%3C/filter%3E%3Cfilter id='c' x='-100%25' y='-100%25' width='300%25' height='300%25'%3E%3CfeGaussianBlur stdDeviation='2'/%3E%3C/filter%3E%3C/defs%3E%3Ccircle cx='396' cy='224' r='15' fill='rgb(255,70,60)' fill-opacity='.55' filter='url(%23b)'/%3E%3Ccircle cx='396' cy='224' r='5' fill='%23fff' fill-opacity='.5' filter='url(%23c)'/%3E%3Ccircle cx='433' cy='224' r='15' fill='rgb(255,70,60)' fill-opacity='.55' filter='url(%23b)'/%3E%3Ccircle cx='433' cy='224' r='5' fill='%23fff' fill-opacity='.5' filter='url(%23c)'/%3E%3Ccircle cx='186' cy='110' r='11' fill='rgb(255,70,60)' fill-opacity='.55' filter='url(%23b)'/%3E%3Ccircle cx='186' cy='110' r='4' fill='%23fff' fill-opacity='.5' filter='url(%23c)'/%3E%3Ccircle cx='246' cy='110' r='11' fill='rgb(255,70,60)' fill-opacity='.55' filter='url(%23b)'/%3E%3Ccircle cx='246' cy='110' r='4' fill='%23fff' fill-opacity='.5' filter='url(%23c)'/%3E%3Ccircle cx='1010' cy='143' r='13' fill='rgb(255,70,60)' fill-opacity='.55' filter='url(%23b)'/%3E%3Ccircle cx='1010' cy='143' r='5' fill='%23fff' fill-opacity='.5' filter='url(%23c)'/%3E%3Ccircle cx='1056' cy='143' r='13' fill='rgb(255,70,60)' fill-opacity='.55' filter='url(%23b)'/%3E%3Ccircle cx='1056' cy='143' r='5' fill='%23fff' fill-opacity='.5' filter='url(%23c)'/%3E%3Ccircle cx='345' cy='203' r='11' fill='rgb(255,70,60)' fill-opacity='.55' filter='url(%23b)'/%3E%3Ccircle cx='345' cy='203' r='4' fill='%23fff' fill-opacity='.5' filter='url(%23c)'/%3E%3Ccircle cx='381' cy='203' r='11' fill='rgb(255,70,60)' fill-opacity='.55' filter='url(%23b)'/%3E%3Ccircle cx='381' cy='203' r='4' fill='%23fff' fill-opacity='.5' filter='url(%23c)'/%3E%3C/svg%3E\") 0 0 / 100% 100% no-repeat; animation: aur-rn-cars-l 71s steps(1065) infinite linear; }\n@keyframes aur-rn-cars-r { from { transform: translateX(-100%); } to { transform: translateX(100%); } }\n@keyframes aur-rn-cars-l { from { transform: translateX(100%); } to { transform: translateX(-100%); } }\n.aur-root[data-fx=\"rain\"] .aur-fx-b {\ndisplay: block;\nleft: 0;\nright: 0;\ntop: -730px;\nheight: calc(100% + 730px);\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 730 730' preserveAspectRatio='xMinYMin slice'%3E%3Cg stroke='%23bcd4f2' stroke-linecap='round' fill='none'%3E%3Cpath d='M501 573l-9.2 66' stroke-width='1.1' stroke-opacity='0.13'/%3E%3Cpath d='M501 -157l-9.2 66' stroke-width='1.1' stroke-opacity='0.13'/%3E%3Cpath d='M501 1303l-9.2 66' stroke-width='1.1' stroke-opacity='0.13'/%3E%3Cpath d='M748 211l-6.6 47' stroke-width='1.1' stroke-opacity='0.11'/%3E%3Cpath d='M748 -519l-6.6 47' stroke-width='1.1' stroke-opacity='0.11'/%3E%3Cpath d='M748 941l-6.6 47' stroke-width='1.1' stroke-opacity='0.11'/%3E%3Cpath d='M232 196l-6.4 45' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M232 -534l-6.4 45' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M232 926l-6.4 45' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M418 147l-6.1 44' stroke-width='1.0' stroke-opacity='0.15'/%3E%3Cpath d='M418 -583l-6.1 44' stroke-width='1.0' stroke-opacity='0.15'/%3E%3Cpath d='M418 877l-6.1 44' stroke-width='1.0' stroke-opacity='0.15'/%3E%3Cpath d='M279 535l-11.2 80' stroke-width='1.1' stroke-opacity='0.09'/%3E%3Cpath d='M279 -195l-11.2 80' stroke-width='1.1' stroke-opacity='0.09'/%3E%3Cpath d='M279 1265l-11.2 80' stroke-width='1.1' stroke-opacity='0.09'/%3E%3Cpath d='M541 552l-8.4 60' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M541 -178l-8.4 60' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M541 1282l-8.4 60' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M684 609l-11.1 80' stroke-width='1.2' stroke-opacity='0.11'/%3E%3Cpath d='M684 -121l-11.1 80' stroke-width='1.2' stroke-opacity='0.11'/%3E%3Cpath d='M684 1339l-11.1 80' stroke-width='1.2' stroke-opacity='0.11'/%3E%3Cpath d='M400 534l-11.2 80' stroke-width='1.1' stroke-opacity='0.10'/%3E%3Cpath d='M400 -196l-11.2 80' stroke-width='1.1' stroke-opacity='0.10'/%3E%3Cpath d='M400 1264l-11.2 80' stroke-width='1.1' stroke-opacity='0.10'/%3E%3Cpath d='M462 76l-10.5 75' stroke-width='1.0' stroke-opacity='0.13'/%3E%3Cpath d='M462 -654l-10.5 75' stroke-width='1.0' stroke-opacity='0.13'/%3E%3Cpath d='M462 806l-10.5 75' stroke-width='1.0' stroke-opacity='0.13'/%3E%3Cpath d='M349 87l-9.0 64' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M349 -643l-9.0 64' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M349 817l-9.0 64' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M670 632l-11.8 85' stroke-width='1.0' stroke-opacity='0.08'/%3E%3Cpath d='M670 -98l-11.8 85' stroke-width='1.0' stroke-opacity='0.08'/%3E%3Cpath d='M670 1362l-11.8 85' stroke-width='1.0' stroke-opacity='0.08'/%3E%3Cpath d='M270 83l-10.5 75' stroke-width='1.1' stroke-opacity='0.10'/%3E%3Cpath d='M270 -647l-10.5 75' stroke-width='1.1' stroke-opacity='0.10'/%3E%3Cpath d='M270 813l-10.5 75' stroke-width='1.1' stroke-opacity='0.10'/%3E%3Cpath d='M198 294l-10.7 77' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M198 -436l-10.7 77' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M198 1024l-10.7 77' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M502 33l-7.1 50' stroke-width='1.1' stroke-opacity='0.17'/%3E%3Cpath d='M502 -697l-7.1 50' stroke-width='1.1' stroke-opacity='0.17'/%3E%3Cpath d='M502 763l-7.1 50' stroke-width='1.1' stroke-opacity='0.17'/%3E%3Cpath d='M58 49l-9.1 65' stroke-width='1.1' stroke-opacity='0.08'/%3E%3Cpath d='M58 -681l-9.1 65' stroke-width='1.1' stroke-opacity='0.08'/%3E%3Cpath d='M58 779l-9.1 65' stroke-width='1.1' stroke-opacity='0.08'/%3E%3Cpath d='M316 201l-6.2 44' stroke-width='1.0' stroke-opacity='0.11'/%3E%3Cpath d='M316 -529l-6.2 44' stroke-width='1.0' stroke-opacity='0.11'/%3E%3Cpath d='M316 931l-6.2 44' stroke-width='1.0' stroke-opacity='0.11'/%3E%3Cpath d='M340 82l-9.9 71' stroke-width='1.2' stroke-opacity='0.16'/%3E%3Cpath d='M340 -648l-9.9 71' stroke-width='1.2' stroke-opacity='0.16'/%3E%3Cpath d='M340 812l-9.9 71' stroke-width='1.2' stroke-opacity='0.16'/%3E%3Cpath d='M32 473l-10.0 72' stroke-width='1.0' stroke-opacity='0.13'/%3E%3Cpath d='M32 -257l-10.0 72' stroke-width='1.0' stroke-opacity='0.13'/%3E%3Cpath d='M32 1203l-10.0 72' stroke-width='1.0' stroke-opacity='0.13'/%3E%3Cpath d='M482 694l-12.1 86' stroke-width='1.1' stroke-opacity='0.15'/%3E%3Cpath d='M482 -36l-12.1 86' stroke-width='1.1' stroke-opacity='0.15'/%3E%3Cpath d='M482 1424l-12.1 86' stroke-width='1.1' stroke-opacity='0.15'/%3E%3Cpath d='M718 154l-9.2 65' stroke-width='1.0' stroke-opacity='0.17'/%3E%3Cpath d='M718 -576l-9.2 65' stroke-width='1.0' stroke-opacity='0.17'/%3E%3Cpath d='M718 884l-9.2 65' stroke-width='1.0' stroke-opacity='0.17'/%3E%3Cpath d='M483 154l-7.0 50' stroke-width='1.1' stroke-opacity='0.17'/%3E%3Cpath d='M483 -576l-7.0 50' stroke-width='1.1' stroke-opacity='0.17'/%3E%3Cpath d='M483 884l-7.0 50' stroke-width='1.1' stroke-opacity='0.17'/%3E%3Cpath d='M85 236l-9.2 66' stroke-width='1.1' stroke-opacity='0.19'/%3E%3Cpath d='M85 -494l-9.2 66' stroke-width='1.1' stroke-opacity='0.19'/%3E%3Cpath d='M85 966l-9.2 66' stroke-width='1.1' stroke-opacity='0.19'/%3E%3Cpath d='M538 697l-10.1 72' stroke-width='1.1' stroke-opacity='0.11'/%3E%3Cpath d='M538 -33l-10.1 72' stroke-width='1.1' stroke-opacity='0.11'/%3E%3Cpath d='M538 1427l-10.1 72' stroke-width='1.1' stroke-opacity='0.11'/%3E%3Cpath d='M369 313l-8.9 64' stroke-width='1.0' stroke-opacity='0.18'/%3E%3Cpath d='M369 -417l-8.9 64' stroke-width='1.0' stroke-opacity='0.18'/%3E%3Cpath d='M369 1043l-8.9 64' stroke-width='1.0' stroke-opacity='0.18'/%3E%3Cpath d='M99 335l-12.1 87' stroke-width='1.1' stroke-opacity='0.18'/%3E%3Cpath d='M99 -395l-12.1 87' stroke-width='1.1' stroke-opacity='0.18'/%3E%3Cpath d='M99 1065l-12.1 87' stroke-width='1.1' stroke-opacity='0.18'/%3E%3Cpath d='M181 341l-8.3 59' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M181 -389l-8.3 59' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M181 1071l-8.3 59' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M323 614l-12.4 89' stroke-width='1.0' stroke-opacity='0.16'/%3E%3Cpath d='M323 -116l-12.4 89' stroke-width='1.0' stroke-opacity='0.16'/%3E%3Cpath d='M323 1344l-12.4 89' stroke-width='1.0' stroke-opacity='0.16'/%3E%3Cpath d='M387 302l-5.9 42' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M387 -428l-5.9 42' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M387 1032l-5.9 42' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M263 433l-8.2 58' stroke-width='1.1' stroke-opacity='0.11'/%3E%3Cpath d='M263 -297l-8.2 58' stroke-width='1.1' stroke-opacity='0.11'/%3E%3Cpath d='M263 1163l-8.2 58' stroke-width='1.1' stroke-opacity='0.11'/%3E%3Cpath d='M733 286l-12.4 89' stroke-width='1.0' stroke-opacity='0.16'/%3E%3Cpath d='M733 -444l-12.4 89' stroke-width='1.0' stroke-opacity='0.16'/%3E%3Cpath d='M733 1016l-12.4 89' stroke-width='1.0' stroke-opacity='0.16'/%3E%3Cpath d='M407 518l-9.2 66' stroke-width='1.2' stroke-opacity='0.15'/%3E%3Cpath d='M407 -212l-9.2 66' stroke-width='1.2' stroke-opacity='0.15'/%3E%3Cpath d='M407 1248l-9.2 66' stroke-width='1.2' stroke-opacity='0.15'/%3E%3Cpath d='M16 498l-9.9 71' stroke-width='1.0' stroke-opacity='0.17'/%3E%3Cpath d='M16 -232l-9.9 71' stroke-width='1.0' stroke-opacity='0.17'/%3E%3Cpath d='M16 1228l-9.9 71' stroke-width='1.0' stroke-opacity='0.17'/%3E%3Cpath d='M624 202l-6.6 47' stroke-width='1.1' stroke-opacity='0.15'/%3E%3Cpath d='M624 -528l-6.6 47' stroke-width='1.1' stroke-opacity='0.15'/%3E%3Cpath d='M624 932l-6.6 47' stroke-width='1.1' stroke-opacity='0.15'/%3E%3Cpath d='M322 53l-8.7 62' stroke-width='1.1' stroke-opacity='0.15'/%3E%3Cpath d='M322 -677l-8.7 62' stroke-width='1.1' stroke-opacity='0.15'/%3E%3Cpath d='M322 783l-8.7 62' stroke-width='1.1' stroke-opacity='0.15'/%3E%3Cpath d='M252 573l-10.3 74' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M252 -157l-10.3 74' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M252 1303l-10.3 74' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M693 161l-8.7 62' stroke-width='1.1' stroke-opacity='0.15'/%3E%3Cpath d='M693 -569l-8.7 62' stroke-width='1.1' stroke-opacity='0.15'/%3E%3Cpath d='M693 891l-8.7 62' stroke-width='1.1' stroke-opacity='0.15'/%3E%3Cpath d='M592 90l-6.9 50' stroke-width='1.0' stroke-opacity='0.10'/%3E%3Cpath d='M592 -640l-6.9 50' stroke-width='1.0' stroke-opacity='0.10'/%3E%3Cpath d='M592 820l-6.9 50' stroke-width='1.0' stroke-opacity='0.10'/%3E%3Cpath d='M381 357l-12.2 87' stroke-width='1.1' stroke-opacity='0.14'/%3E%3Cpath d='M381 -373l-12.2 87' stroke-width='1.1' stroke-opacity='0.14'/%3E%3Cpath d='M381 1087l-12.2 87' stroke-width='1.1' stroke-opacity='0.14'/%3E%3Cpath d='M0 165l-7.8 55' stroke-width='1.0' stroke-opacity='0.17'/%3E%3Cpath d='M0 -565l-7.8 55' stroke-width='1.0' stroke-opacity='0.17'/%3E%3Cpath d='M0 895l-7.8 55' stroke-width='1.0' stroke-opacity='0.17'/%3E%3Cpath d='M301 100l-9.3 67' stroke-width='1.0' stroke-opacity='0.10'/%3E%3Cpath d='M301 -630l-9.3 67' stroke-width='1.0' stroke-opacity='0.10'/%3E%3Cpath d='M301 830l-9.3 67' stroke-width='1.0' stroke-opacity='0.10'/%3E%3C/g%3E%3C/svg%3E\") 0 0 / 730px 730px repeat;\nopacity: 0.85;\ntransition: opacity 2s ease;\nanimation: aur-rn-fall-far 1.3s steps(39) infinite linear;\n}\n.aur-root[data-fx=\"rain\"] .aur-fx-c {\ndisplay: block;\nleft: 0;\nright: 0;\ntop: -1000px;\nheight: calc(100% + 1000px);\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1000 1000' preserveAspectRatio='xMinYMin slice'%3E%3Cg stroke='%23bcd4f2' stroke-linecap='round' fill='none'%3E%3Cpath d='M317 151l-17.1 122' stroke-width='1.1' stroke-opacity='0.23'/%3E%3Cpath d='M317 -849l-17.1 122' stroke-width='1.1' stroke-opacity='0.23'/%3E%3Cpath d='M317 1151l-17.1 122' stroke-width='1.1' stroke-opacity='0.23'/%3E%3Cpath d='M360 58l-15.5 111' stroke-width='1.0' stroke-opacity='0.21'/%3E%3Cpath d='M360 -942l-15.5 111' stroke-width='1.0' stroke-opacity='0.21'/%3E%3Cpath d='M360 1058l-15.5 111' stroke-width='1.0' stroke-opacity='0.21'/%3E%3Cpath d='M53 91l-14.6 104' stroke-width='1.7' stroke-opacity='0.15'/%3E%3Cpath d='M53 -909l-14.6 104' stroke-width='1.7' stroke-opacity='0.15'/%3E%3Cpath d='M53 1091l-14.6 104' stroke-width='1.7' stroke-opacity='0.15'/%3E%3Cpath d='M212 627l-20.4 146' stroke-width='1.5' stroke-opacity='0.20'/%3E%3Cpath d='M212 -373l-20.4 146' stroke-width='1.5' stroke-opacity='0.20'/%3E%3Cpath d='M212 1627l-20.4 146' stroke-width='1.5' stroke-opacity='0.20'/%3E%3Cpath d='M995 47l-19.4 139' stroke-width='1.3' stroke-opacity='0.16'/%3E%3Cpath d='M995 -953l-19.4 139' stroke-width='1.3' stroke-opacity='0.16'/%3E%3Cpath d='M995 1047l-19.4 139' stroke-width='1.3' stroke-opacity='0.16'/%3E%3Cpath d='M103 308l-18.9 135' stroke-width='1.2' stroke-opacity='0.24'/%3E%3Cpath d='M103 -692l-18.9 135' stroke-width='1.2' stroke-opacity='0.24'/%3E%3Cpath d='M103 1308l-18.9 135' stroke-width='1.2' stroke-opacity='0.24'/%3E%3Cpath d='M644 372l-15.9 114' stroke-width='1.1' stroke-opacity='0.14'/%3E%3Cpath d='M644 -628l-15.9 114' stroke-width='1.1' stroke-opacity='0.14'/%3E%3Cpath d='M644 1372l-15.9 114' stroke-width='1.1' stroke-opacity='0.14'/%3E%3Cpath d='M194 680l-14.6 104' stroke-width='1.3' stroke-opacity='0.24'/%3E%3Cpath d='M194 -320l-14.6 104' stroke-width='1.3' stroke-opacity='0.24'/%3E%3Cpath d='M194 1680l-14.6 104' stroke-width='1.3' stroke-opacity='0.24'/%3E%3Cpath d='M451 300l-18.7 134' stroke-width='1.6' stroke-opacity='0.17'/%3E%3Cpath d='M451 -700l-18.7 134' stroke-width='1.6' stroke-opacity='0.17'/%3E%3Cpath d='M451 1300l-18.7 134' stroke-width='1.6' stroke-opacity='0.17'/%3E%3Cpath d='M577 525l-19.6 140' stroke-width='1.7' stroke-opacity='0.18'/%3E%3Cpath d='M577 -475l-19.6 140' stroke-width='1.7' stroke-opacity='0.18'/%3E%3Cpath d='M577 1525l-19.6 140' stroke-width='1.7' stroke-opacity='0.18'/%3E%3Cpath d='M999 118l-14.5 103' stroke-width='1.7' stroke-opacity='0.16'/%3E%3Cpath d='M999 -882l-14.5 103' stroke-width='1.7' stroke-opacity='0.16'/%3E%3Cpath d='M999 1118l-14.5 103' stroke-width='1.7' stroke-opacity='0.16'/%3E%3Cpath d='M489 39l-17.3 123' stroke-width='1.7' stroke-opacity='0.24'/%3E%3Cpath d='M489 -961l-17.3 123' stroke-width='1.7' stroke-opacity='0.24'/%3E%3Cpath d='M489 1039l-17.3 123' stroke-width='1.7' stroke-opacity='0.24'/%3E%3Cpath d='M890 314l-17.6 126' stroke-width='1.5' stroke-opacity='0.24'/%3E%3Cpath d='M890 -686l-17.6 126' stroke-width='1.5' stroke-opacity='0.24'/%3E%3Cpath d='M890 1314l-17.6 126' stroke-width='1.5' stroke-opacity='0.24'/%3E%3Cpath d='M454 840l-20.4 146' stroke-width='1.4' stroke-opacity='0.26'/%3E%3Cpath d='M454 -160l-20.4 146' stroke-width='1.4' stroke-opacity='0.26'/%3E%3Cpath d='M454 1840l-20.4 146' stroke-width='1.4' stroke-opacity='0.26'/%3E%3Cpath d='M43 701l-17.0 122' stroke-width='1.9' stroke-opacity='0.29'/%3E%3Cpath d='M43 -299l-17.0 122' stroke-width='1.9' stroke-opacity='0.29'/%3E%3Cpath d='M43 1701l-17.0 122' stroke-width='1.9' stroke-opacity='0.29'/%3E%3Cpath d='M276 386l-17.3 123' stroke-width='1.0' stroke-opacity='0.22'/%3E%3Cpath d='M276 -614l-17.3 123' stroke-width='1.0' stroke-opacity='0.22'/%3E%3Cpath d='M276 1386l-17.3 123' stroke-width='1.0' stroke-opacity='0.22'/%3E%3Cpath d='M155 117l-10.5 75' stroke-width='1.7' stroke-opacity='0.15'/%3E%3Cpath d='M155 -883l-10.5 75' stroke-width='1.7' stroke-opacity='0.15'/%3E%3Cpath d='M155 1117l-10.5 75' stroke-width='1.7' stroke-opacity='0.15'/%3E%3Cpath d='M238 391l-19.6 140' stroke-width='1.1' stroke-opacity='0.21'/%3E%3Cpath d='M238 -609l-19.6 140' stroke-width='1.1' stroke-opacity='0.21'/%3E%3Cpath d='M238 1391l-19.6 140' stroke-width='1.1' stroke-opacity='0.21'/%3E%3Cpath d='M551 883l-19.0 136' stroke-width='1.8' stroke-opacity='0.18'/%3E%3Cpath d='M551 -117l-19.0 136' stroke-width='1.8' stroke-opacity='0.18'/%3E%3Cpath d='M551 1883l-19.0 136' stroke-width='1.8' stroke-opacity='0.18'/%3E%3Cpath d='M412 359l-19.7 141' stroke-width='1.9' stroke-opacity='0.16'/%3E%3Cpath d='M412 -641l-19.7 141' stroke-width='1.9' stroke-opacity='0.16'/%3E%3Cpath d='M412 1359l-19.7 141' stroke-width='1.9' stroke-opacity='0.16'/%3E%3Cpath d='M163 232l-12.4 89' stroke-width='1.4' stroke-opacity='0.24'/%3E%3Cpath d='M163 -768l-12.4 89' stroke-width='1.4' stroke-opacity='0.24'/%3E%3Cpath d='M163 1232l-12.4 89' stroke-width='1.4' stroke-opacity='0.24'/%3E%3Cpath d='M253 4l-14.5 104' stroke-width='1.3' stroke-opacity='0.24'/%3E%3Cpath d='M253 -996l-14.5 104' stroke-width='1.3' stroke-opacity='0.24'/%3E%3Cpath d='M253 1004l-14.5 104' stroke-width='1.3' stroke-opacity='0.24'/%3E%3C/g%3E%3C/svg%3E\") 0 0 / 1000px 1000px repeat;\ntransition: opacity 2s ease;\nanimation: aur-rn-fall 0.85s steps(26) infinite linear;\n}\n.aur-root[data-fx=\"rain\"][data-gap=\"on\"] :is(.aur-fx-b, .aur-fx-c) { opacity: 1; }\n@keyframes aur-rn-fall { to { transform: translateY(1000px); } }\n@keyframes aur-rn-fall-far { to { transform: translateY(730px); } }\n.aur-root[data-fx=\"rain\"] .aur-fx-d {\ndisplay: block;\ninset: 0;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 900' preserveAspectRatio='xMidYMid slice'%3E%3Cdefs%3E%3CradialGradient id='d' cx='.5' cy='.6' r='.55'%3E%3Cstop offset='0' stop-color='%23a9c8e8' stop-opacity='.16'/%3E%3Cstop offset='.7' stop-color='%23070c16' stop-opacity='.34'/%3E%3Cstop offset='.92' stop-color='%23dbeaff' stop-opacity='.32'/%3E%3Cstop offset='1' stop-color='%23eef5ff' stop-opacity='.7'/%3E%3C/radialGradient%3E%3CradialGradient id='s' cx='.5' cy='.5' r='.5'%3E%3Cstop offset='0' stop-color='%23fff' stop-opacity='.95'/%3E%3Cstop offset='1' stop-color='%23fff' stop-opacity='0'/%3E%3C/radialGradient%3E%3CradialGradient id='w' cx='.5' cy='.5' r='.5'%3E%3Cstop offset='0' stop-color='%23ffc46e' stop-opacity='.5'/%3E%3Cstop offset='1' stop-color='%23ffc46e' stop-opacity='0'/%3E%3C/radialGradient%3E%3CradialGradient id='k' cx='.5' cy='.5' r='.5'%3E%3Cstop offset='0' stop-color='%2378b6ff' stop-opacity='.42'/%3E%3Cstop offset='1' stop-color='%2378b6ff' stop-opacity='0'/%3E%3C/radialGradient%3E%3C/defs%3E%3Cg fill='url(%23d)'%3E%3Cellipse cx='20' cy='101' rx='4.9' ry='6.1'/%3E%3Cellipse cx='1571' cy='30' rx='3.4' ry='4.5'/%3E%3Cellipse cx='33' cy='846' rx='3.3' ry='3.5'/%3E%3Cellipse cx='936' cy='493' rx='8.2' ry='8.5'/%3E%3Cellipse cx='1389' cy='586' rx='5.3' ry='6.2'/%3E%3Cellipse cx='469' cy='515' rx='2.5' ry='3.1'/%3E%3Cellipse cx='490' cy='159' rx='4.5' ry='4.6'/%3E%3Cellipse cx='600' cy='861' rx='3.6' ry='3.8'/%3E%3Cellipse cx='534' cy='363' rx='1.7' ry='2.2'/%3E%3Cellipse cx='322' cy='146' rx='4.3' ry='5.5'/%3E%3Cellipse cx='784' cy='532' rx='10.6' ry='14.0'/%3E%3Cellipse cx='408' cy='689' rx='4.1' ry='4.7'/%3E%3Cellipse cx='211' cy='510' rx='8.4' ry='10.3'/%3E%3Cellipse cx='894' cy='462' rx='8.2' ry='9.1'/%3E%3Cellipse cx='522' cy='334' rx='8.8' ry='10.5'/%3E%3Cellipse cx='1365' cy='107' rx='8.8' ry='11.4'/%3E%3Cellipse cx='940' cy='827' rx='4.2' ry='4.6'/%3E%3Cellipse cx='1302' cy='327' rx='5.4' ry='6.0'/%3E%3Cellipse cx='1535' cy='101' rx='11.2' ry='12.9'/%3E%3Cellipse cx='1053' cy='376' rx='1.7' ry='1.9'/%3E%3Cellipse cx='436' cy='256' rx='3.4' ry='3.8'/%3E%3Cellipse cx='1012' cy='691' rx='7.1' ry='9.3'/%3E%3Cellipse cx='831' cy='773' rx='3.9' ry='4.9'/%3E%3Cellipse cx='913' cy='863' rx='6.1' ry='8.0'/%3E%3Cellipse cx='99' cy='223' rx='4.7' ry='5.9'/%3E%3Cellipse cx='361' cy='775' rx='6.5' ry='7.5'/%3E%3Cellipse cx='1097' cy='811' rx='3.1' ry='3.6'/%3E%3Cellipse cx='574' cy='843' rx='5.6' ry='7.2'/%3E%3Cellipse cx='1342' cy='35' rx='6.0' ry='6.9'/%3E%3Cellipse cx='1256' cy='408' rx='4.6' ry='5.6'/%3E%3Cellipse cx='440' cy='307' rx='10.6' ry='11.9'/%3E%3Cellipse cx='362' cy='234' rx='7.8' ry='8.5'/%3E%3Cellipse cx='691' cy='70' rx='6.7' ry='7.1'/%3E%3Cellipse cx='249' cy='230' rx='5.5' ry='5.9'/%3E%3Cellipse cx='977' cy='766' rx='7.0' ry='7.4'/%3E%3Cellipse cx='622' cy='397' rx='4.7' ry='5.0'/%3E%3Cellipse cx='759' cy='481' rx='5.6' ry='6.0'/%3E%3Cellipse cx='1092' cy='526' rx='3.0' ry='3.6'/%3E%3Cellipse cx='1061' cy='169' rx='11.2' ry='13.5'/%3E%3Cellipse cx='1372' cy='708' rx='5.7' ry='5.9'/%3E%3Cellipse cx='82' cy='883' rx='2.6' ry='3.4'/%3E%3Cellipse cx='640' cy='88' rx='5.5' ry='5.7'/%3E%3Cellipse cx='1559' cy='776' rx='8.5' ry='11.0'/%3E%3Cellipse cx='661' cy='646' rx='3.2' ry='4.1'/%3E%3Cellipse cx='909' cy='134' rx='4.8' ry='5.6'/%3E%3Cellipse cx='257' cy='421' rx='7.2' ry='9.5'/%3E%3Cellipse cx='1146' cy='338' rx='7.3' ry='8.6'/%3E%3Cellipse cx='949' cy='746' rx='12.7' ry='14.8'/%3E%3Cellipse cx='885' cy='1' rx='12.2' ry='13.4'/%3E%3Cellipse cx='254' cy='542' rx='8.8' ry='9.9'/%3E%3Cellipse cx='438' cy='888' rx='3.1' ry='3.6'/%3E%3Cellipse cx='1526' cy='421' rx='8.7' ry='9.8'/%3E%3Cellipse cx='460' cy='244' rx='3.1' ry='3.6'/%3E%3Cellipse cx='487' cy='396' rx='2.1' ry='2.1'/%3E%3Cellipse cx='905' cy='138' rx='4.5' ry='5.0'/%3E%3Cellipse cx='1579' cy='293' rx='3.9' ry='4.9'/%3E%3Cellipse cx='1414' cy='900' rx='2.5' ry='3.2'/%3E%3Cellipse cx='1115' cy='746' rx='3.4' ry='3.9'/%3E%3Cellipse cx='908' cy='787' rx='7.1' ry='8.3'/%3E%3Cellipse cx='467' cy='493' rx='4.3' ry='4.9'/%3E%3Cellipse cx='1304' cy='224' rx='5.1' ry='6.3'/%3E%3Cellipse cx='1314' cy='234' rx='8.1' ry='8.7'/%3E%3Cellipse cx='149' cy='566' rx='3.7' ry='4.8'/%3E%3Cellipse cx='1241' cy='216' rx='7.5' ry='9.3'/%3E%3Cellipse cx='954' cy='226' rx='4.3' ry='5.7'/%3E%3Cellipse cx='507' cy='468' rx='2.8' ry='3.4'/%3E%3Cellipse cx='629' cy='631' rx='8.8' ry='10.2'/%3E%3Cellipse cx='696' cy='289' rx='2.9' ry='3.2'/%3E%3Cellipse cx='134' cy='174' rx='9.0' ry='10.6'/%3E%3Cellipse cx='152' cy='583' rx='7.4' ry='8.1'/%3E%3Cellipse cx='26' cy='733' rx='5.1' ry='6.2'/%3E%3Cellipse cx='317' cy='257' rx='11.6' ry='13.9'/%3E%3Cellipse cx='1395' cy='462' rx='9.8' ry='12.4'/%3E%3Cellipse cx='817' cy='822' rx='5.1' ry='5.7'/%3E%3Cellipse cx='1085' cy='825' rx='4.2' ry='4.6'/%3E%3Cellipse cx='161' cy='858' rx='3.9' ry='4.7'/%3E%3Cellipse cx='1523' cy='243' rx='7.8' ry='10.0'/%3E%3Cellipse cx='553' cy='258' rx='8.0' ry='9.4'/%3E%3Cellipse cx='436' cy='60' rx='1.9' ry='2.2'/%3E%3Cellipse cx='90' cy='775' rx='2.0' ry='2.4'/%3E%3Cellipse cx='1422' cy='339' rx='7.9' ry='8.3'/%3E%3Cellipse cx='1560' cy='686' rx='10.7' ry='11.0'/%3E%3Cellipse cx='601' cy='242' rx='2.7' ry='3.2'/%3E%3Cellipse cx='1041' cy='67' rx='10.7' ry='11.9'/%3E%3Cellipse cx='1440' cy='874' rx='2.3' ry='2.9'/%3E%3Cellipse cx='1528' cy='355' rx='4.4' ry='4.8'/%3E%3Cellipse cx='1566' cy='398' rx='7.3' ry='9.2'/%3E%3Cellipse cx='291' cy='85' rx='6.4' ry='6.6'/%3E%3Cellipse cx='327' cy='351' rx='9.7' ry='12.2'/%3E%3Cellipse cx='783' cy='563' rx='3.2' ry='4.0'/%3E%3Cellipse cx='621' cy='66' rx='3.3' ry='3.6'/%3E%3Cellipse cx='14' cy='319' rx='10.1' ry='10.8'/%3E%3Cellipse cx='1456' cy='463' rx='11.0' ry='13.8'/%3E%3Cellipse cx='404' cy='646' rx='6.3' ry='8.1'/%3E%3Cellipse cx='1252' cy='822' rx='4.5' ry='5.6'/%3E%3Cellipse cx='1357' cy='242' rx='4.3' ry='4.9'/%3E%3Cellipse cx='519' cy='514' rx='10.6' ry='13.5'/%3E%3Cellipse cx='767' cy='859' rx='2.8' ry='3.0'/%3E%3Cellipse cx='337' cy='350' rx='6.3' ry='8.0'/%3E%3Cellipse cx='1513' cy='741' rx='2.1' ry='2.3'/%3E%3Cellipse cx='449' cy='486' rx='9.8' ry='11.5'/%3E%3Cellipse cx='493' cy='497' rx='5.0' ry='6.0'/%3E%3Cellipse cx='560' cy='703' rx='9.7' ry='12.8'/%3E%3Cellipse cx='188' cy='26' rx='2.9' ry='3.5'/%3E%3Cellipse cx='207' cy='332' rx='9.4' ry='10.1'/%3E%3Cellipse cx='1206' cy='459' rx='4.2' ry='4.7'/%3E%3Cellipse cx='793' cy='662' rx='7.5' ry='8.1'/%3E%3Cellipse cx='1357' cy='590' rx='2.8' ry='2.9'/%3E%3Cellipse cx='1503' cy='211' rx='8.4' ry='10.6'/%3E%3Cellipse cx='1237' cy='294' rx='4.3' ry='5.0'/%3E%3Cellipse cx='816' cy='136' rx='2.7' ry='3.0'/%3E%3Cellipse cx='56' cy='161' rx='8.0' ry='8.4'/%3E%3Cellipse cx='314' cy='856' rx='1.6' ry='2.1'/%3E%3Cellipse cx='1488' cy='515' rx='6.8' ry='8.3'/%3E%3Cellipse cx='1461' cy='153' rx='11.5' ry='14.1'/%3E%3Cellipse cx='506' cy='533' rx='11.4' ry='12.3'/%3E%3Cellipse cx='1058' cy='369' rx='2.3' ry='2.9'/%3E%3Cellipse cx='944' cy='41' rx='4.6' ry='5.3'/%3E%3Cellipse cx='408' cy='732' rx='3.9' ry='4.3'/%3E%3Cellipse cx='897' cy='256' rx='4.8' ry='5.7'/%3E%3Cellipse cx='683' cy='100' rx='2.7' ry='3.6'/%3E%3Cellipse cx='1149' cy='619' rx='2.3' ry='2.8'/%3E%3Cellipse cx='1003' cy='560' rx='4.9' ry='6.2'/%3E%3Cellipse cx='1023' cy='178' rx='2.6' ry='3.4'/%3E%3Cellipse cx='1381' cy='629' rx='12.1' ry='13.8'/%3E%3Cellipse cx='540' cy='245' rx='3.8' ry='3.9'/%3E%3Cellipse cx='1045' cy='879' rx='3.7' ry='4.3'/%3E%3Cellipse cx='1081' cy='747' rx='5.2' ry='6.0'/%3E%3Cellipse cx='1087' cy='139' rx='2.1' ry='2.3'/%3E%3Cellipse cx='1169' cy='166' rx='9.3' ry='10.0'/%3E%3Cellipse cx='749' cy='136' rx='2.9' ry='3.2'/%3E%3Cellipse cx='1113' cy='501' rx='4.6' ry='5.0'/%3E%3Cellipse cx='307' cy='582' rx='8.8' ry='10.6'/%3E%3Cellipse cx='300' cy='635' rx='2.9' ry='3.0'/%3E%3Cellipse cx='999' cy='140' rx='6.4' ry='7.2'/%3E%3Cellipse cx='954' cy='616' rx='2.4' ry='3.0'/%3E%3Cellipse cx='457' cy='355' rx='2.1' ry='2.2'/%3E%3Cellipse cx='763' cy='668' rx='5.1' ry='5.3'/%3E%3Cellipse cx='57' cy='62' rx='4.9' ry='6.1'/%3E%3Cellipse cx='95' cy='576' rx='8.5' ry='9.5'/%3E%3C/g%3E%3Cg fill='url(%23w)'%3E%3Cellipse cx='20' cy='103' rx='2.7' ry='3.0'/%3E%3Cellipse cx='1571' cy='31' rx='1.9' ry='2.2'/%3E%3Cellipse cx='33' cy='847' rx='1.8' ry='1.8'/%3E%3Cellipse cx='1389' cy='588' rx='2.9' ry='3.1'/%3E%3Cellipse cx='600' cy='862' rx='2.0' ry='1.9'/%3E%3Cellipse cx='522' cy='338' rx='4.8' ry='5.2'/%3E%3Cellipse cx='1365' cy='110' rx='4.9' ry='5.7'/%3E%3Cellipse cx='940' cy='829' rx='2.3' ry='2.3'/%3E%3Cellipse cx='1302' cy='329' rx='3.0' ry='3.0'/%3E%3Cellipse cx='436' cy='257' rx='1.9' ry='1.9'/%3E%3Cellipse cx='831' cy='774' rx='2.2' ry='2.4'/%3E%3Cellipse cx='361' cy='778' rx='3.6' ry='3.8'/%3E%3Cellipse cx='1256' cy='410' rx='2.5' ry='2.8'/%3E%3Cellipse cx='440' cy='310' rx='5.8' ry='5.9'/%3E%3Cellipse cx='691' cy='73' rx='3.7' ry='3.6'/%3E%3Cellipse cx='977' cy='768' rx='3.8' ry='3.7'/%3E%3Cellipse cx='759' cy='482' rx='3.1' ry='3.0'/%3E%3Cellipse cx='1061' cy='173' rx='6.2' ry='6.7'/%3E%3Cellipse cx='1372' cy='710' rx='3.1' ry='2.9'/%3E%3Cellipse cx='640' cy='90' rx='3.0' ry='2.9'/%3E%3Cellipse cx='1559' cy='779' rx='4.7' ry='5.5'/%3E%3Cellipse cx='909' cy='135' rx='2.6' ry='2.8'/%3E%3Cellipse cx='257' cy='424' rx='4.0' ry='4.7'/%3E%3Cellipse cx='1146' cy='340' rx='4.0' ry='4.3'/%3E%3Cellipse cx='949' cy='750' rx='7.0' ry='7.4'/%3E%3Cellipse cx='885' cy='5' rx='6.7' ry='6.7'/%3E%3Cellipse cx='254' cy='545' rx='4.8' ry='4.9'/%3E%3Cellipse cx='1526' cy='424' rx='4.8' ry='4.9'/%3E%3Cellipse cx='1115' cy='747' rx='1.9' ry='2.0'/%3E%3Cellipse cx='908' cy='790' rx='3.9' ry='4.2'/%3E%3Cellipse cx='1304' cy='226' rx='2.8' ry='3.2'/%3E%3Cellipse cx='1314' cy='236' rx='4.4' ry='4.4'/%3E%3Cellipse cx='1241' cy='218' rx='4.1' ry='4.6'/%3E%3Cellipse cx='152' cy='585' rx='4.1' ry='4.1'/%3E%3Cellipse cx='26' cy='735' rx='2.8' ry='3.1'/%3E%3Cellipse cx='317' cy='261' rx='6.4' ry='7.0'/%3E%3Cellipse cx='1085' cy='826' rx='2.3' ry='2.3'/%3E%3Cellipse cx='1523' cy='246' rx='4.3' ry='5.0'/%3E%3Cellipse cx='553' cy='261' rx='4.4' ry='4.7'/%3E%3Cellipse cx='1422' cy='342' rx='4.3' ry='4.2'/%3E%3Cellipse cx='1528' cy='356' rx='2.4' ry='2.4'/%3E%3Cellipse cx='291' cy='87' rx='3.5' ry='3.3'/%3E%3Cellipse cx='327' cy='355' rx='5.3' ry='6.1'/%3E%3Cellipse cx='621' cy='67' rx='1.8' ry='1.8'/%3E%3Cellipse cx='14' cy='322' rx='5.6' ry='5.4'/%3E%3Cellipse cx='404' cy='649' rx='3.5' ry='4.0'/%3E%3Cellipse cx='1357' cy='243' rx='2.4' ry='2.4'/%3E%3Cellipse cx='519' cy='518' rx='5.8' ry='6.7'/%3E%3Cellipse cx='337' cy='352' rx='3.5' ry='4.0'/%3E%3Cellipse cx='493' cy='499' rx='2.8' ry='3.0'/%3E%3Cellipse cx='560' cy='707' rx='5.3' ry='6.4'/%3E%3Cellipse cx='793' cy='664' rx='4.1' ry='4.0'/%3E%3Cellipse cx='1237' cy='295' rx='2.4' ry='2.5'/%3E%3Cellipse cx='56' cy='164' rx='4.4' ry='4.2'/%3E%3Cellipse cx='1488' cy='518' rx='3.8' ry='4.1'/%3E%3Cellipse cx='1461' cy='157' rx='6.3' ry='7.1'/%3E%3Cellipse cx='944' cy='43' rx='2.5' ry='2.7'/%3E%3Cellipse cx='408' cy='733' rx='2.2' ry='2.1'/%3E%3Cellipse cx='897' cy='258' rx='2.7' ry='2.9'/%3E%3Cellipse cx='540' cy='246' rx='2.1' ry='2.0'/%3E%3Cellipse cx='999' cy='143' rx='3.5' ry='3.6'/%3E%3Cellipse cx='763' cy='669' rx='2.8' ry='2.6'/%3E%3Cellipse cx='57' cy='64' rx='2.7' ry='3.0'/%3E%3C/g%3E%3Cg fill='url(%23k)'%3E%3Cellipse cx='936' cy='495' rx='4.5' ry='4.2'/%3E%3Cellipse cx='490' cy='160' rx='2.5' ry='2.3'/%3E%3Cellipse cx='322' cy='148' rx='2.4' ry='2.7'/%3E%3Cellipse cx='784' cy='536' rx='5.9' ry='7.0'/%3E%3Cellipse cx='408' cy='690' rx='2.2' ry='2.3'/%3E%3Cellipse cx='211' cy='514' rx='4.6' ry='5.2'/%3E%3Cellipse cx='894' cy='465' rx='4.5' ry='4.5'/%3E%3Cellipse cx='1535' cy='105' rx='6.1' ry='6.4'/%3E%3Cellipse cx='1012' cy='694' rx='3.9' ry='4.6'/%3E%3Cellipse cx='913' cy='866' rx='3.3' ry='4.0'/%3E%3Cellipse cx='99' cy='225' rx='2.6' ry='3.0'/%3E%3Cellipse cx='574' cy='845' rx='3.1' ry='3.6'/%3E%3Cellipse cx='1342' cy='37' rx='3.3' ry='3.4'/%3E%3Cellipse cx='362' cy='237' rx='4.3' ry='4.3'/%3E%3Cellipse cx='249' cy='232' rx='3.0' ry='2.9'/%3E%3Cellipse cx='622' cy='399' rx='2.6' ry='2.5'/%3E%3Cellipse cx='905' cy='140' rx='2.5' ry='2.5'/%3E%3Cellipse cx='1579' cy='295' rx='2.1' ry='2.5'/%3E%3Cellipse cx='467' cy='495' rx='2.4' ry='2.4'/%3E%3Cellipse cx='149' cy='567' rx='2.0' ry='2.4'/%3E%3Cellipse cx='954' cy='228' rx='2.4' ry='2.8'/%3E%3Cellipse cx='629' cy='634' rx='4.9' ry='5.1'/%3E%3Cellipse cx='134' cy='177' rx='4.9' ry='5.3'/%3E%3Cellipse cx='1395' cy='466' rx='5.4' ry='6.2'/%3E%3Cellipse cx='817' cy='824' rx='2.8' ry='2.8'/%3E%3Cellipse cx='161' cy='859' rx='2.1' ry='2.4'/%3E%3Cellipse cx='1560' cy='689' rx='5.9' ry='5.5'/%3E%3Cellipse cx='1041' cy='70' rx='5.9' ry='5.9'/%3E%3Cellipse cx='1566' cy='400' rx='4.0' ry='4.6'/%3E%3Cellipse cx='1456' cy='467' rx='6.1' ry='6.9'/%3E%3Cellipse cx='1252' cy='824' rx='2.5' ry='2.8'/%3E%3Cellipse cx='449' cy='489' rx='5.4' ry='5.8'/%3E%3Cellipse cx='207' cy='335' rx='5.2' ry='5.0'/%3E%3Cellipse cx='1206' cy='460' rx='2.3' ry='2.4'/%3E%3Cellipse cx='1503' cy='215' rx='4.6' ry='5.3'/%3E%3Cellipse cx='506' cy='537' rx='6.3' ry='6.1'/%3E%3Cellipse cx='1003' cy='562' rx='2.7' ry='3.1'/%3E%3Cellipse cx='1381' cy='634' rx='6.6' ry='6.9'/%3E%3Cellipse cx='1045' cy='880' rx='2.0' ry='2.1'/%3E%3Cellipse cx='1081' cy='748' rx='2.9' ry='3.0'/%3E%3Cellipse cx='1169' cy='169' rx='5.1' ry='5.0'/%3E%3Cellipse cx='1113' cy='502' rx='2.5' ry='2.5'/%3E%3Cellipse cx='307' cy='585' rx='4.8' ry='5.3'/%3E%3Cellipse cx='95' cy='579' rx='4.7' ry='4.8'/%3E%3C/g%3E%3Cg fill='url(%23s)'%3E%3Cellipse cx='18.2' cy='98.5' rx='1.5' ry='1.1'/%3E%3Cellipse cx='1569.7' cy='27.8' rx='1.0' ry='0.8'/%3E%3Cellipse cx='31.6' cy='844.3' rx='1.0' ry='0.6'/%3E%3Cellipse cx='933.4' cy='488.9' rx='2.5' ry='1.5'/%3E%3Cellipse cx='1387.8' cy='583.3' rx='1.6' ry='1.1'/%3E%3Cellipse cx='468.7' cy='513.3' rx='0.7' ry='0.6'/%3E%3Cellipse cx='488.8' cy='156.7' rx='1.3' ry='0.8'/%3E%3Cellipse cx='598.5' cy='859.7' rx='1.1' ry='0.7'/%3E%3Cellipse cx='533.8' cy='361.7' rx='0.5' ry='0.4'/%3E%3Cellipse cx='320.5' cy='143.7' rx='1.3' ry='1.0'/%3E%3Cellipse cx='781.2' cy='525.5' rx='3.2' ry='2.5'/%3E%3Cellipse cx='406.4' cy='686.9' rx='1.2' ry='0.8'/%3E%3Cellipse cx='208.9' cy='505.9' rx='2.5' ry='1.9'/%3E%3Cellipse cx='891.2' cy='458.1' rx='2.5' ry='1.6'/%3E%3Cellipse cx='518.9' cy='329.8' rx='2.6' ry='1.9'/%3E%3Cellipse cx='1362.4' cy='101.9' rx='2.7' ry='2.0'/%3E%3Cellipse cx='938.4' cy='825.4' rx='1.3' ry='0.8'/%3E%3Cellipse cx='1300.6' cy='324.9' rx='1.6' ry='1.1'/%3E%3Cellipse cx='1531.7' cy='95.4' rx='3.3' ry='2.3'/%3E%3Cellipse cx='1052.7' cy='375.2' rx='0.5' ry='0.3'/%3E%3Cellipse cx='434.9' cy='254.2' rx='1.0' ry='0.7'/%3E%3Cellipse cx='1010.1' cy='687.4' rx='2.1' ry='1.7'/%3E%3Cellipse cx='829.7' cy='770.4' rx='1.2' ry='0.9'/%3E%3Cellipse cx='911.1' cy='859.7' rx='1.8' ry='1.4'/%3E%3Cellipse cx='97.3' cy='220.9' rx='1.4' ry='1.1'/%3E%3Cellipse cx='358.7' cy='772.0' rx='1.9' ry='1.4'/%3E%3Cellipse cx='1096.1' cy='809.1' rx='0.9' ry='0.6'/%3E%3Cellipse cx='572.7' cy='839.6' rx='1.7' ry='1.3'/%3E%3Cellipse cx='1340.4' cy='31.9' rx='1.8' ry='1.2'/%3E%3Cellipse cx='1254.2' cy='405.8' rx='1.4' ry='1.0'/%3E%3Cellipse cx='436.7' cy='301.4' rx='3.2' ry='2.1'/%3E%3Cellipse cx='359.4' cy='230.2' rx='2.3' ry='1.5'/%3E%3Cellipse cx='689.4' cy='67.3' rx='2.0' ry='1.3'/%3E%3Cellipse cx='247.6' cy='227.5' rx='1.7' ry='1.1'/%3E%3Cellipse cx='974.7' cy='762.6' rx='2.1' ry='1.3'/%3E%3Cellipse cx='621.0' cy='395.1' rx='1.4' ry='0.9'/%3E%3Cellipse cx='757.7' cy='478.1' rx='1.7' ry='1.1'/%3E%3Cellipse cx='1090.8' cy='524.5' rx='0.9' ry='0.6'/%3E%3Cellipse cx='1057.7' cy='163.1' rx='3.4' ry='2.4'/%3E%3Cellipse cx='1370.6' cy='705.3' rx='1.7' ry='1.1'/%3E%3Cellipse cx='81.6' cy='881.1' rx='0.8' ry='0.6'/%3E%3Cellipse cx='638.5' cy='86.0' rx='1.6' ry='1.0'/%3E%3Cellipse cx='1556.6' cy='770.8' rx='2.5' ry='2.0'/%3E%3Cellipse cx='659.9' cy='644.3' rx='0.9' ry='0.7'/%3E%3Cellipse cx='907.1' cy='131.3' rx='1.4' ry='1.0'/%3E%3Cellipse cx='254.6' cy='416.8' rx='2.2' ry='1.7'/%3E%3Cellipse cx='1143.7' cy='333.8' rx='2.2' ry='1.5'/%3E%3Cellipse cx='945.6' cy='739.3' rx='3.8' ry='2.7'/%3E%3Cellipse cx='880.9' cy='-5.1' rx='3.7' ry='2.4'/%3E%3Cellipse cx='251.4' cy='538.1' rx='2.6' ry='1.8'/%3E%3Cellipse cx='437.5' cy='886.1' rx='0.9' ry='0.7'/%3E%3Cellipse cx='1523.1' cy='416.3' rx='2.6' ry='1.8'/%3E%3Cellipse cx='459.2' cy='242.9' rx='0.9' ry='0.7'/%3E%3Cellipse cx='486.5' cy='394.6' rx='0.6' ry='0.4'/%3E%3Cellipse cx='903.7' cy='135.9' rx='1.3' ry='0.9'/%3E%3Cellipse cx='1578.0' cy='291.2' rx='1.2' ry='0.9'/%3E%3Cellipse cx='1412.8' cy='898.5' rx='0.7' ry='0.6'/%3E%3Cellipse cx='1113.6' cy='744.2' rx='1.0' ry='0.7'/%3E%3Cellipse cx='906.0' cy='783.6' rx='2.1' ry='1.5'/%3E%3Cellipse cx='465.7' cy='490.9' rx='1.3' ry='0.9'/%3E%3Cellipse cx='1302.7' cy='221.5' rx='1.5' ry='1.1'/%3E%3Cellipse cx='1311.3' cy='229.9' rx='2.4' ry='1.6'/%3E%3Cellipse cx='147.9' cy='563.7' rx='1.1' ry='0.9'/%3E%3Cellipse cx='1238.9' cy='211.6' rx='2.3' ry='1.7'/%3E%3Cellipse cx='952.6' cy='223.3' rx='1.3' ry='1.0'/%3E%3Cellipse cx='506.5' cy='466.3' rx='0.8' ry='0.6'/%3E%3Cellipse cx='626.3' cy='626.7' rx='2.7' ry='1.8'/%3E%3Cellipse cx='695.4' cy='287.7' rx='0.9' ry='0.6'/%3E%3Cellipse cx='131.7' cy='169.2' rx='2.7' ry='1.9'/%3E%3Cellipse cx='150.1' cy='579.2' rx='2.2' ry='1.5'/%3E%3Cellipse cx='24.9' cy='730.1' rx='1.5' ry='1.1'/%3E%3Cellipse cx='313.8' cy='250.5' rx='3.5' ry='2.5'/%3E%3Cellipse cx='1391.6' cy='456.5' rx='2.9' ry='2.2'/%3E%3Cellipse cx='815.3' cy='819.8' rx='1.5' ry='1.0'/%3E%3Cellipse cx='1084.2' cy='823.0' rx='1.2' ry='0.8'/%3E%3Cellipse cx='160.2' cy='855.4' rx='1.2' ry='0.9'/%3E%3Cellipse cx='1520.8' cy='239.0' rx='2.3' ry='1.8'/%3E%3Cellipse cx='550.4' cy='253.5' rx='2.4' ry='1.7'/%3E%3Cellipse cx='435.3' cy='58.8' rx='0.6' ry='0.4'/%3E%3Cellipse cx='89.7' cy='773.9' rx='0.6' ry='0.4'/%3E%3Cellipse cx='1419.6' cy='335.6' rx='2.4' ry='1.5'/%3E%3Cellipse cx='1557.0' cy='681.3' rx='3.2' ry='2.0'/%3E%3Cellipse cx='600.2' cy='240.7' rx='0.8' ry='0.6'/%3E%3Cellipse cx='1038.0' cy='61.7' rx='3.2' ry='2.1'/%3E%3Cellipse cx='1439.8' cy='872.5' rx='0.7' ry='0.5'/%3E%3Cellipse cx='1526.6' cy='352.6' rx='1.3' ry='0.9'/%3E%3Cellipse cx='1563.9' cy='393.4' rx='2.2' ry='1.7'/%3E%3Cellipse cx='289.1' cy='82.3' rx='1.9' ry='1.2'/%3E%3Cellipse cx='324.5' cy='345.6' rx='2.9' ry='2.2'/%3E%3Cellipse cx='781.6' cy='561.2' rx='0.9' ry='0.7'/%3E%3Cellipse cx='619.8' cy='64.3' rx='1.0' ry='0.6'/%3E%3Cellipse cx='11.2' cy='314.4' rx='3.0' ry='2.0'/%3E%3Cellipse cx='1452.8' cy='457.2' rx='3.3' ry='2.5'/%3E%3Cellipse cx='402.5' cy='642.6' rx='1.9' ry='1.5'/%3E%3Cellipse cx='1250.6' cy='819.9' rx='1.3' ry='1.0'/%3E%3Cellipse cx='1355.6' cy='239.6' rx='1.3' ry='0.9'/%3E%3Cellipse cx='515.6' cy='507.7' rx='3.2' ry='2.4'/%3E%3Cellipse cx='766.5' cy='857.6' rx='0.8' ry='0.5'/%3E%3Cellipse cx='335.2' cy='346.4' rx='1.9' ry='1.4'/%3E%3Cellipse cx='1512.5' cy='739.6' rx='0.6' ry='0.4'/%3E%3Cellipse cx='445.8' cy='481.0' rx='2.9' ry='2.1'/%3E%3Cellipse cx='491.1' cy='494.3' rx='1.5' ry='1.1'/%3E%3Cellipse cx='557.4' cy='697.8' rx='2.9' ry='2.3'/%3E%3Cellipse cx='187.5' cy='24.8' rx='0.9' ry='0.6'/%3E%3Cellipse cx='204.7' cy='327.5' rx='2.8' ry='1.8'/%3E%3Cellipse cx='1204.6' cy='456.8' rx='1.3' ry='0.8'/%3E%3Cellipse cx='791.1' cy='658.4' rx='2.2' ry='1.5'/%3E%3Cellipse cx='1355.9' cy='588.5' rx='0.8' ry='0.5'/%3E%3Cellipse cx='1500.1' cy='206.8' rx='2.5' ry='1.9'/%3E%3Cellipse cx='1236.0' cy='291.6' rx='1.3' ry='0.9'/%3E%3Cellipse cx='814.9' cy='134.2' rx='0.8' ry='0.5'/%3E%3Cellipse cx='53.5' cy='157.6' rx='2.4' ry='1.5'/%3E%3Cellipse cx='313.0' cy='855.1' rx='0.5' ry='0.4'/%3E%3Cellipse cx='1486.2' cy='511.5' rx='2.1' ry='1.5'/%3E%3Cellipse cx='1457.8' cy='146.3' rx='3.4' ry='2.5'/%3E%3Cellipse cx='502.6' cy='527.8' rx='3.4' ry='2.2'/%3E%3Cellipse cx='1057.5' cy='367.2' rx='0.7' ry='0.5'/%3E%3Cellipse cx='942.3' cy='38.7' rx='1.4' ry='1.0'/%3E%3Cellipse cx='406.7' cy='729.9' rx='1.2' ry='0.8'/%3E%3Cellipse cx='895.0' cy='253.9' rx='1.5' ry='1.0'/%3E%3Cellipse cx='682.6' cy='98.1' rx='0.8' ry='0.6'/%3E%3Cellipse cx='1147.9' cy='617.5' rx='0.7' ry='0.5'/%3E%3Cellipse cx='1001.9' cy='557.6' rx='1.5' ry='1.1'/%3E%3Cellipse cx='1022.5' cy='176.3' rx='0.8' ry='0.6'/%3E%3Cellipse cx='1377.3' cy='623.4' rx='3.6' ry='2.5'/%3E%3Cellipse cx='538.4' cy='243.2' rx='1.1' ry='0.7'/%3E%3Cellipse cx='1043.9' cy='876.8' rx='1.1' ry='0.8'/%3E%3Cellipse cx='1079.5' cy='744.0' rx='1.6' ry='1.1'/%3E%3Cellipse cx='1086.6' cy='138.4' rx='0.6' ry='0.4'/%3E%3Cellipse cx='1165.9' cy='161.9' rx='2.8' ry='1.8'/%3E%3Cellipse cx='748.3' cy='134.4' rx='0.9' ry='0.6'/%3E%3Cellipse cx='1111.1' cy='498.7' rx='1.4' ry='0.9'/%3E%3Cellipse cx='304.8' cy='577.4' rx='2.6' ry='1.9'/%3E%3Cellipse cx='298.9' cy='633.9' rx='0.9' ry='0.5'/%3E%3Cellipse cx='997.2' cy='137.2' rx='1.9' ry='1.3'/%3E%3Cellipse cx='953.3' cy='614.9' rx='0.7' ry='0.5'/%3E%3Cellipse cx='456.1' cy='353.8' rx='0.6' ry='0.4'/%3E%3Cellipse cx='761.8' cy='665.5' rx='1.5' ry='0.9'/%3E%3Cellipse cx='55.7' cy='59.8' rx='1.5' ry='1.1'/%3E%3Cellipse cx='92.0' cy='572.2' rx='2.5' ry='1.7'/%3E%3C/g%3E%3C/svg%3E\") center / cover no-repeat;\nanimation: aur-rn-bead-a 34s steps(170) infinite alternate;\n}\n.aur-root[data-fx=\"rain\"] .aur-fx-d::before {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 900' preserveAspectRatio='xMidYMid slice'%3E%3Cdefs%3E%3CradialGradient id='d' cx='.5' cy='.6' r='.55'%3E%3Cstop offset='0' stop-color='%23a9c8e8' stop-opacity='.16'/%3E%3Cstop offset='.7' stop-color='%23070c16' stop-opacity='.34'/%3E%3Cstop offset='.92' stop-color='%23dbeaff' stop-opacity='.32'/%3E%3Cstop offset='1' stop-color='%23eef5ff' stop-opacity='.7'/%3E%3C/radialGradient%3E%3CradialGradient id='s' cx='.5' cy='.5' r='.5'%3E%3Cstop offset='0' stop-color='%23fff' stop-opacity='.95'/%3E%3Cstop offset='1' stop-color='%23fff' stop-opacity='0'/%3E%3C/radialGradient%3E%3CradialGradient id='w' cx='.5' cy='.5' r='.5'%3E%3Cstop offset='0' stop-color='%23ffc46e' stop-opacity='.5'/%3E%3Cstop offset='1' stop-color='%23ffc46e' stop-opacity='0'/%3E%3C/radialGradient%3E%3CradialGradient id='k' cx='.5' cy='.5' r='.5'%3E%3Cstop offset='0' stop-color='%2378b6ff' stop-opacity='.42'/%3E%3Cstop offset='1' stop-color='%2378b6ff' stop-opacity='0'/%3E%3C/radialGradient%3E%3C/defs%3E%3Cg fill='url(%23d)'%3E%3Cellipse cx='1091' cy='82' rx='8.2' ry='9.4'/%3E%3Cellipse cx='1572' cy='411' rx='5.7' ry='7.5'/%3E%3Cellipse cx='1341' cy='82' rx='5.8' ry='7.0'/%3E%3Cellipse cx='54' cy='474' rx='4.0' ry='4.2'/%3E%3Cellipse cx='38' cy='317' rx='5.5' ry='6.9'/%3E%3Cellipse cx='364' cy='584' rx='2.7' ry='3.0'/%3E%3Cellipse cx='988' cy='43' rx='2.4' ry='2.8'/%3E%3Cellipse cx='208' cy='316' rx='3.1' ry='3.9'/%3E%3Cellipse cx='462' cy='23' rx='5.6' ry='6.4'/%3E%3Cellipse cx='1465' cy='8' rx='11.5' ry='13.3'/%3E%3Cellipse cx='146' cy='279' rx='10.4' ry='11.7'/%3E%3Cellipse cx='1475' cy='37' rx='5.0' ry='6.0'/%3E%3Cellipse cx='927' cy='786' rx='5.1' ry='6.7'/%3E%3Cellipse cx='1376' cy='840' rx='4.3' ry='5.2'/%3E%3Cellipse cx='138' cy='585' rx='11.4' ry='13.7'/%3E%3Cellipse cx='1183' cy='157' rx='4.9' ry='6.4'/%3E%3Cellipse cx='271' cy='739' rx='3.0' ry='3.4'/%3E%3Cellipse cx='4' cy='666' rx='2.2' ry='2.9'/%3E%3Cellipse cx='364' cy='224' rx='2.8' ry='3.6'/%3E%3Cellipse cx='929' cy='414' rx='7.9' ry='9.2'/%3E%3Cellipse cx='1265' cy='102' rx='4.0' ry='4.3'/%3E%3Cellipse cx='216' cy='584' rx='4.5' ry='4.7'/%3E%3Cellipse cx='941' cy='650' rx='5.1' ry='6.5'/%3E%3Cellipse cx='1348' cy='535' rx='4.7' ry='5.2'/%3E%3Cellipse cx='574' cy='663' rx='12.7' ry='14.4'/%3E%3Cellipse cx='1359' cy='224' rx='4.1' ry='4.5'/%3E%3Cellipse cx='1155' cy='876' rx='3.1' ry='3.2'/%3E%3Cellipse cx='440' cy='745' rx='8.0' ry='8.3'/%3E%3Cellipse cx='1220' cy='650' rx='8.0' ry='9.3'/%3E%3Cellipse cx='1162' cy='735' rx='10.9' ry='12.5'/%3E%3Cellipse cx='575' cy='801' rx='11.6' ry='14.7'/%3E%3Cellipse cx='1148' cy='105' rx='2.7' ry='3.4'/%3E%3Cellipse cx='327' cy='505' rx='5.9' ry='6.9'/%3E%3Cellipse cx='719' cy='142' rx='4.6' ry='5.3'/%3E%3Cellipse cx='1530' cy='216' rx='1.7' ry='2.1'/%3E%3Cellipse cx='355' cy='258' rx='4.6' ry='5.4'/%3E%3Cellipse cx='1143' cy='70' rx='8.1' ry='10.2'/%3E%3Cellipse cx='1062' cy='233' rx='11.5' ry='13.3'/%3E%3Cellipse cx='1558' cy='406' rx='8.4' ry='9.0'/%3E%3Cellipse cx='19' cy='533' rx='5.6' ry='6.4'/%3E%3Cellipse cx='1337' cy='339' rx='5.6' ry='6.8'/%3E%3Cellipse cx='615' cy='76' rx='3.1' ry='3.4'/%3E%3Cellipse cx='1273' cy='509' rx='4.0' ry='5.0'/%3E%3Cellipse cx='386' cy='409' rx='6.0' ry='6.8'/%3E%3Cellipse cx='1017' cy='594' rx='4.6' ry='4.9'/%3E%3Cellipse cx='1029' cy='730' rx='3.3' ry='3.7'/%3E%3Cellipse cx='526' cy='579' rx='2.4' ry='3.1'/%3E%3Cellipse cx='1532' cy='197' rx='7.6' ry='7.8'/%3E%3Cellipse cx='313' cy='161' rx='4.4' ry='4.9'/%3E%3Cellipse cx='797' cy='634' rx='9.9' ry='11.9'/%3E%3Cellipse cx='1259' cy='350' rx='7.0' ry='9.0'/%3E%3Cellipse cx='1187' cy='451' rx='4.4' ry='5.1'/%3E%3Cellipse cx='647' cy='816' rx='9.3' ry='11.2'/%3E%3Cellipse cx='172' cy='321' rx='3.2' ry='3.3'/%3E%3Cellipse cx='950' cy='311' rx='3.2' ry='4.2'/%3E%3Cellipse cx='1583' cy='319' rx='6.1' ry='8.0'/%3E%3Cellipse cx='1123' cy='876' rx='4.8' ry='5.3'/%3E%3Cellipse cx='389' cy='778' rx='2.6' ry='2.8'/%3E%3Cellipse cx='1244' cy='376' rx='7.4' ry='9.5'/%3E%3Cellipse cx='49' cy='185' rx='7.4' ry='8.6'/%3E%3Cellipse cx='281' cy='638' rx='4.5' ry='5.4'/%3E%3Cellipse cx='246' cy='343' rx='1.7' ry='2.1'/%3E%3Cellipse cx='291' cy='220' rx='5.3' ry='6.9'/%3E%3Cellipse cx='1375' cy='672' rx='6.0' ry='6.5'/%3E%3Cellipse cx='890' cy='643' rx='12.9' ry='15.1'/%3E%3Cellipse cx='687' cy='309' rx='3.0' ry='3.4'/%3E%3Cellipse cx='1071' cy='238' rx='8.6' ry='9.8'/%3E%3Cellipse cx='280' cy='277' rx='9.4' ry='9.6'/%3E%3Cellipse cx='1107' cy='33' rx='6.2' ry='6.5'/%3E%3Cellipse cx='84' cy='147' rx='12.2' ry='13.6'/%3E%3Cellipse cx='575' cy='855' rx='2.3' ry='2.5'/%3E%3Cellipse cx='942' cy='845' rx='8.0' ry='10.2'/%3E%3Cellipse cx='145' cy='223' rx='7.1' ry='8.6'/%3E%3Cellipse cx='457' cy='395' rx='5.4' ry='6.6'/%3E%3Cellipse cx='946' cy='69' rx='5.7' ry='7.0'/%3E%3Cellipse cx='732' cy='74' rx='5.4' ry='6.6'/%3E%3Cellipse cx='1575' cy='874' rx='8.2' ry='10.6'/%3E%3Cellipse cx='556' cy='411' rx='1.9' ry='2.1'/%3E%3Cellipse cx='243' cy='607' rx='3.2' ry='3.4'/%3E%3Cellipse cx='1384' cy='179' rx='2.9' ry='3.6'/%3E%3Cellipse cx='1508' cy='30' rx='2.0' ry='2.4'/%3E%3Cellipse cx='309' cy='837' rx='7.9' ry='9.2'/%3E%3Cellipse cx='42' cy='882' rx='5.1' ry='6.6'/%3E%3Cellipse cx='1472' cy='709' rx='3.2' ry='3.5'/%3E%3Cellipse cx='1214' cy='605' rx='3.2' ry='3.6'/%3E%3Cellipse cx='289' cy='554' rx='11.9' ry='13.3'/%3E%3Cellipse cx='84' cy='851' rx='2.0' ry='2.5'/%3E%3Cellipse cx='861' cy='176' rx='2.0' ry='2.4'/%3E%3Cellipse cx='630' cy='472' rx='2.4' ry='2.8'/%3E%3Cellipse cx='1304' cy='235' rx='4.6' ry='4.8'/%3E%3Cellipse cx='1044' cy='126' rx='2.9' ry='3.5'/%3E%3Cellipse cx='899' cy='667' rx='10.2' ry='10.5'/%3E%3Cellipse cx='530' cy='759' rx='3.2' ry='3.7'/%3E%3Cellipse cx='1024' cy='349' rx='2.1' ry='2.5'/%3E%3Cellipse cx='1374' cy='538' rx='2.7' ry='3.2'/%3E%3Cellipse cx='1011' cy='558' rx='1.6' ry='1.7'/%3E%3Cellipse cx='1280' cy='473' rx='9.6' ry='12.0'/%3E%3Cellipse cx='1397' cy='734' rx='10.5' ry='12.2'/%3E%3Cellipse cx='480' cy='522' rx='8.1' ry='8.7'/%3E%3Cellipse cx='383' cy='580' rx='3.2' ry='3.8'/%3E%3Cellipse cx='1101' cy='49' rx='3.5' ry='4.4'/%3E%3Cellipse cx='423' cy='81' rx='1.9' ry='2.4'/%3E%3Cellipse cx='148' cy='103' rx='5.6' ry='6.3'/%3E%3Cellipse cx='1371' cy='666' rx='3.2' ry='4.0'/%3E%3Cellipse cx='743' cy='804' rx='2.0' ry='2.5'/%3E%3Cellipse cx='659' cy='633' rx='3.0' ry='3.4'/%3E%3Cellipse cx='670' cy='18' rx='7.4' ry='9.3'/%3E%3Cellipse cx='256' cy='679' rx='4.2' ry='5.2'/%3E%3Cellipse cx='744' cy='558' rx='2.8' ry='3.5'/%3E%3Cellipse cx='1229' cy='831' rx='8.2' ry='9.3'/%3E%3Cellipse cx='867' cy='675' rx='8.7' ry='10.4'/%3E%3Cellipse cx='1145' cy='360' rx='4.1' ry='4.3'/%3E%3Cellipse cx='854' cy='202' rx='6.7' ry='7.7'/%3E%3Cellipse cx='541' cy='863' rx='4.9' ry='5.7'/%3E%3Cellipse cx='834' cy='125' rx='8.5' ry='9.7'/%3E%3Cellipse cx='69' cy='702' rx='8.1' ry='8.5'/%3E%3Cellipse cx='528' cy='577' rx='7.2' ry='7.6'/%3E%3Cellipse cx='394' cy='700' rx='1.9' ry='2.2'/%3E%3Cellipse cx='583' cy='165' rx='10.7' ry='12.1'/%3E%3Cellipse cx='76' cy='131' rx='6.1' ry='6.9'/%3E%3Cellipse cx='1048' cy='373' rx='2.1' ry='2.6'/%3E%3Cellipse cx='1363' cy='68' rx='3.1' ry='3.3'/%3E%3Cellipse cx='1427' cy='854' rx='6.7' ry='8.4'/%3E%3Cellipse cx='324' cy='521' rx='5.4' ry='5.8'/%3E%3Cellipse cx='928' cy='483' rx='2.8' ry='3.0'/%3E%3Cellipse cx='470' cy='684' rx='4.7' ry='5.8'/%3E%3Cellipse cx='72' cy='894' rx='2.8' ry='3.4'/%3E%3Cellipse cx='1292' cy='856' rx='5.8' ry='6.2'/%3E%3Cellipse cx='1268' cy='379' rx='5.4' ry='6.9'/%3E%3Cellipse cx='243' cy='654' rx='1.7' ry='2.3'/%3E%3Cellipse cx='234' cy='863' rx='3.8' ry='4.4'/%3E%3Cellipse cx='1017' cy='41' rx='5.1' ry='5.2'/%3E%3Cellipse cx='1179' cy='261' rx='9.3' ry='10.0'/%3E%3Cellipse cx='1532' cy='91' rx='7.7' ry='8.2'/%3E%3Cellipse cx='970' cy='440' rx='5.4' ry='5.8'/%3E%3Cellipse cx='417' cy='451' rx='3.0' ry='3.1'/%3E%3Cellipse cx='1553' cy='129' rx='5.5' ry='6.9'/%3E%3Cellipse cx='311' cy='59' rx='11.8' ry='14.0'/%3E%3Cellipse cx='350' cy='339' rx='7.7' ry='8.2'/%3E%3Cellipse cx='78' cy='111' rx='7.2' ry='7.7'/%3E%3C/g%3E%3Cg fill='url(%23w)'%3E%3Cellipse cx='38' cy='319' rx='3.0' ry='3.4'/%3E%3Cellipse cx='462' cy='25' rx='3.1' ry='3.2'/%3E%3Cellipse cx='1465' cy='12' rx='6.3' ry='6.6'/%3E%3Cellipse cx='146' cy='283' rx='5.7' ry='5.8'/%3E%3Cellipse cx='138' cy='590' rx='6.3' ry='6.8'/%3E%3Cellipse cx='929' cy='417' rx='4.4' ry='4.6'/%3E%3Cellipse cx='1265' cy='103' rx='2.2' ry='2.2'/%3E%3Cellipse cx='941' cy='652' rx='2.8' ry='3.2'/%3E%3Cellipse cx='574' cy='667' rx='7.0' ry='7.2'/%3E%3Cellipse cx='1359' cy='225' rx='2.2' ry='2.3'/%3E%3Cellipse cx='1220' cy='653' rx='4.4' ry='4.6'/%3E%3Cellipse cx='327' cy='507' rx='3.3' ry='3.4'/%3E%3Cellipse cx='719' cy='143' rx='2.6' ry='2.6'/%3E%3Cellipse cx='355' cy='260' rx='2.6' ry='2.7'/%3E%3Cellipse cx='1062' cy='237' rx='6.3' ry='6.7'/%3E%3Cellipse cx='1558' cy='409' rx='4.6' ry='4.5'/%3E%3Cellipse cx='19' cy='535' rx='3.1' ry='3.2'/%3E%3Cellipse cx='1273' cy='511' rx='2.2' ry='2.5'/%3E%3Cellipse cx='1029' cy='731' rx='1.8' ry='1.9'/%3E%3Cellipse cx='1532' cy='199' rx='4.2' ry='3.9'/%3E%3Cellipse cx='313' cy='163' rx='2.4' ry='2.5'/%3E%3Cellipse cx='1259' cy='352' rx='3.8' ry='4.5'/%3E%3Cellipse cx='1187' cy='452' rx='2.4' ry='2.6'/%3E%3Cellipse cx='172' cy='322' rx='1.8' ry='1.7'/%3E%3Cellipse cx='1583' cy='321' rx='3.4' ry='4.0'/%3E%3Cellipse cx='1123' cy='878' rx='2.7' ry='2.6'/%3E%3Cellipse cx='49' cy='188' rx='4.1' ry='4.3'/%3E%3Cellipse cx='291' cy='222' rx='2.9' ry='3.5'/%3E%3Cellipse cx='1375' cy='674' rx='3.3' ry='3.2'/%3E%3Cellipse cx='890' cy='648' rx='7.1' ry='7.5'/%3E%3Cellipse cx='1071' cy='241' rx='4.7' ry='4.9'/%3E%3Cellipse cx='280' cy='280' rx='5.2' ry='4.8'/%3E%3Cellipse cx='1107' cy='34' rx='3.4' ry='3.3'/%3E%3Cellipse cx='84' cy='151' rx='6.7' ry='6.8'/%3E%3Cellipse cx='145' cy='226' rx='3.9' ry='4.3'/%3E%3Cellipse cx='457' cy='397' rx='2.9' ry='3.3'/%3E%3Cellipse cx='946' cy='71' rx='3.1' ry='3.5'/%3E%3Cellipse cx='732' cy='76' rx='3.0' ry='3.3'/%3E%3Cellipse cx='309' cy='839' rx='4.4' ry='4.6'/%3E%3Cellipse cx='42' cy='884' rx='2.8' ry='3.3'/%3E%3Cellipse cx='1472' cy='710' rx='1.8' ry='1.8'/%3E%3Cellipse cx='1304' cy='236' rx='2.5' ry='2.4'/%3E%3Cellipse cx='1397' cy='738' rx='5.8' ry='6.1'/%3E%3Cellipse cx='480' cy='524' rx='4.5' ry='4.3'/%3E%3Cellipse cx='1101' cy='51' rx='1.9' ry='2.2'/%3E%3Cellipse cx='256' cy='680' rx='2.3' ry='2.6'/%3E%3Cellipse cx='854' cy='205' rx='3.7' ry='3.9'/%3E%3Cellipse cx='583' cy='168' rx='5.9' ry='6.0'/%3E%3Cellipse cx='1427' cy='857' rx='3.7' ry='4.2'/%3E%3Cellipse cx='470' cy='686' rx='2.6' ry='2.9'/%3E%3Cellipse cx='1292' cy='858' rx='3.2' ry='3.1'/%3E%3Cellipse cx='1268' cy='381' rx='3.0' ry='3.5'/%3E%3Cellipse cx='234' cy='864' rx='2.1' ry='2.2'/%3E%3Cellipse cx='1017' cy='42' rx='2.8' ry='2.6'/%3E%3Cellipse cx='970' cy='442' rx='3.0' ry='2.9'/%3E%3Cellipse cx='1553' cy='131' rx='3.0' ry='3.5'/%3E%3Cellipse cx='311' cy='63' rx='6.5' ry='7.0'/%3E%3Cellipse cx='350' cy='341' rx='4.2' ry='4.1'/%3E%3C/g%3E%3Cg fill='url(%23k)'%3E%3Cellipse cx='1091' cy='85' rx='4.5' ry='4.7'/%3E%3Cellipse cx='1572' cy='413' rx='3.2' ry='3.8'/%3E%3Cellipse cx='1341' cy='84' rx='3.2' ry='3.5'/%3E%3Cellipse cx='54' cy='475' rx='2.2' ry='2.1'/%3E%3Cellipse cx='1475' cy='39' rx='2.7' ry='3.0'/%3E%3Cellipse cx='927' cy='788' rx='2.8' ry='3.3'/%3E%3Cellipse cx='1376' cy='841' rx='2.3' ry='2.6'/%3E%3Cellipse cx='1183' cy='159' rx='2.7' ry='3.2'/%3E%3Cellipse cx='216' cy='585' rx='2.5' ry='2.3'/%3E%3Cellipse cx='1348' cy='537' rx='2.6' ry='2.6'/%3E%3Cellipse cx='440' cy='748' rx='4.4' ry='4.1'/%3E%3Cellipse cx='1162' cy='739' rx='6.0' ry='6.3'/%3E%3Cellipse cx='575' cy='805' rx='6.4' ry='7.3'/%3E%3Cellipse cx='1143' cy='73' rx='4.4' ry='5.1'/%3E%3Cellipse cx='1337' cy='341' rx='3.1' ry='3.4'/%3E%3Cellipse cx='386' cy='411' rx='3.3' ry='3.4'/%3E%3Cellipse cx='1017' cy='595' rx='2.5' ry='2.4'/%3E%3Cellipse cx='797' cy='638' rx='5.5' ry='5.9'/%3E%3Cellipse cx='647' cy='819' rx='5.1' ry='5.6'/%3E%3Cellipse cx='1244' cy='379' rx='4.1' ry='4.7'/%3E%3Cellipse cx='281' cy='640' rx='2.5' ry='2.7'/%3E%3Cellipse cx='942' cy='848' rx='4.4' ry='5.1'/%3E%3Cellipse cx='1575' cy='877' rx='4.5' ry='5.3'/%3E%3Cellipse cx='289' cy='558' rx='6.5' ry='6.6'/%3E%3Cellipse cx='899' cy='670' rx='5.6' ry='5.2'/%3E%3Cellipse cx='530' cy='761' rx='1.8' ry='1.9'/%3E%3Cellipse cx='1280' cy='476' rx='5.3' ry='6.0'/%3E%3Cellipse cx='148' cy='105' rx='3.1' ry='3.2'/%3E%3Cellipse cx='1371' cy='667' rx='1.8' ry='2.0'/%3E%3Cellipse cx='670' cy='21' rx='4.1' ry='4.7'/%3E%3Cellipse cx='1229' cy='834' rx='4.5' ry='4.7'/%3E%3Cellipse cx='867' cy='678' rx='4.8' ry='5.2'/%3E%3Cellipse cx='1145' cy='361' rx='2.3' ry='2.1'/%3E%3Cellipse cx='541' cy='864' rx='2.7' ry='2.8'/%3E%3Cellipse cx='834' cy='128' rx='4.7' ry='4.8'/%3E%3Cellipse cx='69' cy='704' rx='4.4' ry='4.2'/%3E%3Cellipse cx='528' cy='580' rx='3.9' ry='3.8'/%3E%3Cellipse cx='76' cy='133' rx='3.3' ry='3.4'/%3E%3Cellipse cx='324' cy='523' rx='2.9' ry='2.9'/%3E%3Cellipse cx='1179' cy='264' rx='5.1' ry='5.0'/%3E%3Cellipse cx='1532' cy='94' rx='4.3' ry='4.1'/%3E%3Cellipse cx='78' cy='113' rx='4.0' ry='3.8'/%3E%3C/g%3E%3Cg fill='url(%23s)'%3E%3Cellipse cx='1088.8' cy='78.3' rx='2.5' ry='1.7'/%3E%3Cellipse cx='1570.3' cy='407.9' rx='1.7' ry='1.4'/%3E%3Cellipse cx='1339.6' cy='78.8' rx='1.7' ry='1.3'/%3E%3Cellipse cx='53.3' cy='472.1' rx='1.2' ry='0.8'/%3E%3Cellipse cx='35.9' cy='313.7' rx='1.7' ry='1.2'/%3E%3Cellipse cx='362.8' cy='583.2' rx='0.8' ry='0.5'/%3E%3Cellipse cx='987.8' cy='42.2' rx='0.7' ry='0.5'/%3E%3Cellipse cx='207.4' cy='313.9' rx='0.9' ry='0.7'/%3E%3Cellipse cx='460.0' cy='20.6' rx='1.7' ry='1.2'/%3E%3Cellipse cx='1462.0' cy='1.8' rx='3.5' ry='2.4'/%3E%3Cellipse cx='142.6' cy='274.3' rx='3.1' ry='2.1'/%3E%3Cellipse cx='1473.1' cy='34.1' rx='1.5' ry='1.1'/%3E%3Cellipse cx='925.8' cy='783.1' rx='1.5' ry='1.2'/%3E%3Cellipse cx='1375.0' cy='837.5' rx='1.3' ry='0.9'/%3E%3Cellipse cx='134.6' cy='579.4' rx='3.4' ry='2.5'/%3E%3Cellipse cx='1181.0' cy='154.2' rx='1.5' ry='1.2'/%3E%3Cellipse cx='270.4' cy='737.8' rx='0.9' ry='0.6'/%3E%3Cellipse cx='3.4' cy='665.0' rx='0.7' ry='0.5'/%3E%3Cellipse cx='363.0' cy='222.9' rx='0.8' ry='0.6'/%3E%3Cellipse cx='926.3' cy='410.1' rx='2.4' ry='1.6'/%3E%3Cellipse cx='1263.5' cy='99.9' rx='1.2' ry='0.8'/%3E%3Cellipse cx='214.4' cy='581.9' rx='1.4' ry='0.8'/%3E%3Cellipse cx='939.9' cy='647.2' rx='1.5' ry='1.2'/%3E%3Cellipse cx='1346.3' cy='532.7' rx='1.4' ry='0.9'/%3E%3Cellipse cx='569.8' cy='656.2' rx='3.8' ry='2.6'/%3E%3Cellipse cx='1357.3' cy='221.7' rx='1.2' ry='0.8'/%3E%3Cellipse cx='1153.6' cy='874.7' rx='0.9' ry='0.6'/%3E%3Cellipse cx='437.7' cy='741.6' rx='2.4' ry='1.5'/%3E%3Cellipse cx='1217.8' cy='645.8' rx='2.4' ry='1.7'/%3E%3Cellipse cx='1158.4' cy='729.4' rx='3.3' ry='2.3'/%3E%3Cellipse cx='571.2' cy='794.2' rx='3.5' ry='2.6'/%3E%3Cellipse cx='1147.7' cy='103.2' rx='0.8' ry='0.6'/%3E%3Cellipse cx='325.2' cy='502.0' rx='1.8' ry='1.2'/%3E%3Cellipse cx='717.8' cy='139.3' rx='1.4' ry='0.9'/%3E%3Cellipse cx='1530.0' cy='214.7' rx='0.5' ry='0.4'/%3E%3Cellipse cx='353.2' cy='256.1' rx='1.4' ry='1.0'/%3E%3Cellipse cx='1140.6' cy='65.1' rx='2.4' ry='1.8'/%3E%3Cellipse cx='1058.4' cy='227.4' rx='3.4' ry='2.4'/%3E%3Cellipse cx='1555.4' cy='402.1' rx='2.5' ry='1.6'/%3E%3Cellipse cx='17.2' cy='530.4' rx='1.7' ry='1.2'/%3E%3Cellipse cx='1335.1' cy='336.3' rx='1.7' ry='1.2'/%3E%3Cellipse cx='614.5' cy='74.4' rx='0.9' ry='0.6'/%3E%3Cellipse cx='1272.3' cy='506.9' rx='1.2' ry='0.9'/%3E%3Cellipse cx='383.8' cy='405.7' rx='1.8' ry='1.2'/%3E%3Cellipse cx='1015.8' cy='591.6' rx='1.4' ry='0.9'/%3E%3Cellipse cx='1028.2' cy='727.9' rx='1.0' ry='0.7'/%3E%3Cellipse cx='525.3' cy='577.3' rx='0.7' ry='0.6'/%3E%3Cellipse cx='1529.4' cy='193.4' rx='2.3' ry='1.4'/%3E%3Cellipse cx='311.8' cy='159.2' rx='1.3' ry='0.9'/%3E%3Cellipse cx='794.3' cy='629.0' rx='3.0' ry='2.1'/%3E%3Cellipse cx='1256.8' cy='345.6' rx='2.1' ry='1.6'/%3E%3Cellipse cx='1185.3' cy='448.6' rx='1.3' ry='0.9'/%3E%3Cellipse cx='643.8' cy='811.2' rx='2.8' ry='2.0'/%3E%3Cellipse cx='170.6' cy='319.2' rx='1.0' ry='0.6'/%3E%3Cellipse cx='949.2' cy='309.5' rx='0.9' ry='0.7'/%3E%3Cellipse cx='1581.6' cy='315.2' rx='1.8' ry='1.4'/%3E%3Cellipse cx='1121.5' cy='873.8' rx='1.5' ry='0.9'/%3E%3Cellipse cx='387.9' cy='777.1' rx='0.8' ry='0.5'/%3E%3Cellipse cx='1241.8' cy='371.8' rx='2.2' ry='1.7'/%3E%3Cellipse cx='46.9' cy='181.4' rx='2.2' ry='1.5'/%3E%3Cellipse cx='279.5' cy='635.6' rx='1.4' ry='1.0'/%3E%3Cellipse cx='245.1' cy='342.4' rx='0.5' ry='0.4'/%3E%3Cellipse cx='289.4' cy='217.2' rx='1.6' ry='1.2'/%3E%3Cellipse cx='1373.2' cy='668.8' rx='1.8' ry='1.2'/%3E%3Cellipse cx='886.3' cy='636.4' rx='3.9' ry='2.7'/%3E%3Cellipse cx='685.6' cy='307.9' rx='0.9' ry='0.6'/%3E%3Cellipse cx='1068.4' cy='233.5' rx='2.6' ry='1.8'/%3E%3Cellipse cx='277.1' cy='272.6' rx='2.8' ry='1.7'/%3E%3Cellipse cx='1105.4' cy='29.7' rx='1.9' ry='1.2'/%3E%3Cellipse cx='80.4' cy='141.2' rx='3.7' ry='2.5'/%3E%3Cellipse cx='574.1' cy='854.1' rx='0.7' ry='0.5'/%3E%3Cellipse cx='939.8' cy='840.8' rx='2.4' ry='1.8'/%3E%3Cellipse cx='143.0' cy='219.5' rx='2.1' ry='1.6'/%3E%3Cellipse cx='455.2' cy='391.8' rx='1.6' ry='1.2'/%3E%3Cellipse cx='944.1' cy='65.4' rx='1.7' ry='1.3'/%3E%3Cellipse cx='730.8' cy='71.5' rx='1.6' ry='1.2'/%3E%3Cellipse cx='1572.8' cy='869.5' rx='2.5' ry='1.9'/%3E%3Cellipse cx='555.7' cy='410.4' rx='0.6' ry='0.4'/%3E%3Cellipse cx='241.6' cy='605.1' rx='1.0' ry='0.6'/%3E%3Cellipse cx='1382.6' cy='177.6' rx='0.9' ry='0.6'/%3E%3Cellipse cx='1507.7' cy='28.6' rx='0.6' ry='0.4'/%3E%3Cellipse cx='306.8' cy='832.5' rx='2.4' ry='1.6'/%3E%3Cellipse cx='40.2' cy='879.1' rx='1.5' ry='1.2'/%3E%3Cellipse cx='1471.0' cy='707.2' rx='1.0' ry='0.6'/%3E%3Cellipse cx='1213.2' cy='603.4' rx='1.0' ry='0.7'/%3E%3Cellipse cx='285.5' cy='547.7' rx='3.6' ry='2.4'/%3E%3Cellipse cx='83.3' cy='850.3' rx='0.6' ry='0.5'/%3E%3Cellipse cx='860.0' cy='174.8' rx='0.6' ry='0.4'/%3E%3Cellipse cx='628.9' cy='471.0' rx='0.7' ry='0.5'/%3E%3Cellipse cx='1302.6' cy='232.8' rx='1.4' ry='0.9'/%3E%3Cellipse cx='1043.4' cy='124.8' rx='0.9' ry='0.6'/%3E%3Cellipse cx='895.9' cy='662.3' rx='3.1' ry='1.9'/%3E%3Cellipse cx='529.4' cy='757.8' rx='1.0' ry='0.7'/%3E%3Cellipse cx='1023.6' cy='348.3' rx='0.6' ry='0.4'/%3E%3Cellipse cx='1372.8' cy='536.2' rx='0.8' ry='0.6'/%3E%3Cellipse cx='1010.4' cy='557.6' rx='0.5' ry='0.3'/%3E%3Cellipse cx='1277.3' cy='467.5' rx='2.9' ry='2.2'/%3E%3Cellipse cx='1393.4' cy='729.0' rx='3.2' ry='2.2'/%3E%3Cellipse cx='477.3' cy='517.8' rx='2.4' ry='1.6'/%3E%3Cellipse cx='381.6' cy='578.1' rx='1.0' ry='0.7'/%3E%3Cellipse cx='1099.6' cy='47.3' rx='1.1' ry='0.8'/%3E%3Cellipse cx='422.3' cy='79.5' rx='0.6' ry='0.4'/%3E%3Cellipse cx='146.3' cy='100.1' rx='1.7' ry='1.1'/%3E%3Cellipse cx='1370.4' cy='664.3' rx='1.0' ry='0.7'/%3E%3Cellipse cx='742.0' cy='802.9' rx='0.6' ry='0.5'/%3E%3Cellipse cx='657.7' cy='631.7' rx='0.9' ry='0.6'/%3E%3Cellipse cx='667.8' cy='14.3' rx='2.2' ry='1.7'/%3E%3Cellipse cx='254.9' cy='676.7' rx='1.3' ry='0.9'/%3E%3Cellipse cx='742.7' cy='556.8' rx='0.8' ry='0.6'/%3E%3Cellipse cx='1226.7' cy='827.0' rx='2.4' ry='1.7'/%3E%3Cellipse cx='864.5' cy='670.7' rx='2.6' ry='1.9'/%3E%3Cellipse cx='1144.0' cy='358.0' rx='1.2' ry='0.8'/%3E%3Cellipse cx='852.1' cy='199.0' rx='2.0' ry='1.4'/%3E%3Cellipse cx='539.7' cy='860.1' rx='1.5' ry='1.0'/%3E%3Cellipse cx='831.6' cy='121.0' rx='2.5' ry='1.7'/%3E%3Cellipse cx='66.6' cy='698.0' rx='2.4' ry='1.5'/%3E%3Cellipse cx='526.3' cy='574.0' rx='2.1' ry='1.4'/%3E%3Cellipse cx='393.1' cy='699.3' rx='0.6' ry='0.4'/%3E%3Cellipse cx='579.7' cy='159.4' rx='3.2' ry='2.2'/%3E%3Cellipse cx='74.6' cy='127.8' rx='1.8' ry='1.2'/%3E%3Cellipse cx='1047.0' cy='371.7' rx='0.6' ry='0.5'/%3E%3Cellipse cx='1362.4' cy='66.7' rx='0.9' ry='0.6'/%3E%3Cellipse cx='1424.9' cy='850.8' rx='2.0' ry='1.5'/%3E%3Cellipse cx='322.3' cy='518.9' rx='1.6' ry='1.0'/%3E%3Cellipse cx='926.7' cy='482.0' rx='0.8' ry='0.5'/%3E%3Cellipse cx='468.5' cy='681.9' rx='1.4' ry='1.0'/%3E%3Cellipse cx='70.8' cy='893.0' rx='0.8' ry='0.6'/%3E%3Cellipse cx='1290.4' cy='852.9' rx='1.7' ry='1.1'/%3E%3Cellipse cx='1266.2' cy='375.5' rx='1.6' ry='1.2'/%3E%3Cellipse cx='242.9' cy='653.1' rx='0.5' ry='0.4'/%3E%3Cellipse cx='232.7' cy='860.7' rx='1.1' ry='0.8'/%3E%3Cellipse cx='1015.3' cy='38.4' rx='1.5' ry='0.9'/%3E%3Cellipse cx='1176.1' cy='256.3' rx='2.8' ry='1.8'/%3E%3Cellipse cx='1530.1' cy='87.9' rx='2.3' ry='1.5'/%3E%3Cellipse cx='968.3' cy='437.6' rx='1.6' ry='1.0'/%3E%3Cellipse cx='416.5' cy='449.3' rx='0.9' ry='0.6'/%3E%3Cellipse cx='1551.0' cy='125.6' rx='1.6' ry='1.2'/%3E%3Cellipse cx='307.0' cy='53.1' rx='3.5' ry='2.5'/%3E%3Cellipse cx='348.1' cy='335.1' rx='2.3' ry='1.5'/%3E%3Cellipse cx='75.6' cy='107.8' rx='2.2' ry='1.4'/%3E%3C/g%3E%3C/svg%3E\") center / cover no-repeat;\nanimation: aur-rn-bead-b 34s steps(170) infinite alternate;\n}\n@keyframes aur-rn-bead-a { from { opacity: 1; } to { opacity: 0.15; } }\n@keyframes aur-rn-bead-b { from { opacity: 0.15; } to { opacity: 1; } }\n.aur-root[data-fx=\"rain\"] .aur-fx-e {\ndisplay: block;\ninset: 0;\nbackground-image:\nradial-gradient(0.8px 0.8px at 130px 50px, rgba(214, 230, 255, 0.5), transparent),\nradial-gradient(0.8px 0.8px at 146px 59px, rgba(214, 230, 255, 0.5), transparent),\nradial-gradient(0.8px 0.8px at 86px 79px, rgba(214, 230, 255, 0.5), transparent),\nradial-gradient(0.8px 0.8px at 86px 11px, rgba(214, 230, 255, 0.5), transparent),\nradial-gradient(0.8px 0.8px at 128px 95px, rgba(214, 230, 255, 0.5), transparent),\nradial-gradient(0.8px 0.8px at 95px 20px, rgba(214, 230, 255, 0.5), transparent),\nradial-gradient(0.8px 0.8px at 107px 122px, rgba(214, 230, 255, 0.5), transparent),\nradial-gradient(0.8px 0.8px at 88px 46px, rgba(214, 230, 255, 0.5), transparent),\nradial-gradient(0.8px 0.8px at 89px 165px, rgba(214, 230, 255, 0.5), transparent),\nradial-gradient(1.1px 1.1px at 5px 132px, rgba(214, 230, 255, 0.42), transparent),\nradial-gradient(1.1px 1.1px at 180px 27px, rgba(214, 230, 255, 0.42), transparent),\nradial-gradient(1.1px 1.1px at 166px 48px, rgba(214, 230, 255, 0.42), transparent),\nradial-gradient(1.1px 1.1px at 90px 10px, rgba(214, 230, 255, 0.42), transparent),\nradial-gradient(1.1px 1.1px at 114px 40px, rgba(214, 230, 255, 0.42), transparent),\nradial-gradient(1.1px 1.1px at 36px 190px, rgba(214, 230, 255, 0.42), transparent),\nradial-gradient(1.1px 1.1px at 107px 79px, rgba(214, 230, 255, 0.42), transparent),\nradial-gradient(1.1px 1.1px at 78px 192px, rgba(214, 230, 255, 0.42), transparent),\nradial-gradient(1.5px 1.5px at 91px 116px, rgba(214, 230, 255, 0.36), transparent),\nradial-gradient(1.5px 1.5px at 85px 99px, rgba(214, 230, 255, 0.36), transparent),\nradial-gradient(1.5px 1.5px at 49px 70px, rgba(214, 230, 255, 0.36), transparent),\nradial-gradient(1.5px 1.5px at 111px 108px, rgba(214, 230, 255, 0.36), transparent),\nradial-gradient(1.5px 1.5px at 63px 37px, rgba(214, 230, 255, 0.36), transparent),\nradial-gradient(1.5px 1.5px at 50px 18px, rgba(214, 230, 255, 0.36), transparent);\nbackground-size: 173px 173px, 173px 173px, 173px 173px, 173px 173px, 173px 173px, 173px 173px, 173px 173px, 173px 173px, 173px 173px, 211px 211px, 211px 211px, 211px 211px, 211px 211px, 211px 211px, 211px 211px, 211px 211px, 211px 211px, 137px 137px, 137px 137px, 137px 137px, 137px 137px, 137px 137px, 137px 137px;\n}\n.aur-root[data-fx=\"rain\"] .aur-fx-e > i {\nposition: absolute;\ndisplay: block;\nleft: var(--x);\ntop: var(--y);\nwidth: 0;\nheight: 0;\n}\n.aur-root[data-fx=\"rain\"] .aur-fx-e > i:nth-child(n + 13) { display: none; }\n.aur-root[data-fx=\"rain\"] .aur-fx-e > i::before {\ncontent: \"\";\nposition: absolute;\nleft: 0;\ntop: 0;\nwidth: 0.55vmin;\nheight: var(--dy);\nmargin-left: -0.275vmin;\nborder-radius: 0.2vmin;\nbackground: linear-gradient(to bottom, transparent, rgba(190, 215, 250, 0.1) 25%, rgba(214, 230, 255, 0.42));\ntransform-origin: 50% 0;\nscale: 1 0;\nopacity: 0;\nanimation: var(--tv) var(--dur) var(--delay) linear infinite;\n}\n.aur-root[data-fx=\"rain\"] .aur-fx-e > i::after {\ncontent: \"\";\nposition: absolute;\nleft: 0;\ntop: 0;\nwidth: var(--s);\nheight: calc(var(--s) * 1.35);\nmargin: calc(var(--s) * -0.68) 0 0 calc(var(--s) * -0.5);\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 54' preserveAspectRatio='xMidYMid meet'%3E%3Cdefs%3E%3CradialGradient id='d' cx='.5' cy='.62' r='.55'%3E%3Cstop offset='0' stop-color='%23b6d2f0' stop-opacity='.22'/%3E%3Cstop offset='.68' stop-color='%23070c16' stop-opacity='.4'/%3E%3Cstop offset='.92' stop-color='%23dbeaff' stop-opacity='.4'/%3E%3Cstop offset='1' stop-color='%23f2f8ff' stop-opacity='.85'/%3E%3C/radialGradient%3E%3CradialGradient id='s' cx='.5' cy='.5' r='.5'%3E%3Cstop offset='0' stop-color='%23fff'/%3E%3Cstop offset='1' stop-color='%23fff' stop-opacity='0'/%3E%3C/radialGradient%3E%3CradialGradient id='w' cx='.5' cy='.5' r='.5'%3E%3Cstop offset='0' stop-color='%23ffc46e' stop-opacity='.55'/%3E%3Cstop offset='1' stop-color='%23ffc46e' stop-opacity='0'/%3E%3C/radialGradient%3E%3C/defs%3E%3Cpath d='M20 1C25 15 38 25 38 37C38 47 30 53 20 53C10 53 2 47 2 37C2 25 15 15 20 1Z' fill='url(%23d)'/%3E%3Cellipse cx='20' cy='42' rx='9' ry='8' fill='url(%23w)'/%3E%3Cellipse cx='13' cy='30' rx='4' ry='7' fill='url(%23s)' transform='rotate(14 13 30)' fill-opacity='.9'/%3E%3Cellipse cx='27' cy='46' rx='3' ry='1.6' fill='url(%23s)' fill-opacity='.55'/%3E%3C/svg%3E\") center / 100% 100% no-repeat;\nopacity: 0;\nanimation: var(--hv) var(--dur) var(--delay) linear infinite;\n}\n.aur-root[data-fx=\"rain\"] .aur-fx-e > i:nth-child(1) { --x: 10.5%; --y: 21.6vh; --dy: 84.4vh; --s: 3.52vmin; --dur: 26.8s; --delay: -12.7s; --hv: aur-rn-head-1; --tv: aur-rn-trail-1; }\n.aur-root[data-fx=\"rain\"] .aur-fx-e > i:nth-child(2) { --x: 16.6%; --y: 38.7vh; --dy: 66.5vh; --s: 3.21vmin; --dur: 36.0s; --delay: -30.7s; --hv: aur-rn-head-2; --tv: aur-rn-trail-2; }\n.aur-root[data-fx=\"rain\"] .aur-fx-e > i:nth-child(3) { --x: 20.9%; --y: 59.4vh; --dy: 46.0vh; --s: 3.50vmin; --dur: 36.2s; --delay: -30.2s; --hv: aur-rn-head-3; --tv: aur-rn-trail-3; }\n.aur-root[data-fx=\"rain\"] .aur-fx-e > i:nth-child(4) { --x: 29.3%; --y: 21.3vh; --dy: 83.4vh; --s: 3.45vmin; --dur: 36.8s; --delay: -7.5s; --hv: aur-rn-head-2; --tv: aur-rn-trail-2; }\n.aur-root[data-fx=\"rain\"] .aur-fx-e > i:nth-child(5) { --x: 36.9%; --y: 6.9vh; --dy: 98.7vh; --s: 3.10vmin; --dur: 34.5s; --delay: -24.3s; --hv: aur-rn-head-1; --tv: aur-rn-trail-1; }\n.aur-root[data-fx=\"rain\"] .aur-fx-e > i:nth-child(6) { --x: 43.7%; --y: 52.4vh; --dy: 59.5vh; --s: 3.38vmin; --dur: 41.8s; --delay: -35.5s; --hv: aur-rn-head-3; --tv: aur-rn-trail-3; }\n.aur-root[data-fx=\"rain\"] .aur-fx-e > i:nth-child(7) { --x: 51.3%; --y: 29.7vh; --dy: 75.0vh; --s: 3.45vmin; --dur: 36.9s; --delay: -3.9s; --hv: aur-rn-head-2; --tv: aur-rn-trail-2; }\n.aur-root[data-fx=\"rain\"] .aur-fx-e > i:nth-child(8) { --x: 60.9%; --y: 48.6vh; --dy: 59.8vh; --s: 2.39vmin; --dur: 46.5s; --delay: -2.6s; --hv: aur-rn-head-1; --tv: aur-rn-trail-1; }\n.aur-root[data-fx=\"rain\"] .aur-fx-e > i:nth-child(9) { --x: 70.8%; --y: 60.4vh; --dy: 49.6vh; --s: 3.71vmin; --dur: 36.7s; --delay: -8.1s; --hv: aur-rn-head-3; --tv: aur-rn-trail-3; }\n.aur-root[data-fx=\"rain\"] .aur-fx-e > i:nth-child(10) { --x: 76.1%; --y: 46.3vh; --dy: 63.9vh; --s: 2.81vmin; --dur: 46.7s; --delay: -1.6s; --hv: aur-rn-head-1; --tv: aur-rn-trail-1; }\n.aur-root[data-fx=\"rain\"] .aur-fx-e > i:nth-child(11) { --x: 83.7%; --y: 4.4vh; --dy: 102.5vh; --s: 3.78vmin; --dur: 26.8s; --delay: -26.4s; --hv: aur-rn-head-2; --tv: aur-rn-trail-2; }\n.aur-root[data-fx=\"rain\"] .aur-fx-e > i:nth-child(12) { --x: 93.7%; --y: 43.3vh; --dy: 61.2vh; --s: 2.95vmin; --dur: 40.6s; --delay: -3.9s; --hv: aur-rn-head-3; --tv: aur-rn-trail-3; }\n@keyframes aur-rn-head-1 {\n0% { translate: 0vmin calc(var(--dy) * 0); scale: 0.3; opacity: 0; }\n5% { translate: 0.1vmin calc(var(--dy) * 0.05); scale: 1; opacity: 1; }\n13% { translate: -0.08vmin calc(var(--dy) * 0.08); }\n24% { translate: 0.14vmin calc(var(--dy) * 0.3); }\n35% { translate: -0.05vmin calc(var(--dy) * 0.33); }\n50% { translate: 0.12vmin calc(var(--dy) * 0.62); }\n58% { translate: -0.1vmin calc(var(--dy) * 0.63); }\n74% { translate: 0.06vmin calc(var(--dy) * 0.9); }\n84% { translate: 0vmin calc(var(--dy) * 1.0); }\n90% { translate: 0 var(--dy); opacity: 1; }\n96%, 100% { translate: 0 var(--dy); opacity: 0; }\n}\n@keyframes aur-rn-trail-1 {\n0% { scale: 1 0; opacity: 0; }\n5% { scale: 1 0.05; opacity: 1; }\n13% { scale: 1 0.08; }\n24% { scale: 1 0.3; }\n35% { scale: 1 0.33; }\n50% { scale: 1 0.62; }\n58% { scale: 1 0.63; }\n74% { scale: 1 0.9; }\n84% { scale: 1 1.0; }\n90% { scale: 1 1; opacity: 1; }\n96%, 100% { scale: 1 1; opacity: 0; }\n}\n@keyframes aur-rn-head-2 {\n0% { translate: 0vmin calc(var(--dy) * 0); scale: 0.3; opacity: 0; }\n8% { translate: -0.1vmin calc(var(--dy) * 0.02); scale: 1; opacity: 1; }\n20% { translate: 0.08vmin calc(var(--dy) * 0.16); }\n27% { translate: -0.14vmin calc(var(--dy) * 0.17); }\n33% { translate: 0.05vmin calc(var(--dy) * 0.45); }\n48% { translate: -0.12vmin calc(var(--dy) * 0.5); }\n55% { translate: 0.1vmin calc(var(--dy) * 0.82); }\n62% { translate: -0.06vmin calc(var(--dy) * 0.83); }\n80% { translate: 0vmin calc(var(--dy) * 1.0); }\n86% { translate: 0 var(--dy); opacity: 1; }\n92%, 100% { translate: 0 var(--dy); opacity: 0; }\n}\n@keyframes aur-rn-trail-2 {\n0% { scale: 1 0; opacity: 0; }\n8% { scale: 1 0.02; opacity: 1; }\n20% { scale: 1 0.16; }\n27% { scale: 1 0.17; }\n33% { scale: 1 0.45; }\n48% { scale: 1 0.5; }\n55% { scale: 1 0.82; }\n62% { scale: 1 0.83; }\n80% { scale: 1 1.0; }\n86% { scale: 1 1; opacity: 1; }\n92%, 100% { scale: 1 1; opacity: 0; }\n}\n@keyframes aur-rn-head-3 {\n0% { translate: 0vmin calc(var(--dy) * 0); scale: 0.3; opacity: 0; }\n4% { translate: 0.1vmin calc(var(--dy) * 0.04); scale: 1; opacity: 1; }\n9% { translate: -0.08vmin calc(var(--dy) * 0.24); }\n17% { translate: 0.14vmin calc(var(--dy) * 0.26); }\n30% { translate: -0.05vmin calc(var(--dy) * 0.4); }\n40% { translate: 0.12vmin calc(var(--dy) * 0.42); }\n46% { translate: -0.1vmin calc(var(--dy) * 0.66); }\n66% { translate: 0.06vmin calc(var(--dy) * 0.72); }\n72% { translate: 0vmin calc(var(--dy) * 0.95); }\n82% { translate: 0.08vmin calc(var(--dy) * 1.0); }\n88% { translate: 0 var(--dy); opacity: 1; }\n94%, 100% { translate: 0 var(--dy); opacity: 0; }\n}\n@keyframes aur-rn-trail-3 {\n0% { scale: 1 0; opacity: 0; }\n4% { scale: 1 0.04; opacity: 1; }\n9% { scale: 1 0.24; }\n17% { scale: 1 0.26; }\n30% { scale: 1 0.4; }\n40% { scale: 1 0.42; }\n46% { scale: 1 0.66; }\n66% { scale: 1 0.72; }\n72% { scale: 1 0.95; }\n82% { scale: 1 1.0; }\n88% { scale: 1 1; opacity: 1; }\n94%, 100% { scale: 1 1; opacity: 0; }\n}\n.aur-root[data-bganim=\"off\"] .aur-fx-e > i::before,\n.aur-root[data-bganim=\"off\"] .aur-fx-e > i::after { animation-play-state: paused; }\n.aur-root[data-fx=\"rain\"] .aur-fx-e::after {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: radial-gradient(90% 70% at 50% 20%, rgba(210, 225, 255, 0.85), rgba(150, 175, 230, 0.4) 60%, transparent);\nopacity: 0;\nanimation: aur-rn-flash 27s linear infinite;\n}\n.aur-root[data-fx=\"rain\"][data-gap=\"on\"] .aur-fx-e::after { animation-duration: 14s; }\n@keyframes aur-rn-flash {\n0%, 95% { opacity: 0; }\n95.4% { opacity: 0.5; }\n96% { opacity: 0.08; }\n96.6% { opacity: 0.78; }\n100% { opacity: 0; }\n}\n.aur-root[data-fx=\"rain\"] .aur-fx::after {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground:\nlinear-gradient(115deg, transparent 30%, rgba(255, 255, 255, 0.035) 34%, transparent 40%, transparent 62%, rgba(255, 255, 255, 0.025) 66%, transparent 70%),\nradial-gradient(120% 90% at 50% 100%, rgba(150, 170, 200, 0.18), transparent 60%),\nradial-gradient(130% 110% at 50% 45%, transparent 55%, rgba(2, 4, 10, 0.6));\nbox-shadow: inset 0 0 0 1.3vmin rgba(4, 6, 12, 0.92), inset 0 0 0 1.5vmin rgba(120, 140, 170, 0.18);\n}\n.aur-root[data-fx=\"rain\"] .aur-bg-grain { opacity: 0.03; }\n.aur-fx > canvas.aur-fx-gl { position: absolute; inset: 0; width: 100%; height: 100%; display: none; }\n.aur-root[data-fx=\"rain\"][data-gl=\"on\"] .aur-fx > canvas.aur-fx-gl { display: block; }\n.aur-root[data-fx=\"rain\"][data-gl=\"on\"] .aur-fx { background: #04060c; }\n.aur-root[data-fx=\"rain\"][data-gl=\"on\"] .aur-fx > i,\n.aur-root[data-fx=\"rain\"][data-gl=\"on\"] .aur-fx::after { display: none; }\n.aur-root[data-look=\"rain\"] { --aur-glow-tint: #8fb4e6; }\n.aur-root[data-look=\"rain\"][data-color=\"white\"] { --aur-hi: #e8f1ff; }\n.aur-root[data-look=\"rain\"][data-motion=\"full\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active .aur-main { animation: aur-rn-wipe 1.5s var(--aur-ease); }\n@keyframes aur-rn-wipe { from { opacity: 0.3; filter: blur(7px); } }\n@keyframes aur-fx-flash-a { from { opacity: 1; } }\n@keyframes aur-fx-flash-b { from { opacity: 1; } }\n@keyframes aur-fx-swell-a { from { transform: scale(1.1); } }\n@keyframes aur-fx-swell-b { from { transform: scale(1.1); } }\n@keyframes aur-fx-blip-a { 0% { opacity: 0.75; } 100% { opacity: 0.55; } }\n@keyframes aur-fx-blip-b { 0% { opacity: 0.75; } 100% { opacity: 0.55; } }\n.aur-root[data-fx=\"aurora\"][data-bganim=\"on\"] .aur-bg[data-bar=\"a\"] .aur-fx::before { animation: aur-au-twinkle 8s steps(48) infinite alternate, aur-fx-flash-a 1.1s ease-out; }\n.aur-root[data-fx=\"aurora\"][data-bganim=\"on\"] .aur-bg[data-bar=\"b\"] .aur-fx::before { animation: aur-au-twinkle 8s steps(48) infinite alternate, aur-fx-flash-b 1.1s ease-out; }\n.aur-root[data-fx=\"retro\"][data-bganim=\"on\"] .aur-bg[data-bt=\"a\"] .aur-fx-a { animation: aur-fx-blip-a 0.12s steps(1); }\n.aur-root[data-fx=\"retro\"][data-bganim=\"on\"] .aur-bg[data-bt=\"b\"] .aur-fx-a { animation: aur-fx-blip-b 0.12s steps(1); }\n.aur-root[data-fx=\"synthwave\"] .aur-bg[data-beats=\"on\"] .aur-fx-b::before { animation-duration: calc(var(--aur-beat) * 2); }\n.aur-root[data-fx=\"synthwave\"][data-gap=\"on\"] .aur-bg[data-beats=\"on\"] .aur-fx-b::before { animation-duration: var(--aur-beat); }\n.aur-root[data-fx=\"synthwave\"][data-bganim=\"on\"] .aur-bg[data-bar=\"a\"] .aur-fx::after { animation: aur-fx-flash-a 0.7s ease-out; }\n.aur-root[data-fx=\"synthwave\"][data-bganim=\"on\"] .aur-bg[data-bar=\"b\"] .aur-fx::after { animation: aur-fx-flash-b 0.7s ease-out; }\n@keyframes aur-bm-stir-a { from { scale: 1.06 1.16; } }\n@keyframes aur-bm-stir-b { from { scale: 1.06 1.16; } }\n.aur-root[data-fx=\"blackmetal\"][data-bganim=\"on\"] .aur-bg[data-bar=\"a\"] .aur-fx-b::after { animation: aur-bm-fog 90s steps(2700) infinite alternate, aur-bm-stir-a 1.4s ease-out; }\n.aur-root[data-fx=\"blackmetal\"][data-bganim=\"on\"] .aur-bg[data-bar=\"b\"] .aur-fx-b::after { animation: aur-bm-fog 90s steps(2700) infinite alternate, aur-bm-stir-b 1.4s ease-out; }\n.aur-root[data-fx=\"sunset\"][data-bganim=\"on\"] .aur-bg[data-bar=\"a\"] .aur-fx-c::before { animation: aur-fx-glitter 1.8s steps(4) infinite, aur-fx-flash-a 0.8s ease-out; }\n.aur-root[data-fx=\"sunset\"][data-bganim=\"on\"] .aur-bg[data-bar=\"b\"] .aur-fx-c::before { animation: aur-fx-glitter 1.8s steps(4) infinite, aur-fx-flash-b 0.8s ease-out; }\n.aur-root[data-fx=\"midnight\"][data-bganim=\"on\"] .aur-bg[data-bar=\"a\"] .aur-fx-a { animation: aur-fx-twinkle 5s ease-in-out infinite alternate, aur-fx-flash-a 1s ease-out; }\n.aur-root[data-fx=\"midnight\"][data-bganim=\"on\"] .aur-bg[data-bar=\"b\"] .aur-fx-a { animation: aur-fx-twinkle 5s ease-in-out infinite alternate, aur-fx-flash-b 1s ease-out; }\n.aur-root[data-fx=\"rain\"][data-bganim=\"on\"] .aur-bg[data-bar=\"a\"] .aur-fx-a { animation: aur-rn-glow 9s steps(54) infinite alternate, aur-fx-flash-a 0.9s ease-out; }\n.aur-root[data-fx=\"rain\"][data-bganim=\"on\"] .aur-bg[data-bar=\"b\"] .aur-fx-a { animation: aur-rn-glow 9s steps(54) infinite alternate, aur-fx-flash-b 0.9s ease-out; }\n.aur-pb-btn {\n--aur-pb-c: #b98cff;\nposition: relative;\ndisplay: inline-grid !important;\nplace-items: center;\nwidth: 32px !important;\nheight: 32px !important;\nmin-width: 32px;\nmargin-inline: 4px;\npadding: 0 !important;\nborder: 0;\nborder-radius: 10px !important;\noverflow: hidden;\ncursor: pointer;\n}\n:is(.aur-pb-btn, .aur-topbar-btn, .aur-launch) {\ncolor: rgba(255, 255, 255, 0.82) !important;\nbackground: linear-gradient(180deg, rgba(255, 255, 255, 0.15), rgba(255, 255, 255, 0.04)) !important;\nbox-shadow:\ninset 0 1px 0 rgba(255, 255, 255, 0.28),\ninset 0 0 0 1px rgba(255, 255, 255, 0.08),\n0 2px 8px rgba(0, 0, 0, 0.35);\nbackdrop-filter: blur(10px) saturate(1.4);\ntransition: background 0.3s ease, box-shadow 0.3s ease, color 0.2s ease, transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);\n}\n:is(.aur-pb-btn, .aur-topbar-btn, .aur-launch)::before {\ncontent: \"\";\nposition: absolute;\ninset: 0 0 50%;\nborder-radius: inherit;\nborder-bottom-left-radius: 40% 8px;\nborder-bottom-right-radius: 40% 8px;\nbackground: linear-gradient(180deg, rgba(255, 255, 255, 0.18), transparent);\npointer-events: none;\n}\n:is(.aur-pb-btn, .aur-topbar-btn)::after { display: none !important; }\n.aur-pb-btn svg { position: relative; width: 16px; height: 16px; }\n:is(.aur-pb-btn, .aur-topbar-btn, .aur-launch):hover { color: #fff !important; transform: translateY(-1px); background: linear-gradient(180deg, rgba(255, 255, 255, 0.22), rgba(255, 255, 255, 0.07)) !important; }\n:is(.aur-pb-btn, .aur-topbar-btn, .aur-launch):active { transform: scale(0.94); }\n:is(.aur-pb-btn, .aur-topbar-btn, .aur-launch).is-on {\ncolor: #fff !important;\nbackground:\nlinear-gradient(180deg, color-mix(in oklab, var(--aur-pb-c) 55%, rgba(255, 255, 255, 0.25)), color-mix(in oklab, var(--aur-pb-c) 28%, transparent)) !important;\nbox-shadow:\ninset 0 1px 0 rgba(255, 255, 255, 0.4),\ninset 0 0 0 1px color-mix(in oklab, var(--aur-pb-c) 50%, transparent),\n0 0 14px color-mix(in oklab, var(--aur-pb-c) 55%, transparent),\n0 2px 8px rgba(0, 0, 0, 0.35);\n}\n.aur-launch {\n--aur-pb-c: #b98cff;\nposition: relative;\ndisplay: inline-grid;\nplace-items: center;\nflex: none;\nwidth: 32px;\nheight: 32px;\nmargin-inline: 4px;\npadding: 0;\nborder: 0;\nborder-radius: 10px;\noverflow: hidden;\ncursor: pointer;\nfont: inherit;\n}\n.aur-launch[hidden] { display: none !important; }\n.aur-launch svg { position: relative; width: 16px; height: 16px; }\n.aur-launch-float {\nposition: fixed;\nright: 22px;\nbottom: 108px;\nz-index: 9990;\nwidth: 46px;\nheight: 46px;\nmargin: 0;\nborder-radius: 15px;\nanimation: aur-launch-in 0.6s cubic-bezier(0.34, 1.56, 0.64, 1) both;\n}\n.aur-launch-float svg { width: 20px; height: 20px; }\n.aur-launch-float::after {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nborder-radius: inherit;\nbox-shadow: 0 0 0 2px color-mix(in oklab, var(--aur-pb-c) 70%, transparent);\nopacity: 0;\nanimation: aur-launch-ping 1.6s ease-out 0.7s 2;\n}\n@keyframes aur-launch-in { from { opacity: 0; transform: translateY(10px) scale(0.8); } }\n@keyframes aur-launch-ping { 0% { opacity: 0.9; transform: scale(1); } 100% { opacity: 0; transform: scale(1.5); } }\nhtml.aur-covered .aur-launch-float { display: none; }\n.aur-bg-custom { position: absolute; inset: 0; display: none; overflow: hidden; }\n.aur-root[data-bg=\"custom\"] .aur-bg-custom { display: block; }\n.aur-bg-custom > img,\n.aur-bg-custom > video {\nposition: absolute;\ninset: 0;\nwidth: 100%;\nheight: 100%;\nobject-fit: cover;\nfilter: blur(var(--aur-cblur, 0px));\ntransform: scale(calc(1 + var(--aur-cblur, 0px) / 400px));\nopacity: 0;\ntransition: opacity 0.8s ease;\n}\n.aur-bg-custom > .is-on { opacity: 1; }\n.aur-media { display: flex; flex-direction: column; gap: 10px; }\n.aur-media-name { font-size: 13px; color: rgba(255, 255, 255, 0.65); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }\n.aur-media-actions { display: flex; flex-wrap: wrap; gap: 8px; }\n.aur-float[data-next=\"off\"] .aur-float-next { display: none; }\n.aur-float[data-style=\"compact\"] { width: auto; max-width: min(460px, calc(100vw - 16px)); min-height: 42px; padding: 8px 18px; border-radius: 99px; }\n.aur-float[data-style=\"compact\"] .aur-float-art { display: none; }\n.aur-float[data-style=\"compact\"] .aur-float-cur { font-size: 15px; -webkit-line-clamp: 1; }\n.aur-float[data-style=\"compact\"] .aur-float-next { display: none; }\n.aur-float[data-style=\"bar\"] { width: min(920px, calc(100vw - 16px)); min-height: 76px; padding: 12px 28px; border-radius: 14px; text-align: center; background: linear-gradient(180deg, rgba(20, 20, 26, 0.9), rgba(8, 8, 12, 0.92)); }\n.aur-float[data-style=\"bar\"] .aur-float-art { display: none; }\n.aur-float[data-style=\"bar\"] .aur-float-cur { font-size: 24px; }\n.aur-float[data-style=\"bar\"] .aur-float-text::after {\ncontent: \"\";\ndisplay: block;\nheight: 2px;\nmargin: 8px auto 0;\nwidth: 40%;\nborder-radius: 2px;\nbackground: linear-gradient(90deg, transparent, color-mix(in oklab, var(--float-c) 40%, #fff), transparent);\nopacity: 0.6;\n}\n.aur-float[data-style=\"bare\"] { background: none; border-color: transparent; box-shadow: none; backdrop-filter: none; }\n.aur-float[data-style=\"bare\"] .aur-float-art { display: none; }\n.aur-float[data-style=\"bare\"] .aur-float-cur { font-size: 22px; text-shadow: 0 2px 12px rgba(0, 0, 0, 0.85), 0 0 2px rgba(0, 0, 0, 0.9); }\n.aur-float[data-style=\"bare\"] .aur-float-next { text-shadow: 0 1px 8px rgba(0, 0, 0, 0.9); color: rgba(255, 255, 255, 0.7); }\n.aur-float[data-style=\"bare\"] .aur-float-w { filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.85)); }\n.aur-float[data-style=\"bare\"]:hover { background: rgba(0, 0, 0, 0.25); }\n.aur-float[data-style=\"neon\"] {\nbackground: rgba(10, 8, 18, 0.88);\nborder: 1px solid color-mix(in oklab, var(--float-c) 40%, #ff4fd8);\nbox-shadow: 0 0 22px color-mix(in oklab, var(--float-c) 35%, rgba(255, 79, 216, 0.45)), inset 0 0 18px color-mix(in oklab, var(--float-c) 20%, rgba(255, 79, 216, 0.15));\n}\n.aur-float[data-style=\"neon\"] .aur-float-w.sung,\n.aur-float[data-style=\"neon\"] .aur-float-cur:not(:has(.aur-float-w:not([hidden]))) { color: #fff; text-shadow: 0 0 10px rgba(255, 120, 230, 0.7); }\n.aur-share-clip.is-recording { background: rgba(255, 70, 90, 0.2) !important; box-shadow: inset 0 0 0 1px rgba(255, 90, 110, 0.6); }\n.aur-share-clip.is-recording svg { color: #ff5a6e; animation: aur-rec-pulse 1s ease-in-out infinite; }\n@keyframes aur-rec-pulse { 50% { opacity: 0.35; } }\n.aur-root[data-glass=\"on\"] {\n--g-tint: rgba(255, 255, 255, 0.055);\n--g-tint-top: rgba(255, 255, 255, 0.15);\n--g-lit: rgba(255, 255, 255, 0.42);\n--g-hair: rgba(255, 255, 255, 0.1);\n--g-rim-a: rgba(255, 255, 255, 0.72);\n--g-rim-b: rgba(255, 255, 255, 0.06);\n--g-shadow: rgba(3, 3, 12, 0.45);\n--g-glow: color-mix(in oklab, var(--aur-glow-tint) 30%, transparent);\n--g-blur: 22px;\n--g-sat: 1.7;\n--g-bright: 1.05;\n--g-bf: blur(var(--g-blur)) saturate(var(--g-sat)) brightness(var(--g-bright));\n--g-rf-s: url(#aur-rf-s);\n--g-rf-m: url(#aur-rf-m);\n--g-rf-l: url(#aur-rf-l);\n--g-body: linear-gradient(180deg, var(--g-tint-top), var(--g-tint) 46%, rgba(255, 255, 255, 0.015));\n--g-rim: linear-gradient(140deg, var(--g-rim-a), var(--g-rim-b) 26%, var(--g-rim-b) 64%, var(--g-rim-a) 100%);\n--g-edge: inset 0 1px 0 var(--g-lit), inset 0 -1px 0 rgba(255, 255, 255, 0.07), inset 0 0 0 1px var(--g-hair);\n--g-ink: #fff;\n--g-ink-dim: rgba(255, 255, 255, 0.62);\n--g-play: linear-gradient(180deg, #fff, #e9ecf6);\n--g-play-ink: #0b0b10;\n--g-ease: cubic-bezier(0.34, 1.32, 0.52, 1);\n}\n.aur-root[data-glass=\"on\"]:is([data-refract=\"off\"], [data-lite=\"on\"]) { --g-rf-s: ; --g-rf-m: ; --g-rf-l: ; }\n.aur-root[data-glass=\"on\"] :is(.aur-player-center, .aur-player-side, .aur-header, .aur-upnext, .aur-toast)::before {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nborder-radius: inherit;\n}\n.aur-root[data-glass=\"on\"] :is(.aur-player-center, .aur-player-side, .aur-header, .aur-upnext, .aur-toast)::before,\n.aur-root[data-glass=\"on\"] .aur-lens-rim {\npadding: 1px;\nbackground: var(--g-rim);\n-webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);\n-webkit-mask-composite: xor;\nmask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);\npointer-events: none;\n}\n.aur-lens {\n--lens-px: 0.62em;\n--lens-py: 0.3em;\n--lens-r: min(0.66em, 46px);\ndisplay: none;\nposition: absolute;\nleft: 0;\ntop: 0;\nwidth: var(--lw, 0px);\nheight: var(--lh, 0px);\nfont-size: var(--lf, 56px);\ntransform: translate3d(var(--lx, 0px), var(--ly, 0px), 0);\ntransition: transform 0.9s var(--g-ease, ease), width 0.9s var(--g-ease, ease), height 0.9s var(--g-ease, ease);\npointer-events: none;\n}\n.aur-root[data-glass=\"on\"] .aur-lens { display: block; }\n.aur-lens.is-snap { transition: none; }\n.aur-lens[data-state=\"gap\"] { --lens-px: 0.5em; --lens-py: 0.26em; --lens-r: 999px; }\n.aur-lens > i {\nposition: absolute;\ninset: calc(var(--lens-py) * -1) calc(var(--lens-px) * -1);\nborder-radius: var(--lens-r);\ntransition: opacity 0.45s ease;\n}\n.aur-lens[data-state=\"none\"] > i,\n.aur-lens[data-browse=\"on\"] > i { opacity: 0; }\n.aur-lens-pane {\nbackground: var(--g-body);\nbackdrop-filter: var(--g-rf-l) var(--g-bf);\nbox-shadow: var(--g-edge), inset 0 0 30px rgba(255, 255, 255, 0.045), 0 26px 60px -18px var(--g-shadow), 0 0 44px -10px var(--g-glow);\n}\n.aur-lens-sheen {\noverflow: hidden;\nbackground: linear-gradient(104deg, transparent 34%, rgba(255, 255, 255, 0.2) 47%, rgba(255, 255, 255, 0.05) 55%, transparent 68%) 160% 0 / 240% 100% no-repeat;\n}\n.aur-root[data-lb=\"a\"] .aur-lens-sheen { animation: aur-lens-sweep-a 1.5s cubic-bezier(0.3, 0.6, 0.3, 1); }\n.aur-root[data-lb=\"b\"] .aur-lens-sheen { animation: aur-lens-sweep-b 1.5s cubic-bezier(0.3, 0.6, 0.3, 1); }\n@keyframes aur-lens-sweep-a { from { background-position-x: 160%; } to { background-position-x: -60%; } }\n@keyframes aur-lens-sweep-b { from { background-position-x: 160%; } to { background-position-x: -60%; } }\n.aur-lens-line {\ninset: auto calc(var(--lens-px) * -1 + 1.1em) calc(var(--lens-py) * -1 + 0.16em) !important;\nheight: 2px;\nborder-radius: 2px !important;\nbackground: linear-gradient(90deg, rgba(255, 255, 255, 0.9) calc(var(--lp, 0) * 100%), rgba(255, 255, 255, 0.14) calc(var(--lp, 0) * 100%));\nopacity: 0;\n}\n.aur-root[data-glass=\"on\"][data-motion=\"full\"][data-lb=\"a\"] .aur-lens { animation: aur-lens-jelly-a 0.95s cubic-bezier(0.3, 0.7, 0.3, 1); }\n.aur-root[data-glass=\"on\"][data-motion=\"full\"][data-lb=\"b\"] .aur-lens { animation: aur-lens-jelly-b 0.95s cubic-bezier(0.3, 0.7, 0.3, 1); }\n@keyframes aur-lens-jelly-a { 0% { scale: 1; } 26% { scale: 1.016 0.958; } 56% { scale: 0.993 1.024; } 100% { scale: 1; } }\n@keyframes aur-lens-jelly-b { 0% { scale: 1; } 26% { scale: 1.016 0.958; } 56% { scale: 0.993 1.024; } 100% { scale: 1; } }\n.aur-root[data-motion=\"reduced\"] .aur-lens { transition: none; }\n.aur-root[data-motion=\"reduced\"] .aur-lens-sheen { animation: none; }\n.aur-root[data-glass=\"on\"] .aur-player { column-gap: 18px; padding-bottom: 22px; }\n@media (min-width: 781px) {\n.aur-root[data-glass=\"on\"] .aur-player { grid-template-columns: minmax(min-content, 1fr) minmax(300px, 600px) minmax(min-content, 1fr); }\n}\n.aur-root[data-glass=\"on\"] .aur-player-center,\n.aur-root[data-glass=\"on\"] .aur-player-side {\nposition: relative;\nbackground: var(--g-body);\nbackdrop-filter: var(--g-rf-m) var(--g-bf);\nbox-shadow: var(--g-edge), 0 22px 50px -14px var(--g-shadow), 0 0 36px -12px var(--g-glow);\n}\n.aur-root[data-glass=\"on\"] .aur-player-center { gap: 3px; padding: 11px 26px 9px; border-radius: 32px; }\n.aur-root[data-glass=\"on\"] .aur-player-side { height: 54px; padding: 0 12px; border-radius: 999px; align-self: end; margin-bottom: 4px; }\n.aur-root[data-glass=\"on\"] .aur-player-side.is-left { justify-self: start; }\n.aur-root[data-glass=\"on\"] .aur-player-side.is-right { justify-self: end; }\n.aur-root[data-glass=\"on\"]:not([data-transport=\"off\"]) .aur-stage { bottom: 132px; }\n.aur-root[data-glass=\"on\"] .aur-progress-track {\nheight: 5px;\nmargin-top: -2.5px;\nbackground: rgba(255, 255, 255, 0.11);\nbox-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.4), 0 0 0 0.5px rgba(255, 255, 255, 0.07);\n}\n.aur-root[data-glass=\"on\"] .aur-progress:hover .aur-progress-track,\n.aur-root[data-glass=\"on\"] .aur-progress.is-scrubbing .aur-progress-track { height: 7px; margin-top: -3.5px; background: rgba(255, 255, 255, 0.16); }\n.aur-root[data-glass=\"on\"] .aur-progress-fill {\nbackground: linear-gradient(90deg, color-mix(in oklab, var(--aur-glow-tint) 70%, #fff), #fff);\nbox-shadow: 0 0 14px color-mix(in oklab, var(--aur-glow-tint) 65%, transparent);\n}\n.aur-root[data-glass=\"on\"] .aur-progress-knob {\nwidth: 15px;\nheight: 15px;\nmargin-top: -7.5px;\nleft: -7.5px;\nbackground: radial-gradient(circle at 34% 28%, #fff, #eef1fa 55%, #cdd3e6);\nbox-shadow: 0 2px 8px rgba(0, 0, 0, 0.4), 0 0 0 4px color-mix(in oklab, var(--aur-glow-tint) 24%, transparent), inset 0 -2px 3px rgba(0, 0, 0, 0.14);\n}\n.aur-root[data-glass=\"on\"] .aur-time { color: var(--g-ink-dim); }\n.aur-root[data-glass=\"on\"] .aur-play-btn {\nbackground: var(--g-play);\ncolor: var(--g-play-ink);\nbox-shadow:\ninset 0 1px 0 #fff,\ninset 0 -8px 14px rgba(40, 50, 90, 0.16),\n0 10px 26px rgba(0, 0, 0, 0.34),\n0 0 30px -4px color-mix(in oklab, var(--aur-glow-tint) 55%, transparent);\n}\n.aur-root[data-glass=\"on\"] .aur-play-btn:hover {\nbox-shadow:\ninset 0 1px 0 #fff,\ninset 0 -8px 14px rgba(40, 50, 90, 0.16),\n0 12px 30px rgba(0, 0, 0, 0.36),\n0 0 0 7px color-mix(in oklab, var(--aur-glow-tint) 18%, transparent),\n0 0 36px -2px color-mix(in oklab, var(--aur-glow-tint) 65%, transparent);\n}\n.aur-root[data-glass=\"on\"] .aur-icon-btn { color: var(--g-ink-dim); }\n.aur-root[data-glass=\"on\"] .aur-icon-btn:hover { background: rgba(255, 255, 255, 0.13); color: #fff; }\n.aur-root[data-glass=\"on\"] .aur-source { background: rgba(255, 255, 255, 0.09); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06); }\n.aur-root[data-glass=\"on\"] .aur-source:hover { background: rgba(255, 255, 255, 0.16); }\n.aur-root[data-glass=\"on\"] .aur-offset-group { background: rgba(255, 255, 255, 0.07); }\n.aur-root[data-glass=\"on\"] .aur-player-side .aur-sep { background: rgba(255, 255, 255, 0.16); }\n@media (max-width: 1180px) {\n.aur-root[data-glass=\"on\"] .aur-player { column-gap: 10px; }\n.aur-root[data-glass=\"on\"] .aur-player-side { padding: 0 6px; }\n.aur-root[data-glass=\"on\"] .aur-player-side .aur-icon-btn { width: 32px; height: 32px; }\n.aur-root[data-glass=\"on\"] .aur-player-center { padding-inline: 18px; }\n}\n@media (max-width: 960px) {\n.aur-root[data-glass=\"on\"] .aur-player { grid-template-columns: minmax(min-content, 1fr) minmax(240px, 600px) minmax(min-content, 1fr); }\n.aur-root[data-glass=\"on\"] .aur-transport { gap: 8px; }\n.aur-root[data-glass=\"on\"] .aur-play-btn { width: 50px; height: 50px; }\n.aur-root[data-glass=\"on\"] .aur-source { max-width: 120px; }\n.aur-root[data-glass=\"on\"] .aur-player-side .aur-icon-btn { width: 30px; height: 30px; }\n}\n@media (max-width: 780px) {\n.aur-root[data-glass=\"on\"] .aur-player-side { height: 48px; padding: 0 6px; }\n.aur-root[data-glass=\"on\"] .aur-player-center { padding: 8px 14px 6px; border-radius: 26px; }\n.aur-root[data-glass=\"on\"]:not([data-transport=\"off\"]) .aur-stage { bottom: 112px; }\n}\n.aur-root[data-glass=\"on\"] .aur-header {\npadding: 7px 20px 7px 7px;\nborder-radius: 22px;\nbackground: var(--g-body);\nbackdrop-filter: var(--g-rf-s) var(--g-bf);\nbox-shadow: var(--g-edge), 0 18px 40px -14px var(--g-shadow);\n}\n.aur-root[data-glass=\"on\"] .aur-cover { width: 46px; height: 46px; border-radius: 15px; box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4), inset 0 0 0 1px rgba(255, 255, 255, 0.14); }\n.aur-root[data-glass=\"on\"] .aur-artist { color: var(--g-ink-dim); }\n.aur-root[data-glass=\"on\"]:not([data-view=\"poster\"]) .aur-art-wrap {\n--cover-r: clamp(18px, 3.2vh, 32px);\n--cover-pad: clamp(7px, 1.3vh, 13px);\nisolation: isolate;\nborder-radius: var(--cover-r);\nbox-shadow: 0 40px 80px -24px var(--g-shadow), 0 0 60px -20px var(--g-glow) !important;\n}\n.aur-root[data-glass=\"on\"]:not([data-view=\"poster\"]) .aur-art-wrap::before {\ncontent: \"\";\nposition: absolute;\ninset: calc(var(--cover-pad) * -1);\nz-index: -1;\nborder-radius: calc(var(--cover-r) + var(--cover-pad));\nbackground: var(--g-body);\nbackdrop-filter: var(--g-rf-l) var(--g-bf);\nbox-shadow: var(--g-edge);\n}\n.aur-root[data-glass=\"on\"]:not([data-view=\"poster\"]) .aur-art-wrap::after {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nborder-radius: inherit;\nbackground:\nlinear-gradient(128deg, rgba(255, 255, 255, 0.26), rgba(255, 255, 255, 0.04) 34%, transparent 52%),\nlinear-gradient(0deg, rgba(0, 0, 0, 0.16), transparent 28%);\nbox-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16), inset 0 1px 0 rgba(255, 255, 255, 0.4);\npointer-events: none;\n}\n.aur-root[data-glass=\"on\"][data-view=\"vinyl\"] .aur-art-wrap { --cover-r: 50%; }\n.aur-root[data-glass=\"on\"][data-view=\"vinyl\"] .aur-art-wrap::before { border-radius: 50%; }\n.aur-root[data-glass=\"on\"][data-view=\"poster\"] .aur-side-meta { text-shadow: 0 2px 24px rgba(0, 0, 0, 0.5); }\n.aur-root[data-glass=\"on\"] .aur-side-artist { color: var(--g-ink-dim); }\n.aur-root[data-glass=\"on\"] .aur-upnext {\nbackground: var(--g-body);\nbackdrop-filter: var(--g-rf-s) var(--g-bf);\nborder: 0;\nbox-shadow: var(--g-edge), 0 18px 44px -14px var(--g-shadow);\n}\n.aur-root[data-glass=\"on\"] .aur-upnext:hover { background: linear-gradient(180deg, rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.08)); }\n.aur-root[data-glass=\"on\"] .aur-toast {\nbackground: var(--g-body);\nbackdrop-filter: var(--g-bf);\nborder: 0;\nbox-shadow: var(--g-edge), 0 18px 44px -14px var(--g-shadow);\n}\n.aur-root[data-look=\"gothic\"] {\n--gt-bone: #efe4d2;\n--gt-gold: #d9b878;\n--gt-lead: #140a0b;\n--aur-glow-tint: color-mix(in oklab, var(--aur-accent) 55%, #ffd9b0);\n--g-tint: rgba(20, 8, 12, 0.6);\n--g-tint-top: rgba(255, 214, 170, 0.07);\n--g-lit: rgba(255, 214, 160, 0.34);\n--g-hair: rgba(255, 200, 140, 0.13);\n--g-rim-a: rgba(255, 214, 160, 0.6);\n--g-rim-b: rgba(150, 70, 50, 0.12);\n--g-shadow: rgba(2, 0, 3, 0.7);\n--g-glow: color-mix(in oklab, var(--aur-accent) 30%, transparent);\n--g-blur: 14px;\n--g-sat: 1.4;\n--g-bright: 0.82;\n--g-play: linear-gradient(180deg, #fff6e6, #e6d2b0);\n--g-play-ink: #2a0d10;\n--lens-px: 0.85em;\n--lens-py: 0.36em;\n--lens-r: 14px;\n}\n.aur-root[data-look=\"gothic\"][data-color=\"white\"] { --aur-hi: var(--gt-bone); }\n.aur-root[data-fx=\"gothic\"] .aur-fx {\nbackground:\nradial-gradient(50% 42% at 50% -8%, color-mix(in oklab, var(--aur-accent) 32%, transparent), transparent 70%),\nradial-gradient(26% 60% at 5% 100%, rgba(255, 164, 72, 0.28), transparent 72%),\nradial-gradient(26% 60% at 95% 100%, rgba(255, 164, 72, 0.28), transparent 72%),\n#0a0507;\n}\n.aur-root[data-look=\"gothic\"] .aur-lens-pane {\nbackground: linear-gradient(180deg, rgba(255, 214, 170, 0.06), rgba(16, 6, 10, 0.64) 38%, rgba(10, 4, 7, 0.72));\nbox-shadow: inset 0 0 44px rgba(0, 0, 0, 0.55), 0 30px 70px -20px var(--g-shadow), 0 0 56px -12px var(--g-glow);\n}\n.aur-root[data-look=\"gothic\"] .aur-lens-rim {\npadding: 0;\n-webkit-mask: none;\nmask: none;\nbackground: none;\nborder: max(3px, 0.075em) solid var(--gt-lead);\nbox-shadow:\n0 0 0 1px rgba(255, 214, 160, 0.22),\ninset 0 0 0 1px rgba(255, 214, 160, 0.16),\ninset 0 0 16px rgba(0, 0, 0, 0.6);\n}\n.aur-root[data-look=\"gothic\"] .aur-lens-sheen {\nanimation: none !important;\nbackground:\nrepeating-linear-gradient(45deg, transparent 0 calc(0.7em - 1px), rgba(20, 9, 10, 0.62) calc(0.7em - 1px) 0.7em),\nrepeating-linear-gradient(-45deg, transparent 0 calc(0.7em - 1px), rgba(20, 9, 10, 0.62) calc(0.7em - 1px) 0.7em);\nborder-radius: calc(var(--lens-r) - 3px);\ninset: calc(var(--lens-py) * -1 + 3px) calc(var(--lens-px) * -1 + 3px);\n}\n.aur-root[data-look=\"gothic\"] .aur-lens .aur-lens-line {\ninset: auto auto calc(var(--lens-py) * -1 - 0.34em) 50% !important;\nwidth: 1.9em;\nheight: 0.68em;\nmargin-left: -0.95em;\nborder-radius: 999px !important;\nbackground: var(--gt-lead);\nborder: 1px solid rgba(255, 214, 160, 0.4);\nbox-shadow: 0 0 0 2px rgba(0, 0, 0, 0.5), 0 4px 14px rgba(0, 0, 0, 0.6);\ndisplay: grid;\nplace-items: center;\n}\n.aur-root[data-look=\"gothic\"] .aur-lens .aur-lens-line::after {\ncontent: \"❦\";\nfont: 400 0.42em/1 Georgia, \"Segoe UI Symbol\", serif;\ncolor: color-mix(in oklab, var(--aur-accent) 60%, var(--gt-bone));\ntext-shadow: 0 0 0.6em color-mix(in oklab, var(--aur-accent) 70%, transparent);\n}\n.aur-root[data-look=\"gothic\"] .aur-lens[data-state=\"line\"] .aur-lens-line { opacity: 1; }\n.aur-root[data-look=\"gothic\"]:not([data-view=\"poster\"]) .aur-art-wrap { --cover-r: clamp(6px, 1vh, 10px); --cover-pad: clamp(7px, 1.2vh, 12px); }\n.aur-root[data-look=\"gothic\"]:not([data-view=\"poster\"]) .aur-art-wrap::before {\nbackground: linear-gradient(180deg, rgba(255, 214, 170, 0.05), rgba(14, 5, 9, 0.7));\nborder: max(3px, 0.55vh) solid var(--gt-lead);\nbox-shadow: 0 0 0 1px rgba(255, 214, 160, 0.24), inset 0 0 0 1px rgba(255, 214, 160, 0.16), inset 0 0 18px rgba(0, 0, 0, 0.6);\n}\n.aur-root[data-look=\"gothic\"] .aur-stage .aur-line { letter-spacing: 0.01em; }\n.aur-root[data-look=\"gothic\"] .aur-dots i {\nborder-radius: 1px;\nrotate: 45deg;\nbackground: color-mix(in oklab, var(--aur-accent) 75%, var(--gt-bone));\nbox-shadow: 0 0 0.35em color-mix(in oklab, var(--aur-accent) 55%, transparent);\n}\n.aur-root[data-look=\"gothic\"] :is(.aur-side-title, .aur-title) { font-family: var(--aur-font); letter-spacing: 0.01em; }\n.aur-root[data-look=\"karaoke\"] {\n--ktv-edge: #0c1542;\n--ktv-sung: oklch(from var(--aur-accent) 0.7 max(c, 0.2) h);\n--ktv-a: oklch(from var(--aur-accent) 0.72 max(c, 0.2) h);\n--ktv-b: #5ee1ff;\n--ktv-c: #b48cff;\n--ktv-row-gap: 0.42em;\n--ktv-half: calc(var(--ktv-row-gap) + var(--aur-gap) / 2 + 1.16em + 0.3em);\n--ktv-white: linear-gradient(180deg, #fff 0%, #f2f6ff 46%, #b7c5ee 100%);\n--ktv-hot: linear-gradient(180deg, color-mix(in oklab, var(--ktv-sung) 38%, #fff) 0%, var(--ktv-sung) 44%, color-mix(in oklab, var(--ktv-sung) 68%, #2a0a4a) 100%);\n--aur-glow-tint: var(--ktv-a);\n--g-tint: rgba(54, 16, 100, 0.42);\n--g-tint-top: rgba(255, 255, 255, 0.18);\n--g-lit: rgba(255, 255, 255, 0.62);\n--g-hair: color-mix(in oklab, var(--ktv-a) 36%, transparent);\n--g-rim-a: #fff;\n--g-rim-b: color-mix(in oklab, var(--ktv-a) 40%, transparent);\n--g-shadow: rgba(6, 0, 24, 0.55);\n--g-glow: color-mix(in oklab, var(--ktv-a) 48%, transparent);\n--g-blur: 20px;\n--g-sat: 1.9;\n}\n.aur-root[data-look=\"karaoke\"][data-duet=\"on\"] .aur-line[data-singer] { --ktv-sung: var(--aur-kink); }\n.aur-root[data-fx=\"karaoke\"] .aur-fx {\nbackground:\nradial-gradient(60% 46% at 50% 30%, color-mix(in oklab, var(--ktv-a) 22%, transparent), transparent 72%),\nradial-gradient(50% 40% at 88% 10%, color-mix(in oklab, var(--ktv-c) 26%, transparent), transparent 70%),\nlinear-gradient(to bottom, #07031a, #0e062c 52%, #060316);\n}\n.aur-root[data-look=\"karaoke\"] .aur-art-wrap { --cover-r: clamp(12px, 2vh, 20px); }\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-lens { display: none; }\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] { -webkit-mask-image: none; mask-image: none; overflow: visible; }\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-lines {\nleft: max(var(--aur-pad), 50% - 800px);\nright: max(var(--aur-pad), 50% - 800px);\n}\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-lines::before,\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-lines::after {\ncontent: \"\";\nposition: absolute;\nleft: -0.5em;\nright: -0.5em;\ntop: calc(50% - var(--ktv-half));\nheight: calc(var(--ktv-half) * 2);\nfont-size: var(--aur-size);\nborder-radius: min(0.85em, 48px);\npointer-events: none;\ntransition: opacity 0.6s ease;\n}\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-lines::before {\nbackground:\nlinear-gradient(180deg, rgba(255, 255, 255, 0.24), rgba(255, 255, 255, 0.05) 49%, transparent 49.6%),\nvar(--g-body);\nbackdrop-filter: var(--g-rf-l) var(--g-bf);\nbox-shadow: var(--g-edge), 0 30px 70px -22px var(--g-shadow), 0 0 80px -16px var(--g-glow);\n}\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-lines::after {\npadding: 1px;\nbackground: var(--g-rim);\n-webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);\n-webkit-mask-composite: xor;\nmask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);\n}\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"][data-gap=\"on\"][data-soon=\"off\"] .aur-stage[data-mode=\"synced\"] .aur-lines::before,\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"][data-gap=\"on\"][data-soon=\"off\"] .aur-stage[data-mode=\"synced\"] .aur-lines::after { opacity: 0.4; }\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"][data-intro=\"on\"][data-soon=\"off\"] .aur-stage[data-mode=\"synced\"] .aur-lines::before,\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"][data-intro=\"on\"][data-soon=\"off\"] .aur-stage[data-mode=\"synced\"] .aur-lines::after { opacity: 1; }\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line.aur-line[data-row] {\ntop: auto;\nbottom: auto;\nmax-width: none;\nmargin: 0;\nopacity: 0;\ntransform: none;\nfilter: none;\npointer-events: none;\ntransition: opacity 0.22s ease, translate 0.22s ease, color 0.3s ease;\n}\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line.aur-line[data-row=\"0\"] { bottom: calc(50% + var(--ktv-row-gap)); left: 0; right: 16%; text-align: left; translate: -1.4em 0; }\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line.aur-line[data-row=\"1\"] { top: calc(50% + var(--ktv-row-gap)); left: 16%; right: 0; text-align: right; translate: 1.4em 0; }\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line.aur-line[data-row].is-active,\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line.aur-line[data-row][data-d=\"1\"]:not(.is-gap) {\nopacity: 1 !important;\ntranslate: 0 0;\npointer-events: auto;\n}\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line.aur-line[data-row][data-d=\"1\"]:not(.is-gap) { transition: opacity 0.35s ease 0.2s, translate 0.6s var(--aur-ease) 0.2s, color 0.3s ease; }\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"][data-gap=\"on\"][data-soon=\"off\"] .aur-stage[data-mode=\"synced\"] .aur-line.aur-line[data-row] { opacity: 0 !important; }\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line.aur-line.is-gap[data-row] { padding: 0; line-height: 0; translate: 0 0; }\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-gap .aur-dots { height: 0.5em; }\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line.aur-line.is-gap[data-row=\"0\"] { bottom: calc(50% + var(--ktv-row-gap) + 1.16em + var(--aur-gap) / 2 + 0.12em); }\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line.aur-line.is-gap[data-row=\"1\"] { top: auto; bottom: calc(50% - var(--ktv-row-gap) - var(--aur-gap) / 2 + 0.12em); left: 16%; right: 0; text-align: right; }\n.aur-root[data-look=\"karaoke\"][data-color=\"white\"] { --aur-hi: #fff; }\n.aur-root[data-look=\"karaoke\"] .aur-stage[data-mode=\"synced\"] .aur-main {\n-webkit-text-stroke: 0.07em var(--ktv-edge);\npaint-order: stroke fill;\nfilter: drop-shadow(0 0.05em 0.03em rgba(0, 0, 10, 0.6));\n}\n.aur-root[data-look=\"karaoke\"][data-view=\"captions\"] .aur-stage { --aur-size: min(var(--aur-fs), 5vw, 6.9vh); }\n.aur-root[data-look=\"karaoke\"][data-view=\"captions\"] .aur-side-title { font-size: clamp(20px, 2.8vh, 30px); font-weight: 900; color: #fff; text-shadow: 0 2px 12px rgba(0, 0, 12, 0.7); }\n.aur-root[data-look=\"karaoke\"][data-view=\"captions\"] .aur-side-artist { font-size: clamp(14px, 1.9vh, 20px); font-weight: 800; letter-spacing: 0.03em; color: color-mix(in oklab, var(--ktv-a) 45%, #fff); text-shadow: 0 2px 10px rgba(0, 0, 12, 0.7); }\n.aur-root[data-look=\"karaoke\"][data-view=\"captions\"] .aur-side-album { color: rgba(255, 255, 255, 0.55); }\n.aur-root[data-look=\"karaoke\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-active) .aur-main {\ncolor: transparent;\nbackground: var(--ktv-white);\n-webkit-background-clip: text;\nbackground-clip: text;\n}\n.aur-root[data-look=\"karaoke\"][data-words=\"on\"] .aur-stage .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\ncolor: transparent;\nbackground:\nlinear-gradient(90deg, transparent, color-mix(in srgb, #fff calc(sin(var(--p) * 3.14159) * 95%), transparent), transparent) calc(var(--p) * 100%) 0 / 0.18em 100% no-repeat,\nvar(--ktv-hot) 0 0 / calc(var(--p) * 100%) 100% no-repeat,\nvar(--ktv-white) 0 0 / 100% 100% no-repeat;\n-webkit-background-clip: text;\nbackground-clip: text;\ntransform: none;\nfilter: none;\n}\n.aur-root[data-look=\"karaoke\"] .aur-stage .is-active:not(.has-words) .aur-main,\n.aur-root[data-look=\"karaoke\"][data-words=\"off\"] .aur-stage .is-active .aur-main {\ncolor: transparent;\nbackground: var(--ktv-hot);\n-webkit-background-clip: text;\nbackground-clip: text;\n}\n.aur-root[data-look=\"karaoke\"][data-words=\"on\"] .aur-stage .is-active.has-words .aur-w.now { position: relative; }\n.aur-root[data-look=\"karaoke\"][data-words=\"on\"] .aur-stage .is-active.has-words .aur-w.now::after {\n--g: calc(1 - 4 * var(--aur-wp) * (1 - var(--aur-wp)));\ncontent: \"\";\nposition: absolute;\nleft: calc(var(--aur-wp) * 100%);\nbottom: calc(100% - 0.16em);\nwidth: 0.36em;\nheight: 0.36em;\nmargin-left: -0.18em;\nborder-radius: 50%;\nbackground:\nradial-gradient(circle at 32% 26%, #fff 0 9%, rgba(255, 255, 255, 0.35) 18%, transparent 34%),\nradial-gradient(circle at 50% 56%, color-mix(in oklab, var(--ktv-sung) 70%, #fff) 0, var(--ktv-sung) 46%, color-mix(in oklab, var(--ktv-sung) 55%, #12062c) 100%);\nbox-shadow: inset 0 -0.05em 0.08em rgba(255, 255, 255, 0.45), 0 0 0 0.04em var(--ktv-edge), 0 0 0.5em color-mix(in oklab, var(--ktv-sung) 75%, transparent);\ntranslate: 0 calc(-0.5em * (1 - var(--g)));\nscale: calc(1 + 0.3 * var(--g) * var(--g)) calc(1 - 0.28 * var(--g) * var(--g));\ntransform-origin: 50% 100%;\npointer-events: none;\n}\n.aur-root[data-look=\"karaoke\"] .aur-dots { gap: 0.24em; }\n.aur-root[data-look=\"karaoke\"] .aur-dots i {\nwidth: 0.36em;\nheight: 0.36em;\nbackground:\nradial-gradient(circle at 32% 26%, #fff 0 10%, rgba(255, 255, 255, 0.3) 20%, transparent 36%),\nradial-gradient(circle at 50% 56%, color-mix(in oklab, var(--ktv-sung) 70%, #fff) 0, var(--ktv-sung) 46%, color-mix(in oklab, var(--ktv-sung) 60%, #1a0840) 100%);\nbox-shadow: inset 0 -0.05em 0.08em rgba(255, 255, 255, 0.4), 0 0 0 0.05em #fff, 0 0 0 0.1em var(--ktv-edge), 0 0.08em 0.12em 0.1em rgba(0, 0, 12, 0.4);\n}\n.aur-root[data-look=\"karaoke\"] .is-active .aur-dots { animation: none; }\n.aur-root[data-look=\"karaoke\"] .is-active .aur-dots i:nth-child(3) { opacity: calc(1 - clamp(0, var(--aur-cd, 0) * 3, 1)); transform: scale(calc(1 - 0.5 * clamp(0, var(--aur-cd, 0) * 3, 1))); }\n.aur-root[data-look=\"karaoke\"] .is-active .aur-dots i:nth-child(2) { opacity: calc(1 - clamp(0, var(--aur-cd, 0) * 3 - 1, 1)); transform: scale(calc(1 - 0.5 * clamp(0, var(--aur-cd, 0) * 3 - 1, 1))); }\n.aur-root[data-look=\"karaoke\"] .is-active .aur-dots i:nth-child(1) { opacity: calc(1 - clamp(0, var(--aur-cd, 0) * 3 - 2, 1)); transform: scale(calc(1 - 0.5 * clamp(0, var(--aur-cd, 0) * 3 - 2, 1))); }\n.aur-root[data-look=\"karaoke\"] .aur-side-meta { transition: opacity 0.6s ease; }\n.aur-root[data-look=\"karaoke\"][data-intro=\"on\"][data-soon=\"off\"] .aur-side-meta { opacity: 0; }\n.aur-root[data-look=\"karaoke\"] .aur-stage[data-mode=\"synced\"]::before,\n.aur-root[data-look=\"karaoke\"] .aur-stage[data-mode=\"synced\"]::after {\nposition: absolute;\nleft: var(--aur-pad);\nright: var(--aur-pad);\ntext-align: center;\nwhite-space: nowrap;\noverflow: hidden;\ntext-overflow: ellipsis;\nfont-family: var(--aur-font);\npaint-order: stroke fill;\nopacity: 0;\ntransform: translateY(0.3em);\ntransition: opacity 0.6s ease, transform 0.8s var(--aur-ease);\npointer-events: none;\n}\n.aur-root[data-look=\"karaoke\"] .aur-stage[data-mode=\"synced\"]::before {\ncontent: attr(data-title);\nbottom: calc(50% + 0.1em);\nfont-size: calc(var(--aur-size) * 1.2);\nfont-weight: 900;\nline-height: 1.15;\ncolor: transparent;\nbackground: var(--ktv-white);\n-webkit-background-clip: text;\nbackground-clip: text;\n-webkit-text-stroke: 0.06em var(--ktv-edge);\nfilter: drop-shadow(0 0.05em 0.03em rgba(0, 0, 10, 0.6));\n}\n.aur-root[data-look=\"karaoke\"] .aur-stage[data-mode=\"synced\"]::after {\ncontent: attr(data-artist);\ntop: calc(50% + 0.5em);\nfont-size: calc(var(--aur-size) * 0.55);\nfont-weight: 800;\nletter-spacing: 0.04em;\ncolor: transparent;\nbackground: linear-gradient(180deg, color-mix(in oklab, var(--ktv-sung) 35%, #fff), var(--ktv-sung));\n-webkit-background-clip: text;\nbackground-clip: text;\n-webkit-text-stroke: 0.08em var(--ktv-edge);\n}\n.aur-root[data-look=\"karaoke\"][data-intro=\"on\"][data-soon=\"off\"] .aur-stage[data-mode=\"synced\"]::before,\n.aur-root[data-look=\"karaoke\"][data-intro=\"on\"][data-soon=\"off\"] .aur-stage[data-mode=\"synced\"]::after { opacity: 1; transform: none; transition-delay: 0.3s; }\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"][data-view=\"captions\"]:not([data-transport=\"off\"]) .aur-stage { top: 56vh; bottom: 150px; }\n.aur-root[data-look=\"minimal\"] {\n--g-tint: rgba(255, 255, 255, 0.045);\n--g-tint-top: rgba(255, 255, 255, 0.12);\n--g-blur: 26px;\n--g-sat: 1.25;\n--g-glow: rgba(255, 255, 255, 0.05);\n--lens-px: 0.7em;\n--lens-py: 0.34em;\n}\n.aur-root[data-look=\"minimal\"] .aur-bg-stack,\n.aur-root[data-look=\"minimal\"] .aur-bg-gradient { filter: saturate(0.3) brightness(0.8); }\n.aur-root[data-fx=\"minimal\"] .aur-bg-grain { opacity: 0.05; }\n.aur-root[data-fx=\"minimal\"] .aur-fx-a {\ndisplay: block;\ninset: 0;\nbackground:\nradial-gradient(60% 55% at 14% -6%, rgba(255, 255, 255, 0.09), transparent 70%),\nradial-gradient(70% 60% at 100% 110%, rgba(0, 0, 0, 0.4), transparent 70%),\nlinear-gradient(rgba(120, 138, 175, 0.07), rgba(120, 138, 175, 0.07));\n}\n.aur-root[data-fx=\"minimal\"] .aur-fx-b {\ndisplay: block;\ninset: -10% -60%;\nbackground: linear-gradient(100deg, transparent 43%, rgba(255, 255, 255, 0.045) 50%, transparent 57%);\nanimation: aur-mn-drift 52s ease-in-out infinite alternate;\n}\n@keyframes aur-mn-drift { from { transform: translateX(-17%); } to { transform: translateX(17%); } }\n.aur-root[data-look=\"minimal\"] .aur-line { letter-spacing: -0.028em; }\n.aur-root[data-look=\"minimal\"] .aur-lens[data-state=\"line\"] .aur-lens-line { opacity: 1; }\n.aur-root[data-look=\"minimal\"] .aur-dots i { width: 0.7em; height: 2px; border-radius: 1px; }\n.aur-root[data-look=\"minimal\"] .is-active .aur-dots { animation: none; }\n.aur-root[data-look=\"minimal\"] .is-active .aur-dots i { transform: none; }\n.aur-root[data-look=\"neon\"] {\n--neon-a: oklch(from var(--aur-accent) 0.74 max(c, 0.22) h);\n--neon-b: oklch(from var(--aur-accent) 0.8 max(c, 0.18) calc(h + 150));\n--neon-c: oklch(from var(--aur-accent) 0.76 max(c, 0.2) calc(h - 40));\n--neon: var(--neon-a);\n--unlit: color-mix(in oklab, color-mix(in oklab, var(--neon) 82%, #fff) 66%, transparent);\n--aur-glow-tint: var(--neon-a);\n--g-tint: rgba(9, 5, 20, 0.5);\n--g-tint-top: rgba(255, 255, 255, 0.075);\n--g-lit: color-mix(in oklab, var(--neon-a) 62%, #fff);\n--g-hair: color-mix(in oklab, var(--neon-a) 26%, transparent);\n--g-rim-a: color-mix(in oklab, var(--neon-a) 78%, #fff);\n--g-rim-b: color-mix(in oklab, var(--neon-b) 24%, transparent);\n--g-shadow: rgba(2, 0, 8, 0.6);\n--g-glow: color-mix(in oklab, var(--neon-a) 42%, transparent);\n--g-blur: 18px;\n--g-sat: 1.9;\n--g-bright: 0.92;\n--lens-px: 0.7em;\n--lens-py: 0.34em;\n--lens-r: min(0.72em, 50px);\n}\n.aur-root[data-fx=\"neon\"] .aur-fx {\nbackground:\nradial-gradient(60% 50% at 88% 6%, color-mix(in oklab, var(--neon-c) 34%, transparent), transparent 70%),\nradial-gradient(70% 55% at 12% 100%, color-mix(in oklab, var(--neon-a) 30%, transparent), transparent 72%),\nradial-gradient(50% 45% at 92% 92%, color-mix(in oklab, var(--neon-b) 26%, transparent), transparent 70%),\n#07040f;\n}\n.aur-fx > canvas.aur-fx-sc { position: absolute; inset: 0; width: 100%; height: 100%; display: none; }\n.aur-root[data-sc=\"on\"] .aur-fx > canvas.aur-fx-sc { display: block; }\n.aur-root[data-look=\"neon\"] .aur-lens-pane {\nbackground: linear-gradient(180deg, rgba(255, 255, 255, 0.07), rgba(10, 5, 22, 0.56) 55%, rgba(8, 4, 18, 0.62));\nbox-shadow:\ninset 0 0 36px color-mix(in oklab, var(--neon-a) 20%, transparent),\n0 0 70px -6px color-mix(in oklab, var(--neon-a) 32%, transparent);\n}\n.aur-root[data-look=\"neon\"] .aur-lens-rim {\npadding: 0;\n-webkit-mask: none;\nmask: none;\nbackground: none;\nborder: max(2px, 0.05em) solid color-mix(in oklab, var(--neon-a) 86%, #fff 14%);\nbox-shadow:\n0 0 0.12em 0.01em var(--neon-a),\n0 0 0.5em 0.04em color-mix(in oklab, var(--neon-a) 70%, transparent),\n0 0 1.6em 0.1em color-mix(in oklab, var(--neon-a) 34%, transparent),\ninset 0 0 0.3em color-mix(in oklab, var(--neon-a) 60%, transparent),\ninset 0 0 1.2em color-mix(in oklab, var(--neon-a) 20%, transparent);\n}\n.aur-root[data-look=\"neon\"] .aur-lens-rim::after {\ncontent: \"\";\nposition: absolute;\ninset: max(0px, calc(max(2px, 0.05em) * 0.18));\nborder-radius: inherit;\nborder: max(1px, 0.014em) solid rgba(255, 255, 255, 0.88);\nbox-shadow: 0 0 0.1em rgba(255, 255, 255, 0.7);\nopacity: 0.9;\n}\n.aur-root[data-look=\"neon\"] .aur-lens-sheen {\nbackground: linear-gradient(112deg, rgba(255, 255, 255, 0.11), transparent 22%, transparent 70%, color-mix(in oklab, var(--neon-b) 14%, transparent));\nanimation: none !important;\n}\n.aur-root[data-look=\"neon\"][data-motion=\"full\"][data-lb=\"a\"] .aur-lens-rim { animation: aur-nn-strike-a 0.6s steps(1); }\n.aur-root[data-look=\"neon\"][data-motion=\"full\"][data-lb=\"b\"] .aur-lens-rim { animation: aur-nn-strike-b 0.6s steps(1); }\n@keyframes aur-nn-strike-a { 0%, 14%, 30% { opacity: 0.25; } 8%, 22%, 40%, 100% { opacity: 1; } }\n@keyframes aur-nn-strike-b { 0%, 14%, 30% { opacity: 0.25; } 8%, 22%, 40%, 100% { opacity: 1; } }\n.aur-root[data-look=\"neon\"]:not([data-view=\"poster\"]) .aur-art-wrap { --cover-r: clamp(10px, 1.8vh, 18px); --cover-pad: clamp(8px, 1.5vh, 14px); }\n.aur-root[data-look=\"neon\"]:not([data-view=\"poster\"]) .aur-art-wrap::before {\nbackground: linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(10, 5, 22, 0.6));\nborder: max(2px, 0.5vh) solid color-mix(in oklab, var(--neon-a) 86%, #fff 14%);\noutline: max(1px, 0.18vh) solid rgba(255, 255, 255, 0.85);\noutline-offset: calc(max(2px, 0.5vh) * -0.62);\nbox-shadow:\n0 0 1.2vh 0.1vh var(--neon-a),\n0 0 4vh 0.4vh color-mix(in oklab, var(--neon-a) 62%, transparent),\n0 0 12vh 1.2vh color-mix(in oklab, var(--neon-a) 26%, transparent),\ninset 0 0 2.4vh color-mix(in oklab, var(--neon-a) 45%, transparent);\n}\n.aur-root[data-look=\"neon\"][data-playing=\"false\"]:not([data-view=\"poster\"]) .aur-art-wrap::before { opacity: 0.55; }\n.aur-root[data-look=\"neon\"][data-view=\"vinyl\"] .aur-art-wrap::before { border-radius: 50%; }\n.aur-root[data-look=\"neon\"][data-layout=\"list\"] .aur-line[data-d=\"-1\"], .aur-root[data-look=\"neon\"][data-layout=\"list\"] .aur-line[data-d=\"1\"] { opacity: 0.66; }\n.aur-root[data-look=\"neon\"][data-layout=\"list\"] .aur-line[data-d=\"-2\"], .aur-root[data-look=\"neon\"][data-layout=\"list\"] .aur-line[data-d=\"2\"] { opacity: 0.42; }\n.aur-root[data-look=\"neon\"][data-layout=\"list\"] .aur-line[data-d=\"-3\"], .aur-root[data-look=\"neon\"][data-layout=\"list\"] .aur-line[data-d=\"3\"] { opacity: 0.26; }\n.aur-root[data-look=\"neon\"][data-layout=\"list\"] .aur-line[data-d=\"-4\"], .aur-root[data-look=\"neon\"][data-layout=\"list\"] .aur-line[data-d=\"4\"] { opacity: 0.16; }\n.aur-root[data-look=\"neon\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-active) :is(.aur-main, .aur-w, .aur-c) {\ncolor: color-mix(in oklab, var(--neon) 6%, transparent);\n-webkit-text-stroke: 0.03em var(--unlit);\ntext-shadow: none;\n}\n.aur-root[data-look=\"neon\"][data-words=\"on\"] .aur-stage .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--lit: clamp(0, var(--e) * 5, 1);\ncolor: color-mix(in oklab, color-mix(in oklab, var(--neon) 20%, #fff) calc(var(--lit) * 100%), color-mix(in oklab, var(--neon) 8%, transparent));\n-webkit-text-stroke: 0.03em color-mix(in oklab, var(--neon) calc(var(--lit) * 100%), var(--unlit));\npaint-order: stroke fill;\ntransform: none;\nfilter:\ndrop-shadow(0 0 0.03em color-mix(in srgb, #fff calc(60% * var(--lit)), transparent))\ndrop-shadow(0 0 0.12em color-mix(in oklab, var(--neon) calc(85% * var(--lit)), transparent))\ndrop-shadow(0 0 0.34em color-mix(in oklab, var(--neon) calc(70% * var(--lit)), transparent));\n}\n.aur-root[data-look=\"neon\"][data-words=\"on\"] .aur-stage .is-active .aur-w.now { animation: aur-neon-on 0.5s linear; }\n.aur-root[data-look=\"neon\"] .aur-stage .is-active:not(.has-words) .aur-main,\n.aur-root[data-look=\"neon\"][data-words=\"off\"] .aur-stage .is-active .aur-main {\ncolor: color-mix(in oklab, var(--neon) 20%, #fff);\n-webkit-text-stroke: 0.014em var(--neon);\npaint-order: stroke fill;\ntext-shadow:\n0 0 0.04em rgba(255, 255, 255, 0.7),\n0 0 0.14em color-mix(in oklab, var(--neon) 90%, transparent),\n0 0 0.36em color-mix(in oklab, var(--neon) 75%, transparent),\n0 0 0.9em color-mix(in oklab, var(--neon) 45%, transparent);\n}\n.aur-root[data-look=\"neon\"][data-motion=\"full\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active:not(.has-words) .aur-main { animation: aur-nn-line 0.55s linear; }\n@keyframes aur-nn-line {\n0%, 18%, 38% { opacity: 0.25; }\n10%, 28%, 100% { opacity: 1; }\n}\n.aur-root[data-look=\"neon\"] .aur-dots i { background: color-mix(in oklab, var(--neon) 30%, #fff); box-shadow: 0 0 0.3em var(--neon), 0 0 0.8em color-mix(in oklab, var(--neon) 60%, transparent); }\n.aur-root[data-look=\"neon\"] :is(.aur-side-title, .aur-title) { text-shadow: 0 0 0.5em color-mix(in oklab, var(--neon-a) 55%, transparent); }\n.aur-root[data-look=\"neon\"] .aur-play-btn { --g-play-ink: #1b0f2e; }";

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
// Word animations that work on single letters, so every word is split into letters.
const SPLIT_WORD_ANIMS = new Set(["letters", "typewriter"]);
const WORD_LEAD_MS = 40; // highlight words slightly early to cover render latency
const SOON_MS = 3500; // "a line is coming": the last stretch of a break (karaoke countdown)

class LyricsView {
	/**
	 * @param {HTMLElement} stage
	 * @param {{ onSeek?: (ms:number)=>void, onShare?: (lineIndex:number)=>void }} opts
	 */
	constructor(stage, opts = {}) {
		this.stage = stage;
		this.onSeek = opts.onSeek;
		this.onShare = opts.onShare;
		this.onLine = opts.onLine; // a sung line was reached in normal playback (stats)
		this.lens = opts.lens || null; // the glass pane behind the line being sung (see placeLens)
		this.lensState = "";
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
		this.setLens("none");
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
		const root = (this.rootEl ||= this.stage.closest(".aur-root"));
		for (const a of ["data-gap", "data-intro", "data-soon"]) root?.removeAttribute(a);
		this.soon = null;
		this.list.replaceChildren();
		this.lineEls = [];
		this.wordEls = [];
		this.active = -2;
		this.wordIdx = -1;
		this.setLens("none");
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

		const letters = SPLIT_WORD_ANIMS.has(this.wordAnim);
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
		// Karaoke rows: sung lines alternate between two rows, and the first line after an
		// instrumental break starts on the top row again. A break takes the row of the line
		// after it (its countdown sits above that line).
		let row = 0;
		lyrics.lines.forEach((line, i) => {
			let el;
			let words = null;
			if (line.gap) row = 0;
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
					// Each word's position along the line (0..1), for the album-gradient text colour.
					pairs.forEach((p, k) => p.span.style.setProperty("--wx", pairs.length > 1 ? (k / (pairs.length - 1)).toFixed(3) : "0.5"));
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
			el.dataset.row = String(row);
			if (!line.gap) row ^= 1;
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

	setOptions({ layout, wordSync, autoScroll, reduced, wordAnim, showBg, lineProgress }) {
		if (lineProgress != null) this.lineProgress = lineProgress;
		if (layout && layout !== this.layout) {
			this.layout = layout;
			this.stopBrowsing(true);
		}
		// These change the DOM structure, so re-render in place (no swap animation).
		const rebuild = (wordAnim != null && SPLIT_WORD_ANIMS.has(wordAnim) !== SPLIT_WORD_ANIMS.has(this.wordAnim)) || (showBg != null && showBg !== this.showBg);
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
		if (idx < 0) return this.setSoon(lyrics.lines[0]?.time - pos);

		const line = lyrics.lines[idx];
		if (line.gap) {
			const p = clamp((pos - line.time) / Math.max(1, line.end - line.time), 0, 1);
			const el = this.lineEls[idx];
			el.style.setProperty("--aur-gp", p.toFixed(3));
			// Countdown over the break's last few seconds (0 → 1 as the next line arrives).
			const left = line.end - pos;
			el.style.setProperty("--aur-cd", clamp(1 - left / SOON_MS, 0, 1).toFixed(3));
			this.setSoon(left);
		} else {
			// Line progress (to the end of its last word when it has word timing), for themes:
			// "is-sung" once it's through, and --aur-lp every frame only when a theme draws it
			// (a custom property on the line restyles every word in it).
			const el = this.lineEls[idx];
			const end = line.words?.at(-1)?.end ?? line.end;
			const p = clamp((pos - line.time) / Math.max(1, end - line.time), 0, 1);
			if (this.lineProgress) this.lens?.style.setProperty("--lp", p.toFixed(3)); // on the lens only: a custom property on the line would restyle every word
			const sung = p >= 0.97;
			if (sung !== el.classList.contains("is-sung")) el.classList.toggle("is-sung", sung);
			if (this.wordEls[idx] && this.wordSync) this.updateWords(idx, pos);
		}
	}

	/** data-soon on the root: "on" in the last few seconds of a break (or of the intro). */
	setSoon(left) {
		const soon = !(left > SOON_MS);
		if (soon === this.soon) return;
		this.soon = soon;
		const root = (this.rootEl ||= this.stage.closest(".aur-root"));
		if (root) root.dataset.soon = soon ? "on" : "off";
	}

	/** Move the "active" markers from the old index to the new one. */
	activate(idx) {
		const prev = this.active;
		const els = this.lineEls;
		const n = els.length;

		if (prev >= -1) {
			for (let i = Math.max(0, prev - WINDOW); i <= Math.min(n - 1, prev + WINDOW); i++) {
				els[i].removeAttribute("data-d");
				els[i].classList.remove("is-active", "is-sung");
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
		// Line beat for theme ambience: data-lb flips a/b on every new line (so CSS can restart
		// a one-shot animation by switching between two identical keyframes), and data-gap
		// marks instrumental breaks.
		const root = (this.rootEl ||= this.stage.closest(".aur-root"));
		if (root) {
			const gap = idx < 0 || !!this.lyrics.lines[idx]?.gap;
			// The intro: before the first sung line (karaoke shows a title card).
			root.dataset.intro = idx < 0 || (idx === 0 && this.lyrics.lines[0]?.gap) ? "on" : "off";
			if (!gap) root.dataset.lb = root.dataset.lb === "a" ? "b" : "a";
			// Normal progression (the next line, or the one after a break), not a seek.
			if (!gap && idx > prev && idx - prev <= 2) this.onLine?.(idx);
			root.dataset.gap = gap ? "on" : "off";
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
			// Where the active line sits inside the list box: the Wheel's shared vanishing point.
			this.list.style.setProperty("--aur-anchor-y", `${Math.round(this.stage.clientHeight * ANCHOR - this.list.offsetTop)}px`);
		}

		this.placeLens(instant);

		if (instant) {
			void this.list.offsetHeight; // flush so no-anim applies to this change only
			nextFrame(() => this.stage.classList.remove("aur-no-anim"));
		}
	}

	// -------------------------------------------------------------------------
	// The lens: a pane of glass behind the line being sung
	// -------------------------------------------------------------------------
	// Glass themes put a frosted, refracting pane behind the current line. It can't live inside the
	// stage (the stage is masked, so a backdrop filter in there would see nothing but the lyrics), so
	// it is a sibling of the stage and this works out where the line will rest, in the overlay's own
	// coordinates, from layout alone (not from where the line happens to be mid-animation). The pane
	// glides and resizes to each new line (CSS transitions on --lx --ly --lw --lh).

	setLens(state) {
		const lens = this.lens;
		if (!lens || state === this.lensState) return;
		this.lensState = state;
		lens.dataset.state = state;
	}

	/** Where the text of a line sits inside the line's own box (undoing the line's current scale). */
	textBox(el) {
		const gap = el.classList.contains("is-gap");
		const parts = gap ? [el.querySelector(".aur-dots")] : [el.querySelector(".aur-main"), el.querySelector(".aur-tr"), el.querySelector(".aur-bgv")];
		const L = el.getBoundingClientRect();
		if (!L.width) return null;
		const k = el.offsetWidth / L.width;
		const range = (this.range ||= document.createRange());
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (const part of parts) {
			if (!part) continue;
			range.selectNodeContents(part);
			const r = gap ? part.getBoundingClientRect() : range.getBoundingClientRect();
			if (!r.width || !r.height) continue;
			x0 = Math.min(x0, r.left);
			y0 = Math.min(y0, r.top);
			x1 = Math.max(x1, r.right);
			y1 = Math.max(y1, r.bottom);
		}
		if (x0 === Infinity) return null;
		return { x: (x0 - L.left) * k, y: (y0 - L.top) * k, w: (x1 - x0) * k, h: (y1 - y0) * k };
	}

	placeLens(instant = false) {
		const lens = this.lens;
		if (!lens) return;
		const el = this.lyrics?.synced && this.active >= 0 ? this.lineEls[this.active] : null;
		const box = el && this.textBox(el);
		if (!box) return this.setLens("none");
		// where the line comes to rest: the list layout scrolls it to the anchor (this.y); the stack layout
		// centres it on its top edge (translateY(-50%))
		const rest = this.layout === "stack" ? el.offsetTop - el.offsetHeight / 2 : el.offsetTop + this.y;
		const x = this.stage.offsetLeft + this.list.offsetLeft + el.offsetLeft + box.x;
		const y = this.stage.offsetTop + this.list.offsetTop + rest + box.y;
		const st = lens.style;
		// a pane that was hidden appears where it belongs instead of gliding there from where it was
		const snap = instant || this.lensState === "none" || this.lensState === "";
		if (snap) lens.classList.add("is-snap");
		st.setProperty("--lx", `${x.toFixed(1)}px`);
		st.setProperty("--ly", `${y.toFixed(1)}px`);
		st.setProperty("--lw", `${box.w.toFixed(1)}px`);
		st.setProperty("--lh", `${box.h.toFixed(1)}px`);
		st.setProperty("--lf", getComputedStyle(el).fontSize); // the line's font size: the pane's padding is in em
		this.setLens(el.classList.contains("is-gap") ? "gap" : "line");
		if (snap) {
			void lens.offsetWidth;
			nextFrame(() => lens.classList.remove("is-snap"));
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
			if (this.lens) this.lens.dataset.browse = "on";
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
		if (this.lens) delete this.lens.dataset.browse;
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

// ---- media.js --------------------------------------------------------------
// Custom background: an image or video the user picks, stored in IndexedDB (files are far too
// big for localStorage). Settings only keep a small description ({ kind, name, size }); the
// file itself lives here and is served to the overlay as an object URL.

const MEDIA_DB = "aurora-lyrics";
const MEDIA_STORE = "media";
const BG_KEY = "custom-bg";
const MAX_MEDIA_BYTES = 300 * 1024 * 1024;

let dbPromise = null;
function db() {
	if (!dbPromise) {
		dbPromise = new Promise((resolve, reject) => {
			const req = indexedDB.open(MEDIA_DB, 1);
			req.onupgradeneeded = () => req.result.createObjectStore(MEDIA_STORE);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}
	return dbPromise;
}

function tx(mode, run) {
	return db().then(
		(d) =>
			new Promise((resolve, reject) => {
				const t = d.transaction(MEDIA_STORE, mode);
				const req = run(t.objectStore(MEDIA_STORE));
				t.oncomplete = () => resolve(req?.result);
				t.onerror = () => reject(t.error);
				t.onabort = () => reject(t.error);
			}),
	);
}

/** "image" / "video" for a supported file, else null. */
function mediaKind(type) {
	if (/^image\/(png|jpe?g|webp|gif|avif|bmp)$/i.test(type || "")) return "image";
	if (/^video\/(mp4|webm|ogg|quicktime)$/i.test(type || "")) return "video";
	return null;
}

/** Store the file; resolves the settings description. Throws a readable Error when invalid. */
async function saveBackground(file) {
	const kind = mediaKind(file?.type);
	if (!kind) throw new Error("Pick an image (PNG, JPG, WebP, GIF) or a video (MP4, WebM)");
	if (file.size > MAX_MEDIA_BYTES) throw new Error("That file is too large (max 300 MB)");
	await tx("readwrite", (s) => s.put(file, BG_KEY));
	return { kind, name: file.name, size: file.size };
}

function loadBackground() {
	return tx("readonly", (s) => s.get(BG_KEY));
}

function removeBackground() {
	return tx("readwrite", (s) => s.delete(BG_KEY));
}

// ---- panel.js --------------------------------------------------------------
// Side drawer with two tabs:
//  - Settings: generated from SCHEMA (segmented controls, style cards, font tiles,
//    filled sliders, switches), applied live.
//  - This track: paste / import .lrc or .txt lyrics for the current track.


const MAX_IMPORT_BYTES = 512 * 1024;
const SEGMENT_ICONS = { left: ICONS.alignLeft, center: ICONS.alignCenter, right: ICONS.alignRight };
const ACCENT_SWATCHES = ["#ff5fa2", "#ff7a45", "#ffc93d", "#3ddc84", "#2ec5ff", "#7aa2ff", "#b388ff", "#ffffff"];

let panelToast = () => {}; // set by createPanel (controls are built before it has a context)

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

	if (entry.type === "media") {
		// Custom background: pick an image or video (stored in IndexedDB), or remove it.
		const name = h("span", { class: "aur-media-name" });
		const input = h("input", {
			type: "file",
			accept: "image/png,image/jpeg,image/webp,image/gif,image/avif,video/mp4,video/webm",
			hidden: true,
			onchange: async (e) => {
				const file = e.target.files?.[0];
				e.target.value = "";
				if (!file) return;
				try {
					panelToast("Saving background…");
					const desc = await saveBackground(file);
					settings.setMany({ customBg: desc, bgStyle: "custom" });
					panelToast(`Background set: ${desc.name}`);
				} catch (err) {
					panelToast(err?.message || "Couldn't use that file");
				}
			},
		});
		const removeBtn = h(
			"button",
			{
				class: "aur-btn aur-btn-ghost",
				onclick: async () => {
					await removeBackground().catch(() => {});
					settings.setMany({ customBg: null, ...(settings.get("bgStyle") === "custom" ? { bgStyle: "album" } : {}) });
					panelToast("Custom background removed");
				},
			},
			"Remove",
		);
		const sync = (v) => {
			name.textContent = v ? `${v.kind === "video" ? "Video" : "Image"} · ${v.name}` : "None chosen";
			removeBtn.disabled = !v;
		};
		sync(value);
		return {
			row: h(
				"div",
				{ class: "aur-row aur-row-stack" },
				labelEl(),
				h("div", { class: "aur-media" }, name, h("div", { class: "aur-media-actions" }, h("button", { class: "aur-btn", html: `${ICONS.upload()}<span>Choose image or video</span>`, onclick: () => input.click() }), removeBtn), input),
			),
			sync,
		};
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
	panelToast = ctx.toast;
	const syncers = new Map();

	// --- Pages ----------------------------------------------------------------
	// Rail order. "track" = this song's lyrics; the others group SCHEMA sections.
	const PAGES = [
		{ id: "track", label: "Lyrics", icon: ICONS.navLyrics, title: "This track", sub: "Source, reload, import" },
		{ id: "look", label: "Look", icon: ICONS.navLook, title: "Look", sub: "Layout, text and background", sections: ["Theme", "Layout", "Text", "Background"] },
		{ id: "motion", label: "Motion", icon: ICONS.navMotion, title: "Motion", sub: "Line and word animation", sections: ["Motion", "Words"] },
		{ id: "sources", label: "Sources", icon: ICONS.navSources, title: "Sources", sub: "Where lyrics come from, translation", sections: ["Sources", "Translation"] },
		{ id: "general", label: "General", icon: ICONS.navGeneral, title: "General", sub: "Sync, controls and shortcuts", sections: ["Sync", "Interface"] },
		{ id: "stats", label: "Stats", icon: ICONS.navStats, title: "Your stats", sub: "Time with the lyrics open, on this computer" },
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

	// --- Stats tab -------------------------------------------------------------
	const statsBody = h("div", { class: "aur-tab-body aur-stats", "data-tab": "stats", hidden: true });
	let resetArmed = 0;
	function refreshStats() {
		const st = ctx.getStats();
		const themeLabel = (id) => THEMES.find((t) => t.id === id)?.label || "Custom";
		const tile = (value, label) => h("div", { class: "aur-stat" }, h("div", { class: "aur-stat-value" }, value), h("div", { class: "aur-stat-label" }, label));
		const max = Math.max(...st.lastDays.map((d) => d.ms), 1);
		const weekday = (t) => new Date(t).toLocaleDateString(undefined, { weekday: "narrow" });
		const list = (items, render) => (items.length ? h("ol", { class: "aur-stat-list" }, items.map(render)) : h("p", { class: "aur-hint" }, "Nothing yet. Open the lyrics while a song plays."));
		const resetBtn = h(
			"button",
			{
				class: "aur-btn aur-btn-ghost",
				onclick: () => {
					// Two clicks: the first one arms it for a few seconds.
					if (Date.now() - resetArmed > 4000) {
						resetArmed = Date.now();
						resetBtn.textContent = "Click again to reset";
						return;
					}
					resetArmed = 0;
					ctx.resetStats();
					ctx.toast("Stats reset");
					refreshStats();
				},
			},
			"Reset stats",
		);
		statsBody.replaceChildren(
			h(
				"div",
				{ class: "aur-stat-tiles" },
				tile(fmtDuration(st.totalMs), "with lyrics"),
				tile(String(st.songCount), st.songCount === 1 ? "song" : "songs"),
				tile(st.lines.toLocaleString(), "lines sung"),
				tile(String(st.streak), st.streak === 1 ? "day streak" : "days streak"),
			),
			h(
				"div",
				{ class: "aur-section" },
				h("h3", null, "Last 14 days", h("span", { class: "aur-stat-today" }, `Today ${fmtDuration(st.todayMs)}`)),
				h(
					"div",
					{ class: "aur-stat-chart", role: "img", "aria-label": "Time with lyrics per day, last 14 days" },
					st.lastDays.map((d, i) =>
						h(
							"div",
							{ class: `aur-stat-day${i === st.lastDays.length - 1 ? " is-today" : ""}`, title: `${new Date(d.date).toLocaleDateString()}: ${fmtDuration(d.ms)}` },
							h("span", { class: "aur-stat-bar", style: `--v:${(d.ms / max).toFixed(3)}` }),
							h("span", { class: "aur-stat-dow" }, weekday(d.date)),
						),
					),
				),
			),
			h(
				"div",
				{ class: "aur-section" },
				h("h3", null, "Top songs"),
				list(st.topSongs, (x) =>
					h("li", null, h("div", { class: "aur-stat-name" }, h("b", null, x.title || "Unknown"), h("span", null, x.artist || "")), h("div", { class: "aur-stat-num" }, fmtDuration(x.ms), h("span", null, `${x.plays} ${x.plays === 1 ? "play" : "plays"} · ${x.lines} lines`))),
				),
			),
			h(
				"div",
				{ class: "aur-section" },
				h("h3", null, "Top artists"),
				list(st.topArtists, (x) => h("li", null, h("div", { class: "aur-stat-name" }, h("b", null, x.name), h("span", null, `${x.songs} ${x.songs === 1 ? "song" : "songs"}`)), h("div", { class: "aur-stat-num" }, fmtDuration(x.ms)))),
			),
			st.favTheme ? h("p", { class: "aur-hint" }, `Favourite theme: ${themeLabel(st.favTheme.id)} (${fmtDuration(st.favTheme.ms)}). Counting since ${new Date(st.since).toLocaleDateString()}.`) : null,
			h("div", { class: "aur-panel-actions" }, resetBtn),
		);
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
			h("div", { class: "aur-panel-scroll" }, trackBody, statsBody, settingsBodies, noResults),
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
		if (tab !== "track" && tab !== "stats") lastSettingsPage = tab;
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
		statsBody.hidden = tab !== "stats";
		for (const [id, body] of Object.entries(bodies)) body.hidden = id !== tab;
		noResults.hidden = true;
		el.querySelector(".aur-panel-scroll").scrollTop = 0;
		if (tab === "track") refreshTrack();
		if (tab === "stats") refreshStats();
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
		statsBody.hidden = true;
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
			const want = tab === "settings" ? (current === "track" || current === "stats" ? lastSettingsPage : current) : tab;
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
// Share card: render lyric lines + cover art + track info into an image (canvas), with a live
// preview. Copy it, save it as a PNG, hand it to the system share sheet, or copy the text.
//
// Opened from the overlay (share button, S, or right-click on a line). Everything is drawn
// locally; the only network use is loading the cover image (CORS-enabled Spotify CDN). If the
// cover can't be used on a canvas, album-art backgrounds fall back to the gradient.


const SHARE_FORMATS = {
	square: { label: "Square", w: 1080, h: 1080 },
	portrait: { label: "Portrait", w: 1080, h: 1350 },
	story: { label: "Story", w: 1080, h: 1920 },
};
const SHARE_STYLES = [
	["classic", "Classic"],
	["card", "Card"],
	["center", "Centered"],
	["quote", "Quote"],
];
const BACKGROUNDS = [
	["album", "Album"],
	["gradient", "Gradient"],
	["accent", "Accent"],
	["dark", "Dark"],
	["light", "Light"],
];
const MAX_LINES = 8;
const OPTS_KEY = "aurora-lyrics:share";
const DEFAULT_OPTS = { style: "classic", format: "portrait", bg: "album", align: "left", size: 100, glow: true, info: true, tr: true, credit: false };

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

/** Any CSS colour (incl. color-mix / oklch) → something canvas understands ("#rrggbb" / "rgba()"). */
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

/** "#rrggbb" + alpha → "rgba()" (other formats are returned unchanged). */
function withAlpha(color, a) {
	const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color || "");
	return m ? `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})` : color;
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

/** A small tile of random noise, drawn over backgrounds so smooth gradients don't band. */
let grainTile = null;
function grain() {
	if (grainTile) return grainTile;
	const c = document.createElement("canvas");
	c.width = c.height = 160;
	const g = c.getContext("2d");
	const img = g.createImageData(160, 160);
	for (let i = 0; i < img.data.length; i += 4) {
		const v = Math.random() * 255;
		img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
		img.data[i + 3] = 255;
	}
	g.putImageData(img, 0, 0);
	grainTile = c;
	return c;
}

/** Cover art with a rounded clip and a soft shadow. */
function drawArt(ctx, img, x, y, size, radius) {
	ctx.save();
	ctx.shadowColor = "rgba(0,0,0,0.4)";
	ctx.shadowBlur = size * 0.18;
	ctx.shadowOffsetY = size * 0.05;
	roundRect(ctx, x, y, size, size, radius);
	ctx.fillStyle = "#000";
	ctx.fill();
	ctx.restore();
	ctx.save();
	roundRect(ctx, x, y, size, size, radius);
	ctx.clip();
	drawCover(ctx, img, x, y, size, size);
	ctx.restore();
}

function drawBackground(ctx, W, H, o) {
	const radial = (x, y, r, color, alpha) => {
		const g = ctx.createRadialGradient(x, y, 0, x, y, r);
		ctx.globalAlpha = alpha;
		g.addColorStop(0, color);
		g.addColorStop(1, "rgba(0,0,0,0)");
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, W, H);
		ctx.globalAlpha = 1;
	};
	const bg = o.bg === "album" && !o.cover ? "gradient" : o.bg;
	const light = bg === "light";
	if (bg === "album") {
		ctx.fillStyle = o.c2;
		ctx.fillRect(0, 0, W, H);
		ctx.save();
		ctx.filter = `blur(${Math.round(W * 0.07)}px) saturate(1.5) brightness(0.85)`;
		drawCover(ctx, o.cover, -W * 0.2, -H * 0.2, W * 1.4, H * 1.4);
		ctx.restore();
		ctx.fillStyle = "rgba(0,0,0,0.28)";
		ctx.fillRect(0, 0, W, H);
	} else if (bg === "gradient") {
		ctx.fillStyle = o.c2;
		ctx.fillRect(0, 0, W, H);
		radial(W * 0.2, H * 0.18, W * 1.05, o.c1, 0.95);
		radial(W * 0.9, H * 0.92, W * 0.8, o.accent, 0.38);
		ctx.fillStyle = "rgba(0,0,0,0.2)";
		ctx.fillRect(0, 0, W, H);
	} else if (bg === "accent") {
		const g = ctx.createLinearGradient(0, 0, W, H);
		g.addColorStop(0, o.accent);
		g.addColorStop(1, o.c2);
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, W, H);
		ctx.fillStyle = "rgba(0,0,0,0.3)";
		ctx.fillRect(0, 0, W, H);
		radial(W * 0.15, H * 0.1, W * 0.9, "#ffffff", 0.14);
	} else if (light) {
		ctx.fillStyle = "#f4f1ea";
		ctx.fillRect(0, 0, W, H);
		radial(W * 0.1, H * 0.05, W * 0.95, o.accent, 0.2);
		radial(W * 0.95, H * 0.95, W * 0.8, o.c1, 0.1);
	} else {
		ctx.fillStyle = "#0b0b0f";
		ctx.fillRect(0, 0, W, H);
		radial(W * 0.12, H * 0.08, W * 0.9, o.accent, 0.2);
	}
	if (!light) {
		// Darker towards the bottom (track info) and at the edges.
		const fade = ctx.createLinearGradient(0, H * 0.55, 0, H);
		fade.addColorStop(0, "rgba(0,0,0,0)");
		fade.addColorStop(1, "rgba(0,0,0,0.4)");
		ctx.fillStyle = fade;
		ctx.fillRect(0, 0, W, H);
		const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.hypot(W, H) * 0.62);
		v.addColorStop(0, "rgba(0,0,0,0)");
		v.addColorStop(1, "rgba(0,0,0,0.3)");
		ctx.fillStyle = v;
		ctx.fillRect(0, 0, W, H);
	}
	ctx.save();
	ctx.globalAlpha = light ? 0.035 : 0.05;
	ctx.globalCompositeOperation = light ? "multiply" : "overlay";
	ctx.fillStyle = ctx.createPattern(grain(), "repeat");
	ctx.fillRect(0, 0, W, H);
	ctx.restore();
	return light;
}

/**
 * Wrap and size the lyric blocks (each: a line + optional translation) to fit maxW × maxH.
 * Starts at `size` and shrinks until it fits.
 */
function fitLyrics(ctx, o, blocks, maxW, maxH, size) {
	const min = o.W * 0.034;
	for (;;) {
		const trSize = Math.max(o.W * 0.026, size * 0.46);
		ctx.font = `${o.weight} ${Math.round(size)}px ${o.font}`;
		const lh = size * 1.16;
		const wrapped = blocks.map((b) => {
			ctx.font = `${o.weight} ${Math.round(size)}px ${o.font}`;
			const lines = wrapText(ctx, b.text, maxW);
			let tr = [];
			if (b.tr) {
				ctx.font = `600 ${Math.round(trSize)}px ${o.uiFont}`;
				tr = wrapText(ctx, b.tr, maxW);
			}
			return { lines, tr };
		});
		const gap = size * 0.42;
		const trLh = trSize * 1.3;
		const trGap = size * 0.14;
		const height = wrapped.reduce((sum, b) => sum + b.lines.length * lh + (b.tr.length ? trGap + b.tr.length * trLh : 0), 0) + gap * Math.max(0, wrapped.length - 1);
		if (height <= maxH || size <= min) return { size, trSize, lh, trLh, gap, trGap, wrapped, height };
		size *= 0.94;
	}
}

/** Draw fitted lyrics with the first baseline at top + lh·0.8. */
function drawLyrics(ctx, o, fit, x, top, align, pal) {
	ctx.textAlign = align;
	let y = top + fit.lh * 0.8;
	fit.wrapped.forEach((b, bi) => {
		ctx.save();
		ctx.font = `${o.weight} ${Math.round(fit.size)}px ${o.font}`;
		ctx.fillStyle = pal.text;
		if (pal.glow && o.glow !== false) {
			ctx.shadowColor = pal.glow;
			ctx.shadowBlur = fit.size * 0.38;
		}
		for (const line of b.lines) {
			ctx.fillText(line, x, y);
			y += fit.lh;
		}
		ctx.restore();
		if (b.tr.length) {
			ctx.font = `600 ${Math.round(fit.trSize)}px ${o.uiFont}`;
			ctx.fillStyle = pal.sub;
			y += fit.trGap - fit.lh * 0.8 + fit.trLh * 0.8;
			for (const line of b.tr) {
				ctx.fillText(line, x, y);
				y += fit.trLh;
			}
			y += fit.lh * 0.8 - fit.trLh * 0.8;
		}
		if (bi < fit.wrapped.length - 1) y += fit.gap;
	});
	ctx.textAlign = "left";
}

/** Title + artist next to (or, when centred, under) the cover. */
function drawTrackInfo(ctx, o, x, y, maxW, pal, { align = "left", titleSize, artSize }) {
	ctx.textAlign = align;
	ctx.fillStyle = pal.text;
	ctx.font = `700 ${Math.round(titleSize)}px ${o.uiFont}`;
	ctx.fillText(ellipsize(ctx, o.title || "", maxW), x, y);
	ctx.fillStyle = pal.sub;
	ctx.font = `500 ${Math.round(titleSize * 0.8)}px ${o.uiFont}`;
	ctx.fillText(ellipsize(ctx, o.artist || "", maxW), x, y + titleSize * 1.25);
	ctx.textAlign = "left";
	return artSize;
}

/**
 * Render the share image.
 * @param {HTMLCanvasElement} canvas
 * @param {{ lines: {text: string, tr?: string|null}[], title: string, artist: string,
 *   cover: HTMLImageElement|null, format: string, style: string, bg: string, align: string,
 *   size: number, glow?: boolean, info: boolean, credit: boolean, font: string, uiFont: string,
 *   weight: string|number, accent: string, c1: string, c2: string }} opts
 */
function drawShareCard(canvas, opts) {
	const { w: W, h: H } = SHARE_FORMATS[opts.format] || SHARE_FORMATS.portrait;
	const o = { ...opts, W, H };
	canvas.width = W;
	canvas.height = H;
	const ctx = canvas.getContext("2d");
	ctx.textBaseline = "alphabetic";
	const light = drawBackground(ctx, W, H, o);
	const pal = light
		? { text: "#15151a", sub: "rgba(21,21,26,0.62)", glow: null, card: "rgba(255,255,255,0.72)", cardLine: "rgba(0,0,0,0.06)" }
		: { text: "#ffffff", sub: "rgba(255,255,255,0.7)", glow: withAlpha(o.accent, 0.5), card: "rgba(10,10,14,0.38)", cardLine: "rgba(255,255,255,0.1)" };
	// Every lyric block goes through place(): it records where the lyrics sit (animated clips
	// redraw them frame by frame over a background drawn with skipLyrics) and draws them.
	let placed = null;
	const place = (fit, x, top, align) => {
		placed = { fit, x, top, align };
		if (!o.skipLyrics) drawLyrics(ctx, o, fit, x, top, align, pal);
	};
	const pad = Math.round(W * 0.08);
	const base = W * 0.088 * (o.size / 100);
	const showArt = o.info && o.cover;
	const blocks = o.lines;

	if (o.style === "card") {
		// A floating card holding the track header and the lyrics.
		const cw = W - pad * 2;
		const ip = W * 0.06;
		const art = W * 0.11;
		const header = o.info ? art + W * 0.05 : 0;
		const fit = fitLyrics(ctx, o, blocks, cw - ip * 2, H - pad * 2 - ip * 2 - header, base * 0.92);
		const ch = ip * 2 + header + fit.height;
		const cx = pad;
		const cy = (H - ch) / 2;
		ctx.save();
		ctx.shadowColor = "rgba(0,0,0,0.35)";
		ctx.shadowBlur = W * 0.06;
		ctx.shadowOffsetY = W * 0.015;
		roundRect(ctx, cx, cy, cw, ch, W * 0.045);
		ctx.fillStyle = pal.card;
		ctx.fill();
		ctx.restore();
		roundRect(ctx, cx + 1, cy + 1, cw - 2, ch - 2, W * 0.045);
		ctx.strokeStyle = pal.cardLine;
		ctx.lineWidth = 2;
		ctx.stroke();
		if (o.info) {
			let tx = cx + ip;
			if (showArt) {
				drawArt(ctx, o.cover, cx + ip, cy + ip, art, W * 0.014);
				tx += art + W * 0.03;
			}
			drawTrackInfo(ctx, o, tx, cy + ip + art * 0.46, cx + cw - ip - tx, pal, { titleSize: W * 0.034 });
		}
		const alignX = o.align === "center" ? W / 2 : cx + ip;
		place(fit, alignX, cy + ip + header, o.align);
	} else if (o.style === "center") {
		// Centred lyrics; small cover and track info centred at the bottom.
		const art = W * 0.1;
		const footer = o.info ? (showArt ? art + W * 0.035 : 0) + W * 0.075 : 0;
		const fit = fitLyrics(ctx, o, blocks, W - pad * 2, H - pad * 2.4 - footer, base);
		const top = pad + (H - pad * 2 - footer - fit.height) / 2;
		place(fit, W / 2, top, "center");
		if (o.info) {
			let fy = H - pad - W * 0.075;
			if (showArt) {
				drawArt(ctx, o.cover, (W - art) / 2, fy - art - W * 0.035, art, W * 0.012);
			}
			drawTrackInfo(ctx, o, W / 2, fy + W * 0.03, W - pad * 2, pal, { align: "center", titleSize: W * 0.032 });
		}
	} else if (o.style === "quote") {
		// A large quotation mark in the accent colour, the lyrics, then "— Title · Artist".
		const qSize = W * 0.3;
		const qTop = pad + qSize * 0.12;
		ctx.save();
		ctx.font = `700 ${Math.round(qSize)}px Georgia, "Times New Roman", serif`;
		ctx.fillStyle = light ? o.c1 : o.bg === "accent" ? "rgba(255,255,255,0.85)" : o.accent; // never the same colour as the background
		ctx.globalAlpha = 0.9;
		ctx.textAlign = o.align === "center" ? "center" : "left";
		ctx.fillText("“", o.align === "center" ? W / 2 : pad - W * 0.01, qTop + qSize * 0.62);
		ctx.restore();
		const footer = o.info ? W * 0.11 : 0;
		const lyricsTop = qTop + qSize * 0.45;
		const fit = fitLyrics(ctx, o, blocks, W - pad * 2, H - lyricsTop - pad - footer, base);
		const x = o.align === "center" ? W / 2 : pad;
		place(fit, x, lyricsTop, o.align);
		if (o.info) {
			const fy = Math.min(H - pad - W * 0.045, lyricsTop + fit.height + W * 0.12);
			ctx.textAlign = o.align;
			ctx.fillStyle = pal.text;
			ctx.font = `700 ${Math.round(W * 0.034)}px ${o.uiFont}`;
			ctx.fillText(ellipsize(ctx, `— ${o.title || ""}`, W - pad * 2), x, fy);
			ctx.fillStyle = pal.sub;
			ctx.font = `500 ${Math.round(W * 0.028)}px ${o.uiFont}`;
			ctx.fillText(ellipsize(ctx, o.artist || "", W - pad * 2), x, fy + W * 0.042);
			ctx.textAlign = "left";
		}
	} else {
		// Classic: lyrics in the open space, cover + track info in the bottom corner.
		const art = Math.round(W * 0.13);
		const fy = H - pad - art;
		if (o.info) {
			let tx = pad;
			if (showArt) {
				drawArt(ctx, o.cover, pad, fy, art, W * 0.016);
				tx = pad + art + W * 0.035;
			}
			drawTrackInfo(ctx, o, tx, fy + art * 0.46, W - pad - tx, pal, { titleSize: W * 0.038 });
		}
		const bottom = o.info ? fy - pad * 0.9 : H - pad;
		const fit = fitLyrics(ctx, o, blocks, W - pad * 2, bottom - pad, base);
		// Centred in portrait / story; nearer the top in square (reads like a quote).
		const top = pad + Math.max(0, (bottom - pad - fit.height) * (o.format === "square" ? 0.35 : 0.5));
		place(fit, o.align === "center" ? W / 2 : pad, top, o.align);
	}

	if (o.credit) {
		ctx.textAlign = "right";
		ctx.fillStyle = pal.sub;
		ctx.globalAlpha = 0.7;
		ctx.font = `600 ${Math.round(W * 0.022)}px ${o.uiFont}`;
		ctx.fillText("Aurora Lyrics", W - W * 0.04, H - W * 0.035);
		ctx.globalAlpha = 1;
		ctx.textAlign = "left";
	}
	return { canvas, layout: placed, pal, light };
}

// ---------------------------------------------------------------------------------------
// Animated clips: the selected lines light up word by word (at the song's own timing) over the
// card's background, which slowly zooms in. Recorded live from the preview canvas.
// ---------------------------------------------------------------------------------------

const CLIP_MAX_MS = 15000;
const CLIP_LEAD_MS = 700; // before the first line starts
const CLIP_TAIL_MS = 1400; // held after the last line is sung
const UNSYNCED_LINE_MS = 2600;

/**
 * Timeline for a clip. lines: Line objects (see lrc.js) in order. Times become relative to the
 * clip start; each line ends where the next selected line starts (so held notes don't linger).
 * @returns {{ blocks: {time:number,end:number,words:{time:number,end:number,text:string}[]|null}[], duration: number }}
 */
function clipTimeline(lines, synced) {
	if (!lines.length) return { blocks: [], duration: 0 };
	if (!synced || lines.some((l) => l.time == null)) {
		const blocks = lines.map((l, i) => ({ time: CLIP_LEAD_MS + i * UNSYNCED_LINE_MS, end: CLIP_LEAD_MS + (i + 1) * UNSYNCED_LINE_MS - 300, words: null }));
		return { blocks, duration: Math.min(CLIP_MAX_MS, blocks[blocks.length - 1].end + CLIP_TAIL_MS) };
	}
	const t0 = lines[0].time - CLIP_LEAD_MS;
	const blocks = lines.map((l, i) => {
		const next = lines[i + 1]?.time;
		const lastWord = l.words?.length ? l.words[l.words.length - 1].end : null;
		let end = lastWord ?? l.end ?? l.time + 3000;
		if (next != null) end = Math.min(end, next);
		end = Math.min(end, l.time + 8000);
		return {
			time: l.time - t0,
			end: end - t0,
			words: l.words?.length ? l.words.map((w) => ({ time: w.time - t0, end: Math.min(w.end, end) - t0, text: w.text })) : null,
		};
	});
	return { blocks, duration: Math.min(CLIP_MAX_MS, blocks[blocks.length - 1].end + CLIP_TAIL_MS) };
}

/** How much of a line has been sung at time t (0..1), by characters so the sweep is even. */
function sungFraction(block, t) {
	if (t <= block.time) return 0;
	if (t >= block.end) return 1;
	if (block.words) {
		let total = 0;
		let sung = 0;
		for (const w of block.words) {
			const n = w.text.length;
			total += n;
			if (t >= w.end) sung += n;
			else if (t > w.time) sung += (n * (t - w.time)) / Math.max(1, w.end - w.time);
		}
		return total ? sung / total : 0;
	}
	return (t - block.time) / Math.max(1, block.end - block.time);
}

/** One frame of a clip: background (zooming slowly), then each line dim with a bright sweep. */
function drawClipFrame(ctx, clip, t) {
	const { W, H, base, layout, pal, light, blocks, o, duration } = clip;
	const k = 1 + 0.045 * Math.min(1, t / duration);
	ctx.drawImage(base, (W - W * k) / 2, (H - H * k) / 2, W * k, H * k);
	const { fit, x, top, align } = layout;
	const dim = light ? "rgba(21,21,26,0.28)" : "rgba(255,255,255,0.3)";
	const fadeIn = Math.min(1, t / 450);
	const edge = fit.size * 0.45;
	let y = top + fit.lh * 0.8;
	ctx.globalAlpha = fadeIn;
	fit.wrapped.forEach((b, bi) => {
		const block = blocks[bi] || { time: 0, end: 1, words: null };
		const total = b.lines.reduce((n, l) => n + l.length, 0) + Math.max(0, b.lines.length - 1);
		let sungChars = sungFraction(block, t) * total;
		ctx.font = `${o.weight} ${Math.round(fit.size)}px ${o.font}`;
		ctx.textAlign = "left";
		for (const line of b.lines) {
			const w = ctx.measureText(line).width;
			const left = align === "center" ? x - w / 2 : x;
			const seg = Math.max(0, Math.min(line.length, sungChars));
			sungChars -= line.length + 1;
			ctx.fillStyle = dim;
			ctx.fillText(line, left, y);
			if (seg > 0) {
				const whole = Math.floor(seg);
				const sungW = ctx.measureText(line.slice(0, whole)).width + (seg - whole) * ctx.measureText(line[whole] || "").width;
				ctx.save();
				if (seg < line.length) {
					const g = ctx.createLinearGradient(left, 0, left + sungW + edge, 0);
					const stop = Math.max(0, Math.min(1, sungW / (sungW + edge)));
					g.addColorStop(0, pal.text);
					g.addColorStop(stop, pal.text);
					g.addColorStop(1, light ? "rgba(21,21,26,0)" : "rgba(255,255,255,0)");
					ctx.fillStyle = g;
				} else ctx.fillStyle = pal.text;
				if (pal.glow && o.glow !== false) {
					ctx.shadowColor = pal.glow;
					ctx.shadowBlur = fit.size * 0.38;
				}
				ctx.fillText(line, left, y);
				ctx.restore();
			}
			y += fit.lh;
		}
		if (b.tr.length) {
			ctx.font = `600 ${Math.round(fit.trSize)}px ${o.uiFont}`;
			ctx.fillStyle = pal.sub;
			ctx.textAlign = align;
			y += fit.trGap - fit.lh * 0.8 + fit.trLh * 0.8;
			for (const line of b.tr) {
				ctx.fillText(line, x, y);
				y += fit.trLh;
			}
			y += fit.lh * 0.8 - fit.trLh * 0.8;
		}
		if (bi < fit.wrapped.length - 1) y += fit.gap;
	});
	ctx.globalAlpha = 1;
	ctx.textAlign = "left";
}

/** Best recording format this browser supports: MP4 where possible (Instagram, WhatsApp…), else WebM. */
function clipMime() {
	const MR = globalThis.MediaRecorder;
	if (!MR) return null;
	return ["video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MR.isTypeSupported?.(m)) || null;
}

/** Plain-text version of the selection, for pasting into a message. */
function shareText(lines, title, artist) {
	const credit = [title, artist].filter(Boolean).join(" · ");
	return `${lines.join("\n")}${credit ? `\n— ${credit}` : ""}`;
}

/**
 * The share sheet (lives inside the overlay).
 * @param {{ getContext: () => { track: object|null, lyrics: object|null, tr: (string|null)[]|null,
 *   active: number, root: HTMLElement }, toast: (m: string) => void, onClose?: () => void }} ctx
 */
function createShareSheet(ctx) {
	const saved = store.getJSON(OPTS_KEY, {}) || {};
	const opts = { ...DEFAULT_OPTS };
	for (const k of Object.keys(DEFAULT_OPTS)) if (typeof saved[k] === typeof DEFAULT_OPTS[k]) opts[k] = saved[k];
	opts.size = clamp(opts.size, 70, 130);
	let selected = new Set();
	let lastClicked = -1;
	let info = null; // snapshot of the context when opened
	let renderToken = 0;
	let pending = false;

	const canvas = h("canvas", { class: "aur-share-canvas", "aria-label": "Share image preview" });
	const lineList = h("div", { class: "aur-share-lines", role: "group", "aria-label": "Lines to include" });
	const count = h("span", { class: "aur-share-count" });
	const controls = []; // re-sync on open

	const setOpt = (key, value) => {
		opts[key] = value;
		store.setJSON(OPTS_KEY, opts);
		for (const c of controls) c();
		render();
	};
	const segmented = (options, key) => {
		const buttons = options.map(([v, label]) => h("button", { class: "aur-seg", role: "radio", onclick: () => setOpt(key, v) }, label));
		const sync = () => buttons.forEach((b, i) => b.setAttribute("aria-checked", String(options[i][0] === opts[key])));
		controls.push(sync);
		sync();
		return h("div", { class: "aur-segmented", role: "radiogroup" }, buttons);
	};
	const toggle = (key, label) => {
		const input = h("input", { type: "checkbox", class: "aur-switch", onchange: (e) => setOpt(key, e.target.checked) });
		const row = h("label", { class: "aur-share-toggle" }, h("span", null, label), input);
		controls.push(() => (input.checked = !!opts[key]));
		input.checked = !!opts[key];
		return row;
	};

	const alignSeg = segmented(
		[
			["left", "Left"],
			["center", "Centre"],
		],
		"align",
	);
	controls.push(() => alignSeg.classList.toggle("is-disabled", opts.style === "center"));
	const sizeOut = h("output", { class: "aur-range-value" });
	const sizeInput = h("input", { type: "range", class: "aur-range", min: "70", max: "130", step: "5", "aria-label": "Text size" });
	const paintSize = () => {
		sizeInput.value = String(opts.size);
		sizeInput.style.setProperty("--p", `${((opts.size - 70) / 60) * 100}%`);
		sizeOut.textContent = `${opts.size}%`;
	};
	sizeInput.addEventListener("input", () => {
		opts.size = Number(sizeInput.value);
		paintSize();
		store.setJSON(OPTS_KEY, opts);
		render();
	});
	controls.push(paintSize);
	const trToggle = toggle("tr", "Translation");

	const copyBtn = h("button", { class: "aur-btn aur-btn-primary", html: `${ICONS.copy()}<span>Copy image</span>`, title: "Copy image (Ctrl+C)", onclick: () => copy() });
	const saveBtn = h("button", { class: "aur-btn", html: `${ICONS.download()}<span>Save PNG</span>`, onclick: () => save() });
	const shareBtn = h("button", { class: "aur-btn", html: `${ICONS.share()}<span>Share…</span>`, onclick: () => nativeShare(), hidden: !navigator.canShare });
	const textBtn = h("button", { class: "aur-btn aur-btn-ghost", html: `${ICONS.copy()}<span>Copy text</span>`, onclick: () => copyText() });
	const clipBtn = h("button", { class: "aur-btn aur-share-clip", html: `${ICONS.video()}<span>Record clip</span>`, title: "Record a short video of these lines lighting up (max 15 s, silent)", onclick: () => recordClip(), hidden: !clipMime() });
	const exportBtns = [copyBtn, saveBtn, shareBtn, clipBtn, textBtn];

	const label = (text, extra) => h("div", { class: "aur-share-label" }, h("span", null, text), extra || null);
	const side = h(
		"div",
		{ class: "aur-share-side" },
		h(
			"div",
			{ class: "aur-share-head" },
			h("div", null, h("div", { class: "aur-panel-title" }, "Share lyrics"), h("div", { class: "aur-panel-sub" }, "Pick lines, style it, then copy or save")),
			h("button", { class: "aur-icon-btn", title: "Close (Esc)", "aria-label": "Close", html: ICONS.close(), onclick: () => close() }),
		),
		h(
			"div",
			{ class: "aur-share-scroll" },
			label("Lines", count),
			lineList,
			h(
				"div",
				{ class: "aur-share-quick" },
				h("button", { class: "aur-share-link", onclick: () => selectCurrent() }, "Current line"),
				h("button", { class: "aur-share-link", onclick: () => ((selected = new Set()), syncLines(), render()) }, "Clear"),
				h("span", { class: "aur-share-tip" }, "Shift-click to select a range"),
			),
			label("Style"),
			segmented(SHARE_STYLES, "style"),
			label("Format"),
			segmented(Object.entries(SHARE_FORMATS).map(([k, f]) => [k, f.label]), "format"),
			label("Background"),
			segmented(BACKGROUNDS, "bg"),
			label("Text"),
			alignSeg,
			h("div", { class: "aur-share-size" }, h("span", null, "Size"), sizeInput, sizeOut),
			h("div", { class: "aur-share-toggles" }, toggle("glow", "Text glow"), toggle("info", "Cover and track info"), trToggle, toggle("credit", "Aurora Lyrics credit")),
		),
		h("div", { class: "aur-share-actions" }, exportBtns),
	);
	const card = h("div", { class: "aur-share-card", role: "dialog", "aria-label": "Share lyrics" }, h("div", { class: "aur-share-preview" }, canvas), side);
	const el = h("div", { class: "aur-share", hidden: true, onclick: (e) => e.target === el && close() }, card);
	// Keep keys (Escape is handled by the overlay) and the wheel inside the sheet.
	el.addEventListener("keydown", (e) => {
		if (e.key === "Escape") return;
		e.stopPropagation();
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && !String(window.getSelection?.() || "")) {
			e.preventDefault();
			copy();
		}
	});
	el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

	// ---- lines
	const realLines = () => (info.lyrics?.lines || []).map((l, i) => [l, i]).filter(([l]) => !l.gap && l.text);
	function lineButtons() {
		lineList.replaceChildren(
			...realLines().map(([l, i]) =>
				h(
					"button",
					{
						class: "aur-share-line",
						"data-i": String(i),
						onclick: (e) => {
							if (e.shiftKey && lastClicked >= 0) {
								// Range from the last clicked line to this one.
								const [a, b] = [Math.min(lastClicked, i), Math.max(lastClicked, i)];
								const range = realLines().filter(([, j]) => j >= a && j <= b).map(([, j]) => j);
								if (range.length > MAX_LINES) ctx.toast(`Up to ${MAX_LINES} lines`);
								selected = new Set(range.slice(0, MAX_LINES));
							} else if (selected.has(i)) selected.delete(i);
							else if (selected.size >= MAX_LINES) return ctx.toast(`Up to ${MAX_LINES} lines`);
							else selected.add(i);
							lastClicked = i;
							syncLines();
							render();
						},
					},
					l.text,
				),
			),
		);
	}
	function syncLines() {
		for (const b of lineList.children) b.setAttribute("aria-pressed", String(selected.has(Number(b.dataset.i))));
		count.textContent = `${selected.size} / ${MAX_LINES}`;
		for (const b of exportBtns) b.disabled = !selected.size;
	}
	function selectCurrent() {
		const ls = info.lyrics.lines;
		const i = ls.findIndex((l, j) => j >= Math.max(0, info.active) && !l.gap && l.text);
		selected = new Set(i >= 0 ? [i] : []);
		lastClicked = i;
		syncLines();
		render();
		lineList.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "center" });
	}

	const hasTr = () => !!info?.tr && info.tr.length === info.lyrics?.lines?.length && info.tr.some(Boolean);
	const selectedLines = () => {
		const ls = info.lyrics?.lines || [];
		return [...selected]
			.sort((a, b) => a - b)
			.filter((i) => ls[i]?.text)
			.map((i) => ({ text: ls[i].text, tr: opts.tr && hasTr() ? info.tr[i] || null : null }));
	};

	// ---- rendering (coalesced to one per frame; nextFrame also runs when frames are throttled)
	function render() {
		if (pending) return;
		pending = true;
		nextFrame(() => {
			pending = false;
			draw();
		});
	}
	async function draw() {
		const token = ++renderToken;
		const lines = selectedLines();
		const cover = await loadImage(info.track?.image);
		if (token !== renderToken) return;
		try {
			await document.fonts?.load?.(`${info.style.weight} 40px ${info.style.font}`, lines.map((l) => l.text).join(" ") || "Aa");
		} catch {
			/* draw with whatever is available */
		}
		if (token !== renderToken) return;
		drawShareCard(canvas, {
			...info.style,
			...opts,
			lines: lines.length ? lines : [{ text: "Pick a line to share" }],
			title: info.track?.title,
			artist: info.track?.artist,
			cover,
		});
		canvas.dataset.format = opts.format;
	}

	// ---- animated clip
	let recording = null; // { stop: () => void }
	const selectedRaw = () => {
		const ls = info.lyrics?.lines || [];
		return [...selected].sort((a, b) => a - b).map((i) => ls[i]).filter((l) => l?.text);
	};
	async function recordClip() {
		if (recording) return recording.stop(true); // second click cancels
		const mime = clipMime();
		const lines = selectedRaw();
		if (!mime || !lines.length) return;
		const { blocks, duration } = clipTimeline(lines, !!info.lyrics?.synced);
		const cover = await loadImage(info.track?.image);
		// Background + track info once, without the lyrics; lyrics are drawn per frame.
		const base = document.createElement("canvas");
		const drawn = drawShareCard(base, { ...info.style, ...opts, lines: selectedLines(), title: info.track?.title, artist: info.track?.artist, cover, skipLyrics: true });
		canvas.width = base.width;
		canvas.height = base.height;
		const clip = { W: base.width, H: base.height, base, layout: drawn.layout, pal: drawn.pal, light: drawn.light, blocks, o: { ...info.style, ...opts }, duration };
		const g = canvas.getContext("2d");
		drawClipFrame(g, clip, 0);
		let stream;
		try {
			stream = canvas.captureStream(30);
		} catch (e) {
			console.warn("[aurora-lyrics] clip capture failed", e);
			render();
			return ctx.toast("Can't record here (the cover image isn't allowed in videos)");
		}
		const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
		const chunks = [];
		rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
		let cancelled = false;
		let done = false;
		const label = clipBtn.querySelector("span");
		for (const b of exportBtns) if (b !== clipBtn) b.disabled = true;
		clipBtn.classList.add("is-recording");
		const finish = () => {
			if (done) return;
			done = true;
			if (rec.state !== "inactive") rec.stop();
		};
		recording = { stop: (cancel) => ((cancelled = !!cancel), finish()) };
		rec.onstop = async () => {
			recording = null;
			stream.getTracks().forEach((tr) => tr.stop());
			clipBtn.classList.remove("is-recording");
			label.textContent = "Record clip";
			syncLines(); // re-enables the export buttons
			render(); // back to the still preview
			if (cancelled) return ctx.toast("Recording cancelled");
			const type = mime.split(";")[0];
			const ext = type === "video/mp4" ? "mp4" : "webm";
			await saveFile(new Blob(chunks, { type }), fileName().replace(/\.png$/, `.${ext}`), type, ext);
		};
		rec.start(250);
		const start = performance.now();
		const frame = () => {
			if (done) return;
			const t = performance.now() - start;
			drawClipFrame(g, clip, Math.min(t, duration));
			label.textContent = `Recording… ${Math.ceil(Math.max(0, duration - t) / 1000)}s · click to stop`;
			if (t >= duration) return finish();
			nextFrame(frame);
		};
		frame();
	}

	// ---- export
	const toBlob = () =>
		new Promise((resolve, reject) => {
			try {
				canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("empty image"))), "image/png");
			} catch (e) {
				reject(e); // tainted canvas
			}
		});
	const fileName = () => `${[info.track?.artist, info.track?.title].filter(Boolean).join(" - ") || "lyrics"}.png`.replace(/[\\/:*?"<>|]+/g, "");

	async function copy() {
		if (!selected.size) return;
		try {
			const blob = await toBlob();
			await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
			ctx.toast("Image copied — paste it anywhere");
		} catch (e) {
			console.warn("[aurora-lyrics] copy image failed", e);
			ctx.toast("Couldn't copy the image here — try Save PNG");
		}
	}

	async function copyText() {
		const text = shareText(selectedLines().map((l) => l.text), info.track?.title, info.track?.artist);
		try {
			await navigator.clipboard.writeText(text);
			ctx.toast("Lyrics copied as text");
		} catch {
			ctx.toast("Couldn't copy the text here");
		}
	}

	async function nativeShare() {
		try {
			const file = new File([await toBlob()], fileName(), { type: "image/png" });
			if (!navigator.canShare?.({ files: [file] })) throw new Error("files not shareable");
			await navigator.share({ files: [file], title: info.track?.title || "Lyrics" });
		} catch (e) {
			if (e?.name === "AbortError") return; // user closed the share sheet
			console.warn("[aurora-lyrics] share failed", e);
			ctx.toast("Sharing isn't available here — try Copy image");
		}
	}

	/** Save a blob: the system save dialog where available, else a download. */
	async function saveFile(blob, name, type, ext) {
		try {
			if (globalThis.showSaveFilePicker) {
				try {
					const handle = await globalThis.showSaveFilePicker({ suggestedName: name, types: [{ description: ext.toUpperCase(), accept: { [type]: [`.${ext}`] } }] });
					const w = await handle.createWritable();
					await w.write(blob);
					await w.close();
					return ctx.toast(`${ext === "png" ? "Image" : "Clip"} saved`);
				} catch (e) {
					if (e?.name === "AbortError") return; // user cancelled
				}
			}
			const url = URL.createObjectURL(blob);
			h("a", { href: url, download: name }).click();
			setTimeout(() => URL.revokeObjectURL(url), 30000);
			ctx.toast(`${ext === "png" ? "Image" : "Clip"} saved to Downloads`);
		} catch (e) {
			console.warn("[aurora-lyrics] save failed", e);
			ctx.toast("Couldn't save the file");
		}
	}

	async function save() {
		const name = fileName();
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
			tr: c.tr || null,
			active: c.active,
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
		lastClicked = start;
		trToggle.hidden = !hasTr();
		lineButtons();
		syncLines();
		for (const s of controls) s();
		el.hidden = false;
		void el.offsetWidth;
		el.classList.add("is-open");
		lineList.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "center" });
		copyBtn.focus({ preventScroll: true });
		render();
	}

	function close() {
		if (el.hidden) return;
		recording?.stop(true);
		el.classList.remove("is-open");
		setTimeout(() => !el.classList.contains("is-open") && (el.hidden = true), 250);
		ctx.onClose?.();
	}

	return { el, open, close, isOpen: () => !el.hidden && el.classList.contains("is-open") };
}

// ---- tabs.js ---------------------------------------------------------------
// Songsterr: find the guitar / bass / drum tabs for the playing song and open them in the
// browser. Only Songsterr's public song search is used (through the CORS proxy, since it
// sends no CORS headers); the tabs themselves are viewed on songsterr.com.


const SEARCH = "https://www.songsterr.com/api/songs";
const tabCache = new Map(); // track uri → result

function slug(s) {
	return normalizeTitle(s).replace(/\s+/g, "-") || "song";
}

/** Songsterr's search page for a free-text query (used when there's no exact match). */
function songsterrSearchUrl(track) {
	return `https://www.songsterr.com/?pattern=${encodeURIComponent(`${track.artist} ${track.title}`.trim())}`;
}

/** Which instrument family a Songsterr track is. */
function instrumentKind(t) {
	const s = `${t?.instrument || ""} ${t?.name || ""}`.toLowerCase();
	if (/drum|percussion/.test(s)) return "drums";
	if (/bass/.test(s)) return "bass";
	if (/guitar/.test(s)) return "guitar";
	if (/vocal|voice|choir|aahs/.test(s)) return "vocals";
	return "other";
}

/**
 * Pick the search result that is the playing song, and summarise it.
 * @returns {null | { url, title, artist, parts: { guitar, bass, drums, vocals, other }, difficulty: number|null }}
 */
function pickSongsterr(results, track) {
	if (!Array.isArray(results)) return null;
	const song = results.find((r) => r && titleMatches(track.title, r.title) && artistMatches(track.artist, [r.artist]));
	if (!song?.songId) return null;
	const parts = { guitar: 0, bass: 0, drums: 0, vocals: 0, other: 0 };
	let difficulty = null;
	for (const t of song.tracks || []) {
		const kind = instrumentKind(t);
		parts[kind]++;
		if (kind === "guitar" && Number.isFinite(t.difficulty)) difficulty = Math.max(difficulty ?? 0, t.difficulty);
	}
	return {
		url: `https://www.songsterr.com/a/wsa/${slug(song.artist)}-${slug(song.title)}-tab-s${song.songId}`,
		title: song.title,
		artist: song.artist,
		parts,
		difficulty,
	};
}

/** Look the track up on Songsterr (cached per track). Resolves null when there's no tab. */
async function findTabs(track, { signal } = {}) {
	if (!track?.title) return null;
	if (tabCache.has(track.uri)) return tabCache.get(track.uri);
	const pattern = `${track.artist.split(",")[0]} ${track.title}`.trim();
	const res = await getJSON(`${SEARCH}?pattern=${encodeURIComponent(pattern)}&size=10`, { signal, proxy: true });
	if (!res.ok) throw new Error(`Songsterr: HTTP ${res.status}`);
	const found = pickSongsterr(res.json, track);
	tabCache.set(track.uri, found);
	return found;
}

// ---- overlay.js ------------------------------------------------------------
// The overlay controller: builds the full-screen UI once (lazily), owns the playback loop,
// loads lyrics on track changes, and applies settings live.


const CLOSE_MS = 420; // must match the overlay fade-out transition in styles.css
const BEAT_LEAD_MS = 40; // flip beat markers slightly early, like the word highlight
const BEAT_FRESH_MS = 180; // only react to a beat that just happened (not after a seek)
const STATS_KEY = `${EXT_ID}:stats`;
const STATS_SAVE_MS = 15000;
const OPEN_MS = 750; // the overlay's fade/scale-in (styles.css), after which Spotify's page is hidden
const BG_SIZE = 256; // px; background art is drawn small and scaled up (cheap heavy blur)
const RELAYOUT_KEYS = new Set(["fontSize", "lineSpacing", "textAlign", "animation", "fontWeight", "font", "showContext", "view", "showBgVocals", "*"]);
const SOURCE_KEYS = new Set(["providers", "searchUntil"]);
// Motion styles that stack lines at the centre (one line in focus) instead of a scrolling list.
const STACK_ANIMS = new Set(["fade", "cinematic", "swipe", "zoom", "flip"]);
// Themes that draw the current line's progress (--aur-lp, written every frame, which restyles
// the whole line, so only when something uses it).
const LINE_PROGRESS_LOOKS = new Set(["minimal"]);
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
	let rain = null; // the Rain theme's WebGL scene, created when that theme is first shown
	let scenes = null; // the glass themes' WebGL scenes (scenes.js), created when the first one is shown
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
			h("div", { class: "aur-bg-custom" }),
			h("div", { class: "aur-bg-gradient" }),
			h("div", { class: "aur-bg-shade" }),
			// Theme ambience (scanlines, spotlights, stars…); each theme styles these layers.
			h(
				"div",
				{ class: "aur-fx" },
				h("i", { class: "aur-fx-a" }),
				h("i", { class: "aur-fx-b" }),
				h("i", { class: "aur-fx-c" }),
				h("i", { class: "aur-fx-d" }),
				// The last layer holds two dozen children for themes that need separate moving parts
				// (Rain's running drops, Karaoke's equaliser bars); a theme uses as many as it needs.
				h("i", { class: "aur-fx-e" }, Array.from({ length: 24 }, () => h("i"))),
				// The Rain theme draws its whole scene here with WebGL (see rain.js); hidden otherwise.
				h("canvas", { class: "aur-fx-gl", "aria-hidden": "true" }),
				// Glass themes with a WebGL scene (scenes.js) draw it here.
				h("canvas", { class: "aur-fx-sc", "aria-hidden": "true" }),
			),
			h("div", { class: "aur-bg-grain" }),
		);

		const cover = h("img", { class: "aur-cover", alt: "" });
		const title = h("div", { class: "aur-title" });
		const artist = h("div", { class: "aur-artist" });
		const header = h("div", { class: "aur-header aur-chrome" }, cover, h("div", { class: "aur-meta" }, title, artist));

		const stage = h("div", { class: "aur-stage", role: "main" });

		// The lens: in glass themes, a pane of glass behind the line being sung (view.js places it).
		// It sits under the stage, not in it: the stage is masked, and a backdrop filter inside a masked
		// element only sees what is inside it.
		const lens = h("div", { class: "aur-lens", "aria-hidden": "true", "data-state": "none" }, h("i", { class: "aur-lens-pane" }), h("i", { class: "aur-lens-rim" }), h("i", { class: "aur-lens-sheen" }), h("i", { class: "aur-lens-line" }));

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
		const tabsBtn = iconBtn("Guitar tabs on Songsterr (G)", ICONS.pick(), () => toggleTabs(), "aur-icon-btn aur-toggle aur-tabs-btn");
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
				tabsBtn,
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
			setText(tip, fmtTime(f * getDuration()));
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

		// Songsterr tabs: a small card above the control bar with what's available.
		const tabsPop = h("div", { class: "aur-tabs-pop", role: "dialog", "aria-label": "Guitar tabs", hidden: true });

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
			getStats: () => summarize(statsObj(), Date.now()),
			resetStats: () => {
				statsData = validStats(null, Date.now());
				store.setJSON(STATS_KEY, statsData);
			},
			clearCache: () => {
				const n = lyricsCache.size();
				lyricsCache.clear();
				return n;
			},
			toast,
		});

		const share = createShareSheet({
			getContext: () => ({ track: state.track, lyrics: state.lyrics, tr: ui?.view.tr || null, active: ui?.view.active ?? -1, root }),
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
			lens,
			stage,
			dock,
			miniProgress,
			panel.el,
			share.el,
			tabsPop,
			upNext,
			toastEl,
			createGlassDefs(),
		);

		const view = new LyricsView(stage, {
			lens,
			onShare: (i) => openShare(i),
			onLine: () => state.open && isPlaying() && !document.hidden && state.track && addLine(statsObj(), state.track.uri),
			onSeek: (t) => {
				// Seek so that the *effective* (offset-adjusted) position lands on the line.
				seek(t - settings.get("offset") + 20);
				setTimeout(kick, 60);
			},
		});

		// Clicking anywhere else closes the tabs card.
		root.addEventListener("pointerdown", (e) => {
			if (!tabsPop.hidden && !tabsPop.contains(e.target) && !tabsBtn.contains(e.target)) closeTabs();
		});

		// Depth motion: the lyric scene tilts gently towards the pointer (at most one update a frame).
		let tiltPending = false;
		root.addEventListener("pointermove", (e) => {
			if (root.dataset.anim !== "depth" || root.dataset.motion === "reduced" || tiltPending) return;
			tiltPending = true;
			nextFrame(() => {
				tiltPending = false;
				const nx = e.clientX / window.innerWidth - 0.5;
				const ny = e.clientY / window.innerHeight - 0.5;
				stage.style.setProperty("--aur-ty", `${(nx * 7).toFixed(2)}deg`);
				stage.style.setProperty("--aur-tx", `${(-ny * 5).toFixed(2)}deg`);
			});
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
		if (globalThis.AURORA_LYRICS_DEBUG) globalThis.__aurSettings = settings; // the preview page sets this, to switch themes from the console
		ui = { trBtn, root, bgStack, cover, title, artist, artA, artB, artHint, sideTitle, sideArtist, sideAlbum, activeArt: artA, stage, dock, bar, miniProgress, elapsed, remaining, playBtn, shuffleBtn, repeatBtn, heartBtn, muteBtn, vol, source, offsetOut, fsBtn, toastEl, tabsPop, tabsBtn, bgCustom: bg.querySelector(".aur-bg-custom"), fx: bg.querySelector(".aur-fx"), gl: bg.querySelector(".aur-fx-gl"), sc: bg.querySelector(".aur-fx-sc"), bg, panel, share, view, upNext, upArt, upTitle, upArtist, upWhen };
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
		st.setProperty("--aur-cblur", `${all.customBlur}px`);
		if (["customBg", "bgStyle", "*"].includes(key)) updateCustomBg(all);
		if (all.accent === "album") st.removeProperty("--aur-user-accent");
		else st.setProperty("--aur-user-accent", all.accent);

		const layout = STACK_ANIMS.has(all.animation) ? "stack" : "list";
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
			tabs: all.tabsButton ? "on" : "off",
			fx: all.ambience ? all.themeFx || "none" : "none",
			look: all.themeFx || "none", // the theme's lyric styling, independent of the ambience toggle
			glass: THEMES.find((t) => t.id === all.themeFx)?.glass ? "on" : "off", // the liquid-glass kit (glass.css): lens, glass bar, glass cover
			refract: all.glassRefract ? "on" : "off",
			depth: all.depthBlur ? "on" : "off",
			bg: all.bgStyle === "custom" && !all.customBg ? "album" : all.bgStyle,
			bganim: all.bgAnimate && !reduced ? "on" : "off",
			words: all.wordSync ? "on" : "off",
			motion: reduced ? "reduced" : "full",
			transport: all.showTransport ? "on" : "off",
			info: all.showTrackInfo ? "on" : "off",
			pinned: all.pinControls ? "true" : "false",
			view: all.view,
			wordanim: all.wordAnim,
		});
		view.setOptions({ lineProgress: LINE_PROGRESS_LOOKS.has(all.themeFx), layout, wordSync: all.wordSync, autoScroll: all.unsyncedAutoScroll, reduced, wordAnim: all.wordAnim, showBg: all.showBgVocals });
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
		if (["beatSync", "ambience", "*"].includes(key)) syncBeats();
		if (["themeFx", "ambience", "bgAnimate", "reducedMotion", "*"].includes(key)) (syncRain(), syncScene());
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
	// Custom background (image or video from IndexedDB). A video plays only while the overlay
	// is open and music is playing.
	let customUrl = null;
	let customToken = 0;
	async function updateCustomBg(all) {
		const token = ++customToken;
		const holder = ui.bgCustom;
		const want = all.bgStyle === "custom" && all.customBg;
		if (!want) {
			holder.replaceChildren();
			if (customUrl) URL.revokeObjectURL(customUrl);
			customUrl = null;
			return;
		}
		let blob = null;
		try {
			blob = await loadBackground();
		} catch (e) {
			console.warn("[aurora-lyrics] custom background unavailable", e);
		}
		if (token !== customToken) return;
		if (!blob) return toast("Custom background file is missing — choose it again in Look → Background");
		if (customUrl) URL.revokeObjectURL(customUrl);
		customUrl = URL.createObjectURL(blob);
		const media =
			all.customBg.kind === "video"
				? h("video", { src: customUrl, muted: true, loop: true, playsInline: true, autoplay: false, preload: "auto" })
				: h("img", { src: customUrl, alt: "", decoding: "async" });
		const show = () => media.classList.add("is-on");
		if (media.tagName === "VIDEO") {
			media.muted = true;
			media.addEventListener("loadeddata", show, { once: true });
			media.addEventListener("canplay", syncCustomVideo); // it may become playable after the last check
		} else media.decode ? media.decode().then(show, show) : (media.onload = show);
		holder.replaceChildren(media);
		syncCustomVideo();
	}
	function syncCustomVideo() {
		const video = ui?.bgCustom.querySelector("video");
		if (!video) return;
		if (state.open && isPlaying() && ui.root.dataset.motion !== "reduced") video.play().catch(() => {});
		else video.pause();
	}

	// The Rain theme draws its scene with WebGL (a canvas in the ambience layer). It runs while the
	// theme is on, the lyrics are open and the window is visible; without WebGL (data-gl="off") the
	// CSS version of the scene stays.
	function syncRain() {
		if (!ui) return;
		const all = settings.all();
		if (!(all.ambience && all.themeFx === "rain")) {
			rain?.stop();
			delete ui.root.dataset.gl;
			return;
		}
		rain ||= createRain(ui.gl, ui.root, ui.bg);
		if (globalThis.AURORA_LYRICS_DEBUG) globalThis.__aurRain = rain; // the preview page sets this, to poke at the scene
		if (!rain.init()) {
			ui.root.dataset.gl = "off";
			return;
		}
		ui.root.dataset.gl = "on";
		if (!state.open || document.hidden) rain.stop();
		else if (ui.root.dataset.bganim === "on") rain.start();
		else rain.still();
	}

	// The glass themes with a WebGL scene (scenes.js) draw it in a canvas in the ambience layer. It runs
	// while the theme's ambience is on, the lyrics are open and the window is visible; without WebGL
	// (data-sc="off") the theme's plain CSS ambience stays.
	function syncScene() {
		if (!ui) return;
		const all = settings.all();
		if (!(all.ambience && hasScene(all.themeFx))) {
			scenes?.stop();
			delete ui.root.dataset.sc;
			return;
		}
		scenes ||= createScenes(ui.sc, ui.root, ui.bg, ui.fx, () => ({ text: ui.stage.getBoundingClientRect(), meta: ui.sideTitle.parentElement.getBoundingClientRect() }));
		if (globalThis.AURORA_LYRICS_DEBUG) globalThis.__aurScenes = scenes;
		if (!scenes.init() || !scenes.use(all.themeFx)) {
			ui.root.dataset.sc = "off";
			scenes.stop();
			return;
		}
		ui.root.dataset.sc = "on";
		if (!state.open || document.hidden) scenes.stop();
		else if (ui.root.dataset.bganim === "on") scenes.start();
		else scenes.still();
	}

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
		// For the karaoke title card (drawn by CSS from these attributes during the intro).
		ui.stage.dataset.title = track?.title || "";
		ui.stage.dataset.artist = track?.artist || "";
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
		syncBeats();
		if (!only) {
			state.lyrics = null;
			state.source = null;
			state.cached = false;
			state.pinned = false;
			ui.view.freeze(); // don't let the old lyrics chase the new track's position
		}
		updateTrackChrome(track);
		closeTabs();
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
			setText(ui.elapsed, fmtTime(pos));
			setText(ui.remaining, `-${fmtTime(dur - pos)}`);
			ui.bar.setAttribute("aria-valuemax", String(Math.round(dur / 1000)));
			updateUpNext(pos, dur);
			// Song progress for theme ambience (Sunset's sun sets, Midnight's moon rises).
			// Set on the ambience layer only, once a second, so nothing else restyles.
			ui.fx.style.setProperty("--aur-song", p.toFixed(3));
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
		setText(ui.upWhen, ` · in ${Math.max(1, Math.ceil(left / 1000))}s`);
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

	// ---------------------------------------------------------------------------
	// Beat sync: Spotify's beat grid for the song drives data-bt / data-bar (flipping a/b on
	// every beat / bar, so CSS can restart one-shot animations) and --aur-beat (one beat, for
	// tempo-matched loops) on the background, where the theme ambience lives.
	// ---------------------------------------------------------------------------
	function syncBeats() {
		if (!ui) return;
		const uri = getCurrentTrack()?.uri || null;
		const want = state.open && uri && settings.get("beatSync") && settings.get("ambience");
		if (!want) {
			state.beatUri = null;
			return setBeats(null);
		}
		if (state.beatUri === uri) return;
		state.beatUri = uri;
		setBeats(null);
		loadBeats(uri).then((grid) => state.beatUri === uri && setBeats(grid));
	}
	function setBeats(grid) {
		state.beats = grid;
		state.beatIdx = state.barIdx = state.secIdx = -1;
		state.secTimes = grid ? grid.sections.map((x) => x.time) : null;
		const bg = ui.bg;
		if (grid) {
			bg.dataset.beats = "on";
			bg.style.setProperty("--aur-beat", `${Math.round(60000 / grid.tempo)}ms`);
		} else {
			for (const k of ["beats", "bt", "bar"]) delete bg.dataset[k];
			bg.style.removeProperty("--aur-beat");
			ui.fx.style.removeProperty("--aur-energy");
		}
	}
	function updateBeats(pos) {
		const g = state.beats;
		if (!g || !isPlaying()) return;
		const p = pos + BEAT_LEAD_MS;
		const step = (times, idxKey, attr) => {
			const i = beatIndexAt(times, p);
			if (i === state[idxKey]) return;
			state[idxKey] = i;
			if (i >= 0 && p - times[i] < BEAT_FRESH_MS) ui.bg.dataset[attr] = ui.bg.dataset[attr] === "a" ? "b" : "a";
		};
		step(g.beats, "beatIdx", "bt");
		step(g.bars, "barIdx", "bar");
		if (state.secTimes?.length) {
			const si = beatIndexAt(state.secTimes, p);
			if (si !== state.secIdx) {
				state.secIdx = si;
				ui.fx.style.setProperty("--aur-energy", (g.sections[Math.max(0, si)]?.energy ?? 0.6).toFixed(2));
			}
		}
	}

	// ---------------------------------------------------------------------------
	// Stats: time with the lyrics open while playing (counted in the playback loop, saved every
	// 15 s and on close), plus lines sung (LyricsView's onLine).
	// ---------------------------------------------------------------------------
	let statsData = null;
	function statsObj() {
		return (statsData ||= validStats(store.getJSON(STATS_KEY), Date.now()));
	}
	function saveStats() {
		if (!statsData) return;
		state.statsSavedAt = performance.now();
		store.setJSON(STATS_KEY, pruneStats(statsData));
	}
	function statsTick() {
		const now = performance.now();
		const counting = state.open && isPlaying() && !document.hidden && state.track?.uri;
		if (counting && state.statsAt) state.statsPending = (state.statsPending || 0) + Math.min(now - state.statsAt, 2000);
		state.statsAt = counting ? now : 0;
		if (state.statsPending >= 1000 || (!counting && state.statsPending > 0)) {
			const track = state.track;
			if (track?.uri) {
				addTime(statsObj(), { ms: Math.round(state.statsPending), now: Date.now(), track, theme: settings.get("themeFx"), fresh: state.statsUri !== track.uri });
				state.statsUri = track.uri;
			}
			state.statsPending = 0;
			if (now - (state.statsSavedAt || 0) > STATS_SAVE_MS) saveStats();
		}
	}

	function tick() {
		// Whichever of rAF / fallback timer fired first, cancel the other.
		if (state.raf) cancelAnimationFrame(state.raf);
		clearTimeout(state.timer);
		state.raf = 0;
		state.timer = 0;
		if (!state.open) return;
		const pos = smoothPosition();
		ui.view.update(pos + settings.get("offset"), state.track?.duration || getDuration());
		updateBeats(pos);
		statsTick();
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
		// Once the fade-in is done, stop Spotify's own page from rendering underneath: it's fully
		// covered, but its layers would otherwise still be composited every frame (a big cost on
		// large windows). visibility keeps its layout and scroll positions intact.
		clearTimeout(state.coverTimer);
		state.coverTimer = setTimeout(() => state.open && document.documentElement.classList.add("aur-covered"), OPEN_MS);
		ui.root.focus({ preventScroll: true });
		wake();
		syncBeats();
		syncRain();
		syncScene();
		if (state.stale || state.track?.uri !== getCurrentTrack()?.uri) loadLyrics();
		else {
			ui.view.relayout();
			ui.view.playEnter();
		}
		kick();
		syncCustomVideo();
		onOpenChange?.(true);
	}

	function close() {
		if (!state.open) return;
		state.open = false;
		ui.panel.close();
		ui.share.close();
		closeTabs();
		ui.view.stopBrowsing(true);
		clearTimeout(state.coverTimer);
		document.documentElement.classList.remove("aur-covered");
		statsTick();
		saveStats();
		ui.root.classList.remove("is-open");
		syncRain();
		syncScene();
		if (state.enteredFullscreen && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
		state.closeTimer = setTimeout(() => (ui.root.hidden = true), CLOSE_MS);
		kick(); // cancels pending frames because state.open is false
		state.lastFocus?.focus?.({ preventScroll: true });
		syncCustomVideo();
		onOpenChange?.(false);
	}

	// ---------------------------------------------------------------------------
	// Songsterr tabs popover
	// ---------------------------------------------------------------------------
	function openExternal(url) {
		window.open(url, "_blank", "noopener");
	}

	function closeTabs() {
		if (!ui || ui.tabsPop.hidden) return;
		ui.tabsPop.classList.remove("is-open");
		ui.tabsBtn.classList.remove("is-on");
		state.tabsToken = (state.tabsToken || 0) + 1;
		setTimeout(() => !ui.tabsPop.classList.contains("is-open") && (ui.tabsPop.hidden = true), 220);
	}

	async function toggleTabs() {
		if (!ui) return;
		if (!ui.tabsPop.hidden && ui.tabsPop.classList.contains("is-open")) return closeTabs();
		const track = state.track || getCurrentTrack();
		if (!track?.isTrack) return toast("Tabs are only available for songs");
		const pop = ui.tabsPop;
		const token = (state.tabsToken = (state.tabsToken || 0) + 1);
		const head = h("div", { class: "aur-tabs-head" }, h("span", { class: "aur-tabs-logo", html: ICONS.pick() }), h("div", null, h("div", { class: "aur-tabs-kicker" }, "Songsterr"), h("div", { class: "aur-tabs-song" }, track.title)));
		pop.replaceChildren(head, h("div", { class: "aur-tabs-status" }, "Looking for tabs…"));
		pop.hidden = false;
		void pop.offsetWidth;
		pop.classList.add("is-open");
		ui.tabsBtn.classList.add("is-on");
		let res = null;
		let failed = false;
		try {
			res = await findTabs(track);
		} catch (e) {
			console.warn("[aurora-lyrics] Songsterr search failed", e);
			failed = true;
		}
		if (token !== state.tabsToken) return;
		const searchBtn = (label) => h("button", { class: "aur-btn aur-btn-ghost", onclick: () => (openExternal(songsterrSearchUrl(track)), closeTabs()) }, label);
		if (!res) {
			pop.replaceChildren(head, h("div", { class: "aur-tabs-status" }, failed ? "Couldn't reach Songsterr." : "No tab for this song yet."), h("div", { class: "aur-tabs-actions" }, searchBtn("Search Songsterr")));
			return;
		}
		const LABELS = { guitar: "Guitar", bass: "Bass", drums: "Drums", vocals: "Vocals", other: "Other" };
		const chips = Object.entries(res.parts)
			.filter(([, n]) => n)
			.map(([k, n]) => h("span", { class: "aur-tabs-chip" }, n > 1 ? `${LABELS[k]} ×${n}` : LABELS[k]));
		const diff = res.difficulty ? h("div", { class: "aur-tabs-diff", title: `Guitar difficulty ${res.difficulty} of 5` }, "Guitar difficulty ", h("span", { class: "aur-tabs-dots", style: `--d:${res.difficulty}` }, h("i"), h("i"), h("i"), h("i"), h("i"))) : null;
		pop.replaceChildren(
			head,
			h("div", { class: "aur-tabs-chips" }, chips),
			diff,
			h(
				"div",
				{ class: "aur-tabs-actions" },
				h("button", { class: "aur-btn aur-btn-primary", html: `<span>Open tab</span>${ICONS.external()}`, onclick: () => (openExternal(res.url), closeTabs()) }),
			),
		);
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
				if (!ui.tabsPop.hidden) closeTabs();
				else if (ui.share.isOpen()) ui.share.close();
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
			else if ((e.key === "g" || e.key === "G") && settings.get("tabsButton")) toggleTabs();
			else return;
			e.preventDefault();
			e.stopPropagation();
		},
		true,
	);

	// Keep stats when Spotify closes or goes to the background.
	globalThis.addEventListener?.("pagehide", () => (statsTick(), saveStats()));
	document.addEventListener("visibilitychange", () => {
		if (document.hidden) (statsTick(), saveStats());
		syncRain();
		syncScene();
	});

	// ---------------------------------------------------------------------------
	// Player events (wired by main.js)
	// ---------------------------------------------------------------------------
	return {
		open,
		close,
		toggle: () => (state.open ? close() : open()),
		isOpen: () => state.open,
		onSongChange() {
			state.statsUri = null; // the next counted second is a new play (even of the same song)
			if (state.open) loadLyrics();
			else state.stale = true;
		},
		onPlayPause: () => (kick(), syncCustomVideo()),
		testSources,
		onProgress() {
			// ~1/s while playing and on seeks. Cheap, and makes seeks show up immediately
			// even if animation frames are being throttled.
			if (state.open) kick();
			syncCustomVideo(); // also corrects a background video that missed a play/pause change
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
	// The current line is drawn into nodes reused from line to line: text changes in place and
	// spare word slots are hidden, so a new line never adds or removes nodes (Spicetify's wrapper
	// rescans the whole page whenever that happens; see setText in util.js).
	const dots = h("span", { class: "aur-float-dots", hidden: true }, h("i"), h("i"), h("i"));
	const plain = h("span", { class: "aur-float-plain" }, "");
	const cur = h("div", { class: "aur-float-cur" }, dots, plain);
	const slots = []; // { span, gap }: a word and the whitespace text node after it
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
		if (["miniStyle", "miniNext", "*"].includes(key)) styleMini();
	});
	function styleMini() {
		el.dataset.style = settings.get("miniStyle");
		el.dataset.next = settings.get("miniNext") ? "on" : "off";
		if (!el.hidden) place(); // the size changes with the style
	}
	styleMini();
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

	/** Swap the two lines with a short enter animation. `a` is a line ({ gap } or one with text / words) or plain text. */
	function showLines(a, b, singer = null) {
		setCur(a);
		setText(next, b);
		if (singer) cur.dataset.singer = String(singer);
		else delete cur.dataset.singer;
		for (const n of [cur, next]) {
			n.classList.remove("is-enter");
			void n.offsetWidth;
			n.classList.add("is-enter");
		}
	}

	function setCur(content) {
		const line = typeof content === "string" ? null : content;
		const words = line && !line.gap ? line.words : null;
		dots.hidden = !line?.gap;
		plain.hidden = !!(line?.gap || words);
		setText(plain, plain.hidden ? "" : line ? line.text : content);
		const n = words ? words.length : 0;
		const spans = [];
		for (let i = 0; i < Math.max(n, slots.length); i++) {
			if (i >= n) {
				if (!slots[i].span.hidden) (slots[i].span.hidden = true), (slots[i].gap.data = "");
				continue;
			}
			if (i === slots.length) {
				const span = h("span", { class: "aur-float-w", hidden: true }, "");
				const gap = document.createTextNode("");
				cur.append(span, gap);
				slots.push({ span, gap });
			}
			const { span, gap } = slots[i];
			const m = words[i].text.match(/^(\s*)([\s\S]*?)(\s*)$/);
			const lead = i + 1 < n ? words[i + 1].text.match(/^\s*/)[0] : "";
			setText(span, m[2]);
			if (gap.data !== m[3] + lead) gap.data = m[3] + lead;
			span.classList.remove("sung");
			span.style.removeProperty("--aur-wp");
			span.hidden = false;
			spans.push(span);
		}
		state.words = words ? { words, spans } : null;
	}

	function activate(idx) {
		const ls = state.lyrics.lines;
		state.active = idx;
		state.wordIdx = -1;
		state.words = null;
		const nextText = (from) => ls.slice(from).find((l) => !l.gap)?.text || "";
		if (idx < 0) return showLines({ gap: true }, nextText(0));
		const line = ls[idx];
		showLines(line, nextText(idx + 1), line.gap ? null : (line.singer ?? (line.opposite ? 1 : null)));
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
		setText(next, text);
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

// ---- launcher.js -----------------------------------------------------------
// The buttons that open the lyrics.
//
// Normally there are two, placed by Spicetify's own button APIs: one in Spotify's top bar and one in
// the player bar. Those APIs depend on Spotify's markup, which changes from release to release, so
// this also checks that the buttons are really on screen (every couple of seconds, since Spotify
// redraws its bars) and, if the player-bar one isn't, puts a button of our own there; if there is
// no button on screen at all, a small floating one appears in the corner, so the lyrics can always
// be opened (Alt+L works too).


// Where the player bar's right-hand group of buttons lives, by class and by test id (the test ids
// of its neighbours are the steadier thing to find it by).
const PLAYBAR_HOSTS = [".main-nowPlayingBar-extraControls", '[data-testid="extra-controls"]', '[data-testid="now-playing-bar"] [class*="extraControls"]', "footer [class*='extraControls']"];
const PLAYBAR_ANCHORS = [
	'[data-testid="lyrics-button"]',
	'[data-testid="control-button-npv"]',
	'[data-testid="queue-button"]',
	'[data-testid="control-button-pip"]',
	'[data-testid="control-button-connect"]',
	'[data-testid="volume-bar-toggle-mute-button"]',
];

const isShown = (el) => !!el && el.isConnected && el.getClientRects().length > 0;

function firstMatch(selectors) {
	for (const s of selectors) {
		try {
			const el = document.querySelector(s);
			if (el) return el;
		} catch {}
	}
	return null;
}

/**
 * createLauncher({ label, onToggle, getUri }): sets the buttons up and keeps them on screen.
 * Returns { setOpen(open), retint(), state }.
 */
function createLauncher({ label, onToggle, getUri }) {
	const S = globalThis.Spicetify;
	const state = { topbar: null, playbar: null, playbarApi: null, own: null, float: null, open: false, color: "", timer: 0, ticks: 0, report: "" };

	function makeButton(cls, size) {
		const b = h("button", {
			class: `aur-launch ${cls}`,
			type: "button",
			title: label,
			"aria-label": label,
			html: ICONS.lyrics(size),
			onclick: (e) => {
				e.preventDefault();
				e.stopPropagation();
				onToggle();
			},
		});
		if (state.color) b.style.setProperty("--aur-pb-c", state.color);
		b.classList.toggle("is-on", state.open);
		return b;
	}

	// Spicetify's own buttons, styled as glass tiles (styles.css). Each API is optional across versions.
	try {
		if (S?.Topbar?.Button) {
			const tb = new S.Topbar.Button(label, ICONS.lyrics(20), () => onToggle());
			const el = tb.element?.matches?.("button") ? tb.element : tb.element?.querySelector?.("button") || tb.element;
			el?.classList.add("aur-topbar-btn");
			state.topbar = el || null;
		}
	} catch (e) {
		console.warn("[aurora-lyrics] top bar button unavailable", e);
	}
	try {
		if (S?.Playbar?.Button) {
			state.playbarApi = new S.Playbar.Button(label, ICONS.lyrics(16), () => onToggle(), false, false);
			const el = state.playbarApi.element;
			state.playbar = el?.matches?.("button") ? el : el?.querySelector?.("button") || el || null;
			state.playbar?.classList.add("aur-pb-btn");
		}
	} catch (e) {
		console.warn("[aurora-lyrics] player bar button unavailable", e);
	}

	const every = () => [state.topbar, state.playbar, state.own, state.float];

	/** Our own player-bar button, in the group of buttons on the right (or beside one of its neighbours). */
	function placeOwn() {
		const host = firstMatch(PLAYBAR_HOSTS);
		let parent = host;
		let before = host?.firstChild || null;
		if (!host) {
			const anchor = firstMatch(PLAYBAR_ANCHORS);
			if (!anchor?.parentElement) return;
			parent = anchor.parentElement;
			before = anchor;
		}
		state.own ||= makeButton("aur-launch-pb", 16);
		parent.insertBefore(state.own, before);
	}

	function setFloat(on) {
		if (on && !state.float) {
			state.float = makeButton("aur-launch-float", 20);
			document.body.append(state.float);
		}
		if (state.float) state.float.hidden = !on;
	}

	function ensure() {
		const top = isShown(state.topbar);
		let bar = isShown(state.playbar);
		if (!bar) {
			if (!isShown(state.own)) placeOwn();
			bar = isShown(state.own);
		} else if (state.own) {
			state.own.remove(); // Spicetify's has appeared (or come back): one is enough
			state.own = null;
		}
		setFloat(!top && !bar);
		const report = `top bar ${top ? "yes" : "no"}, player bar ${isShown(state.playbar) ? "yes" : bar ? "own" : "no"}, floating ${top || bar ? "no" : "yes"}`;
		if (report !== state.report) {
			state.report = report;
			console.info(`[aurora-lyrics] buttons: ${report}`);
		}
	}

	// Look a few times while Spotify draws its bars, then now and then, since it redraws them.
	function schedule() {
		const delays = [400, 1000, 2000, 4000];
		state.timer = setTimeout(
			() => {
				ensure();
				state.ticks++;
				schedule();
			},
			delays[state.ticks] ?? 2500,
		);
	}
	schedule();

	return {
		state,
		/** The buttons are lit while the lyrics are open. */
		setOpen(open) {
			state.open = open;
			if (state.playbarApi) state.playbarApi.active = open;
			for (const b of every()) b?.classList.toggle("is-on", open);
		},
		/** They glow in the album's colour. */
		retint() {
			const uri = getUri?.();
			if (!uri || typeof S?.colorExtractor !== "function") return;
			Promise.resolve(S.colorExtractor(uri))
				.then((c) => {
					if (!c) return;
					state.color = c.LIGHT_VIBRANT || c.VIBRANT || c.PROMINENT || "#b98cff";
					for (const b of every()) b?.style.setProperty("--aur-pb-c", state.color);
				})
				.catch(() => {});
		},
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

	let launcher = null;
	let card = null;
	let mini = null;
	const overlay = createOverlay({
		onOpenChange: (open) => {
			launcher?.setOpen(open);
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

	// The buttons that open the lyrics (top bar, player bar, or a floating one if neither is on screen).
	try {
		launcher = createLauncher({ label: "Aurora Lyrics (Alt+L)", onToggle: () => overlay.toggle(), getUri: () => S.Player.data?.item?.uri });
		launcher.retint();
	} catch (e) {
		console.warn(`[${EXT_ID}] buttons unavailable`, e);
	}

	S.Player.addEventListener("songchange", () => (overlay.onSongChange(), card?.onSongChange(), launcher?.retint()));
	S.Player.addEventListener("onplaypause", () => (overlay.onPlayPause(), card?.onPlayPause(), mini?.onPlayPause()));
	S.Player.addEventListener("onprogress", () => (overlay.onProgress(), card?.onProgress(), mini?.onProgress()));

	// Small public handle for debugging from DevTools: window.AuroraLyrics.open()
	globalThis.AuroraLyrics = { open: overlay.open, close: overlay.close, toggle: overlay.toggle, testSources: overlay.testSources, toggleMini: () => mini?.toggle() };
	console.info(`[${EXT_ID}] loaded`);
}

main().catch((e) => console.error("[aurora-lyrics] failed to start", e));
})();
