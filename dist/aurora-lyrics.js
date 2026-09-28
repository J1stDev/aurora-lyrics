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
 */
const LOOK_KEYS = ["view", "font", "fontWeight", "textAlign", "textColor", "glow", "accent", "animation", "wordAnim", "depthBlur", "bgStyle", "bgOpacity"];
const THEMES = [
	{ id: "aurora", label: "Aurora", hint: "The default look", swatch: ["#6d3bd1", "#1b2a6b"], values: {} },
	{ id: "neon", label: "Neon", hint: "Radiant, vivid", swatch: ["#ff2fb3", "#2a0a5e"], values: { font: "outfit", fontWeight: "900", glow: "radiant", textColor: "accent", animation: "scale", wordAnim: "glow", bgStyle: "gradient", bgOpacity: 0.35 } },
	{ id: "minimal", label: "Minimal", hint: "Quiet and clean", swatch: ["#26262b", "#0d0d10"], values: { view: "lyrics", font: "system", fontWeight: "700", glow: "off", animation: "slide", depthBlur: false, bgStyle: "solid" } },
	{ id: "karaoke", label: "Karaoke", hint: "Two-row KTV captions", swatch: ["#ff3d8b", "#0c1542"], values: { view: "captions", font: "rounded", fontWeight: "900", textAlign: "center", accent: "#ff3d8b", glow: "off", animation: "fade", wordAnim: "karaoke", bgOpacity: 0.5 } },
	{ id: "gothic", label: "Gothic", hint: "Candlelit blackletter", swatch: ["#9e1030", "#0d0709"], values: { view: "lyrics", font: "gothic", fontWeight: "700", textAlign: "center", accent: "#c21f3f", animation: "fade", wordAnim: "glow", bgStyle: "gradient", bgOpacity: 0.62 } },
	{ id: "blackmetal", label: "Black Metal", hint: "Frozen forest under the moon", swatch: ["#cfd9e2", "#07090c"], values: { view: "lyrics", font: "gothic", fontWeight: "700", textAlign: "center", accent: "#aebfcd", animation: "fade", wordAnim: "focus", bgOpacity: 0.6 } },
	{ id: "lounge", label: "Lounge", hint: "Spinning vinyl", swatch: ["#c0703a", "#2b1408"], values: { view: "vinyl", font: "serif", fontWeight: "700", animation: "flow", wordAnim: "letters" } },
	{ id: "retro", label: "Retro", hint: "Amber terminal", swatch: ["#ffb000", "#1a1204"], values: { view: "lyrics", font: "mono", fontWeight: "700", textColor: "accent", accent: "#ffb000", animation: "flip", wordAnim: "typewriter", depthBlur: false, bgStyle: "solid" } },
	{ id: "synthwave", label: "Synthwave", hint: "Outrun sunset, chrome type", swatch: ["#ff4fd8", "#1b0b3a"], values: { view: "lyrics", font: "outfit", fontWeight: "900", textAlign: "center", accent: "#ff4fd8", glow: "soft", animation: "slide", wordAnim: "fill", bgStyle: "gradient", bgOpacity: 0.3 } },
	{ id: "zen", label: "Zen", hint: "Soft and slow", swatch: ["#9fd8b8", "#10231c"], values: { view: "lyrics", font: "serif", fontWeight: "500", textAlign: "center", accent: "#9fd8b8", animation: "fade", wordAnim: "focus", bgStyle: "gradient", bgOpacity: 0.55 } },
	{ id: "sunset", label: "Sunset", hint: "Warm shimmer", swatch: ["#ff8a4c", "#3a0e2e"], values: { font: "inter", textColor: "accent", accent: "#ff8a4c", animation: "spring", wordAnim: "shimmer", bgStyle: "gradient", bgOpacity: 0.4 } },
	{ id: "midnight", label: "Midnight", hint: "Cool blue", swatch: ["#7aa2ff", "#0b1330"], values: { font: "inter", textColor: "accent", accent: "#7aa2ff", bgStyle: "gradient", bgOpacity: 0.6 } },
	{ id: "vaporwave", label: "Vaporwave", hint: "Pastel dusk, marble and palms", swatch: ["#ff71ce", "#2b0f5c"], values: { view: "lyrics", font: "outfit", fontWeight: "800", textAlign: "center", accent: "#ff71ce", glow: "soft", animation: "slide", wordAnim: "glow", bgStyle: "gradient", bgOpacity: 0.3 } },
	{ id: "ocean", label: "Ocean", hint: "A dive with light shafts and kelp", swatch: ["#3fb4e8", "#04264f"], values: { view: "lyrics", font: "rounded", fontWeight: "800", textAlign: "center", accent: "#5fd4ff", animation: "flow", wordAnim: "shimmer", bgStyle: "gradient", bgOpacity: 0.3 } },
	{ id: "rain", label: "Rain", hint: "A night window in the rain", swatch: ["#8fb4e6", "#0b1220"], values: { view: "lyrics", font: "inter", fontWeight: "700", textAlign: "center", accent: "#9fc2e8", glow: "soft", animation: "fade", wordAnim: "focus", bgStyle: "gradient", bgOpacity: 0.55 } },
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
const CSS = ".aur-root {\n--aur-font: var(--encore-title-font-stack, \"SpotifyMixUITitle\", \"SpotifyMixUI\", \"CircularSp\", system-ui, sans-serif);\n--aur-fs: 56px;\n--aur-gap: 0.55em;\n--aur-fw: 800;\n--aur-shade: 0.45;\n--aur-bg-scale: 12;\n--aur-bg-blur: 6px;\n--aur-c1: var(--aur-album-c1, #4b3b78);\n--aur-c2: var(--aur-album-c2, #14203a);\n--aur-accent: var(--aur-album-accent, #ffffff);\n--aur-ah: 1.2em;\n--aur-ui-font: var(--encore-body-font-stack, \"SpotifyMixUI\", \"CircularSp\", \"Segoe UI Variable Text\", system-ui, sans-serif);\n--aur-size: min(var(--aur-fs), 7.4vw, 10.5vh);\n--aur-hi: #fff;\n--aur-dim: color-mix(in srgb, var(--aur-hi) 30%, transparent);\n--aur-glow-tint: color-mix(in oklab, var(--aur-accent) 62%, #fff);\n--aur-glow-k: 1;\n--aur-glow-c: color-mix(in oklab, var(--aur-glow-tint) 45%, transparent);\n--aur-green: #1ed760;\n--aur-origin: 0%;\n--aur-pad: max(7vw, 20px);\n--aur-ease: cubic-bezier(0.22, 1, 0.36, 1);\n--aur-spring: cubic-bezier(0.34, 1.56, 0.64, 1);\n--aur-wave: cubic-bezier(0.3, 1.12, 0.44, 1);\n--aur-stagger: 0ms;\n--aur-move: 0.85s;\n--aur-move-ease: var(--aur-ease);\nposition: fixed;\ninset: 0;\nz-index: 99999;\noverflow: hidden;\noverflow: clip;\nisolation: isolate;\ncolor: #fff;\nbackground: #08080b;\nfont-family: var(--aur-ui-font);\n-webkit-font-smoothing: antialiased;\ntext-rendering: optimizeLegibility;\n-webkit-app-region: no-drag;\noutline: none;\nuser-select: none;\nopacity: 0;\ntransform: scale(1.035);\ntransition:\nopacity 0.42s var(--aur-ease),\ntransform 0.7s var(--aur-ease);\n}\n.aur-root[hidden] { display: none; }\nhtml.aur-covered body > :not(.aur-root) { visibility: hidden !important; }\nhtml.aur-covered body > :not(.aur-root, .aur-float),\nhtml.aur-covered body > :not(.aur-root, .aur-float) *,\nhtml.aur-covered body > :not(.aur-root, .aur-float) *::before,\nhtml.aur-covered body > :not(.aur-root, .aur-float) *::after { animation-play-state: paused !important; }\n.aur-root.is-open { opacity: 1; transform: none; }\n.aur-root *, .aur-root *::before, .aur-root *::after { box-sizing: border-box; }\n.aur-root ::selection { background: rgba(255, 255, 255, 0.28); }\n.aur-root[data-align=\"center\"] { --aur-origin: 50%; }\n.aur-root[data-align=\"right\"] { --aur-origin: 100%; }\n.aur-root[data-glow=\"radiant\"] { --aur-glow-k: 1.7; }\n.aur-root[data-glow=\"off\"] { --aur-glow-k: 0; }\n.aur-root[data-color=\"accent\"] { --aur-hi: color-mix(in srgb, var(--aur-accent) 42%, #fff); }\n.aur-root[data-color=\"gradient\"] {\n--aur-grad-a: color-mix(in oklab, var(--aur-accent) 78%, #fff);\n--aur-grad-b: color-mix(in oklab, var(--aur-c2) 50%, #fff);\n--aur-hi: color-mix(in oklab, var(--aur-grad-a) 50%, var(--aur-grad-b));\n}\n.aur-root[data-color=\"gradient\"] .aur-line:not([data-singer]) .aur-w {\n--aur-hi: color-mix(in oklab, var(--aur-grad-a) calc((1 - var(--wx, 0.5)) * 100%), var(--aur-grad-b));\n--aur-kink: var(--aur-hi);\ncolor: var(--aur-hi);\n}\n.aur-root[data-accent=\"custom\"] {\n--aur-accent: var(--aur-user-accent, #ffffff);\n--aur-c1: color-mix(in oklab, var(--aur-user-accent, #4b3b78) 62%, #000);\n--aur-c2: color-mix(in oklab, var(--aur-user-accent, #14203a) 22%, #07070c);\n}\n.aur-root[data-anim=\"flow\"] { --aur-stagger: 36ms; --aur-move: 1.05s; --aur-move-ease: var(--aur-wave); }\n.aur-root[data-anim=\"scale\"] { --aur-stagger: 14ms; --aur-move: 0.95s; --aur-move-ease: cubic-bezier(0.34, 1.3, 0.64, 1); }\n.aur-bg { position: absolute; inset: 0; z-index: -1; overflow: hidden; background: #0a0a0e; }\n.aur-bg-stack, .aur-bg-layer { position: absolute; inset: 0; }\n.aur-bg-layer { opacity: 0; transition: opacity 1.6s ease; }\n.aur-bg-layer.is-on { opacity: 1; }\n.aur-blob {\nposition: absolute;\nleft: 50%;\ntop: 50%;\nwidth: 256px;\nheight: 256px;\nmax-width: none;\nmargin: -128px 0 0 -128px;\nobject-fit: cover;\nfilter: blur(var(--aur-bg-blur)) saturate(1.7) brightness(0.92);\ntransform: translate(var(--bx, 0), var(--by, 0)) scale(calc(var(--aur-bg-scale) * var(--bs, 1)));\nanimation: aur-spin var(--bt, 120s) steps(3600) infinite;\nwill-change: transform;\n}\n.aur-blob.b3 { --bt: 150s; animation-direction: reverse; }\n.aur-blob.b1 { --bx: -20vw; --by: -14vh; --bs: 0.7; --bt: 70s; opacity: 0.85; border-radius: 42%; animation-delay: -20s; }\n.aur-blob.b2 { --bx: 22vw; --by: 16vh; --bs: 0.62; --bt: 95s; opacity: 0.7; border-radius: 46%; animation-direction: reverse; animation-delay: -45s; }\n.aur-root[data-bganim=\"off\"] .aur-blob,\n.aur-root[data-bganim=\"off\"] .aur-bg-gradient { animation-play-state: paused; }\n@keyframes aur-spin { to { rotate: 360deg; } }\n.aur-bg-gradient {\nposition: absolute;\ninset: -30%;\nopacity: 0;\nbackground:\nradial-gradient(42% 42% at 30% 35%, var(--aur-c1) 0%, transparent 70%),\nradial-gradient(48% 48% at 70% 65%, var(--aur-c2) 0%, transparent 72%),\nradial-gradient(35% 35% at 75% 20%, color-mix(in srgb, var(--aur-accent) 40%, transparent) 0%, transparent 70%),\n#0b0b10;\ntransition: opacity 1s ease;\nanimation: aur-drift 36s steps(1080) infinite alternate;\n}\n.aur-root[data-bg=\"gradient\"] .aur-bg-gradient { opacity: 1; }\n.aur-root:not([data-bg=\"gradient\"]) .aur-bg-gradient { animation: none; }\n.aur-root:not([data-bg=\"album\"]) .aur-bg-stack { display: none; }\n@keyframes aur-drift {\nfrom { transform: translate3d(-3%, -2%, 0) rotate(0deg) scale(1); }\nto { transform: translate3d(3%, 2%, 0) rotate(10deg) scale(1.1); }\n}\n.aur-bg-shade {\nposition: absolute;\ninset: 0;\nbackground:\nlinear-gradient(to top, rgba(0, 0, 0, 0.55), rgba(0, 0, 0, 0.18) 16%, transparent 34%),\nradial-gradient(ellipse at 42% 40%, rgba(0, 0, 0, calc(var(--aur-shade) * 0.6)) 0%, rgba(0, 0, 0, var(--aur-shade)) 100%);\n}\n.aur-bg-grain {\nposition: absolute;\ninset: 0;\nopacity: 0.035;\nbackground-size: 180px 180px;\nbackground-image: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\");\npointer-events: none;\n}\n.aur-drag { position: absolute; top: 0; left: 0; right: 0; height: 40px; -webkit-app-region: drag; z-index: 1; }\n.aur-header {\nposition: absolute;\ntop: 30px;\nleft: var(--aur-pad);\nz-index: 2;\ndisplay: flex;\nalign-items: center;\ngap: 14px;\nmax-width: min(560px, 55vw);\npointer-events: none;\ntransition: opacity 0.5s ease, transform 0.6s var(--aur-ease);\n}\n.aur-root[data-info=\"off\"] .aur-header { display: none; }\n.aur-cover { width: 54px; height: 54px; flex: none; border-radius: 8px; object-fit: cover; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45); }\n.aur-meta { min-width: 0; }\n.aur-title, .aur-artist { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.aur-title { font-size: 15.5px; font-weight: 700; letter-spacing: -0.01em; }\n.aur-artist { margin-top: 3px; font-size: 13px; color: rgba(255, 255, 255, 0.62); }\n.aur-stage {\nposition: absolute;\ninset: 0;\npadding: 0 var(--aur-pad);\noverflow: hidden;\n-webkit-mask-image: linear-gradient(to bottom, transparent 0, transparent 72px, #000 calc(72px + 13%), #000 72%, transparent 93%);\nmask-image: linear-gradient(to bottom, transparent 0, transparent 72px, #000 calc(72px + 13%), #000 72%, transparent 93%);\n}\n.aur-lines { position: relative; }\n.aur-root:not([data-transport=\"off\"]) .aur-stage { bottom: 96px; }\n.aur-root[data-align=\"center\"] .aur-stage { text-align: center; }\n.aur-root[data-align=\"right\"] .aur-stage { text-align: right; }\n.aur-stage > .aur-lines,\n.aur-stage > .aur-message { transition: opacity 0.22s ease, filter 0.22s ease; }\n.aur-stage.is-leaving > .aur-lines,\n.aur-stage.is-leaving > .aur-message { opacity: 0; filter: blur(8px); }\n.aur-line {\n--aur-s: 0.95;\n--aur-k: 0;\nfont-family: var(--aur-font);\nfont-size: var(--aur-size);\nfont-weight: var(--aur-fw);\nline-height: 1.16;\nletter-spacing: -0.022em;\npadding: calc(var(--aur-gap) / 2) 0;\nmax-width: 1400px;\ncolor: var(--aur-hi);\nopacity: 0.1;\ntransform-origin: var(--aur-origin) 50%;\noverflow-wrap: anywhere;\ntext-wrap: balance;\nfont-kerning: normal;\ncursor: pointer;\ntransition:\nopacity 0.7s var(--aur-ease),\ntransform var(--aur-move) var(--aur-move-ease) calc(var(--aur-k) * var(--aur-stagger)),\nfilter 0.7s var(--aur-ease),\ncolor 0.5s ease,\ntext-shadow 0.7s ease;\n}\n.aur-root[data-align=\"center\"] .aur-line { margin-inline: auto; }\n.aur-root[data-align=\"right\"] .aur-line { margin-left: auto; }\n.aur-root .aur-line.is-active { --aur-s: 1; opacity: 1; cursor: default; }\n.aur-root:not([data-glow=\"off\"]) .aur-line.is-active:not(.has-words) .aur-main {\ntext-shadow:\n0 0 0.05em color-mix(in srgb, #fff calc(28% * var(--aur-glow-k)), transparent),\n0 0 0.26em color-mix(in oklab, var(--aur-glow-tint) calc(30% * var(--aur-glow-k)), transparent),\n0 0 0.85em color-mix(in oklab, var(--aur-glow-tint) calc(16% * var(--aur-glow-k)), transparent);\n}\n.aur-main { transition: text-shadow 0.8s ease; }\n.aur-main { position: relative; }\n.aur-main::before {\n--a: calc(13% * var(--aur-glow-k));\ncontent: \"\";\nposition: absolute;\nz-index: -1;\nleft: calc(var(--hx, 0px) - 1.1em);\ntop: calc(var(--hy, 0px) - 0.7em);\nwidth: calc(var(--hw, 100%) + 2.2em);\nheight: calc(var(--hh, 100%) + 1.4em);\npointer-events: none;\nbackground: radial-gradient(closest-side, color-mix(in oklab, var(--aur-glow-tint) var(--a), transparent) 0%, color-mix(in oklab, var(--aur-glow-tint) calc(var(--a) * 0.45), transparent) 55%, transparent 100%);\nopacity: 0;\ntransform: scale(0.85);\ntransition: opacity 1.2s ease, transform 1.6s var(--aur-ease);\n}\n.aur-line.is-active .aur-main::before { opacity: 1; transform: none; }\n.aur-stage[data-mode=\"unsynced\"] .aur-main::before { display: none; }\n@property --aur-wp { syntax: \"<number>\"; inherits: true; initial-value: 0; }\n.aur-wg { display: inline-block; white-space: nowrap; }\n.aur-w, .aur-c { display: inline-block; }\n.aur-root[data-words=\"on\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--p: var(--aur-wp);\n--e: calc(var(--p) * var(--p) * (3 - 2 * var(--p)));\n--hop: sin(calc(var(--e) * 3.14159));\n--edge: 0.75em;\ntransform-origin: 50% 90%;\n}\n.aur-root[data-words=\"on\"] .is-active.has-words .aur-w.now:not(.has-chars),\n.aur-root[data-words=\"on\"] .is-active.has-words .aur-w.now .aur-c { will-change: transform; }\n.aur-root[data-words=\"on\"] .is-active.has-words .aur-w .aur-c {\n--wave: 2.6;\n--p: clamp(0, (var(--aur-wp) * (var(--n) + var(--wave)) - var(--i)) / var(--wave), 1);\n--edge: 0.4em;\n}\n.aur-root[data-words=\"on\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\ncolor: color-mix(in srgb, var(--aur-hi) calc(var(--e) * 100%), var(--aur-dim));\ntransform: translateY(calc(0.03em - var(--e) * 0.075em));\n}\n.aur-root:not([data-glow=\"off\"])[data-words=\"on\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--g: calc(var(--e) * var(--aur-glow-k));\nfilter:\ndrop-shadow(0 0 0.04em color-mix(in srgb, #fff calc(32% * var(--g)), transparent))\ndrop-shadow(0 0 0.3em color-mix(in oklab, var(--aur-glow-tint) calc(34% * var(--g)), transparent));\n}\n.aur-root[data-words=\"on\"]:is([data-wordanim=\"fill\"], [data-wordanim=\"rise\"], [data-wordanim=\"karaoke\"], [data-wordanim=\"letters\"]) .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\ncolor: transparent;\nbackground-image: linear-gradient(90deg, var(--aur-ink, var(--aur-hi)) calc(var(--p) * (100% + var(--edge)) - var(--edge)), var(--aur-dim) calc(var(--p) * (100% + var(--edge))));\n-webkit-background-clip: text;\nbackground-clip: text;\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"glow\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--lit: clamp(0, var(--e) * 3, 1);\ncolor: color-mix(in srgb, var(--aur-hi) calc(var(--lit) * 100%), var(--aur-dim));\ntransform: translateY(calc(0.03em - var(--lit) * 0.07em)) scale(calc(1 + 0.04 * var(--hop)));\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"glow\"] .is-active .aur-w.now:not(.has-chars),\n.aur-root[data-words=\"on\"][data-wordanim=\"glow\"] .is-active .aur-w.now .aur-c {\n--gk: max(var(--aur-glow-k), 0.6);\nfilter:\ndrop-shadow(0 0 0.05em color-mix(in srgb, #fff calc((30% + 25% * var(--hop)) * var(--gk)), transparent))\ndrop-shadow(0 0 calc(0.25em + 0.3em * var(--hop)) color-mix(in oklab, var(--aur-glow-tint) calc((32% + 30% * var(--hop)) * var(--gk)), transparent));\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"pop\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--lit: clamp(0, var(--e) * 4, 1);\ncolor: color-mix(in srgb, var(--aur-hi) calc(var(--lit) * 100%), var(--aur-dim));\ntransform: translateY(calc(0.03em - var(--lit) * 0.06em - 0.06em * var(--hop))) scale(calc(1 + 0.12 * var(--hop)));\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"rise\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--up: clamp(0, var(--e) * 2.2, 1);\n--up-e: calc(1 - (1 - var(--up)) * (1 - var(--up)));\nopacity: calc(0.45 + 0.55 * var(--up-e));\ntransform: translateY(calc((1 - var(--up-e)) * 0.2em - 0.04em));\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"karaoke\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--aur-ink: var(--aur-kink, color-mix(in srgb, var(--aur-accent) 70%, #fff));\n--edge: 0.18em;\ntransform: none;\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"letters\"] .is-active.has-words .aur-w .aur-c {\n--wave: 3.2;\ntransform-origin: 50% 85%;\ntransform: translateY(calc(0.03em - var(--e) * 0.06em - 0.16em * var(--hop))) rotate(calc(-4deg * var(--hop))) scale(calc(1 + 0.11 * var(--hop)));\n}\n.aur-root:not([data-glow=\"off\"])[data-words=\"on\"][data-wordanim=\"letters\"] .is-active.has-words .aur-w .aur-c {\nfilter:\ndrop-shadow(0 0 0.04em color-mix(in srgb, #fff calc((24% * var(--e) + 30% * var(--hop)) * var(--aur-glow-k)), transparent))\ndrop-shadow(0 0 calc(0.2em + 0.2em * var(--hop)) color-mix(in oklab, var(--aur-glow-tint) calc((28% * var(--e) + 36% * var(--hop)) * var(--aur-glow-k)), transparent));\n}\n.aur-root[data-words=\"on\"]:not([data-wordanim=\"karaoke\"]):not([data-wordanim=\"letters\"]):not([data-wordanim=\"typewriter\"]) .is-active .aur-w.is-long .aur-c {\ntransform: translateY(calc(0.03em - var(--e) * 0.075em - 0.08em * var(--hop))) scale(calc(1 + 0.05 * var(--hop)));\n}\n.aur-root[data-words=\"on\"] .is-active .aur-w.is-long.now .aur-c {\nfilter:\ndrop-shadow(0 0 0.05em color-mix(in srgb, #fff calc((20% + 30% * var(--hop)) * var(--aur-glow-k)), transparent))\ndrop-shadow(0 0 calc(0.22em + 0.25em * var(--hop)) color-mix(in oklab, var(--aur-glow-tint) calc((30% + 35% * var(--hop)) * var(--aur-glow-k)), transparent));\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"focus\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--lit: clamp(0, var(--e) * 2.2, 1);\ncolor: color-mix(in srgb, var(--aur-hi) calc(var(--lit) * 100%), var(--aur-dim));\ntransform: translateY(calc(0.03em - var(--lit) * 0.05em)) scale(calc(0.965 + 0.035 * var(--lit)));\nfilter: blur(calc((1 - var(--lit)) * 0.045em))\ndrop-shadow(0 0 0.3em color-mix(in oklab, var(--aur-glow-tint) calc(30% * var(--lit) * var(--aur-glow-k)), transparent));\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"focus\"] .aur-stage[data-mode=\"synced\"] .aur-line.has-words:not(.is-active)[data-d=\"1\"] .aur-main { filter: blur(0.045em); }\n.aur-root[data-words=\"on\"][data-wordanim=\"bounce\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--hh: 0.2em;\n--lit: clamp(0, var(--e) * 4, 1);\n--t: clamp(0, var(--p) * 1.8, 1);\n--h1: sin(calc(clamp(0, var(--t) / 0.6, 1) * 3.14159));\n--sq: sin(calc(clamp(0, (var(--t) - 0.52) / 0.2, 1) * 3.14159));\n--h2: sin(calc(clamp(0, (var(--t) - 0.66) / 0.34, 1) * 3.14159));\ncolor: color-mix(in srgb, var(--aur-hi) calc(var(--lit) * 100%), var(--aur-dim));\ntransform-origin: 50% 100%;\ntransform: translateY(calc(0.02em - var(--h1) * var(--hh) - var(--h2) * var(--hh) * 0.25))\nscale(calc(1 - 0.03 * var(--h1) + 0.07 * var(--sq)), calc(1 + 0.07 * var(--h1) - 0.09 * var(--sq)));\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"bounce\"] .is-active.has-words .aur-w.is-long .aur-c { --hh: 0.28em; }\n.aur-root[data-words=\"on\"][data-wordanim=\"neon\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--lit: clamp(0, var(--e) * 5, 1);\n--neon: color-mix(in oklab, var(--aur-accent) 70%, #fff);\n--gk: max(var(--aur-glow-k), 0.7);\ncolor: color-mix(in srgb, var(--neon) calc(var(--lit) * 100%), color-mix(in srgb, var(--aur-hi) 22%, transparent));\n-webkit-text-stroke: 0.014em color-mix(in oklab, var(--neon) calc((1 - var(--lit)) * 50%), transparent);\ntransform: none;\nfilter:\ndrop-shadow(0 0 0.05em color-mix(in srgb, #fff calc(38% * var(--lit) * var(--gk)), transparent))\ndrop-shadow(0 0 0.32em color-mix(in oklab, var(--neon) calc(75% * var(--lit) * var(--gk)), transparent));\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"neon\"] .is-active .aur-w.now { animation: aur-neon-on 0.5s linear; }\n@keyframes aur-neon-on {\n0% { opacity: 0.3; }\n8% { opacity: 1; }\n14% { opacity: 0.45; }\n22% { opacity: 1; }\n30% { opacity: 0.75; }\n38%, 100% { opacity: 1; }\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"typewriter\"] .is-active.has-words .aur-w .aur-c { --wave: 1.1; position: relative; }\n.aur-root[data-words=\"on\"][data-wordanim=\"typewriter\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--lit: clamp(0, var(--p) * 3.5, 1);\ncolor: color-mix(in srgb, var(--aur-hi) calc(var(--lit) * 100%), color-mix(in srgb, var(--aur-hi) 16%, transparent));\ntransform: translateY(calc((1 - var(--lit)) * 0.1em)) scale(calc(0.92 + 0.08 * var(--lit)));\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"typewriter\"] .is-active.has-words .aur-w .aur-c::after {\ncontent: \"\";\nposition: absolute;\ntop: 0.14em;\nbottom: 0.1em;\nright: -0.05em;\nwidth: 0.07em;\nborder-radius: 0.04em;\nbackground: var(--aur-hi);\nopacity: clamp(0, var(--p) * (1 - var(--p)) * 8, 1);\n}\n.aur-root[data-words=\"on\"][data-wordanim=\"shimmer\"] .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--x: calc(var(--p) * (100% + 1.4em));\n--sung: color-mix(in oklab, var(--aur-hi) 76%, var(--aur-accent));\n--rim: color-mix(in oklab, var(--aur-accent) 45%, #fff);\ncolor: transparent;\nbackground-image:\nlinear-gradient(180deg, rgba(255, 255, 255, 0.2), transparent 55%),\nlinear-gradient(90deg, var(--sung) calc(var(--x) - 1.4em), #fff calc(var(--x) - 0.7em), var(--rim) calc(var(--x) - 0.35em), var(--aur-dim) var(--x));\n-webkit-background-clip: text;\nbackground-clip: text;\nfilter:\ndrop-shadow(0 0 0.04em color-mix(in srgb, #fff calc((22% * var(--e) + 30% * var(--hop)) * max(var(--aur-glow-k), 0.5)), transparent))\ndrop-shadow(0 0 0.3em color-mix(in oklab, var(--rim) calc((24% * var(--e) + 34% * var(--hop)) * max(var(--aur-glow-k), 0.5)), transparent));\n}\n.aur-tr {\nmargin-top: 0.22em;\nfont-family: var(--aur-ui-font);\nfont-size: 0.44em;\nfont-weight: 600;\nline-height: 1.3;\nletter-spacing: 0;\ncolor: rgba(255, 255, 255, 0.62);\ntext-wrap: balance;\ntransition: color 0.5s ease;\n}\n.aur-line.is-active .aur-tr { color: rgba(255, 255, 255, 0.9); }\n.aur-stage[data-mode=\"unsynced\"] .aur-tr { font-size: 0.6em; }\n.aur-root[data-view=\"captions\"] .aur-tr { font-size: 0.5em; }\n.aur-tr-btn.is-on { background: rgba(255, 255, 255, 0.08); }\n.aur-root { --aur-duet: oklch(from var(--aur-accent) 0.86 clamp(0.09, c, 0.16) h); }\n.aur-root:is([data-color=\"accent\"], [data-wordanim=\"karaoke\"]) { --aur-duet: oklch(from var(--aur-accent) 0.86 clamp(0.09, c, 0.16) calc(h + 150)); }\n.aur-root[data-duet=\"on\"] .aur-line[data-singer=\"1\"] { --aur-hi: var(--aur-duet); --aur-kink: var(--aur-duet); }\n.aur-root[data-duet=\"on\"] .aur-line[data-singer=\"2\"] { --aur-hi: color-mix(in oklab, var(--aur-duet) 50%, #fff); --aur-kink: color-mix(in oklab, var(--aur-duet) 50%, #fff); }\n.aur-root[data-duet=\"on\"] .aur-line:is([data-singer=\"1\"], [data-singer=\"2\"]) {\n--aur-dim: color-mix(in srgb, var(--aur-hi) 30%, transparent);\n--aur-glow-tint: color-mix(in oklab, var(--aur-hi) 70%, #fff);\n--aur-glow-c: color-mix(in oklab, var(--aur-glow-tint) 45%, transparent);\n}\n.aur-root[data-align=\"left\"] .aur-line.is-opposite { --aur-origin: 100%; text-align: right; margin-left: auto; }\n.aur-root[data-align=\"right\"] .aur-line.is-opposite { --aur-origin: 0%; text-align: left; margin-left: 0; margin-right: auto; }\n.aur-bgv {\nmargin-top: 0.12em;\nfont-size: 0.56em;\nfont-weight: calc(var(--aur-fw) - 100);\nletter-spacing: -0.01em;\nopacity: 0.55;\ntransition: opacity 0.6s ease;\n}\n.aur-line.is-active .aur-bgv { opacity: 0.85; }\n.aur-line.is-gap { cursor: default; }\n.aur-dots { display: inline-flex; align-items: center; gap: 0.32em; height: 1.16em; transform-origin: var(--aur-origin) 50%; }\n.aur-dots i { width: 0.28em; height: 0.28em; border-radius: 50%; background: var(--aur-hi); opacity: 0.3; transform: scale(0.8); transition: opacity 0.4s ease, transform 0.5s var(--aur-spring); }\n.is-active .aur-dots { animation: aur-breathe 3s ease-in-out infinite; }\n.is-active .aur-dots i:nth-child(1) { opacity: calc(0.3 + 0.7 * clamp(0, var(--aur-gp, 0) * 3, 1)); transform: scale(calc(0.8 + 0.35 * clamp(0, var(--aur-gp, 0) * 3, 1))); }\n.is-active .aur-dots i:nth-child(2) { opacity: calc(0.3 + 0.7 * clamp(0, var(--aur-gp, 0) * 3 - 1, 1)); transform: scale(calc(0.8 + 0.35 * clamp(0, var(--aur-gp, 0) * 3 - 1, 1))); }\n.is-active .aur-dots i:nth-child(3) { opacity: calc(0.3 + 0.7 * clamp(0, var(--aur-gp, 0) * 3 - 2, 1)); transform: scale(calc(0.8 + 0.35 * clamp(0, var(--aur-gp, 0) * 3 - 2, 1))); }\n@keyframes aur-breathe {\n0%, 100% { transform: scale(1); }\n50% { transform: scale(1.14); }\n}\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line {\ntransform: translate(0, var(--aur-y, 0px)) scale(var(--aur-s));\ntransition: none;\n}\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line:is([data-d], .is-active) {\ntransform: translate3d(0, var(--aur-y, 0px), 0) scale(var(--aur-s));\ntransition:\nopacity 0.7s var(--aur-ease),\ntransform var(--aur-move) var(--aur-move-ease) calc(var(--aur-k) * var(--aur-stagger)),\nfilter 0.7s var(--aur-ease),\ncolor 0.5s ease,\ntext-shadow 0.7s ease;\n}\n.aur-root[data-anim=\"flow\"] .aur-line { --aur-s: 0.96; }\n.aur-root[data-anim=\"scale\"] .aur-line { --aur-s: 0.8; }\n.aur-root[data-anim=\"scale\"] .aur-line[data-d=\"-1\"],\n.aur-root[data-anim=\"scale\"] .aur-line[data-d=\"1\"] { --aur-s: 0.86; }\n.aur-root .aur-line.is-active { --aur-s: 1; }\n.aur-root[data-anim=\"scale\"] .aur-line.is-active { --aur-s: 1.04; }\n.aur-root[data-layout=\"list\"] .aur-line[data-d=\"-1\"], .aur-root[data-layout=\"list\"] .aur-line[data-d=\"1\"] { opacity: 0.36; }\n.aur-root[data-layout=\"list\"] .aur-line[data-d=\"-2\"], .aur-root[data-layout=\"list\"] .aur-line[data-d=\"2\"] { opacity: 0.24; }\n.aur-root[data-layout=\"list\"] .aur-line[data-d=\"-3\"], .aur-root[data-layout=\"list\"] .aur-line[data-d=\"3\"] { opacity: 0.17; }\n.aur-root[data-layout=\"list\"] .aur-line[data-d=\"-4\"], .aur-root[data-layout=\"list\"] .aur-line[data-d=\"4\"] { opacity: 0.13; }\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-1\"],\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"1\"] { filter: blur(0.8px); }\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-2\"],\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"2\"] { filter: blur(1.5px); }\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-3\"],\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"3\"] { filter: blur(2.2px); }\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-4\"],\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"4\"],\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-5\"],\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"5\"],\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-6\"],\n.aur-root[data-depth=\"on\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"6\"] { filter: blur(2.8px); }\n.aur-lines[data-dir=\"up\"] .aur-line[data-d=\"-1\"] { --aur-k: 1; }\n.aur-lines[data-dir=\"up\"] .aur-line[data-d=\"0\"] { --aur-k: 2; }\n.aur-lines[data-dir=\"up\"] .aur-line[data-d=\"1\"] { --aur-k: 3; }\n.aur-lines[data-dir=\"up\"] .aur-line[data-d=\"2\"] { --aur-k: 4; }\n.aur-lines[data-dir=\"up\"] .aur-line[data-d=\"3\"] { --aur-k: 5; }\n.aur-lines[data-dir=\"up\"] .aur-line[data-d=\"4\"] { --aur-k: 6; }\n.aur-lines[data-dir=\"up\"] .aur-line[data-d=\"5\"] { --aur-k: 7; }\n.aur-lines[data-dir=\"up\"] .aur-line[data-d=\"6\"],\n.aur-lines[data-dir=\"up\"] .aur-line.is-active ~ .aur-line:not([data-d]) { --aur-k: 8; }\n.aur-lines[data-dir=\"down\"] .aur-line:not([data-d]) { --aur-k: 8; }\n.aur-lines[data-dir=\"down\"] .aur-line.is-active ~ .aur-line:not([data-d]) { --aur-k: 0; }\n.aur-lines[data-dir=\"down\"] .aur-line[data-d=\"1\"] { --aur-k: 1; }\n.aur-lines[data-dir=\"down\"] .aur-line[data-d=\"0\"] { --aur-k: 2; }\n.aur-lines[data-dir=\"down\"] .aur-line[data-d=\"-1\"] { --aur-k: 3; }\n.aur-lines[data-dir=\"down\"] .aur-line[data-d=\"-2\"] { --aur-k: 4; }\n.aur-lines[data-dir=\"down\"] .aur-line[data-d=\"-3\"] { --aur-k: 5; }\n.aur-lines[data-dir=\"down\"] .aur-line[data-d=\"-4\"] { --aur-k: 6; }\n.aur-lines[data-dir=\"down\"] .aur-line[data-d=\"-5\"] { --aur-k: 7; }\n.aur-lines[data-dir=\"down\"] .aur-line[data-d=\"-6\"] { --aur-k: 8; }\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-gap) { position: relative; }\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-active):not(.is-gap):hover { opacity: 0.82; filter: none; transition-duration: 0.25s, var(--aur-move), 0.25s, 0.3s, 0.3s; }\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-gap)::after {\ncontent: \"\";\nposition: absolute;\nz-index: -1;\ninset: 0 -0.32em;\nborder-radius: 0.28em;\nbackground: linear-gradient(90deg, rgba(255, 255, 255, 0.09), rgba(255, 255, 255, 0.04));\nbox-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06), 0 0.2em 0.6em rgba(0, 0, 0, 0.12);\nopacity: 0;\ntransform: scale(0.97);\ntransition: opacity 0.25s ease, transform 0.4s var(--aur-ease);\npointer-events: none;\n}\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-time]::before {\ncontent: attr(data-time) \"  ▶\";\nposition: absolute;\ntop: 50%;\nright: 0.1em;\npadding: 0.35em 0.75em;\nborder-radius: 99px;\nbackground: rgba(0, 0, 0, 0.28);\nfont-family: var(--aur-ui-font);\nfont-size: max(11px, 0.2em);\nfont-weight: 700;\nletter-spacing: 0.02em;\nwhite-space: pre;\ncolor: rgba(255, 255, 255, 0.85);\nopacity: 0;\ntransform: translate(0.4em, -50%);\ntransition: opacity 0.2s ease, transform 0.35s var(--aur-ease);\npointer-events: none;\n}\n.aur-root[data-align=\"right\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-time]::before { right: auto; left: 0.1em; transform: translate(-0.4em, -50%); }\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-gap):hover::after { opacity: 1; transform: none; }\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-time]:hover::before { opacity: 1; transform: translate(0, -50%); }\n.aur-root[data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-gap):active::after { transform: scale(0.985); }\n.aur-root[data-view=\"captions\"] .aur-line::before, .aur-root[data-view=\"captions\"] .aur-line::after { display: none; }\n.aur-root[data-layout=\"list\"] .aur-stage.is-browsing .aur-line {\n--aur-k: 0 !important;\nfilter: none !important;\ntransition:\nopacity 0.4s ease,\ntransform 0.45s var(--aur-ease),\nfilter 0.3s ease,\ncolor 0.4s ease,\ntext-shadow 0.4s ease;\n}\n.aur-root[data-layout=\"list\"] .aur-stage.is-browsing .aur-line:not(.is-active) { opacity: 0.42; }\n.aur-root[data-layout=\"list\"] .aur-stage.is-browsing .aur-line:not(.is-active):not(.is-gap):hover { opacity: 0.9; }\n.aur-root[data-layout=\"list\"] .aur-stage.is-entering[data-mode=\"synced\"] .aur-line {\nanimation: aur-line-in 1s var(--aur-ease) backwards;\nanimation-delay: calc(var(--i, 0) * 55ms);\n}\n@keyframes aur-line-in {\nfrom { opacity: 0; transform: translate3d(0, calc(var(--aur-y, 0px) + 64px), 0) scale(var(--aur-s)); filter: blur(12px); }\n}\n.aur-root[data-layout=\"stack\"] .aur-stage[data-mode=\"synced\"] .aur-lines { position: absolute; top: 0; bottom: 0; left: var(--aur-pad); right: var(--aur-pad); }\n.aur-root[data-layout=\"stack\"] .aur-stage[data-mode=\"synced\"] .aur-line {\nposition: absolute;\nleft: 0;\nright: 0;\ntop: 44%;\nopacity: 0;\npointer-events: none;\ntransform: translateY(-50%) scale(0.5);\n}\n.aur-root[data-layout=\"stack\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active { opacity: 1; pointer-events: auto; transform: translateY(-50%); }\n.aur-root[data-layout=\"stack\"] .aur-stage.is-entering[data-mode=\"synced\"] .aur-lines { animation: aur-fade-up 0.9s var(--aur-ease) backwards; }\n.aur-root[data-anim=\"fade\"] .aur-line { transition-duration: 0.55s, 0.8s, 0.6s, 0.5s, 0.6s; }\n.aur-root[data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-1\"] { opacity: 0.3; pointer-events: auto; transform: translateY(calc(var(--aur-ah) / -2 - 0.3em - 81%)) scale(0.62); }\n.aur-root[data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"1\"] { opacity: 0.3; pointer-events: auto; transform: translateY(calc(var(--aur-ah) / 2 + 0.3em - 19%)) scale(0.62); }\n.aur-root[data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-2\"] { transform: translateY(calc(var(--aur-ah) / -2 - 1.6em - 75%)) scale(0.5); }\n.aur-root[data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"2\"] { transform: translateY(calc(var(--aur-ah) / 2 + 1.6em - 25%)) scale(0.5); }\n.aur-root[data-depth=\"on\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"-1\"],\n.aur-root[data-depth=\"on\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"1\"] { filter: blur(1px); }\n.aur-root[data-anim=\"cinematic\"] .aur-line { letter-spacing: -0.015em; transition-duration: 0.9s, 1.1s, 0.9s, 0.5s, 0.9s; }\n.aur-root[data-anim=\"cinematic\"] .aur-stage[data-mode=\"synced\"] .aur-line { transform: translateY(calc(-50% + 0.45em)) scale(0.97); }\n.aur-root[data-anim=\"cinematic\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d] { filter: blur(16px); }\n.aur-root[data-anim=\"cinematic\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d^=\"-\"] { transform: translateY(calc(-50% - 0.45em)) scale(1.03); }\n.aur-root[data-anim=\"cinematic\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active { filter: none; transform: translateY(-50%) scale(1.05); transition-delay: 0s, 0.14s, 0.14s, 0s, 0s; }\n.aur-root[data-anim=\"spring\"] { --aur-stagger: 42ms; --aur-move: 1.15s; --aur-move-ease: cubic-bezier(0.3, 1.55, 0.5, 1); }\n.aur-root[data-anim=\"spring\"] .aur-line { --aur-s: 0.95; }\n.aur-root[data-anim=\"spring\"] .aur-line.is-active { --aur-s: 1.02; }\n.aur-root[data-anim=\"spring\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active .aur-main {\ntransform-origin: var(--aur-origin) 60%;\nanimation: aur-spring-settle 0.75s cubic-bezier(0.3, 1.6, 0.5, 1);\n}\n@keyframes aur-spring-settle { from { transform: translateY(0.08em) scale(0.97); } }\n.aur-root[data-anim=\"wheel\"] { --aur-stagger: 0ms; --aur-move: 1s; --aur-move-ease: cubic-bezier(0.22, 1.08, 0.36, 1); }\n.aur-root[data-anim=\"wheel\"] .aur-stage[data-mode=\"synced\"] .aur-lines { perspective: 1100px; perspective-origin: 50% var(--aur-anchor-y, 40%); }\n.aur-root[data-anim=\"wheel\"] .aur-stage[data-mode=\"synced\"] .aur-line {\ntransform: translate3d(0, calc(var(--aur-y, 0px) - var(--dd, 0) * var(--ad, 0) * 0.09em), calc(var(--ad, 0) * -0.35em)) rotateX(calc(var(--dd, 0) * -19deg));\ntransform-origin: 50% 50%;\nbackface-visibility: hidden;\n}\n.aur-root[data-anim=\"wheel\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d] { opacity: calc(0.6 - var(--ad, 0) * 0.11); }\n.aur-root[data-anim=\"wheel\"] .aur-stage[data-mode=\"synced\"] .aur-line:not([data-d]) { opacity: 0; }\n.aur-root[data-anim=\"wheel\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active { opacity: 1; }\n.aur-line[data-d=\"-6\"] { --dd: -6; --ad: 6; }\n.aur-line[data-d=\"-5\"] { --dd: -5; --ad: 5; }\n.aur-line[data-d=\"-4\"] { --dd: -4; --ad: 4; }\n.aur-line[data-d=\"-3\"] { --dd: -3; --ad: 3; }\n.aur-line[data-d=\"-2\"] { --dd: -2; --ad: 2; }\n.aur-line[data-d=\"-1\"] { --dd: -1; --ad: 1; }\n.aur-line[data-d=\"1\"] { --dd: 1; --ad: 1; }\n.aur-line[data-d=\"2\"] { --dd: 2; --ad: 2; }\n.aur-line[data-d=\"3\"] { --dd: 3; --ad: 3; }\n.aur-line[data-d=\"4\"] { --dd: 4; --ad: 4; }\n.aur-line[data-d=\"5\"] { --dd: 5; --ad: 5; }\n.aur-line[data-d=\"6\"] { --dd: 6; --ad: 6; }\n.aur-root[data-anim=\"swipe\"] .aur-stage[data-mode=\"synced\"] .aur-line {\ntransform: translate(1.8em, -50%) skewX(-8deg) scale(0.97);\nfilter: blur(4px);\ntransition-duration: 0.5s, 0.8s, 0.6s, 0.5s, 0.6s;\ntransition-timing-function: ease, cubic-bezier(0.22, 1, 0.36, 1), ease, ease, ease;\n}\n.aur-root[data-anim=\"swipe\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d^=\"-\"] {\ntransform: translate(-1.8em, -50%) skewX(8deg) scale(0.97);\nfilter: blur(6px);\ntransition-duration: 0.32s, 0.5s, 0.4s, 0.3s, 0.3s;\ntransition-timing-function: ease-in, cubic-bezier(0.55, 0, 0.8, 0.4), ease-in, ease, ease;\ntransition-delay: 0s;\n}\n.aur-root[data-anim=\"swipe\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active {\ntransform: translate(0, -50%) skewX(0deg) scale(1);\nfilter: none;\ntransition-duration: 0.5s, 0.95s, 0.55s, 0.5s, 0.6s;\ntransition-timing-function: ease-out, cubic-bezier(0.18, 1.25, 0.4, 1), ease-out, ease, ease;\ntransition-delay: 0.08s, 0.08s, 0.08s, 0s, 0s;\n}\n.aur-root[data-anim=\"zoom\"] .aur-stage[data-mode=\"synced\"] .aur-line {\ntransform: translateY(-50%) scale(0.72);\nfilter: blur(8px);\ntransition-duration: 0.5s, 0.9s, 0.7s, 0.5s, 0.6s;\n}\n.aur-root[data-anim=\"zoom\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d^=\"-\"] {\ntransform: translateY(-50%) scale(1.32);\nfilter: blur(12px);\ntransition-duration: 0.35s, 0.6s, 0.45s, 0.3s, 0.3s;\ntransition-timing-function: ease-in, cubic-bezier(0.4, 0, 1, 1), ease-in, ease, ease;\ntransition-delay: 0s;\n}\n.aur-root[data-anim=\"zoom\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active {\ntransform: translateY(-50%) scale(1);\nfilter: none;\ntransition-duration: 0.6s, 1s, 0.8s, 0.5s, 0.6s;\ntransition-timing-function: ease, cubic-bezier(0.16, 1, 0.3, 1), ease-out, ease, ease;\ntransition-delay: 0.1s, 0.1s, 0.1s, 0s, 0s;\n}\n.aur-root[data-anim=\"flip\"] .aur-stage[data-mode=\"synced\"] .aur-line {\ntransform-origin: 50% 0%;\ntransform: translateY(-50%) perspective(700px) rotateX(-95deg);\nfilter: brightness(0.3);\nbackface-visibility: hidden;\ntransition-duration: 0.4s, 0.8s, 0.5s, 0.5s, 0.5s;\n}\n.aur-root[data-anim=\"flip\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d^=\"-\"] {\ntransform: translateY(-58%) perspective(700px) rotateX(75deg);\nfilter: brightness(0.45);\ntransition-duration: 0.28s, 0.5s, 0.4s, 0.3s, 0.3s;\ntransition-timing-function: ease-in, cubic-bezier(0.5, 0, 0.9, 0.5), ease-in, ease, ease;\ntransition-delay: 0s;\n}\n.aur-root[data-anim=\"flip\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active {\ntransform: translateY(-50%) perspective(700px) rotateX(0deg);\nfilter: brightness(1);\ntransition-duration: 0.22s, 0.9s, 0.65s, 0.5s, 0.5s;\ntransition-timing-function: ease-out, cubic-bezier(0.2, 1.45, 0.35, 1), ease-out, ease, ease;\ntransition-delay: 0.1s, 0.1s, 0.1s, 0s, 0s;\n}\n.aur-root[data-anim=\"depth\"] { --aur-stagger: 22ms; --aur-move: 1.15s; --aur-move-ease: cubic-bezier(0.22, 1, 0.36, 1); }\n.aur-root[data-anim=\"depth\"] .aur-stage[data-mode=\"synced\"] { perspective: 1300px; perspective-origin: 50% 40%; }\n.aur-root[data-anim=\"depth\"] .aur-stage[data-mode=\"synced\"] .aur-lines {\ntransform-style: preserve-3d;\ntransform: rotateX(var(--aur-tx, 0deg)) rotateY(var(--aur-ty, 0deg));\ntransition: transform 1.4s cubic-bezier(0.22, 1, 0.36, 1);\nanimation: aur-depth-drift 26s ease-in-out infinite alternate;\n}\n@keyframes aur-depth-drift {\nfrom { translate: -1.2% 0.6% 0; rotate: y -1.5deg; }\nto { translate: 1.2% -0.6% 0; rotate: y 1.5deg; }\n}\n.aur-root[data-anim=\"depth\"] .aur-stage[data-mode=\"synced\"] .aur-line {\ntransform: translate3d(0, var(--aur-y, 0px), calc(var(--ad, 0) * -140px));\n}\n.aur-root[data-anim=\"depth\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d] { opacity: calc(0.62 - var(--ad, 0) * 0.1); }\n.aur-root[data-anim=\"depth\"] .aur-stage[data-mode=\"synced\"] .aur-line:not([data-d]) { opacity: 0; }\n.aur-root[data-anim=\"depth\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active { opacity: 1; transform: translate3d(0, var(--aur-y, 0px), 40px); }\n.aur-root[data-context=\"off\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-active) { opacity: 0 !important; pointer-events: none; }\n.aur-stage[data-mode=\"unsynced\"] { overflow-y: auto; scrollbar-width: none; }\n.aur-stage[data-mode=\"unsynced\"]::-webkit-scrollbar { display: none; }\n.aur-stage[data-mode=\"unsynced\"] .aur-lines { padding: 24vh 0 42vh; }\n.aur-stage[data-mode=\"unsynced\"] .aur-line {\nfont-size: calc(var(--aur-size) * 0.66);\nline-height: 1.28;\npadding: calc(var(--aur-gap) / 3.5) 0;\nopacity: 0.9;\ntransform: none;\ncursor: text;\nuser-select: text;\n}\n.aur-stage[data-mode=\"unsynced\"] .aur-line.is-gap { height: 0.9em; }\n.aur-stage[data-mode=\"unsynced\"] .aur-dots { display: none; }\n.aur-stage.is-entering[data-mode=\"unsynced\"] .aur-lines { animation: aur-fade-up 0.9s var(--aur-ease) backwards; }\n@keyframes aur-fade-up {\nfrom { opacity: 0; transform: translateY(28px); filter: blur(8px); }\n}\n.aur-message {\nposition: absolute;\ninset: 0;\ndisplay: none;\nflex-direction: column;\nalign-items: center;\njustify-content: center;\ngap: 8px;\npadding: 60px 8vw 150px;\ntext-align: center;\n}\n.aur-stage[data-mode=\"message\"] .aur-message { display: flex; }\n.aur-message-art {\nwidth: clamp(120px, 30vh, 280px);\naspect-ratio: 1;\nmargin-bottom: 22px;\nborder-radius: 14px;\noverflow: hidden;\nbox-shadow: 0 30px 80px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.06);\n}\n.aur-message-art img { display: block; width: 100%; height: 100%; object-fit: cover; }\n.aur-message[data-kind=\"loading\"] .aur-message-art { animation: aur-pulse 2.4s ease-in-out infinite; }\n.aur-message-icon { color: rgba(255, 255, 255, 0.55); margin-bottom: 6px; }\n.aur-message-icon:empty { display: none; }\n.aur-message-title { font-family: var(--aur-font); font-size: clamp(22px, calc(var(--aur-size) * 0.6), 40px); font-weight: 800; letter-spacing: -0.02em; line-height: 1.15; }\n.aur-message-detail { min-height: 1.5em; max-width: 520px; font-size: 15px; line-height: 1.5; color: rgba(255, 255, 255, 0.6); }\n.aur-message[data-kind=\"error\"] .aur-message-title { color: #ffb4a8; }\n.aur-message-action { margin-top: 14px; }\n.aur-spinner { display: flex; gap: 7px; margin-bottom: 6px; }\n.aur-spinner i { width: 7px; height: 7px; border-radius: 50%; background: #fff; animation: aur-bounce 1.2s var(--aur-ease) infinite; }\n.aur-spinner i:nth-child(2) { animation-delay: 0.15s; }\n.aur-spinner i:nth-child(3) { animation-delay: 0.3s; }\n.aur-stage.is-entering[data-mode=\"message\"] .aur-message > * { animation: aur-fade-up 0.8s var(--aur-ease) backwards; }\n.aur-stage.is-entering[data-mode=\"message\"] .aur-message > :nth-child(2) { animation-delay: 0.06s; }\n.aur-stage.is-entering[data-mode=\"message\"] .aur-message > :nth-child(3) { animation-delay: 0.12s; }\n.aur-stage.is-entering[data-mode=\"message\"] .aur-message > :nth-child(4) { animation-delay: 0.18s; }\n.aur-stage.is-entering[data-mode=\"message\"] .aur-message > :nth-child(5) { animation-delay: 0.24s; }\n.aur-stage.is-entering[data-mode=\"message\"] .aur-message > .aur-message-art { animation: aur-art-in 1s var(--aur-ease) backwards; }\n@keyframes aur-bounce {\n0%, 100% { transform: translateY(0); opacity: 0.35; }\n40% { transform: translateY(-7px); opacity: 1; }\n}\n@keyframes aur-pulse {\n0%, 100% { transform: scale(1); }\n50% { transform: scale(0.975); }\n}\n@keyframes aur-art-in {\nfrom { opacity: 0; transform: translateY(20px) scale(0.92); filter: blur(10px); }\n}\n:where(.aur-root) button { appearance: none; margin: 0; padding: 0; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; -webkit-app-region: no-drag; }\n.aur-root button:focus-visible,\n.aur-root select:focus-visible,\n.aur-root input:focus-visible,\n.aur-root textarea:focus-visible,\n.aur-progress:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }\n.aur-icon-btn {\ndisplay: inline-grid;\nplace-items: center;\nflex: none;\nwidth: 36px;\nheight: 36px;\nborder-radius: 50%;\ncolor: rgba(255, 255, 255, 0.72);\ntransition: background 0.2s ease, color 0.2s ease, transform 0.25s var(--aur-spring);\n}\n.aur-icon-btn:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }\n.aur-icon-btn:active { transform: scale(0.9); }\n.aur-icon-btn.is-on { color: var(--aur-green); }\n.aur-btn {\ndisplay: inline-flex;\nalign-items: center;\njustify-content: center;\ngap: 8px;\nheight: 36px;\npadding: 0 16px;\nborder-radius: 999px;\nbackground: rgba(255, 255, 255, 0.1);\nfont-size: 13px;\nfont-weight: 700;\ntransition: background 0.2s ease, transform 0.2s var(--aur-spring), box-shadow 0.2s ease;\n}\n.aur-btn svg { width: 16px; height: 16px; }\n.aur-btn:hover { background: rgba(255, 255, 255, 0.17); }\n.aur-btn:active { transform: scale(0.96); }\n.aur-btn:disabled { opacity: 0.4; pointer-events: none; }\n.aur-btn-ghost { background: transparent; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18); }\n.aur-btn-ghost:hover { background: rgba(255, 255, 255, 0.07); }\n.aur-btn-primary { background: #fff; color: #000; }\n.aur-btn-primary:hover { background: #fff; transform: scale(1.03); box-shadow: 0 6px 20px rgba(255, 255, 255, 0.15); }\n.aur-btn-danger { background: transparent; color: #ff8a7a; box-shadow: inset 0 0 0 1px rgba(255, 138, 122, 0.35); }\n.aur-root {\n--aur-toggle-on: color-mix(in oklab, var(--aur-accent) 50%, #fff);\n--aur-ctl: rgba(255, 255, 255, 0.72);\n}\n.aur-player {\nposition: absolute;\nleft: 0;\nright: 0;\nbottom: 0;\nz-index: 3;\ndisplay: grid;\ngrid-template-columns: minmax(0, 1fr) minmax(300px, 640px) minmax(0, 1fr);\nalign-items: end;\ncolumn-gap: 28px;\npadding: 0 var(--aur-pad) 20px;\npointer-events: none;\ntransition: opacity 0.5s ease, transform 0.65s var(--aur-ease);\n}\n.aur-player > * { pointer-events: auto; }\n.aur-player-side { display: flex; align-items: center; gap: 4px; height: 58px; min-width: 0; }\n.aur-player-side.is-left { grid-column: 1; justify-content: flex-start; }\n.aur-player-center { grid-column: 2; display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 0; }\n.aur-player-side.is-right { grid-column: 3; justify-content: flex-end; }\n.aur-root[data-transport=\"off\"] .aur-player-center { display: none; }\n.aur-scrub { width: 100%; }\n.aur-progress { --p: 0; --hx: 0; position: relative; height: 18px; cursor: pointer; touch-action: none; border-radius: 4px; }\n.aur-progress-track {\nposition: absolute;\nleft: 0;\nright: 0;\ntop: 50%;\nheight: 4px;\nmargin-top: -2px;\noverflow: hidden;\nborder-radius: 99px;\nbackground: rgba(255, 255, 255, 0.16);\ntransition: height 0.25s var(--aur-ease), margin 0.25s var(--aur-ease), background 0.25s ease;\n}\n.aur-progress-fill {\nposition: absolute;\ninset: 0;\nborder-radius: inherit;\nbackground: linear-gradient(90deg, rgba(255, 255, 255, 0.75), #fff);\ntransform-origin: 0 50%;\ntransform: scaleX(var(--p));\n}\n.aur-progress-knob-rail { position: absolute; inset: 0; transform: translateX(calc(var(--p) * 100%)); pointer-events: none; }\n.aur-progress-knob {\nposition: absolute;\nleft: -7px;\ntop: 50%;\nwidth: 14px;\nheight: 14px;\nmargin-top: -7px;\nborder-radius: 50%;\nbackground: #fff;\nbox-shadow: 0 2px 10px rgba(0, 0, 0, 0.35), 0 0 0 4px color-mix(in oklab, var(--aur-glow-tint) 25%, transparent);\ntransform: scale(0);\ntransition: transform 0.3s var(--aur-spring);\n}\n.aur-progress:hover .aur-progress-track,\n.aur-progress.is-scrubbing .aur-progress-track { height: 7px; margin-top: -3.5px; background: rgba(255, 255, 255, 0.22); }\n.aur-progress:hover .aur-progress-knob,\n.aur-progress.is-scrubbing .aur-progress-knob,\n.aur-progress:focus-visible .aur-progress-knob { transform: scale(1); }\n.aur-progress.is-scrubbing .aur-progress-knob { transform: scale(1.15); }\n.aur-progress-tip {\nposition: absolute;\nbottom: 20px;\nleft: calc(var(--hx) * 100%);\npadding: 3px 8px;\nborder-radius: 7px;\nbackground: rgba(18, 18, 22, 0.88);\nborder: 1px solid rgba(255, 255, 255, 0.08);\nfont-size: 11.5px;\nfont-weight: 600;\nfont-variant-numeric: tabular-nums;\nwhite-space: nowrap;\npointer-events: none;\nopacity: 0;\ntransform: translate(-50%, 4px);\ntransition: opacity 0.18s ease, transform 0.25s var(--aur-ease);\n}\n.aur-progress:hover .aur-progress-tip,\n.aur-progress.is-scrubbing .aur-progress-tip { opacity: 1; transform: translate(-50%, 0); }\n.aur-times { display: flex; justify-content: space-between; margin-top: 1px; }\n.aur-time { font-size: 11.5px; font-weight: 500; font-variant-numeric: tabular-nums; color: rgba(255, 255, 255, 0.55); }\n.aur-transport { display: flex; align-items: center; gap: 20px; }\n.aur-skip { width: 42px; height: 42px; color: rgba(255, 255, 255, 0.92); }\n.aur-skip svg { width: 22px; height: 22px; }\n.aur-toggle { position: relative; color: rgba(255, 255, 255, 0.5); }\n.aur-toggle.is-on { color: var(--aur-toggle-on); }\n.aur-toggle::after {\ncontent: \"\";\nposition: absolute;\nleft: 50%;\nbottom: 3px;\nwidth: 4px;\nheight: 4px;\nmargin-left: -2px;\nborder-radius: 50%;\nbackground: currentColor;\nopacity: 0;\ntransform: scale(0);\ntransition: opacity 0.2s ease, transform 0.3s var(--aur-spring);\n}\n.aur-toggle.is-on::after { opacity: 1; transform: none; }\n.aur-play-btn {\nposition: relative;\ndisplay: grid;\nplace-items: center;\nwidth: 58px;\nheight: 58px;\nflex: none;\nborder-radius: 50%;\nbackground: #fff;\ncolor: #0b0b0e;\nbox-shadow: 0 10px 30px rgba(0, 0, 0, 0.3), 0 0 0 0 color-mix(in oklab, var(--aur-glow-tint) 30%, transparent);\ntransition: transform 0.35s var(--aur-spring), box-shadow 0.4s ease;\n}\n.aur-play-btn:hover { transform: scale(1.06); box-shadow: 0 12px 34px rgba(0, 0, 0, 0.32), 0 0 0 8px color-mix(in oklab, var(--aur-glow-tint) 16%, transparent); }\n.aur-play-btn:active { transform: scale(0.93); }\n.aur-pp { position: absolute; inset: 0; display: grid; place-items: center; transition: opacity 0.22s ease, transform 0.4s var(--aur-spring); }\n.aur-pp svg { width: 26px; height: 26px; }\n.aur-pp.is-pause { opacity: 0; transform: scale(0.5) rotate(-90deg); }\n.aur-root[data-playing=\"true\"] .aur-pp.is-play { opacity: 0; transform: scale(0.5) rotate(90deg); }\n.aur-root[data-playing=\"true\"] .aur-pp.is-pause { opacity: 1; transform: none; }\n.aur-source {\ndisplay: inline-flex;\nalign-items: center;\ngap: 8px;\nmin-width: 0;\nmax-width: 230px;\nheight: 32px;\npadding: 0 12px 0 10px;\nborder-radius: 99px;\nbackground: rgba(255, 255, 255, 0.07);\nfont-size: 12px;\nfont-weight: 600;\nwhite-space: nowrap;\noverflow: hidden;\ntext-overflow: ellipsis;\ncolor: rgba(255, 255, 255, 0.78);\ntransition: background 0.2s ease, color 0.2s ease;\n}\n.aur-source:hover { background: rgba(255, 255, 255, 0.13); color: #fff; }\n.aur-source::before { content: \"\"; flex: none; width: 7px; height: 7px; border-radius: 50%; background: #777; }\n.aur-source[data-kind=\"synced\"]::before { background: var(--aur-green); }\n.aur-source[data-kind=\"word-synced\"]::before { background: #7cd4ff; box-shadow: 0 0 8px #7cd4ff; }\n.aur-source[data-kind=\"unsynced\"]::before { background: #f5c451; }\n.aur-offset-group { display: inline-flex; align-items: center; flex: none; height: 32px; margin-left: 6px; border-radius: 99px; background: rgba(255, 255, 255, 0.05); }\n.aur-mini-btn { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; color: rgba(255, 255, 255, 0.6); transition: background 0.2s ease, color 0.2s ease; }\n.aur-mini-btn:hover { background: rgba(255, 255, 255, 0.12); color: #fff; }\n.aur-offset { min-width: 54px; height: 30px; font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; text-align: center; color: #fff; }\n.aur-offset.is-zero { color: rgba(255, 255, 255, 0.45); }\n.aur-player-side .aur-icon-btn { color: var(--aur-ctl); }\n.aur-heart { transition: color 0.2s ease, transform 0.35s var(--aur-spring); }\n.aur-heart.is-on { color: var(--aur-green); }\n.aur-heart.is-on svg { animation: aur-heart-pop 0.45s var(--aur-spring); }\n@keyframes aur-heart-pop { 40% { transform: scale(1.3); } }\n.aur-volume { display: flex; align-items: center; }\n.aur-vol {\n--v: 1;\n-webkit-appearance: none;\nappearance: none;\nwidth: 0;\nheight: 18px;\nmargin: 0;\nbackground: transparent;\nopacity: 0;\ncursor: pointer;\ntransition: width 0.35s var(--aur-ease), opacity 0.25s ease, margin 0.35s var(--aur-ease);\n}\n.aur-volume:hover .aur-vol,\n.aur-vol:focus-visible { width: 86px; margin: 0 6px 0 2px; opacity: 1; }\n.aur-vol::-webkit-slider-runnable-track { height: 4px; border-radius: 99px; background: linear-gradient(to right, #fff calc(var(--v) * 100%), rgba(255, 255, 255, 0.18) calc(var(--v) * 100%)); }\n.aur-vol::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; margin-top: -4px; border-radius: 50%; background: #fff; box-shadow: 0 1px 6px rgba(0, 0, 0, 0.4); }\n.aur-vol::-moz-range-track { height: 4px; border-radius: 99px; background: rgba(255, 255, 255, 0.18); }\n.aur-vol::-moz-range-progress { height: 4px; border-radius: 99px; background: #fff; }\n.aur-vol::-moz-range-thumb { width: 12px; height: 12px; border: 0; border-radius: 50%; background: #fff; }\n.aur-player-side .aur-sep { flex: none; width: 1px; height: 20px; margin: 0 6px; background: rgba(255, 255, 255, 0.14); }\n.aur-mini-progress { position: absolute; left: 0; right: 0; bottom: 0; z-index: 3; height: 2px; background: rgba(255, 255, 255, 0.07); opacity: 0; transition: opacity 0.8s ease; pointer-events: none; }\n.aur-mini-fill { height: 100%; background: linear-gradient(90deg, rgba(255, 255, 255, 0.35), rgba(255, 255, 255, 0.75)); transform-origin: 0 50%; transform: scaleX(var(--p, 0)); }\n.aur-root[data-idle=\"true\"] .aur-mini-progress { opacity: 1; transition-delay: 0.3s; }\n.aur-root[data-idle=\"true\"] { cursor: none; }\n.aur-root[data-idle=\"true\"] .aur-chrome { opacity: 0; pointer-events: none; }\n.aur-root[data-idle=\"true\"] .aur-player { transform: translateY(18px); }\n.aur-root[data-idle=\"true\"] .aur-header { transform: translateY(-10px); }\n.aur-root.is-open .aur-player { animation: aur-rise 0.8s var(--aur-ease) 0.1s backwards; }\n.aur-root.is-open .aur-header { animation: aur-drop 0.8s var(--aur-ease) 0.05s backwards; }\n@keyframes aur-rise { from { opacity: 0; transform: translateY(28px); } }\n@keyframes aur-drop { from { opacity: 0; transform: translateY(-14px); } }\n.aur-toast {\nposition: absolute;\nleft: 50%;\nbottom: 150px;\nz-index: 5;\nmax-width: calc(100vw - 32px);\npadding: 9px 18px;\nborder-radius: 999px;\nbackground: rgba(24, 24, 28, 0.82);\nborder: 1px solid rgba(255, 255, 255, 0.1);\nbox-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);\nbackdrop-filter: blur(20px);\nfont-size: 13px;\nfont-weight: 600;\nwhite-space: nowrap;\noverflow: hidden;\ntext-overflow: ellipsis;\nopacity: 0;\npointer-events: none;\ntransform: translate(-50%, 10px) scale(0.96);\ntransition: opacity 0.25s ease, transform 0.4s var(--aur-spring);\n}\n.aur-root[data-transport=\"off\"] .aur-toast { bottom: 84px; }\n.aur-toast.is-on { opacity: 1; transform: translate(-50%, 0) scale(1); }\n.aur-root { --aur-safe-top: 52px; }\n.aur-root[data-fs=\"true\"] { --aur-safe-top: 12px; }\n.aur-panel {\nposition: absolute;\ntop: var(--aur-safe-top);\nright: 12px;\nbottom: 12px;\nz-index: 4;\nwidth: min(520px, calc(100vw - 24px));\ndisplay: grid;\ngrid-template-columns: 76px minmax(0, 1fr);\noverflow: hidden;\nborder-radius: 22px;\nbackground: linear-gradient(180deg, rgba(32, 32, 38, 0.86), rgba(18, 18, 22, 0.9));\nborder: 1px solid rgba(255, 255, 255, 0.08);\nbox-shadow: 0 40px 100px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.06);\nbackdrop-filter: blur(40px) saturate(1.5);\nfont-size: 14px;\n-webkit-app-region: no-drag;\nopacity: 0;\nvisibility: hidden;\ntransform: translateX(28px) scale(0.985);\ntransform-origin: right center;\ntransition: transform 0.5s var(--aur-ease), opacity 0.3s ease, visibility 0s linear 0.5s;\n}\n.aur-panel.is-open { opacity: 1; visibility: visible; transform: none; transition-delay: 0s; }\n.aur-panel [hidden] { display: none !important; }\n.aur-rail {\nposition: relative;\ndisplay: flex;\nflex-direction: column;\ngap: 4px;\npadding: 14px 8px;\nbackground: rgba(0, 0, 0, 0.18);\nborder-right: 1px solid rgba(255, 255, 255, 0.05);\n}\n.aur-rail-btn {\nposition: relative;\nz-index: 1;\ndisplay: flex;\nflex-direction: column;\nalign-items: center;\njustify-content: center;\ngap: 5px;\nheight: 62px;\nborder-radius: 14px;\ncolor: rgba(255, 255, 255, 0.5);\ntransition: color 0.25s ease, background 0.25s ease;\n}\n.aur-rail-btn:hover { color: rgba(255, 255, 255, 0.88); background: rgba(255, 255, 255, 0.04); }\n.aur-rail-btn[aria-selected=\"true\"] { color: #fff; background: none; }\n.aur-rail-icon { display: grid; transition: transform 0.35s var(--aur-spring); }\n.aur-rail-btn[aria-selected=\"true\"] .aur-rail-icon { transform: translateY(-1px) scale(1.06); }\n.aur-rail-icon svg { width: 21px; height: 21px; }\n.aur-rail-label { font-size: 10.5px; font-weight: 650; letter-spacing: 0.01em; }\n.aur-rail-pill {\nposition: absolute;\ntop: 14px;\nleft: 8px;\nright: 8px;\nheight: 62px;\nborder-radius: 14px;\nbackground: rgba(255, 255, 255, 0.1);\nbox-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.07);\ntransform: translateY(calc(var(--i, 1) * 66px));\ntransition: transform 0.45s var(--aur-ease), opacity 0.2s ease;\n}\n.aur-rail-pill::before { content: \"\"; position: absolute; left: -8px; top: 20px; bottom: 20px; width: 3px; border-radius: 0 3px 3px 0; background: var(--aur-toggle-on); }\n.aur-panel[data-searching=\"true\"] .aur-rail-pill { opacity: 0; }\n.aur-panel-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }\n.aur-panel-head {\ndisplay: grid;\ngrid-template-columns: minmax(0, 1fr) auto;\nalign-items: start;\ngap: 14px 8px;\npadding: 18px 14px 14px 20px;\nborder-bottom: 1px solid rgba(255, 255, 255, 0.05);\n}\n.aur-panel-title { font-family: var(--aur-font); font-size: 21px; font-weight: 800; line-height: 1.15; letter-spacing: -0.02em; }\n.aur-panel-sub { margin-top: 3px; font-size: 12.5px; color: rgba(255, 255, 255, 0.5); }\n.aur-panel-close { margin: -4px -2px 0 0; background: rgba(255, 255, 255, 0.06); }\n.aur-panel-close:hover { background: rgba(255, 255, 255, 0.14); }\n.aur-search-wrap { grid-column: 1 / -1; position: relative; display: block; }\n.aur-search-icon { position: absolute; left: 11px; top: 50%; display: grid; transform: translateY(-50%); color: rgba(255, 255, 255, 0.45); pointer-events: none; }\n.aur-search {\nwidth: 100%;\nheight: 36px;\npadding: 0 12px 0 34px;\nborder: 1px solid rgba(255, 255, 255, 0.08);\nborder-radius: 11px;\nbackground: rgba(0, 0, 0, 0.25);\ncolor: #fff;\nfont: inherit;\nfont-size: 13px;\noutline: none;\ntransition: border-color 0.2s ease, background 0.2s ease;\n}\n.aur-search::placeholder { color: rgba(255, 255, 255, 0.4); }\n.aur-search:focus { border-color: rgba(255, 255, 255, 0.28); background: rgba(0, 0, 0, 0.35); }\n.aur-search::-webkit-search-cancel-button { filter: invert(1) opacity(0.5); cursor: pointer; }\n.aur-panel-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 16px 24px 18px; scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.15) transparent; }\n.aur-panel-scroll::-webkit-scrollbar { width: 8px; }\n.aur-panel-scroll::-webkit-scrollbar-thumb { border: 2px solid transparent; border-radius: 99px; background: rgba(255, 255, 255, 0.15) padding-box; }\n.aur-panel.is-open .aur-tab-body:not([hidden]) > * { animation: aur-fade-up 0.5s var(--aur-ease) backwards; }\n.aur-panel.is-open .aur-tab-body:not([hidden]) > :nth-child(2) { animation-delay: 0.04s; }\n.aur-panel.is-open .aur-tab-body:not([hidden]) > :nth-child(3) { animation-delay: 0.08s; }\n.aur-panel.is-open .aur-tab-body:not([hidden]) > :nth-child(n + 4) { animation-delay: 0.12s; }\n.aur-no-results { padding: 48px 0; text-align: center; font-size: 13px; color: rgba(255, 255, 255, 0.5); }\n.aur-tab-body[data-tab=\"track\"] > .aur-np { margin: 14px 0 4px; }\n@media (max-width: 600px) {\n.aur-panel { grid-template-columns: 58px minmax(0, 1fr); }\n.aur-rail-label { display: none; }\n.aur-rail-btn, .aur-rail-pill { height: 50px; }\n.aur-rail-pill { transform: translateY(calc(var(--i, 1) * 54px)); }\n}\n.aur-section h3 { margin: 22px 4px 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: rgba(255, 255, 255, 0.45); }\n.aur-section-card { padding: 2px 14px; border-radius: 14px; background: rgba(255, 255, 255, 0.045); border: 1px solid rgba(255, 255, 255, 0.05); }\n.aur-section-card > .aur-row + .aur-row { border-top: 1px solid rgba(255, 255, 255, 0.06); }\n.aur-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 46px; padding: 10px 0; cursor: pointer; transition: opacity 0.2s ease; }\n.aur-row > span, .aur-row-label > span { font-size: 13.5px; color: rgba(255, 255, 255, 0.9); }\n.aur-row.is-disabled { opacity: 0.35; pointer-events: none; }\n.aur-row-stack, .aur-row-range { flex-direction: column; align-items: stretch; gap: 10px; cursor: default; }\n.aur-row-range { gap: 6px; cursor: pointer; }\n.aur-row-label { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }\n.aur-range-value { font-size: 12px; font-variant-numeric: tabular-nums; color: rgba(255, 255, 255, 0.55); }\n.aur-range { --p: 50%; -webkit-appearance: none; appearance: none; width: 100%; height: 18px; margin: 0; background: transparent; cursor: pointer; }\n.aur-range::-webkit-slider-runnable-track { height: 4px; border-radius: 99px; background: linear-gradient(to right, #fff var(--p), rgba(255, 255, 255, 0.16) var(--p)); }\n.aur-range::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; margin-top: -6px; border-radius: 50%; background: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45); transition: transform 0.2s var(--aur-spring); }\n.aur-range:hover::-webkit-slider-thumb { transform: scale(1.12); }\n.aur-range:active::-webkit-slider-thumb { transform: scale(1.25); }\n.aur-range::-moz-range-track { height: 4px; border-radius: 99px; background: rgba(255, 255, 255, 0.16); }\n.aur-range::-moz-range-progress { height: 4px; border-radius: 99px; background: #fff; }\n.aur-range::-moz-range-thumb { width: 16px; height: 16px; border: 0; border-radius: 50%; background: #fff; }\n.aur-switch { appearance: none; position: relative; flex: none; width: 40px; height: 24px; margin: 0; border-radius: 99px; background: rgba(255, 255, 255, 0.2); cursor: pointer; transition: background 0.25s ease; }\n.aur-switch::before { content: \"\"; position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35); transition: transform 0.35s var(--aur-spring); }\n.aur-switch:checked { background: var(--aur-green); }\n.aur-switch:checked::before { transform: translateX(16px); }\n.aur-segmented { display: flex; gap: 2px; padding: 3px; border-radius: 11px; background: rgba(0, 0, 0, 0.28); }\n.aur-seg { flex: 1; display: grid; place-items: center; height: 30px; border-radius: 8px; font-size: 12.5px; font-weight: 600; color: rgba(255, 255, 255, 0.6); transition: background 0.25s ease, color 0.2s ease, box-shadow 0.25s ease; }\n.aur-seg:hover { color: #fff; }\n.aur-seg[aria-checked=\"true\"] { background: rgba(255, 255, 255, 0.16); color: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3); }\n.aur-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(98px, 1fr)); gap: 8px; }\n.aur-card, .aur-font {\ndisplay: flex;\nflex-direction: column;\ngap: 2px;\npadding: 10px;\nborder-radius: 12px;\nbackground: rgba(255, 255, 255, 0.05);\nborder: 1px solid rgba(255, 255, 255, 0.06);\ntext-align: left;\ntransition: background 0.2s ease, border-color 0.2s ease, transform 0.25s var(--aur-spring);\n}\n.aur-card:hover, .aur-font:hover { background: rgba(255, 255, 255, 0.09); }\n.aur-card:active, .aur-font:active { transform: scale(0.97); }\n.aur-card[aria-checked=\"true\"], .aur-font[aria-checked=\"true\"] { background: rgba(30, 215, 96, 0.12); border-color: rgba(30, 215, 96, 0.75); }\n.aur-card-art { display: block; width: 100%; height: 38px; margin-bottom: 6px; color: rgba(255, 255, 255, 0.8); }\n.aur-card-art svg { width: 100%; height: 100%; fill: currentColor; }\n.aur-card[aria-checked=\"true\"] .aur-card-art { color: var(--aur-green); }\n.aur-card-name { font-size: 13px; font-weight: 700; }\n.aur-card-hint { font-size: 11px; color: rgba(255, 255, 255, 0.5); }\n.aur-themes { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); }\n.aur-theme-art {\nposition: relative;\ndisplay: grid;\nplace-items: center;\nheight: 52px;\nmargin-bottom: 6px;\nborder-radius: 8px;\noverflow: hidden;\nbackground: radial-gradient(120% 140% at 20% 10%, var(--t1) 0%, transparent 70%), var(--t2);\nbox-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);\n}\n.aur-theme-art span { font-size: 24px; font-weight: 800; line-height: 1; color: #fff; text-shadow: 0 0 14px color-mix(in oklab, var(--t1) 70%, transparent); }\n.aur-theme[aria-checked=\"true\"] .aur-theme-art { box-shadow: inset 0 0 0 1px rgba(30, 215, 96, 0.6); }\n.aur-swatches { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }\n.aur-swatch {\nposition: relative;\nwidth: 30px;\nheight: 30px;\nflex: none;\nborder-radius: 50%;\nbackground: var(--sw);\nbox-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);\ncursor: pointer;\ntransition: transform 0.25s var(--aur-spring), box-shadow 0.2s ease;\n}\n.aur-swatch:hover { transform: scale(1.08); }\n.aur-swatch[aria-checked=\"true\"] { box-shadow: 0 0 0 2px #121216, 0 0 0 4px #fff; }\n.aur-swatch.is-album {\nwidth: auto;\npadding: 0 12px;\nborder-radius: 99px;\nfont-size: 12px;\nfont-weight: 700;\ncolor: #fff;\nbackground: linear-gradient(135deg, color-mix(in srgb, var(--aur-album-accent, #fff) 55%, #222), color-mix(in srgb, var(--aur-album-c1, #4b3b78) 70%, #111));\n}\n.aur-swatch.is-custom { background: conic-gradient(var(--sw) 0 0), conic-gradient(#ff5f5f, #ffd23f, #3ddc84, #2ec5ff, #b388ff, #ff5fa2, #ff5f5f); overflow: hidden; }\n.aur-swatch-input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }\n.aur-fonts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }\n.aur-font { align-items: center; text-align: center; }\n.aur-font-sample { font-size: 26px; font-weight: 800; line-height: 1.1; letter-spacing: -0.02em; }\n.aur-font-name { font-size: 11px; color: rgba(255, 255, 255, 0.55); }\n.aur-select { max-width: 200px; padding: 6px 8px; border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px; background: rgba(255, 255, 255, 0.07); color: #fff; font: inherit; font-size: 13px; }\n.aur-select option { background: #222; color: #fff; }\n.aur-panel-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }\n.aur-hint { margin: 14px 2px 0; font-size: 12px; line-height: 1.55; color: rgba(255, 255, 255, 0.45); }\n.aur-keys { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; margin-top: 20px; padding: 12px 14px; border-radius: 14px; background: rgba(255, 255, 255, 0.03); font-size: 12px; color: rgba(255, 255, 255, 0.6); }\n.aur-key { display: flex; align-items: center; gap: 8px; }\n.aur-key kbd { flex: none; min-width: 24px; padding: 2px 6px; border-radius: 5px; background: rgba(255, 255, 255, 0.1); box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.12); font: 600 11px/1.4 var(--aur-ui-font); color: #fff; text-align: center; }\n.aur-stat-tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 6px 0 4px; }\n.aur-stat { padding: 14px 12px 12px; border-radius: 14px; background: rgba(255, 255, 255, 0.045); border: 1px solid rgba(255, 255, 255, 0.05); }\n.aur-stat-value { font-size: 20px; font-weight: 800; letter-spacing: -0.02em; line-height: 1.1; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.aur-stat-label { margin-top: 4px; font-size: 11.5px; color: rgba(255, 255, 255, 0.5); }\n.aur-stat-today { float: right; letter-spacing: 0.02em; text-transform: none; font-weight: 600; color: rgba(255, 255, 255, 0.55); }\n.aur-stat-chart { display: grid; grid-template-columns: repeat(14, 1fr); gap: 6px; align-items: end; height: 120px; padding: 14px 14px 10px; border-radius: 14px; background: rgba(255, 255, 255, 0.045); border: 1px solid rgba(255, 255, 255, 0.05); }\n.aur-stat-day { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 6px; height: 100%; }\n.aur-stat-bar { width: 100%; max-width: 18px; height: max(3px, calc(var(--v, 0) * (100% - 20px))); border-radius: 5px; background: rgba(255, 255, 255, 0.22); }\n.aur-stat-day.is-today .aur-stat-bar { background: linear-gradient(to top, color-mix(in oklab, var(--aur-accent) 70%, #fff), color-mix(in oklab, var(--aur-accent) 30%, #fff)); }\n.aur-stat-dow { font-size: 10.5px; color: rgba(255, 255, 255, 0.4); }\n.aur-stat-list { margin: 0; padding: 2px 14px; list-style: none; counter-reset: aur-rank; border-radius: 14px; background: rgba(255, 255, 255, 0.045); border: 1px solid rgba(255, 255, 255, 0.05); }\n.aur-stat-list li { display: flex; align-items: center; gap: 12px; padding: 10px 0; counter-increment: aur-rank; }\n.aur-stat-list li + li { border-top: 1px solid rgba(255, 255, 255, 0.06); }\n.aur-stat-list li::before { content: counter(aur-rank); width: 16px; flex: none; font-size: 12px; font-weight: 700; color: rgba(255, 255, 255, 0.35); text-align: center; }\n.aur-stat-name { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }\n.aur-stat-name b, .aur-stat-name span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.aur-stat-name b { font-size: 13.5px; font-weight: 600; color: #fff; }\n.aur-stat-name span, .aur-stat-num span { font-size: 11.5px; color: rgba(255, 255, 255, 0.45); }\n.aur-stat-num { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 2px; font-size: 13px; font-weight: 600; color: rgba(255, 255, 255, 0.85); font-variant-numeric: tabular-nums; }\n@media (max-width: 700px) { .aur-stat-tiles { grid-template-columns: repeat(2, 1fr); } }\n.aur-track-info { display: flex; align-items: center; gap: 14px; margin: 14px 0; }\n.aur-track-art { width: 60px; height: 60px; flex: none; border-radius: 8px; object-fit: cover; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4); }\n.aur-track-text { min-width: 0; }\n.aur-track-title { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.aur-track-sub { margin-top: 2px; font-size: 12.5px; color: rgba(255, 255, 255, 0.6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.aur-track-chip { display: inline-block; margin-top: 7px; padding: 3px 9px; border-radius: 99px; background: rgba(255, 255, 255, 0.08); font-size: 11.5px; font-weight: 600; color: rgba(255, 255, 255, 0.75); }\n.aur-textarea {\ndisplay: block;\nwidth: 100%;\nmin-height: 280px;\npadding: 12px 14px;\nresize: vertical;\nborder: 1px solid rgba(255, 255, 255, 0.1);\nborder-radius: 12px;\nbackground: rgba(0, 0, 0, 0.32);\ncolor: #fff;\nfont: 12px/1.6 ui-monospace, \"Cascadia Code\", Consolas, monospace;\nuser-select: text;\ntransition: border-color 0.2s ease, background 0.2s ease;\n}\n.aur-textarea:focus { border-color: rgba(255, 255, 255, 0.3); outline: none; }\n.aur-textarea.is-drop { border-color: var(--aur-green); background: rgba(30, 215, 96, 0.08); }\n.aur-root { --aur-split-w: clamp(320px, 40vw, 600px); }\n.aur-side {\nposition: absolute;\ntop: 0;\nbottom: 0;\nleft: 0;\nz-index: 1;\nwidth: var(--aur-split-w);\ndisplay: none;\nflex-direction: column;\nalign-items: center;\njustify-content: center;\ngap: 24px;\npadding: 64px 2vw 150px calc(var(--aur-pad) * 0.8);\n}\n.aur-art-wrap {\nposition: relative;\ndisplay: block;\nwidth: min(100%, 52vh, 460px);\naspect-ratio: 1;\nflex: none;\nborder-radius: 14px;\ncursor: pointer;\nbox-shadow: 0 40px 90px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.06);\ntransition: transform 0.8s var(--aur-spring), box-shadow 0.8s ease;\n}\n.aur-root[data-playing=\"false\"] .aur-art-wrap { transform: scale(0.86); box-shadow: 0 18px 44px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.05); }\n.aur-art-wrap:active { transform: scale(0.97); }\n.aur-root[data-playing=\"false\"] .aur-art-wrap:active { transform: scale(0.84); }\n.aur-art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; border-radius: inherit; opacity: 0; transition: opacity 0.9s ease; }\n.aur-art.is-on { opacity: 1; }\n.aur-art-hint {\nposition: absolute;\nleft: 50%;\ntop: 50%;\ndisplay: grid;\nplace-items: center;\nwidth: 64px;\nheight: 64px;\nmargin: -32px 0 0 -32px;\nborder-radius: 50%;\nbackground: rgba(0, 0, 0, 0.45);\nbackdrop-filter: blur(10px);\ncolor: #fff;\nopacity: 0;\ntransform: scale(0.8);\ntransition: opacity 0.25s ease, transform 0.35s var(--aur-spring);\n}\n.aur-art-hint svg { width: 28px; height: 28px; }\n.aur-art-wrap:hover .aur-art-hint, .aur-art-wrap:focus-visible .aur-art-hint { opacity: 1; transform: none; }\n.aur-side-meta { width: min(100%, 52vh, 460px); min-width: 0; }\n.aur-side-title {\ndisplay: -webkit-box;\noverflow: hidden;\n-webkit-line-clamp: 2;\n-webkit-box-orient: vertical;\nfont-family: var(--aur-font);\nfont-size: clamp(20px, 2.1vw, 30px);\nfont-weight: 800;\nline-height: 1.15;\nletter-spacing: -0.02em;\n}\n.aur-side-artist, .aur-side-album { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }\n.aur-side-artist { margin-top: 6px; font-size: 15px; color: rgba(255, 255, 255, 0.7); }\n.aur-side-album { margin-top: 2px; font-size: 13px; color: rgba(255, 255, 255, 0.45); }\n.aur-root.is-open .aur-side { animation: aur-art-in 0.9s var(--aur-ease) 0.05s backwards; }\n.aur-disc { position: absolute; inset: 0; border-radius: inherit; overflow: hidden; }\n.aur-disc-grooves, .aur-disc-shine { display: none; }\n@media (min-width: 900px) and (min-height: 540px) {\n.aur-root:is([data-view=\"split\"], [data-view=\"mirror\"], [data-view=\"poster\"], [data-view=\"vinyl\"]) .aur-side { display: flex; }\n.aur-root:is([data-view=\"split\"], [data-view=\"mirror\"], [data-view=\"poster\"], [data-view=\"vinyl\"]) :is(.aur-header, .aur-message-art) { display: none; }\n.aur-root:is([data-view=\"split\"], [data-view=\"vinyl\"]) .aur-stage { left: var(--aur-split-w); padding-left: 2.5vw; --aur-size: min(var(--aur-fs), 4.6vw, 10.5vh); }\n.aur-root[data-view=\"mirror\"] .aur-side { left: auto; right: 0; padding: 64px calc(var(--aur-pad) * 0.8) 150px 2vw; }\n.aur-root[data-view=\"mirror\"] .aur-stage { right: var(--aur-split-w); padding-right: 2.5vw; --aur-size: min(var(--aur-fs), 4.6vw, 10.5vh); }\n.aur-root[data-view=\"poster\"] { --aur-poster-w: clamp(360px, 46vw, 820px); }\n.aur-root[data-view=\"poster\"] .aur-side { width: var(--aur-poster-w); padding: 0; display: block; }\n.aur-root[data-view=\"poster\"] .aur-art-wrap {\nposition: absolute;\ninset: 0;\nwidth: 100%;\nheight: 100%;\naspect-ratio: auto;\nborder-radius: 0;\nbox-shadow: none;\n-webkit-mask-image: linear-gradient(to right, #000 45%, transparent 98%), linear-gradient(to top, transparent 0, #000 42%);\n-webkit-mask-composite: source-in;\nmask-image: linear-gradient(to right, #000 45%, transparent 98%), linear-gradient(to top, transparent 0, #000 42%);\nmask-composite: intersect;\ntransition: opacity 0.8s ease, filter 0.8s ease;\n}\n.aur-root[data-view=\"poster\"][data-playing=\"false\"] .aur-art-wrap { transform: none; box-shadow: none; filter: saturate(0.6) brightness(0.8); }\n.aur-root[data-view=\"poster\"] .aur-art-wrap:active { transform: none; }\n.aur-root[data-view=\"poster\"] .aur-art-hint { left: 40%; }\n.aur-root[data-view=\"poster\"] .aur-side-meta { position: absolute; left: var(--aur-pad); bottom: 150px; width: min(34vw, 560px); text-shadow: 0 2px 24px rgba(0, 0, 0, 0.45); }\n.aur-root[data-view=\"poster\"] .aur-side-title { font-size: clamp(28px, 3.4vw, 54px); line-height: 1.05; }\n.aur-root[data-view=\"poster\"] .aur-side-artist { font-size: clamp(15px, 1.3vw, 19px); color: rgba(255, 255, 255, 0.82); }\n.aur-root[data-view=\"poster\"] .aur-stage { left: calc(var(--aur-poster-w) * 0.9); padding-left: 2vw; --aur-size: min(var(--aur-fs), 4.4vw, 10.5vh); }\n.aur-root[data-view=\"vinyl\"] .aur-art-wrap { border-radius: 50%; box-shadow: 0 40px 90px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05); }\n.aur-root[data-view=\"vinyl\"] .aur-disc {\nborder-radius: 50%;\nbackground:\nradial-gradient(circle, transparent 0 21%, rgba(255, 255, 255, 0.07) 21.3%, transparent 22%),\nradial-gradient(circle, #1b1b1f 0 60%, #111114 100%);\nanimation: aur-spin-disc 7.5s linear infinite;\nanimation-play-state: paused;\n}\n.aur-root[data-view=\"vinyl\"][data-playing=\"true\"] .aur-disc { animation-play-state: running; }\n.aur-root[data-view=\"vinyl\"] .aur-disc-grooves {\ndisplay: block;\nposition: absolute;\ninset: 0;\nborder-radius: 50%;\nbackground: repeating-radial-gradient(circle, rgba(255, 255, 255, 0.035) 0 1px, rgba(255, 255, 255, 0.012) 1.6px, transparent 2.4px 4px);\n-webkit-mask-image: radial-gradient(circle, transparent 0 33%, #000 34% 96%, transparent 97%);\nmask-image: radial-gradient(circle, transparent 0 33%, #000 34% 96%, transparent 97%);\n}\n.aur-root[data-view=\"vinyl\"] .aur-art { inset: 31%; width: 38%; height: 38%; border-radius: 50%; }\n.aur-root[data-view=\"vinyl\"] .aur-disc::after { content: \"\"; position: absolute; left: 50%; top: 50%; width: 3.2%; height: 3.2%; margin: -1.6% 0 0 -1.6%; border-radius: 50%; background: #0b0b0e; box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.08); }\n.aur-root[data-view=\"vinyl\"] .aur-disc-shine {\ndisplay: block;\nposition: absolute;\ninset: 0;\nborder-radius: 50%;\npointer-events: none;\nbackground: conic-gradient(from 20deg, transparent 0 8%, rgba(255, 255, 255, 0.1) 13%, transparent 20% 52%, rgba(255, 255, 255, 0.08) 60%, transparent 68%);\n-webkit-mask-image: radial-gradient(circle, transparent 0 32%, #000 36%);\nmask-image: radial-gradient(circle, transparent 0 32%, #000 36%);\n}\n.aur-root[data-view=\"vinyl\"] .aur-art-hint { z-index: 1; }\n.aur-root[data-view=\"vinyl\"] .aur-side-meta { text-align: center; }\n}\n@keyframes aur-spin-disc { to { rotate: 360deg; } }\n@media (min-height: 600px) {\n.aur-root:is([data-view=\"stage\"], [data-view=\"captions\"]) .aur-side { display: flex; left: 0; right: 0; width: auto; }\n.aur-root:is([data-view=\"stage\"], [data-view=\"captions\"]) :is(.aur-header, .aur-message-art) { display: none; }\n.aur-root:is([data-view=\"stage\"], [data-view=\"captions\"]) .aur-stage { --aur-origin: 50%; text-align: center; }\n.aur-root:is([data-view=\"stage\"], [data-view=\"captions\"]) .aur-line { margin-inline: auto; }\n.aur-root:is([data-view=\"stage\"], [data-view=\"captions\"]) .aur-side-meta { width: auto; min-width: 0; }\n.aur-root[data-view=\"stage\"] .aur-side { flex-direction: row; justify-content: center; bottom: auto; gap: 18px; padding: calc(var(--aur-safe-top) - 16px) var(--aur-pad) 0; }\n.aur-root[data-view=\"stage\"] .aur-art-wrap { width: clamp(84px, 14vh, 150px); border-radius: 10px; box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5); }\n.aur-root[data-view=\"stage\"][data-playing=\"false\"] .aur-art-wrap { transform: scale(0.9); }\n.aur-root[data-view=\"stage\"] .aur-art-hint { width: 44px; height: 44px; margin: -22px 0 0 -22px; }\n.aur-root[data-view=\"stage\"] .aur-side-meta { max-width: 42vw; }\n.aur-root[data-view=\"stage\"] .aur-side-title { font-size: clamp(18px, 2.4vh, 26px); }\n.aur-root[data-view=\"stage\"] .aur-stage { top: calc(var(--aur-safe-top) + clamp(84px, 14vh, 150px)); }\n.aur-root[data-view=\"captions\"] .aur-side { flex-direction: column; justify-content: center; top: 0; bottom: 40vh; gap: 14px; padding: calc(var(--aur-safe-top) - 8px) var(--aur-pad) 0; }\n.aur-root[data-view=\"captions\"] .aur-art-wrap { width: min(34vh, 380px); }\n.aur-root[data-view=\"captions\"] .aur-side-meta { text-align: center; }\n.aur-root[data-view=\"captions\"] .aur-side-title { font-size: clamp(18px, 2.4vh, 26px); }\n.aur-root[data-view=\"captions\"] .aur-stage {\ntop: 58vh;\nbottom: 104px;\n--aur-size: min(calc(var(--aur-fs) * 0.8), 4.4vw, 5.6vh);\n-webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 14%, #000 86%, transparent 100%);\nmask-image: linear-gradient(to bottom, transparent 0, #000 14%, #000 86%, transparent 100%);\n}\n.aur-root[data-view=\"captions\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-active):not([data-d=\"1\"]) { opacity: 0 !important; pointer-events: none; }\n.aur-root[data-view=\"captions\"][data-layout=\"list\"] .aur-stage[data-mode=\"synced\"] .aur-line[data-d=\"1\"] { opacity: 0.4; }\n}\n.aur-root.aur-view-swap :is(.aur-side, .aur-stage) { animation: aur-fade-up 0.7s var(--aur-ease) both; }\n.aur-np {\ndisplay: flex;\nalign-items: center;\ngap: 12px;\nmargin: 2px 14px 8px;\npadding: 10px;\nborder-radius: 14px;\nbackground: linear-gradient(135deg, color-mix(in srgb, var(--aur-accent) 18%, transparent), rgba(255, 255, 255, 0.04));\nborder: 1px solid rgba(255, 255, 255, 0.07);\n}\n.aur-np img { width: 50px; height: 50px; flex: none; border-radius: 8px; object-fit: cover; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4); }\n.aur-np-text { min-width: 0; flex: 1; }\n.aur-np-title, .aur-np-sub { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }\n.aur-np-title { font-size: 14px; font-weight: 700; }\n.aur-np-sub { margin-top: 2px; font-size: 12px; color: rgba(255, 255, 255, 0.6); }\n.aur-np-chip { flex: none; padding: 3px 8px; border-radius: 99px; background: rgba(255, 255, 255, 0.09); font-size: 11px; font-weight: 700; color: rgba(255, 255, 255, 0.8); }\n.aur-prov-list { display: flex; flex-direction: column; gap: 6px; }\n.aur-prov {\ndisplay: grid;\ngrid-template-columns: auto 1fr auto auto;\nalign-items: center;\ngap: 10px;\npadding: 10px 10px 10px 8px;\nborder-radius: 12px;\nbackground: rgba(0, 0, 0, 0.22);\ntransition: opacity 0.2s ease, background 0.2s ease;\n}\n.aur-prov.is-off { opacity: 0.45; }\n.aur-prov-rank { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: rgba(255, 255, 255, 0.1); font-size: 11px; font-weight: 700; }\n.aur-prov-name { font-size: 13.5px; font-weight: 700; }\n.aur-prov-badge { margin-left: 6px; padding: 1px 6px; border-radius: 99px; background: rgba(124, 212, 255, 0.16); color: #7cd4ff; font-size: 10px; font-weight: 700; vertical-align: 1px; }\n.aur-prov-desc { margin-top: 2px; font-size: 11.5px; line-height: 1.35; color: rgba(255, 255, 255, 0.5); }\n.aur-prov-move { display: flex; flex-direction: column; }\n.aur-prov-move button { display: grid; place-items: center; width: 24px; height: 18px; border-radius: 6px; color: rgba(255, 255, 255, 0.6); }\n.aur-prov-move button:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }\n.aur-prov-move button:disabled { opacity: 0.2; pointer-events: none; }\n.aur-prov-move svg { width: 14px; height: 14px; }\n.aur-src-title { margin: 16px 2px 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; color: rgba(255, 255, 255, 0.45); }\n.aur-src-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }\n.aur-src-btn {\ndisplay: flex;\nalign-items: center;\njustify-content: space-between;\ngap: 6px;\nmin-height: 36px;\npadding: 6px 10px;\nborder-radius: 10px;\nbackground: rgba(255, 255, 255, 0.06);\nfont-size: 12.5px;\nfont-weight: 600;\ntext-align: left;\ntransition: background 0.2s ease, box-shadow 0.2s ease;\n}\n.aur-src-btn:hover { background: rgba(255, 255, 255, 0.11); }\n.aur-src-btn small { font-size: 10.5px; font-weight: 600; color: rgba(255, 255, 255, 0.5); }\n.aur-src-btn.is-current { background: rgba(30, 215, 96, 0.13); box-shadow: inset 0 0 0 1px rgba(30, 215, 96, 0.6); }\n.aur-src-btn.is-loading small { animation: aur-blink 1s ease-in-out infinite; }\n.aur-test-btn { width: 100%; margin-top: 8px; }\n@keyframes aur-blink { 50% { opacity: 0.3; } }\n@media (max-width: 1100px) {\n.aur-offset-group { display: none; }\n.aur-source { max-width: 160px; }\n}\n@media (max-width: 780px) {\n.aur-root { --aur-pad: 22px; }\n.aur-header { top: 18px; max-width: calc(100vw - 44px); }\n.aur-cover { width: 44px; height: 44px; }\n.aur-player { column-gap: 10px; padding-bottom: 12px; grid-template-columns: auto minmax(0, 1fr) auto; }\n.aur-source { width: 32px; padding: 0; justify-content: center; font-size: 0; }\n.aur-source::before { width: 9px; height: 9px; }\n.aur-transport { gap: 8px; }\n.aur-play-btn { width: 50px; height: 50px; }\n.aur-player-side { height: 50px; }\n}\n@media (max-width: 600px) {\n.aur-offset-group,\n.aur-volume,\n.aur-player-side .aur-sep,\n.aur-heart,\n.aur-toggle { display: none; }\n.aur-player-side .aur-icon-btn { width: 34px; height: 34px; }\n}\n@media (max-height: 540px) {\n.aur-header { display: none; }\n.aur-message-art { display: none; }\n}\n.aur-no-anim .aur-line,\n.aur-no-anim .aur-w,\n.aur-no-anim .aur-c { transition: none !important; }\n.aur-root[data-motion=\"reduced\"] { transform: none !important; transition: opacity 0.2s ease; }\n.aur-root[data-motion=\"reduced\"] .aur-line,\n.aur-root[data-motion=\"reduced\"] .aur-w,\n.aur-root[data-motion=\"reduced\"] .aur-player,\n.aur-root[data-motion=\"reduced\"] .aur-header,\n.aur-root[data-motion=\"reduced\"] .aur-panel,\n.aur-root[data-motion=\"reduced\"] .aur-rail-pill {\ntransition-property: opacity, color, visibility !important;\ntransition-duration: 0.2s !important;\ntransition-delay: 0s !important;\n}\n.aur-root[data-motion=\"reduced\"] *,\n.aur-root[data-motion=\"reduced\"] *::before { animation: none !important; }\n.aur-root[data-motion=\"reduced\"] .aur-line[data-d] { filter: none !important; }\n.aur-root[data-motion=\"reduced\"] .aur-w,\n.aur-root[data-motion=\"reduced\"] .aur-c { transform: none !important; }\n[data-testid=\"lyrics-npv-section\"][data-aur-hidden] { display: none !important; }\n.aur-npv {\n--npv-c: #3a3a46;\nposition: relative;\noverflow: hidden;\npadding: 16px 16px 10px;\nborder-radius: 8px;\ncolor: #fff;\nfont-family: var(--encore-body-font-stack, \"SpotifyMixUI\", \"CircularSp\", system-ui, sans-serif);\nbackground:\nradial-gradient(120% 90% at 0% 0%, color-mix(in oklab, var(--npv-c) 80%, #fff 6%) 0%, transparent 70%),\nlinear-gradient(165deg, color-mix(in oklab, var(--npv-c) 72%, #000) 0%, color-mix(in oklab, var(--npv-c) 38%, #0d0d10) 100%);\nbox-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);\ntransition: background 0.8s ease;\n}\n.aur-npv-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; min-width: 0; }\n.aur-npv-title { margin: 0; font-size: 16px; font-weight: 700; }\n.aur-npv-src { min-width: 0; overflow: hidden; padding: 2px 8px; border-radius: 99px; background: rgba(255, 255, 255, 0.1); font-size: 11px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; color: rgba(255, 255, 255, 0.72); }\n.aur-npv-src:empty { display: none; }\n.aur-npv-open {\ndisplay: grid;\nflex: none;\nplace-items: center;\nwidth: 32px;\nheight: 32px;\nmargin-left: auto;\npadding: 0;\nborder: 0;\nborder-radius: 50%;\nbackground: rgba(255, 255, 255, 0.1);\ncolor: rgba(255, 255, 255, 0.8);\ncursor: pointer;\ntransition: background 0.2s ease, color 0.2s ease, transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);\n}\n.aur-npv-open:hover { background: rgba(255, 255, 255, 0.2); color: #fff; transform: scale(1.08); }\n.aur-npv-open svg { width: 16px; height: 16px; }\n.aur-npv-body {\nposition: relative;\nheight: 204px;\noverflow: hidden;\ncursor: pointer;\n-webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 14%, #000 78%, transparent 100%);\nmask-image: linear-gradient(to bottom, transparent 0, #000 14%, #000 78%, transparent 100%);\n}\n.aur-npv-lines { padding-top: 6px; will-change: transform; transition: transform 0.75s cubic-bezier(0.22, 1, 0.36, 1); }\n.aur-npv-lines.no-anim { transition: none; }\n.aur-npv-line {\nmargin: 0 -8px;\npadding: 5px 8px;\nborder-radius: 8px;\nfont-size: 19px;\nfont-weight: 700;\nline-height: 1.32;\nletter-spacing: -0.01em;\ncolor: rgba(255, 255, 255, 0.42);\ntransition: color 0.45s ease, background 0.2s ease, text-shadow 0.6s ease;\n}\n.aur-npv-line.is-past { color: rgba(255, 255, 255, 0.7); }\n.aur-npv-line.is-active { color: #fff; text-shadow: 0 0 18px rgba(255, 255, 255, 0.25); }\n.aur-npv-line.is-gap { letter-spacing: 0.15em; }\n.aur-npv-line[title]:hover { background: rgba(255, 255, 255, 0.09); color: rgba(255, 255, 255, 0.92); }\n.aur-npv-line.is-active:has(.aur-npv-w) { text-shadow: none; }\n.aur-npv-line.is-active .aur-npv-w { color: rgba(255, 255, 255, 0.42); }\n.aur-npv-line.is-active .aur-npv-w.sung { color: #fff; }\n.aur-npv-line.is-active .aur-npv-w.now {\ncolor: transparent;\nbackground: linear-gradient(90deg, #fff calc(var(--aur-wp, 0) * (100% + 0.6em) - 0.6em), rgba(255, 255, 255, 0.42) calc(var(--aur-wp, 0) * (100% + 0.6em)));\n-webkit-background-clip: text;\nbackground-clip: text;\n}\n.aur-npv.is-unsynced .aur-npv-line { color: rgba(255, 255, 255, 0.85); font-size: 16px; }\n.aur-npv[data-duet=\"on\"] .aur-npv-line[data-singer=\"1\"] { text-align: right; }\n.aur-npv[data-duet=\"on\"] .aur-npv-line[data-singer=\"2\"] { text-align: center; }\n.aur-npv[data-duet=\"on\"] .aur-npv-line.is-active[data-singer=\"1\"],\n.aur-npv[data-duet=\"on\"] .aur-npv-line.is-active[data-singer=\"1\"] .aur-npv-w.sung { color: #ffd3e6; }\n.aur-npv[data-duet=\"on\"] .aur-npv-line.is-active[data-singer=\"2\"],\n.aur-npv[data-duet=\"on\"] .aur-npv-line.is-active[data-singer=\"2\"] .aur-npv-w.sung { color: #ffe9f2; }\n.aur-npv-msg { position: absolute; inset: 0; display: grid; place-items: center; padding: 0 16px; font-size: 13px; text-align: center; color: rgba(255, 255, 255, 0.62); }\n.aur-npv-msg:empty { display: none; }\n.aur-npv-tr { margin-top: 2px; font-size: 13px; font-weight: 600; line-height: 1.3; color: rgba(255, 255, 255, 0.55); }\n.aur-npv-line.is-active .aur-npv-tr { color: rgba(255, 255, 255, 0.85); }\n.aur-share {\nposition: absolute;\ninset: 0;\nz-index: 6;\ndisplay: grid;\nplace-items: center;\npadding: var(--aur-safe-top, 48px) 16px 16px;\nbackground: rgba(0, 0, 0, 0.45);\nbackdrop-filter: blur(6px);\nopacity: 0;\ntransition: opacity 0.25s ease;\n}\n.aur-share[hidden] { display: none; }\n.aur-share.is-open { opacity: 1; }\n.aur-share-card {\ndisplay: grid;\ngrid-template-columns: auto minmax(260px, 340px);\ngap: 22px;\nmax-width: min(980px, 100%);\nmax-height: 100%;\npadding: 20px;\nborder-radius: 24px;\nbackground: linear-gradient(180deg, rgba(34, 34, 40, 0.92), rgba(18, 18, 22, 0.95));\nborder: 1px solid rgba(255, 255, 255, 0.08);\nbox-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);\ntransform: translateY(12px) scale(0.98);\ntransition: transform 0.35s var(--aur-ease);\nuser-select: none;\n}\n.aur-share.is-open .aur-share-card { transform: none; }\n.aur-share-preview { display: grid; place-items: center; min-height: 0; }\n.aur-share-canvas {\ndisplay: block;\nwidth: auto;\nmax-width: min(46vw, 440px);\nmax-height: min(72vh, 640px);\nborder-radius: 14px;\nbox-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);\n}\n.aur-share-side { display: flex; flex-direction: column; gap: 8px; min-height: 0; min-width: 0; max-height: min(78vh, 720px); }\n.aur-share-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 2px; }\n.aur-share-scroll { display: flex; flex-direction: column; gap: 8px; min-height: 0; overflow-y: auto; margin-right: -8px; padding-right: 8px; scrollbar-width: thin; }\n.aur-share-label { display: flex; justify-content: space-between; margin-top: 8px; font-size: 12px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: rgba(255, 255, 255, 0.55); }\n.aur-share-count { font-variant-numeric: tabular-nums; letter-spacing: 0; }\n.aur-share-lines {\ndisplay: flex;\nflex-direction: column;\ngap: 2px;\nflex: none;\nheight: 26vh;\nmin-height: 120px;\nmax-height: 260px;\noverflow-y: auto;\npadding: 4px;\nborder-radius: 12px;\nbackground: rgba(0, 0, 0, 0.22);\nscrollbar-width: thin;\n}\n.aur-share-line {\npadding: 7px 10px;\nborder-radius: 8px;\nfont-size: 13.5px;\nfont-weight: 600;\nline-height: 1.35;\ntext-align: left;\ncolor: rgba(255, 255, 255, 0.62);\nuser-select: none;\ntransition: background 0.15s ease, color 0.15s ease;\n}\n.aur-share-line:hover { background: rgba(255, 255, 255, 0.07); color: #fff; }\n.aur-share-line[aria-pressed=\"true\"] { background: rgba(30, 215, 96, 0.14); color: #fff; box-shadow: inset 3px 0 0 var(--aur-green); }\n.aur-share-quick { display: flex; align-items: center; gap: 12px; font-size: 12px; }\n.aur-share-link { padding: 0; font-weight: 700; color: rgba(255, 255, 255, 0.8); }\n.aur-share-link:hover { color: #fff; text-decoration: underline; }\n.aur-share-tip { margin-left: auto; color: rgba(255, 255, 255, 0.4); }\n.aur-share .aur-segmented.is-disabled { opacity: 0.4; pointer-events: none; }\n.aur-share .aur-seg { padding: 0 6px; font-size: 12px; }\n.aur-share-size { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 12px; margin-top: 4px; font-size: 13px; color: rgba(255, 255, 255, 0.75); }\n.aur-share-toggles { display: flex; flex-direction: column; margin-top: 8px; border-radius: 12px; background: rgba(255, 255, 255, 0.04); }\n.aur-share-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 12px; font-size: 13px; cursor: pointer; }\n.aur-share-toggle + .aur-share-toggle { border-top: 1px solid rgba(255, 255, 255, 0.05); }\n.aur-share-toggle[hidden] { display: none; }\n.aur-share-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding-top: 12px; border-top: 1px solid rgba(255, 255, 255, 0.06); }\n.aur-share-actions .aur-btn { justify-content: center; }\n.aur-share-actions .aur-btn[hidden] { display: none; }\n@media (max-width: 760px) {\n.aur-share-card { grid-template-columns: 1fr; overflow-y: auto; }\n.aur-share-canvas { max-width: 100%; max-height: 40vh; }\n}\n.aur-float {\n--float-c: #2a2a33;\nposition: fixed;\nz-index: 9990;\ndisplay: flex;\nalign-items: center;\ngap: 12px;\nbox-sizing: border-box;\nwidth: min(560px, calc(100vw - 16px));\nmin-height: 68px;\npadding: 10px 16px 10px 10px;\nborder-radius: 18px;\ncolor: #fff;\nfont-family: var(--encore-body-font-stack, \"SpotifyMixUI\", \"CircularSp\", system-ui, sans-serif);\nbackground: linear-gradient(135deg, color-mix(in srgb, var(--float-c) 72%, rgba(14, 14, 18, 0.9)), rgba(14, 14, 18, 0.88));\nborder: 1px solid rgba(255, 255, 255, 0.1);\nbox-shadow: 0 18px 48px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.06);\nbackdrop-filter: blur(22px) saturate(1.4);\ncursor: grab;\nuser-select: none;\n-webkit-app-region: no-drag;\ntransition: background 0.8s ease, box-shadow 0.25s ease;\n}\n.aur-float[hidden] { display: none; }\n.aur-float *, .aur-float *::before { box-sizing: border-box; }\n.aur-float.is-in { animation: aur-float-in 0.45s cubic-bezier(0.22, 1, 0.36, 1); }\n@keyframes aur-float-in { from { opacity: 0; transform: translateY(12px) scale(0.97); } }\n.aur-float.is-dragging { cursor: grabbing; box-shadow: 0 26px 60px rgba(0, 0, 0, 0.6); transition: none; }\n.aur-float-art { flex: none; width: 48px; height: 48px; border-radius: 10px; object-fit: cover; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4); pointer-events: none; }\n.aur-float-art[hidden] { display: none; }\n.aur-float-text { flex: 1; min-width: 0; cursor: pointer; }\n.aur-float-cur {\nfont-family: var(--encore-title-font-stack, \"SpotifyMixUITitle\", \"SpotifyMixUI\", \"CircularSp\", system-ui, sans-serif);\nfont-size: 18px;\nfont-weight: 800;\nline-height: 1.25;\nletter-spacing: -0.01em;\noverflow-wrap: anywhere;\ndisplay: -webkit-box;\n-webkit-line-clamp: 2;\n-webkit-box-orient: vertical;\noverflow: hidden;\n}\n.aur-float-next { margin-top: 2px; font-size: 13px; font-weight: 600; color: rgba(255, 255, 255, 0.5); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.aur-float-next:empty { display: none; }\n.aur-float .is-enter { animation: aur-float-line 0.4s cubic-bezier(0.22, 1, 0.36, 1); }\n@keyframes aur-float-line { from { opacity: 0; transform: translateY(6px); filter: blur(3px); } }\n.aur-float-w { color: rgba(255, 255, 255, 0.4); }\n.aur-float-w.sung { color: #fff; }\n.aur-float-w[style*=\"--aur-wp\"] {\ncolor: transparent;\nbackground: linear-gradient(90deg, #fff calc(var(--aur-wp, 0) * (100% + 0.6em) - 0.6em), rgba(255, 255, 255, 0.4) calc(var(--aur-wp, 0) * (100% + 0.6em)));\n-webkit-background-clip: text;\nbackground-clip: text;\n}\n.aur-float[data-duet=\"on\"] .aur-float-cur[data-singer=\"1\"] .aur-float-w.sung,\n.aur-float[data-duet=\"on\"] .aur-float-cur[data-singer=\"1\"]:not(:has(.aur-float-w:not([hidden]))) { color: #ffd3e6; }\n.aur-float-dots { display: inline-flex; gap: 6px; padding: 6px 0; }\n.aur-float-cur > [hidden] { display: none; }\n.aur-float-dots i { width: 7px; height: 7px; border-radius: 50%; background: #fff; opacity: 0.35; animation: aur-float-dot 1.4s ease-in-out infinite; }\n.aur-float-dots i:nth-child(2) { animation-delay: 0.18s; }\n.aur-float-dots i:nth-child(3) { animation-delay: 0.36s; }\n@keyframes aur-float-dot { 50% { opacity: 0.9; transform: translateY(-2px); } }\n.aur-float-actions {\nposition: absolute;\ntop: -12px;\nright: 10px;\ndisplay: flex;\ngap: 4px;\npadding: 3px;\nborder-radius: 99px;\nbackground: rgba(24, 24, 28, 0.95);\nborder: 1px solid rgba(255, 255, 255, 0.1);\nbox-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);\nopacity: 0;\ntransform: translateY(4px);\ntransition: opacity 0.2s ease, transform 0.25s ease;\npointer-events: none;\n}\n.aur-float:hover .aur-float-actions, .aur-float:focus-within .aur-float-actions { opacity: 1; transform: none; pointer-events: auto; }\n.aur-float-btn {\ndisplay: grid;\nplace-items: center;\nwidth: 28px;\nheight: 28px;\npadding: 0;\nborder: 0;\nborder-radius: 50%;\nbackground: transparent;\ncolor: rgba(255, 255, 255, 0.75);\ncursor: pointer;\n}\n.aur-float-btn:hover { background: rgba(255, 255, 255, 0.12); color: #fff; }\n.aur-float-btn[hidden] { display: none; }\n.aur-float-btn svg { width: 16px; height: 16px; }\n.aur-float-pip-body { margin: 0; overflow: hidden; background: #0e0e12; }\n.aur-float.is-pip { position: static; width: 100vw; height: 100vh; min-height: 0; border: 0; border-radius: 0; padding: 12px 18px 12px 12px; box-shadow: none; cursor: default; }\n.aur-float.is-pip .aur-float-art { width: min(64px, calc(100vh - 24px)); height: min(64px, calc(100vh - 24px)); }\n.aur-float.is-pip .aur-float-cur { font-size: clamp(16px, 6.5vw, 30px); }\n.aur-float.is-pip .aur-float-actions { top: 6px; right: 6px; }\n.aur-float.is-pip .is-pip-btn { display: none; }\n.aur-upnext {\nposition: absolute;\nright: var(--aur-pad);\nbottom: 116px;\nz-index: 3;\ndisplay: flex;\nalign-items: center;\ngap: 12px;\nmax-width: min(340px, calc(100vw - 32px));\npadding: 8px 12px 8px 8px;\nborder-radius: 16px;\nbackground: rgba(20, 20, 26, 0.55);\nborder: 1px solid rgba(255, 255, 255, 0.1);\nbox-shadow: 0 14px 40px rgba(0, 0, 0, 0.35);\nbackdrop-filter: blur(20px) saturate(1.4);\ncolor: #fff;\ntext-align: left;\nopacity: 0;\ntransform: translateY(14px) scale(0.97);\npointer-events: none;\ntransition: opacity 0.5s var(--aur-ease), transform 0.6s var(--aur-ease), bottom 0.65s var(--aur-ease), background 0.2s ease;\n}\n.aur-upnext.is-on { opacity: 1; transform: none; pointer-events: auto; }\n.aur-upnext:hover { background: rgba(38, 38, 46, 0.7); }\n.aur-root[data-transport=\"off\"] .aur-upnext,\n.aur-root[data-idle=\"true\"] .aur-upnext { bottom: 24px; }\n.aur-upnext-art { flex: none; width: 46px; height: 46px; border-radius: 9px; object-fit: cover; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4); }\n.aur-upnext-art[hidden] { display: none; }\n.aur-upnext-text { min-width: 0; flex: 1; }\n.aur-upnext-label { font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255, 255, 255, 0.55); }\n.aur-upnext-when { letter-spacing: 0.02em; text-transform: none; font-variant-numeric: tabular-nums; }\n.aur-upnext-title, .aur-upnext-artist { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.aur-upnext-title { margin-top: 1px; font-size: 14px; font-weight: 700; }\n.aur-upnext-artist { font-size: 12.5px; color: rgba(255, 255, 255, 0.62); }\n.aur-upnext-skip { flex: none; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: rgba(255, 255, 255, 0.1); opacity: 0.7; transition: opacity 0.2s ease, background 0.2s ease; }\n.aur-upnext-skip svg { width: 14px; height: 14px; }\n.aur-upnext:hover .aur-upnext-skip { opacity: 1; background: rgba(255, 255, 255, 0.2); }\n.aur-root[data-motion=\"reduced\"] .aur-upnext { transition: opacity 0.3s ease; transform: none; }\n.aur-link { display: inline; padding: 0; border: 0; background: none; font: inherit; color: inherit; cursor: pointer; text-decoration: underline transparent 1px; text-underline-offset: 3px; transition: color 0.2s ease, text-decoration-color 0.2s ease; }\n.aur-link:hover, .aur-link:focus-visible { color: #fff; text-decoration-color: currentColor; outline: none; }\n.aur-topbar-btn {\n--aur-pb-c: #b98cff;\nposition: relative;\ndisplay: inline-grid !important;\nplace-items: center;\nwidth: 44px !important;\nheight: 44px !important;\nmin-width: 44px;\nmargin-inline: 8px;\npadding: 0 !important;\nborder: 0;\nborder-radius: 14px !important;\noverflow: hidden;\ncursor: pointer;\n}\n.aur-topbar-btn svg { position: relative; width: 20px; height: 20px; }\n.aur-root[data-tabs=\"off\"] .aur-tabs-btn { display: none; }\n.aur-tabs-pop {\nposition: absolute;\nright: var(--aur-pad);\nbottom: 96px;\nz-index: 5;\nwidth: min(300px, calc(100vw - 32px));\npadding: 14px;\nborder-radius: 18px;\nbackground: linear-gradient(180deg, rgba(34, 34, 40, 0.94), rgba(18, 18, 22, 0.96));\nborder: 1px solid rgba(255, 255, 255, 0.1);\nbox-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);\nbackdrop-filter: blur(20px);\nopacity: 0;\ntransform: translateY(10px) scale(0.97);\ntransform-origin: 85% 100%;\ntransition: opacity 0.22s ease, transform 0.3s var(--aur-ease);\n}\n.aur-tabs-pop[hidden] { display: none; }\n.aur-tabs-pop.is-open { opacity: 1; transform: none; }\n.aur-tabs-head { display: flex; align-items: center; gap: 10px; min-width: 0; }\n.aur-tabs-logo { flex: none; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; background: rgba(255, 255, 255, 0.08); color: #fff; }\n.aur-tabs-logo svg { width: 18px; height: 18px; }\n.aur-tabs-head > div { min-width: 0; }\n.aur-tabs-kicker { font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(255, 255, 255, 0.5); }\n.aur-tabs-song { font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.aur-tabs-status { margin-top: 12px; font-size: 13px; color: rgba(255, 255, 255, 0.65); }\n.aur-tabs-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }\n.aur-tabs-chip { padding: 4px 10px; border-radius: 99px; background: rgba(255, 255, 255, 0.09); font-size: 12px; font-weight: 600; }\n.aur-tabs-diff { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 12px; color: rgba(255, 255, 255, 0.6); }\n.aur-tabs-dots { display: inline-flex; gap: 3px; }\n.aur-tabs-dots i { width: 7px; height: 7px; border-radius: 50%; background: rgba(255, 255, 255, 0.18); }\n.aur-tabs-dots i:nth-child(-n + 1) { background: var(--aur-green); }\n.aur-tabs-dots[style*=\"--d:2\"] i:nth-child(-n + 2),\n.aur-tabs-dots[style*=\"--d:3\"] i:nth-child(-n + 3),\n.aur-tabs-dots[style*=\"--d:4\"] i:nth-child(-n + 4),\n.aur-tabs-dots[style*=\"--d:5\"] i:nth-child(-n + 5) { background: var(--aur-green); }\n.aur-tabs-actions { display: flex; gap: 8px; margin-top: 14px; }\n.aur-tabs-actions .aur-btn { flex: 1; justify-content: center; }\n.aur-fx { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }\n.aur-fx > i { position: absolute; display: none; }\n.aur-root[data-bganim=\"off\"] .aur-fx > i,\n.aur-root[data-bganim=\"off\"] .aur-fx > i::before,\n.aur-root[data-bganim=\"off\"] .aur-fx > i::after,\n.aur-root[data-bganim=\"off\"] .aur-fx::before,\n.aur-root[data-bganim=\"off\"] .aur-fx::after { animation-play-state: paused; }\n@keyframes aur-fx-pulse { 50% { opacity: 0.6; } }\n@keyframes aur-fx-breathe { 50% { transform: scale(1.12); opacity: 0.7; } }\n.aur-root[data-fx=\"aurora\"] .aur-fx {\nbackground:\nradial-gradient(80% 34% at 50% 100%, rgba(60, 255, 170, 0.2), rgba(40, 200, 170, 0.07) 55%, transparent 80%),\nlinear-gradient(to bottom, rgba(6, 14, 34, 0.8), rgba(9, 24, 46, 0.7) 40%, rgba(12, 36, 58, 0.6) 70%, rgba(14, 44, 62, 0.5) 100%);\n}\n.aur-root[data-fx=\"aurora\"] .aur-fx::before {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground:\nradial-gradient(1.2px 1.2px at 85.0% 54.9%, rgba(235, 255, 245, 0.68), transparent),\nradial-gradient(1.5px 1.5px at 19.1% 36.3%, rgba(255, 255, 255, 0.76), transparent),\nradial-gradient(1px 1px at 44.8% 10.8%, rgba(255, 255, 255, 0.72), transparent),\nradial-gradient(0.8px 0.8px at 97.3% 67.6%, rgba(235, 255, 245, 0.78), transparent),\nradial-gradient(1.5px 1.5px at 16.4% 2.0%, rgba(235, 255, 245, 0.71), transparent),\nradial-gradient(0.8px 0.8px at 19.6% 17.7%, rgba(255, 255, 255, 0.47), transparent),\nradial-gradient(1.2px 1.2px at 44.2% 59.1%, rgba(220, 235, 255, 0.71), transparent),\nradial-gradient(1px 1px at 1.5% 6.9%, rgba(220, 235, 255, 0.78), transparent),\nradial-gradient(1.2px 1.2px at 98.6% 59.0%, rgba(235, 255, 245, 0.80), transparent),\nradial-gradient(1px 1px at 51.3% 3.1%, rgba(255, 255, 255, 0.73), transparent),\nradial-gradient(0.8px 0.8px at 11.6% 21.1%, rgba(220, 235, 255, 0.48), transparent),\nradial-gradient(0.8px 0.8px at 1.1% 15.5%, rgba(235, 255, 245, 0.91), transparent),\nradial-gradient(1.2px 1.2px at 97.1% 28.4%, rgba(220, 235, 255, 0.49), transparent),\nradial-gradient(1px 1px at 27.4% 7.0%, rgba(235, 255, 245, 0.62), transparent),\nradial-gradient(1.2px 1.2px at 14.2% 49.8%, rgba(255, 255, 255, 0.46), transparent),\nradial-gradient(1.2px 1.2px at 18.4% 39.6%, rgba(220, 235, 255, 0.67), transparent),\nradial-gradient(1px 1px at 76.4% 29.9%, rgba(235, 255, 245, 0.64), transparent),\nradial-gradient(1.2px 1.2px at 98.0% 1.0%, rgba(220, 235, 255, 0.88), transparent),\nradial-gradient(1.5px 1.5px at 98.8% 2.4%, rgba(220, 235, 255, 0.54), transparent),\nradial-gradient(1.5px 1.5px at 57.5% 3.9%, rgba(235, 255, 245, 0.52), transparent),\nradial-gradient(1.2px 1.2px at 1.9% 43.1%, rgba(220, 235, 255, 0.87), transparent),\nradial-gradient(1.2px 1.2px at 8.3% 15.4%, rgba(255, 255, 255, 0.77), transparent),\nradial-gradient(0.8px 0.8px at 37.1% 43.9%, rgba(235, 255, 245, 0.51), transparent),\nradial-gradient(1.5px 1.5px at 82.6% 10.4%, rgba(220, 235, 255, 0.64), transparent),\nradial-gradient(1px 1px at 90.0% 57.4%, rgba(220, 235, 255, 0.57), transparent),\nradial-gradient(1px 1px at 73.5% 65.9%, rgba(255, 255, 255, 0.55), transparent),\nradial-gradient(1.2px 1.2px at 60.1% 30.1%, rgba(220, 235, 255, 0.50), transparent),\nradial-gradient(0.8px 0.8px at 95.3% 17.5%, rgba(235, 255, 245, 0.80), transparent),\nradial-gradient(1px 1px at 81.7% 42.2%, rgba(220, 235, 255, 0.60), transparent),\nradial-gradient(1px 1px at 96.8% 9.7%, rgba(235, 255, 245, 0.69), transparent),\nradial-gradient(1.5px 1.5px at 8.3% 15.7%, rgba(235, 255, 245, 0.91), transparent),\nradial-gradient(0.8px 0.8px at 27.4% 31.8%, rgba(255, 255, 255, 0.48), transparent),\nradial-gradient(1px 1px at 37.1% 40.5%, rgba(220, 235, 255, 0.52), transparent),\nradial-gradient(1px 1px at 88.3% 68.7%, rgba(255, 255, 255, 0.78), transparent),\nradial-gradient(1.5px 1.5px at 93.8% 41.7%, rgba(235, 255, 245, 0.91), transparent),\nradial-gradient(1.2px 1.2px at 69.7% 67.4%, rgba(220, 235, 255, 0.46), transparent),\nradial-gradient(0.8px 0.8px at 7.6% 22.5%, rgba(220, 235, 255, 0.52), transparent),\nradial-gradient(0.8px 0.8px at 45.4% 26.4%, rgba(255, 255, 255, 0.47), transparent),\nradial-gradient(1px 1px at 35.5% 48.3%, rgba(220, 235, 255, 0.90), transparent),\nradial-gradient(1.2px 1.2px at 85.6% 40.5%, rgba(255, 255, 255, 0.76), transparent);\n-webkit-mask-image: linear-gradient(#000 35%, transparent 80%);\nmask-image: linear-gradient(#000 35%, transparent 80%);\nopacity: 0.8;\nanimation: aur-au-twinkle 8s steps(48) infinite alternate;\n}\n@keyframes aur-au-twinkle { from { opacity: 0.55; } to { opacity: 0.9; } }\n.aur-root[data-fx=\"aurora\"] .aur-fx-a {\ndisplay: block;\nleft: -8%;\nright: -8%;\ntop: -4%;\nheight: 92%;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2400 1000' preserveAspectRatio='none'%3E%3Cdefs%3E%3ClinearGradient id='c' gradientUnits='userSpaceOnUse' x1='0' y1='0' x2='0' y2='1000'%3E%3Cstop offset='0.181' stop-color='%23c455ff'/%3E%3Cstop offset='0.390' stop-color='%237f70ff'/%3E%3Cstop offset='0.626' stop-color='%2326e6b4'/%3E%3Cstop offset='0.807' stop-color='%2357ffbd'/%3E%3Cstop offset='0.876' stop-color='%23e4fff4'/%3E%3C/linearGradient%3E%3ClinearGradient id='g' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%23000'/%3E%3Cstop offset='.4' stop-color='%23fff' stop-opacity='.14'/%3E%3Cstop offset='.7' stop-color='%23fff' stop-opacity='.55'/%3E%3Cstop offset='.86' stop-color='%23fff'/%3E%3Cstop offset='.93' stop-color='%23fff' stop-opacity='.85'/%3E%3Cstop offset='1' stop-color='%23000'/%3E%3C/linearGradient%3E%3Cmask id='f' maskContentUnits='objectBoundingBox'%3E%3Crect width='1' height='1' fill='url(%23g)'/%3E%3C/mask%3E%3ClinearGradient id='s'%3E%3Cstop offset='0' stop-color='%23000'/%3E%3Cstop offset='.5' stop-color='%23fff'/%3E%3Cstop offset='1' stop-color='%23000'/%3E%3C/linearGradient%3E%3Cpattern id='r' width='1200' height='1000' patternUnits='userSpaceOnUse'%3E%3Cg fill='url(%23s)'%3E%3Crect x='0' width='16' height='1000' opacity='0.75'/%3E%3Crect x='31' width='27' height='1000' opacity='0.91'/%3E%3Crect x='58' width='35' height='1000' opacity='0.84'/%3E%3Crect x='115' width='34' height='1000' opacity='0.62'/%3E%3Crect x='146' width='7' height='1000' opacity='0.82'/%3E%3Crect x='160' width='6' height='1000' opacity='0.84'/%3E%3Crect x='169' width='23' height='1000' opacity='1.00'/%3E%3Crect x='212' width='12' height='1000' opacity='0.56'/%3E%3Crect x='231' width='5' height='1000' opacity='0.98'/%3E%3Crect x='240' width='11' height='1000' opacity='0.72'/%3E%3Crect x='259' width='21' height='1000' opacity='0.67'/%3E%3Crect x='280' width='6' height='1000' opacity='0.61'/%3E%3Crect x='291' width='28' height='1000' opacity='0.80'/%3E%3Crect x='331' width='19' height='1000' opacity='0.72'/%3E%3Crect x='357' width='37' height='1000' opacity='0.69'/%3E%3Crect x='429' width='37' height='1000' opacity='0.81'/%3E%3Crect x='464' width='16' height='1000' opacity='0.70'/%3E%3Crect x='484' width='4' height='1000' opacity='0.56'/%3E%3Crect x='490' width='30' height='1000' opacity='0.61'/%3E%3Crect x='531' width='21' height='1000' opacity='0.66'/%3E%3Crect x='555' width='21' height='1000' opacity='0.95'/%3E%3Crect x='590' width='9' height='1000' opacity='0.66'/%3E%3Crect x='606' width='20' height='1000' opacity='0.78'/%3E%3Crect x='645' width='28' height='1000' opacity='0.93'/%3E%3Crect x='690' width='6' height='1000' opacity='0.58'/%3E%3Crect x='698' width='23' height='1000' opacity='0.81'/%3E%3Crect x='722' width='40' height='1000' opacity='0.88'/%3E%3Crect x='783' width='16' height='1000' opacity='0.96'/%3E%3Crect x='811' width='8' height='1000' opacity='0.58'/%3E%3Crect x='822' width='9' height='1000' opacity='0.88'/%3E%3Crect x='840' width='18' height='1000' opacity='0.71'/%3E%3Crect x='870' width='9' height='1000' opacity='0.94'/%3E%3Crect x='885' width='30' height='1000' opacity='0.58'/%3E%3Crect x='915' width='12' height='1000' opacity='0.72'/%3E%3Crect x='936' width='7' height='1000' opacity='0.78'/%3E%3Crect x='947' width='17' height='1000' opacity='0.60'/%3E%3Crect x='978' width='15' height='1000' opacity='0.69'/%3E%3Crect x='1003' width='38' height='1000' opacity='0.97'/%3E%3Crect x='1060' width='22' height='1000' opacity='0.74'/%3E%3Crect x='1101' width='25' height='1000' opacity='0.96'/%3E%3Crect x='1130' width='5' height='1000' opacity='0.87'/%3E%3Crect x='1140' width='10' height='1000' opacity='0.97'/%3E%3Crect x='1159' width='32' height='1000' opacity='0.93'/%3E%3C/g%3E%3C/pattern%3E%3Cmask id='rm' maskUnits='userSpaceOnUse' x='0' y='0' width='2400' height='1000'%3E%3Crect width='2400' height='1000' fill='url(%23r)'/%3E%3C/mask%3E%3Cg id='sl' fill='url(%23c)'%3E%3Cpath d='M0 863L25 864 25 432 0 431Z' opacity='0.76' mask='url(%23f)'/%3E%3Cpath d='M24 864L49 861 49 428 24 432Z' opacity='0.76' mask='url(%23f)'/%3E%3Cpath d='M48 861L73 854 73 419 48 428Z' opacity='0.76' mask='url(%23f)'/%3E%3Cpath d='M72 854L97 846 97 409 72 419Z' opacity='0.77' mask='url(%23f)'/%3E%3Cpath d='M96 846L121 837 121 398 96 409Z' opacity='0.77' mask='url(%23f)'/%3E%3Cpath d='M120 837L145 827 145 385 120 398Z' opacity='0.78' mask='url(%23f)'/%3E%3Cpath d='M144 827L169 816 169 370 144 385Z' opacity='0.78' mask='url(%23f)'/%3E%3Cpath d='M168 816L193 801 193 353 168 370Z' opacity='0.79' mask='url(%23f)'/%3E%3Cpath d='M192 801L217 783 217 332 192 353Z' opacity='0.79' mask='url(%23f)'/%3E%3Cpath d='M216 783L241 763 241 309 216 332Z' opacity='0.79' mask='url(%23f)'/%3E%3Cpath d='M240 763L265 742 265 286 240 309Z' opacity='0.78' mask='url(%23f)'/%3E%3Cpath d='M264 742L289 724 289 266 264 286Z' opacity='0.75' mask='url(%23f)'/%3E%3Cpath d='M288 724L313 711 313 252 288 266Z' opacity='0.71' mask='url(%23f)'/%3E%3Cpath d='M312 711L337 705 337 246 312 252Z' opacity='0.65' mask='url(%23f)'/%3E%3Cpath d='M336 705L361 707 361 247 336 246Z' opacity='0.59' mask='url(%23f)'/%3E%3Cpath d='M360 707L385 714 385 254 360 247Z' opacity='0.54' mask='url(%23f)'/%3E%3Cpath d='M384 714L409 725 409 264 384 254Z' opacity='0.50' mask='url(%23f)'/%3E%3Cpath d='M408 725L433 734 433 273 408 264Z' opacity='0.48' mask='url(%23f)'/%3E%3Cpath d='M432 734L457 741 457 278 432 273Z' opacity='0.47' mask='url(%23f)'/%3E%3Cpath d='M456 741L481 742 481 278 456 278Z' opacity='0.46' mask='url(%23f)'/%3E%3Cpath d='M480 742L505 737 505 272 480 278Z' opacity='0.45' mask='url(%23f)'/%3E%3Cpath d='M504 737L529 729 529 263 504 272Z' opacity='0.43' mask='url(%23f)'/%3E%3Cpath d='M528 729L553 720 553 252 528 263Z' opacity='0.40' mask='url(%23f)'/%3E%3Cpath d='M552 720L577 712 577 243 552 252Z' opacity='0.37' mask='url(%23f)'/%3E%3Cpath d='M576 712L601 708 601 238 576 243Z' opacity='0.35' mask='url(%23f)'/%3E%3Cpath d='M600 708L625 708 625 237 600 238Z' opacity='0.33' mask='url(%23f)'/%3E%3Cpath d='M624 708L649 712 649 240 624 237Z' opacity='0.32' mask='url(%23f)'/%3E%3Cpath d='M648 712L673 718 673 246 648 240Z' opacity='0.31' mask='url(%23f)'/%3E%3Cpath d='M672 718L697 726 697 254 672 246Z' opacity='0.31' mask='url(%23f)'/%3E%3Cpath d='M696 726L721 733 721 261 696 254Z' opacity='0.30' mask='url(%23f)'/%3E%3Cpath d='M720 733L745 741 745 267 720 261Z' opacity='0.28' mask='url(%23f)'/%3E%3Cpath d='M744 741L769 751 769 274 744 267Z' opacity='0.26' mask='url(%23f)'/%3E%3Cpath d='M768 751L793 762 793 283 768 274Z' opacity='0.25' mask='url(%23f)'/%3E%3Cpath d='M792 762L817 777 817 294 792 283Z' opacity='0.23' mask='url(%23f)'/%3E%3Cpath d='M816 777L841 797 841 310 816 294Z' opacity='0.22' mask='url(%23f)'/%3E%3Cpath d='M840 797L865 818 865 328 840 310Z' opacity='0.22' mask='url(%23f)'/%3E%3Cpath d='M864 818L889 840 889 346 864 328Z' opacity='0.22' mask='url(%23f)'/%3E%3Cpath d='M888 840L913 859 913 362 888 346Z' opacity='0.22' mask='url(%23f)'/%3E%3Cpath d='M912 859L937 872 937 371 912 362Z' opacity='0.23' mask='url(%23f)'/%3E%3Cpath d='M936 872L961 876 961 373 936 371Z' opacity='0.25' mask='url(%23f)'/%3E%3Cpath d='M960 876L985 871 985 366 960 373Z' opacity='0.29' mask='url(%23f)'/%3E%3Cpath d='M984 871L1009 859 1009 353 984 366Z' opacity='0.36' mask='url(%23f)'/%3E%3Cpath d='M1008 859L1033 842 1033 335 1008 353Z' opacity='0.44' mask='url(%23f)'/%3E%3Cpath d='M1032 842L1057 824 1057 318 1032 335Z' opacity='0.52' mask='url(%23f)'/%3E%3Cpath d='M1056 824L1081 808 1081 304 1056 318Z' opacity='0.58' mask='url(%23f)'/%3E%3Cpath d='M1080 808L1105 795 1105 294 1080 304Z' opacity='0.62' mask='url(%23f)'/%3E%3Cpath d='M1104 795L1129 788 1129 290 1104 294Z' opacity='0.62' mask='url(%23f)'/%3E%3Cpath d='M1128 788L1153 783 1153 290 1128 290Z' opacity='0.61' mask='url(%23f)'/%3E%3Cpath d='M1152 783L1177 781 1177 293 1152 290Z' opacity='0.59' mask='url(%23f)'/%3E%3Cpath d='M1176 781L1201 778 1201 295 1176 293Z' opacity='0.56' mask='url(%23f)'/%3E%3Cpath d='M1200 778L1225 774 1225 296 1200 295Z' opacity='0.53' mask='url(%23f)'/%3E%3Cpath d='M1224 774L1249 768 1249 295 1224 296Z' opacity='0.51' mask='url(%23f)'/%3E%3Cpath d='M1248 768L1273 762 1273 293 1248 295Z' opacity='0.48' mask='url(%23f)'/%3E%3Cpath d='M1272 762L1297 756 1297 291 1272 293Z' opacity='0.46' mask='url(%23f)'/%3E%3Cpath d='M1296 756L1321 752 1321 290 1296 291Z' opacity='0.45' mask='url(%23f)'/%3E%3Cpath d='M1320 752L1345 750 1345 290 1320 290Z' opacity='0.45' mask='url(%23f)'/%3E%3Cpath d='M1344 750L1369 749 1369 290 1344 290Z' opacity='0.47' mask='url(%23f)'/%3E%3Cpath d='M1368 749L1393 749 1393 289 1368 290Z' opacity='0.49' mask='url(%23f)'/%3E%3Cpath d='M1392 749L1417 745 1417 284 1392 289Z' opacity='0.53' mask='url(%23f)'/%3E%3Cpath d='M1416 745L1441 738 1441 274 1416 284Z' opacity='0.57' mask='url(%23f)'/%3E%3Cpath d='M1440 738L1465 726 1465 259 1440 274Z' opacity='0.62' mask='url(%23f)'/%3E%3Cpath d='M1464 726L1489 710 1489 240 1464 259Z' opacity='0.66' mask='url(%23f)'/%3E%3Cpath d='M1488 710L1513 693 1513 219 1488 240Z' opacity='0.70' mask='url(%23f)'/%3E%3Cpath d='M1512 693L1537 679 1537 200 1512 219Z' opacity='0.72' mask='url(%23f)'/%3E%3Cpath d='M1536 679L1561 670 1561 186 1536 200Z' opacity='0.72' mask='url(%23f)'/%3E%3Cpath d='M1560 670L1585 670 1585 181 1560 186Z' opacity='0.70' mask='url(%23f)'/%3E%3Cpath d='M1584 670L1609 678 1609 186 1584 181Z' opacity='0.66' mask='url(%23f)'/%3E%3Cpath d='M1608 678L1633 694 1633 198 1608 186Z' opacity='0.60' mask='url(%23f)'/%3E%3Cpath d='M1632 694L1657 715 1657 216 1632 198Z' opacity='0.54' mask='url(%23f)'/%3E%3Cpath d='M1656 715L1681 737 1681 237 1656 216Z' opacity='0.49' mask='url(%23f)'/%3E%3Cpath d='M1680 737L1705 759 1705 257 1680 237Z' opacity='0.44' mask='url(%23f)'/%3E%3Cpath d='M1704 759L1729 777 1729 276 1704 257Z' opacity='0.40' mask='url(%23f)'/%3E%3Cpath d='M1728 777L1753 791 1753 296 1728 276Z' opacity='0.39' mask='url(%23f)'/%3E%3Cpath d='M1752 791L1777 802 1777 317 1752 296Z' opacity='0.38' mask='url(%23f)'/%3E%3Cpath d='M1776 802L1801 812 1801 340 1776 317Z' opacity='0.39' mask='url(%23f)'/%3E%3Cpath d='M1800 812L1825 820 1825 367 1800 340Z' opacity='0.42' mask='url(%23f)'/%3E%3Cpath d='M1824 820L1849 828 1849 396 1824 367Z' opacity='0.47' mask='url(%23f)'/%3E%3Cpath d='M1848 828L1873 835 1873 425 1848 396Z' opacity='0.52' mask='url(%23f)'/%3E%3Cpath d='M1872 835L1897 840 1897 453 1872 425Z' opacity='0.58' mask='url(%23f)'/%3E%3Cpath d='M1896 840L1921 842 1921 477 1896 453Z' opacity='0.64' mask='url(%23f)'/%3E%3Cpath d='M1920 842L1945 838 1945 494 1920 477Z' opacity='0.69' mask='url(%23f)'/%3E%3Cpath d='M1944 838L1969 830 1969 504 1944 494Z' opacity='0.73' mask='url(%23f)'/%3E%3Cpath d='M1968 830L1993 819 1993 508 1968 504Z' opacity='0.73' mask='url(%23f)'/%3E%3Cpath d='M1992 819L2017 807 2017 507 1992 508Z' opacity='0.71' mask='url(%23f)'/%3E%3Cpath d='M2016 807L2041 798 2041 504 2016 507Z' opacity='0.66' mask='url(%23f)'/%3E%3Cpath d='M2040 798L2065 793 2065 500 2040 504Z' opacity='0.60' mask='url(%23f)'/%3E%3Cpath d='M2064 793L2089 794 2089 499 2064 500Z' opacity='0.52' mask='url(%23f)'/%3E%3Cpath d='M2088 794L2113 800 2113 501 2088 499Z' opacity='0.45' mask='url(%23f)'/%3E%3Cpath d='M2112 800L2137 809 2137 504 2112 501Z' opacity='0.39' mask='url(%23f)'/%3E%3Cpath d='M2136 809L2161 818 2161 504 2136 504Z' opacity='0.35' mask='url(%23f)'/%3E%3Cpath d='M2160 818L2185 822 2185 499 2160 504Z' opacity='0.32' mask='url(%23f)'/%3E%3Cpath d='M2184 822L2209 821 2209 487 2184 499Z' opacity='0.32' mask='url(%23f)'/%3E%3Cpath d='M2208 821L2233 812 2233 467 2208 487Z' opacity='0.33' mask='url(%23f)'/%3E%3Cpath d='M2232 812L2257 798 2257 441 2232 467Z' opacity='0.36' mask='url(%23f)'/%3E%3Cpath d='M2256 798L2281 780 2281 413 2256 441Z' opacity='0.41' mask='url(%23f)'/%3E%3Cpath d='M2280 780L2305 760 2305 384 2280 413Z' opacity='0.47' mask='url(%23f)'/%3E%3Cpath d='M2304 760L2329 742 2329 358 2304 384Z' opacity='0.55' mask='url(%23f)'/%3E%3Cpath d='M2328 742L2353 727 2353 337 2328 358Z' opacity='0.63' mask='url(%23f)'/%3E%3Cpath d='M2352 727L2377 714 2377 321 2352 337Z' opacity='0.70' mask='url(%23f)'/%3E%3Cpath d='M2376 714L2401 704 2401 309 2376 321Z' opacity='0.75' mask='url(%23f)'/%3E%3C/g%3E%3C/defs%3E%3Cuse href='%23sl' opacity='.17'/%3E%3Cg mask='url(%23rm)'%3E%3Cuse href='%23sl'/%3E%3C/g%3E%3Cdefs%3E%3Cg id='hm'%3E%3Cpath d='M0 855L25 856' opacity='0.76'/%3E%3Cpath d='M24 856L49 853' opacity='0.76'/%3E%3Cpath d='M48 853L73 846' opacity='0.76'/%3E%3Cpath d='M72 846L97 838' opacity='0.77'/%3E%3Cpath d='M96 838L121 829' opacity='0.77'/%3E%3Cpath d='M120 829L145 819' opacity='0.78'/%3E%3Cpath d='M144 819L169 808' opacity='0.78'/%3E%3Cpath d='M168 808L193 793' opacity='0.79'/%3E%3Cpath d='M192 793L217 775' opacity='0.79'/%3E%3Cpath d='M216 775L241 755' opacity='0.79'/%3E%3Cpath d='M240 755L265 734' opacity='0.78'/%3E%3Cpath d='M264 734L289 716' opacity='0.75'/%3E%3Cpath d='M288 716L313 703' opacity='0.71'/%3E%3Cpath d='M312 703L337 697' opacity='0.65'/%3E%3Cpath d='M336 697L361 699' opacity='0.59'/%3E%3Cpath d='M360 699L385 706' opacity='0.54'/%3E%3Cpath d='M384 706L409 717' opacity='0.50'/%3E%3Cpath d='M408 717L433 726' opacity='0.48'/%3E%3Cpath d='M432 726L457 733' opacity='0.47'/%3E%3Cpath d='M456 733L481 734' opacity='0.46'/%3E%3Cpath d='M480 734L505 729' opacity='0.45'/%3E%3Cpath d='M504 729L529 721' opacity='0.43'/%3E%3Cpath d='M528 721L553 712' opacity='0.40'/%3E%3Cpath d='M552 712L577 704' opacity='0.37'/%3E%3Cpath d='M576 704L601 700' opacity='0.35'/%3E%3Cpath d='M600 700L625 700' opacity='0.33'/%3E%3Cpath d='M624 700L649 704' opacity='0.32'/%3E%3Cpath d='M648 704L673 710' opacity='0.31'/%3E%3Cpath d='M672 710L697 718' opacity='0.31'/%3E%3Cpath d='M696 718L721 725' opacity='0.30'/%3E%3Cpath d='M720 725L745 733' opacity='0.28'/%3E%3Cpath d='M744 733L769 743' opacity='0.26'/%3E%3Cpath d='M768 743L793 754' opacity='0.25'/%3E%3Cpath d='M792 754L817 769' opacity='0.23'/%3E%3Cpath d='M816 769L841 789' opacity='0.22'/%3E%3Cpath d='M840 789L865 810' opacity='0.22'/%3E%3Cpath d='M864 810L889 832' opacity='0.22'/%3E%3Cpath d='M888 832L913 851' opacity='0.22'/%3E%3Cpath d='M912 851L937 864' opacity='0.23'/%3E%3Cpath d='M936 864L961 868' opacity='0.25'/%3E%3Cpath d='M960 868L985 863' opacity='0.29'/%3E%3Cpath d='M984 863L1009 851' opacity='0.36'/%3E%3Cpath d='M1008 851L1033 834' opacity='0.44'/%3E%3Cpath d='M1032 834L1057 816' opacity='0.52'/%3E%3Cpath d='M1056 816L1081 800' opacity='0.58'/%3E%3Cpath d='M1080 800L1105 787' opacity='0.62'/%3E%3Cpath d='M1104 787L1129 780' opacity='0.62'/%3E%3Cpath d='M1128 780L1153 775' opacity='0.61'/%3E%3Cpath d='M1152 775L1177 773' opacity='0.59'/%3E%3Cpath d='M1176 773L1201 770' opacity='0.56'/%3E%3Cpath d='M1200 770L1225 766' opacity='0.53'/%3E%3Cpath d='M1224 766L1249 760' opacity='0.51'/%3E%3Cpath d='M1248 760L1273 754' opacity='0.48'/%3E%3Cpath d='M1272 754L1297 748' opacity='0.46'/%3E%3Cpath d='M1296 748L1321 744' opacity='0.45'/%3E%3Cpath d='M1320 744L1345 742' opacity='0.45'/%3E%3Cpath d='M1344 742L1369 741' opacity='0.47'/%3E%3Cpath d='M1368 741L1393 741' opacity='0.49'/%3E%3Cpath d='M1392 741L1417 737' opacity='0.53'/%3E%3Cpath d='M1416 737L1441 730' opacity='0.57'/%3E%3Cpath d='M1440 730L1465 718' opacity='0.62'/%3E%3Cpath d='M1464 718L1489 702' opacity='0.66'/%3E%3Cpath d='M1488 702L1513 685' opacity='0.70'/%3E%3Cpath d='M1512 685L1537 671' opacity='0.72'/%3E%3Cpath d='M1536 671L1561 662' opacity='0.72'/%3E%3Cpath d='M1560 662L1585 662' opacity='0.70'/%3E%3Cpath d='M1584 662L1609 670' opacity='0.66'/%3E%3Cpath d='M1608 670L1633 686' opacity='0.60'/%3E%3Cpath d='M1632 686L1657 707' opacity='0.54'/%3E%3Cpath d='M1656 707L1681 729' opacity='0.49'/%3E%3Cpath d='M1680 729L1705 751' opacity='0.44'/%3E%3Cpath d='M1704 751L1729 769' opacity='0.40'/%3E%3Cpath d='M1728 769L1753 783' opacity='0.39'/%3E%3Cpath d='M1752 783L1777 794' opacity='0.38'/%3E%3Cpath d='M1776 794L1801 804' opacity='0.39'/%3E%3Cpath d='M1800 804L1825 812' opacity='0.42'/%3E%3Cpath d='M1824 812L1849 820' opacity='0.47'/%3E%3Cpath d='M1848 820L1873 827' opacity='0.52'/%3E%3Cpath d='M1872 827L1897 832' opacity='0.58'/%3E%3Cpath d='M1896 832L1921 834' opacity='0.64'/%3E%3Cpath d='M1920 834L1945 830' opacity='0.69'/%3E%3Cpath d='M1944 830L1969 822' opacity='0.73'/%3E%3Cpath d='M1968 822L1993 811' opacity='0.73'/%3E%3Cpath d='M1992 811L2017 799' opacity='0.71'/%3E%3Cpath d='M2016 799L2041 790' opacity='0.66'/%3E%3Cpath d='M2040 790L2065 785' opacity='0.60'/%3E%3Cpath d='M2064 785L2089 786' opacity='0.52'/%3E%3Cpath d='M2088 786L2113 792' opacity='0.45'/%3E%3Cpath d='M2112 792L2137 801' opacity='0.39'/%3E%3Cpath d='M2136 801L2161 810' opacity='0.35'/%3E%3Cpath d='M2160 810L2185 814' opacity='0.32'/%3E%3Cpath d='M2184 814L2209 813' opacity='0.32'/%3E%3Cpath d='M2208 813L2233 804' opacity='0.33'/%3E%3Cpath d='M2232 804L2257 790' opacity='0.36'/%3E%3Cpath d='M2256 790L2281 772' opacity='0.41'/%3E%3Cpath d='M2280 772L2305 752' opacity='0.47'/%3E%3Cpath d='M2304 752L2329 734' opacity='0.55'/%3E%3Cpath d='M2328 734L2353 719' opacity='0.63'/%3E%3Cpath d='M2352 719L2377 706' opacity='0.70'/%3E%3Cpath d='M2376 706L2401 696' opacity='0.75'/%3E%3C/g%3E%3C/defs%3E%3Cg fill='none' stroke='%2357ffbd' stroke-linecap='round'%3E%3Cuse href='%23hm' stroke-width='40' opacity='.06'/%3E%3Cuse href='%23hm' stroke-width='14' opacity='.12'/%3E%3C/g%3E%3C/svg%3E\") center / 100% 100% no-repeat;\ntransform-origin: 50% 80%;\nopacity: 0.9;\ntransition: opacity 3s ease;\nanimation: aur-au-sway 30s steps(900) infinite alternate;\n}\n.aur-root[data-fx=\"aurora\"][data-gap=\"on\"] .aur-fx-a { opacity: 1; }\n.aur-root[data-fx=\"aurora\"][data-bganim=\"on\"][data-lb=\"a\"] .aur-fx-a { animation: aur-au-sway 30s steps(900) infinite alternate, aur-au-flare-a 2.6s ease-out; }\n.aur-root[data-fx=\"aurora\"][data-bganim=\"on\"][data-lb=\"b\"] .aur-fx-a { animation: aur-au-sway 30s steps(900) infinite alternate, aur-au-flare-b 2.6s ease-out; }\n@keyframes aur-au-sway {\n0% { transform: translate3d(-2.5%, 0, 0) skewX(-5deg) scaleY(0.96); }\n50% { transform: translate3d(0.5%, -1%, 0) skewX(1deg) scaleY(1.04); }\n100% { transform: translate3d(3%, 0.5%, 0) skewX(5deg) scaleY(0.98); }\n}\n@keyframes aur-au-flare-a { from { opacity: 1; } }\n@keyframes aur-au-flare-b { from { opacity: 1; } }\n.aur-root[data-fx=\"aurora\"] .aur-fx-a::after {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2400 1000' preserveAspectRatio='none'%3E%3Cdefs%3E%3ClinearGradient id='c' gradientUnits='userSpaceOnUse' x1='0' y1='0' x2='0' y2='1000'%3E%3Cstop offset='0.181' stop-color='%23c455ff'/%3E%3Cstop offset='0.390' stop-color='%237f70ff'/%3E%3Cstop offset='0.626' stop-color='%2326e6b4'/%3E%3Cstop offset='0.807' stop-color='%2357ffbd'/%3E%3Cstop offset='0.876' stop-color='%23e4fff4'/%3E%3C/linearGradient%3E%3ClinearGradient id='g' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%23000'/%3E%3Cstop offset='.4' stop-color='%23fff' stop-opacity='.14'/%3E%3Cstop offset='.7' stop-color='%23fff' stop-opacity='.55'/%3E%3Cstop offset='.86' stop-color='%23fff'/%3E%3Cstop offset='.93' stop-color='%23fff' stop-opacity='.85'/%3E%3Cstop offset='1' stop-color='%23000'/%3E%3C/linearGradient%3E%3Cmask id='f' maskContentUnits='objectBoundingBox'%3E%3Crect width='1' height='1' fill='url(%23g)'/%3E%3C/mask%3E%3ClinearGradient id='s'%3E%3Cstop offset='0' stop-color='%23000'/%3E%3Cstop offset='.5' stop-color='%23fff'/%3E%3Cstop offset='1' stop-color='%23000'/%3E%3C/linearGradient%3E%3Cpattern id='r' width='1200' height='1000' patternUnits='userSpaceOnUse'%3E%3Cg fill='url(%23s)'%3E%3Crect x='0' width='6' height='1000' opacity='0.61'/%3E%3Crect x='6' width='8' height='1000' opacity='0.97'/%3E%3Crect x='19' width='17' height='1000' opacity='0.92'/%3E%3Crect x='51' width='20' height='1000' opacity='0.70'/%3E%3Crect x='92' width='19' height='1000' opacity='0.57'/%3E%3Crect x='122' width='7' height='1000' opacity='0.76'/%3E%3Crect x='135' width='8' height='1000' opacity='0.98'/%3E%3Crect x='148' width='8' height='1000' opacity='0.97'/%3E%3Crect x='163' width='8' height='1000' opacity='0.59'/%3E%3Crect x='174' width='12' height='1000' opacity='0.61'/%3E%3Crect x='191' width='22' height='1000' opacity='0.67'/%3E%3Crect x='221' width='9' height='1000' opacity='0.61'/%3E%3Crect x='238' width='18' height='1000' opacity='0.61'/%3E%3Crect x='257' width='6' height='1000' opacity='0.95'/%3E%3Crect x='265' width='11' height='1000' opacity='0.63'/%3E%3Crect x='276' width='6' height='1000' opacity='0.72'/%3E%3Crect x='283' width='36' height='1000' opacity='0.59'/%3E%3Crect x='353' width='18' height='1000' opacity='0.65'/%3E%3Crect x='388' width='19' height='1000' opacity='0.87'/%3E%3Crect x='409' width='17' height='1000' opacity='0.75'/%3E%3Crect x='445' width='9' height='1000' opacity='0.78'/%3E%3Crect x='463' width='19' height='1000' opacity='0.74'/%3E%3Crect x='487' width='20' height='1000' opacity='0.86'/%3E%3Crect x='519' width='17' height='1000' opacity='0.70'/%3E%3Crect x='539' width='4' height='1000' opacity='0.95'/%3E%3Crect x='546' width='26' height='1000' opacity='0.65'/%3E%3Crect x='596' width='19' height='1000' opacity='0.64'/%3E%3Crect x='624' width='40' height='1000' opacity='0.90'/%3E%3Crect x='681' width='18' height='1000' opacity='0.80'/%3E%3Crect x='712' width='20' height='1000' opacity='0.64'/%3E%3Crect x='730' width='5' height='1000' opacity='0.74'/%3E%3Crect x='736' width='21' height='1000' opacity='0.64'/%3E%3Crect x='758' width='14' height='1000' opacity='0.76'/%3E%3Crect x='772' width='36' height='1000' opacity='0.73'/%3E%3Crect x='829' width='13' height='1000' opacity='0.81'/%3E%3Crect x='855' width='20' height='1000' opacity='0.81'/%3E%3Crect x='887' width='40' height='1000' opacity='0.66'/%3E%3Crect x='945' width='13' height='1000' opacity='0.84'/%3E%3Crect x='956' width='12' height='1000' opacity='0.74'/%3E%3Crect x='969' width='9' height='1000' opacity='0.78'/%3E%3Crect x='983' width='20' height='1000' opacity='0.65'/%3E%3Crect x='1005' width='7' height='1000' opacity='0.80'/%3E%3Crect x='1013' width='32' height='1000' opacity='0.59'/%3E%3Crect x='1067' width='8' height='1000' opacity='0.56'/%3E%3Crect x='1080' width='6' height='1000' opacity='0.83'/%3E%3Crect x='1091' width='13' height='1000' opacity='0.91'/%3E%3Crect x='1109' width='20' height='1000' opacity='0.98'/%3E%3Crect x='1144' width='4' height='1000' opacity='0.90'/%3E%3Crect x='1153' width='7' height='1000' opacity='0.94'/%3E%3Crect x='1161' width='10' height='1000' opacity='0.69'/%3E%3Crect x='1171' width='6' height='1000' opacity='0.95'/%3E%3Crect x='1182' width='6' height='1000' opacity='0.57'/%3E%3Crect x='1189' width='8' height='1000' opacity='0.72'/%3E%3Crect x='1199' width='10' height='1000' opacity='0.88'/%3E%3C/g%3E%3C/pattern%3E%3Cmask id='rm' maskUnits='userSpaceOnUse' x='0' y='0' width='2400' height='1000'%3E%3Crect width='2400' height='1000' fill='url(%23r)'/%3E%3C/mask%3E%3Cg id='sl' fill='url(%23c)'%3E%3Cpath d='M0 863L25 864 25 432 0 431Z' opacity='0.76' mask='url(%23f)'/%3E%3Cpath d='M24 864L49 861 49 428 24 432Z' opacity='0.76' mask='url(%23f)'/%3E%3Cpath d='M48 861L73 854 73 419 48 428Z' opacity='0.76' mask='url(%23f)'/%3E%3Cpath d='M72 854L97 846 97 409 72 419Z' opacity='0.77' mask='url(%23f)'/%3E%3Cpath d='M96 846L121 837 121 398 96 409Z' opacity='0.77' mask='url(%23f)'/%3E%3Cpath d='M120 837L145 827 145 385 120 398Z' opacity='0.78' mask='url(%23f)'/%3E%3Cpath d='M144 827L169 816 169 370 144 385Z' opacity='0.78' mask='url(%23f)'/%3E%3Cpath d='M168 816L193 801 193 353 168 370Z' opacity='0.79' mask='url(%23f)'/%3E%3Cpath d='M192 801L217 783 217 332 192 353Z' opacity='0.79' mask='url(%23f)'/%3E%3Cpath d='M216 783L241 763 241 309 216 332Z' opacity='0.79' mask='url(%23f)'/%3E%3Cpath d='M240 763L265 742 265 286 240 309Z' opacity='0.78' mask='url(%23f)'/%3E%3Cpath d='M264 742L289 724 289 266 264 286Z' opacity='0.75' mask='url(%23f)'/%3E%3Cpath d='M288 724L313 711 313 252 288 266Z' opacity='0.71' mask='url(%23f)'/%3E%3Cpath d='M312 711L337 705 337 246 312 252Z' opacity='0.65' mask='url(%23f)'/%3E%3Cpath d='M336 705L361 707 361 247 336 246Z' opacity='0.59' mask='url(%23f)'/%3E%3Cpath d='M360 707L385 714 385 254 360 247Z' opacity='0.54' mask='url(%23f)'/%3E%3Cpath d='M384 714L409 725 409 264 384 254Z' opacity='0.50' mask='url(%23f)'/%3E%3Cpath d='M408 725L433 734 433 273 408 264Z' opacity='0.48' mask='url(%23f)'/%3E%3Cpath d='M432 734L457 741 457 278 432 273Z' opacity='0.47' mask='url(%23f)'/%3E%3Cpath d='M456 741L481 742 481 278 456 278Z' opacity='0.46' mask='url(%23f)'/%3E%3Cpath d='M480 742L505 737 505 272 480 278Z' opacity='0.45' mask='url(%23f)'/%3E%3Cpath d='M504 737L529 729 529 263 504 272Z' opacity='0.43' mask='url(%23f)'/%3E%3Cpath d='M528 729L553 720 553 252 528 263Z' opacity='0.40' mask='url(%23f)'/%3E%3Cpath d='M552 720L577 712 577 243 552 252Z' opacity='0.37' mask='url(%23f)'/%3E%3Cpath d='M576 712L601 708 601 238 576 243Z' opacity='0.35' mask='url(%23f)'/%3E%3Cpath d='M600 708L625 708 625 237 600 238Z' opacity='0.33' mask='url(%23f)'/%3E%3Cpath d='M624 708L649 712 649 240 624 237Z' opacity='0.32' mask='url(%23f)'/%3E%3Cpath d='M648 712L673 718 673 246 648 240Z' opacity='0.31' mask='url(%23f)'/%3E%3Cpath d='M672 718L697 726 697 254 672 246Z' opacity='0.31' mask='url(%23f)'/%3E%3Cpath d='M696 726L721 733 721 261 696 254Z' opacity='0.30' mask='url(%23f)'/%3E%3Cpath d='M720 733L745 741 745 267 720 261Z' opacity='0.28' mask='url(%23f)'/%3E%3Cpath d='M744 741L769 751 769 274 744 267Z' opacity='0.26' mask='url(%23f)'/%3E%3Cpath d='M768 751L793 762 793 283 768 274Z' opacity='0.25' mask='url(%23f)'/%3E%3Cpath d='M792 762L817 777 817 294 792 283Z' opacity='0.23' mask='url(%23f)'/%3E%3Cpath d='M816 777L841 797 841 310 816 294Z' opacity='0.22' mask='url(%23f)'/%3E%3Cpath d='M840 797L865 818 865 328 840 310Z' opacity='0.22' mask='url(%23f)'/%3E%3Cpath d='M864 818L889 840 889 346 864 328Z' opacity='0.22' mask='url(%23f)'/%3E%3Cpath d='M888 840L913 859 913 362 888 346Z' opacity='0.22' mask='url(%23f)'/%3E%3Cpath d='M912 859L937 872 937 371 912 362Z' opacity='0.23' mask='url(%23f)'/%3E%3Cpath d='M936 872L961 876 961 373 936 371Z' opacity='0.25' mask='url(%23f)'/%3E%3Cpath d='M960 876L985 871 985 366 960 373Z' opacity='0.29' mask='url(%23f)'/%3E%3Cpath d='M984 871L1009 859 1009 353 984 366Z' opacity='0.36' mask='url(%23f)'/%3E%3Cpath d='M1008 859L1033 842 1033 335 1008 353Z' opacity='0.44' mask='url(%23f)'/%3E%3Cpath d='M1032 842L1057 824 1057 318 1032 335Z' opacity='0.52' mask='url(%23f)'/%3E%3Cpath d='M1056 824L1081 808 1081 304 1056 318Z' opacity='0.58' mask='url(%23f)'/%3E%3Cpath d='M1080 808L1105 795 1105 294 1080 304Z' opacity='0.62' mask='url(%23f)'/%3E%3Cpath d='M1104 795L1129 788 1129 290 1104 294Z' opacity='0.62' mask='url(%23f)'/%3E%3Cpath d='M1128 788L1153 783 1153 290 1128 290Z' opacity='0.61' mask='url(%23f)'/%3E%3Cpath d='M1152 783L1177 781 1177 293 1152 290Z' opacity='0.59' mask='url(%23f)'/%3E%3Cpath d='M1176 781L1201 778 1201 295 1176 293Z' opacity='0.56' mask='url(%23f)'/%3E%3Cpath d='M1200 778L1225 774 1225 296 1200 295Z' opacity='0.53' mask='url(%23f)'/%3E%3Cpath d='M1224 774L1249 768 1249 295 1224 296Z' opacity='0.51' mask='url(%23f)'/%3E%3Cpath d='M1248 768L1273 762 1273 293 1248 295Z' opacity='0.48' mask='url(%23f)'/%3E%3Cpath d='M1272 762L1297 756 1297 291 1272 293Z' opacity='0.46' mask='url(%23f)'/%3E%3Cpath d='M1296 756L1321 752 1321 290 1296 291Z' opacity='0.45' mask='url(%23f)'/%3E%3Cpath d='M1320 752L1345 750 1345 290 1320 290Z' opacity='0.45' mask='url(%23f)'/%3E%3Cpath d='M1344 750L1369 749 1369 290 1344 290Z' opacity='0.47' mask='url(%23f)'/%3E%3Cpath d='M1368 749L1393 749 1393 289 1368 290Z' opacity='0.49' mask='url(%23f)'/%3E%3Cpath d='M1392 749L1417 745 1417 284 1392 289Z' opacity='0.53' mask='url(%23f)'/%3E%3Cpath d='M1416 745L1441 738 1441 274 1416 284Z' opacity='0.57' mask='url(%23f)'/%3E%3Cpath d='M1440 738L1465 726 1465 259 1440 274Z' opacity='0.62' mask='url(%23f)'/%3E%3Cpath d='M1464 726L1489 710 1489 240 1464 259Z' opacity='0.66' mask='url(%23f)'/%3E%3Cpath d='M1488 710L1513 693 1513 219 1488 240Z' opacity='0.70' mask='url(%23f)'/%3E%3Cpath d='M1512 693L1537 679 1537 200 1512 219Z' opacity='0.72' mask='url(%23f)'/%3E%3Cpath d='M1536 679L1561 670 1561 186 1536 200Z' opacity='0.72' mask='url(%23f)'/%3E%3Cpath d='M1560 670L1585 670 1585 181 1560 186Z' opacity='0.70' mask='url(%23f)'/%3E%3Cpath d='M1584 670L1609 678 1609 186 1584 181Z' opacity='0.66' mask='url(%23f)'/%3E%3Cpath d='M1608 678L1633 694 1633 198 1608 186Z' opacity='0.60' mask='url(%23f)'/%3E%3Cpath d='M1632 694L1657 715 1657 216 1632 198Z' opacity='0.54' mask='url(%23f)'/%3E%3Cpath d='M1656 715L1681 737 1681 237 1656 216Z' opacity='0.49' mask='url(%23f)'/%3E%3Cpath d='M1680 737L1705 759 1705 257 1680 237Z' opacity='0.44' mask='url(%23f)'/%3E%3Cpath d='M1704 759L1729 777 1729 276 1704 257Z' opacity='0.40' mask='url(%23f)'/%3E%3Cpath d='M1728 777L1753 791 1753 296 1728 276Z' opacity='0.39' mask='url(%23f)'/%3E%3Cpath d='M1752 791L1777 802 1777 317 1752 296Z' opacity='0.38' mask='url(%23f)'/%3E%3Cpath d='M1776 802L1801 812 1801 340 1776 317Z' opacity='0.39' mask='url(%23f)'/%3E%3Cpath d='M1800 812L1825 820 1825 367 1800 340Z' opacity='0.42' mask='url(%23f)'/%3E%3Cpath d='M1824 820L1849 828 1849 396 1824 367Z' opacity='0.47' mask='url(%23f)'/%3E%3Cpath d='M1848 828L1873 835 1873 425 1848 396Z' opacity='0.52' mask='url(%23f)'/%3E%3Cpath d='M1872 835L1897 840 1897 453 1872 425Z' opacity='0.58' mask='url(%23f)'/%3E%3Cpath d='M1896 840L1921 842 1921 477 1896 453Z' opacity='0.64' mask='url(%23f)'/%3E%3Cpath d='M1920 842L1945 838 1945 494 1920 477Z' opacity='0.69' mask='url(%23f)'/%3E%3Cpath d='M1944 838L1969 830 1969 504 1944 494Z' opacity='0.73' mask='url(%23f)'/%3E%3Cpath d='M1968 830L1993 819 1993 508 1968 504Z' opacity='0.73' mask='url(%23f)'/%3E%3Cpath d='M1992 819L2017 807 2017 507 1992 508Z' opacity='0.71' mask='url(%23f)'/%3E%3Cpath d='M2016 807L2041 798 2041 504 2016 507Z' opacity='0.66' mask='url(%23f)'/%3E%3Cpath d='M2040 798L2065 793 2065 500 2040 504Z' opacity='0.60' mask='url(%23f)'/%3E%3Cpath d='M2064 793L2089 794 2089 499 2064 500Z' opacity='0.52' mask='url(%23f)'/%3E%3Cpath d='M2088 794L2113 800 2113 501 2088 499Z' opacity='0.45' mask='url(%23f)'/%3E%3Cpath d='M2112 800L2137 809 2137 504 2112 501Z' opacity='0.39' mask='url(%23f)'/%3E%3Cpath d='M2136 809L2161 818 2161 504 2136 504Z' opacity='0.35' mask='url(%23f)'/%3E%3Cpath d='M2160 818L2185 822 2185 499 2160 504Z' opacity='0.32' mask='url(%23f)'/%3E%3Cpath d='M2184 822L2209 821 2209 487 2184 499Z' opacity='0.32' mask='url(%23f)'/%3E%3Cpath d='M2208 821L2233 812 2233 467 2208 487Z' opacity='0.33' mask='url(%23f)'/%3E%3Cpath d='M2232 812L2257 798 2257 441 2232 467Z' opacity='0.36' mask='url(%23f)'/%3E%3Cpath d='M2256 798L2281 780 2281 413 2256 441Z' opacity='0.41' mask='url(%23f)'/%3E%3Cpath d='M2280 780L2305 760 2305 384 2280 413Z' opacity='0.47' mask='url(%23f)'/%3E%3Cpath d='M2304 760L2329 742 2329 358 2304 384Z' opacity='0.55' mask='url(%23f)'/%3E%3Cpath d='M2328 742L2353 727 2353 337 2328 358Z' opacity='0.63' mask='url(%23f)'/%3E%3Cpath d='M2352 727L2377 714 2377 321 2352 337Z' opacity='0.70' mask='url(%23f)'/%3E%3Cpath d='M2376 714L2401 704 2401 309 2376 321Z' opacity='0.75' mask='url(%23f)'/%3E%3C/g%3E%3C/defs%3E%3Cg mask='url(%23rm)'%3E%3Cuse href='%23sl'/%3E%3C/g%3E%3C/svg%3E\") center / 100% 100% no-repeat;\nopacity: 0;\nanimation: aur-au-shimmer 6.5s steps(78) infinite alternate;\n}\n@keyframes aur-au-shimmer { to { opacity: 0.85; } }\n.aur-root[data-fx=\"aurora\"] .aur-fx-b {\ndisplay: block;\nleft: -10%;\nright: -10%;\ntop: -8%;\nheight: 70%;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2400 1000' preserveAspectRatio='none'%3E%3Cdefs%3E%3ClinearGradient id='c' gradientUnits='userSpaceOnUse' x1='0' y1='0' x2='0' y2='1000'%3E%3Cstop offset='0.096' stop-color='%23d05cff'/%3E%3Cstop offset='0.249' stop-color='%238467ff'/%3E%3Cstop offset='0.423' stop-color='%232aa6d8'/%3E%3Cstop offset='0.556' stop-color='%233fe6c8'/%3E%3Cstop offset='0.607' stop-color='%23b8fff0'/%3E%3C/linearGradient%3E%3ClinearGradient id='g' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%23000'/%3E%3Cstop offset='.4' stop-color='%23fff' stop-opacity='.14'/%3E%3Cstop offset='.7' stop-color='%23fff' stop-opacity='.55'/%3E%3Cstop offset='.86' stop-color='%23fff'/%3E%3Cstop offset='.93' stop-color='%23fff' stop-opacity='.85'/%3E%3Cstop offset='1' stop-color='%23000'/%3E%3C/linearGradient%3E%3Cmask id='f' maskContentUnits='objectBoundingBox'%3E%3Crect width='1' height='1' fill='url(%23g)'/%3E%3C/mask%3E%3ClinearGradient id='s'%3E%3Cstop offset='0' stop-color='%23000'/%3E%3Cstop offset='.5' stop-color='%23fff'/%3E%3Cstop offset='1' stop-color='%23000'/%3E%3C/linearGradient%3E%3Cpattern id='r' width='1200' height='1000' patternUnits='userSpaceOnUse'%3E%3Cg fill='url(%23s)'%3E%3Crect x='0' width='21' height='1000' opacity='0.79'/%3E%3Crect x='22' width='34' height='1000' opacity='0.78'/%3E%3Crect x='78' width='10' height='1000' opacity='0.90'/%3E%3Crect x='98' width='4' height='1000' opacity='0.65'/%3E%3Crect x='104' width='22' height='1000' opacity='0.56'/%3E%3Crect x='149' width='6' height='1000' opacity='0.84'/%3E%3Crect x='157' width='24' height='1000' opacity='0.74'/%3E%3Crect x='203' width='22' height='1000' opacity='0.72'/%3E%3Crect x='234' width='18' height='1000' opacity='0.80'/%3E%3Crect x='267' width='4' height='1000' opacity='0.93'/%3E%3Crect x='272' width='9' height='1000' opacity='0.81'/%3E%3Crect x='280' width='5' height='1000' opacity='0.86'/%3E%3Crect x='286' width='31' height='1000' opacity='0.86'/%3E%3Crect x='326' width='7' height='1000' opacity='0.62'/%3E%3Crect x='332' width='39' height='1000' opacity='0.76'/%3E%3Crect x='394' width='8' height='1000' opacity='0.57'/%3E%3Crect x='412' width='5' height='1000' opacity='0.82'/%3E%3Crect x='416' width='4' height='1000' opacity='0.91'/%3E%3Crect x='421' width='31' height='1000' opacity='0.73'/%3E%3Crect x='453' width='10' height='1000' opacity='0.93'/%3E%3Crect x='468' width='6' height='1000' opacity='0.78'/%3E%3Crect x='479' width='8' height='1000' opacity='0.73'/%3E%3Crect x='489' width='27' height='1000' opacity='0.77'/%3E%3Crect x='514' width='9' height='1000' opacity='0.65'/%3E%3Crect x='524' width='39' height='1000' opacity='0.88'/%3E%3Crect x='567' width='15' height='1000' opacity='0.77'/%3E%3Crect x='583' width='8' height='1000' opacity='0.80'/%3E%3Crect x='593' width='27' height='1000' opacity='0.87'/%3E%3Crect x='628' width='23' height='1000' opacity='0.68'/%3E%3Crect x='670' width='19' height='1000' opacity='0.98'/%3E%3Crect x='689' width='23' height='1000' opacity='0.68'/%3E%3Crect x='737' width='26' height='1000' opacity='0.56'/%3E%3Crect x='783' width='9' height='1000' opacity='0.89'/%3E%3Crect x='796' width='34' height='1000' opacity='1.00'/%3E%3Crect x='857' width='19' height='1000' opacity='0.86'/%3E%3Crect x='897' width='18' height='1000' opacity='0.73'/%3E%3Crect x='933' width='26' height='1000' opacity='0.67'/%3E%3Crect x='959' width='17' height='1000' opacity='0.65'/%3E%3Crect x='978' width='21' height='1000' opacity='0.85'/%3E%3Crect x='1006' width='17' height='1000' opacity='0.76'/%3E%3Crect x='1030' width='18' height='1000' opacity='0.77'/%3E%3Crect x='1050' width='30' height='1000' opacity='0.91'/%3E%3Crect x='1104' width='31' height='1000' opacity='0.76'/%3E%3Crect x='1137' width='16' height='1000' opacity='0.78'/%3E%3Crect x='1157' width='8' height='1000' opacity='0.80'/%3E%3Crect x='1167' width='40' height='1000' opacity='0.96'/%3E%3C/g%3E%3C/pattern%3E%3Cmask id='rm' maskUnits='userSpaceOnUse' x='0' y='0' width='2400' height='1000'%3E%3Crect width='2400' height='1000' fill='url(%23r)'/%3E%3C/mask%3E%3Cg id='sl' fill='url(%23c)'%3E%3Cpath d='M0 444L31 440 31 96 0 99Z' opacity='0.26' mask='url(%23f)'/%3E%3Cpath d='M30 440L61 441 61 99 30 96Z' opacity='0.27' mask='url(%23f)'/%3E%3Cpath d='M60 441L91 449 91 110 60 99Z' opacity='0.31' mask='url(%23f)'/%3E%3Cpath d='M90 449L121 462 121 127 90 110Z' opacity='0.37' mask='url(%23f)'/%3E%3Cpath d='M120 462L151 478 151 147 120 127Z' opacity='0.45' mask='url(%23f)'/%3E%3Cpath d='M150 478L181 493 181 168 150 147Z' opacity='0.54' mask='url(%23f)'/%3E%3Cpath d='M180 493L211 507 211 186 180 168Z' opacity='0.61' mask='url(%23f)'/%3E%3Cpath d='M210 507L241 515 241 199 210 186Z' opacity='0.65' mask='url(%23f)'/%3E%3Cpath d='M240 515L271 519 271 206 240 199Z' opacity='0.65' mask='url(%23f)'/%3E%3Cpath d='M270 519L301 518 301 207 270 206Z' opacity='0.64' mask='url(%23f)'/%3E%3Cpath d='M300 518L331 514 331 205 300 207Z' opacity='0.63' mask='url(%23f)'/%3E%3Cpath d='M330 514L361 510 361 201 330 205Z' opacity='0.62' mask='url(%23f)'/%3E%3Cpath d='M360 510L391 508 391 198 360 201Z' opacity='0.61' mask='url(%23f)'/%3E%3Cpath d='M390 508L421 510 421 199 390 198Z' opacity='0.60' mask='url(%23f)'/%3E%3Cpath d='M420 510L451 515 451 203 420 199Z' opacity='0.60' mask='url(%23f)'/%3E%3Cpath d='M450 515L481 524 481 210 450 203Z' opacity='0.60' mask='url(%23f)'/%3E%3Cpath d='M480 524L511 534 511 219 480 210Z' opacity='0.58' mask='url(%23f)'/%3E%3Cpath d='M510 534L541 545 541 228 510 219Z' opacity='0.56' mask='url(%23f)'/%3E%3Cpath d='M540 545L571 555 571 236 540 228Z' opacity='0.53' mask='url(%23f)'/%3E%3Cpath d='M570 555L601 563 601 243 570 236Z' opacity='0.50' mask='url(%23f)'/%3E%3Cpath d='M600 563L631 570 631 248 600 243Z' opacity='0.48' mask='url(%23f)'/%3E%3Cpath d='M630 570L661 575 661 254 630 248Z' opacity='0.46' mask='url(%23f)'/%3E%3Cpath d='M660 575L691 581 691 259 660 254Z' opacity='0.46' mask='url(%23f)'/%3E%3Cpath d='M690 581L721 586 721 263 690 259Z' opacity='0.45' mask='url(%23f)'/%3E%3Cpath d='M720 586L751 590 751 266 720 263Z' opacity='0.42' mask='url(%23f)'/%3E%3Cpath d='M750 590L781 593 781 267 750 266Z' opacity='0.38' mask='url(%23f)'/%3E%3Cpath d='M780 593L811 591 811 263 780 267Z' opacity='0.34' mask='url(%23f)'/%3E%3Cpath d='M810 591L841 585 841 253 810 263Z' opacity='0.31' mask='url(%23f)'/%3E%3Cpath d='M840 585L871 573 871 238 840 253Z' opacity='0.29' mask='url(%23f)'/%3E%3Cpath d='M870 573L901 556 901 218 870 238Z' opacity='0.29' mask='url(%23f)'/%3E%3Cpath d='M900 556L931 535 931 194 900 218Z' opacity='0.30' mask='url(%23f)'/%3E%3Cpath d='M930 535L961 513 961 171 930 194Z' opacity='0.34' mask='url(%23f)'/%3E%3Cpath d='M960 513L991 493 991 150 960 171Z' opacity='0.41' mask='url(%23f)'/%3E%3Cpath d='M990 493L1021 478 1021 134 990 150Z' opacity='0.51' mask='url(%23f)'/%3E%3Cpath d='M1020 478L1051 470 1051 126 1020 134Z' opacity='0.62' mask='url(%23f)'/%3E%3Cpath d='M1050 470L1081 467 1081 128 1050 126Z' opacity='0.71' mask='url(%23f)'/%3E%3Cpath d='M1080 467L1111 470 1111 139 1080 128Z' opacity='0.75' mask='url(%23f)'/%3E%3Cpath d='M1110 470L1141 476 1141 156 1110 139Z' opacity='0.76' mask='url(%23f)'/%3E%3Cpath d='M1140 476L1171 482 1171 176 1140 156Z' opacity='0.76' mask='url(%23f)'/%3E%3Cpath d='M1170 482L1201 487 1201 195 1170 176Z' opacity='0.76' mask='url(%23f)'/%3E%3Cpath d='M1200 487L1231 489 1231 211 1200 195Z' opacity='0.77' mask='url(%23f)'/%3E%3Cpath d='M1230 489L1261 489 1261 224 1230 211Z' opacity='0.77' mask='url(%23f)'/%3E%3Cpath d='M1260 489L1291 486 1291 232 1260 224Z' opacity='0.77' mask='url(%23f)'/%3E%3Cpath d='M1290 486L1321 482 1321 236 1290 232Z' opacity='0.77' mask='url(%23f)'/%3E%3Cpath d='M1320 482L1351 480 1351 238 1320 236Z' opacity='0.77' mask='url(%23f)'/%3E%3Cpath d='M1350 480L1381 478 1381 238 1350 238Z' opacity='0.75' mask='url(%23f)'/%3E%3Cpath d='M1380 478L1411 479 1411 237 1380 238Z' opacity='0.70' mask='url(%23f)'/%3E%3Cpath d='M1410 479L1441 481 1441 235 1410 237Z' opacity='0.64' mask='url(%23f)'/%3E%3Cpath d='M1440 481L1471 483 1471 232 1440 235Z' opacity='0.58' mask='url(%23f)'/%3E%3Cpath d='M1470 483L1501 486 1501 227 1470 232Z' opacity='0.53' mask='url(%23f)'/%3E%3Cpath d='M1500 486L1531 488 1531 221 1500 227Z' opacity='0.50' mask='url(%23f)'/%3E%3Cpath d='M1530 488L1561 490 1561 215 1530 221Z' opacity='0.49' mask='url(%23f)'/%3E%3Cpath d='M1560 490L1591 494 1591 211 1560 215Z' opacity='0.49' mask='url(%23f)'/%3E%3Cpath d='M1590 494L1621 502 1621 211 1590 211Z' opacity='0.49' mask='url(%23f)'/%3E%3Cpath d='M1620 502L1651 513 1651 217 1620 211Z' opacity='0.49' mask='url(%23f)'/%3E%3Cpath d='M1650 513L1681 528 1681 229 1650 217Z' opacity='0.48' mask='url(%23f)'/%3E%3Cpath d='M1680 528L1711 547 1711 246 1680 229Z' opacity='0.48' mask='url(%23f)'/%3E%3Cpath d='M1710 547L1741 567 1741 265 1710 246Z' opacity='0.48' mask='url(%23f)'/%3E%3Cpath d='M1740 567L1771 585 1771 282 1740 265Z' opacity='0.48' mask='url(%23f)'/%3E%3Cpath d='M1770 585L1801 599 1801 292 1770 282Z' opacity='0.47' mask='url(%23f)'/%3E%3Cpath d='M1800 599L1831 607 1831 295 1800 292Z' opacity='0.45' mask='url(%23f)'/%3E%3Cpath d='M1830 607L1861 607 1861 289 1830 295Z' opacity='0.41' mask='url(%23f)'/%3E%3Cpath d='M1860 607L1891 600 1891 276 1860 289Z' opacity='0.37' mask='url(%23f)'/%3E%3Cpath d='M1890 600L1921 587 1921 258 1890 276Z' opacity='0.34' mask='url(%23f)'/%3E%3Cpath d='M1920 587L1951 573 1951 238 1920 258Z' opacity='0.31' mask='url(%23f)'/%3E%3Cpath d='M1950 573L1981 558 1981 219 1950 238Z' opacity='0.30' mask='url(%23f)'/%3E%3Cpath d='M1980 558L2011 546 2011 203 1980 219Z' opacity='0.30' mask='url(%23f)'/%3E%3Cpath d='M2010 546L2041 537 2041 193 2010 203Z' opacity='0.28' mask='url(%23f)'/%3E%3Cpath d='M2040 537L2071 531 2071 186 2040 193Z' opacity='0.27' mask='url(%23f)'/%3E%3Cpath d='M2070 531L2101 527 2101 183 2070 186Z' opacity='0.25' mask='url(%23f)'/%3E%3Cpath d='M2100 527L2131 524 2131 180 2100 183Z' opacity='0.23' mask='url(%23f)'/%3E%3Cpath d='M2130 524L2161 520 2161 177 2130 180Z' opacity='0.22' mask='url(%23f)'/%3E%3Cpath d='M2160 520L2191 516 2191 173 2160 177Z' opacity='0.22' mask='url(%23f)'/%3E%3Cpath d='M2190 516L2221 511 2221 169 2190 173Z' opacity='0.22' mask='url(%23f)'/%3E%3Cpath d='M2220 511L2251 506 2251 165 2220 169Z' opacity='0.22' mask='url(%23f)'/%3E%3Cpath d='M2250 506L2281 503 2281 162 2250 165Z' opacity='0.24' mask='url(%23f)'/%3E%3Cpath d='M2280 503L2311 500 2311 160 2280 162Z' opacity='0.26' mask='url(%23f)'/%3E%3Cpath d='M2310 500L2341 499 2341 159 2310 160Z' opacity='0.30' mask='url(%23f)'/%3E%3Cpath d='M2340 499L2371 498 2371 159 2340 159Z' opacity='0.34' mask='url(%23f)'/%3E%3Cpath d='M2370 498L2401 496 2401 157 2370 159Z' opacity='0.37' mask='url(%23f)'/%3E%3C/g%3E%3C/defs%3E%3Cuse href='%23sl' opacity='.17'/%3E%3Cg mask='url(%23rm)'%3E%3Cuse href='%23sl'/%3E%3C/g%3E%3Cdefs%3E%3Cg id='hm'%3E%3Cpath d='M0 436L31 432' opacity='0.26'/%3E%3Cpath d='M30 432L61 433' opacity='0.27'/%3E%3Cpath d='M60 433L91 441' opacity='0.31'/%3E%3Cpath d='M90 441L121 454' opacity='0.37'/%3E%3Cpath d='M120 454L151 470' opacity='0.45'/%3E%3Cpath d='M150 470L181 485' opacity='0.54'/%3E%3Cpath d='M180 485L211 499' opacity='0.61'/%3E%3Cpath d='M210 499L241 507' opacity='0.65'/%3E%3Cpath d='M240 507L271 511' opacity='0.65'/%3E%3Cpath d='M270 511L301 510' opacity='0.64'/%3E%3Cpath d='M300 510L331 506' opacity='0.63'/%3E%3Cpath d='M330 506L361 502' opacity='0.62'/%3E%3Cpath d='M360 502L391 500' opacity='0.61'/%3E%3Cpath d='M390 500L421 502' opacity='0.60'/%3E%3Cpath d='M420 502L451 507' opacity='0.60'/%3E%3Cpath d='M450 507L481 516' opacity='0.60'/%3E%3Cpath d='M480 516L511 526' opacity='0.58'/%3E%3Cpath d='M510 526L541 537' opacity='0.56'/%3E%3Cpath d='M540 537L571 547' opacity='0.53'/%3E%3Cpath d='M570 547L601 555' opacity='0.50'/%3E%3Cpath d='M600 555L631 562' opacity='0.48'/%3E%3Cpath d='M630 562L661 567' opacity='0.46'/%3E%3Cpath d='M660 567L691 573' opacity='0.46'/%3E%3Cpath d='M690 573L721 578' opacity='0.45'/%3E%3Cpath d='M720 578L751 582' opacity='0.42'/%3E%3Cpath d='M750 582L781 585' opacity='0.38'/%3E%3Cpath d='M780 585L811 583' opacity='0.34'/%3E%3Cpath d='M810 583L841 577' opacity='0.31'/%3E%3Cpath d='M840 577L871 565' opacity='0.29'/%3E%3Cpath d='M870 565L901 548' opacity='0.29'/%3E%3Cpath d='M900 548L931 527' opacity='0.30'/%3E%3Cpath d='M930 527L961 505' opacity='0.34'/%3E%3Cpath d='M960 505L991 485' opacity='0.41'/%3E%3Cpath d='M990 485L1021 470' opacity='0.51'/%3E%3Cpath d='M1020 470L1051 462' opacity='0.62'/%3E%3Cpath d='M1050 462L1081 459' opacity='0.71'/%3E%3Cpath d='M1080 459L1111 462' opacity='0.75'/%3E%3Cpath d='M1110 462L1141 468' opacity='0.76'/%3E%3Cpath d='M1140 468L1171 474' opacity='0.76'/%3E%3Cpath d='M1170 474L1201 479' opacity='0.76'/%3E%3Cpath d='M1200 479L1231 481' opacity='0.77'/%3E%3Cpath d='M1230 481L1261 481' opacity='0.77'/%3E%3Cpath d='M1260 481L1291 478' opacity='0.77'/%3E%3Cpath d='M1290 478L1321 474' opacity='0.77'/%3E%3Cpath d='M1320 474L1351 472' opacity='0.77'/%3E%3Cpath d='M1350 472L1381 470' opacity='0.75'/%3E%3Cpath d='M1380 470L1411 471' opacity='0.70'/%3E%3Cpath d='M1410 471L1441 473' opacity='0.64'/%3E%3Cpath d='M1440 473L1471 475' opacity='0.58'/%3E%3Cpath d='M1470 475L1501 478' opacity='0.53'/%3E%3Cpath d='M1500 478L1531 480' opacity='0.50'/%3E%3Cpath d='M1530 480L1561 482' opacity='0.49'/%3E%3Cpath d='M1560 482L1591 486' opacity='0.49'/%3E%3Cpath d='M1590 486L1621 494' opacity='0.49'/%3E%3Cpath d='M1620 494L1651 505' opacity='0.49'/%3E%3Cpath d='M1650 505L1681 520' opacity='0.48'/%3E%3Cpath d='M1680 520L1711 539' opacity='0.48'/%3E%3Cpath d='M1710 539L1741 559' opacity='0.48'/%3E%3Cpath d='M1740 559L1771 577' opacity='0.48'/%3E%3Cpath d='M1770 577L1801 591' opacity='0.47'/%3E%3Cpath d='M1800 591L1831 599' opacity='0.45'/%3E%3Cpath d='M1830 599L1861 599' opacity='0.41'/%3E%3Cpath d='M1860 599L1891 592' opacity='0.37'/%3E%3Cpath d='M1890 592L1921 579' opacity='0.34'/%3E%3Cpath d='M1920 579L1951 565' opacity='0.31'/%3E%3Cpath d='M1950 565L1981 550' opacity='0.30'/%3E%3Cpath d='M1980 550L2011 538' opacity='0.30'/%3E%3Cpath d='M2010 538L2041 529' opacity='0.28'/%3E%3Cpath d='M2040 529L2071 523' opacity='0.27'/%3E%3Cpath d='M2070 523L2101 519' opacity='0.25'/%3E%3Cpath d='M2100 519L2131 516' opacity='0.23'/%3E%3Cpath d='M2130 516L2161 512' opacity='0.22'/%3E%3Cpath d='M2160 512L2191 508' opacity='0.22'/%3E%3Cpath d='M2190 508L2221 503' opacity='0.22'/%3E%3Cpath d='M2220 503L2251 498' opacity='0.22'/%3E%3Cpath d='M2250 498L2281 495' opacity='0.24'/%3E%3Cpath d='M2280 495L2311 492' opacity='0.26'/%3E%3Cpath d='M2310 492L2341 491' opacity='0.30'/%3E%3Cpath d='M2340 491L2371 490' opacity='0.34'/%3E%3Cpath d='M2370 490L2401 488' opacity='0.37'/%3E%3C/g%3E%3C/defs%3E%3Cg fill='none' stroke='%233fe6c8' stroke-linecap='round'%3E%3Cuse href='%23hm' stroke-width='40' opacity='.06'/%3E%3Cuse href='%23hm' stroke-width='14' opacity='.12'/%3E%3C/g%3E%3C/svg%3E\") center / 100% 100% no-repeat;\ntransform-origin: 50% 60%;\nopacity: 0.55;\ntransition: opacity 3s ease;\nanimation: aur-au-sway 41s steps(1230) infinite alternate-reverse;\n}\n.aur-root[data-fx=\"aurora\"][data-gap=\"on\"] .aur-fx-b { opacity: 0.68; }\n.aur-root[data-fx=\"aurora\"] .aur-fx-c {\ndisplay: block;\nleft: 0;\nright: 0;\nbottom: 0;\nheight: 13vh;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2400 200' preserveAspectRatio='none'%3E%3ClinearGradient id='h' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='.35' stop-color='%230a1418'/%3E%3Cstop offset='1' stop-color='%23040709'/%3E%3C/linearGradient%3E%3Cpath d='M0 200 1 121 13 76 25 121 24 112 38 107 44 113 54 67 65 113 59 120 73 69 87 120 84 125 98 116 115 120 121 128 135 74 149 128 152 134 158 110 164 134 182 133 187 133 196 100 205 133 214 141 237 147 256 141 280 148 300 143 301 139 318 84 335 139 323 145 329 120 335 145 340 151 350 106 360 151 370 148 394 148 408 141 408 135 419 91 429 135 412 142 429 82 447 142 432 141 444 95 457 141 462 143 479 142 493 139 500 140 510 103 520 140 520 142 519 144 531 96 543 144 545 148 551 128 557 148 564 144 575 100 585 144 579 140 590 96 600 140 593 145 605 102 617 145 619 140 621 135 633 86 644 135 647 132 654 138 663 105 672 138 679 137 686 114 692 137 698 143 711 139 724 144 730 120 736 144 742 140 751 104 760 140 761 148 767 129 772 148 771 156 789 97 807 156 802 161 814 161 821 128 829 161 820 163 832 109 844 163 855 166 878 170 879 170 888 139 896 170 905 168 909 166 924 110 938 166 933 163 945 121 956 163 957 168 965 170 978 124 991 170 979 166 989 125 999 166 1001 170 1006 150 1010 170 1017 162 1032 155 1039 123 1047 155 1054 157 1063 152 1069 128 1075 152 1083 150 1089 124 1096 150 1093 155 1108 102 1122 155 1111 153 1124 104 1136 153 1132 152 1144 110 1155 152 1138 150 1155 94 1171 150 1170 158 1169 157 1183 103 1198 157 1206 162 1216 163 1226 120 1236 163 1233 168 1238 146 1243 168 1248 163 1260 108 1273 163 1282 166 1306 167 1305 170 1316 121 1327 170 1328 170 1337 138 1345 170 1350 165 1358 136 1366 165 1370 163 1379 128 1388 163 1379 156 1395 95 1410 156 1415 150 1425 153 1436 114 1446 153 1443 147 1458 96 1473 147 1475 146 1477 141 1488 98 1499 141 1501 145 1501 149 1515 93 1530 149 1519 143 1529 104 1539 143 1530 141 1542 89 1554 141 1566 141 1582 147 1600 146 1622 145 1637 144 1645 116 1653 144 1665 152 1671 147 1678 120 1685 147 1686 154 1700 98 1714 154 1710 158 1716 136 1722 158 1730 155 1740 146 1750 109 1759 146 1763 148 1770 149 1778 119 1786 149 1790 156 1786 164 1801 112 1816 164 1815 167 1836 163 1854 166 1860 143 1866 166 1875 170 1893 164 1912 158 1931 151 1943 148 1961 149 1972 146 1977 125 1983 146 1998 147 2000 143 2013 86 2026 143 2030 138 2033 135 2045 93 2057 135 2053 141 2060 111 2067 141 2072 146 2070 141 2084 90 2099 141 2096 142 2105 107 2113 142 2114 144 2122 115 2130 144 2132 149 2156 147 2174 149 2194 146 2210 148 2220 152 2230 153 2237 126 2244 153 2248 153 2264 154 2286 147 2299 139 2305 111 2312 139 2307 147 2323 91 2338 147 2335 154 2358 157 2372 163 2394 162 2406 155 2411 133 2416 155 2400 200Z' fill='url(%23h)'/%3E%3C/svg%3E\") center bottom / 100% 100% no-repeat;\nopacity: 0.92;\n}\n.aur-root[data-fx=\"neon\"] :is(.aur-fx-a, .aur-fx-b) {\n--tube: #ff2fb3;\ndisplay: block;\ninset: 18px;\nborder-radius: 22px;\nborder: 2px solid color-mix(in oklab, var(--tube) 35%, #fff);\nbox-shadow:\n0 0 6px 1px var(--tube),\n0 0 26px 3px color-mix(in oklab, var(--tube) 60%, transparent),\ninset 0 0 6px 1px var(--tube),\ninset 0 0 40px 2px color-mix(in oklab, var(--tube) 30%, transparent);\nopacity: 0.8;\nanimation: aur-fx-ignite 1.6s linear both, aur-fx-stutter 11s linear 1.6s infinite;\n}\n.aur-root[data-fx=\"neon\"] .aur-fx-a { --tube: color-mix(in oklab, var(--aur-accent) 45%, #ff2fb3); }\n.aur-root[data-fx=\"neon\"] .aur-fx-b {\n--tube: #22d3ee;\ninset: 30px;\nborder-radius: 14px;\nborder-width: 1.5px;\nopacity: 0.6;\nanimation: aur-fx-ignite 1.9s linear 0.25s both, aur-fx-stutter 17s linear 3s infinite reverse;\n}\n.aur-root[data-fx=\"neon\"][data-bganim=\"on\"][data-lb=\"a\"] .aur-fx-a { animation: aur-fx-ignite 1.6s linear both, aur-fx-stutter 11s linear 1.6s infinite, aur-fx-buzz-a 0.32s steps(1); }\n.aur-root[data-fx=\"neon\"][data-bganim=\"on\"][data-lb=\"b\"] .aur-fx-a { animation: aur-fx-ignite 1.6s linear both, aur-fx-stutter 11s linear 1.6s infinite, aur-fx-buzz-b 0.32s steps(1); }\n@keyframes aur-fx-ignite {\n0%, 8%, 16%, 30%, 46% { opacity: 0.05; }\n5%, 12%, 24%, 40% { opacity: 0.7; }\n60%, 100% { opacity: 0.8; }\n}\n@keyframes aur-fx-stutter {\n0%, 90%, 91.4%, 93%, 100% { filter: none; }\n90.7%, 92.2% { filter: brightness(0.35); }\n}\n@keyframes aur-fx-buzz-a { 0%, 60% { filter: brightness(1.5); } 30% { filter: brightness(0.6); } }\n@keyframes aur-fx-buzz-b { 0%, 60% { filter: brightness(1.5); } 30% { filter: brightness(0.6); } }\n.aur-root[data-fx=\"neon\"] .aur-fx-c {\ndisplay: block;\nleft: 0;\nright: 0;\nbottom: 0;\nheight: 38%;\nbackground:\nrepeating-linear-gradient(to bottom, transparent 0 5px, rgba(0, 0, 0, 0.35) 5px 7px),\nradial-gradient(45% 80% at 30% 100%, color-mix(in oklab, var(--aur-accent) 30%, rgba(255, 47, 179, 0.35)), transparent 70%),\nradial-gradient(40% 70% at 72% 100%, rgba(34, 211, 238, 0.22), transparent 70%);\n-webkit-mask-image: linear-gradient(to top, #000, transparent);\nmask-image: linear-gradient(to top, #000, transparent);\nopacity: 0.8;\nanimation: aur-fx-pulse 5s ease-in-out infinite;\n}\n.aur-root[data-look=\"neon\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-active) .aur-main {\n-webkit-text-stroke: max(1px, 0.022em) color-mix(in oklab, var(--aur-hi) 75%, transparent);\n}\n.aur-root[data-look=\"neon\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-active) :is(.aur-main, .aur-w, .aur-c) { color: transparent; }\n.aur-root[data-look=\"neon\"][data-motion=\"full\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active .aur-main { animation: aur-fx-strike 0.55s linear; }\n@keyframes aur-fx-strike {\n0%, 18%, 38% { opacity: 0.25; }\n10%, 28%, 100% { opacity: 1; }\n}\n.aur-root[data-fx=\"minimal\"] .aur-bg-grain { opacity: 0; }\n.aur-root[data-fx=\"minimal\"] .aur-fx-a {\ndisplay: block;\ninset: 0;\nbackground: linear-gradient(160deg, color-mix(in oklab, var(--aur-c1) 22%, transparent), transparent 55%);\n}\n.aur-root[data-look=\"minimal\"] .aur-stage[data-mode=\"synced\"] .aur-lines { counter-reset: aur-ln; }\n.aur-root[data-look=\"minimal\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-gap) { counter-increment: aur-ln; }\n.aur-root[data-look=\"minimal\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-gap) .aur-main::after {\ncontent: counter(aur-ln, decimal-leading-zero);\nposition: absolute;\nleft: var(--hx, 0px);\nwidth: var(--hw, 100%);\ntop: calc(var(--hy, 0px) + var(--hh, 100%) + 0.14em);\npadding-top: 8px;\nfont: 600 11px/1 var(--aur-ui-font);\nfont-variant-numeric: tabular-nums;\nletter-spacing: 0.14em;\ncolor: rgba(255, 255, 255, 0.42);\nbackground: linear-gradient(90deg, rgba(255, 255, 255, 0.6) calc(var(--aur-lp, 0) * 100%), rgba(255, 255, 255, 0.12) 0) top left / 100% 1px no-repeat;\nopacity: 0;\ntransition: opacity 0.6s ease;\npointer-events: none;\n}\n.aur-root[data-look=\"minimal\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active .aur-main::after { opacity: 1; }\n.aur-root[data-look=\"minimal\"] .aur-dots i { width: 0.7em; height: 2px; border-radius: 1px; }\n.aur-root[data-look=\"minimal\"] .is-active .aur-dots { animation: none; }\n.aur-root[data-look=\"minimal\"] .is-active .aur-dots i { transform: none; }\n.aur-root[data-look=\"karaoke\"] {\n--ktv-edge: #0c1542;\n--ktv-sung: oklch(from var(--aur-accent) 0.7 max(c, 0.2) h);\n--ktv-row-gap: 0.42em;\n}\n.aur-root[data-look=\"karaoke\"][data-duet=\"on\"] .aur-line[data-singer] { --ktv-sung: var(--aur-kink); }\n.aur-root[data-fx=\"karaoke\"] :is(.aur-fx-a, .aur-fx-b) {\n--spot: color-mix(in oklab, var(--aur-accent) 70%, #fff);\ndisplay: block;\ntop: -30%;\nwidth: 70%;\nheight: 150%;\nbackground: conic-gradient(from 150deg at 30% 0%, transparent 0deg, color-mix(in oklab, var(--spot) 7%, transparent) 10deg, color-mix(in oklab, var(--spot) 14%, transparent) 16deg, color-mix(in oklab, var(--spot) 7%, transparent) 22deg, transparent 32deg);\ntransform-origin: 30% 0%;\ntransition: opacity 2s ease;\nanimation: aur-ktv-spot 16s steps(480) infinite alternate;\n}\n.aur-root[data-fx=\"karaoke\"] .aur-fx-a { left: -6%; }\n.aur-root[data-fx=\"karaoke\"] .aur-fx-b { --spot: #6fdcff; right: -6%; scale: -1 1; animation-duration: 19s; animation-direction: alternate-reverse; }\n@keyframes aur-ktv-spot { from { rotate: -10deg; } to { rotate: 12deg; } }\n.aur-root[data-fx=\"karaoke\"][data-gap=\"on\"] :is(.aur-fx-a, .aur-fx-b) { animation-duration: 6s; }\n.aur-root[data-fx=\"karaoke\"] .aur-fx-c {\ndisplay: block;\ninset: -10%;\nbackground:\nradial-gradient(circle 7vmin at 12% 30%, color-mix(in oklab, var(--aur-accent) 22%, transparent), transparent 100%),\nradial-gradient(circle 5vmin at 27% 62%, rgba(111, 220, 255, 0.14), transparent 100%),\nradial-gradient(circle 9vmin at 44% 18%, rgba(170, 120, 255, 0.12), transparent 100%),\nradial-gradient(circle 6vmin at 63% 40%, color-mix(in oklab, var(--aur-accent) 16%, transparent), transparent 100%),\nradial-gradient(circle 11vmin at 82% 24%, rgba(111, 220, 255, 0.1), transparent 100%),\nradial-gradient(circle 5vmin at 90% 58%, rgba(255, 200, 120, 0.12), transparent 100%),\nradial-gradient(circle 8vmin at 70% 76%, rgba(170, 120, 255, 0.1), transparent 100%),\nradial-gradient(circle 4vmin at 36% 84%, color-mix(in oklab, var(--aur-accent) 18%, transparent), transparent 100%);\nopacity: 0.7;\ntransition: opacity 2s ease;\nanimation: aur-ktv-bokeh 50s steps(1500) infinite alternate;\n}\n.aur-root[data-fx=\"karaoke\"][data-gap=\"on\"] .aur-fx-c { opacity: 1; }\n@keyframes aur-ktv-bokeh { from { transform: translate3d(-3%, 1%, 0); } to { transform: translate3d(3%, -2%, 0); } }\n.aur-root[data-fx=\"karaoke\"] .aur-fx::before {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: radial-gradient(50% 30% at 50% 104%, color-mix(in oklab, var(--aur-accent) 26%, transparent), transparent 70%);\n}\n.aur-root[data-look=\"karaoke\"] .aur-bg-shade::after {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: linear-gradient(to bottom, transparent 48%, rgba(4, 5, 16, 0.42) 64%, rgba(4, 5, 16, 0.6) 100%);\npointer-events: none;\n}\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] { -webkit-mask-image: none; mask-image: none; }\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-lines {\nleft: max(var(--aur-pad), 50% - 800px);\nright: max(var(--aur-pad), 50% - 800px);\n}\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line.aur-line[data-row] {\ntop: auto;\nbottom: auto;\nmax-width: none;\nmargin: 0;\nopacity: 0;\ntransform: none;\nfilter: none;\npointer-events: none;\ntransition: opacity 0.22s ease, color 0.3s ease;\n}\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line.aur-line[data-row=\"0\"] { bottom: calc(50% + var(--ktv-row-gap)); left: 0; right: 16%; text-align: left; }\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line.aur-line[data-row=\"1\"] { top: calc(50% + var(--ktv-row-gap)); left: 16%; right: 0; text-align: right; }\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line.aur-line[data-row].is-active,\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line.aur-line[data-row][data-d=\"1\"]:not(.is-gap) {\nopacity: 1 !important;\npointer-events: auto;\n}\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line.aur-line[data-row][data-d=\"1\"]:not(.is-gap) { transition: opacity 0.35s ease 0.2s, color 0.3s ease; }\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"][data-gap=\"on\"][data-soon=\"off\"] .aur-stage[data-mode=\"synced\"] .aur-line.aur-line[data-row] { opacity: 0 !important; }\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line.aur-line.is-gap[data-row] { padding: 0; line-height: 0; }\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-gap .aur-dots { height: 0.5em; }\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line.aur-line.is-gap[data-row=\"0\"] { bottom: calc(50% + var(--ktv-row-gap) + 1.16em + var(--aur-gap) / 2 + 0.12em); }\n.aur-root[data-look=\"karaoke\"][data-anim=\"fade\"] .aur-stage[data-mode=\"synced\"] .aur-line.aur-line.is-gap[data-row=\"1\"] { top: auto; bottom: calc(50% - var(--ktv-row-gap) - var(--aur-gap) / 2 + 0.12em); left: 16%; right: 0; text-align: right; }\n.aur-root[data-look=\"karaoke\"][data-color=\"white\"] { --aur-hi: #fff; }\n.aur-root[data-look=\"karaoke\"] .aur-stage[data-mode=\"synced\"] .aur-main {\n-webkit-text-stroke: 0.055em var(--ktv-edge);\npaint-order: stroke fill;\nfilter: drop-shadow(0 0.045em 0.03em rgba(0, 0, 10, 0.55));\n}\n.aur-root[data-look=\"karaoke\"][data-view=\"captions\"] .aur-stage { --aur-size: min(calc(var(--aur-fs) * 0.92), 4.6vw, 6.4vh); }\n.aur-root[data-look=\"karaoke\"][data-words=\"on\"] .aur-stage .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--edge: 0.04em;\ncolor: transparent;\nbackground-image:\nlinear-gradient(180deg, rgba(255, 255, 255, 0.42), rgba(255, 255, 255, 0) 58%),\nlinear-gradient(90deg, var(--ktv-sung) calc(var(--p) * (100% + var(--edge)) - var(--edge)), #fff calc(var(--p) * (100% + var(--edge))));\n-webkit-background-clip: text;\nbackground-clip: text;\ntransform: none;\nfilter: none;\n}\n.aur-root[data-look=\"karaoke\"] .aur-stage .is-active:not(.has-words) .aur-main,\n.aur-root[data-look=\"karaoke\"][data-words=\"off\"] .aur-stage .is-active .aur-main { color: var(--ktv-sung); }\n.aur-root[data-look=\"karaoke\"] .aur-dots { gap: 0.22em; }\n.aur-root[data-look=\"karaoke\"] .aur-dots i { width: 0.3em; height: 0.3em; background: var(--ktv-sung); box-shadow: 0 0 0 0.05em #fff, 0 0 0 0.1em var(--ktv-edge); }\n.aur-root[data-look=\"karaoke\"] .is-active .aur-dots { animation: none; }\n.aur-root[data-look=\"karaoke\"] .is-active .aur-dots i:nth-child(3) { opacity: calc(1 - clamp(0, var(--aur-cd, 0) * 3, 1)); transform: scale(calc(1 - 0.5 * clamp(0, var(--aur-cd, 0) * 3, 1))); }\n.aur-root[data-look=\"karaoke\"] .is-active .aur-dots i:nth-child(2) { opacity: calc(1 - clamp(0, var(--aur-cd, 0) * 3 - 1, 1)); transform: scale(calc(1 - 0.5 * clamp(0, var(--aur-cd, 0) * 3 - 1, 1))); }\n.aur-root[data-look=\"karaoke\"] .is-active .aur-dots i:nth-child(1) { opacity: calc(1 - clamp(0, var(--aur-cd, 0) * 3 - 2, 1)); transform: scale(calc(1 - 0.5 * clamp(0, var(--aur-cd, 0) * 3 - 2, 1))); }\n.aur-root[data-look=\"karaoke\"] .aur-side-meta { transition: opacity 0.6s ease; }\n.aur-root[data-look=\"karaoke\"][data-intro=\"on\"][data-soon=\"off\"] .aur-side-meta { opacity: 0; }\n.aur-root[data-look=\"karaoke\"] .aur-stage[data-mode=\"synced\"]::before,\n.aur-root[data-look=\"karaoke\"] .aur-stage[data-mode=\"synced\"]::after {\nposition: absolute;\nleft: var(--aur-pad);\nright: var(--aur-pad);\ntext-align: center;\nwhite-space: nowrap;\noverflow: hidden;\ntext-overflow: ellipsis;\nfont-family: var(--aur-font);\npaint-order: stroke fill;\nopacity: 0;\ntransform: translateY(0.3em);\ntransition: opacity 0.6s ease, transform 0.8s var(--aur-ease);\npointer-events: none;\n}\n.aur-root[data-look=\"karaoke\"] .aur-stage[data-mode=\"synced\"]::before {\ncontent: attr(data-title);\nbottom: calc(50% + 0.1em);\nfont-size: calc(var(--aur-size) * 1.2);\nfont-weight: 900;\nline-height: 1.15;\ncolor: #fff;\n-webkit-text-stroke: 0.06em var(--ktv-edge);\nfilter: drop-shadow(0 0.05em 0.03em rgba(0, 0, 10, 0.55));\n}\n.aur-root[data-look=\"karaoke\"] .aur-stage[data-mode=\"synced\"]::after {\ncontent: attr(data-artist);\ntop: calc(50% + 0.5em);\nfont-size: calc(var(--aur-size) * 0.55);\nfont-weight: 800;\nletter-spacing: 0.04em;\ncolor: var(--ktv-sung);\n-webkit-text-stroke: 0.08em var(--ktv-edge);\n}\n.aur-root[data-look=\"karaoke\"][data-intro=\"on\"][data-soon=\"off\"] .aur-stage[data-mode=\"synced\"]::before,\n.aur-root[data-look=\"karaoke\"][data-intro=\"on\"][data-soon=\"off\"] .aur-stage[data-mode=\"synced\"]::after { opacity: 1; transform: none; transition-delay: 0.3s; }\n.aur-root[data-fx=\"gothic\"] .aur-fx::before {\ncontent: \"\";\nposition: absolute;\nleft: 0;\nright: 0;\nbottom: 0;\nheight: 55%;\nbackground:\nradial-gradient(26% 60% at 5% 100%, rgba(255, 164, 72, 0.3), rgba(255, 110, 40, 0.1) 45%, transparent 75%),\nradial-gradient(26% 60% at 95% 100%, rgba(255, 164, 72, 0.3), rgba(255, 110, 40, 0.1) 45%, transparent 75%);\nanimation: aur-fx-flame 3.4s steps(27) infinite;\n}\n@keyframes aur-fx-flame {\n0%, 100% { opacity: 1; }\n11% { opacity: 0.82; }\n19% { opacity: 0.95; }\n31% { opacity: 0.76; }\n44% { opacity: 1; }\n57% { opacity: 0.86; }\n68% { opacity: 0.97; }\n83% { opacity: 0.8; }\n}\n.aur-root[data-fx=\"gothic\"] .aur-fx::after {\ncontent: \"\";\nposition: absolute;\nleft: -30%;\nright: -30%;\nbottom: -4%;\nheight: 34%;\nbackground:\nradial-gradient(22% 42% at 20% 70%, rgba(205, 195, 215, 0.07), transparent 70%),\nradial-gradient(26% 38% at 52% 80%, rgba(205, 195, 215, 0.06), transparent 70%),\nradial-gradient(20% 44% at 82% 72%, rgba(205, 195, 215, 0.07), transparent 70%);\nanimation: aur-fx-mist 70s steps(2100) infinite alternate;\n}\n@keyframes aur-fx-mist { from { transform: translate3d(-8%, 0, 0); } to { transform: translate3d(8%, 0, 0); } }\n.aur-root[data-fx=\"gothic\"] .aur-bg-shade::after {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: radial-gradient(ellipse at 50% 42%, transparent 38%, rgba(6, 2, 4, 0.72) 100%), radial-gradient(50% 30% at 50% 108%, color-mix(in oklab, var(--aur-accent) 22%, transparent), transparent 70%);\npointer-events: none;\n}\n.aur-root[data-fx=\"gothic\"] .aur-bg-grain { opacity: 0.05; }\n.aur-root[data-look=\"gothic\"][data-color=\"white\"] { --aur-hi: #efe4d2; }\n.aur-root[data-look=\"gothic\"] { --aur-glow-tint: color-mix(in oklab, var(--aur-accent) 58%, #ffd9c9); }\n.aur-root[data-look=\"gothic\"] .aur-stage .aur-line { letter-spacing: 0.01em; }\n.aur-root[data-look=\"gothic\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-gap) .aur-main::after {\ncontent: \"❦\";\nposition: absolute;\nleft: var(--hx, 0px);\nwidth: var(--hw, 100%);\ntop: calc(var(--hy, 0px) + var(--hh, 100%) + 0.06em);\nfont: 400 max(20px, 0.44em)/1 Georgia, \"Segoe UI Symbol\", serif;\ntext-align: center;\ncolor: color-mix(in oklab, var(--aur-accent) 70%, #efe4d2);\ntext-shadow: 0 0 0.5em color-mix(in oklab, var(--aur-accent) 60%, transparent);\nbackground:\nlinear-gradient(90deg, transparent, color-mix(in oklab, var(--aur-accent) 60%, #efe4d2)) calc(50% - 4.2em) 58% / 6em 1.5px no-repeat,\nlinear-gradient(90deg, color-mix(in oklab, var(--aur-accent) 60%, #efe4d2), transparent) calc(50% + 4.2em) 58% / 6em 1.5px no-repeat;\nopacity: 0;\ntransform: scale(0.8);\ntransition: opacity 1.1s ease 0.2s, transform 1.3s var(--aur-ease) 0.2s;\npointer-events: none;\n}\n.aur-root[data-look=\"gothic\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active .aur-main::after { opacity: 1; transform: none; }\n.aur-root[data-look=\"gothic\"] .aur-dots i {\nborder-radius: 1px;\nrotate: 45deg;\nbackground: color-mix(in oklab, var(--aur-accent) 75%, #efe4d2);\nbox-shadow: 0 0 0.35em color-mix(in oklab, var(--aur-accent) 55%, transparent);\n}\n.aur-root[data-fx=\"blackmetal\"] {\n--bm-moon-x: 78vw;\n--bm-moon-y: 17vh;\n--bm-moon: 8.6vmin;\n}\n.aur-root[data-fx=\"blackmetal\"] .aur-fx {\nbackground: linear-gradient(to bottom, rgba(3, 5, 8, 0.95) 0%, rgba(8, 12, 17, 0.92) 30%, rgba(19, 27, 35, 0.9) 54%, rgba(40, 50, 61, 0.88) 68%, rgba(14, 18, 22, 0.96) 84%, #050608 100%);\n}\n.aur-root[data-fx=\"blackmetal\"] .aur-fx::before {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground:\nurl(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'%3E %3Cdefs%3E %3CradialGradient id='g' cx='43%25' cy='40%25' r='64%25'%3E%3Cstop offset='0' stop-color='%23f6f8fa'/%3E%3Cstop offset='.62' stop-color='%23dfe6ec'/%3E%3Cstop offset='1' stop-color='%23a9b7c3'/%3E%3C/radialGradient%3E %3CradialGradient id='sh' cx='30%25' cy='70%25' r='75%25'%3E%3Cstop offset='.55' stop-color='%231b232b' stop-opacity='0'/%3E%3Cstop offset='1' stop-color='%231b232b' stop-opacity='.55'/%3E%3C/radialGradient%3E %3Cfilter id='m' x='0' y='0' width='100%25' height='100%25'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.03' numOctaves='4' seed='9'/%3E%3CfeColorMatrix values='0 0 0 0 .42 0 0 0 0 .47 0 0 0 0 .53 -2.7 0 0 0 1.55'/%3E%3C/filter%3E %3Cfilter id='n' x='0' y='0' width='100%25' height='100%25'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.5' numOctaves='2' seed='2'/%3E%3CfeColorMatrix values='0 0 0 0 .3 0 0 0 0 .34 0 0 0 0 .38 -1.4 0 0 0 .9'/%3E%3C/filter%3E %3CclipPath id='c'%3E%3Ccircle cx='100' cy='100' r='98'/%3E%3C/clipPath%3E %3C/defs%3E %3Ccircle cx='100' cy='100' r='98' fill='url(%23g)'/%3E %3Cg clip-path='url(%23c)'%3E %3Crect width='200' height='200' filter='url(%23m)' opacity='.62'/%3E %3Crect width='200' height='200' filter='url(%23n)' opacity='.25'/%3E %3Cg fill='none' stroke='%237e8b97' stroke-opacity='.4' stroke-width='1.4'%3E%3Ccircle cx='128' cy='142' r='9'/%3E%3Ccircle cx='62' cy='58' r='5'/%3E%3Ccircle cx='150' cy='76' r='4'/%3E%3Ccircle cx='88' cy='160' r='3.5'/%3E%3C/g%3E %3Cg fill='%23f7f9fb' fill-opacity='.5'%3E%3Ccircle cx='129' cy='140' r='2.2'/%3E%3Ccircle cx='61' cy='56' r='1.2'/%3E%3C/g%3E %3Ccircle cx='100' cy='100' r='98' fill='url(%23sh)'/%3E %3C/g%3E %3C/svg%3E\") calc(var(--bm-moon-x) - var(--bm-moon) / 2) calc(var(--bm-moon-y) - var(--bm-moon) / 2) / var(--bm-moon) var(--bm-moon) no-repeat,\nradial-gradient(circle at var(--bm-moon-x) var(--bm-moon-y), rgba(214, 226, 236, 0.32) calc(var(--bm-moon) * 0.5), rgba(170, 188, 204, 0.12) calc(var(--bm-moon) * 1.4), rgba(140, 158, 176, 0.05) calc(var(--bm-moon) * 3), transparent calc(var(--bm-moon) * 5.5)),\nradial-gradient(1.1px 1.1px at 12% 9%, rgba(255, 255, 255, 0.7), transparent),\nradial-gradient(1px 1px at 23% 21%, rgba(255, 255, 255, 0.5), transparent),\nradial-gradient(1.3px 1.3px at 37% 6%, rgba(255, 255, 255, 0.65), transparent),\nradial-gradient(0.9px 0.9px at 49% 15%, rgba(255, 255, 255, 0.45), transparent),\nradial-gradient(1.2px 1.2px at 58% 4%, rgba(255, 255, 255, 0.6), transparent),\nradial-gradient(1px 1px at 66% 27%, rgba(255, 255, 255, 0.4), transparent),\nradial-gradient(1.1px 1.1px at 91% 8%, rgba(255, 255, 255, 0.55), transparent),\nradial-gradient(0.9px 0.9px at 5% 31%, rgba(255, 255, 255, 0.4), transparent);\n}\n.aur-root[data-fx=\"blackmetal\"] .aur-fx-a {\ndisplay: block;\nleft: -6%;\nright: -6%;\ntop: 0;\nheight: 78%;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2400 1000' preserveAspectRatio='none'%3E%3Cdefs%3E%3CradialGradient id='d'%3E%3Cstop offset='0' stop-color='%231d252c' stop-opacity='.95'/%3E%3Cstop offset='.55' stop-color='%231a2128' stop-opacity='.55'/%3E%3Cstop offset='1' stop-color='%23161c22' stop-opacity='0'/%3E%3C/radialGradient%3E%3CradialGradient id='l'%3E%3Cstop offset='0' stop-color='%23b3c2ce' stop-opacity='.5'/%3E%3Cstop offset='.6' stop-color='%238e9eab' stop-opacity='.18'/%3E%3Cstop offset='1' stop-color='%238e9eab' stop-opacity='0'/%3E%3C/radialGradient%3E%3C/defs%3E%3Cellipse cx='706.5' cy='196.8' rx='142.5' ry='37.6' fill='url(%23d)' opacity='0.56'/%3E%3Cellipse cx='2597.3' cy='146.9' rx='197.9' ry='15.3' fill='url(%23d)' opacity='0.40'/%3E%3Cellipse cx='2589.6' cy='147.6' rx='168.2' ry='8.4' fill='url(%23l)' opacity='0.05'/%3E%3Cellipse cx='-132.3' cy='206.8' rx='246' ry='33.6' fill='url(%23d)' opacity='0.54'/%3E%3Cellipse cx='778.1' cy='133.4' rx='240.8' ry='14.7' fill='url(%23d)' opacity='0.51'/%3E%3Cellipse cx='331.4' cy='130.8' rx='397.6' ry='24.5' fill='url(%23d)' opacity='0.59'/%3E%3Cellipse cx='2544.8' cy='203' rx='212.4' ry='17.5' fill='url(%23d)' opacity='0.41'/%3E%3Cellipse cx='2536' cy='203.2' rx='180.6' ry='9.6' fill='url(%23l)' opacity='0.09'/%3E%3Cellipse cx='1862.6' cy='181.7' rx='226.4' ry='14.4' fill='url(%23d)' opacity='0.44'/%3E%3Cellipse cx='1856.3' cy='185.6' rx='192.4' ry='7.9' fill='url(%23l)' opacity='0.75'/%3E%3Cellipse cx='899.7' cy='119.7' rx='212.4' ry='21.1' fill='url(%23d)' opacity='0.45'/%3E%3Cellipse cx='1182.9' cy='189.2' rx='386.4' ry='21.1' fill='url(%23d)' opacity='0.37'/%3E%3Cellipse cx='1193.5' cy='189.7' rx='328.4' ry='11.6' fill='url(%23l)' opacity='0.19'/%3E%3Cellipse cx='648.9' cy='140.2' rx='306.9' ry='25.4' fill='url(%23d)' opacity='0.43'/%3E%3Cellipse cx='65.4' cy='215.1' rx='321' ry='29' fill='url(%23d)' opacity='0.53'/%3E%3Cellipse cx='2193.7' cy='114.9' rx='194.7' ry='25.3' fill='url(%23d)' opacity='0.53'/%3E%3Cellipse cx='2181.5' cy='118.4' rx='165.5' ry='13.9' fill='url(%23l)' opacity='0.37'/%3E%3Cellipse cx='1211.7' cy='180.7' rx='229.1' ry='19.9' fill='url(%23d)' opacity='0.57'/%3E%3Cellipse cx='1221.6' cy='181.4' rx='194.7' ry='10.9' fill='url(%23l)' opacity='0.21'/%3E%3Cellipse cx='2551.9' cy='180' rx='275.6' ry='17.1' fill='url(%23d)' opacity='0.50'/%3E%3Cellipse cx='2543.3' cy='180.4' rx='234.2' ry='9.4' fill='url(%23l)' opacity='0.08'/%3E%3Cellipse cx='392.9' cy='197.6' rx='220.8' ry='25.2' fill='url(%23d)' opacity='0.57'/%3E%3Cellipse cx='672.9' cy='184.9' rx='232.4' ry='25.7' fill='url(%23d)' opacity='0.57'/%3E%3Cellipse cx='1178.8' cy='532.6' rx='330.5' ry='86.3' fill='url(%23d)' opacity='0.64'/%3E%3Cellipse cx='1217.3' cy='511.1' rx='280.9' ry='47.5' fill='url(%23l)' opacity='0.05'/%3E%3Cellipse cx='1203.1' cy='471.1' rx='293' ry='51.1' fill='url(%23d)' opacity='0.58'/%3E%3Cellipse cx='1226.6' cy='460.1' rx='249' ry='28.1' fill='url(%23l)' opacity='0.10'/%3E%3Cellipse cx='-19.8' cy='382.1' rx='391.3' ry='105.2' fill='url(%23d)' opacity='0.72'/%3E%3Cellipse cx='1699.7' cy='446.6' rx='310.2' ry='88.2' fill='url(%23d)' opacity='0.54'/%3E%3Cellipse cx='1717.4' cy='402.2' rx='263.7' ry='48.5' fill='url(%23l)' opacity='0.42'/%3E%3Cellipse cx='87.1' cy='442.3' rx='401.9' ry='74.6' fill='url(%23d)' opacity='0.67'/%3E%3Cellipse cx='1283.8' cy='395' rx='472.4' ry='51.8' fill='url(%23d)' opacity='0.53'/%3E%3Cellipse cx='1308.3' cy='385.7' rx='401.6' ry='28.5' fill='url(%23l)' opacity='0.21'/%3E%3Cellipse cx='698.8' cy='471.3' rx='280.8' ry='128.6' fill='url(%23d)' opacity='0.48'/%3E%3Cellipse cx='1060' cy='428.6' rx='438.2' ry='70.3' fill='url(%23d)' opacity='0.50'/%3E%3Cellipse cx='1093.8' cy='418' rx='372.5' ry='38.7' fill='url(%23l)' opacity='0.04'/%3E%3Cellipse cx='1883.6' cy='495.3' rx='384.1' ry='122.2' fill='url(%23d)' opacity='0.57'/%3E%3Cellipse cx='1865.9' cy='430.9' rx='326.5' ry='67.2' fill='url(%23l)' opacity='0.34'/%3E%3Cellipse cx='1057.7' cy='434.7' rx='240.6' ry='116.2' fill='url(%23d)' opacity='0.47'/%3E%3Cellipse cx='1113.5' cy='416.8' rx='204.5' ry='63.9' fill='url(%23l)' opacity='0.04'/%3E%3Cellipse cx='16.3' cy='521.2' rx='344.6' ry='61.7' fill='url(%23d)' opacity='0.72'/%3E%3Cellipse cx='331.1' cy='425.2' rx='204.6' ry='61.5' fill='url(%23d)' opacity='0.59'/%3E%3Cellipse cx='1762.4' cy='357.2' rx='443.7' ry='101.6' fill='url(%23d)' opacity='0.65'/%3E%3Cellipse cx='1775.6' cy='303.2' rx='377.2' ry='55.9' fill='url(%23l)' opacity='0.58'/%3E%3Cellipse cx='2502.5' cy='430.9' rx='201.5' ry='54.5' fill='url(%23d)' opacity='0.71'/%3E%3Cellipse cx='2476.4' cy='422.2' rx='171.3' ry='30' fill='url(%23l)' opacity='0.06'/%3E%3Cellipse cx='103.4' cy='387.4' rx='409' ry='109' fill='url(%23d)' opacity='0.68'/%3E%3Cellipse cx='1366' cy='398.6' rx='488.5' ry='51.5' fill='url(%23d)' opacity='0.53'/%3E%3Cellipse cx='1389.8' cy='387.8' rx='415.2' ry='28.3' fill='url(%23l)' opacity='0.28'/%3E%3Cellipse cx='2563.7' cy='369.5' rx='469.3' ry='98.1' fill='url(%23d)' opacity='0.64'/%3E%3Cellipse cx='2515.6' cy='359' rx='398.9' ry='54' fill='url(%23l)' opacity='0.05'/%3E%3Cellipse cx='1572.5' cy='424.4' rx='469' ry='54.8' fill='url(%23d)' opacity='0.54'/%3E%3Cellipse cx='1592.8' cy='404.2' rx='398.6' ry='30.1' fill='url(%23l)' opacity='0.39'/%3E%3Cellipse cx='1960' cy='484.9' rx='405.3' ry='105.2' fill='url(%23d)' opacity='0.54'/%3E%3Cellipse cx='1933' cy='435.3' rx='344.5' ry='57.8' fill='url(%23l)' opacity='0.34'/%3E%3Cellipse cx='1483' cy='449.7' rx='460.6' ry='68.4' fill='url(%23d)' opacity='0.54'/%3E%3Cellipse cx='1510.6' cy='427.5' rx='391.5' ry='37.6' fill='url(%23l)' opacity='0.31'/%3E%3Cellipse cx='698.2' cy='373.4' rx='433' ry='89.3' fill='url(%23d)' opacity='0.47'/%3E%3Cellipse cx='2299' cy='439.9' rx='463.4' ry='109.6' fill='url(%23d)' opacity='0.57'/%3E%3Cellipse cx='2249' cy='415.4' rx='393.9' ry='60.3' fill='url(%23l)' opacity='0.19'/%3E%3Cellipse cx='697.3' cy='647.9' rx='579.8' ry='108.1' fill='url(%23d)' opacity='0.79'/%3E%3Cellipse cx='1401.7' cy='647.2' rx='362.1' ry='92.9' fill='url(%23d)' opacity='0.67'/%3E%3Cellipse cx='1433.3' cy='609.7' rx='307.8' ry='51.1' fill='url(%23l)' opacity='0.05'/%3E%3Cellipse cx='1934.1' cy='694' rx='566.4' ry='75.2' fill='url(%23d)' opacity='0.69'/%3E%3Cellipse cx='1923.9' cy='654.2' rx='481.4' ry='41.4' fill='url(%23l)' opacity='0.07'/%3E%3Cellipse cx='-14.5' cy='604.9' rx='465.4' ry='60.1' fill='url(%23d)' opacity='0.76'/%3E%3Cellipse cx='1309.2' cy='598.2' rx='403.4' ry='105.2' fill='url(%23d)' opacity='0.53'/%3E%3Cellipse cx='1350.8' cy='562.8' rx='342.9' ry='57.8' fill='url(%23l)' opacity='0.06'/%3E%3Cellipse cx='2352' cy='665.2' rx='439.8' ry='71.5' fill='url(%23d)' opacity='0.69'/%3E%3Cellipse cx='421.7' cy='571.1' rx='549.7' ry='81' fill='url(%23d)' opacity='0.73'/%3E%3Cellipse cx='1155.1' cy='650.1' rx='391.5' ry='109.2' fill='url(%23d)' opacity='0.73'/%3E%3Cellipse cx='886.9' cy='649.1' rx='353.5' ry='114.6' fill='url(%23d)' opacity='0.64'/%3E%3Cellipse cx='1483.5' cy='651.9' rx='293.3' ry='80' fill='url(%23d)' opacity='0.73'/%3E%3Cellipse cx='1507.1' cy='616.4' rx='249.3' ry='44' fill='url(%23l)' opacity='0.07'/%3E%3Cellipse cx='1449.3' cy='599.2' rx='316.2' ry='112.1' fill='url(%23d)' opacity='0.74'/%3E%3Cellipse cx='1487.3' cy='553.9' rx='268.8' ry='61.6' fill='url(%23l)' opacity='0.12'/%3E%3Cellipse cx='2277' cy='588.3' rx='446.5' ry='86.3' fill='url(%23d)' opacity='0.63'/%3E%3Cellipse cx='2243' cy='559.2' rx='379.6' ry='47.5' fill='url(%23l)' opacity='0.08'/%3E%3Cellipse cx='810.6' cy='662.5' rx='454.7' ry='64.4' fill='url(%23d)' opacity='0.51'/%3E%3Cellipse cx='295.3' cy='689.7' rx='552.7' ry='100.3' fill='url(%23d)' opacity='0.61'/%3E%3C/svg%3E\") center / 100% 100% no-repeat;\nanimation: aur-bm-clouds 160s steps(3200) infinite alternate;\n}\n@keyframes aur-bm-clouds { from { transform: translate3d(-2.5%, 0, 0); } to { transform: translate3d(2.5%, 0, 0); } }\n.aur-root[data-fx=\"blackmetal\"] .aur-fx-a::after {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: radial-gradient(38% 34% at 26% 42%, rgba(205, 220, 236, 0.34), transparent 70%), radial-gradient(30% 26% at 62% 30%, rgba(205, 220, 236, 0.2), transparent 70%);\nopacity: 0;\nanimation: aur-bm-lightning 23s linear infinite;\n}\n.aur-root[data-fx=\"blackmetal\"][data-gap=\"on\"] .aur-fx-a::after { animation-duration: 8s; }\n@keyframes aur-bm-lightning {\n0%, 93.9%, 94.6%, 95.4%, 96.6%, 100% { opacity: 0; }\n94.2% { opacity: 1; }\n95.1% { opacity: 0.45; }\n95.9% { opacity: 0.8; }\n}\n.aur-root[data-fx=\"blackmetal\"] .aur-fx-b {\ndisplay: block;\nleft: 0;\nright: 0;\nbottom: 7vh;\nheight: 50vh;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2400 600' preserveAspectRatio='none'%3E%3Cdefs%3E%3ClinearGradient id='fr' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%234c5864'/%3E%3Cstop offset='.45' stop-color='%232b343d'/%3E%3Cstop offset='1' stop-color='%231a2026'/%3E%3C/linearGradient%3E%3ClinearGradient id='mr' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%23e2e9ef'/%3E%3Cstop offset='.1' stop-color='%23b4c2cd'/%3E%3Cstop offset='.24' stop-color='%235a6671'/%3E%3Cstop offset='.42' stop-color='%2328313a'/%3E%3Cstop offset='1' stop-color='%230d1115'/%3E%3C/linearGradient%3E%3ClinearGradient id='hz' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='.45' stop-color='%239fb0bf' stop-opacity='0'/%3E%3Cstop offset='1' stop-color='%239fb0bf' stop-opacity='.22'/%3E%3C/linearGradient%3E%3Cpath id='f' d='M0 600L0 290 19 293 38 292 56 288 75 287 94 287 112 286 131 286 150 296 169 298 188 310 206 308 225 312 244 329 262 339 281 349 300 365 319 374 338 380 356 388 375 390 394 400 412 404 431 412 450 422 469 423 488 425 506 421 525 415 544 417 562 413 581 406 600 404 619 408 638 409 656 407 675 401 694 400 712 393 731 380 750 375 769 373 788 364 806 360 825 363 844 355 862 350 881 349 900 346 919 345 938 337 956 339 975 343 994 351 1012 351 1031 362 1050 373 1069 371 1088 373 1106 379 1125 387 1144 384 1162 385 1181 384 1200 388 1219 390 1238 395 1256 398 1275 397 1294 401 1312 397 1331 400 1350 406 1369 406 1388 412 1406 415 1425 412 1444 411 1462 408 1481 408 1500 409 1519 397 1538 389 1556 383 1575 375 1594 377 1612 375 1631 371 1650 368 1669 361 1688 356 1706 348 1725 349 1744 356 1762 356 1781 360 1800 372 1819 373 1838 375 1856 380 1875 380 1894 377 1912 380 1931 379 1950 375 1969 377 1988 372 2006 376 2025 377 2044 384 2062 386 2081 380 2100 378 2119 373 2138 367 2156 363 2175 362 2194 363 2212 359 2231 352 2250 348 2269 346 2288 346 2306 345 2325 336 2344 327 2362 312 2381 313 2400 306 2400 600Z'/%3E%3Cpath id='m' d='M0 600L0 368 19 362 38 355 56 347 75 343 94 327 112 311 131 299 150 289 169 270 188 244 206 220 225 204 244 192 262 179 281 160 300 150 319 145 338 136 356 133 375 146 394 140 412 143 431 135 450 134 469 125 488 113 506 110 525 124 544 130 562 138 581 152 600 175 619 182 638 196 656 199 675 203 694 213 712 212 731 219 750 227 769 237 788 237 806 240 825 251 844 266 862 271 881 277 900 285 919 294 938 307 956 320 975 327 994 339 1012 344 1031 349 1050 361 1069 363 1088 369 1106 380 1125 387 1144 389 1162 392 1181 390 1200 390 1219 389 1238 393 1256 385 1275 383 1294 389 1312 393 1331 395 1350 390 1369 388 1388 379 1406 370 1425 361 1444 352 1462 350 1481 345 1500 342 1519 338 1538 327 1556 325 1575 315 1594 304 1612 290 1631 270 1650 255 1669 250 1688 245 1706 237 1725 230 1744 222 1762 212 1781 210 1800 217 1819 206 1838 181 1856 178 1875 164 1894 156 1912 161 1931 162 1950 171 1969 184 1988 187 2006 193 2025 207 2044 219 2062 219 2081 218 2100 219 2119 237 2138 249 2156 267 2175 279 2194 279 2212 285 2231 296 2250 310 2269 322 2288 339 2306 349 2325 355 2344 371 2362 382 2381 392 2400 406 2400 600Z'/%3E%3C/defs%3E%3Cuse href='%23f' fill='url(%23fr)' opacity='.85'/%3E%3Cuse href='%23f' fill='url(%23hz)'/%3E%3Cuse href='%23m' fill='url(%23mr)'/%3E%3Cpath d='M342 163L 336 174 329 183 320 198 M376 169L 383 183 388 192 399 203 405 220 414 229 M391 145L 396 156 400 167 406 177 M469 139L 458 156 448 173 439 186 430 203 420 214 M520 149L 526 166 537 178 541 190 551 202 555 212 564 226 M536 127L 546 144 550 153 560 163 M480 122L 472 140 464 148 453 161 M1886 178L 1880 195 1873 211 1867 221 1859 230 1852 243 1845 258 M1898 167L 1904 179 1910 190 1920 198 1927 210 M1912 174L 1916 184 1925 197 1935 209 1945 218 1953 228 1959 245 M1874 191L 1868 203 1862 215 1854 230 1847 243 1839 260' fill='none' stroke='%230c1014' stroke-opacity='.32' stroke-width='1.3' stroke-linejoin='round' vector-effect='non-scaling-stroke'/%3E%3Cpath d='M383 168L 390 185 398 198 409 215 420 226 428 239 M341 150L 334 162 326 176 319 190 309 202 301 217 M527 135L 535 147 545 160 549 172 558 183 567 194 M492 139L 482 151 472 169 462 184 454 197 444 212 M543 145L 550 161 559 171 566 186 573 194 M1929 196L 1939 208 1945 220 1952 235 M1880 188L 1870 199 1864 207 1859 224 1854 241 M1911 180L 1917 188 1922 200 1929 210 1936 225 1941 235' fill='none' stroke='%23e6edf2' stroke-opacity='.22' stroke-width='1.1' stroke-linejoin='round' vector-effect='non-scaling-stroke'/%3E%3Cpath d='M356 133L375 146 M394 140L412 143 M506 110L525 124 M525 124L544 130 M544 130L562 138 M562 138L581 152 M581 152L600 175 M600 175L619 182 M619 182L638 196 M638 196L656 199 M656 199L675 203 M675 203L694 213 M712 212L731 219 M731 219L750 227 M750 227L769 237 M788 237L806 240 M806 240L825 251 M825 251L844 266 M844 266L862 271 M862 271L881 277 M881 277L900 285 M900 285L919 294 M919 294L938 307 M938 307L956 320 M956 320L975 327 M975 327L994 339 M994 339L1012 344 M1012 344L1031 349 M1031 349L1050 361 M1050 361L1069 363 M1069 363L1088 369 M1088 369L1106 380 M1106 380L1125 387 M1125 387L1144 389 M1144 389L1162 392 M1181 390L1200 390 M1219 389L1238 393 M1275 383L1294 389 M1294 389L1312 393 M1312 393L1331 395 M1781 210L1800 217 M1894 156L1912 161 M1912 161L1931 162 M1931 162L1950 171 M1950 171L1969 184 M1969 184L1988 187 M1988 187L2006 193 M2006 193L2025 207 M2025 207L2044 219 M2081 218L2100 219 M2100 219L2119 237 M2119 237L2138 249 M2138 249L2156 267 M2156 267L2175 279 M2194 279L2212 285 M2212 285L2231 296 M2231 296L2250 310 M2250 310L2269 322 M2269 322L2288 339 M2288 339L2306 349 M2306 349L2325 355 M2325 355L2344 371 M2344 371L2362 382 M2362 382L2381 392 M2381 392L2400 406' fill='none' stroke='%23eef3f7' stroke-opacity='.55' stroke-width='1.3' stroke-linecap='round' vector-effect='non-scaling-stroke'/%3E%3Cuse href='%23m' fill='url(%23hz)'/%3E%3C/svg%3E\") center bottom / 100% 100% no-repeat;\n}\n.aur-root[data-fx=\"blackmetal\"] .aur-fx-b::before {\ncontent: \"\";\nposition: absolute;\nleft: 0;\nright: 0;\nbottom: -7vh;\nheight: 34vh;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2400 700'%3E%3Cdefs%3E%3Cpath id='t0' d='M0 0 -17 102 -13 96 -10 97 -7 95 -4 103 -33 162 -26 157 -20 167 -16 159 -8 166 -52 236 -40 228 -33 234 -25 218 -15 232 -61 304 -49 286 -38 295 -30 287 -18 299 -90 369 -68 360 -56 369 -43 358 -27 368 -99 442 -77 428 -62 441 -44 424 -26 437 -103 510 -81 498 -61 511 -50 495 -24 508 -112 584 -88 574 -70 583 -50 568 -31 580 -149 665 -115 645 -89 656 -68 639 -39 652 -148 742 -114 717 -88 734 -70 717 -35 725 -162 809 -127 787 -95 803 -73 785 -48 798 -157 879 -118 868 -98 880 -77 864 -38 872 -218 966 -161 941 -128 959 -105 941 -61 947 -14 950 -14 1000 14 1000 14 950 49 947 76 934 107 953 123 938 170 962 43 872 78 862 108 882 133 864 176 888 33 798 71 787 97 804 117 794 157 806 28 725 65 718 86 727 109 722 137 739 34 652 69 644 99 658 124 649 156 663 29 580 60 574 70 587 96 569 121 586 31 508 55 495 77 511 91 502 122 510 27 437 45 426 59 440 73 428 98 440 15 368 34 358 45 365 59 360 74 369 13 299 29 286 37 298 47 286 62 297 11 232 26 225 32 227 42 224 54 230 10 166 18 154 25 164 28 155 39 162 5 103 10 94 13 103 16 91 20 101Z'/%3E%3Cpath id='s0' d='M0 0Q-12 43 -17 102 M-8 166Q-38 194 -52 236 M-27 368Q-71 401 -99 442 M-26 437Q-69 467 -103 510 M-24 508Q-72 542 -112 584 M-31 580Q-94 616 -149 665 M-35 725Q-106 764 -162 809 M-38 872Q-134 913 -218 966 M0 0Q12 44 20 101 M5 103Q26 129 39 162 M10 166Q38 193 54 230 M13 299Q49 328 74 369 M31 508Q84 539 121 586 M29 580Q96 616 156 663 M34 652Q89 692 137 739 M28 725Q98 759 157 806 M33 798Q112 836 176 888' fill='none' stroke='%238f9daa' stroke-width='6' stroke-linecap='round' stroke-opacity='0.3'/%3E%3Cpath id='t1' d='M0 0 -18 103 -15 92 -12 102 -9 89 -4 103 -40 163 -30 161 -24 163 -18 159 -10 166 -51 236 -39 222 -31 233 -23 222 -13 232 -70 299 -51 296 -45 295 -33 290 -17 299 -91 366 -71 363 -56 368 -41 354 -24 368 -90 438 -67 425 -56 440 -42 430 -21 437 -119 513 -90 501 -73 511 -52 496 -35 508 -106 587 -83 570 -66 587 -52 569 -22 580 -148 657 -111 644 -91 655 -70 640 -31 652 -136 736 -100 719 -82 733 -67 719 -33 725 -166 808 -131 791 -98 809 -74 788 -46 798 -164 891 -129 866 -98 877 -76 866 -36 872 -217 969 -160 943 -131 956 -98 939 -60 947 -14 950 -14 1000 14 1000 14 950 55 947 95 941 120 955 160 944 203 954 43 872 77 867 93 879 118 866 156 888 42 798 77 792 92 802 124 792 156 816 37 725 76 713 103 733 123 721 166 733 32 652 57 642 79 654 93 650 125 658 27 580 51 572 74 583 88 576 115 585 30 508 49 499 58 511 76 503 100 511 25 437 47 427 59 438 79 432 99 440 18 368 34 357 44 369 56 360 72 369 18 299 31 289 37 297 47 287 63 298 13 232 25 223 35 229 42 227 57 231 9 166 18 159 22 166 27 156 38 169 5 103 8 95 11 104 14 99 18 100Z'/%3E%3Cpath id='s1' d='M0 0Q-14 45 -18 103 M-13 232Q-48 258 -70 299 M-17 299Q-57 327 -91 366 M-24 368Q-62 395 -90 438 M-35 508Q-76 545 -106 587 M-22 580Q-88 612 -148 657 M-46 798Q-109 843 -164 891 M-36 872Q-134 916 -217 969 M0 0Q12 44 18 100 M5 103Q28 129 38 169 M13 232Q46 258 63 298 M18 299Q53 327 72 369 M30 508Q79 539 115 585 M32 652Q102 691 166 733 M37 725Q104 764 156 816 M42 798Q102 840 156 888' fill='none' stroke='%238f9daa' stroke-width='6' stroke-linecap='round' stroke-opacity='0.3'/%3E%3Cpath id='t2' d='M0 0 -19 98 -14 92 -12 102 -9 89 -5 103 -40 164 -29 154 -25 165 -19 157 -10 166 -52 231 -39 220 -31 234 -25 222 -11 232 -73 299 -57 290 -46 299 -33 286 -19 299 -93 371 -74 363 -54 370 -45 358 -21 368 -103 442 -81 430 -60 438 -45 431 -30 437 -107 510 -82 503 -63 510 -54 499 -26 508 -113 582 -90 573 -69 586 -55 567 -24 580 -128 667 -96 649 -78 654 -64 645 -38 652 -155 738 -114 716 -99 732 -73 717 -32 725 -162 811 -124 797 -96 807 -74 788 -43 798 -199 888 -153 871 -123 877 -97 861 -53 872 -189 956 -136 944 -117 954 -92 938 -46 947 -14 950 -14 1000 14 1000 14 950 61 947 100 941 129 953 172 942 218 962 39 872 76 861 99 878 117 868 158 886 42 798 66 792 84 803 115 797 144 809 39 725 62 712 84 732 99 715 136 742 34 652 63 644 83 661 104 641 138 656 29 580 65 568 80 583 106 569 133 589 30 508 47 501 61 512 77 498 104 515 26 437 52 424 62 442 77 430 106 447 18 368 39 360 48 366 63 357 79 376 18 299 28 289 37 295 51 291 64 298 13 232 26 217 37 233 44 225 58 233 8 166 17 154 24 160 30 158 38 166 4 103 8 88 9 101 12 95 16 99Z'/%3E%3Cpath id='s2' d='M0 0Q-12 46 -19 98 M-5 103Q-30 129 -40 164 M-10 166Q-38 196 -52 231 M-19 299Q-62 332 -93 371 M-21 368Q-69 401 -103 442 M-30 437Q-74 471 -107 510 M-26 508Q-74 540 -113 582 M-24 580Q-83 616 -128 667 M-43 798Q-129 841 -199 888 M0 0Q14 45 16 99 M4 103Q25 132 38 166 M13 232Q43 262 64 298 M18 299Q54 332 79 376 M30 508Q86 544 133 589 M34 652Q89 691 136 742 M39 725Q99 763 144 809 M42 798Q107 835 158 886 M39 872Q136 910 218 962' fill='none' stroke='%238f9daa' stroke-width='6' stroke-linecap='round' stroke-opacity='0.3'/%3E%3ClinearGradient id='fg' x1='0' y1='0' x2='0' y2='700' gradientUnits='userSpaceOnUse'%3E%3Cstop offset='.55' stop-color='%2346525c'/%3E%3Cstop offset='.8' stop-color='%23303a43'/%3E%3C/linearGradient%3E%3ClinearGradient id='mg' x1='0' y1='0' x2='0' y2='700' gradientUnits='userSpaceOnUse'%3E%3Cstop offset='.45' stop-color='%2326303a'/%3E%3Cstop offset='1' stop-color='%230d1115'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cg fill='url(%23fg)'%3E%3Cpath d='M0 700L0 520 -8 520 16 407 39 520 13 514 30 452 47 514 34 517 51 440 69 517 46 515 67 411 88 515 66 522 80 458 95 522 87 523 98 470 110 523 92 519 112 431 132 519 107 519 129 426 151 519 136 513 154 427 172 513 162 522 179 443 196 522 175 515 200 419 225 515 195 520 217 414 240 520 209 522 232 429 255 522 239 514 256 433 273 514 259 522 276 441 292 522 275 515 295 421 315 515 293 517 308 448 323 517 299 514 326 411 353 514 330 523 344 466 358 523 338 512 360 413 382 512 368 517 383 448 398 517 382 517 399 443 416 517 406 513 420 448 433 513 416 521 434 439 452 521 428 513 454 418 479 513 454 518 467 463 479 518 471 512 489 442 508 512 498 512 513 453 529 512 512 518 539 420 565 518 528 513 554 400 580 513 556 514 575 434 594 514 570 513 590 428 609 513 584 517 608 421 632 517 611 514 626 444 642 514 632 520 645 467 658 520 656 517 666 470 677 517 652 518 680 405 709 518 690 518 703 459 715 518 707 519 725 428 743 519 724 523 750 426 776 523 750 523 766 457 782 523 755 518 784 407 813 518 776 515 805 403 833 515 816 523 829 464 842 523 838 519 853 452 868 519 852 520 877 427 902 520 881 517 901 429 920 517 899 515 920 433 941 515 913 517 934 420 955 517 926 515 948 412 971 515 954 522 972 441 989 522 971 521 990 450 1009 521 997 519 1013 456 1029 519 1019 521 1037 450 1055 521 1032 523 1055 432 1078 523 1059 519 1080 419 1101 519 1090 522 1102 470 1113 522 1104 519 1126 409 1149 519 1130 512 1151 422 1171 512 1150 516 1176 411 1201 516 1174 519 1199 417 1225 519 1202 516 1216 450 1231 516 1223 516 1236 463 1249 516 1237 517 1251 454 1266 517 1263 515 1274 463 1286 515 1270 513 1290 415 1310 513 1285 518 1310 422 1335 518 1300 517 1327 411 1354 517 1318 522 1348 412 1377 522 1347 514 1362 446 1378 514 1372 518 1385 469 1398 518 1386 518 1406 444 1426 518 1404 523 1431 413 1458 523 1432 518 1450 447 1468 518 1446 513 1467 421 1489 513 1470 518 1491 438 1513 518 1502 518 1516 453 1530 518 1514 513 1539 411 1564 513 1547 522 1557 475 1568 522 1552 514 1575 420 1598 514 1586 518 1597 468 1608 518 1586 519 1611 406 1637 519 1623 512 1637 460 1651 512 1633 516 1658 425 1682 516 1662 514 1683 423 1704 514 1683 516 1699 446 1715 516 1705 512 1723 441 1740 512 1713 515 1738 421 1762 515 1737 516 1751 455 1765 516 1755 521 1771 455 1787 521 1771 515 1794 418 1818 515 1801 517 1818 452 1835 517 1820 516 1840 436 1859 516 1838 519 1860 422 1882 519 1861 518 1879 440 1897 518 1889 521 1901 464 1913 521 1890 514 1915 414 1941 514 1920 514 1937 451 1953 514 1939 514 1951 467 1963 514 1940 520 1968 407 1997 520 1971 521 1989 431 2007 521 1982 522 2006 417 2030 522 1996 518 2019 404 2043 518 2010 523 2038 409 2067 523 2047 514 2063 439 2079 514 2058 516 2085 404 2113 516 2086 520 2106 429 2126 520 2112 517 2122 470 2131 517 2130 520 2144 459 2158 520 2140 516 2160 435 2180 516 2153 514 2176 421 2199 514 2176 521 2199 430 2223 521 2198 519 2219 424 2240 519 2217 522 2233 453 2249 522 2226 523 2255 414 2283 523 2255 514 2276 426 2296 514 2281 515 2299 427 2318 515 2292 514 2315 419 2338 514 2318 517 2337 432 2355 517 2351 519 2363 464 2375 519 2362 520 2387 411 2412 520 2383 519 2401 447 2420 519 2400 520 2400 700Z'/%3E%3C/g%3E%3Crect y='515' width='2400' height='185' fill='%232a333c' opacity='.9'/%3E%3Cg fill='url(%23mg)'%3E%3Cuse href='%23t2' transform='translate(58 415) scale(-0.315 0.291)'/%3E%3Cuse href='%23s2' transform='translate(58 415) scale(-0.315 0.291)'/%3E%3Cuse href='%23t2' transform='translate(126 516) scale(-0.182 0.184)'/%3E%3Cuse href='%23s2' transform='translate(126 516) scale(-0.182 0.184)'/%3E%3Cuse href='%23t2' transform='translate(157 446) scale(0.226 0.261)'/%3E%3Cuse href='%23s2' transform='translate(157 446) scale(0.226 0.261)'/%3E%3Cuse href='%23t0' transform='translate(210 511) scale(-0.164 0.189)'/%3E%3Cuse href='%23s0' transform='translate(210 511) scale(-0.164 0.189)'/%3E%3Cuse href='%23t1' transform='translate(257 469) scale(-0.260 0.235)'/%3E%3Cuse href='%23s1' transform='translate(257 469) scale(-0.260 0.235)'/%3E%3Cuse href='%23t0' transform='translate(322 500) scale(0.206 0.211)'/%3E%3Cuse href='%23s0' transform='translate(322 500) scale(0.206 0.211)'/%3E%3Cuse href='%23t2' transform='translate(373 407) scale(-0.259 0.300)'/%3E%3Cuse href='%23s2' transform='translate(373 407) scale(-0.259 0.300)'/%3E%3Cuse href='%23t2' transform='translate(424 453) scale(0.276 0.258)'/%3E%3Cuse href='%23s2' transform='translate(424 453) scale(0.276 0.258)'/%3E%3Cuse href='%23t2' transform='translate(453 535) scale(-0.158 0.176)'/%3E%3Cuse href='%23s2' transform='translate(453 535) scale(-0.158 0.176)'/%3E%3Cuse href='%23t1' transform='translate(510 510) scale(-0.191 0.197)'/%3E%3Cuse href='%23s1' transform='translate(510 510) scale(-0.191 0.197)'/%3E%3Cuse href='%23t1' transform='translate(555 536) scale(0.150 0.174)'/%3E%3Cuse href='%23s1' transform='translate(555 536) scale(0.150 0.174)'/%3E%3Cuse href='%23t0' transform='translate(614 422) scale(-0.291 0.279)'/%3E%3Cuse href='%23s0' transform='translate(614 422) scale(-0.291 0.279)'/%3E%3Cuse href='%23t0' transform='translate(675 507) scale(0.175 0.201)'/%3E%3Cuse href='%23s0' transform='translate(675 507) scale(0.175 0.201)'/%3E%3Cuse href='%23t1' transform='translate(703 448) scale(0.224 0.253)'/%3E%3Cuse href='%23s1' transform='translate(703 448) scale(0.224 0.253)'/%3E%3Cuse href='%23t2' transform='translate(758 508) scale(0.183 0.199)'/%3E%3Cuse href='%23s2' transform='translate(758 508) scale(0.183 0.199)'/%3E%3Cuse href='%23t2' transform='translate(816 506) scale(-0.198 0.198)'/%3E%3Cuse href='%23s2' transform='translate(816 506) scale(-0.198 0.198)'/%3E%3Cuse href='%23t1' transform='translate(874 522) scale(-0.160 0.182)'/%3E%3Cuse href='%23s1' transform='translate(874 522) scale(-0.160 0.182)'/%3E%3Cuse href='%23t2' transform='translate(935 532) scale(-0.149 0.174)'/%3E%3Cuse href='%23s2' transform='translate(935 532) scale(-0.149 0.174)'/%3E%3Cuse href='%23t2' transform='translate(959 530) scale(-0.168 0.174)'/%3E%3Cuse href='%23s2' transform='translate(959 530) scale(-0.168 0.174)'/%3E%3Cuse href='%23t2' transform='translate(1009 550) scale(0.143 0.161)'/%3E%3Cuse href='%23s2' transform='translate(1009 550) scale(0.143 0.161)'/%3E%3Cuse href='%23t1' transform='translate(1058 570) scale(-0.146 0.135)'/%3E%3Cuse href='%23s1' transform='translate(1058 570) scale(-0.146 0.135)'/%3E%3Cuse href='%23t2' transform='translate(1136 498) scale(0.223 0.204)'/%3E%3Cuse href='%23s2' transform='translate(1136 498) scale(0.223 0.204)'/%3E%3Cuse href='%23t2' transform='translate(1192 567) scale(0.153 0.142)'/%3E%3Cuse href='%23s2' transform='translate(1192 567) scale(0.153 0.142)'/%3E%3Cuse href='%23t1' transform='translate(1222 522) scale(-0.182 0.180)'/%3E%3Cuse href='%23s1' transform='translate(1222 522) scale(-0.182 0.180)'/%3E%3Cuse href='%23t0' transform='translate(1290 575) scale(-0.133 0.135)'/%3E%3Cuse href='%23s0' transform='translate(1290 575) scale(-0.133 0.135)'/%3E%3Cuse href='%23t2' transform='translate(1340 527) scale(0.152 0.174)'/%3E%3Cuse href='%23s2' transform='translate(1340 527) scale(0.152 0.174)'/%3E%3Cuse href='%23t2' transform='translate(1375 531) scale(0.189 0.173)'/%3E%3Cuse href='%23s2' transform='translate(1375 531) scale(0.189 0.173)'/%3E%3Cuse href='%23t0' transform='translate(1412 484) scale(-0.229 0.225)'/%3E%3Cuse href='%23s0' transform='translate(1412 484) scale(-0.229 0.225)'/%3E%3Cuse href='%23t2' transform='translate(1484 533) scale(0.180 0.176)'/%3E%3Cuse href='%23s2' transform='translate(1484 533) scale(0.180 0.176)'/%3E%3Cuse href='%23t0' transform='translate(1518 570) scale(-0.117 0.136)'/%3E%3Cuse href='%23s0' transform='translate(1518 570) scale(-0.117 0.136)'/%3E%3Cuse href='%23t1' transform='translate(1594 530) scale(-0.164 0.173)'/%3E%3Cuse href='%23s1' transform='translate(1594 530) scale(-0.164 0.173)'/%3E%3Cuse href='%23t0' transform='translate(1631 505) scale(-0.222 0.205)'/%3E%3Cuse href='%23s0' transform='translate(1631 505) scale(-0.222 0.205)'/%3E%3Cuse href='%23t2' transform='translate(1696 495) scale(-0.178 0.208)'/%3E%3Cuse href='%23s2' transform='translate(1696 495) scale(-0.178 0.208)'/%3E%3Cuse href='%23t2' transform='translate(1715 460) scale(0.272 0.244)'/%3E%3Cuse href='%23s2' transform='translate(1715 460) scale(0.272 0.244)'/%3E%3Cuse href='%23t2' transform='translate(1798 435) scale(0.276 0.271)'/%3E%3Cuse href='%23s2' transform='translate(1798 435) scale(0.276 0.271)'/%3E%3Cuse href='%23t2' transform='translate(1850 448) scale(-0.236 0.264)'/%3E%3Cuse href='%23s2' transform='translate(1850 448) scale(-0.236 0.264)'/%3E%3Cuse href='%23t0' transform='translate(1891 440) scale(-0.278 0.260)'/%3E%3Cuse href='%23s0' transform='translate(1891 440) scale(-0.278 0.260)'/%3E%3Cuse href='%23t2' transform='translate(1927 533) scale(0.158 0.178)'/%3E%3Cuse href='%23s2' transform='translate(1927 533) scale(0.158 0.178)'/%3E%3Cuse href='%23t1' transform='translate(1969 469) scale(0.249 0.238)'/%3E%3Cuse href='%23s1' transform='translate(1969 469) scale(0.249 0.238)'/%3E%3Cuse href='%23t1' transform='translate(2042 493) scale(-0.226 0.219)'/%3E%3Cuse href='%23s1' transform='translate(2042 493) scale(-0.226 0.219)'/%3E%3Cuse href='%23t0' transform='translate(2082 469) scale(-0.259 0.238)'/%3E%3Cuse href='%23s0' transform='translate(2082 469) scale(-0.259 0.238)'/%3E%3Cuse href='%23t2' transform='translate(2142 449) scale(0.262 0.261)'/%3E%3Cuse href='%23s2' transform='translate(2142 449) scale(0.262 0.261)'/%3E%3Cuse href='%23t2' transform='translate(2194 385) scale(0.273 0.320)'/%3E%3Cuse href='%23s2' transform='translate(2194 385) scale(0.273 0.320)'/%3E%3Cuse href='%23t2' transform='translate(2242 416) scale(-0.298 0.296)'/%3E%3Cuse href='%23s2' transform='translate(2242 416) scale(-0.298 0.296)'/%3E%3Cuse href='%23t2' transform='translate(2279 516) scale(-0.201 0.184)'/%3E%3Cuse href='%23s2' transform='translate(2279 516) scale(-0.201 0.184)'/%3E%3Cuse href='%23t1' transform='translate(2352 422) scale(-0.315 0.285)'/%3E%3Cuse href='%23s1' transform='translate(2352 422) scale(-0.315 0.285)'/%3E%3C/g%3E%3C/svg%3E\") left bottom / auto 100% repeat-x;\n}\n.aur-root[data-fx=\"blackmetal\"] .aur-fx-b::after {\ncontent: \"\";\nposition: absolute;\nleft: -25%;\nright: -25%;\nbottom: -7vh;\nheight: 44vh;\nbackground:\nradial-gradient(18% 11% at 39% 38%, rgba(186, 199, 211, 0.075), transparent 70%),\nradial-gradient(20% 21% at 83% 68%, rgba(186, 199, 211, 0.088), transparent 70%),\nradial-gradient(23% 13% at 14% 35%, rgba(186, 199, 211, 0.087), transparent 70%),\nradial-gradient(29% 20% at 84% 70%, rgba(186, 199, 211, 0.085), transparent 70%),\nradial-gradient(19% 18% at 76% 73%, rgba(186, 199, 211, 0.140), transparent 70%),\nradial-gradient(15% 17% at 69% 55%, rgba(186, 199, 211, 0.084), transparent 70%),\nradial-gradient(22% 11% at 98% 73%, rgba(186, 199, 211, 0.114), transparent 70%),\nradial-gradient(19% 21% at 58% 74%, rgba(186, 199, 211, 0.138), transparent 70%),\nradial-gradient(22% 15% at 61% 52%, rgba(186, 199, 211, 0.083), transparent 70%),\nradial-gradient(19% 20% at -0% 32%, rgba(186, 199, 211, 0.120), transparent 70%),\nradial-gradient(18% 16% at 47% 47%, rgba(186, 199, 211, 0.150), transparent 70%),\nradial-gradient(17% 15% at 17% 62%, rgba(186, 199, 211, 0.092), transparent 70%);\ntransform-origin: 50% 100%;\nanimation: aur-bm-fog 90s steps(2700) infinite alternate;\n}\n@keyframes aur-bm-fog { from { transform: translate3d(-6%, 0, 0); } to { transform: translate3d(6%, 0, 0); } }\n.aur-root[data-fx=\"blackmetal\"] .aur-fx-c {\ndisplay: block;\ninset: 0;\nbackground:\nradial-gradient(ellipse at 50% 44%, transparent 42%, rgba(1, 2, 3, 0.6) 82%, rgba(1, 2, 3, 0.86) 100%),\nurl(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 900 1400'%3E%3Cdefs%3E%3Cpath id='t0' d='M0 0 -17 102 -13 96 -10 97 -7 95 -4 103 -33 162 -26 157 -20 167 -16 159 -8 166 -52 236 -40 228 -33 234 -25 218 -15 232 -61 304 -49 286 -38 295 -30 287 -18 299 -90 369 -68 360 -56 369 -43 358 -27 368 -99 442 -77 428 -62 441 -44 424 -26 437 -103 510 -81 498 -61 511 -50 495 -24 508 -112 584 -88 574 -70 583 -50 568 -31 580 -149 665 -115 645 -89 656 -68 639 -39 652 -148 742 -114 717 -88 734 -70 717 -35 725 -162 809 -127 787 -95 803 -73 785 -48 798 -157 879 -118 868 -98 880 -77 864 -38 872 -218 966 -161 941 -128 959 -105 941 -61 947 -14 950 -14 1000 14 1000 14 950 49 947 76 934 107 953 123 938 170 962 43 872 78 862 108 882 133 864 176 888 33 798 71 787 97 804 117 794 157 806 28 725 65 718 86 727 109 722 137 739 34 652 69 644 99 658 124 649 156 663 29 580 60 574 70 587 96 569 121 586 31 508 55 495 77 511 91 502 122 510 27 437 45 426 59 440 73 428 98 440 15 368 34 358 45 365 59 360 74 369 13 299 29 286 37 298 47 286 62 297 11 232 26 225 32 227 42 224 54 230 10 166 18 154 25 164 28 155 39 162 5 103 10 94 13 103 16 91 20 101Z'/%3E%3Cpath id='s0' d='M0 0Q-12 43 -17 102 M-8 166Q-38 194 -52 236 M-27 368Q-71 401 -99 442 M-26 437Q-69 467 -103 510 M-24 508Q-72 542 -112 584 M-31 580Q-94 616 -149 665 M-35 725Q-106 764 -162 809 M-38 872Q-134 913 -218 966 M0 0Q12 44 20 101 M5 103Q26 129 39 162 M10 166Q38 193 54 230 M13 299Q49 328 74 369 M31 508Q84 539 121 586 M29 580Q96 616 156 663 M34 652Q89 692 137 739 M28 725Q98 759 157 806 M33 798Q112 836 176 888' fill='none' stroke='%23c9d4dd' stroke-width='5' stroke-linecap='round' stroke-opacity='0.36'/%3E%3Cpath id='t1' d='M0 0 -18 103 -15 92 -12 102 -9 89 -4 103 -40 163 -30 161 -24 163 -18 159 -10 166 -51 236 -39 222 -31 233 -23 222 -13 232 -70 299 -51 296 -45 295 -33 290 -17 299 -91 366 -71 363 -56 368 -41 354 -24 368 -90 438 -67 425 -56 440 -42 430 -21 437 -119 513 -90 501 -73 511 -52 496 -35 508 -106 587 -83 570 -66 587 -52 569 -22 580 -148 657 -111 644 -91 655 -70 640 -31 652 -136 736 -100 719 -82 733 -67 719 -33 725 -166 808 -131 791 -98 809 -74 788 -46 798 -164 891 -129 866 -98 877 -76 866 -36 872 -217 969 -160 943 -131 956 -98 939 -60 947 -14 950 -14 1000 14 1000 14 950 55 947 95 941 120 955 160 944 203 954 43 872 77 867 93 879 118 866 156 888 42 798 77 792 92 802 124 792 156 816 37 725 76 713 103 733 123 721 166 733 32 652 57 642 79 654 93 650 125 658 27 580 51 572 74 583 88 576 115 585 30 508 49 499 58 511 76 503 100 511 25 437 47 427 59 438 79 432 99 440 18 368 34 357 44 369 56 360 72 369 18 299 31 289 37 297 47 287 63 298 13 232 25 223 35 229 42 227 57 231 9 166 18 159 22 166 27 156 38 169 5 103 8 95 11 104 14 99 18 100Z'/%3E%3Cpath id='s1' d='M0 0Q-14 45 -18 103 M-13 232Q-48 258 -70 299 M-17 299Q-57 327 -91 366 M-24 368Q-62 395 -90 438 M-35 508Q-76 545 -106 587 M-22 580Q-88 612 -148 657 M-46 798Q-109 843 -164 891 M-36 872Q-134 916 -217 969 M0 0Q12 44 18 100 M5 103Q28 129 38 169 M13 232Q46 258 63 298 M18 299Q53 327 72 369 M30 508Q79 539 115 585 M32 652Q102 691 166 733 M37 725Q104 764 156 816 M42 798Q102 840 156 888' fill='none' stroke='%23c9d4dd' stroke-width='5' stroke-linecap='round' stroke-opacity='0.36'/%3E%3Cpath id='t2' d='M0 0 -19 98 -14 92 -12 102 -9 89 -5 103 -40 164 -29 154 -25 165 -19 157 -10 166 -52 231 -39 220 -31 234 -25 222 -11 232 -73 299 -57 290 -46 299 -33 286 -19 299 -93 371 -74 363 -54 370 -45 358 -21 368 -103 442 -81 430 -60 438 -45 431 -30 437 -107 510 -82 503 -63 510 -54 499 -26 508 -113 582 -90 573 -69 586 -55 567 -24 580 -128 667 -96 649 -78 654 -64 645 -38 652 -155 738 -114 716 -99 732 -73 717 -32 725 -162 811 -124 797 -96 807 -74 788 -43 798 -199 888 -153 871 -123 877 -97 861 -53 872 -189 956 -136 944 -117 954 -92 938 -46 947 -14 950 -14 1000 14 1000 14 950 61 947 100 941 129 953 172 942 218 962 39 872 76 861 99 878 117 868 158 886 42 798 66 792 84 803 115 797 144 809 39 725 62 712 84 732 99 715 136 742 34 652 63 644 83 661 104 641 138 656 29 580 65 568 80 583 106 569 133 589 30 508 47 501 61 512 77 498 104 515 26 437 52 424 62 442 77 430 106 447 18 368 39 360 48 366 63 357 79 376 18 299 28 289 37 295 51 291 64 298 13 232 26 217 37 233 44 225 58 233 8 166 17 154 24 160 30 158 38 166 4 103 8 88 9 101 12 95 16 99Z'/%3E%3Cpath id='s2' d='M0 0Q-12 46 -19 98 M-5 103Q-30 129 -40 164 M-10 166Q-38 196 -52 231 M-19 299Q-62 332 -93 371 M-21 368Q-69 401 -103 442 M-30 437Q-74 471 -107 510 M-26 508Q-74 540 -113 582 M-24 580Q-83 616 -128 667 M-43 798Q-129 841 -199 888 M0 0Q14 45 16 99 M4 103Q25 132 38 166 M13 232Q43 262 64 298 M18 299Q54 332 79 376 M30 508Q86 544 133 589 M34 652Q89 691 136 742 M39 725Q99 763 144 809 M42 798Q107 835 158 886 M39 872Q136 910 218 962' fill='none' stroke='%23c9d4dd' stroke-width='5' stroke-linecap='round' stroke-opacity='0.36'/%3E%3C/defs%3E%3Cg fill='%23030405'%3E%3Cuse href='%23t1' transform='translate(1 238) scale(1.169 1.172)'/%3E%3Cuse href='%23s1' transform='translate(1 238) scale(1.169 1.172)'/%3E%3Cuse href='%23t0' transform='translate(316 404) scale(1.039 1.006)'/%3E%3Cuse href='%23s0' transform='translate(316 404) scale(1.039 1.006)'/%3E%3Cuse href='%23t1' transform='translate(496 706) scale(0.752 0.704)'/%3E%3Cuse href='%23s1' transform='translate(496 706) scale(0.752 0.704)'/%3E%3Cuse href='%23t0' transform='translate(645 865) scale(-0.541 0.545)'/%3E%3Cuse href='%23s0' transform='translate(645 865) scale(-0.541 0.545)'/%3E%3Cuse href='%23t0' transform='translate(805 1124) scale(-0.245 0.286)'/%3E%3Cuse href='%23s0' transform='translate(805 1124) scale(-0.245 0.286)'/%3E%3C/g%3E%3C/svg%3E\") left bottom / auto 76vh no-repeat,\nurl(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 900 1400'%3E%3Cdefs%3E%3Cpath id='t0' d='M0 0 -17 102 -13 96 -10 97 -7 95 -4 103 -33 162 -26 157 -20 167 -16 159 -8 166 -52 236 -40 228 -33 234 -25 218 -15 232 -61 304 -49 286 -38 295 -30 287 -18 299 -90 369 -68 360 -56 369 -43 358 -27 368 -99 442 -77 428 -62 441 -44 424 -26 437 -103 510 -81 498 -61 511 -50 495 -24 508 -112 584 -88 574 -70 583 -50 568 -31 580 -149 665 -115 645 -89 656 -68 639 -39 652 -148 742 -114 717 -88 734 -70 717 -35 725 -162 809 -127 787 -95 803 -73 785 -48 798 -157 879 -118 868 -98 880 -77 864 -38 872 -218 966 -161 941 -128 959 -105 941 -61 947 -14 950 -14 1000 14 1000 14 950 49 947 76 934 107 953 123 938 170 962 43 872 78 862 108 882 133 864 176 888 33 798 71 787 97 804 117 794 157 806 28 725 65 718 86 727 109 722 137 739 34 652 69 644 99 658 124 649 156 663 29 580 60 574 70 587 96 569 121 586 31 508 55 495 77 511 91 502 122 510 27 437 45 426 59 440 73 428 98 440 15 368 34 358 45 365 59 360 74 369 13 299 29 286 37 298 47 286 62 297 11 232 26 225 32 227 42 224 54 230 10 166 18 154 25 164 28 155 39 162 5 103 10 94 13 103 16 91 20 101Z'/%3E%3Cpath id='s0' d='M0 0Q-12 43 -17 102 M-8 166Q-38 194 -52 236 M-27 368Q-71 401 -99 442 M-26 437Q-69 467 -103 510 M-24 508Q-72 542 -112 584 M-31 580Q-94 616 -149 665 M-35 725Q-106 764 -162 809 M-38 872Q-134 913 -218 966 M0 0Q12 44 20 101 M5 103Q26 129 39 162 M10 166Q38 193 54 230 M13 299Q49 328 74 369 M31 508Q84 539 121 586 M29 580Q96 616 156 663 M34 652Q89 692 137 739 M28 725Q98 759 157 806 M33 798Q112 836 176 888' fill='none' stroke='%23c9d4dd' stroke-width='5' stroke-linecap='round' stroke-opacity='0.36'/%3E%3Cpath id='t1' d='M0 0 -18 103 -15 92 -12 102 -9 89 -4 103 -40 163 -30 161 -24 163 -18 159 -10 166 -51 236 -39 222 -31 233 -23 222 -13 232 -70 299 -51 296 -45 295 -33 290 -17 299 -91 366 -71 363 -56 368 -41 354 -24 368 -90 438 -67 425 -56 440 -42 430 -21 437 -119 513 -90 501 -73 511 -52 496 -35 508 -106 587 -83 570 -66 587 -52 569 -22 580 -148 657 -111 644 -91 655 -70 640 -31 652 -136 736 -100 719 -82 733 -67 719 -33 725 -166 808 -131 791 -98 809 -74 788 -46 798 -164 891 -129 866 -98 877 -76 866 -36 872 -217 969 -160 943 -131 956 -98 939 -60 947 -14 950 -14 1000 14 1000 14 950 55 947 95 941 120 955 160 944 203 954 43 872 77 867 93 879 118 866 156 888 42 798 77 792 92 802 124 792 156 816 37 725 76 713 103 733 123 721 166 733 32 652 57 642 79 654 93 650 125 658 27 580 51 572 74 583 88 576 115 585 30 508 49 499 58 511 76 503 100 511 25 437 47 427 59 438 79 432 99 440 18 368 34 357 44 369 56 360 72 369 18 299 31 289 37 297 47 287 63 298 13 232 25 223 35 229 42 227 57 231 9 166 18 159 22 166 27 156 38 169 5 103 8 95 11 104 14 99 18 100Z'/%3E%3Cpath id='s1' d='M0 0Q-14 45 -18 103 M-13 232Q-48 258 -70 299 M-17 299Q-57 327 -91 366 M-24 368Q-62 395 -90 438 M-35 508Q-76 545 -106 587 M-22 580Q-88 612 -148 657 M-46 798Q-109 843 -164 891 M-36 872Q-134 916 -217 969 M0 0Q12 44 18 100 M5 103Q28 129 38 169 M13 232Q46 258 63 298 M18 299Q53 327 72 369 M30 508Q79 539 115 585 M32 652Q102 691 166 733 M37 725Q104 764 156 816 M42 798Q102 840 156 888' fill='none' stroke='%23c9d4dd' stroke-width='5' stroke-linecap='round' stroke-opacity='0.36'/%3E%3Cpath id='t2' d='M0 0 -19 98 -14 92 -12 102 -9 89 -5 103 -40 164 -29 154 -25 165 -19 157 -10 166 -52 231 -39 220 -31 234 -25 222 -11 232 -73 299 -57 290 -46 299 -33 286 -19 299 -93 371 -74 363 -54 370 -45 358 -21 368 -103 442 -81 430 -60 438 -45 431 -30 437 -107 510 -82 503 -63 510 -54 499 -26 508 -113 582 -90 573 -69 586 -55 567 -24 580 -128 667 -96 649 -78 654 -64 645 -38 652 -155 738 -114 716 -99 732 -73 717 -32 725 -162 811 -124 797 -96 807 -74 788 -43 798 -199 888 -153 871 -123 877 -97 861 -53 872 -189 956 -136 944 -117 954 -92 938 -46 947 -14 950 -14 1000 14 1000 14 950 61 947 100 941 129 953 172 942 218 962 39 872 76 861 99 878 117 868 158 886 42 798 66 792 84 803 115 797 144 809 39 725 62 712 84 732 99 715 136 742 34 652 63 644 83 661 104 641 138 656 29 580 65 568 80 583 106 569 133 589 30 508 47 501 61 512 77 498 104 515 26 437 52 424 62 442 77 430 106 447 18 368 39 360 48 366 63 357 79 376 18 299 28 289 37 295 51 291 64 298 13 232 26 217 37 233 44 225 58 233 8 166 17 154 24 160 30 158 38 166 4 103 8 88 9 101 12 95 16 99Z'/%3E%3Cpath id='s2' d='M0 0Q-12 46 -19 98 M-5 103Q-30 129 -40 164 M-10 166Q-38 196 -52 231 M-19 299Q-62 332 -93 371 M-21 368Q-69 401 -103 442 M-30 437Q-74 471 -107 510 M-26 508Q-74 540 -113 582 M-24 580Q-83 616 -128 667 M-43 798Q-129 841 -199 888 M0 0Q14 45 16 99 M4 103Q25 132 38 166 M13 232Q43 262 64 298 M18 299Q54 332 79 376 M30 508Q86 544 133 589 M34 652Q89 691 136 742 M39 725Q99 763 144 809 M42 798Q107 835 158 886 M39 872Q136 910 218 962' fill='none' stroke='%23c9d4dd' stroke-width='5' stroke-linecap='round' stroke-opacity='0.36'/%3E%3C/defs%3E%3Cg fill='%23030405'%3E%3Cuse href='%23t2' transform='translate(923 219) scale(-1.270 1.191)'/%3E%3Cuse href='%23s2' transform='translate(923 219) scale(-1.270 1.191)'/%3E%3Cuse href='%23t0' transform='translate(581 481) scale(-0.844 0.929)'/%3E%3Cuse href='%23s0' transform='translate(581 481) scale(-0.844 0.929)'/%3E%3Cuse href='%23t0' transform='translate(366 618) scale(-0.692 0.792)'/%3E%3Cuse href='%23s0' transform='translate(366 618) scale(-0.692 0.792)'/%3E%3Cuse href='%23t2' transform='translate(226 919) scale(0.489 0.491)'/%3E%3Cuse href='%23s2' transform='translate(226 919) scale(0.489 0.491)'/%3E%3Cuse href='%23t1' transform='translate(94 1126) scale(0.302 0.284)'/%3E%3Cuse href='%23s1' transform='translate(94 1126) scale(0.302 0.284)'/%3E%3C/g%3E%3C/svg%3E\") right bottom / auto 76vh no-repeat;\n}\n.aur-root[data-fx=\"blackmetal\"] .aur-fx-c::before {\ncontent: \"\";\nposition: absolute;\nleft: -25%;\nright: -25%;\nbottom: 0;\nheight: 30vh;\nbackground:\nradial-gradient(25% 24% at 10% 94%, rgba(186, 199, 211, 0.050), transparent 70%),\nradial-gradient(26% 32% at 4% 80%, rgba(186, 199, 211, 0.087), transparent 70%),\nradial-gradient(19% 24% at 72% 75%, rgba(186, 199, 211, 0.094), transparent 70%),\nradial-gradient(21% 22% at 7% 78%, rgba(186, 199, 211, 0.105), transparent 70%),\nradial-gradient(27% 30% at 37% 89%, rgba(186, 199, 211, 0.056), transparent 70%),\nradial-gradient(23% 29% at 75% 74%, rgba(186, 199, 211, 0.055), transparent 70%),\nradial-gradient(22% 21% at 26% 91%, rgba(186, 199, 211, 0.062), transparent 70%),\nradial-gradient(32% 32% at 1% 72%, rgba(186, 199, 211, 0.080), transparent 70%),\nradial-gradient(18% 25% at 95% 60%, rgba(186, 199, 211, 0.086), transparent 70%),\nlinear-gradient(to top, rgba(160, 174, 188, 0.1), transparent 70%);\nanimation: aur-bm-fog 70s steps(2100) infinite alternate-reverse;\n}\n.aur-root[data-fx=\"blackmetal\"] .aur-fx-c::after,\n.aur-root[data-fx=\"blackmetal\"] .aur-fx::after {\ncontent: \"\";\nposition: absolute;\nleft: -10%;\nright: -10%;\ntop: -520px;\nbottom: 0;\npointer-events: none;\n}\n.aur-root[data-fx=\"blackmetal\"] .aur-fx-c::after {\nbackground: radial-gradient(8.2px 8.2px at 252px 136px, rgba(235, 242, 248, 0.51), rgba(235, 242, 248, 0.18) 45%, transparent 100%),\nradial-gradient(5.0px 5.0px at 245px 395px, rgba(235, 242, 248, 0.48), rgba(235, 242, 248, 0.17) 45%, transparent 100%),\nradial-gradient(6.5px 6.5px at 142px 417px, rgba(235, 242, 248, 0.50), rgba(235, 242, 248, 0.18) 45%, transparent 100%),\nradial-gradient(7.9px 7.9px at 280px 355px, rgba(235, 242, 248, 0.43), rgba(235, 242, 248, 0.15) 45%, transparent 100%),\nradial-gradient(5.8px 5.8px at 419px 138px, rgba(235, 242, 248, 0.46), rgba(235, 242, 248, 0.16) 45%, transparent 100%);\nbackground-size: 520px 520px;\nanimation: aur-bm-snow-near 7s steps(210) infinite;\n}\n.aur-root[data-fx=\"blackmetal\"] .aur-fx::after {\nbackground:\nradial-gradient(2.1px 2.1px at 254px 302px, rgba(235, 242, 248, 0.76), transparent),\nradial-gradient(2.2px 2.2px at 9px 149px, rgba(235, 242, 248, 0.82), transparent),\nradial-gradient(2.3px 2.3px at 288px 36px, rgba(235, 242, 248, 0.73), transparent),\nradial-gradient(1.9px 1.9px at 174px 184px, rgba(235, 242, 248, 0.59), transparent),\nradial-gradient(1.5px 1.5px at 89px 293px, rgba(235, 242, 248, 0.58), transparent),\nradial-gradient(2.2px 2.2px at 255px 44px, rgba(235, 242, 248, 0.56), transparent),\nradial-gradient(2.1px 2.1px at 1px 279px, rgba(235, 242, 248, 0.54), transparent),\nradial-gradient(1.7px 1.7px at 314px 279px, rgba(235, 242, 248, 0.58), transparent),\nradial-gradient(1.8px 1.8px at 173px 217px, rgba(235, 242, 248, 0.84), transparent),\nradial-gradient(1.7px 1.7px at 221px 309px, rgba(235, 242, 248, 0.83), transparent),\nradial-gradient(2.3px 2.3px at 116px 53px, rgba(235, 242, 248, 0.60), transparent),\nradial-gradient(0.9px 0.9px at 40px 226px, rgba(235, 242, 248, 0.59), transparent),\nradial-gradient(0.9px 0.9px at 320px 67px, rgba(235, 242, 248, 0.37), transparent),\nradial-gradient(1.2px 1.2px at 145px 158px, rgba(235, 242, 248, 0.44), transparent),\nradial-gradient(0.9px 0.9px at 29px 75px, rgba(235, 242, 248, 0.55), transparent),\nradial-gradient(0.8px 0.8px at 130px 289px, rgba(235, 242, 248, 0.38), transparent),\nradial-gradient(1.0px 1.0px at 83px 317px, rgba(235, 242, 248, 0.33), transparent),\nradial-gradient(0.8px 0.8px at 121px 211px, rgba(235, 242, 248, 0.49), transparent),\nradial-gradient(1.0px 1.0px at 159px 208px, rgba(235, 242, 248, 0.51), transparent),\nradial-gradient(1.3px 1.3px at 45px 21px, rgba(235, 242, 248, 0.47), transparent),\nradial-gradient(1.4px 1.4px at 62px 303px, rgba(235, 242, 248, 0.45), transparent),\nradial-gradient(1.1px 1.1px at 282px 91px, rgba(235, 242, 248, 0.52), transparent),\nradial-gradient(1.0px 1.0px at 43px 245px, rgba(235, 242, 248, 0.56), transparent),\nradial-gradient(0.9px 0.9px at 225px 304px, rgba(235, 242, 248, 0.51), transparent),\nradial-gradient(1.3px 1.3px at 63px 48px, rgba(235, 242, 248, 0.45), transparent),\nradial-gradient(1.1px 1.1px at 23px 289px, rgba(235, 242, 248, 0.45), transparent),\nradial-gradient(1.1px 1.1px at 70px 78px, rgba(235, 242, 248, 0.51), transparent);\nbackground-size: 320px 320px;\nanimation: aur-bm-snow 12s steps(360) infinite;\n}\n.aur-root[data-fx=\"blackmetal\"][data-gap=\"on\"] .aur-fx-c::after { animation-duration: 3.5s; }\n.aur-root[data-fx=\"blackmetal\"][data-gap=\"on\"] .aur-fx::after { animation-duration: 5.5s; }\n@keyframes aur-bm-snow-near { to { transform: translate3d(-110px, 520px, 0); } }\n@keyframes aur-bm-snow { to { transform: translate3d(-50px, 320px, 0); } }\n.aur-root[data-fx=\"blackmetal\"] .aur-bg-grain { inset: -120px; opacity: 0.1; animation: aur-bm-grain 0.42s steps(1) infinite; }\n.aur-root[data-fx=\"blackmetal\"][data-bganim=\"off\"] .aur-bg-grain { animation: none; }\n@keyframes aur-bm-grain {\n0% { transform: translate3d(0, 0, 0); }\n25% { transform: translate3d(-47px, 31px, 0); }\n50% { transform: translate3d(29px, -53px, 0); }\n75% { transform: translate3d(-18px, -22px, 0); }\n}\n.aur-root[data-look=\"blackmetal\"] .aur-blob { filter: blur(var(--aur-bg-blur)) grayscale(1) sepia(0.25) hue-rotate(170deg) saturate(1.3) contrast(1.3) brightness(0.42); }\n.aur-root[data-look=\"blackmetal\"] :is(.aur-art, .aur-cover, .aur-message-art) { filter: grayscale(1) sepia(0.15) hue-rotate(170deg) contrast(1.18) brightness(0.9); }\n.aur-root[data-look=\"blackmetal\"] .aur-bg-gradient { filter: grayscale(1); }\n.aur-root[data-look=\"blackmetal\"] {\n--aur-glow-tint: #cfe0ee;\n--aur-green: #dfe8ef;\n--bm-specks: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='x'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.05' numOctaves='1' seed='4' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .06 0 0 0 0 .07 0 0 0 0 .09 3.4 0 0 0 -2.35'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23x)'/%3E%3C/svg%3E\");\n--bm-thorn: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 600 40'%3E%3Cg fill='%23eef3f6'%3E%3Cpath d='M20 20 Q160 18.4 300 17.6 Q440 18.4 580 20 Q440 21.6 300 22.4 Q160 21.6 20 20Z'/%3E%3Cpath d='M270.9 20 L254.9 7 L262.4 20Z'/%3E%3Cpath d='M239.9 20 L225.3 31.8 L232 20Z'/%3E%3Cpath d='M212.3 20 L199.2 9.4 L205 20Z'/%3E%3Cpath d='M183.3 20 L171.7 29.5 L176.7 20Z'/%3E%3Cpath d='M161 20 L150.8 11.7 L155 20Z'/%3E%3Cpath d='M133 20 L124.2 27.1 L127.7 20Z'/%3E%3Cpath d='M106 20 L98.7 14.1 L101.3 20Z'/%3E%3Cpath d='M77.7 20 L71.9 24.7 L73.7 20Z'/%3E%3Cpath d='M46 20 L41.7 16.5 L42.6 20Z'/%3E%3Cpath d='M328 20 L344 7 L336.5 20Z'/%3E%3Cpath d='M358.9 20 L373.4 31.8 L366.8 20Z'/%3E%3Cpath d='M384 20 L397.1 9.4 L391.2 20Z'/%3E%3Cpath d='M412.3 20 L423.9 29.5 L418.9 20Z'/%3E%3Cpath d='M441 20 L451.2 11.7 L447 20Z'/%3E%3Cpath d='M471.9 20 L480.6 27.1 L477.2 20Z'/%3E%3Cpath d='M497.7 20 L505 14.1 L502.4 20Z'/%3E%3Cpath d='M520.6 20 L526.4 24.7 L524.6 20Z'/%3E%3Cpath d='M550.3 20 L554.7 16.5 L553.7 20Z'/%3E%3Cpath d='M300 1 L304 16 L300 20 L296 16Z M300 39 L304 24 L300 20 L296 24Z M285 20 L296 17.5 L300 20 L296 22.5Z M315 20 L304 17.5 L300 20 L304 22.5Z'/%3E%3Cpath d='M300 20 L310 8 L303 18Z M300 20 L290 8 L297 18Z M300 20 L310 32 L303 22Z M300 20 L290 32 L297 22Z' opacity='.7'/%3E%3C/g%3E%3C/svg%3E\");\n--bm-frost: linear-gradient(180deg, #ffffff 8%, #edf3f7 55%, #b3c6d6 100%);\n}\n.aur-root[data-look=\"blackmetal\"][data-color=\"white\"] { --aur-hi: #e9eff3; }\n.aur-root[data-look=\"blackmetal\"][data-words=\"on\"] .aur-stage .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--bm-a: clamp(0, var(--e) * 2.2, 1);\ncolor: transparent;\nbackground-image:\nvar(--bm-specks),\nlinear-gradient(180deg, color-mix(in srgb, #ffffff calc(var(--bm-a) * 100%), rgba(150, 168, 186, 0.42)) 8%, color-mix(in srgb, #edf3f7 calc(var(--bm-a) * 100%), rgba(150, 168, 186, 0.38)) 55%, color-mix(in srgb, #b3c6d6 calc(var(--bm-a) * 100%), rgba(150, 168, 186, 0.34)) 100%);\nbackground-size: 160px 160px, 100% 100%;\n-webkit-background-clip: text;\nbackground-clip: text;\ntransform: translateY(calc(0.03em - var(--bm-a) * 0.05em)) scale(calc(0.965 + 0.035 * var(--bm-a)));\nfilter: blur(calc((1 - var(--bm-a)) * 0.05em)) drop-shadow(0 0 0.32em color-mix(in oklab, #bcd6ea calc(34% * var(--bm-a) * var(--aur-glow-k)), transparent));\n}\n.aur-root[data-look=\"blackmetal\"] .aur-stage .aur-line.is-active:not(.has-words) .aur-main,\n.aur-root[data-look=\"blackmetal\"][data-words=\"off\"] .aur-stage .aur-line.is-active .aur-main {\ncolor: transparent;\nbackground-image: var(--bm-specks), var(--bm-frost);\nbackground-size: 160px 160px, 100% 100%;\n-webkit-background-clip: text;\nbackground-clip: text;\ntext-shadow: none;\nfilter: drop-shadow(0 0 0.32em rgba(188, 214, 234, 0.3));\n}\n.aur-root[data-look=\"blackmetal\"] .aur-stage[data-mode=\"synced\"] .aur-line:not(.is-gap) .aur-main::after {\ncontent: \"\";\nposition: absolute;\nleft: calc(var(--hx, 0px) + var(--hw, 100%) / 2 - 4.2em);\ntop: calc(var(--hy, 0px) + var(--hh, 100%) + 0.02em);\nwidth: 8.4em;\nheight: 0.56em;\nbackground: var(--bm-thorn) center / 100% 100% no-repeat;\nfilter: drop-shadow(0 0 0.2em rgba(190, 214, 234, 0.35));\nopacity: 0;\ntransform: scaleX(0.5);\ntransition: opacity 0.9s ease 0.15s, transform 1.2s var(--aur-ease) 0.15s;\npointer-events: none;\n}\n.aur-root[data-look=\"blackmetal\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active .aur-main::after { opacity: 0.85; transform: none; }\n.aur-root[data-look=\"blackmetal\"] .aur-dots { gap: 0.36em; }\n.aur-root[data-look=\"blackmetal\"] .aur-dots i { width: 2px; height: 0.6em; border-radius: 1px; background: linear-gradient(#fff, rgba(255, 255, 255, 0.15)); }\n.aur-root[data-fx=\"lounge\"] .aur-fx-a {\ndisplay: block;\ninset: 0;\nbackground: radial-gradient(ellipse at 28% 18%, rgba(255, 170, 90, 0.22), transparent 60%), linear-gradient(rgba(120, 60, 20, 0.1), rgba(40, 15, 5, 0.28));\nanimation: aur-fx-candle 6s ease-in-out infinite;\n}\n@keyframes aur-fx-candle {\n0%, 100% { opacity: 1; }\n12% { opacity: 0.88; }\n19% { opacity: 0.97; }\n34% { opacity: 0.84; }\n47% { opacity: 1; }\n63% { opacity: 0.9; }\n71% { opacity: 0.96; }\n86% { opacity: 0.86; }\n}\n.aur-root[data-fx=\"lounge\"] .aur-fx-b {\ndisplay: block;\ninset: -30% 0 0;\nbackground-image:\nradial-gradient(1.6px 1.6px at 40px 60px, rgba(255, 228, 196, 0.55), transparent),\nradial-gradient(1.2px 1.2px at 170px 210px, rgba(255, 228, 196, 0.45), transparent),\nradial-gradient(2px 2px at 260px 90px, rgba(255, 228, 196, 0.35), transparent),\nradial-gradient(1.3px 1.3px at 110px 280px, rgba(255, 228, 196, 0.4), transparent);\nbackground-size: 320px 320px;\nanimation: aur-fx-rise 60s linear infinite;\n}\n@keyframes aur-fx-rise { to { transform: translateY(-320px); } }\n.aur-root[data-fx=\"lounge\"] .aur-fx-c {\ndisplay: block;\ninset: -25%;\nbackground:\nradial-gradient(30% 18% at 30% 60%, rgba(255, 225, 190, 0.1), transparent 70%),\nradial-gradient(26% 14% at 68% 40%, rgba(255, 215, 175, 0.08), transparent 70%),\nradial-gradient(40% 20% at 50% 78%, rgba(255, 230, 200, 0.07), transparent 70%);\nopacity: 0.8;\ntransition: opacity 3s ease;\nanimation: aur-fx-smoke 45s ease-in-out infinite alternate;\n}\n.aur-root[data-fx=\"lounge\"][data-gap=\"on\"] .aur-fx-c { opacity: 1; }\n.aur-root[data-fx=\"lounge\"][data-bganim=\"on\"][data-lb=\"a\"] .aur-fx-c { animation: aur-fx-smoke 45s ease-in-out infinite alternate, aur-fx-stir-a 3s ease-out; }\n.aur-root[data-fx=\"lounge\"][data-bganim=\"on\"][data-lb=\"b\"] .aur-fx-c { animation: aur-fx-smoke 45s ease-in-out infinite alternate, aur-fx-stir-b 3s ease-out; }\n@keyframes aur-fx-smoke {\nfrom { transform: translate3d(-6%, 3%, 0) scale(1); }\nto { transform: translate3d(7%, -4%, 0) scale(1.15); }\n}\n@keyframes aur-fx-stir-a { from { opacity: 1; } }\n@keyframes aur-fx-stir-b { from { opacity: 1; } }\n.aur-root[data-look=\"lounge\"][data-color=\"white\"] { --aur-hi: #f7e8cf; }\n.aur-root[data-look=\"lounge\"] { --aur-glow-tint: color-mix(in oklab, #ffb070 55%, #fff); }\n@media (min-width: 900px) and (min-height: 540px) {\n.aur-root[data-look=\"lounge\"][data-view=\"vinyl\"] .aur-art-wrap::before,\n.aur-root[data-look=\"lounge\"][data-view=\"vinyl\"] .aur-art-wrap::after {\ncontent: \"\";\nposition: absolute;\nz-index: 2;\npointer-events: none;\n}\n.aur-root[data-look=\"lounge\"][data-view=\"vinyl\"] .aur-art-wrap::before {\nright: -5%;\ntop: -5%;\nwidth: 14%;\nheight: 14%;\nborder-radius: 50%;\nbackground: radial-gradient(circle at 40% 35%, #f3eee4, #9c968c 45%, #4a4640 72%, #2a2826);\nbox-shadow: 0 6px 16px rgba(0, 0, 0, 0.55), inset 0 0 0 1px rgba(255, 255, 255, 0.15);\n}\n.aur-root[data-look=\"lounge\"][data-view=\"vinyl\"] .aur-art-wrap::after {\nleft: 95%;\ntop: 2%;\nwidth: 6%;\nheight: 62%;\nborder-radius: 3px;\nbackground:\nlinear-gradient(#2c2c31, #3d3d44) bottom / 100% 11% no-repeat,\nlinear-gradient(90deg, transparent 38%, #8a857c 38%, #f1ece2 50%, #8a857c 62%, transparent 62%) top / 100% 90% no-repeat;\nfilter: drop-shadow(-6px 10px 8px rgba(0, 0, 0, 0.5));\ntransform-origin: 50% 0;\ntransform: rotate(18deg);\ntransition: transform 1.4s var(--aur-ease);\n}\n.aur-root[data-look=\"lounge\"][data-view=\"vinyl\"][data-playing=\"false\"] .aur-art-wrap::after { transform: rotate(-5deg); }\n}\n.aur-root[data-fx=\"retro\"] .aur-fx-a {\ndisplay: block;\ninset: 0;\nbackground: repeating-linear-gradient(to bottom, rgba(0, 0, 0, 0.3) 0 1px, transparent 1px 3px);\nopacity: 0.55;\nanimation: aur-fx-flicker 0.12s steps(2) infinite;\n}\n@keyframes aur-fx-flicker { 50% { opacity: 0.47; } }\n.aur-root[data-fx=\"retro\"] .aur-fx-b {\ndisplay: block;\ninset: 10px;\nborder-radius: 4.5vmin;\nbackground: radial-gradient(ellipse at 50% 45%, color-mix(in oklab, var(--aur-accent) 10%, transparent), transparent 65%), radial-gradient(ellipse at 50% 50%, transparent 55%, rgba(0, 0, 0, 0.6) 100%);\nbox-shadow:\n0 0 0 40px #050300,\ninset 0 0 3vmin color-mix(in oklab, var(--aur-accent) 12%, transparent),\ninset 0 0 0 1px color-mix(in oklab, var(--aur-accent) 10%, transparent);\n}\n.aur-root[data-fx=\"retro\"] .aur-fx-c {\ndisplay: block;\nleft: 0;\nright: 0;\ntop: 0;\nheight: 22%;\nbackground: linear-gradient(transparent, color-mix(in oklab, var(--aur-accent) 7%, transparent), transparent);\nanimation: aur-fx-roll 8s linear infinite;\n}\n@keyframes aur-fx-roll { from { transform: translateY(-30vh); } to { transform: translateY(130vh); } }\n.aur-root[data-fx=\"retro\"] .aur-bg-grain { opacity: 0.06; }\n.aur-root[data-look=\"retro\"] .aur-stage .aur-line .aur-main {\ntext-shadow:\n0 0 0.08em color-mix(in oklab, var(--aur-accent) 55%, transparent),\n0 0 0.45em color-mix(in oklab, var(--aur-accent) 22%, transparent);\n}\n.aur-root[data-look=\"retro\"][data-motion=\"full\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active .aur-main { animation: aur-fx-glitch 0.32s steps(1); }\n@keyframes aur-fx-glitch {\n0% { transform: translateX(0.06em); text-shadow: -0.05em 0 rgba(255, 40, 90, 0.7), 0.05em 0 rgba(40, 200, 255, 0.7); }\n25% { transform: translateX(-0.04em) skewX(-4deg); }\n50% { transform: translateX(0.02em); text-shadow: 0.03em 0 rgba(255, 40, 90, 0.5), -0.03em 0 rgba(40, 200, 255, 0.5); }\n75%, 100% { transform: none; }\n}\n.aur-root[data-look=\"retro\"][data-words=\"on\"][data-wordanim=\"typewriter\"] .is-active.has-words .aur-w .aur-c::after {\ntop: 0.12em;\nbottom: 0.06em;\nright: -0.6em;\nwidth: 0.52em;\nborder-radius: 0;\nbackground: color-mix(in oklab, var(--aur-accent) 75%, transparent);\n}\n.aur-root[data-look=\"retro\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active:not(.is-gap) .aur-main::after {\ncontent: \"\";\ndisplay: inline-block;\nwidth: 0.5em;\nheight: 0.82em;\nmargin-left: 0.12em;\nvertical-align: -0.08em;\nbackground: var(--aur-hi);\nbox-shadow: 0 0 0.3em color-mix(in oklab, var(--aur-accent) 50%, transparent);\nanimation: aur-fx-blink 1.05s steps(1) infinite;\n}\n.aur-root[data-look=\"retro\"][data-words=\"on\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active.has-words:not(.is-sung) .aur-main::after { opacity: 0; }\n@keyframes aur-fx-blink { 50% { background: transparent; box-shadow: none; } }\n.aur-root[data-look=\"retro\"] .aur-dots i { width: 0.34em; height: 0.56em; border-radius: 0; }\n@property --sw-ph { syntax: \"<number>\"; inherits: false; initial-value: 0; }\n.aur-root[data-fx=\"synthwave\"] {\n--sw-horizon: 74%;\n--sw-d: min(46vmin, 60vw);\n}\n.aur-root[data-fx=\"synthwave\"] .aur-fx {\nbackground: linear-gradient(\nto bottom,\nrgba(5, 3, 20, 0.9) 0%,\nrgba(20, 8, 52, 0.84) 30%,\nrgba(70, 14, 92, 0.76) 52%,\nrgba(170, 34, 118, 0.7) 66%,\nrgba(255, 96, 128, 0.72) calc(var(--sw-horizon) - 0.4%),\nrgba(12, 4, 30, 0.97) var(--sw-horizon),\nrgba(6, 2, 18, 0.98) 100%\n);\n}\n.aur-root[data-fx=\"synthwave\"] .aur-fx::before {\ncontent: \"\";\nposition: absolute;\ninset: 0 0 30% 0;\nbackground:\nradial-gradient(1px 1px at 24.8% 32.5%, rgba(255, 220, 250, 1), transparent),\nradial-gradient(0.8px 0.8px at 62.1% 5.7%, rgba(255, 220, 250, 0.9), transparent),\nradial-gradient(1.7px 1.7px at 54.9% 12.7%, rgba(210, 225, 255, 0.9), transparent),\nradial-gradient(1.7px 1.7px at 82.3% 28.7%, rgba(255, 255, 255, 0.6), transparent),\nradial-gradient(1.4px 1.4px at 62.9% 50.6%, rgba(210, 225, 255, 0.9), transparent),\nradial-gradient(1px 1px at 3.5% 45.5%, rgba(255, 255, 255, 1), transparent),\nradial-gradient(1px 1px at 30.9% 3.7%, rgba(210, 225, 255, 0.9), transparent),\nradial-gradient(1.7px 1.7px at 71.0% 51.2%, rgba(255, 220, 250, 0.9), transparent),\nradial-gradient(1px 1px at 71.9% 34.3%, rgba(255, 255, 255, 0.75), transparent),\nradial-gradient(1px 1px at 5.4% 29.7%, rgba(210, 225, 255, 0.9), transparent),\nradial-gradient(1.2px 1.2px at 84.1% 25.6%, rgba(255, 220, 250, 1), transparent),\nradial-gradient(1px 1px at 53.3% 24.8%, rgba(210, 225, 255, 0.75), transparent),\nradial-gradient(1px 1px at 89.9% 3.6%, rgba(210, 225, 255, 1), transparent),\nradial-gradient(1px 1px at 68.8% 41.1%, rgba(210, 225, 255, 1), transparent),\nradial-gradient(1px 1px at 56.6% 42.0%, rgba(255, 220, 250, 1), transparent),\nradial-gradient(1.7px 1.7px at 29.4% 5.6%, rgba(255, 255, 255, 0.9), transparent),\nradial-gradient(1px 1px at 35.0% 5.7%, rgba(255, 220, 250, 0.5), transparent),\nradial-gradient(0.8px 0.8px at 43.0% 25.3%, rgba(210, 225, 255, 0.5), transparent),\nradial-gradient(1.7px 1.7px at 61.0% 4.5%, rgba(255, 220, 250, 1), transparent),\nradial-gradient(1px 1px at 54.9% 53.6%, rgba(255, 255, 255, 1), transparent),\nradial-gradient(0.8px 0.8px at 97.9% 19.3%, rgba(210, 225, 255, 0.5), transparent),\nradial-gradient(1.2px 1.2px at 53.4% 55.1%, rgba(210, 225, 255, 0.75), transparent),\nradial-gradient(1px 1px at 27.3% 40.6%, rgba(255, 220, 250, 0.75), transparent),\nradial-gradient(1.2px 1.2px at 94.0% 52.2%, rgba(255, 220, 250, 0.9), transparent),\nradial-gradient(1.4px 1.4px at 85.5% 23.6%, rgba(255, 255, 255, 1), transparent),\nradial-gradient(1.4px 1.4px at 61.5% 54.7%, rgba(255, 220, 250, 0.75), transparent),\nradial-gradient(1px 1px at 62.9% 42.1%, rgba(255, 220, 250, 0.9), transparent),\nradial-gradient(0.8px 0.8px at 52.0% 32.7%, rgba(210, 225, 255, 0.9), transparent),\nradial-gradient(1.4px 1.4px at 32.2% 23.1%, rgba(255, 255, 255, 0.6), transparent),\nradial-gradient(1px 1px at 62.8% 20.6%, rgba(210, 225, 255, 0.75), transparent),\nradial-gradient(0.8px 0.8px at 69.9% 43.3%, rgba(255, 255, 255, 1), transparent),\nradial-gradient(1px 1px at 93.7% 3.2%, rgba(210, 225, 255, 0.75), transparent),\nradial-gradient(1px 1px at 45.8% 35.2%, rgba(255, 220, 250, 0.6), transparent),\nradial-gradient(1.4px 1.4px at 19.8% 44.5%, rgba(255, 220, 250, 0.75), transparent);\n-webkit-mask-image: linear-gradient(#000 40%, transparent 85%);\nmask-image: linear-gradient(#000 40%, transparent 85%);\nanimation: aur-sw-twinkle 7s steps(42) infinite alternate;\n}\n@keyframes aur-sw-twinkle { from { opacity: 0.55; } to { opacity: 0.95; } }\n.aur-root[data-fx=\"synthwave\"] .aur-fx-a {\ndisplay: block;\nleft: 50%;\nwidth: var(--sw-d);\nheight: calc(var(--sw-d) * 0.7);\nmargin-left: calc(var(--sw-d) / -2);\ntop: calc(var(--sw-horizon) - var(--sw-d) * 0.7);\noverflow: hidden;\n}\n.aur-root[data-fx=\"synthwave\"] .aur-fx-a::before {\ncontent: \"\";\nposition: absolute;\nleft: 0;\ntop: 0;\nwidth: 100%;\naspect-ratio: 1;\nborder-radius: 50%;\nbackground: linear-gradient(to bottom, #fff4b0 0%, #ffd86b 20%, #ffa04f 40%, #ff5a86 60%, #d92fc6 80%);\n-webkit-mask-image: linear-gradient(to bottom, #000 0 44%, transparent 44% 46%, #000 46% 52%, transparent 52% 55%, #000 55% 60%, transparent 60% 64%, #000 64% 68%, transparent 68% 73%);\nmask-image: linear-gradient(to bottom, #000 0 44%, transparent 44% 46%, #000 46% 52%, transparent 52% 55%, #000 55% 60%, transparent 60% 64%, #000 64% 68%, transparent 68% 73%);\nopacity: 0.86;\n}\n.aur-root[data-fx=\"synthwave\"] .aur-fx-b {\n--sw-line: color-mix(in oklab, var(--aur-accent) 78%, #fff);\n--sw-line-soft: color-mix(in oklab, var(--aur-accent) 30%, transparent);\ndisplay: block;\nleft: 0;\nright: 0;\ntop: var(--sw-horizon);\nbottom: 0;\nbackground:\nradial-gradient(22% 120% at 50% 0%, rgba(255, 130, 170, 0.22), transparent 70%),\nconic-gradient(from 0deg at 50% 0%, transparent 0deg, transparent 99.16deg, var(--sw-line-soft) 99.51deg, var(--sw-line) 99.51deg 99.79deg, var(--sw-line-soft) 99.79deg, transparent 100.14deg, transparent 99.89deg, var(--sw-line-soft) 100.24deg, var(--sw-line) 100.24deg 100.52deg, var(--sw-line-soft) 100.52deg, transparent 100.87deg, transparent 100.73deg, var(--sw-line-soft) 101.08deg, var(--sw-line) 101.08deg 101.36deg, var(--sw-line-soft) 101.36deg, transparent 101.71deg, transparent 101.72deg, var(--sw-line-soft) 102.07deg, var(--sw-line) 102.07deg 102.35deg, var(--sw-line-soft) 102.35deg, transparent 102.70deg, transparent 102.90deg, var(--sw-line-soft) 103.25deg, var(--sw-line) 103.25deg 103.53deg, var(--sw-line-soft) 103.53deg, transparent 103.88deg, transparent 104.33deg, var(--sw-line-soft) 104.68deg, var(--sw-line) 104.68deg 104.96deg, var(--sw-line-soft) 104.96deg, transparent 105.31deg, transparent 106.08deg, var(--sw-line-soft) 106.43deg, var(--sw-line) 106.43deg 106.71deg, var(--sw-line-soft) 106.71deg, transparent 107.06deg, transparent 108.30deg, var(--sw-line-soft) 108.65deg, var(--sw-line) 108.65deg 108.93deg, var(--sw-line-soft) 108.93deg, transparent 109.28deg, transparent 111.15deg, var(--sw-line-soft) 111.50deg, var(--sw-line) 111.50deg 111.78deg, var(--sw-line-soft) 111.78deg, transparent 112.13deg, transparent 114.97deg, var(--sw-line-soft) 115.32deg, var(--sw-line) 115.32deg 115.60deg, var(--sw-line-soft) 115.60deg, transparent 115.95deg, transparent 120.27deg, var(--sw-line-soft) 120.62deg, var(--sw-line) 120.62deg 120.90deg, var(--sw-line-soft) 120.90deg, transparent 121.25deg, transparent 127.95deg, var(--sw-line-soft) 128.30deg, var(--sw-line) 128.30deg 128.58deg, var(--sw-line-soft) 128.58deg, transparent 128.93deg, transparent 139.48deg, var(--sw-line-soft) 139.83deg, var(--sw-line) 139.83deg 140.11deg, var(--sw-line-soft) 140.11deg, transparent 140.46deg, transparent 156.73deg, var(--sw-line-soft) 157.08deg, var(--sw-line) 157.08deg 157.36deg, var(--sw-line-soft) 157.36deg, transparent 157.71deg, transparent 179.51deg, var(--sw-line-soft) 179.86deg, var(--sw-line) 179.86deg 180.14deg, var(--sw-line-soft) 180.14deg, transparent 180.49deg, transparent 202.29deg, var(--sw-line-soft) 202.64deg, var(--sw-line) 202.64deg 202.92deg, var(--sw-line-soft) 202.92deg, transparent 203.27deg, transparent 219.54deg, var(--sw-line-soft) 219.89deg, var(--sw-line) 219.89deg 220.17deg, var(--sw-line-soft) 220.17deg, transparent 220.52deg, transparent 231.07deg, var(--sw-line-soft) 231.42deg, var(--sw-line) 231.42deg 231.70deg, var(--sw-line-soft) 231.70deg, transparent 232.05deg, transparent 238.75deg, var(--sw-line-soft) 239.10deg, var(--sw-line) 239.10deg 239.38deg, var(--sw-line-soft) 239.38deg, transparent 239.73deg, transparent 244.05deg, var(--sw-line-soft) 244.40deg, var(--sw-line) 244.40deg 244.68deg, var(--sw-line-soft) 244.68deg, transparent 245.03deg, transparent 247.87deg, var(--sw-line-soft) 248.22deg, var(--sw-line) 248.22deg 248.50deg, var(--sw-line-soft) 248.50deg, transparent 248.85deg, transparent 250.72deg, var(--sw-line-soft) 251.07deg, var(--sw-line) 251.07deg 251.35deg, var(--sw-line-soft) 251.35deg, transparent 251.70deg, transparent 252.94deg, var(--sw-line-soft) 253.29deg, var(--sw-line) 253.29deg 253.57deg, var(--sw-line-soft) 253.57deg, transparent 253.92deg, transparent 254.69deg, var(--sw-line-soft) 255.04deg, var(--sw-line) 255.04deg 255.32deg, var(--sw-line-soft) 255.32deg, transparent 255.67deg, transparent 256.12deg, var(--sw-line-soft) 256.47deg, var(--sw-line) 256.47deg 256.75deg, var(--sw-line-soft) 256.75deg, transparent 257.10deg, transparent 257.30deg, var(--sw-line-soft) 257.65deg, var(--sw-line) 257.65deg 257.93deg, var(--sw-line-soft) 257.93deg, transparent 258.28deg, transparent 258.29deg, var(--sw-line-soft) 258.64deg, var(--sw-line) 258.64deg 258.92deg, var(--sw-line-soft) 258.92deg, transparent 259.27deg, transparent 259.13deg, var(--sw-line-soft) 259.48deg, var(--sw-line) 259.48deg 259.76deg, var(--sw-line-soft) 259.76deg, transparent 260.11deg, transparent 259.86deg, var(--sw-line-soft) 260.21deg, var(--sw-line) 260.21deg 260.49deg, var(--sw-line-soft) 260.49deg, transparent 260.84deg);\n-webkit-mask-image: linear-gradient(to bottom, rgba(0, 0, 0, 0.15), #000 45%);\nmask-image: linear-gradient(to bottom, rgba(0, 0, 0, 0.15), #000 45%);\nopacity: 0.85;\n}\n.aur-root[data-fx=\"synthwave\"] .aur-fx-b::before {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground:\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (1 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (1 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (1 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (1 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (1 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (1 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (1 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (1 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (1 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (1 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (1 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (1 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (1 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (2 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (2 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (2 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (2 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (2 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (2 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (2 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (2 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (2 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (2 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (2 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (2 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (2 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (3 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (3 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (3 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (3 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (3 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (3 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (3 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (3 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (3 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (3 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (3 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (3 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (3 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (4 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (4 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (4 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (4 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (4 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (4 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (4 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (4 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (4 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (4 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (4 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (4 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (4 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (5 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (5 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (5 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (5 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (5 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (5 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (5 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (5 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (5 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (5 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (5 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (5 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (5 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (6 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (6 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (6 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (6 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (6 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (6 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (6 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (6 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (6 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (6 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (6 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (6 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (6 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (7 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (7 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (7 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (7 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (7 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (7 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (7 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (7 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (7 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (7 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (7 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (7 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (7 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (8 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (8 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (8 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (8 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (8 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (8 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (8 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (8 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (8 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (8 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (8 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (8 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (8 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (9 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (9 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (9 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (9 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (9 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (9 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (9 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (9 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (9 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (9 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (9 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (9 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (9 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (10 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (10 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (10 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (10 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (10 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (10 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (10 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (10 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (10 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (10 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (10 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (10 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (10 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (11 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (11 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (11 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (11 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (11 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (11 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (11 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (11 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (11 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (11 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (11 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (11 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (11 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (12 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (12 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (12 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (12 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (12 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (12 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (12 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (12 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (12 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (12 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (12 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (12 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (12 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (13 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (13 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (13 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (13 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (13 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (13 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (13 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (13 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (13 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (13 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (13 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (13 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (13 - var(--sw-ph)) * 0.36)) + 4px)),\nlinear-gradient(to bottom, transparent calc(calc(100% / (1 + (14 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (14 - var(--sw-ph)) * 0.36)) - 5px), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (14 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (14 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (14 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (14 - var(--sw-ph)) * 0.576)), transparent) calc(calc(100% / (1 + (14 - var(--sw-ph)) * 0.36)) - calc(0.6px + 2px / (1 + (14 - var(--sw-ph)) * 0.36))), color-mix(in srgb, var(--sw-line) calc(100% / (1 + (14 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (14 - var(--sw-ph)) * 0.36)), color-mix(in srgb, var(--sw-line-soft) calc(100% / (1 + (14 - var(--sw-ph)) * 0.576)), transparent) calc(100% / (1 + (14 - var(--sw-ph)) * 0.36)), transparent calc(calc(100% / (1 + (14 - var(--sw-ph)) * 0.36)) + 4px));\nanimation: aur-sw-grid 1.3s steps(40) infinite;\n}\n.aur-root[data-fx=\"synthwave\"][data-gap=\"on\"] .aur-fx-b::before { animation-duration: 0.65s; }\n@keyframes aur-sw-grid { to { --sw-ph: 1; } }\n.aur-root[data-fx=\"synthwave\"] .aur-fx-c {\ndisplay: block;\nleft: 0;\nright: 0;\ntop: var(--sw-horizon);\nheight: 1.5px;\nbackground: linear-gradient(90deg, transparent, color-mix(in oklab, var(--aur-accent) 50%, #fff) 20%, #fff 50%, color-mix(in oklab, var(--aur-accent) 50%, #fff) 80%, transparent);\nfilter: drop-shadow(0 -1px 0 color-mix(in oklab, var(--aur-accent) 55%, #fff)) drop-shadow(0 0 5px color-mix(in oklab, var(--aur-accent) 55%, transparent));\n}\n.aur-root[data-fx=\"synthwave\"] .aur-fx-c::before,\n.aur-root[data-fx=\"synthwave\"] .aur-fx-c::after {\ncontent: \"\";\nposition: absolute;\nleft: -1%;\nright: -1%;\nbottom: 100%;\n}\n.aur-root[data-fx=\"synthwave\"] .aur-fx-c::before {\nheight: 15vh;\nbackground: linear-gradient(to bottom, #3a1a6c, #1e0c40 70%, #170932);\nclip-path: polygon(0% 100%, 0.0% 28.7%, 3.0% 40.2%, 5.8% 42.9%, 9.5% 9.3%, 13.8% 8.0%, 17.7% 8.0%, 20.6% 8.0%, 25.9% 8.0%, 29.1% 17.7%, 34.8% 78.1%, 38.7% 81.5%, 41.4% 83.4%, 44.9% 81.9%, 47.8% 79.0%, 53.0% 79.7%, 57.5% 83.4%, 61.3% 81.5%, 64.0% 78.8%, 67.2% 72.0%, 71.2% 57.9%, 75.7% 54.3%, 79.2% 72.0%, 84.1% 52.6%, 88.5% 54.5%, 94.0% 71.9%, 97.5% 72.0%, 100% 100%);\n}\n.aur-root[data-fx=\"synthwave\"] .aur-fx-c::after {\nheight: 9vh;\nbackground: linear-gradient(to bottom, #1a0a34, #09040f);\nclip-path: polygon(0% 100%, 0.0% 32.9%, 6.3% 43.1%, 11.7% 22.0%, 18.5% 45.4%, 24.1% 45.8%, 28.4% 22.0%, 33.0% 100%, 67.0% 100%, 72.5% 28.5%, 76.1% 50.8%, 80.4% 30.5%, 83.9% 68.3%, 90.5% 88.0%, 96.5% 52.6%, 100% 100%);\n}\n.aur-root[data-fx=\"synthwave\"] .aur-fx::after {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground:\nradial-gradient(circle at 50% calc(var(--sw-horizon) - var(--sw-d) * 0.2), rgba(255, 130, 150, 0.2), rgba(255, 70, 170, 0.07) calc(var(--sw-d) * 0.62), transparent calc(var(--sw-d) * 1.05)),\nlinear-gradient(to bottom, transparent calc(var(--sw-horizon) - 8%), rgba(255, 80, 170, 0.14) calc(var(--sw-horizon) - 1%), rgba(255, 150, 200, 0.3) var(--sw-horizon), rgba(140, 40, 170, 0.14) calc(var(--sw-horizon) + 2.5%), transparent calc(var(--sw-horizon) + 10%));\nopacity: 0.85;\ntransition: opacity 2s ease;\n}\n.aur-root[data-fx=\"synthwave\"][data-gap=\"on\"] .aur-fx::after { opacity: 1; }\n.aur-root[data-fx=\"synthwave\"] .aur-bg-grain { opacity: 0.025; }\n.aur-root[data-look=\"synthwave\"] {\n--sw-chrome: linear-gradient(180deg, #f6fbff 0%, #cfe8ff 24%, #7fbcff 46%, #231650 50%, #3b1d6e 52%, #ff5fb4 58%, #ffb46e 80%, #fff0d8 100%);\n--sw-todo: #8f80c9;\n}\n.aur-root[data-look=\"synthwave\"][data-color=\"white\"] { --aur-hi: #d8cdff; }\n.aur-root[data-look=\"synthwave\"] .aur-stage {\n-webkit-mask-image: linear-gradient(to bottom, transparent 0, transparent 72px, #000 calc(72px + 12%), #000 50%, transparent 66%);\nmask-image: linear-gradient(to bottom, transparent 0, transparent 72px, #000 calc(72px + 12%), #000 50%, transparent 66%);\n}\n.aur-root[data-look=\"synthwave\"] .aur-stage .aur-main { transform: skewX(-8deg); }\n.aur-root[data-look=\"synthwave\"][data-words=\"on\"]:is([data-wordanim=\"fill\"], [data-wordanim=\"rise\"], [data-wordanim=\"karaoke\"], [data-wordanim=\"letters\"]) .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\n--edge: 0.35em;\ncolor: transparent;\nbackground-image: linear-gradient(90deg, transparent calc(var(--p) * (100% + var(--edge)) - var(--edge)), var(--sw-todo) calc(var(--p) * (100% + var(--edge)))), var(--sw-chrome);\n-webkit-background-clip: text;\nbackground-clip: text;\nfilter: drop-shadow(0 0.05em 0 color-mix(in srgb, #ff2d95 calc(var(--e) * 85%), transparent)) drop-shadow(0 0 0.3em color-mix(in oklab, var(--aur-accent) calc(var(--e) * 40%), transparent));\n}\n.aur-root[data-look=\"synthwave\"] .aur-stage .aur-line.is-active:not(.has-words) .aur-main,\n.aur-root[data-look=\"synthwave\"][data-words=\"off\"] .aur-stage .aur-line.is-active .aur-main {\ncolor: transparent;\nbackground-image: var(--sw-chrome);\n-webkit-background-clip: text;\nbackground-clip: text;\ntext-shadow: none;\nfilter: drop-shadow(0 0.05em 0 rgba(255, 45, 149, 0.85)) drop-shadow(0 0 0.3em color-mix(in oklab, var(--aur-accent) 40%, transparent));\n}\n.aur-root[data-look=\"synthwave\"] .aur-dots i { background: color-mix(in oklab, var(--aur-accent) 70%, #fff); box-shadow: 0 0 0.3em var(--aur-accent); }\n.aur-root[data-fx=\"zen\"] .aur-fx-a {\ndisplay: block;\ninset: -20%;\nbackground: radial-gradient(40% 40% at 50% 45%, color-mix(in oklab, var(--aur-accent) 20%, transparent), transparent 70%);\nopacity: 0.8;\ntransition: opacity 3s ease;\nanimation: aur-fx-breathe 14s ease-in-out infinite;\n}\n.aur-root[data-fx=\"zen\"][data-gap=\"on\"] .aur-fx-a { opacity: 1; }\n.aur-root[data-fx=\"zen\"] .aur-fx-b {\ndisplay: block;\nleft: 50%;\ntop: 45%;\nwidth: 70vmin;\nheight: 70vmin;\nmargin: -35vmin 0 0 -35vmin;\nborder-radius: 50%;\nbackground:\nradial-gradient(circle, transparent 60%, color-mix(in oklab, var(--aur-accent) 24%, transparent) 66%, transparent 71%),\nradial-gradient(circle, transparent 41%, color-mix(in oklab, var(--aur-accent) 14%, transparent) 46%, transparent 51%);\nopacity: 0;\n}\n.aur-root[data-fx=\"zen\"][data-bganim=\"on\"][data-lb=\"a\"] .aur-fx-b { animation: aur-fx-ripple-a 5s cubic-bezier(0.2, 0.6, 0.3, 1); }\n.aur-root[data-fx=\"zen\"][data-bganim=\"on\"][data-lb=\"b\"] .aur-fx-b { animation: aur-fx-ripple-b 5s cubic-bezier(0.2, 0.6, 0.3, 1); }\n@keyframes aur-fx-ripple-a { from { transform: scale(0.25); opacity: 0.9; } to { transform: scale(1.5); opacity: 0; } }\n@keyframes aur-fx-ripple-b { from { transform: scale(0.25); opacity: 0.9; } to { transform: scale(1.5); opacity: 0; } }\n.aur-root[data-fx=\"zen\"] .aur-fx-c {\ndisplay: block;\ninset: -400px 0 0 -100px;\nbackground-image:\nradial-gradient(3px 3px at 60px 80px, color-mix(in oklab, var(--aur-accent) 50%, #fff), transparent),\nradial-gradient(2px 2px at 250px 190px, rgba(255, 255, 255, 0.7), transparent),\nradial-gradient(2.5px 2.5px at 150px 330px, color-mix(in oklab, var(--aur-accent) 40%, #fff), transparent),\nradial-gradient(2px 2px at 40px 210px, rgba(255, 255, 255, 0.6), transparent),\nradial-gradient(3px 3px at 230px 60px, color-mix(in oklab, var(--aur-accent) 45%, #fff), transparent);\nbackground-size: 400px 400px, 400px 400px, 400px 400px, 290px 330px, 290px 330px;\nopacity: 0.35;\nanimation: aur-fx-motes 80s linear infinite;\n}\n@keyframes aur-fx-motes { to { transform: translate3d(100px, 400px, 0); } }\n.aur-root[data-fx=\"zen\"] .aur-bg-grain { opacity: 0.02; }\n.aur-root[data-look=\"zen\"][data-color=\"white\"] { --aur-hi: color-mix(in oklab, var(--aur-accent) 16%, #fff); }\n.aur-root[data-look=\"zen\"] .aur-stage .aur-line { letter-spacing: 0.015em; }\n.aur-root[data-look=\"zen\"][data-motion=\"full\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active .aur-main { animation: aur-fx-settle 1.8s var(--aur-ease); }\n@keyframes aur-fx-settle { from { opacity: 0.35; filter: blur(5px); } }\n.aur-root[data-fx=\"sunset\"] .aur-fx::before {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: linear-gradient(to bottom, rgba(60, 20, 90, 0.3), rgba(160, 50, 90, 0.18) 45%, rgba(255, 120, 60, 0.26) 71%, rgba(255, 150, 80, 0.3) 72%, rgba(40, 15, 45, 0.3) 73%);\n}\n.aur-root[data-fx=\"sunset\"] .aur-fx::after {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: linear-gradient(to bottom, #0b1030, rgba(20, 20, 60, 0.6) 70%, rgba(10, 10, 30, 0.5));\nopacity: calc(var(--aur-song, 0) * 0.5);\ntransition: opacity 1s linear;\n}\n.aur-root[data-fx=\"sunset\"] .aur-fx-a {\ndisplay: block;\nleft: -10%;\nright: -10%;\ntop: 30%;\nheight: 84%;\nbackground: radial-gradient(50% 50% at 50% 50%, rgba(255, 150, 70, 0.38), rgba(255, 80, 120, 0.16) 45%, transparent 75%);\ntranslate: 0 calc(var(--aur-song, 0) * 14vh);\nopacity: 0.85;\ntransition: translate 1s linear, opacity 3s ease;\nanimation: aur-fx-breathe 16s ease-in-out infinite;\n}\n.aur-root[data-fx=\"sunset\"][data-gap=\"on\"] .aur-fx-a { opacity: 1; }\n.aur-root[data-fx=\"sunset\"] .aur-fx-b {\ndisplay: block;\nleft: 0;\nright: 0;\ntop: 0;\nheight: 72%;\noverflow: hidden;\n}\n.aur-root[data-fx=\"sunset\"] .aur-fx-b::before {\ncontent: \"\";\nposition: absolute;\nleft: 50%;\nbottom: -8vmin;\nwidth: 34vmin;\nheight: 34vmin;\nmargin-left: -17vmin;\nborder-radius: 50%;\nbackground: radial-gradient(circle, #ffd9a0 0 30%, #ffb45e 48%, #ff8a4c 64%, rgba(255, 100, 80, 0) 71%);\nopacity: 0.6;\ntranslate: 0 calc(var(--aur-song, 0) * 26vmin);\ntransition: translate 1s linear;\n}\n.aur-root[data-fx=\"sunset\"][data-bganim=\"on\"][data-lb=\"a\"] .aur-fx-b::before { animation: aur-fx-sunglow-a 2.2s ease-out; }\n.aur-root[data-fx=\"sunset\"][data-bganim=\"on\"][data-lb=\"b\"] .aur-fx-b::before { animation: aur-fx-sunglow-b 2.2s ease-out; }\n@keyframes aur-fx-sunglow-a { from { opacity: 0.8; scale: 1.05; } }\n@keyframes aur-fx-sunglow-b { from { opacity: 0.8; scale: 1.05; } }\n.aur-root[data-fx=\"sunset\"] .aur-fx-c {\ndisplay: block;\nleft: 0;\nright: 0;\ntop: 72%;\nbottom: 0;\nbackground: linear-gradient(rgba(60, 25, 60, 0.35), rgba(15, 8, 25, 0.5));\n}\n.aur-root[data-fx=\"sunset\"] .aur-fx-c::before {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: repeating-linear-gradient(to bottom, transparent 0 7px, rgba(255, 190, 110, 0.55) 7px 9px, transparent 9px 13px, rgba(255, 150, 90, 0.35) 13px 14px);\n-webkit-mask-image: radial-gradient(22% 120% at 50% 0%, #000 20%, transparent 100%);\nmask-image: radial-gradient(22% 120% at 50% 0%, #000 20%, transparent 100%);\nopacity: calc(0.9 - var(--aur-song, 0) * 0.75);\ntransition: opacity 1s linear;\nanimation: aur-fx-glitter 1.8s steps(4) infinite;\n}\n@keyframes aur-fx-glitter { to { background-position: 0 14px; } }\n.aur-root[data-look=\"sunset\"] { --aur-glow-tint: color-mix(in oklab, #ffb46b 60%, #fff); }\n.aur-root[data-fx=\"midnight\"] :is(.aur-fx-a, .aur-fx-b) {\ndisplay: block;\ninset: 0;\nbackground-image:\nradial-gradient(1.3px 1.3px at 30px 40px, rgba(255, 255, 255, 0.9), transparent),\nradial-gradient(1px 1px at 120px 150px, rgba(255, 255, 255, 0.7), transparent),\nradial-gradient(1.6px 1.6px at 260px 70px, rgba(220, 230, 255, 0.85), transparent),\nradial-gradient(1px 1px at 330px 260px, rgba(255, 255, 255, 0.6), transparent),\nradial-gradient(1.2px 1.2px at 190px 330px, rgba(255, 255, 255, 0.75), transparent),\nradial-gradient(0.9px 0.9px at 70px 250px, rgba(255, 255, 255, 0.6), transparent);\nbackground-size: 380px 380px;\nopacity: 0.55;\nanimation: aur-fx-twinkle 5s ease-in-out infinite alternate;\n}\n.aur-root[data-fx=\"midnight\"] .aur-fx-b { background-size: 260px 260px; background-position: 90px 130px; animation-duration: 7s; animation-delay: -3s; }\n.aur-root[data-fx=\"midnight\"][data-bganim=\"on\"][data-lb=\"a\"] .aur-fx-b { animation: aur-fx-twinkle 7s ease-in-out -3s infinite alternate, aur-fx-starflare-a 1.6s ease-out; }\n.aur-root[data-fx=\"midnight\"][data-bganim=\"on\"][data-lb=\"b\"] .aur-fx-b { animation: aur-fx-twinkle 7s ease-in-out -3s infinite alternate, aur-fx-starflare-b 1.6s ease-out; }\n@keyframes aur-fx-twinkle { from { opacity: 0.4; } to { opacity: 0.95; } }\n@keyframes aur-fx-starflare-a { from { opacity: 1; } }\n@keyframes aur-fx-starflare-b { from { opacity: 1; } }\n.aur-root[data-fx=\"midnight\"] .aur-fx-c {\ndisplay: block;\nright: 7%;\ntop: 3%;\nwidth: 8vmin;\nheight: 8vmin;\nborder-radius: 50%;\nbox-shadow: inset -1.9vmin 1.1vmin 0 0 #eef2ff;\nfilter: drop-shadow(0 0 1.6vmin rgba(200, 220, 255, 0.55));\nrotate: -18deg;\ntranslate: 0 calc((1 - var(--aur-song, 0)) * 12vh);\ntransition: translate 1s linear;\n}\n.aur-root[data-fx=\"midnight\"] .aur-fx-c::before {\ncontent: \"\";\nposition: absolute;\ninset: -260%;\nborder-radius: 50%;\nbackground: radial-gradient(circle, rgba(200, 220, 255, 0.16), transparent 60%);\n}\n.aur-root[data-fx=\"midnight\"] .aur-fx::after {\ncontent: \"\";\nposition: absolute;\ntop: 0;\nbottom: 30%;\nleft: -60%;\nright: -60%;\nbackground:\nradial-gradient(18% 7% at 30% 28%, rgba(16, 22, 48, 0.55), transparent 70%),\nradial-gradient(14% 5% at 38% 31%, rgba(16, 22, 48, 0.45), transparent 70%),\nradial-gradient(20% 6% at 72% 18%, rgba(16, 22, 48, 0.5), transparent 70%);\nanimation: aur-fx-clouds 140s linear infinite alternate;\n}\n@keyframes aur-fx-clouds { from { transform: translate3d(-18%, 0, 0); } to { transform: translate3d(18%, 0, 0); } }\n.aur-root[data-fx=\"midnight\"] .aur-fx::before {\ncontent: \"\";\nposition: absolute;\nleft: 72%;\ntop: 8%;\nwidth: 180px;\nheight: 2px;\nborder-radius: 2px;\nbackground: linear-gradient(90deg, #fff, rgba(200, 220, 255, 0.5) 30%, transparent);\nrotate: -28deg;\ntransform-origin: 0 50%;\nopacity: 0;\nanimation: aur-fx-meteor 13s ease-in infinite;\n}\n.aur-root[data-fx=\"midnight\"][data-gap=\"on\"] .aur-fx::before { animation-duration: 5s; }\n@keyframes aur-fx-meteor {\n0%, 90% { opacity: 0; transform: translateX(0) scaleX(0.3); }\n92% { opacity: 1; }\n100% { opacity: 0; transform: translateX(-40vw) scaleX(1); }\n}\n.aur-root[data-look=\"midnight\"] { --aur-glow-tint: color-mix(in oklab, #b9ccff 60%, #fff); }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx {\nbackground: linear-gradient(to bottom, rgba(38, 12, 92, 0.9) 0%, rgba(96, 42, 160, 0.8) 28%, rgba(255, 110, 200, 0.68) 55%, rgba(255, 190, 228, 0.82) 62%, rgba(20, 6, 50, 0.92) 62.2%, rgba(20, 6, 50, 0.92) 100%);\n}\n.aur-root[data-fx=\"vaporwave\"] .aur-fx::before {\ncontent: \"\";\nposition: absolute;\nleft: 50%;\ntop: 62%;\nwidth: 46vmin;\nheight: 46vmin;\nmargin: -30vmin 0 0 -23vmin;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 800' preserveAspectRatio='none'%3E%3Cdefs%3E%3ClinearGradient id='s' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%23fff2a0'/%3E%3Cstop offset='.4' stop-color='%23ff9ad0'/%3E%3Cstop offset='1' stop-color='%239a63ff'/%3E%3C/linearGradient%3E%3CradialGradient id='h'%3E%3Cstop offset='.62' stop-color='%23ff8ee0' stop-opacity='.35'/%3E%3Cstop offset='1' stop-color='%23ff8ee0' stop-opacity='0'/%3E%3C/radialGradient%3E%3C/defs%3E%3Ccircle cx='400' cy='400' r='400' fill='url(%23h)'/%3E%3Ccircle cx='400' cy='400' r='380' fill='url(%23s)'/%3E%3Cg fill='none' stroke='%237ff4ff' stroke-opacity='.5' stroke-width='2.2'%3E%3Cpath d='M148.7 115.0A251.3 38 0 0 0 651.3 115.0'/%3E%3Cpath d='M70.9 210.0A329.1 34 0 0 0 729.1 210.0'/%3E%3Cpath d='M32.1 305.0A367.9 30 0 0 0 767.9 305.0'/%3E%3Cpath d='M20.0 400.0A380.0 26 0 0 0 780.0 400.0'/%3E%3Cpath d='M32.1 495.0A367.9 30 0 0 0 767.9 495.0'/%3E%3Cpath d='M70.9 590.0A329.1 34 0 0 0 729.1 590.0'/%3E%3Cpath d='M148.7 685.0A251.3 38 0 0 0 651.3 685.0'/%3E%3Cellipse cx='400' cy='400' rx='63.3' ry='380'/%3E%3Cellipse cx='400' cy='400' rx='126.7' ry='380'/%3E%3Cellipse cx='400' cy='400' rx='190.0' ry='380'/%3E%3Cellipse cx='400' cy='400' rx='253.3' ry='380'/%3E%3Cellipse cx='400' cy='400' rx='316.7' ry='380'/%3E%3Ccircle cx='400' cy='400' r='380'/%3E%3C/g%3E%3C/svg%3E\") center / 100% 100% no-repeat;\nopacity: 0.88;\ntransition: opacity 3s ease;\n}\n.aur-root[data-fx=\"vaporwave\"][data-gap=\"on\"] .aur-fx::before { opacity: 1; }\n.aur-root[data-fx=\"vaporwave\"][data-bganim=\"on\"][data-lb=\"a\"] .aur-fx::before { animation: aur-fx-swell-a 1.6s ease-out; }\n.aur-root[data-fx=\"vaporwave\"][data-bganim=\"on\"][data-lb=\"b\"] .aur-fx::before { animation: aur-fx-swell-b 1.6s ease-out; }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-a {\ndisplay: block;\nleft: 0;\nright: 0;\ntop: 62%;\nbottom: 0;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 400' preserveAspectRatio='none'%3E%3Cdefs%3E%3ClinearGradient id='f' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%23ffb8ec' stop-opacity='.95'/%3E%3Cstop offset='.18' stop-color='%23ff8ee0' stop-opacity='.45'/%3E%3Cstop offset='.55' stop-color='%232a0f6b' stop-opacity='0'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath d='M800.0 0.0L800.0 0.0 795.8 0.9 795.4 0.9Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M800.0 0.0L800.0 0.0 796.3 0.9 795.8 0.9Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M800.0 0.0L800.0 0.0 796.8 0.9 796.3 0.9Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M800.0 0.0L800.0 0.0 797.2 0.9 796.8 0.9Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M800.0 0.0L800.0 0.0 797.7 0.9 797.2 0.9Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M800.0 0.0L800.0 0.0 798.2 0.9 797.7 0.9Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M800.0 0.0L800.0 0.0 798.6 0.9 798.2 0.9Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M800.0 0.0L800.0 0.0 799.1 0.9 798.6 0.9Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M800.0 0.0L800.0 0.0 799.5 0.9 799.1 0.9Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M800.0 0.0L800.0 0.0 800.0 0.9 799.5 0.9Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M800.0 0.0L800.0 0.0 800.5 0.9 800.0 0.9Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M800.0 0.0L800.0 0.0 800.9 0.9 800.5 0.9Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M800.0 0.0L800.0 0.0 801.4 0.9 800.9 0.9Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M800.0 0.0L800.0 0.0 801.8 0.9 801.4 0.9Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M800.0 0.0L800.0 0.0 802.3 0.9 801.8 0.9Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M800.0 0.0L800.0 0.0 802.8 0.9 802.3 0.9Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M800.0 0.0L800.0 0.0 803.2 0.9 802.8 0.9Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M800.0 0.0L800.0 0.0 803.7 0.9 803.2 0.9Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M800.0 0.0L800.0 0.0 804.2 0.9 803.7 0.9Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M800.0 0.0L800.0 0.0 804.6 0.9 804.2 0.9Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M795.4 0.9L795.8 0.9 779.5 4.6 777.2 4.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M795.8 0.9L796.3 0.9 781.8 4.6 779.5 4.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M796.3 0.9L796.8 0.9 784.1 4.6 781.8 4.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M796.8 0.9L797.2 0.9 786.3 4.6 784.1 4.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M797.2 0.9L797.7 0.9 788.6 4.6 786.3 4.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M797.7 0.9L798.2 0.9 790.9 4.6 788.6 4.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M798.2 0.9L798.6 0.9 793.2 4.6 790.9 4.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M798.6 0.9L799.1 0.9 795.4 4.6 793.2 4.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M799.1 0.9L799.5 0.9 797.7 4.6 795.4 4.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M799.5 0.9L800.0 0.9 800.0 4.6 797.7 4.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M800.0 0.9L800.5 0.9 802.3 4.6 800.0 4.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M800.5 0.9L800.9 0.9 804.6 4.6 802.3 4.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M800.9 0.9L801.4 0.9 806.8 4.6 804.6 4.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M801.4 0.9L801.8 0.9 809.1 4.6 806.8 4.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M801.8 0.9L802.3 0.9 811.4 4.6 809.1 4.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M802.3 0.9L802.8 0.9 813.7 4.6 811.4 4.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M802.8 0.9L803.2 0.9 815.9 4.6 813.7 4.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M803.2 0.9L803.7 0.9 818.2 4.6 815.9 4.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M803.7 0.9L804.2 0.9 820.5 4.6 818.2 4.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M804.2 0.9L804.6 0.9 822.8 4.6 820.5 4.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M777.2 4.6L779.5 4.6 747.9 11.6 742.1 11.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M779.5 4.6L781.8 4.6 753.7 11.6 747.9 11.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M781.8 4.6L784.1 4.6 759.5 11.6 753.7 11.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M784.1 4.6L786.3 4.6 765.3 11.6 759.5 11.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M786.3 4.6L788.6 4.6 771.1 11.6 765.3 11.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M788.6 4.6L790.9 4.6 776.9 11.6 771.1 11.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M790.9 4.6L793.2 4.6 782.6 11.6 776.9 11.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M793.2 4.6L795.4 4.6 788.4 11.6 782.6 11.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M795.4 4.6L797.7 4.6 794.2 11.6 788.4 11.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M797.7 4.6L800.0 4.6 800.0 11.6 794.2 11.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M800.0 4.6L802.3 4.6 805.8 11.6 800.0 11.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M802.3 4.6L804.6 4.6 811.6 11.6 805.8 11.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M804.6 4.6L806.8 4.6 817.4 11.6 811.6 11.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M806.8 4.6L809.1 4.6 823.1 11.6 817.4 11.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M809.1 4.6L811.4 4.6 828.9 11.6 823.1 11.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M811.4 4.6L813.7 4.6 834.7 11.6 828.9 11.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M813.7 4.6L815.9 4.6 840.5 11.6 834.7 11.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M815.9 4.6L818.2 4.6 846.3 11.6 840.5 11.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M818.2 4.6L820.5 4.6 852.1 11.6 846.3 11.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M820.5 4.6L822.8 4.6 857.9 11.6 852.1 11.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M742.1 11.6L747.9 11.6 699.1 22.4 687.9 22.4Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M747.9 11.6L753.7 11.6 710.3 22.4 699.1 22.4Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M753.7 11.6L759.5 11.6 721.5 22.4 710.3 22.4Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M759.5 11.6L765.3 11.6 732.7 22.4 721.5 22.4Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M765.3 11.6L771.1 11.6 743.9 22.4 732.7 22.4Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M771.1 11.6L776.9 11.6 755.2 22.4 743.9 22.4Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M776.9 11.6L782.6 11.6 766.4 22.4 755.2 22.4Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M782.6 11.6L788.4 11.6 777.6 22.4 766.4 22.4Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M788.4 11.6L794.2 11.6 788.8 22.4 777.6 22.4Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M794.2 11.6L800.0 11.6 800.0 22.4 788.8 22.4Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M800.0 11.6L805.8 11.6 811.2 22.4 800.0 22.4Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M805.8 11.6L811.6 11.6 822.4 22.4 811.2 22.4Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M811.6 11.6L817.4 11.6 833.6 22.4 822.4 22.4Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M817.4 11.6L823.1 11.6 844.8 22.4 833.6 22.4Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M823.1 11.6L828.9 11.6 856.1 22.4 844.8 22.4Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M828.9 11.6L834.7 11.6 867.3 22.4 856.1 22.4Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M834.7 11.6L840.5 11.6 878.5 22.4 867.3 22.4Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M840.5 11.6L846.3 11.6 889.7 22.4 878.5 22.4Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M846.3 11.6L852.1 11.6 900.9 22.4 889.7 22.4Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M852.1 11.6L857.9 11.6 912.1 22.4 900.9 22.4Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M687.9 22.4L699.1 22.4 631.4 37.5 612.7 37.5Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M699.1 22.4L710.3 22.4 650.2 37.5 631.4 37.5Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M710.3 22.4L721.5 22.4 668.9 37.5 650.2 37.5Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M721.5 22.4L732.7 22.4 687.6 37.5 668.9 37.5Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M732.7 22.4L743.9 22.4 706.3 37.5 687.6 37.5Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M743.9 22.4L755.2 22.4 725.1 37.5 706.3 37.5Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M755.2 22.4L766.4 22.4 743.8 37.5 725.1 37.5Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M766.4 22.4L777.6 22.4 762.5 37.5 743.8 37.5Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M777.6 22.4L788.8 22.4 781.3 37.5 762.5 37.5Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M788.8 22.4L800.0 22.4 800.0 37.5 781.3 37.5Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M800.0 22.4L811.2 22.4 818.7 37.5 800.0 37.5Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M811.2 22.4L822.4 22.4 837.5 37.5 818.7 37.5Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M822.4 22.4L833.6 22.4 856.2 37.5 837.5 37.5Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M833.6 22.4L844.8 22.4 874.9 37.5 856.2 37.5Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M844.8 22.4L856.1 22.4 893.7 37.5 874.9 37.5Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M856.1 22.4L867.3 22.4 912.4 37.5 893.7 37.5Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M867.3 22.4L878.5 22.4 931.1 37.5 912.4 37.5Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M878.5 22.4L889.7 22.4 949.8 37.5 931.1 37.5Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M889.7 22.4L900.9 22.4 968.6 37.5 949.8 37.5Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M900.9 22.4L912.1 22.4 987.3 37.5 968.6 37.5Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M612.7 37.5L631.4 37.5 543.6 57.0 515.1 57.0Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M631.4 37.5L650.2 37.5 572.1 57.0 543.6 57.0Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M650.2 37.5L668.9 37.5 600.6 57.0 572.1 57.0Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M668.9 37.5L687.6 37.5 629.1 57.0 600.6 57.0Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M687.6 37.5L706.3 37.5 657.6 57.0 629.1 57.0Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M706.3 37.5L725.1 37.5 686.0 57.0 657.6 57.0Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M725.1 37.5L743.8 37.5 714.5 57.0 686.0 57.0Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M743.8 37.5L762.5 37.5 743.0 57.0 714.5 57.0Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M762.5 37.5L781.3 37.5 771.5 57.0 743.0 57.0Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M781.3 37.5L800.0 37.5 800.0 57.0 771.5 57.0Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M800.0 37.5L818.7 37.5 828.5 57.0 800.0 57.0Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M818.7 37.5L837.5 37.5 857.0 57.0 828.5 57.0Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M837.5 37.5L856.2 37.5 885.5 57.0 857.0 57.0Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M856.2 37.5L874.9 37.5 914.0 57.0 885.5 57.0Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M874.9 37.5L893.7 37.5 942.4 57.0 914.0 57.0Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M893.7 37.5L912.4 37.5 970.9 57.0 942.4 57.0Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M912.4 37.5L931.1 37.5 999.4 57.0 970.9 57.0Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M931.1 37.5L949.8 37.5 1027.9 57.0 999.4 57.0Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M949.8 37.5L968.6 37.5 1056.4 57.0 1027.9 57.0Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M968.6 37.5L987.3 37.5 1084.9 57.0 1056.4 57.0Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M515.1 57.0L543.6 57.0 434.5 81.2 393.9 81.2Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M543.6 57.0L572.1 57.0 475.1 81.2 434.5 81.2Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M572.1 57.0L600.6 57.0 515.7 81.2 475.1 81.2Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M600.6 57.0L629.1 57.0 556.3 81.2 515.7 81.2Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M629.1 57.0L657.6 57.0 596.9 81.2 556.3 81.2Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M657.6 57.0L686.0 57.0 637.5 81.2 596.9 81.2Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M686.0 57.0L714.5 57.0 678.2 81.2 637.5 81.2Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M714.5 57.0L743.0 57.0 718.8 81.2 678.2 81.2Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M743.0 57.0L771.5 57.0 759.4 81.2 718.8 81.2Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M771.5 57.0L800.0 57.0 800.0 81.2 759.4 81.2Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M800.0 57.0L828.5 57.0 840.6 81.2 800.0 81.2Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M828.5 57.0L857.0 57.0 881.2 81.2 840.6 81.2Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M857.0 57.0L885.5 57.0 921.8 81.2 881.2 81.2Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M885.5 57.0L914.0 57.0 962.5 81.2 921.8 81.2Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M914.0 57.0L942.4 57.0 1003.1 81.2 962.5 81.2Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M942.4 57.0L970.9 57.0 1043.7 81.2 1003.1 81.2Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M970.9 57.0L999.4 57.0 1084.3 81.2 1043.7 81.2Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M999.4 57.0L1027.9 57.0 1124.9 81.2 1084.3 81.2Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1027.9 57.0L1056.4 57.0 1165.5 81.2 1124.9 81.2Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M1056.4 57.0L1084.9 57.0 1206.1 81.2 1165.5 81.2Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M393.9 81.2L434.5 81.2 303.1 110.4 247.9 110.4Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M434.5 81.2L475.1 81.2 358.3 110.4 303.1 110.4Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M475.1 81.2L515.7 81.2 413.5 110.4 358.3 110.4Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M515.7 81.2L556.3 81.2 468.7 110.4 413.5 110.4Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M556.3 81.2L596.9 81.2 523.9 110.4 468.7 110.4Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M596.9 81.2L637.5 81.2 579.1 110.4 523.9 110.4Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M637.5 81.2L678.2 81.2 634.4 110.4 579.1 110.4Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M678.2 81.2L718.8 81.2 689.6 110.4 634.4 110.4Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M718.8 81.2L759.4 81.2 744.8 110.4 689.6 110.4Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M759.4 81.2L800.0 81.2 800.0 110.4 744.8 110.4Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M800.0 81.2L840.6 81.2 855.2 110.4 800.0 110.4Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M840.6 81.2L881.2 81.2 910.4 110.4 855.2 110.4Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M881.2 81.2L921.8 81.2 965.6 110.4 910.4 110.4Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M921.8 81.2L962.5 81.2 1020.9 110.4 965.6 110.4Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M962.5 81.2L1003.1 81.2 1076.1 110.4 1020.9 110.4Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1003.1 81.2L1043.7 81.2 1131.3 110.4 1076.1 110.4Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M1043.7 81.2L1084.3 81.2 1186.5 110.4 1131.3 110.4Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1084.3 81.2L1124.9 81.2 1241.7 110.4 1186.5 110.4Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M1124.9 81.2L1165.5 81.2 1296.9 110.4 1241.7 110.4Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1165.5 81.2L1206.1 81.2 1352.1 110.4 1296.9 110.4Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M247.9 110.4L303.1 110.4 148.5 144.8 76.1 144.8Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M303.1 110.4L358.3 110.4 220.9 144.8 148.5 144.8Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M358.3 110.4L413.5 110.4 293.3 144.8 220.9 144.8Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M413.5 110.4L468.7 110.4 365.6 144.8 293.3 144.8Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M468.7 110.4L523.9 110.4 438.0 144.8 365.6 144.8Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M523.9 110.4L579.1 110.4 510.4 144.8 438.0 144.8Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M579.1 110.4L634.4 110.4 582.8 144.8 510.4 144.8Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M634.4 110.4L689.6 110.4 655.2 144.8 582.8 144.8Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M689.6 110.4L744.8 110.4 727.6 144.8 655.2 144.8Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M744.8 110.4L800.0 110.4 800.0 144.8 727.6 144.8Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M800.0 110.4L855.2 110.4 872.4 144.8 800.0 144.8Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M855.2 110.4L910.4 110.4 944.8 144.8 872.4 144.8Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M910.4 110.4L965.6 110.4 1017.2 144.8 944.8 144.8Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M965.6 110.4L1020.9 110.4 1089.6 144.8 1017.2 144.8Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1020.9 110.4L1076.1 110.4 1162.0 144.8 1089.6 144.8Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M1076.1 110.4L1131.3 110.4 1234.4 144.8 1162.0 144.8Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1131.3 110.4L1186.5 110.4 1306.7 144.8 1234.4 144.8Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M1186.5 110.4L1241.7 110.4 1379.1 144.8 1306.7 144.8Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1241.7 110.4L1296.9 110.4 1451.5 144.8 1379.1 144.8Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M1296.9 110.4L1352.1 110.4 1523.9 144.8 1451.5 144.8Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M76.1 144.8L148.5 144.8 -30.2 184.5 -122.4 184.5Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M148.5 144.8L220.9 144.8 62.1 184.5 -30.2 184.5Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M220.9 144.8L293.3 144.8 154.3 184.5 62.1 184.5Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M293.3 144.8L365.6 144.8 246.5 184.5 154.3 184.5Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M365.6 144.8L438.0 144.8 338.8 184.5 246.5 184.5Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M438.0 144.8L510.4 144.8 431.0 184.5 338.8 184.5Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M510.4 144.8L582.8 144.8 523.3 184.5 431.0 184.5Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M582.8 144.8L655.2 144.8 615.5 184.5 523.3 184.5Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M655.2 144.8L727.6 144.8 707.8 184.5 615.5 184.5Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M727.6 144.8L800.0 144.8 800.0 184.5 707.8 184.5Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M800.0 144.8L872.4 144.8 892.2 184.5 800.0 184.5Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M872.4 144.8L944.8 144.8 984.5 184.5 892.2 184.5Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M944.8 144.8L1017.2 144.8 1076.7 184.5 984.5 184.5Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1017.2 144.8L1089.6 144.8 1169.0 184.5 1076.7 184.5Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M1089.6 144.8L1162.0 144.8 1261.2 184.5 1169.0 184.5Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1162.0 144.8L1234.4 144.8 1353.5 184.5 1261.2 184.5Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M1234.4 144.8L1306.7 144.8 1445.7 184.5 1353.5 184.5Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1306.7 144.8L1379.1 144.8 1537.9 184.5 1445.7 184.5Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M1379.1 144.8L1451.5 144.8 1630.2 184.5 1537.9 184.5Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1451.5 144.8L1523.9 144.8 1722.4 184.5 1630.2 184.5Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M-122.4 184.5L-30.2 184.5 -233.7 229.7 -348.5 229.7Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M-30.2 184.5L62.1 184.5 -118.8 229.7 -233.7 229.7Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M62.1 184.5L154.3 184.5 -4.0 229.7 -118.8 229.7Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M154.3 184.5L246.5 184.5 110.9 229.7 -4.0 229.7Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M246.5 184.5L338.8 184.5 225.7 229.7 110.9 229.7Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M338.8 184.5L431.0 184.5 340.6 229.7 225.7 229.7Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M431.0 184.5L523.3 184.5 455.4 229.7 340.6 229.7Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M523.3 184.5L615.5 184.5 570.3 229.7 455.4 229.7Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M615.5 184.5L707.8 184.5 685.1 229.7 570.3 229.7Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M707.8 184.5L800.0 184.5 800.0 229.7 685.1 229.7Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M800.0 184.5L892.2 184.5 914.9 229.7 800.0 229.7Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M892.2 184.5L984.5 184.5 1029.7 229.7 914.9 229.7Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M984.5 184.5L1076.7 184.5 1144.6 229.7 1029.7 229.7Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M1076.7 184.5L1169.0 184.5 1259.4 229.7 1144.6 229.7Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1169.0 184.5L1261.2 184.5 1374.3 229.7 1259.4 229.7Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M1261.2 184.5L1353.5 184.5 1489.1 229.7 1374.3 229.7Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1353.5 184.5L1445.7 184.5 1604.0 229.7 1489.1 229.7Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M1445.7 184.5L1537.9 184.5 1718.8 229.7 1604.0 229.7Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1537.9 184.5L1630.2 184.5 1833.7 229.7 1718.8 229.7Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M1630.2 184.5L1722.4 184.5 1948.5 229.7 1833.7 229.7Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M-348.5 229.7L-233.7 229.7 -462.7 280.6 -603.0 280.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M-233.7 229.7L-118.8 229.7 -322.4 280.6 -462.7 280.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M-118.8 229.7L-4.0 229.7 -182.1 280.6 -322.4 280.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M-4.0 229.7L110.9 229.7 -41.8 280.6 -182.1 280.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M110.9 229.7L225.7 229.7 98.5 280.6 -41.8 280.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M225.7 229.7L340.6 229.7 238.8 280.6 98.5 280.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M340.6 229.7L455.4 229.7 379.1 280.6 238.8 280.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M455.4 229.7L570.3 229.7 519.4 280.6 379.1 280.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M570.3 229.7L685.1 229.7 659.7 280.6 519.4 280.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M685.1 229.7L800.0 229.7 800.0 280.6 659.7 280.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M800.0 229.7L914.9 229.7 940.3 280.6 800.0 280.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M914.9 229.7L1029.7 229.7 1080.6 280.6 940.3 280.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M1029.7 229.7L1144.6 229.7 1220.9 280.6 1080.6 280.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1144.6 229.7L1259.4 229.7 1361.2 280.6 1220.9 280.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M1259.4 229.7L1374.3 229.7 1501.5 280.6 1361.2 280.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1374.3 229.7L1489.1 229.7 1641.8 280.6 1501.5 280.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M1489.1 229.7L1604.0 229.7 1782.1 280.6 1641.8 280.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1604.0 229.7L1718.8 229.7 1922.4 280.6 1782.1 280.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M1718.8 229.7L1833.7 229.7 2062.7 280.6 1922.4 280.6Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1833.7 229.7L1948.5 229.7 2203.0 280.6 2062.7 280.6Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M-603.0 280.6L-462.7 280.6 -717.9 337.3 -886.6 337.3Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M-462.7 280.6L-322.4 280.6 -549.3 337.3 -717.9 337.3Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M-322.4 280.6L-182.1 280.6 -380.6 337.3 -549.3 337.3Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M-182.1 280.6L-41.8 280.6 -211.9 337.3 -380.6 337.3Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M-41.8 280.6L98.5 280.6 -43.3 337.3 -211.9 337.3Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M98.5 280.6L238.8 280.6 125.4 337.3 -43.3 337.3Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M238.8 280.6L379.1 280.6 294.0 337.3 125.4 337.3Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M379.1 280.6L519.4 280.6 462.7 337.3 294.0 337.3Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M519.4 280.6L659.7 280.6 631.3 337.3 462.7 337.3Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M659.7 280.6L800.0 280.6 800.0 337.3 631.3 337.3Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M800.0 280.6L940.3 280.6 968.7 337.3 800.0 337.3Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M940.3 280.6L1080.6 280.6 1137.3 337.3 968.7 337.3Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1080.6 280.6L1220.9 280.6 1306.0 337.3 1137.3 337.3Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M1220.9 280.6L1361.2 280.6 1474.6 337.3 1306.0 337.3Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1361.2 280.6L1501.5 280.6 1643.3 337.3 1474.6 337.3Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M1501.5 280.6L1641.8 280.6 1811.9 337.3 1643.3 337.3Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1641.8 280.6L1782.1 280.6 1980.6 337.3 1811.9 337.3Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M1782.1 280.6L1922.4 280.6 2149.3 337.3 1980.6 337.3Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1922.4 280.6L2062.7 280.6 2317.9 337.3 2149.3 337.3Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M2062.7 280.6L2203.0 280.6 2486.6 337.3 2317.9 337.3Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M-886.6 337.3L-717.9 337.3 -1000.0 400.0 -1200.0 400.0Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M-717.9 337.3L-549.3 337.3 -800.0 400.0 -1000.0 400.0Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M-549.3 337.3L-380.6 337.3 -600.0 400.0 -800.0 400.0Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M-380.6 337.3L-211.9 337.3 -400.0 400.0 -600.0 400.0Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M-211.9 337.3L-43.3 337.3 -200.0 400.0 -400.0 400.0Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M-43.3 337.3L125.4 337.3 0.0 400.0 -200.0 400.0Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M125.4 337.3L294.0 337.3 200.0 400.0 0.0 400.0Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M294.0 337.3L462.7 337.3 400.0 400.0 200.0 400.0Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M462.7 337.3L631.3 337.3 600.0 400.0 400.0 400.0Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M631.3 337.3L800.0 337.3 800.0 400.0 600.0 400.0Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M800.0 337.3L968.7 337.3 1000.0 400.0 800.0 400.0Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M968.7 337.3L1137.3 337.3 1200.0 400.0 1000.0 400.0Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M1137.3 337.3L1306.0 337.3 1400.0 400.0 1200.0 400.0Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1306.0 337.3L1474.6 337.3 1600.0 400.0 1400.0 400.0Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M1474.6 337.3L1643.3 337.3 1800.0 400.0 1600.0 400.0Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1643.3 337.3L1811.9 337.3 2000.0 400.0 1800.0 400.0Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M1811.9 337.3L1980.6 337.3 2200.0 400.0 2000.0 400.0Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M1980.6 337.3L2149.3 337.3 2400.0 400.0 2200.0 400.0Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Cpath d='M2149.3 337.3L2317.9 337.3 2600.0 400.0 2400.0 400.0Z' fill='%23ff5fc4' fill-opacity='.62'/%3E%3Cpath d='M2317.9 337.3L2486.6 337.3 2800.0 400.0 2600.0 400.0Z' fill='%232a0f6b' fill-opacity='.9'/%3E%3Crect width='1600' height='400' fill='url(%23f)'/%3E%3C/svg%3E\") 0 0 / 100% 100% no-repeat;\n}\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-a::before {\ncontent: \"\";\nposition: absolute;\nleft: 0;\nright: 0;\ntop: 0;\nheight: 14%;\nbackground: linear-gradient(to bottom, transparent, rgba(255, 170, 235, 0.32) 50%, transparent);\ntransform: translateY(-100%);\nanimation: aur-vw-scan 9s steps(135) infinite;\n}\n@keyframes aur-vw-scan { to { transform: translateY(700%); } }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-b {\ndisplay: block;\ninset: 0;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 900' preserveAspectRatio='xMidYMid slice'%3E%3Cdefs%3E%3ClinearGradient id='m' x1='0' y1='0' x2='1' y2='0'%3E%3Cstop offset='0' stop-color='%23c9bdf5'/%3E%3Cstop offset='.45' stop-color='%23fff'/%3E%3Cstop offset='1' stop-color='%23a08de0'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cg transform='rotate(-9 165 410.0)'%3E%3Crect x='111.0' y='194' width='108' height='18' rx='3' fill='url(%23m)'/%3E%3Crect x='121.0' y='212' width='88' height='16' rx='3' fill='url(%23m)'/%3E%3Crect x='133.0' y='228' width='64' height='364' fill='url(%23m)'/%3E%3Cpath d='M139.0 234V590' stroke='%239a86d8' stroke-opacity='.55' stroke-width='2.4'/%3E%3Cpath d='M149.4 234V590' stroke='%239a86d8' stroke-opacity='.55' stroke-width='2.4'/%3E%3Cpath d='M159.8 234V590' stroke='%239a86d8' stroke-opacity='.55' stroke-width='2.4'/%3E%3Cpath d='M170.2 234V590' stroke='%239a86d8' stroke-opacity='.55' stroke-width='2.4'/%3E%3Cpath d='M180.6 234V590' stroke='%239a86d8' stroke-opacity='.55' stroke-width='2.4'/%3E%3Cpath d='M191.0 234V590' stroke='%239a86d8' stroke-opacity='.55' stroke-width='2.4'/%3E%3Crect x='121.0' y='592' width='88' height='16' rx='3' fill='url(%23m)'/%3E%3Crect x='111.0' y='608' width='108' height='18' rx='3' fill='url(%23m)'/%3E%3C/g%3E%3Cpath d='M1210 395.0 1340 200 1385.5 453.5Z' fill='%23ff71ce' fill-opacity='.28'/%3E%3Cg fill='none' stroke='%237ff4ff' stroke-width='3' stroke-linejoin='round' stroke-opacity='.85'%3E%3Cpath d='M1210 395.0 1340 200 1470 395.0 1385.5 453.5Z'/%3E%3Cpath d='M1340 200 1385.5 453.5'/%3E%3Cpath d='M1210 395.0 1385.5 453.5' stroke-opacity='.4' stroke-dasharray='6 8'/%3E%3C/g%3E%3Cg fill='none' stroke='%23ff9ee6' stroke-width='2.6' stroke-linejoin='round'%3E%3Cpath d='M1190 560 1236 560 1236 606 1190 606Z'/%3E%3Cpath d='M1212 540 1258 540 1258 586 1212 586Z' stroke-opacity='.6'/%3E%3Cpath d='M1190 560 1212 540M1236 560 1258 540M1236 606 1258 586M1190 606 1212 586'/%3E%3C/g%3E%3Cg fill='none' stroke='%237ff4ff' stroke-width='3' stroke-opacity='.7'%3E%3Cellipse cx='470' cy='300' rx='56' ry='18' transform='rotate(-22 470 300)'/%3E%3C/g%3E%3Cpath d='M1450 610 1500 700 1400 700Z' fill='none' stroke='%23ffe86a' stroke-width='3' stroke-opacity='.8'/%3E%3C/svg%3E\") center / cover no-repeat;\nanimation: aur-vw-bob 9s steps(135) infinite alternate;\n}\n@keyframes aur-vw-bob {\nfrom { transform: translate3d(0, 1%, 0) rotate(-0.5deg); }\nto { transform: translate3d(0, -1.6%, 0) rotate(0.6deg); }\n}\n.aur-root[data-fx=\"vaporwave\"] .aur-fx-c {\ndisplay: block;\ninset: 0;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 900' preserveAspectRatio='xMidYMax slice'%3E%3Cg fill='%2312052e'%3E%3Cpath d='M68.0 900.2 68.6 869.3 69.5 839.0 70.7 809.1 72.1 779.8 73.9 751.0 75.9 722.7 78.2 695.0 80.7 667.7 83.6 641.0 86.7 614.8 90.1 589.1 93.8 563.9 97.8 539.2 102.0 515.1 106.5 491.4 111.3 468.3 116.4 445.7 121.8 423.6 127.4 402.1 133.4 381.0 126.6 379.0 120.3 400.0 114.1 421.6 108.3 443.7 102.7 466.4 97.5 489.6 92.5 513.2 87.8 537.5 83.3 562.2 79.2 587.4 75.3 613.2 71.7 639.5 68.4 666.4 65.4 693.7 62.6 721.6 60.1 750.0 58.0 778.9 56.0 808.4 54.4 838.3 53.1 868.8 52.0 899.8Z'/%3E%3Cpath d='M130.0 380.0Q17.4 301.4 -74.8 458.5Q17.4 341.4 130.0 380.0Z'/%3E%3Cpath d='M130.0 380.0Q28.1 237.7 -55.3 402.0Q28.1 277.7 130.0 380.0Z'/%3E%3Cpath d='M130.0 380.0Q57.4 198.5 -2.0 346.7Q57.4 238.5 130.0 380.0Z'/%3E%3Cpath d='M130.0 380.0Q82.4 209.5 43.4 332.0Q82.4 249.5 130.0 380.0Z'/%3E%3Cpath d='M130.0 380.0Q143.7 183.7 154.9 282.3Q143.7 223.7 130.0 380.0Z'/%3E%3Cpath d='M130.0 380.0Q168.9 227.2 200.8 337.0Q168.9 267.2 130.0 380.0Z'/%3E%3Cpath d='M130.0 380.0Q189.4 235.8 238.0 362.0Q189.4 275.8 130.0 380.0Z'/%3E%3Cpath d='M130.0 380.0Q224.0 262.1 300.9 412.7Q224.0 302.1 130.0 380.0Z'/%3E%3Cpath d='M130.0 380.0Q217.6 295.7 289.3 431.5Q217.6 335.7 130.0 380.0Z'/%3E%3Cpath d='M215.6 899.9 215.1 880.2 214.4 860.9 213.7 841.9 212.8 823.2 211.8 804.9 210.7 786.9 209.4 769.2 208.1 751.8 206.6 734.8 205.0 718.1 203.3 701.8 201.4 685.8 199.5 670.1 197.4 654.7 195.2 639.7 192.9 625.0 190.4 610.6 187.9 596.6 185.2 582.9 182.4 569.5 177.6 570.5 180.1 583.9 182.4 597.5 184.7 611.6 186.8 625.9 188.8 640.6 190.7 655.6 192.4 670.9 194.1 686.6 195.6 702.6 197.0 718.9 198.3 735.5 199.4 752.5 200.5 769.8 201.4 787.4 202.2 805.4 202.9 823.6 203.4 842.3 203.9 861.2 204.2 880.5 204.4 900.1Z'/%3E%3Cpath d='M180.0 570.0Q93.2 523.5 22.3 638.4Q93.2 551.5 180.0 570.0Z'/%3E%3Cpath d='M180.0 570.0Q109.7 487.3 52.2 596.9Q109.7 515.3 180.0 570.0Z'/%3E%3Cpath d='M180.0 570.0Q137.6 469.9 103.0 558.7Q137.6 497.9 180.0 570.0Z'/%3E%3Cpath d='M180.0 570.0Q176.3 450.4 173.4 509.2Q176.3 478.4 180.0 570.0Z'/%3E%3Cpath d='M180.0 570.0Q196.8 442.5 210.6 515.4Q196.8 470.5 180.0 570.0Z'/%3E%3Cpath d='M180.0 570.0Q219.8 454.3 252.3 544.9Q219.8 482.3 180.0 570.0Z'/%3E%3Cpath d='M180.0 570.0Q245.1 466.8 298.3 577.1Q245.1 494.8 180.0 570.0Z'/%3E%3Cpath d='M180.0 570.0Q241.8 510.7 292.4 606.3Q241.8 538.7 180.0 570.0Z'/%3E%3Cpath d='M1568.0 899.8 1566.9 866.4 1565.6 833.6 1564.0 801.4 1562.0 769.7 1559.9 738.5 1557.4 708.0 1554.6 677.9 1551.6 648.5 1548.3 619.6 1544.7 591.3 1540.8 563.5 1536.7 536.3 1532.2 509.7 1527.5 483.6 1522.5 458.1 1517.3 433.2 1511.7 408.8 1505.9 385.0 1499.8 361.7 1493.4 339.1 1486.6 340.9 1492.6 363.6 1498.2 386.9 1503.6 410.6 1508.7 435.0 1513.5 459.9 1518.0 485.3 1522.2 511.3 1526.2 537.9 1529.9 565.0 1533.3 592.7 1536.4 620.9 1539.3 649.7 1541.8 679.1 1544.1 709.0 1546.1 739.5 1547.9 770.5 1549.3 802.1 1550.5 834.2 1551.4 866.9 1552.0 900.2Z'/%3E%3Cpath d='M1490.0 340.0Q1378.0 277.6 1286.4 429.8Q1378.0 317.6 1490.0 340.0Z'/%3E%3Cpath d='M1490.0 340.0Q1389.4 205.1 1307.1 366.3Q1389.4 245.1 1490.0 340.0Z'/%3E%3Cpath d='M1490.0 340.0Q1424.5 204.7 1370.8 334.1Q1424.5 244.7 1490.0 340.0Z'/%3E%3Cpath d='M1490.0 340.0Q1450.0 180.4 1417.3 293.1Q1450.0 220.4 1490.0 340.0Z'/%3E%3Cpath d='M1490.0 340.0Q1495.8 173.9 1500.5 257.2Q1495.8 213.9 1490.0 340.0Z'/%3E%3Cpath d='M1490.0 340.0Q1522.2 176.6 1548.5 283.2Q1522.2 216.6 1490.0 340.0Z'/%3E%3Cpath d='M1490.0 340.0Q1550.7 183.1 1600.3 313.8Q1550.7 223.1 1490.0 340.0Z'/%3E%3Cpath d='M1490.0 340.0Q1589.4 232.0 1670.6 384.8Q1589.4 272.0 1490.0 340.0Z'/%3E%3Cpath d='M1490.0 340.0Q1580.1 254.6 1653.9 393.0Q1580.1 294.6 1490.0 340.0Z'/%3E%3Cpath d='M1425.2 900.1 1425.5 881.1 1426.0 862.4 1426.7 844.1 1427.5 826.0 1428.5 808.3 1429.6 790.9 1430.9 773.8 1432.3 757.0 1433.9 740.6 1435.7 724.5 1437.6 708.7 1439.7 693.2 1442.0 678.0 1444.4 663.1 1447.0 648.6 1449.7 634.3 1452.6 620.4 1455.6 606.8 1458.8 593.6 1462.2 580.6 1457.8 579.4 1454.1 592.3 1450.6 605.6 1447.3 619.2 1444.1 633.2 1441.0 647.4 1438.2 662.0 1435.5 676.9 1432.9 692.1 1430.5 707.7 1428.3 723.5 1426.2 739.7 1424.3 756.2 1422.6 773.1 1421.0 790.2 1419.5 807.7 1418.3 825.5 1417.2 843.6 1416.2 862.0 1415.4 880.8 1414.8 899.9Z'/%3E%3Cpath d='M1460.0 580.0Q1387.3 537.1 1327.8 636.5Q1387.3 563.1 1460.0 580.0Z'/%3E%3Cpath d='M1460.0 580.0Q1409.0 490.2 1367.2 582.4Q1409.0 516.2 1460.0 580.0Z'/%3E%3Cpath d='M1460.0 580.0Q1421.6 460.2 1390.1 549.0Q1421.6 486.2 1460.0 580.0Z'/%3E%3Cpath d='M1460.0 580.0Q1465.9 457.3 1470.7 517.3Q1465.9 483.3 1460.0 580.0Z'/%3E%3Cpath d='M1460.0 580.0Q1486.3 476.0 1507.8 549.5Q1486.3 502.0 1460.0 580.0Z'/%3E%3Cpath d='M1460.0 580.0Q1504.2 486.5 1540.4 573.6Q1504.2 512.5 1460.0 580.0Z'/%3E%3Cpath d='M1460.0 580.0Q1514.5 535.0 1559.1 618.5Q1514.5 561.0 1460.0 580.0Z'/%3E%3C/g%3E%3C/svg%3E\") center bottom / cover no-repeat;\ntransform-origin: 50% 100%;\nanimation: aur-vw-sway 11s steps(165) infinite alternate;\n}\n@keyframes aur-vw-sway { from { transform: skewX(-0.8deg); } to { transform: skewX(0.9deg); } }\n.aur-root[data-fx=\"vaporwave\"] .aur-fx::after {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 900' preserveAspectRatio='xMidYMid slice'%3E%3Cpath d='M394 63Q394 72 402 72Q394 72 394 81Q394 72 385 72Q394 72 394 63Z' fill='%23ffffff' fill-opacity='0.55'/%3E%3Cpath d='M61 287Q61 295 68 295Q61 295 61 303Q61 295 53 295Q61 295 61 287Z' fill='%23ffffff' fill-opacity='0.61'/%3E%3Cpath d='M856 152Q856 158 863 158Q856 158 856 165Q856 158 850 158Q856 158 856 152Z' fill='%23ffffff' fill-opacity='0.63'/%3E%3Cpath d='M1482 21Q1482 33 1494 33Q1482 33 1482 44Q1482 33 1471 33Q1482 33 1482 21Z' fill='%23ffe0f6' fill-opacity='0.90'/%3E%3Cpath d='M328 164Q328 175 339 175Q328 175 328 186Q328 175 317 175Q328 175 328 164Z' fill='%23c8faff' fill-opacity='0.98'/%3E%3Cpath d='M1337 193Q1337 206 1350 206Q1337 206 1337 220Q1337 206 1323 206Q1337 206 1337 193Z' fill='%23ffe0f6' fill-opacity='0.84'/%3E%3Cpath d='M809 99Q809 109 819 109Q809 109 809 119Q809 109 799 109Q809 109 809 99Z' fill='%23ffffff' fill-opacity='0.97'/%3E%3Cpath d='M1290 478Q1290 491 1303 491Q1290 491 1290 505Q1290 491 1276 491Q1290 491 1290 478Z' fill='%23ffffff' fill-opacity='0.95'/%3E%3Cpath d='M911 448Q911 461 925 461Q911 461 911 475Q911 461 898 461Q911 461 911 448Z' fill='%23c8faff' fill-opacity='0.60'/%3E%3Cpath d='M683 155Q683 164 692 164Q683 164 683 174Q683 164 673 164Q683 164 683 155Z' fill='%23ffffff' fill-opacity='0.65'/%3E%3Cpath d='M1281 36Q1281 42 1287 42Q1281 42 1281 47Q1281 42 1276 42Q1281 42 1281 36Z' fill='%23c8faff' fill-opacity='1.00'/%3E%3Cpath d='M829 332Q829 344 841 344Q829 344 829 356Q829 344 817 344Q829 344 829 332Z' fill='%23ffffff' fill-opacity='1.00'/%3E%3Cpath d='M331 219Q331 226 338 226Q331 226 331 233Q331 226 324 226Q331 226 331 219Z' fill='%23c8faff' fill-opacity='0.72'/%3E%3Cpath d='M313 227Q313 238 324 238Q313 238 313 249Q313 238 302 238Q313 238 313 227Z' fill='%23c8faff' fill-opacity='0.78'/%3E%3Cpath d='M1423 65Q1423 70 1428 70Q1423 70 1423 76Q1423 70 1417 70Q1423 70 1423 65Z' fill='%23ffffff' fill-opacity='0.64'/%3E%3Cpath d='M927 445Q927 451 933 451Q927 451 927 457Q927 451 920 451Q927 451 927 445Z' fill='%23ffffff' fill-opacity='0.65'/%3E%3Cpath d='M70 193Q70 199 75 199Q70 199 70 204Q70 199 64 199Q70 199 70 193Z' fill='%23ffe0f6' fill-opacity='0.87'/%3E%3Cpath d='M1508 21Q1508 29 1516 29Q1508 29 1508 37Q1508 29 1500 29Q1508 29 1508 21Z' fill='%23ffffff' fill-opacity='0.89'/%3E%3Cpath d='M662 480Q662 492 673 492Q662 492 662 503Q662 492 651 492Q662 492 662 480Z' fill='%23ffffff' fill-opacity='0.65'/%3E%3Cpath d='M325 236Q325 242 331 242Q325 242 325 248Q325 242 318 242Q325 242 325 236Z' fill='%23ffe0f6' fill-opacity='0.80'/%3E%3Cpath d='M275 298Q275 307 283 307Q275 307 275 315Q275 307 266 307Q275 307 275 298Z' fill='%23ffe0f6' fill-opacity='0.58'/%3E%3Cpath d='M1237 193Q1237 201 1245 201Q1237 201 1237 209Q1237 201 1229 201Q1237 201 1237 193Z' fill='%23ffffff' fill-opacity='0.72'/%3E%3C/svg%3E\") center / cover no-repeat;\nopacity: 0.55;\nanimation: aur-vw-twinkle 4s steps(24) infinite alternate;\n}\n@keyframes aur-vw-twinkle { to { opacity: 1; } }\n.aur-root[data-fx=\"vaporwave\"] .aur-bg-grain { opacity: 0.02; }\n.aur-root[data-look=\"vaporwave\"] { --aur-glow-tint: #ff8ee0; }\n.aur-root[data-look=\"vaporwave\"][data-color=\"white\"] { --aur-hi: #fff2fc; }\n.aur-root[data-look=\"vaporwave\"] .aur-stage {\n-webkit-mask-image: linear-gradient(to bottom, transparent 0, transparent 72px, #000 calc(72px + 10%), #000 62%, transparent 82%);\nmask-image: linear-gradient(to bottom, transparent 0, transparent 72px, #000 calc(72px + 10%), #000 62%, transparent 82%);\n}\n.aur-root[data-look=\"vaporwave\"] .aur-stage .aur-line { letter-spacing: 0.05em; }\n.aur-root[data-look=\"vaporwave\"] .aur-stage .aur-line.is-active:not(.has-words) .aur-main,\n.aur-root[data-look=\"vaporwave\"][data-words=\"off\"] .aur-stage .aur-line.is-active .aur-main {\ntext-shadow: 0.045em 0 0 rgba(255, 80, 200, 0.7), -0.045em 0 0 rgba(0, 229, 255, 0.6), 0 0.04em 0.5em rgba(60, 10, 110, 0.6);\n}\n.aur-root[data-look=\"vaporwave\"][data-words=\"on\"]:is([data-wordanim=\"glow\"], [data-wordanim=\"pop\"], [data-wordanim=\"bounce\"], [data-wordanim=\"focus\"]) .is-active.has-words :is(.aur-w:not(.has-chars), .aur-c) {\ntext-shadow:\ncalc(var(--e) * 0.045em) 0 0 color-mix(in srgb, #ff50c8 calc(var(--e) * 70%), transparent),\ncalc(var(--e) * -0.045em) 0 0 color-mix(in srgb, #00e5ff calc(var(--e) * 60%), transparent),\n0 0.04em 0.5em rgba(60, 10, 110, 0.55);\n}\n.aur-root[data-look=\"vaporwave\"] .aur-dots i { background: color-mix(in oklab, var(--aur-accent) 70%, #fff); box-shadow: 0 0 0.3em var(--aur-accent); }\n.aur-root[data-fx=\"ocean\"] .aur-fx {\nbackground: linear-gradient(to bottom, rgba(24, 130, 180, 0.62), rgba(10, 72, 124, 0.72) 35%, rgba(4, 38, 84, 0.82) 70%, rgba(2, 16, 44, 0.9));\n}\n.aur-root[data-fx=\"ocean\"] .aur-fx::before {\ncontent: \"\";\nposition: absolute;\nleft: -60vw;\ntop: 34%;\nwidth: 56vw;\nheight: 26%;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 300' preserveAspectRatio='xMidYMid meet'%3E%3Cg fill='%2303203a' fill-opacity='.62'%3E%3Cpath d='M600 224Q641 195 691 224Q641 253 600 224ZM600 224L566 200 566 247Z'/%3E%3Cpath d='M386 214Q423 188 468 214Q423 240 386 214ZM386 214L355 193 355 235Z'/%3E%3Cpath d='M728 56Q755 38 787 56Q755 75 728 56ZM728 56L706 41 706 72Z'/%3E%3Cpath d='M473 209Q503 188 540 209Q503 230 473 209ZM473 209L448 192 448 226Z'/%3E%3Cpath d='M581 106Q621 78 668 106Q621 134 581 106ZM581 106L548 84 548 129Z'/%3E%3Cpath d='M990 126Q1031 97 1082 126Q1031 156 990 126ZM990 126L955 102 955 150Z'/%3E%3Cpath d='M177 225Q217 197 265 225Q217 253 177 225ZM177 225L144 202 144 248Z'/%3E%3Cpath d='M259 199Q293 175 336 199Q293 224 259 199ZM259 199L230 179 230 219Z'/%3E%3Cpath d='M999 80Q1033 56 1075 80Q1033 105 999 80ZM999 80L970 61 970 100Z'/%3E%3Cpath d='M932 183Q963 161 1000 183Q963 205 932 183ZM932 183L906 165 906 201Z'/%3E%3Cpath d='M195 256Q229 232 269 256Q229 279 195 256ZM195 256L167 236 167 275Z'/%3E%3Cpath d='M1037 64Q1075 37 1122 64Q1075 91 1037 64ZM1037 64L1004 42 1004 86Z'/%3E%3Cpath d='M868 251Q895 232 927 251Q895 270 868 251ZM868 251L846 236 846 266Z'/%3E%3Cpath d='M462 42Q500 16 546 42Q500 69 462 42ZM462 42L431 21 431 64Z'/%3E%3Cpath d='M446 260Q478 238 517 260Q478 283 446 260ZM446 260L419 242 419 279Z'/%3E%3Cpath d='M832 238Q862 217 899 238Q862 259 832 238ZM832 238L807 221 807 255Z'/%3E%3C/g%3E%3C/svg%3E\") center / 100% 100% no-repeat;\nanimation: aur-oc-school 110s steps(1650) infinite;\n}\n@keyframes aur-oc-school { to { translate: 200vw 0; } }\n.aur-root[data-fx=\"ocean\"] .aur-fx-a {\ndisplay: block;\nleft: -10%;\nright: -10%;\ntop: -6%;\nheight: 106%;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2000 1000' preserveAspectRatio='none'%3E%3Cdefs%3E%3ClinearGradient id='b' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%23e9fdff'/%3E%3Cstop offset='.35' stop-color='%239be6ff' stop-opacity='.55'/%3E%3Cstop offset='1' stop-color='%233aa8e0' stop-opacity='0'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cg fill='url(%23b)'%3E%3Cpath d='M1587 0L1638 0 1872 1000 1666 1000Z' fill-opacity='0.19'/%3E%3Cpath d='M1326 0L1361 0 1693 1000 1502 1000Z' fill-opacity='0.47'/%3E%3Cpath d='M545 0L596 0 939 1000 711 1000Z' fill-opacity='0.38'/%3E%3Cpath d='M1364 0L1387 0 1702 1000 1468 1000Z' fill-opacity='0.29'/%3E%3Cpath d='M1607 0L1652 0 2017 1000 1812 1000Z' fill-opacity='0.23'/%3E%3Cpath d='M1601 0L1652 0 1843 1000 1666 1000Z' fill-opacity='0.26'/%3E%3Cpath d='M1270 0L1297 0 1722 1000 1513 1000Z' fill-opacity='0.26'/%3E%3Cpath d='M1311 0L1341 0 1814 1000 1547 1000Z' fill-opacity='0.38'/%3E%3Cpath d='M1289 0L1335 0 1789 1000 1481 1000Z' fill-opacity='0.20'/%3E%3C/g%3E%3C/svg%3E\") center top / 100% 100% no-repeat;\ntransform-origin: 50% 0;\nopacity: 0.5;\ntransition: opacity 3s ease;\nanimation: aur-oc-sway 22s steps(330) infinite alternate;\n}\n.aur-root[data-fx=\"ocean\"][data-gap=\"on\"] .aur-fx-a { opacity: 0.85; }\n.aur-root[data-fx=\"ocean\"][data-bganim=\"on\"][data-lb=\"a\"] .aur-fx-a { animation: aur-oc-sway 22s steps(330) infinite alternate, aur-fx-flash-a 2.2s ease-out; }\n.aur-root[data-fx=\"ocean\"][data-bganim=\"on\"][data-lb=\"b\"] .aur-fx-a { animation: aur-oc-sway 22s steps(330) infinite alternate, aur-fx-flash-b 2.2s ease-out; }\n@keyframes aur-oc-sway {\nfrom { transform: rotate(-2.6deg) translate3d(-2%, 0, 0); }\nto { transform: rotate(2.6deg) translate3d(2%, 0, 0); }\n}\n.aur-root[data-fx=\"ocean\"] .aur-fx-a::before {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2000 1000' preserveAspectRatio='none'%3E%3Cdefs%3E%3ClinearGradient id='b' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%23e9fdff'/%3E%3Cstop offset='.35' stop-color='%239be6ff' stop-opacity='.55'/%3E%3Cstop offset='1' stop-color='%233aa8e0' stop-opacity='0'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cg fill='url(%23b)'%3E%3Cpath d='M949 0L993 0 1264 1000 1092 1000Z' fill-opacity='0.12'/%3E%3Cpath d='M750 0L776 0 1167 1000 943 1000Z' fill-opacity='0.26'/%3E%3Cpath d='M1116 0L1161 0 1296 1000 1077 1000Z' fill-opacity='0.16'/%3E%3Cpath d='M1812 0L1829 0 2114 1000 2009 1000Z' fill-opacity='0.28'/%3E%3Cpath d='M674 0L707 0 1007 1000 879 1000Z' fill-opacity='0.14'/%3E%3Cpath d='M1830 0L1867 0 2065 1000 1772 1000Z' fill-opacity='0.34'/%3E%3Cpath d='M225 0L259 0 359 1000 182 1000Z' fill-opacity='0.26'/%3E%3C/g%3E%3C/svg%3E\") center top / 100% 100% no-repeat;\nopacity: 0.8;\nanimation: aur-oc-sway 31s steps(465) infinite alternate-reverse;\n}\n.aur-root[data-fx=\"ocean\"] .aur-fx-a::after {\ncontent: \"\";\nposition: absolute;\nleft: 0;\ntop: 0;\nwidth: 200%;\nheight: 18%;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2400 200' preserveAspectRatio='none'%3E%3Cdefs%3E%3ClinearGradient id='w' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%23eaffff' stop-opacity='.55'/%3E%3Cstop offset='1' stop-color='%237fe0ff' stop-opacity='0'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath d='M0 0H2400V64L2400 64.0 2392 58.1 2384 52.6 2376 48.0 2368 44.5 2360 42.3 2352 41.3 2344 41.6 2336 42.8 2328 44.7 2320 46.7 2312 48.7 2304 50.2 2296 51.0 2288 51.1 2280 50.4 2272 49.1 2264 47.5 2256 45.9 2248 44.8 2240 44.4 2232 45.0 2224 46.9 2216 50.0 2208 54.3 2200 59.5 2192 65.3 2184 71.2 2176 76.8 2168 81.7 2160 85.5 2152 88.1 2144 89.2 2136 89.1 2128 87.9 2120 85.9 2112 83.4 2104 80.8 2096 78.6 2088 76.9 2080 76.0 2072 75.8 2064 76.4 2056 77.5 2048 78.7 2040 79.7 2032 80.2 2024 79.8 2016 78.3 2008 75.6 2000 71.8 1992 67.0 1984 61.5 1976 55.7 1968 50.1 1960 45.0 1952 41.0 1944 38.1 1936 36.7 1928 36.6 1920 37.8 1912 40.0 1904 42.8 1896 45.9 1888 48.8 1880 51.3 1872 53.1 1864 54.0 1856 54.2 1848 53.8 1840 52.9 1832 52.1 1824 51.6 1816 51.7 1808 52.8 1800 55.0 1792 58.3 1784 62.7 1776 67.8 1768 73.3 1760 78.8 1752 83.9 1744 88.1 1736 91.2 1728 92.9 1720 93.1 1712 92.0 1704 89.8 1696 86.7 1688 83.2 1680 79.6 1672 76.4 1664 73.8 1656 72.0 1648 71.1 1640 70.9 1632 71.3 1624 71.9 1616 72.4 1608 72.5 1600 71.8 1592 70.1 1584 67.4 1576 63.6 1568 59.0 1560 53.8 1552 48.6 1544 43.6 1536 39.3 1528 36.0 1520 34.1 1512 33.7 1504 34.7 1496 36.9 1488 40.2 1480 44.0 1472 48.1 1464 52.0 1456 55.3 1448 57.9 1440 59.6 1432 60.5 1424 60.6 1416 60.2 1408 59.7 1400 59.5 1392 59.8 1384 61.0 1376 63.1 1368 66.2 1360 70.2 1352 74.9 1344 79.8 1336 84.6 1328 88.9 1320 92.2 1312 94.3 1304 94.9 1296 94.1 1288 91.9 1280 88.6 1272 84.5 1264 80.0 1256 75.5 1248 71.5 1240 68.1 1232 65.7 1224 64.2 1216 63.6 1208 63.6 1200 64.0 1192 64.4 1184 64.4 1176 63.8 1168 62.3 1160 59.9 1152 56.5 1144 52.5 1136 48.0 1128 43.5 1120 39.4 1112 36.1 1104 33.9 1096 33.1 1088 33.7 1080 35.8 1072 39.1 1064 43.4 1056 48.2 1048 53.1 1040 57.8 1032 61.8 1024 64.9 1016 67.0 1008 68.2 1000 68.5 992 68.3 984 67.8 976 67.4 968 67.5 960 68.4 952 70.1 944 72.7 936 76.0 928 79.9 920 84.0 912 87.8 904 91.1 896 93.3 888 94.3 880 93.9 872 92.0 864 88.7 856 84.4 848 79.4 840 74.2 832 69.0 824 64.4 816 60.6 808 57.9 800 56.2 792 55.5 784 55.6 776 56.1 768 56.7 760 57.1 752 56.9 744 56.0 736 54.2 728 51.6 720 48.4 712 44.8 704 41.3 696 38.2 688 36.0 680 34.9 672 35.1 664 36.8 656 39.9 648 44.1 640 49.2 632 54.7 624 60.2 616 65.3 608 69.7 600 73.0 592 75.2 584 76.3 576 76.4 568 75.9 560 75.1 552 74.2 544 73.8 536 74.0 528 74.9 520 76.7 512 79.2 504 82.1 496 85.2 488 88.0 480 90.2 472 91.4 464 91.3 456 89.9 448 87.0 440 83.0 432 77.9 424 72.3 416 66.5 408 61.0 400 56.2 392 52.4 384 49.7 376 48.2 368 47.8 360 48.3 352 49.3 344 50.5 336 51.6 328 52.2 320 52.0 312 51.1 304 49.4 296 47.2 288 44.6 280 42.1 272 40.1 264 38.9 256 38.8 248 39.9 240 42.5 232 46.3 224 51.2 216 56.8 208 62.7 200 68.5 192 73.7 184 78.0 176 81.1 168 83.0 160 83.6 152 83.2 144 82.1 136 80.5 128 78.9 120 77.6 112 76.9 104 77.0 96 77.8 88 79.3 80 81.3 72 83.3 64 85.2 56 86.4 48 86.7 40 85.7 32 83.5 24 80.0 16 75.4 8 69.9 0 64.0Z' fill='url(%23w)'/%3E%3Cpath d='M0 64.0 8 69.9 16 75.4 24 80.0 32 83.5 40 85.7 48 86.7 56 86.4 64 85.2 72 83.3 80 81.3 88 79.3 96 77.8 104 77.0 112 76.9 120 77.6 128 78.9 136 80.5 144 82.1 152 83.2 160 83.6 168 83.0 176 81.1 184 78.0 192 73.7 200 68.5 208 62.7 216 56.8 224 51.2 232 46.3 240 42.5 248 39.9 256 38.8 264 38.9 272 40.1 280 42.1 288 44.6 296 47.2 304 49.4 312 51.1 320 52.0 328 52.2 336 51.6 344 50.5 352 49.3 360 48.3 368 47.8 376 48.2 384 49.7 392 52.4 400 56.2 408 61.0 416 66.5 424 72.3 432 77.9 440 83.0 448 87.0 456 89.9 464 91.3 472 91.4 480 90.2 488 88.0 496 85.2 504 82.1 512 79.2 520 76.7 528 74.9 536 74.0 544 73.8 552 74.2 560 75.1 568 75.9 576 76.4 584 76.3 592 75.2 600 73.0 608 69.7 616 65.3 624 60.2 632 54.7 640 49.2 648 44.1 656 39.9 664 36.8 672 35.1 680 34.9 688 36.0 696 38.2 704 41.3 712 44.8 720 48.4 728 51.6 736 54.2 744 56.0 752 56.9 760 57.1 768 56.7 776 56.1 784 55.6 792 55.5 800 56.2 808 57.9 816 60.6 824 64.4 832 69.0 840 74.2 848 79.4 856 84.4 864 88.7 872 92.0 880 93.9 888 94.3 896 93.3 904 91.1 912 87.8 920 84.0 928 79.9 936 76.0 944 72.7 952 70.1 960 68.4 968 67.5 976 67.4 984 67.8 992 68.3 1000 68.5 1008 68.2 1016 67.0 1024 64.9 1032 61.8 1040 57.8 1048 53.1 1056 48.2 1064 43.4 1072 39.1 1080 35.8 1088 33.7 1096 33.1 1104 33.9 1112 36.1 1120 39.4 1128 43.5 1136 48.0 1144 52.5 1152 56.5 1160 59.9 1168 62.3 1176 63.8 1184 64.4 1192 64.4 1200 64.0 1208 63.6 1216 63.6 1224 64.2 1232 65.7 1240 68.1 1248 71.5 1256 75.5 1264 80.0 1272 84.5 1280 88.6 1288 91.9 1296 94.1 1304 94.9 1312 94.3 1320 92.2 1328 88.9 1336 84.6 1344 79.8 1352 74.9 1360 70.2 1368 66.2 1376 63.1 1384 61.0 1392 59.8 1400 59.5 1408 59.7 1416 60.2 1424 60.6 1432 60.5 1440 59.6 1448 57.9 1456 55.3 1464 52.0 1472 48.1 1480 44.0 1488 40.2 1496 36.9 1504 34.7 1512 33.7 1520 34.1 1528 36.0 1536 39.3 1544 43.6 1552 48.6 1560 53.8 1568 59.0 1576 63.6 1584 67.4 1592 70.1 1600 71.8 1608 72.5 1616 72.4 1624 71.9 1632 71.3 1640 70.9 1648 71.1 1656 72.0 1664 73.8 1672 76.4 1680 79.6 1688 83.2 1696 86.7 1704 89.8 1712 92.0 1720 93.1 1728 92.9 1736 91.2 1744 88.1 1752 83.9 1760 78.8 1768 73.3 1776 67.8 1784 62.7 1792 58.3 1800 55.0 1808 52.8 1816 51.7 1824 51.6 1832 52.1 1840 52.9 1848 53.8 1856 54.2 1864 54.0 1872 53.1 1880 51.3 1888 48.8 1896 45.9 1904 42.8 1912 40.0 1920 37.8 1928 36.6 1936 36.7 1944 38.1 1952 41.0 1960 45.0 1968 50.1 1976 55.7 1984 61.5 1992 67.0 2000 71.8 2008 75.6 2016 78.3 2024 79.8 2032 80.2 2040 79.7 2048 78.7 2056 77.5 2064 76.4 2072 75.8 2080 76.0 2088 76.9 2096 78.6 2104 80.8 2112 83.4 2120 85.9 2128 87.9 2136 89.1 2144 89.2 2152 88.1 2160 85.5 2168 81.7 2176 76.8 2184 71.2 2192 65.3 2200 59.5 2208 54.3 2216 50.0 2224 46.9 2232 45.0 2240 44.4 2248 44.8 2256 45.9 2264 47.5 2272 49.1 2280 50.4 2288 51.1 2296 51.0 2304 50.2 2312 48.7 2320 46.7 2328 44.7 2336 42.8 2344 41.6 2352 41.3 2360 42.3 2368 44.5 2376 48.0 2384 52.6 2392 58.1 2400 64.0' fill='none' stroke='%23f2ffff' stroke-opacity='.7' stroke-width='4'/%3E%3C/svg%3E\") 0 0 / 50% 100% repeat-x;\nanimation: aur-oc-waves 40s steps(600) infinite linear;\n}\n@keyframes aur-oc-waves { to { transform: translateX(-50%); } }\n.aur-root[data-fx=\"ocean\"] .aur-fx-b {\ndisplay: block;\ninset: 0;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2000 1000' preserveAspectRatio='xMidYMax slice'%3E%3Cg fill='%2304222f'%3E%3Cpath d='M25.7 1000.0 24.9 982.4 23.9 964.8 22.9 947.2 22.3 929.6 22.2 912.0 23.0 894.4 24.7 876.8 27.2 859.2 30.5 841.6 34.4 824.0 38.4 806.4 42.3 788.8 45.6 771.2 47.8 753.6 48.8 736.0 48.1 718.4 45.8 700.8 41.9 683.2 36.7 665.6 30.4 648.0 23.7 630.4 17.1 612.8 11.3 595.2 6.9 577.6 4.4 560.0 4.4 542.4 7.0 524.8 12.7 507.2 14.2 507.2 10.9 524.8 9.7 542.4 11.1 560.0 14.7 577.6 20.1 595.2 27.0 612.8 34.5 630.4 42.1 648.0 49.2 665.6 55.4 683.2 60.1 700.8 63.2 718.4 64.6 736.0 64.4 753.6 62.9 771.2 60.4 788.8 57.2 806.4 53.9 824.0 50.7 841.6 48.1 859.2 46.2 876.8 45.2 894.4 45.1 912.0 45.8 929.6 47.1 947.2 48.7 964.8 50.3 982.4 51.7 1000.0Z'/%3E%3Cpath d='M20.2 608.0Q53.0 572.0 36.6 542.5Q28.1 581.8 20.2 608.0Z'/%3E%3Cpath d='M47.6 807.5Q88.8 762.1 68.2 725.0Q57.5 774.5 47.6 807.5Z'/%3E%3Cpath d='M182.4 1000.0 184.7 983.9 187.3 967.7 189.9 951.6 192.3 935.5 194.2 919.3 195.4 903.2 195.8 887.0 195.2 870.9 193.7 854.8 191.1 838.6 187.7 822.5 183.6 806.4 178.9 790.2 174.0 774.1 169.3 758.0 164.9 741.8 161.4 725.7 158.9 709.6 157.8 693.4 158.4 677.3 160.8 661.1 165.1 645.0 171.3 628.9 179.3 612.7 188.8 596.6 199.7 580.5 211.7 564.3 224.8 548.2 226.3 548.2 217.5 564.3 208.2 580.5 199.6 596.6 192.1 612.7 186.0 628.9 181.7 645.0 179.1 661.1 178.4 677.3 179.4 693.4 181.9 709.6 185.9 725.7 190.9 741.8 196.7 758.0 202.8 774.1 209.0 790.2 215.0 806.4 220.4 822.5 225.2 838.6 228.9 854.8 231.7 870.9 233.5 887.0 234.3 903.2 234.3 919.3 233.5 935.5 232.3 951.6 230.9 967.7 229.4 983.9 228.2 1000.0Z'/%3E%3Cpath d='M168.3 686.1Q138.5 653.4 153.4 626.5Q161.2 662.3 168.3 686.1Z'/%3E%3Cpath d='M179.2 627.5Q145.2 590.0 162.2 559.4Q171.0 600.3 179.2 627.5Z'/%3E%3Cpath d='M214.2 878.6Q253.4 835.5 233.8 800.3Q223.6 847.3 214.2 878.6Z'/%3E%3Cpath d='M335.2 1000.0 336.3 979.1 336.1 958.1 334.9 937.2 332.8 916.3 330.3 895.3 328.2 874.4 327.0 853.5 327.5 832.5 330.0 811.6 334.6 790.6 340.9 769.7 348.5 748.8 356.5 727.8 363.7 706.9 369.2 686.0 372.0 665.0 371.5 644.1 367.4 623.2 359.9 602.2 349.9 581.3 338.4 560.4 327.0 539.4 317.2 518.5 310.5 497.6 308.3 476.6 311.4 455.7 319.9 434.7 333.9 413.8 335.4 413.8 325.4 434.7 319.4 455.7 318.5 476.6 322.6 497.6 331.1 518.5 342.6 539.4 355.6 560.4 368.6 581.3 380.1 602.2 389.0 623.2 394.5 644.1 396.4 665.0 394.9 686.0 390.7 706.9 384.7 727.8 378.0 748.8 371.6 769.7 366.5 790.6 363.1 811.6 361.8 832.5 362.4 853.5 364.7 874.4 367.9 895.3 371.4 916.3 374.6 937.2 377.0 958.1 378.1 979.1 378.1 1000.0Z'/%3E%3Cpath d='M322.3 514.4Q271.0 457.9 296.7 411.6Q310.0 473.3 322.3 514.4Z'/%3E%3Cpath d='M345.6 819.2Q305.8 775.3 325.7 739.5Q336.0 787.3 345.6 819.2Z'/%3E%3Cpath d='M358.5 762.7Q406.9 709.5 382.7 666.0Q370.1 724.0 358.5 762.7Z'/%3E%3Cpath d='M487.6 1000.0 487.1 983.6 485.8 967.2 483.9 950.9 481.9 934.5 480.2 918.1 479.2 901.7 479.3 885.4 480.8 869.0 483.8 852.6 488.4 836.2 494.2 819.9 500.9 803.5 508.0 787.1 514.8 770.7 520.7 754.4 525.1 738.0 527.4 721.6 527.2 705.2 524.2 688.9 518.6 672.5 510.5 656.1 500.6 639.7 489.4 623.4 478.1 607.0 467.4 590.6 458.6 574.2 452.5 557.9 450.5 541.5 452.0 541.5 457.2 557.9 465.2 574.2 475.7 590.6 487.8 607.0 500.6 623.4 513.1 639.7 524.3 656.1 533.5 672.5 540.3 688.9 544.4 705.2 545.7 721.6 544.5 738.0 541.2 754.4 536.2 770.7 530.4 787.1 524.3 803.5 518.5 819.9 513.6 836.2 510.0 852.6 507.9 869.0 507.3 885.4 508.0 901.7 509.9 918.1 512.5 934.5 515.3 950.9 518.0 967.2 520.2 983.6 521.5 1000.0Z'/%3E%3Cpath d='M504.6 636.6Q453.9 580.9 479.3 535.2Q492.5 596.1 504.6 636.6Z'/%3E%3Cpath d='M487.2 612.8Q441.2 562.2 464.2 520.8Q476.1 576.0 487.2 612.8Z'/%3E%3Cpath d='M562.0 1000.0 561.0 982.4 559.9 964.8 558.8 947.3 557.8 929.7 557.1 912.1 556.7 894.5 556.9 877.0 557.7 859.4 559.2 841.8 561.4 824.2 564.2 806.7 567.7 789.1 571.8 771.5 576.3 753.9 581.1 736.3 586.1 718.8 590.9 701.2 595.5 683.6 599.7 666.0 603.1 648.5 605.8 630.9 607.4 613.3 607.9 595.7 607.3 578.2 605.4 560.6 602.3 543.0 598.2 525.4 593.7 507.8 595.2 507.8 603.4 525.4 609.7 543.0 614.7 560.6 618.4 578.2 620.7 595.7 621.7 613.3 621.5 630.9 620.3 648.5 618.1 666.0 615.3 683.6 612.0 701.2 608.3 718.8 604.6 736.3 600.9 753.9 597.6 771.5 594.6 789.1 592.2 806.7 590.4 824.2 589.3 841.8 588.9 859.4 589.1 877.0 590.0 894.5 591.3 912.1 593.0 929.7 595.0 947.3 597.1 964.8 599.1 982.4 601.0 1000.0Z'/%3E%3Cpath d='M579.6 798.1Q552.7 768.5 566.1 744.3Q573.1 776.6 579.6 798.1Z'/%3E%3Cpath d='M614.1 624.8Q641.7 594.4 627.9 569.5Q620.7 602.7 614.1 624.8Z'/%3E%3Cpath d='M612.7 640.6Q664.6 583.4 638.6 536.7Q625.2 599.0 612.7 640.6Z'/%3E%3Cpath d='M573.1 871.0Q621.1 818.1 597.1 774.9Q584.6 832.6 573.1 871.0Z'/%3E%3Cpath d='M757.0 1000.0 755.8 987.4 754.7 974.8 753.7 962.1 753.0 949.5 752.6 936.9 752.8 924.3 753.6 911.7 755.0 899.0 757.0 886.4 759.6 873.8 762.8 861.2 766.5 848.6 770.6 836.0 774.9 823.3 779.4 810.7 783.9 798.1 788.1 785.5 791.9 772.9 795.2 760.2 797.8 747.6 799.5 735.0 800.3 722.4 800.0 709.8 798.6 697.1 796.1 684.5 792.6 671.9 788.1 659.3 783.2 646.7 784.7 646.7 792.6 659.3 798.9 671.9 804.0 684.5 808.0 697.1 810.7 709.8 812.2 722.4 812.6 735.0 812.1 747.6 810.6 760.2 808.3 772.9 805.5 785.5 802.3 798.1 798.8 810.7 795.3 823.3 791.9 836.0 788.7 848.6 785.9 861.2 783.6 873.8 781.8 886.4 780.7 899.0 780.1 911.7 780.2 924.3 780.8 936.9 781.9 949.5 783.4 962.1 785.2 974.8 787.2 987.4 789.2 1000.0Z'/%3E%3Cpath d='M791.1 804.5Q756.8 766.8 773.9 735.9Q782.8 777.1 791.1 804.5Z'/%3E%3Cpath d='M768.2 895.4Q714.7 836.5 741.5 788.4Q755.4 852.6 768.2 895.4Z'/%3E%3Cpath d='M804.8 705.7Q848.1 658.1 826.5 619.1Q815.2 671.1 804.8 705.7Z'/%3E%3Cpath d='M807.4 1000.0 807.9 987.4 809.3 974.8 811.5 962.2 814.3 949.6 817.6 937.0 821.2 924.4 824.6 911.8 827.6 899.2 830.0 886.6 831.3 874.0 831.5 861.4 830.3 848.8 827.8 836.2 823.9 823.6 818.8 811.0 812.8 798.4 806.1 785.8 799.3 773.2 792.7 760.6 786.8 748.0 782.1 735.4 779.1 722.8 778.1 710.2 779.4 697.6 783.2 685.0 789.5 672.4 798.5 659.8 810.3 647.2 811.8 647.2 804.2 659.8 797.9 672.4 793.8 685.0 792.0 697.6 792.6 710.2 795.4 722.8 800.1 735.4 806.4 748.0 813.9 760.6 822.0 773.2 830.3 785.8 838.4 798.4 845.8 811.0 852.2 823.6 857.4 836.2 861.3 848.8 863.7 861.4 864.8 874.0 864.7 886.6 863.6 899.2 861.8 911.8 859.5 924.4 857.1 937.0 855.0 949.6 853.3 962.2 852.2 974.8 852.0 987.4 852.6 1000.0Z'/%3E%3Cpath d='M841.2 832.0Q885.6 783.3 863.4 743.4Q851.9 796.6 841.2 832.0Z'/%3E%3Cpath d='M818.2 785.7Q774.6 737.7 796.4 698.5Q807.7 750.8 818.2 785.7Z'/%3E%3Cpath d='M785.6 712.7Q823.5 670.9 804.5 636.8Q794.7 682.3 785.6 712.7Z'/%3E%3Cpath d='M1004.9 1000.0 1004.8 985.5 1004.1 970.9 1003.1 956.4 1002.2 941.8 1001.8 927.3 1002.4 912.7 1004.2 898.2 1007.2 883.6 1011.1 869.1 1015.6 854.5 1020.1 840.0 1023.8 825.4 1026.1 810.9 1026.6 796.3 1024.9 781.8 1021.2 767.3 1015.7 752.7 1009.2 738.2 1002.5 723.6 996.7 709.1 992.8 694.5 991.6 680.0 993.6 665.4 999.0 650.9 1007.4 636.3 1018.0 621.8 1029.8 607.2 1042.0 592.7 1043.5 592.7 1034.8 607.2 1025.1 621.8 1016.3 636.3 1009.6 650.9 1005.8 665.4 1005.2 680.0 1007.8 694.5 1013.0 709.1 1020.1 723.6 1028.0 738.2 1035.7 752.7 1042.4 767.3 1047.2 781.8 1050.0 796.3 1050.6 810.9 1049.3 825.4 1046.7 840.0 1043.3 854.5 1039.8 869.1 1036.8 883.6 1034.8 898.2 1034.0 912.7 1034.4 927.3 1035.7 941.8 1037.5 956.4 1039.4 970.9 1041.1 985.5 1042.1 1000.0Z'/%3E%3Cpath d='M1003.6 705.5Q1029.2 677.3 1016.4 654.3Q1009.7 685.0 1003.6 705.5Z'/%3E%3Cpath d='M1023.3 747.7Q996.5 718.2 1009.9 694.1Q1016.9 726.2 1023.3 747.7Z'/%3E%3Cpath d='M1126.2 1000.0 1125.0 983.2 1123.9 966.4 1123.1 949.5 1122.9 932.7 1123.4 915.9 1124.8 899.1 1127.1 882.2 1130.3 865.4 1134.3 848.6 1138.9 831.8 1143.7 814.9 1148.6 798.1 1153.1 781.3 1157.0 764.5 1159.7 747.6 1161.2 730.8 1161.2 714.0 1159.5 697.2 1156.1 680.3 1151.1 663.5 1144.8 646.7 1137.5 629.9 1129.5 613.0 1121.4 596.2 1113.7 579.4 1107.0 562.6 1102.0 545.7 1099.5 528.9 1101.0 528.9 1107.3 545.7 1114.8 562.6 1123.6 579.4 1133.1 596.2 1143.0 613.0 1152.6 629.9 1161.5 646.7 1169.3 663.5 1175.6 680.3 1180.4 697.2 1183.5 714.0 1184.8 730.8 1184.6 747.6 1183.1 764.5 1180.5 781.3 1177.1 798.1 1173.4 814.9 1169.7 831.8 1166.3 848.6 1163.4 865.4 1161.3 882.2 1160.1 899.1 1159.7 915.9 1160.3 932.7 1161.5 949.5 1163.3 966.4 1165.5 983.2 1167.7 1000.0Z'/%3E%3Cpath d='M1172.5 715.6Q1118.6 656.4 1145.5 607.8Q1159.5 672.5 1172.5 715.6Z'/%3E%3Cpath d='M1159.5 811.2Q1193.5 773.9 1176.5 743.3Q1167.7 784.1 1159.5 811.2Z'/%3E%3Cpath d='M1262.2 1000.0 1262.0 986.1 1262.3 972.1 1263.2 958.2 1264.7 944.2 1266.8 930.3 1269.0 916.3 1271.2 902.4 1273.1 888.4 1274.2 874.5 1274.3 860.5 1273.4 846.6 1271.3 832.6 1268.3 818.7 1264.6 804.7 1260.6 790.8 1256.9 776.9 1253.9 762.9 1252.1 749.0 1252.0 735.0 1253.7 721.1 1257.4 707.1 1262.9 693.2 1269.8 679.2 1277.6 665.3 1285.5 651.3 1293.0 637.4 1299.2 623.4 1303.9 609.5 1305.4 609.5 1303.5 623.4 1299.0 637.4 1293.1 651.3 1286.5 665.3 1280.0 679.2 1274.3 693.2 1269.9 707.1 1267.3 721.1 1266.6 735.0 1267.8 749.0 1270.5 762.9 1274.5 776.9 1279.1 790.8 1284.0 804.7 1288.6 818.7 1292.5 832.6 1295.4 846.6 1297.2 860.5 1297.8 874.5 1297.5 888.4 1296.5 902.4 1295.1 916.3 1293.6 930.3 1292.3 944.2 1291.6 958.2 1291.4 972.1 1291.8 986.1 1292.8 1000.0Z'/%3E%3Cpath d='M1285.9 877.8Q1231.8 818.2 1258.9 769.5Q1272.9 834.5 1285.9 877.8Z'/%3E%3Cpath d='M1259.4 742.2Q1225.1 704.4 1242.3 673.6Q1251.2 714.7 1259.4 742.2Z'/%3E%3Cpath d='M1284.9 850.2Q1317.0 814.9 1300.9 785.9Q1292.6 824.5 1284.9 850.2Z'/%3E%3Cpath d='M1350.6 1000.0 1352.3 983.5 1353.7 967.0 1354.6 950.5 1354.8 933.9 1354.4 917.4 1353.4 900.9 1351.8 884.4 1349.6 867.9 1347.0 851.4 1344.1 834.8 1341.1 818.3 1338.1 801.8 1335.3 785.3 1333.0 768.8 1331.3 752.3 1330.4 735.8 1330.5 719.2 1331.6 702.7 1333.9 686.2 1337.4 669.7 1342.1 653.2 1347.9 636.7 1354.7 620.1 1362.3 603.6 1370.6 587.1 1379.3 570.6 1388.2 554.1 1397.5 537.6 1399.0 537.6 1392.7 554.1 1385.7 570.6 1378.5 587.1 1371.7 603.6 1365.4 620.1 1359.8 636.7 1355.2 653.2 1351.7 669.7 1349.3 686.2 1348.0 702.7 1347.9 719.2 1348.8 735.8 1350.7 752.3 1353.3 768.8 1356.6 785.3 1360.3 801.8 1364.2 818.3 1368.1 834.8 1371.9 851.4 1375.4 867.9 1378.4 884.4 1380.8 900.9 1382.7 917.4 1383.9 933.9 1384.4 950.5 1384.3 967.0 1383.7 983.5 1382.7 1000.0Z'/%3E%3Cpath d='M1342.3 762.7Q1314.9 732.6 1328.6 707.9Q1335.7 740.8 1342.3 762.7Z'/%3E%3Cpath d='M1342.8 678.5Q1291.3 621.8 1317.1 575.4Q1330.5 637.3 1342.8 678.5Z'/%3E%3Cpath d='M1506.6 1000.0 1508.0 985.6 1509.4 971.2 1510.6 956.7 1511.5 942.3 1511.8 927.9 1511.7 913.5 1510.9 899.1 1509.7 884.6 1508.2 870.2 1506.4 855.8 1504.7 841.4 1503.3 827.0 1502.4 812.5 1502.4 798.1 1503.2 783.7 1505.2 769.3 1508.1 754.8 1512.1 740.4 1516.9 726.0 1522.2 711.6 1527.8 697.2 1533.3 682.7 1538.2 668.3 1542.3 653.9 1545.2 639.5 1546.6 625.1 1546.6 610.6 1545.7 596.2 1547.2 596.2 1552.2 610.6 1554.7 625.1 1555.4 639.5 1554.4 653.9 1552.2 668.3 1548.9 682.7 1545.1 697.2 1541.0 711.6 1537.2 726.0 1533.8 740.4 1531.3 754.8 1529.6 769.3 1529.0 783.7 1529.5 798.1 1530.8 812.5 1532.9 827.0 1535.5 841.4 1538.4 855.8 1541.3 870.2 1544.1 884.6 1546.4 899.1 1548.3 913.5 1549.5 927.9 1550.3 942.3 1550.5 956.7 1550.3 971.2 1550.0 985.6 1549.6 1000.0Z'/%3E%3Cpath d='M1522.2 854.6Q1557.4 815.9 1539.8 784.2Q1530.6 826.4 1522.2 854.6Z'/%3E%3Cpath d='M1536.0 698.5Q1486.8 644.4 1511.4 600.1Q1524.2 659.1 1536.0 698.5Z'/%3E%3Cpath d='M1516.9 815.4Q1479.2 774.0 1498.0 740.1Q1507.8 785.3 1516.9 815.4Z'/%3E%3Cpath d='M1516.9 773.5Q1555.9 730.6 1536.4 695.6Q1526.3 742.3 1516.9 773.5Z'/%3E%3Cpath d='M1666.4 1000.0 1667.3 984.9 1667.8 969.9 1667.7 954.8 1667.1 939.7 1666.1 924.6 1664.6 909.6 1662.8 894.5 1660.8 879.4 1658.6 864.4 1656.5 849.3 1654.5 834.2 1652.8 819.1 1651.5 804.1 1650.8 789.0 1650.7 773.9 1651.4 758.8 1652.9 743.8 1655.3 728.7 1658.6 713.6 1662.8 698.6 1667.7 683.5 1673.3 668.4 1679.5 653.3 1686.2 638.3 1693.1 623.2 1700.2 608.1 1707.1 593.1 1714.2 578.0 1715.7 578.0 1711.3 593.1 1706.0 608.1 1700.4 623.2 1694.8 638.3 1689.3 653.3 1684.2 668.4 1679.6 683.5 1675.7 698.6 1672.6 713.6 1670.3 728.7 1668.8 743.8 1668.2 758.8 1668.3 773.9 1669.2 789.0 1670.8 804.1 1672.9 819.1 1675.4 834.2 1678.2 849.3 1681.2 864.4 1684.1 879.4 1686.9 894.5 1689.4 909.6 1691.6 924.6 1693.4 939.7 1694.7 954.8 1695.5 969.9 1695.7 984.9 1695.5 1000.0Z'/%3E%3Cpath d='M1683.5 655.6Q1725.3 609.7 1704.4 572.1Q1693.6 622.2 1683.5 655.6Z'/%3E%3Cpath d='M1687.8 644.9Q1661.8 616.3 1674.8 592.9Q1681.6 624.1 1687.8 644.9Z'/%3E%3Cpath d='M1659.6 778.9Q1700.9 733.4 1680.3 696.2Q1669.5 745.8 1659.6 778.9Z'/%3E%3Cpath d='M1826.5 1000.0 1828.6 979.2 1831.1 958.5 1833.2 937.7 1834.4 916.9 1834.0 896.2 1831.8 875.4 1827.9 854.7 1822.9 833.9 1817.5 813.1 1812.6 792.4 1809.4 771.6 1808.8 750.8 1811.3 730.1 1817.1 709.3 1825.8 688.6 1836.7 667.8 1848.5 647.0 1859.6 626.3 1868.5 605.5 1873.6 584.7 1874.1 564.0 1869.4 543.2 1859.7 522.4 1846.1 501.7 1830.1 480.9 1813.8 460.2 1799.5 439.4 1789.8 418.6 1791.3 418.6 1803.8 439.4 1819.8 460.2 1837.6 480.9 1854.9 501.7 1869.8 522.4 1880.6 543.2 1886.4 564.0 1887.0 584.7 1882.9 605.5 1875.0 626.3 1864.9 647.0 1854.1 667.8 1844.1 688.6 1836.2 709.3 1831.3 730.1 1829.6 750.8 1831.1 771.6 1835.1 792.4 1840.8 813.1 1847.0 833.9 1852.8 854.7 1857.5 875.4 1860.4 896.2 1861.6 916.9 1861.2 937.7 1859.8 958.5 1858.0 979.2 1856.6 1000.0Z'/%3E%3Cpath d='M1873.5 539.5Q1821.6 482.4 1847.5 435.7Q1861.0 497.9 1873.5 539.5Z'/%3E%3Cpath d='M1874.0 540.8Q1848.6 512.9 1861.3 490.0Q1867.9 520.5 1874.0 540.8Z'/%3E%3Cpath d='M1942.5 1000.0 1942.4 986.1 1941.8 972.2 1940.8 958.3 1939.7 944.4 1938.9 930.5 1938.6 916.7 1939.0 902.8 1940.4 888.9 1942.8 875.0 1946.1 861.1 1950.1 847.2 1954.5 833.3 1959.0 819.4 1963.0 805.5 1966.1 791.6 1967.9 777.7 1968.2 763.9 1966.7 750.0 1963.5 736.1 1958.7 722.2 1952.8 708.3 1946.2 694.4 1939.6 680.5 1933.7 666.6 1929.2 652.7 1926.7 638.8 1926.7 625.0 1930.1 611.1 1931.6 611.1 1931.4 625.0 1933.3 638.8 1937.5 652.7 1943.5 666.6 1950.8 680.5 1958.7 694.4 1966.6 708.3 1973.7 722.2 1979.7 736.1 1984.0 750.0 1986.6 763.9 1987.4 777.7 1986.6 791.6 1984.5 805.5 1981.5 819.4 1978.0 833.3 1974.5 847.2 1971.4 861.1 1969.0 875.0 1967.6 888.9 1967.1 902.8 1967.5 916.7 1968.7 930.5 1970.4 944.4 1972.3 958.3 1974.1 972.2 1975.6 986.1 1976.5 1000.0Z'/%3E%3Cpath d='M1955.7 876.3Q1923.1 840.4 1939.4 811.1Q1947.9 850.2 1955.7 876.3Z'/%3E%3Cpath d='M1956.3 701.7Q2005.6 647.4 1981.0 603.0Q1968.1 662.2 1956.3 701.7Z'/%3E%3Cpath d='M1954.0 888.4Q1923.1 854.4 1938.6 826.6Q1946.6 863.7 1954.0 888.4Z'/%3E%3Cpath d='M1977.7 778.0Q1947.5 744.8 1962.6 717.7Q1970.4 753.9 1977.7 778.0Z'/%3E%3C/g%3E%3Cpath d='M0 1000 0 956.3 40 953.8 80 953.5 120 956.9 160 964.3 200 974.4 240 985.2 280 994.2 320 999.2 360 999.1 400 994.0 440 985.3 480 975.4 520 966.7 560 961.0 600 959.2 640 960.5 680 963.3 720 965.4 760 964.8 800 960.4 840 952.3 880 941.9 920 931.5 960 923.6 1000 920.1 1040 921.9 1080 928.4 1120 937.9 1160 947.9 1200 956.1 1240 960.8 1280 961.8 1320 960.0 1360 957.1 1400 955.5 1440 957.0 1480 962.4 1520 971.2 1560 981.7 1600 991.4 1640 998.1 1680 999.9 1720 996.5 1760 988.8 1800 978.8 1840 968.9 1880 961.3 1920 957.5 1960 957.3 2000 959.6 2040 962.4 2000 1000Z' fill='%230a2a3a'/%3E%3C/svg%3E\") center bottom / 100% 100% no-repeat;\ntransform-origin: 50% 100%;\nanimation: aur-oc-kelp 7s steps(105) infinite alternate;\n}\n.aur-root[data-fx=\"ocean\"] .aur-fx-b::before {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 2000 1000' preserveAspectRatio='xMidYMax slice'%3E%3Cg fill='%230b4256'%3E%3Cpath d='M33.5 1000.0 34.2 987.2 35.3 974.4 36.8 961.5 38.4 948.7 39.7 935.9 40.4 923.1 40.3 910.3 39.3 897.4 37.5 884.6 34.9 871.8 32.0 859.0 29.2 846.1 26.9 833.3 25.7 820.5 25.8 807.7 27.5 794.9 30.9 782.0 35.8 769.2 41.7 756.4 48.1 743.6 54.2 730.8 59.5 717.9 63.1 705.1 64.6 692.3 63.8 679.5 60.4 666.6 55.0 653.8 48.5 641.0 50.0 641.0 59.0 653.8 66.0 666.6 70.6 679.5 72.7 692.3 72.3 705.1 69.7 717.9 65.4 730.8 60.2 743.6 54.7 756.4 49.7 769.2 45.7 782.0 43.2 794.9 42.2 807.7 42.9 820.5 44.9 833.3 48.0 846.1 51.5 859.0 55.2 871.8 58.4 884.6 61.0 897.4 62.7 910.3 63.5 923.1 63.4 935.9 62.8 948.7 61.9 961.5 61.1 974.4 60.6 987.2 60.6 1000.0Z'/%3E%3Cpath d='M49.5 892.8Q2.6 841.3 26.1 799.2Q38.2 855.4 49.5 892.8Z'/%3E%3Cpath d='M45.5 873.8Q99.1 814.9 72.3 766.7Q58.4 830.9 45.5 873.8Z'/%3E%3Cpath d='M34.2 819.2Q2.0 783.9 18.1 754.9Q26.5 793.5 34.2 819.2Z'/%3E%3Cpath d='M48.3 886.4Q0.1 833.3 24.2 789.9Q36.7 847.8 48.3 886.4Z'/%3E%3Cpath d='M125.3 1000.0 124.8 984.2 124.3 968.4 123.9 952.5 123.6 936.7 123.7 920.9 124.1 905.1 124.9 889.3 126.3 873.5 128.0 857.6 130.2 841.8 132.7 826.0 135.5 810.2 138.3 794.4 141.0 778.6 143.4 762.7 145.4 746.9 146.9 731.1 147.7 715.3 147.7 699.5 146.9 683.7 145.2 667.8 142.8 652.0 139.7 636.2 136.1 620.4 132.2 604.6 128.2 588.8 124.4 572.9 121.6 557.1 123.1 557.1 128.8 572.9 134.3 588.8 139.8 604.6 145.1 620.4 150.0 636.2 154.3 652.0 157.8 667.8 160.6 683.7 162.4 699.5 163.4 715.3 163.7 731.1 163.1 746.9 162.0 762.7 160.5 778.6 158.7 794.4 156.8 810.2 154.9 826.0 153.3 841.8 151.9 857.6 150.9 873.5 150.4 889.3 150.4 905.1 150.7 920.9 151.4 936.7 152.5 952.5 153.7 968.4 154.9 984.2 156.1 1000.0Z'/%3E%3Cpath d='M148.7 652.9Q201.1 595.3 174.9 548.2Q161.3 611.0 148.7 652.9Z'/%3E%3Cpath d='M150.0 783.9Q199.3 729.7 174.6 685.3Q161.8 744.5 150.0 783.9Z'/%3E%3Cpath d='M142.5 836.3Q91.1 779.8 116.8 733.5Q130.1 795.2 142.5 836.3Z'/%3E%3Cpath d='M197.4 1000.0 198.3 987.1 198.6 974.3 198.6 961.4 198.1 948.5 197.1 935.7 195.8 922.8 194.2 909.9 192.5 897.1 190.6 884.2 188.8 871.3 187.1 858.5 185.8 845.6 184.8 832.7 184.3 819.9 184.5 807.0 185.4 794.2 187.0 781.3 189.4 768.4 192.6 755.6 196.6 742.7 201.3 729.8 206.6 717.0 212.5 704.1 218.8 691.2 225.3 678.4 231.9 665.5 238.5 652.6 245.3 639.8 246.8 639.8 243.1 652.6 238.5 665.5 233.6 678.4 228.6 691.2 223.7 704.1 219.2 717.0 215.1 729.8 211.6 742.7 208.8 755.6 206.7 768.4 205.4 781.3 204.8 794.2 205.0 807.0 205.8 819.9 207.2 832.7 209.2 845.6 211.5 858.5 214.1 871.3 216.8 884.2 219.6 897.1 222.2 909.9 224.7 922.8 226.9 935.7 228.7 948.5 230.0 961.4 230.9 974.3 231.4 987.1 231.3 1000.0Z'/%3E%3Cpath d='M219.2 701.6Q190.5 670.1 204.8 644.3Q212.3 678.7 219.2 701.6Z'/%3E%3Cpath d='M195.8 784.9Q160.9 746.5 178.4 715.0Q187.4 756.9 195.8 784.9Z'/%3E%3Cpath d='M367.6 1000.0 366.6 989.1 364.9 978.2 362.8 967.3 360.8 956.4 359.3 945.5 358.6 934.7 359.2 923.8 361.1 912.9 364.4 902.0 369.2 891.1 375.1 880.2 381.8 869.3 388.8 858.4 395.5 847.5 401.3 836.6 405.6 825.7 407.9 814.8 407.8 804.0 405.1 793.1 399.7 782.2 392.0 771.3 382.2 760.4 371.0 749.5 359.2 738.6 347.7 727.7 337.4 716.8 329.3 705.9 324.6 695.0 326.1 695.0 333.4 705.9 343.0 716.8 354.6 727.7 367.4 738.6 380.3 749.5 392.6 760.4 403.4 771.3 412.1 782.2 418.4 793.1 422.0 804.0 423.0 814.8 421.6 825.7 418.1 836.6 413.1 847.5 407.2 858.4 401.0 869.3 395.1 880.2 389.9 891.1 385.9 902.0 383.2 912.9 382.0 923.8 382.2 934.7 383.6 945.5 385.8 956.4 388.5 967.3 391.2 978.2 393.5 989.1 395.2 1000.0Z'/%3E%3Cpath d='M404.7 846.9Q435.4 813.0 420.0 785.4Q412.0 822.3 404.7 846.9Z'/%3E%3Cpath d='M407.0 783.8Q376.8 750.6 391.9 723.4Q399.7 759.7 407.0 783.8Z'/%3E%3Cpath d='M448.2 1000.0 447.8 982.5 447.2 965.0 446.6 947.4 446.1 929.9 445.9 912.4 446.1 894.9 446.9 877.3 448.3 859.8 450.2 842.3 452.6 824.8 455.2 807.3 458.0 789.7 460.5 772.2 462.6 754.7 464.1 737.2 464.8 719.6 464.4 702.1 463.0 684.6 460.6 667.1 457.4 649.6 453.5 632.0 449.2 614.5 445.0 597.0 441.1 579.5 438.1 561.9 436.2 544.4 435.7 526.9 437.2 509.4 438.7 509.4 439.1 526.9 440.7 544.4 443.6 561.9 447.6 579.5 452.3 597.0 457.3 614.5 462.4 632.0 467.0 649.6 471.0 667.1 474.0 684.6 476.1 702.1 477.1 719.6 477.0 737.2 476.2 754.7 474.6 772.2 472.7 789.7 470.5 807.3 468.4 824.8 466.6 842.3 465.3 859.8 464.4 877.3 464.2 894.9 464.4 912.4 465.1 929.9 466.1 947.4 467.3 965.0 468.3 982.5 469.2 1000.0Z'/%3E%3Cpath d='M464.5 660.4Q435.9 628.9 450.2 603.1Q457.6 637.5 464.5 660.4Z'/%3E%3Cpath d='M466.3 669.7Q436.4 636.8 451.3 610.0Q459.1 645.8 466.3 669.7Z'/%3E%3Cpath d='M470.9 728.7Q521.2 673.3 496.0 628.0Q482.9 688.4 470.9 728.7Z'/%3E%3Cpath d='M535.0 1000.0 536.9 985.6 539.1 971.3 541.3 956.9 542.8 942.5 543.1 928.2 542.0 913.8 539.4 899.5 535.6 885.1 531.0 870.7 526.3 856.4 522.3 842.0 519.9 827.6 519.6 813.3 522.0 798.9 527.2 784.5 534.8 770.2 544.4 755.8 554.9 741.5 565.1 727.1 573.9 712.7 580.0 698.4 582.5 684.0 580.8 669.6 574.9 655.3 565.2 640.9 552.6 626.5 538.6 612.2 525.3 597.8 526.8 597.8 543.2 612.2 559.2 626.5 573.4 640.9 584.6 655.3 591.9 669.6 594.9 684.0 593.6 698.4 588.7 712.7 581.1 727.1 571.9 741.5 562.5 755.8 554.0 770.2 547.4 784.5 543.2 798.9 541.8 813.3 543.0 827.6 546.4 842.0 551.2 856.4 556.8 870.7 562.3 885.1 567.0 899.5 570.5 913.8 572.5 928.2 573.0 942.5 572.3 956.9 571.0 971.3 569.6 985.6 568.5 1000.0Z'/%3E%3Cpath d='M535.0 790.6Q565.9 756.5 550.5 728.6Q542.4 765.8 535.0 790.6Z'/%3E%3Cpath d='M586.8 671.0Q550.4 631.0 568.6 598.2Q578.0 641.9 586.8 671.0Z'/%3E%3Cpath d='M555.5 752.8Q517.5 711.0 536.5 676.8Q546.4 722.4 555.5 752.8Z'/%3E%3Cpath d='M616.9 1000.0 616.2 986.6 615.2 973.2 614.2 959.8 613.2 946.4 612.3 933.1 611.7 919.7 611.3 906.3 611.4 892.9 612.0 879.5 613.1 866.1 614.8 852.7 616.9 839.3 619.6 825.9 622.7 812.5 626.2 799.2 629.9 785.8 633.7 772.4 637.5 759.0 641.0 745.6 644.2 732.2 647.0 718.8 649.0 705.4 650.4 692.0 650.8 678.7 650.4 665.3 649.0 651.9 646.7 638.5 643.8 625.1 645.3 625.1 650.0 638.5 653.5 651.9 655.8 665.3 657.1 678.7 657.5 692.0 656.9 705.4 655.6 718.8 653.5 732.2 651.0 745.6 648.1 759.0 644.9 772.4 641.8 785.8 638.7 799.2 635.8 812.5 633.2 825.9 631.1 839.3 629.5 852.7 628.4 866.1 627.8 879.5 627.8 892.9 628.2 906.3 629.0 919.7 630.2 933.1 631.5 946.4 633.0 959.8 634.6 973.2 636.0 986.6 637.2 1000.0Z'/%3E%3Cpath d='M619.6 900.6Q659.5 856.7 639.6 820.7Q629.2 868.6 619.6 900.6Z'/%3E%3Cpath d='M645.8 746.7Q603.8 700.5 624.8 662.7Q635.7 713.1 645.8 746.7Z'/%3E%3Cpath d='M697.9 1000.0 698.0 985.0 697.7 969.9 697.0 954.9 696.3 939.9 695.8 924.9 695.7 909.8 696.3 894.8 697.7 879.8 699.8 864.8 702.7 849.7 706.0 834.7 709.6 819.7 712.9 804.6 715.7 789.6 717.6 774.6 718.2 759.6 717.5 744.5 715.4 729.5 712.0 714.5 707.6 699.5 702.8 684.4 698.0 669.4 693.8 654.4 690.9 639.3 689.8 624.3 690.8 609.3 694.1 594.3 700.1 579.2 701.6 579.2 698.8 594.3 697.5 609.3 698.3 624.3 701.0 639.3 705.3 654.4 710.8 669.4 716.9 684.4 722.9 699.5 728.5 714.5 733.0 729.5 736.3 744.5 738.1 759.6 738.5 774.6 737.7 789.6 735.9 804.6 733.5 819.7 731.0 834.7 728.6 849.7 726.6 864.8 725.4 879.8 725.0 894.8 725.3 909.8 726.3 924.9 727.7 939.9 729.3 954.9 730.8 969.9 731.9 985.0 732.7 1000.0Z'/%3E%3Cpath d='M725.0 801.6Q755.1 768.4 740.0 741.3Q732.2 777.5 725.0 801.6Z'/%3E%3Cpath d='M708.9 681.9Q734.8 653.4 721.8 630.2Q715.1 661.2 708.9 681.9Z'/%3E%3Cpath d='M700.5 657.6Q667.6 621.5 684.1 591.9Q692.6 631.3 700.5 657.6Z'/%3E%3Cpath d='M715.0 853.4Q671.8 805.8 693.4 767.0Q704.6 818.8 715.0 853.4Z'/%3E%3Cpath d='M793.5 1000.0 793.1 989.7 792.5 979.4 791.8 969.1 791.2 958.8 790.8 948.4 790.9 938.1 791.5 927.8 792.8 917.5 794.7 907.2 797.2 896.9 800.2 886.6 803.6 876.3 807.2 866.0 810.7 855.6 814.0 845.3 816.7 835.0 818.7 824.7 819.8 814.4 819.7 804.1 818.6 793.8 816.3 783.5 812.9 773.2 808.7 762.8 803.9 752.5 798.8 742.2 793.7 731.9 789.2 721.6 786.0 711.3 787.5 711.3 793.9 721.6 800.5 731.9 807.3 742.2 814.0 752.5 820.2 762.8 825.8 773.2 830.5 783.5 834.0 793.8 836.4 804.1 837.5 814.4 837.6 824.7 836.7 835.0 835.0 845.3 832.8 855.6 830.3 866.0 827.7 876.3 825.3 886.6 823.2 896.9 821.7 907.2 820.7 917.5 820.4 927.8 820.7 938.1 821.5 948.4 822.7 958.8 824.1 969.1 825.7 979.4 827.2 989.7 828.4 1000.0Z'/%3E%3Cpath d='M815.0 878.5Q856.9 832.4 835.9 794.7Q825.1 845.0 815.0 878.5Z'/%3E%3Cpath d='M808.7 904.0Q761.3 851.9 785.0 809.2Q797.4 866.1 808.7 904.0Z'/%3E%3Cpath d='M815.6 876.5Q788.6 846.9 802.1 822.6Q809.1 855.0 815.6 876.5Z'/%3E%3Cpath d='M935.4 1000.0 934.9 984.5 935.1 969.0 936.2 953.6 938.2 938.1 940.9 922.6 944.1 907.1 947.5 891.7 950.9 876.2 953.8 860.7 956.1 845.2 957.2 829.7 957.1 814.3 955.6 798.8 952.5 783.3 948.1 767.8 942.3 752.4 935.6 736.9 928.3 721.4 921.0 705.9 914.0 690.5 908.0 675.0 903.5 659.5 900.9 644.0 900.5 628.5 902.7 613.1 907.5 597.6 915.0 582.1 925.1 566.6 926.6 566.6 918.4 582.1 912.2 597.6 908.4 613.1 907.1 628.5 908.3 644.0 911.7 659.5 917.0 675.0 923.8 690.5 931.5 705.9 939.5 721.4 947.4 736.9 954.8 752.4 961.2 767.8 966.3 783.3 969.9 798.8 972.1 814.3 972.8 829.7 972.2 845.2 970.5 860.7 968.1 876.2 965.2 891.7 962.3 907.1 959.7 922.6 957.5 938.1 956.1 953.6 955.5 969.0 955.7 984.5 956.8 1000.0Z'/%3E%3Cpath d='M964.9 820.4Q1000.4 781.4 982.7 749.4Q973.4 792.0 964.9 820.4Z'/%3E%3Cpath d='M905.8 651.6Q946.7 606.7 926.2 569.9Q915.6 618.9 905.8 651.6Z'/%3E%3Cpath d='M964.0 846.6Q934.1 813.7 949.0 786.9Q956.8 822.7 964.0 846.6Z'/%3E%3Cpath d='M917.1 686.3Q886.0 652.1 901.6 624.2Q909.6 661.5 917.1 686.3Z'/%3E%3Cpath d='M1033.6 1000.0 1033.2 985.4 1032.4 970.9 1031.3 956.3 1029.9 941.7 1028.4 927.1 1026.9 912.6 1025.6 898.0 1024.6 883.4 1024.0 868.8 1024.0 854.3 1024.6 839.7 1025.9 825.1 1028.0 810.5 1030.8 796.0 1034.4 781.4 1038.6 766.8 1043.4 752.2 1048.6 737.7 1054.0 723.1 1059.6 708.5 1065.0 693.9 1070.2 679.4 1074.7 664.8 1078.6 650.2 1081.6 635.6 1083.5 621.1 1084.4 606.5 1084.4 591.9 1085.9 591.9 1088.5 606.5 1089.3 621.1 1088.8 635.6 1087.1 650.2 1084.4 664.8 1080.9 679.4 1076.8 693.9 1072.4 708.5 1067.8 723.1 1063.2 737.7 1059.0 752.2 1055.1 766.8 1051.7 781.4 1049.0 796.0 1047.0 810.5 1045.7 825.1 1045.2 839.7 1045.3 854.3 1046.2 868.8 1047.5 883.4 1049.3 898.0 1051.3 912.6 1053.5 927.1 1055.7 941.7 1057.8 956.3 1059.7 970.9 1061.1 985.4 1062.2 1000.0Z'/%3E%3Cpath d='M1046.8 766.9Q1004.4 720.2 1025.6 682.0Q1036.6 732.9 1046.8 766.9Z'/%3E%3Cpath d='M1050.4 754.7Q1091.7 709.2 1071.1 672.0Q1060.3 721.6 1050.4 754.7Z'/%3E%3Cpath d='M1046.0 769.8Q994.7 713.3 1020.3 667.2Q1033.7 728.7 1046.0 769.8Z'/%3E%3Cpath d='M1145.8 1000.0 1146.8 982.5 1147.8 965.0 1148.9 947.5 1150.0 930.0 1150.9 912.5 1151.5 895.0 1151.8 877.5 1151.7 860.0 1151.2 842.5 1150.3 825.0 1149.0 807.5 1147.4 790.0 1145.5 772.5 1143.4 755.0 1141.4 737.5 1139.4 720.0 1137.7 702.5 1136.4 685.0 1135.6 667.5 1135.5 650.0 1136.0 632.5 1137.4 615.0 1139.6 597.5 1142.5 580.0 1146.1 562.5 1150.4 545.0 1155.3 527.5 1160.7 510.0 1162.2 510.0 1158.6 527.5 1154.9 545.0 1151.6 562.5 1148.8 580.0 1146.7 597.5 1145.3 615.0 1144.6 632.5 1144.8 650.0 1145.6 667.5 1147.0 685.0 1148.9 702.5 1151.2 720.0 1153.8 737.5 1156.4 755.0 1159.1 772.5 1161.5 790.0 1163.7 807.5 1165.5 825.0 1167.0 842.5 1168.0 860.0 1168.6 877.5 1168.8 895.0 1168.6 912.5 1168.3 930.0 1167.7 947.5 1167.1 965.0 1166.5 982.5 1166.0 1000.0Z'/%3E%3Cpath d='M1148.5 744.2Q1200.1 687.3 1174.3 640.8Q1160.9 702.8 1148.5 744.2Z'/%3E%3Cpath d='M1140.4 663.6Q1104.2 623.8 1122.3 591.2Q1131.7 634.7 1140.4 663.6Z'/%3E%3Cpath d='M1141.0 619.2Q1104.9 579.4 1123.0 546.9Q1132.4 590.3 1141.0 619.2Z'/%3E%3Cpath d='M1277.0 1000.0 1276.1 985.6 1274.9 971.1 1273.5 956.7 1272.3 942.3 1271.3 927.9 1270.8 913.4 1270.8 899.0 1271.5 884.6 1273.0 870.2 1275.3 855.7 1278.3 841.3 1281.9 826.9 1286.1 812.4 1290.6 798.0 1295.1 783.6 1299.5 769.2 1303.5 754.7 1306.8 740.3 1309.1 725.9 1310.4 711.5 1310.3 697.0 1308.9 682.6 1306.1 668.2 1301.9 653.7 1296.5 639.3 1290.1 624.9 1282.9 610.5 1275.6 596.0 1277.1 596.0 1286.2 610.5 1294.5 624.9 1301.8 639.3 1308.1 653.7 1313.1 668.2 1316.7 682.6 1318.8 697.0 1319.5 711.5 1318.9 725.9 1317.2 740.3 1314.6 754.7 1311.2 769.2 1307.4 783.6 1303.4 798.0 1299.5 812.4 1295.9 826.9 1292.8 841.3 1290.3 855.7 1288.6 870.2 1287.6 884.6 1287.4 899.0 1287.8 913.4 1288.9 927.9 1290.3 942.3 1292.1 956.7 1293.9 971.1 1295.6 985.6 1297.0 1000.0Z'/%3E%3Cpath d='M1312.9 734.7Q1355.6 687.7 1334.2 649.3Q1323.1 700.5 1312.9 734.7Z'/%3E%3Cpath d='M1279.9 879.4Q1236.7 831.9 1258.3 793.0Q1269.5 844.8 1279.9 879.4Z'/%3E%3Cpath d='M1315.0 1000.0 1314.7 989.7 1313.8 979.3 1312.6 969.0 1311.3 958.6 1310.1 948.3 1309.2 937.9 1308.8 927.6 1309.3 917.3 1310.5 906.9 1312.7 896.6 1315.8 886.2 1319.5 875.9 1323.8 865.5 1328.3 855.2 1332.7 844.9 1336.6 834.5 1339.6 824.2 1341.5 813.8 1341.9 803.5 1340.8 793.1 1338.1 782.8 1333.8 772.5 1328.2 762.1 1321.6 751.8 1314.4 741.4 1307.1 731.1 1300.3 720.7 1294.9 710.4 1296.4 710.4 1303.5 720.7 1311.3 731.1 1319.5 741.4 1327.5 751.8 1334.9 762.1 1341.2 772.5 1346.2 782.8 1349.6 793.1 1351.3 803.5 1351.4 813.8 1350.2 824.2 1347.7 834.5 1344.4 844.9 1340.6 855.2 1336.6 865.5 1332.8 875.9 1329.6 886.2 1327.0 896.6 1325.3 906.9 1324.5 917.3 1324.6 927.6 1325.4 937.9 1326.8 948.3 1328.5 958.6 1330.3 969.0 1331.9 979.3 1333.2 989.7 1334.0 1000.0Z'/%3E%3Cpath d='M1328.6 869.6Q1353.9 841.8 1341.2 819.1Q1334.7 849.4 1328.6 869.6Z'/%3E%3Cpath d='M1331.4 761.8Q1277.1 702.1 1304.2 653.2Q1318.3 718.4 1331.4 761.8Z'/%3E%3Cpath d='M1473.0 1000.0 1474.3 983.5 1475.4 967.0 1476.4 950.5 1477.0 933.9 1477.2 917.4 1477.0 900.9 1476.3 884.4 1475.3 867.9 1473.9 851.4 1472.2 834.9 1470.5 818.4 1468.9 801.8 1467.6 785.3 1466.7 768.8 1466.5 752.3 1467.0 735.8 1468.2 719.3 1470.4 702.8 1473.4 686.2 1477.1 669.7 1481.5 653.2 1486.4 636.7 1491.5 620.2 1496.6 603.7 1501.4 587.2 1505.7 570.7 1509.3 554.1 1512.4 537.6 1513.9 537.6 1513.8 554.1 1512.0 570.7 1509.3 587.2 1505.9 603.7 1502.1 620.2 1498.2 636.7 1494.5 653.2 1491.2 669.7 1488.6 686.2 1486.6 702.8 1485.5 719.3 1485.2 735.8 1485.7 752.3 1486.9 768.8 1488.7 785.3 1490.9 801.8 1493.4 818.4 1495.9 834.9 1498.4 851.4 1500.7 867.9 1502.6 884.4 1504.1 900.9 1505.1 917.4 1505.7 933.9 1505.8 950.5 1505.7 967.0 1505.3 983.5 1504.8 1000.0Z'/%3E%3Cpath d='M1498.0 615.7Q1469.7 584.5 1483.9 559.0Q1491.2 593.0 1498.0 615.7Z'/%3E%3Cpath d='M1486.1 851.1Q1449.9 811.3 1468.0 778.7Q1477.4 822.2 1486.1 851.1Z'/%3E%3Cpath d='M1558.0 1000.0 1557.0 986.4 1555.7 972.8 1554.4 959.3 1553.4 945.7 1552.8 932.1 1552.8 918.5 1553.7 905.0 1555.4 891.4 1557.9 877.8 1561.3 864.2 1565.3 850.6 1569.8 837.1 1574.4 823.5 1578.8 809.9 1582.7 796.3 1585.8 782.7 1587.8 769.2 1588.4 755.6 1587.5 742.0 1584.9 728.4 1580.8 714.9 1575.3 701.3 1568.6 687.7 1561.1 674.1 1553.3 660.5 1545.5 647.0 1538.4 633.4 1532.8 619.8 1534.3 619.8 1542.0 633.4 1550.3 647.0 1559.2 660.5 1568.0 674.1 1576.4 687.7 1584.0 701.3 1590.3 714.9 1595.2 728.4 1598.5 742.0 1600.1 755.6 1600.2 769.2 1598.9 782.7 1596.5 796.3 1593.2 809.9 1589.4 823.5 1585.5 837.1 1581.6 850.6 1578.2 864.2 1575.4 877.8 1573.5 891.4 1572.3 905.0 1572.1 918.5 1572.6 932.1 1573.8 945.7 1575.4 959.3 1577.2 972.8 1579.0 986.4 1580.5 1000.0Z'/%3E%3Cpath d='M1590.7 730.8Q1565.2 702.8 1578.0 679.9Q1584.6 710.4 1590.7 730.8Z'/%3E%3Cpath d='M1574.5 847.2Q1520.7 788.0 1547.6 739.5Q1561.6 804.1 1574.5 847.2Z'/%3E%3Cpath d='M1591.7 786.5Q1618.5 757.1 1605.1 733.0Q1598.2 765.1 1591.7 786.5Z'/%3E%3Cpath d='M1618.5 1000.0 1619.6 983.3 1621.3 966.7 1623.3 950.0 1625.4 933.3 1627.7 916.7 1629.7 900.0 1631.3 883.3 1632.4 866.7 1632.7 850.0 1632.2 833.4 1630.8 816.7 1628.6 800.0 1625.4 783.4 1621.6 766.7 1617.1 750.0 1612.3 733.4 1607.3 716.7 1602.6 700.0 1598.3 683.4 1594.8 666.7 1592.3 650.0 1591.1 633.4 1591.4 616.7 1593.3 600.0 1596.8 583.4 1602.1 566.7 1609.0 550.0 1617.7 533.4 1619.2 533.4 1612.6 550.0 1607.0 566.7 1602.9 583.4 1600.3 600.0 1599.3 616.7 1600.0 633.4 1602.0 650.0 1605.3 666.7 1609.6 683.4 1614.6 700.0 1620.1 716.7 1625.8 733.4 1631.3 750.0 1636.4 766.7 1640.9 783.4 1644.7 800.0 1647.6 816.7 1649.6 833.4 1650.7 850.0 1651.0 866.7 1650.5 883.3 1649.5 900.0 1648.0 916.7 1646.4 933.3 1644.8 950.0 1643.3 966.7 1642.3 983.3 1641.7 1000.0Z'/%3E%3Cpath d='M1641.5 872.5Q1587.2 812.8 1614.4 763.9Q1628.5 829.0 1641.5 872.5Z'/%3E%3Cpath d='M1599.3 663.2Q1652.2 605.0 1625.8 557.4Q1612.0 620.9 1599.3 663.2Z'/%3E%3Cpath d='M1595.8 637.9Q1649.8 578.5 1622.8 529.9Q1608.8 594.7 1595.8 637.9Z'/%3E%3Cpath d='M1705.4 1000.0 1705.4 987.6 1704.9 975.3 1703.9 962.9 1702.8 950.5 1701.6 938.1 1700.7 925.8 1700.4 913.4 1700.8 901.0 1702.1 888.6 1704.3 876.3 1707.4 863.9 1711.2 851.5 1715.4 839.1 1719.6 826.8 1723.6 814.4 1726.8 802.0 1729.0 789.6 1729.8 777.3 1729.0 764.9 1726.5 752.5 1722.5 740.1 1717.3 727.8 1711.1 715.4 1704.6 703.0 1698.2 690.6 1692.8 678.3 1688.7 665.9 1687.0 653.5 1688.5 653.5 1692.5 665.9 1697.9 678.3 1704.5 690.6 1711.9 703.0 1719.5 715.4 1726.6 727.8 1732.7 740.1 1737.5 752.5 1740.8 764.9 1742.4 777.3 1742.4 789.6 1741.0 802.0 1738.5 814.4 1735.2 826.8 1731.6 839.1 1728.1 851.5 1725.0 863.9 1722.6 876.3 1721.0 888.6 1720.4 901.0 1720.6 913.4 1721.6 925.8 1723.1 938.1 1724.8 950.5 1726.6 962.9 1728.1 975.3 1729.2 987.6 1729.8 1000.0Z'/%3E%3Cpath d='M1728.3 824.0Q1695.0 787.4 1711.6 757.4Q1720.3 797.3 1728.3 824.0Z'/%3E%3Cpath d='M1730.2 817.4Q1768.4 775.4 1749.3 741.0Q1739.4 786.8 1730.2 817.4Z'/%3E%3Cpath d='M1713.8 874.6Q1740.5 845.2 1727.1 821.1Q1720.2 853.2 1713.8 874.6Z'/%3E%3Cpath d='M1800.5 1000.0 1801.3 987.6 1801.9 975.3 1802.3 962.9 1802.3 950.5 1802.0 938.1 1801.4 925.8 1800.6 913.4 1799.7 901.0 1798.8 888.6 1797.9 876.3 1797.1 863.9 1796.7 851.5 1796.6 839.2 1796.9 826.8 1797.7 814.4 1799.1 802.0 1801.1 789.7 1803.6 777.3 1806.6 764.9 1810.0 752.5 1813.7 740.2 1817.7 727.8 1821.6 715.4 1825.5 703.1 1829.1 690.7 1832.3 678.3 1835.1 665.9 1837.7 653.6 1839.2 653.6 1839.7 665.9 1838.9 678.3 1837.4 690.7 1835.3 703.1 1832.8 715.4 1830.1 727.8 1827.5 740.2 1824.9 752.5 1822.7 764.9 1820.8 777.3 1819.3 789.7 1818.4 802.0 1818.1 814.4 1818.2 826.8 1818.9 839.2 1820.0 851.5 1821.4 863.9 1823.1 876.3 1824.9 888.6 1826.7 901.0 1828.5 913.4 1830.1 925.8 1831.6 938.1 1832.7 950.5 1833.5 962.9 1834.1 975.3 1834.3 987.6 1834.2 1000.0Z'/%3E%3Cpath d='M1812.6 895.5Q1866.5 836.3 1839.5 787.8Q1825.5 852.4 1812.6 895.5Z'/%3E%3Cpath d='M1810.3 788.8Q1841.7 754.3 1826.0 726.1Q1817.9 763.7 1810.3 788.8Z'/%3E%3Cpath d='M1808.9 800.7Q1836.2 770.7 1822.5 746.2Q1815.5 778.9 1808.9 800.7Z'/%3E%3Cpath d='M1812.8 774.2Q1851.9 731.1 1832.3 695.9Q1822.1 742.9 1812.8 774.2Z'/%3E%3Cpath d='M1964.0 1000.0 1965.9 987.6 1968.2 975.2 1970.8 962.7 1973.1 950.3 1974.8 937.9 1975.6 925.5 1975.2 913.0 1973.4 900.6 1970.4 888.2 1966.1 875.8 1961.1 863.4 1955.6 850.9 1950.2 838.5 1945.4 826.1 1941.9 813.7 1940.2 801.2 1940.6 788.8 1943.4 776.4 1948.6 764.0 1956.3 751.6 1965.9 739.1 1977.0 726.7 1988.9 714.3 2000.8 701.9 2011.8 689.4 2021.0 677.0 2027.7 664.6 2031.8 652.2 2033.3 652.2 2032.1 664.6 2027.1 677.0 2019.4 689.4 2009.8 701.9 1999.2 714.3 1988.5 726.7 1978.5 739.1 1969.9 751.6 1963.3 764.0 1959.1 776.4 1957.2 788.8 1957.8 801.2 1960.5 813.7 1964.9 826.1 1970.5 838.5 1976.8 850.9 1983.2 863.4 1989.1 875.8 1994.1 888.2 1998.0 900.6 2000.5 913.0 2001.7 925.5 2001.7 937.9 2000.8 950.3 1999.2 962.7 1997.4 975.2 1995.8 987.6 1994.7 1000.0Z'/%3E%3Cpath d='M1987.4 721.5Q1960.3 691.7 1973.8 667.2Q1980.9 699.8 1987.4 721.5Z'/%3E%3Cpath d='M1987.6 910.8Q2013.8 881.9 2000.7 858.3Q1993.9 889.8 1987.6 910.8Z'/%3E%3Cpath d='M1980.0 881.9Q1934.2 831.5 1957.1 790.3Q1969.0 845.3 1980.0 881.9Z'/%3E%3C/g%3E%3C/svg%3E\") center bottom / 100% 100% no-repeat;\ntransform-origin: 50% 100%;\nopacity: 0.75;\nanimation: aur-oc-kelp 11s steps(165) infinite alternate-reverse;\n}\n@keyframes aur-oc-kelp { from { transform: skewX(-2.4deg); } to { transform: skewX(2.6deg); } }\n.aur-root[data-fx=\"ocean\"] .aur-fx-c {\ndisplay: block;\nleft: 0;\nright: 0;\ntop: 0;\nheight: calc(100% + 900px);\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 700 900' preserveAspectRatio='xMinYMin slice'%3E%3Cdefs%3E%3CradialGradient id='q' cx='.5' cy='.5' r='.5'%3E%3Cstop offset='.6' stop-color='%23bfeeff' stop-opacity='.03'/%3E%3Cstop offset='.9' stop-color='%23d8f6ff' stop-opacity='.42'/%3E%3Cstop offset='1' stop-color='%23fff' stop-opacity='.7'/%3E%3C/radialGradient%3E%3CradialGradient id='g' cx='.5' cy='.5' r='.5'%3E%3Cstop offset='0' stop-color='%23fff' stop-opacity='.95'/%3E%3Cstop offset='1' stop-color='%23fff' stop-opacity='0'/%3E%3C/radialGradient%3E%3C/defs%3E%3Ccircle cx='651' cy='835' r='6.9' fill='url(%23q)'/%3E%3Cellipse cx='648.8' cy='832.6' rx='1.5' ry='1.0' fill='url(%23g)' transform='rotate(-35 648.8 832.6)'/%3E%3Ccircle cx='76' cy='739' r='17.8' fill='url(%23q)'/%3E%3Cellipse cx='70.3' cy='732.1' rx='3.9' ry='2.5' fill='url(%23g)' transform='rotate(-35 70.3 732.1)'/%3E%3Ccircle cx='462' cy='285' r='15.7' fill='url(%23q)'/%3E%3Cellipse cx='457.0' cy='279.3' rx='3.5' ry='2.2' fill='url(%23g)' transform='rotate(-35 457.0 279.3)'/%3E%3Ccircle cx='420' cy='520' r='8.5' fill='url(%23q)'/%3E%3Cellipse cx='417.8' cy='516.8' rx='1.9' ry='1.2' fill='url(%23g)' transform='rotate(-35 417.8 516.8)'/%3E%3Ccircle cx='304' cy='358' r='17.6' fill='url(%23q)'/%3E%3Cellipse cx='298.6' cy='352.1' rx='3.9' ry='2.5' fill='url(%23g)' transform='rotate(-35 298.6 352.1)'/%3E%3Ccircle cx='677' cy='836' r='14.7' fill='url(%23q)'/%3E%3Cellipse cx='671.9' cy='831.2' rx='3.2' ry='2.1' fill='url(%23g)' transform='rotate(-35 671.9 831.2)'/%3E%3Ccircle cx='314' cy='251' r='6.6' fill='url(%23q)'/%3E%3Cellipse cx='311.5' cy='248.3' rx='1.4' ry='0.9' fill='url(%23g)' transform='rotate(-35 311.5 248.3)'/%3E%3Ccircle cx='38' cy='420' r='11.1' fill='url(%23q)'/%3E%3Cellipse cx='34.6' cy='415.8' rx='2.4' ry='1.6' fill='url(%23g)' transform='rotate(-35 34.6 415.8)'/%3E%3Ccircle cx='271' cy='787' r='14.4' fill='url(%23q)'/%3E%3Cellipse cx='266.2' cy='781.8' rx='3.2' ry='2.0' fill='url(%23g)' transform='rotate(-35 266.2 781.8)'/%3E%3Ccircle cx='390' cy='223' r='6.4' fill='url(%23q)'/%3E%3Cellipse cx='387.9' cy='220.8' rx='1.4' ry='0.9' fill='url(%23g)' transform='rotate(-35 387.9 220.8)'/%3E%3Ccircle cx='235' cy='138' r='14.2' fill='url(%23q)'/%3E%3Cellipse cx='230.1' cy='132.5' rx='3.1' ry='2.0' fill='url(%23g)' transform='rotate(-35 230.1 132.5)'/%3E%3Ccircle cx='679' cy='600' r='8.9' fill='url(%23q)'/%3E%3Cellipse cx='676.3' cy='596.8' rx='2.0' ry='1.2' fill='url(%23g)' transform='rotate(-35 676.3 596.8)'/%3E%3Ccircle cx='610' cy='705' r='17.8' fill='url(%23q)'/%3E%3Cellipse cx='604.1' cy='698.8' rx='3.9' ry='2.5' fill='url(%23g)' transform='rotate(-35 604.1 698.8)'/%3E%3Ccircle cx='618' cy='676' r='18.6' fill='url(%23q)'/%3E%3Cellipse cx='612.4' cy='669.4' rx='4.1' ry='2.6' fill='url(%23g)' transform='rotate(-35 612.4 669.4)'/%3E%3Ccircle cx='253' cy='864' r='21.4' fill='url(%23q)'/%3E%3Cellipse cx='246.7' cy='855.9' rx='4.7' ry='3.0' fill='url(%23g)' transform='rotate(-35 246.7 855.9)'/%3E%3Ccircle cx='126' cy='668' r='17.4' fill='url(%23q)'/%3E%3Cellipse cx='120.8' cy='662.2' rx='3.8' ry='2.4' fill='url(%23g)' transform='rotate(-35 120.8 662.2)'/%3E%3Ccircle cx='325' cy='476' r='13.8' fill='url(%23q)'/%3E%3Cellipse cx='320.1' cy='471.1' rx='3.0' ry='1.9' fill='url(%23g)' transform='rotate(-35 320.1 471.1)'/%3E%3Ccircle cx='630' cy='451' r='19.3' fill='url(%23q)'/%3E%3Cellipse cx='624.2' cy='443.8' rx='4.2' ry='2.7' fill='url(%23g)' transform='rotate(-35 624.2 443.8)'/%3E%3Ccircle cx='254' cy='779' r='20.4' fill='url(%23q)'/%3E%3Cellipse cx='247.1' cy='771.9' rx='4.5' ry='2.9' fill='url(%23g)' transform='rotate(-35 247.1 771.9)'/%3E%3Ccircle cx='324' cy='508' r='20.7' fill='url(%23q)'/%3E%3Cellipse cx='317.6' cy='500.8' rx='4.6' ry='2.9' fill='url(%23g)' transform='rotate(-35 317.6 500.8)'/%3E%3C/svg%3E\") 0 0 / 700px 900px repeat;\nanimation: aur-oc-rise-tile 45s steps(675) infinite linear;\n}\n@keyframes aur-oc-rise-tile { to { transform: translateY(-900px); } }\n.aur-root[data-fx=\"ocean\"] .aur-fx-c::before {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 500 700' preserveAspectRatio='xMinYMin slice'%3E%3Cdefs%3E%3CradialGradient id='q' cx='.5' cy='.5' r='.5'%3E%3Cstop offset='.6' stop-color='%23bfeeff' stop-opacity='.03'/%3E%3Cstop offset='.9' stop-color='%23d8f6ff' stop-opacity='.42'/%3E%3Cstop offset='1' stop-color='%23fff' stop-opacity='.7'/%3E%3C/radialGradient%3E%3CradialGradient id='g' cx='.5' cy='.5' r='.5'%3E%3Cstop offset='0' stop-color='%23fff' stop-opacity='.95'/%3E%3Cstop offset='1' stop-color='%23fff' stop-opacity='0'/%3E%3C/radialGradient%3E%3C/defs%3E%3Ccircle cx='307' cy='510' r='6.1' fill='url(%23q)'/%3E%3Cellipse cx='304.6' cy='507.4' rx='1.3' ry='0.9' fill='url(%23g)' transform='rotate(-35 304.6 507.4)'/%3E%3Ccircle cx='454' cy='508' r='6.7' fill='url(%23q)'/%3E%3Cellipse cx='451.4' cy='505.9' rx='1.5' ry='0.9' fill='url(%23g)' transform='rotate(-35 451.4 505.9)'/%3E%3Ccircle cx='33' cy='327' r='6.7' fill='url(%23q)'/%3E%3Cellipse cx='31.2' cy='324.9' rx='1.5' ry='0.9' fill='url(%23g)' transform='rotate(-35 31.2 324.9)'/%3E%3Ccircle cx='319' cy='615' r='3.0' fill='url(%23q)'/%3E%3Cellipse cx='317.6' cy='613.5' rx='0.7' ry='0.4' fill='url(%23g)' transform='rotate(-35 317.6 613.5)'/%3E%3Ccircle cx='236' cy='183' r='4.9' fill='url(%23q)'/%3E%3Cellipse cx='234.2' cy='181.0' rx='1.1' ry='0.7' fill='url(%23g)' transform='rotate(-35 234.2 181.0)'/%3E%3Ccircle cx='284' cy='29' r='3.5' fill='url(%23q)'/%3E%3Cellipse cx='282.9' cy='27.4' rx='0.8' ry='0.5' fill='url(%23g)' transform='rotate(-35 282.9 27.4)'/%3E%3Ccircle cx='149' cy='625' r='5.9' fill='url(%23q)'/%3E%3Cellipse cx='146.7' cy='622.6' rx='1.3' ry='0.8' fill='url(%23g)' transform='rotate(-35 146.7 622.6)'/%3E%3Ccircle cx='93' cy='546' r='3.1' fill='url(%23q)'/%3E%3Cellipse cx='92.4' cy='545.0' rx='0.7' ry='0.4' fill='url(%23g)' transform='rotate(-35 92.4 545.0)'/%3E%3Ccircle cx='304' cy='104' r='2.5' fill='url(%23q)'/%3E%3Cellipse cx='303.2' cy='102.7' rx='0.6' ry='0.4' fill='url(%23g)' transform='rotate(-35 303.2 102.7)'/%3E%3Ccircle cx='421' cy='158' r='3.5' fill='url(%23q)'/%3E%3Cellipse cx='419.7' cy='157.0' rx='0.8' ry='0.5' fill='url(%23g)' transform='rotate(-35 419.7 157.0)'/%3E%3Ccircle cx='472' cy='596' r='3.8' fill='url(%23q)'/%3E%3Cellipse cx='470.7' cy='594.4' rx='0.8' ry='0.5' fill='url(%23g)' transform='rotate(-35 470.7 594.4)'/%3E%3Ccircle cx='462' cy='376' r='5.6' fill='url(%23q)'/%3E%3Cellipse cx='460.5' cy='373.9' rx='1.2' ry='0.8' fill='url(%23g)' transform='rotate(-35 460.5 373.9)'/%3E%3Ccircle cx='114' cy='641' r='5.6' fill='url(%23q)'/%3E%3Cellipse cx='112.4' cy='639.0' rx='1.2' ry='0.8' fill='url(%23g)' transform='rotate(-35 112.4 639.0)'/%3E%3Ccircle cx='465' cy='610' r='3.8' fill='url(%23q)'/%3E%3Cellipse cx='463.4' cy='608.5' rx='0.8' ry='0.5' fill='url(%23g)' transform='rotate(-35 463.4 608.5)'/%3E%3Ccircle cx='186' cy='130' r='3.2' fill='url(%23q)'/%3E%3Cellipse cx='185.1' cy='128.4' rx='0.7' ry='0.4' fill='url(%23g)' transform='rotate(-35 185.1 128.4)'/%3E%3Ccircle cx='50' cy='219' r='5.2' fill='url(%23q)'/%3E%3Cellipse cx='48.3' cy='217.0' rx='1.1' ry='0.7' fill='url(%23g)' transform='rotate(-35 48.3 217.0)'/%3E%3Ccircle cx='22' cy='467' r='4.0' fill='url(%23q)'/%3E%3Cellipse cx='20.3' cy='466.0' rx='0.9' ry='0.6' fill='url(%23g)' transform='rotate(-35 20.3 466.0)'/%3E%3Ccircle cx='163' cy='560' r='4.7' fill='url(%23q)'/%3E%3Cellipse cx='161.1' cy='558.5' rx='1.0' ry='0.7' fill='url(%23g)' transform='rotate(-35 161.1 558.5)'/%3E%3Ccircle cx='165' cy='338' r='5.7' fill='url(%23q)'/%3E%3Cellipse cx='163.5' cy='335.6' rx='1.2' ry='0.8' fill='url(%23g)' transform='rotate(-35 163.5 335.6)'/%3E%3Ccircle cx='46' cy='664' r='2.6' fill='url(%23q)'/%3E%3Cellipse cx='45.4' cy='662.6' rx='0.6' ry='0.4' fill='url(%23g)' transform='rotate(-35 45.4 662.6)'/%3E%3Ccircle cx='365' cy='578' r='2.6' fill='url(%23q)'/%3E%3Cellipse cx='364.1' cy='576.7' rx='0.6' ry='0.4' fill='url(%23g)' transform='rotate(-35 364.1 576.7)'/%3E%3Ccircle cx='382' cy='262' r='5.1' fill='url(%23q)'/%3E%3Cellipse cx='380.7' cy='259.8' rx='1.1' ry='0.7' fill='url(%23g)' transform='rotate(-35 380.7 259.8)'/%3E%3Ccircle cx='24' cy='51' r='3.3' fill='url(%23q)'/%3E%3Cellipse cx='23.1' cy='49.6' rx='0.7' ry='0.5' fill='url(%23g)' transform='rotate(-35 23.1 49.6)'/%3E%3Ccircle cx='459' cy='150' r='5.9' fill='url(%23q)'/%3E%3Cellipse cx='457.5' cy='147.6' rx='1.3' ry='0.8' fill='url(%23g)' transform='rotate(-35 457.5 147.6)'/%3E%3Ccircle cx='448' cy='642' r='4.0' fill='url(%23q)'/%3E%3Cellipse cx='446.3' cy='640.3' rx='0.9' ry='0.6' fill='url(%23g)' transform='rotate(-35 446.3 640.3)'/%3E%3Ccircle cx='183' cy='366' r='6.0' fill='url(%23q)'/%3E%3Cellipse cx='181.3' cy='364.1' rx='1.3' ry='0.8' fill='url(%23g)' transform='rotate(-35 181.3 364.1)'/%3E%3Ccircle cx='70' cy='514' r='6.1' fill='url(%23q)'/%3E%3Cellipse cx='67.8' cy='511.8' rx='1.3' ry='0.9' fill='url(%23g)' transform='rotate(-35 67.8 511.8)'/%3E%3Ccircle cx='415' cy='44' r='6.8' fill='url(%23q)'/%3E%3Cellipse cx='413.3' cy='41.7' rx='1.5' ry='0.9' fill='url(%23g)' transform='rotate(-35 413.3 41.7)'/%3E%3Ccircle cx='62' cy='245' r='5.2' fill='url(%23q)'/%3E%3Cellipse cx='60.3' cy='243.0' rx='1.2' ry='0.7' fill='url(%23g)' transform='rotate(-35 60.3 243.0)'/%3E%3Ccircle cx='442' cy='244' r='6.7' fill='url(%23q)'/%3E%3Cellipse cx='440.2' cy='242.0' rx='1.5' ry='0.9' fill='url(%23g)' transform='rotate(-35 440.2 242.0)'/%3E%3C/svg%3E\") 0 0 / 500px 700px repeat;\nanimation: aur-oc-rise-small 20s steps(300) infinite linear;\n}\n@keyframes aur-oc-rise-small { to { transform: translateY(-700px); } }\n.aur-root[data-fx=\"ocean\"] .aur-fx::after {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: linear-gradient(to bottom, #001028, #000818);\nopacity: calc(var(--aur-song, 0) * 0.42);\ntransition: opacity 1s linear;\n}\n.aur-root[data-fx=\"ocean\"] .aur-bg-grain { opacity: 0.02; }\n.aur-root[data-look=\"ocean\"] { --aur-glow-tint: #7fe0ff; }\n.aur-root[data-look=\"ocean\"][data-color=\"white\"] { --aur-hi: #e6fbff; }\n.aur-root[data-look=\"ocean\"][data-motion=\"full\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active .aur-main { animation: aur-oc-line 1.6s var(--aur-ease); }\n@keyframes aur-oc-line { from { opacity: 0.3; transform: translateY(0.3em); } }\n.aur-root[data-fx=\"rain\"] .aur-fx {\nbackground: linear-gradient(to bottom, rgba(10, 16, 30, 0.86), rgba(14, 22, 40, 0.8) 60%, rgba(20, 26, 44, 0.72));\n}\n.aur-root[data-fx=\"rain\"] .aur-fx::before {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground:\nlinear-gradient(115deg, transparent 30%, rgba(255, 255, 255, 0.035) 34%, transparent 40%, transparent 62%, rgba(255, 255, 255, 0.025) 66%, transparent 70%),\nradial-gradient(120% 90% at 50% 100%, rgba(150, 170, 200, 0.16), transparent 60%),\nradial-gradient(130% 110% at 50% 45%, transparent 55%, rgba(2, 4, 10, 0.6));\nbox-shadow: inset 0 0 0 1.3vmin rgba(4, 6, 12, 0.92), inset 0 0 0 1.5vmin rgba(120, 140, 170, 0.18);\n}\n.aur-root[data-fx=\"rain\"] .aur-fx-a {\ndisplay: block;\ninset: 0;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 900' preserveAspectRatio='xMidYMid slice'%3E%3Cdefs%3E%3Cfilter id='b' x='-50%25' y='-50%25' width='200%25' height='200%25'%3E%3CfeGaussianBlur stdDeviation='9'/%3E%3C/filter%3E%3C/defs%3E%3Ccircle cx='1463' cy='835' r='41' fill='rgb(255,190,110)' fill-opacity='0.14' filter='url(%23b)'/%3E%3Ccircle cx='499' cy='562' r='23' fill='rgb(190,240,230)' fill-opacity='0.19' filter='url(%23b)'/%3E%3Ccircle cx='714' cy='486' r='27' fill='rgb(255,190,110)' fill-opacity='0.17' filter='url(%23b)'/%3E%3Ccircle cx='1551' cy='619' r='13' fill='rgb(190,240,230)' fill-opacity='0.35' filter='url(%23b)'/%3E%3Ccircle cx='580' cy='408' r='37' fill='rgb(255,120,120)' fill-opacity='0.24' filter='url(%23b)'/%3E%3Ccircle cx='288' cy='484' r='36' fill='rgb(255,120,120)' fill-opacity='0.35' filter='url(%23b)'/%3E%3Ccircle cx='595' cy='655' r='33' fill='rgb(255,210,150)' fill-opacity='0.30' filter='url(%23b)'/%3E%3Ccircle cx='1290' cy='465' r='27' fill='rgb(255,235,190)' fill-opacity='0.27' filter='url(%23b)'/%3E%3Ccircle cx='1022' cy='467' r='18' fill='rgb(255,210,150)' fill-opacity='0.33' filter='url(%23b)'/%3E%3Ccircle cx='831' cy='660' r='15' fill='rgb(120,190,240)' fill-opacity='0.15' filter='url(%23b)'/%3E%3Ccircle cx='450' cy='655' r='38' fill='rgb(255,210,150)' fill-opacity='0.17' filter='url(%23b)'/%3E%3Ccircle cx='1424' cy='640' r='41' fill='rgb(120,190,240)' fill-opacity='0.29' filter='url(%23b)'/%3E%3Ccircle cx='423' cy='431' r='37' fill='rgb(190,240,230)' fill-opacity='0.36' filter='url(%23b)'/%3E%3Ccircle cx='789' cy='538' r='17' fill='rgb(190,240,230)' fill-opacity='0.31' filter='url(%23b)'/%3E%3Ccircle cx='1495' cy='460' r='43' fill='rgb(255,190,110)' fill-opacity='0.32' filter='url(%23b)'/%3E%3Ccircle cx='634' cy='458' r='19' fill='rgb(255,190,110)' fill-opacity='0.41' filter='url(%23b)'/%3E%3Ccircle cx='1276' cy='835' r='29' fill='rgb(120,190,240)' fill-opacity='0.35' filter='url(%23b)'/%3E%3Ccircle cx='560' cy='848' r='24' fill='rgb(255,160,90)' fill-opacity='0.15' filter='url(%23b)'/%3E%3Ccircle cx='432' cy='643' r='36' fill='rgb(120,190,240)' fill-opacity='0.41' filter='url(%23b)'/%3E%3Ccircle cx='357' cy='430' r='29' fill='rgb(255,160,90)' fill-opacity='0.33' filter='url(%23b)'/%3E%3Ccircle cx='890' cy='495' r='15' fill='rgb(255,160,90)' fill-opacity='0.39' filter='url(%23b)'/%3E%3Ccircle cx='714' cy='545' r='41' fill='rgb(255,235,190)' fill-opacity='0.19' filter='url(%23b)'/%3E%3Ccircle cx='983' cy='769' r='14' fill='rgb(255,235,190)' fill-opacity='0.39' filter='url(%23b)'/%3E%3Ccircle cx='1183' cy='642' r='26' fill='rgb(255,210,150)' fill-opacity='0.36' filter='url(%23b)'/%3E%3Ccircle cx='889' cy='644' r='38' fill='rgb(255,190,110)' fill-opacity='0.15' filter='url(%23b)'/%3E%3Ccircle cx='237' cy='843' r='35' fill='rgb(120,190,240)' fill-opacity='0.21' filter='url(%23b)'/%3E%3Ccircle cx='1504' cy='418' r='30' fill='rgb(255,120,120)' fill-opacity='0.17' filter='url(%23b)'/%3E%3Ccircle cx='1404' cy='840' r='38' fill='rgb(190,240,230)' fill-opacity='0.22' filter='url(%23b)'/%3E%3Ccircle cx='548' cy='391' r='43' fill='rgb(190,240,230)' fill-opacity='0.38' filter='url(%23b)'/%3E%3Ccircle cx='338' cy='707' r='18' fill='rgb(120,190,240)' fill-opacity='0.35' filter='url(%23b)'/%3E%3Ccircle cx='1509' cy='582' r='21' fill='rgb(255,120,120)' fill-opacity='0.33' filter='url(%23b)'/%3E%3Ccircle cx='861' cy='647' r='29' fill='rgb(255,210,150)' fill-opacity='0.21' filter='url(%23b)'/%3E%3Ccircle cx='1570' cy='489' r='14' fill='rgb(120,190,240)' fill-opacity='0.25' filter='url(%23b)'/%3E%3Ccircle cx='48' cy='599' r='25' fill='rgb(190,240,230)' fill-opacity='0.23' filter='url(%23b)'/%3E%3Ccircle cx='565' cy='525' r='43' fill='rgb(255,210,150)' fill-opacity='0.18' filter='url(%23b)'/%3E%3Ccircle cx='87' cy='806' r='33' fill='rgb(255,235,190)' fill-opacity='0.30' filter='url(%23b)'/%3E%3C/svg%3E\") center / cover no-repeat;\nopacity: 0.75;\ntransition: opacity 2s ease;\nanimation: aur-rn-glow 9s steps(54) infinite alternate;\n}\n.aur-root[data-fx=\"rain\"][data-gap=\"on\"] .aur-fx-a { opacity: 0.95; }\n.aur-root[data-fx=\"rain\"][data-bganim=\"on\"][data-lb=\"a\"] .aur-fx-a { animation: aur-rn-glow 9s steps(54) infinite alternate, aur-fx-flash-a 1.6s ease-out; }\n.aur-root[data-fx=\"rain\"][data-bganim=\"on\"][data-lb=\"b\"] .aur-fx-a { animation: aur-rn-glow 9s steps(54) infinite alternate, aur-fx-flash-b 1.6s ease-out; }\n@keyframes aur-rn-glow { from { opacity: 0.6; } to { opacity: 0.9; } }\n.aur-root[data-fx=\"rain\"] .aur-fx-b {\ndisplay: block;\ninset: 0;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 900' preserveAspectRatio='xMidYMid slice'%3E%3Cdefs%3E%3CradialGradient id='d' cx='.5' cy='.58' r='.55'%3E%3Cstop offset='0' stop-color='%23a9c8e8' stop-opacity='.22'/%3E%3Cstop offset='.72' stop-color='%230a1220' stop-opacity='.28'/%3E%3Cstop offset='1' stop-color='%23dbeaff' stop-opacity='.55'/%3E%3C/radialGradient%3E%3CradialGradient id='s' cx='.5' cy='.5' r='.5'%3E%3Cstop offset='0' stop-color='%23fff' stop-opacity='.95'/%3E%3Cstop offset='1' stop-color='%23fff' stop-opacity='0'/%3E%3C/radialGradient%3E%3C/defs%3E%3Cellipse cx='20' cy='101' rx='3.5' ry='4.3' fill='url(%23d)'/%3E%3Cellipse cx='18.7' cy='99.3' rx='1.1' ry='0.9' fill='url(%23s)'/%3E%3Cellipse cx='1138' cy='126' rx='5.0' ry='6.1' fill='url(%23d)'/%3E%3Cellipse cx='1137.0' cy='123.1' rx='1.6' ry='1.2' fill='url(%23s)'/%3E%3Cellipse cx='716' cy='371' rx='4.5' ry='5.2' fill='url(%23d)'/%3E%3Cellipse cx='715.2' cy='369.1' rx='1.4' ry='1.0' fill='url(%23s)'/%3E%3Cellipse cx='329' cy='353' rx='5.2' ry='6.6' fill='url(%23d)'/%3E%3Cellipse cx='328.0' cy='350.0' rx='1.7' ry='1.3' fill='url(%23s)'/%3E%3Cellipse cx='876' cy='858' rx='5.8' ry='6.1' fill='url(%23d)'/%3E%3Cellipse cx='874.2' cy='855.8' rx='1.8' ry='1.2' fill='url(%23s)'/%3E%3Cellipse cx='1176' cy='782' rx='12.6' ry='14.8' fill='url(%23d)'/%3E%3Cellipse cx='1172.6' cy='775.3' rx='4.0' ry='3.0' fill='url(%23s)'/%3E%3Cellipse cx='529' cy='737' rx='9.1' ry='10.8' fill='url(%23d)'/%3E%3Cellipse cx='526.5' cy='732.4' rx='2.9' ry='2.2' fill='url(%23s)'/%3E%3Cellipse cx='1035' cy='753' rx='8.9' ry='12.1' fill='url(%23d)'/%3E%3Cellipse cx='1032.3' cy='747.5' rx='2.8' ry='2.4' fill='url(%23s)'/%3E%3Cellipse cx='896' cy='842' rx='4.6' ry='6.3' fill='url(%23d)'/%3E%3Cellipse cx='894.5' cy='839.7' rx='1.5' ry='1.3' fill='url(%23s)'/%3E%3Cellipse cx='962' cy='626' rx='13.4' ry='18.0' fill='url(%23d)'/%3E%3Cellipse cx='958.5' cy='618.3' rx='4.3' ry='3.6' fill='url(%23s)'/%3E%3Cellipse cx='1416' cy='103' rx='3.0' ry='3.7' fill='url(%23d)'/%3E%3Cellipse cx='1415.0' cy='101.0' rx='1.0' ry='0.7' fill='url(%23s)'/%3E%3Cellipse cx='189' cy='89' rx='4.6' ry='5.1' fill='url(%23d)'/%3E%3Cellipse cx='187.6' cy='86.8' rx='1.5' ry='1.0' fill='url(%23s)'/%3E%3Cellipse cx='1584' cy='137' rx='7.1' ry='9.8' fill='url(%23d)'/%3E%3Cellipse cx='1582.3' cy='132.6' rx='2.3' ry='2.0' fill='url(%23s)'/%3E%3Cellipse cx='784' cy='532' rx='12.6' ry='16.3' fill='url(%23d)'/%3E%3Cellipse cx='780.9' cy='524.8' rx='4.0' ry='3.3' fill='url(%23s)'/%3E%3Cellipse cx='1557' cy='691' rx='7.8' ry='8.9' fill='url(%23d)'/%3E%3Cellipse cx='1554.9' cy='687.1' rx='2.5' ry='1.8' fill='url(%23s)'/%3E%3Cellipse cx='155' cy='524' rx='7.9' ry='10.7' fill='url(%23d)'/%3E%3Cellipse cx='152.6' cy='519.9' rx='2.5' ry='2.1' fill='url(%23s)'/%3E%3Cellipse cx='80' cy='553' rx='5.0' ry='6.4' fill='url(%23d)'/%3E%3Cellipse cx='78.6' cy='549.9' rx='1.6' ry='1.3' fill='url(%23s)'/%3E%3Cellipse cx='887' cy='503' rx='3.8' ry='4.7' fill='url(%23d)'/%3E%3Cellipse cx='886.1' cy='500.7' rx='1.2' ry='0.9' fill='url(%23s)'/%3E%3Cellipse cx='1147' cy='415' rx='4.3' ry='5.3' fill='url(%23d)'/%3E%3Cellipse cx='1146.2' cy='413.2' rx='1.4' ry='1.1' fill='url(%23s)'/%3E%3Cellipse cx='555' cy='172' rx='3.2' ry='4.4' fill='url(%23d)'/%3E%3Cellipse cx='554.1' cy='170.6' rx='1.0' ry='0.9' fill='url(%23s)'/%3E%3Cellipse cx='190' cy='382' rx='5.9' ry='8.0' fill='url(%23d)'/%3E%3Cellipse cx='188.4' cy='379.0' rx='1.9' ry='1.6' fill='url(%23s)'/%3E%3Cellipse cx='491' cy='529' rx='4.8' ry='5.1' fill='url(%23d)'/%3E%3Cellipse cx='489.8' cy='526.4' rx='1.5' ry='1.0' fill='url(%23s)'/%3E%3Cellipse cx='984' cy='806' rx='5.0' ry='5.6' fill='url(%23d)'/%3E%3Cellipse cx='982.1' cy='803.5' rx='1.6' ry='1.1' fill='url(%23s)'/%3E%3Cellipse cx='53' cy='399' rx='5.2' ry='6.7' fill='url(%23d)'/%3E%3Cellipse cx='52.0' cy='396.4' rx='1.7' ry='1.3' fill='url(%23s)'/%3E%3Cellipse cx='589' cy='694' rx='5.2' ry='7.1' fill='url(%23d)'/%3E%3Cellipse cx='587.7' cy='691.0' rx='1.7' ry='1.4' fill='url(%23s)'/%3E%3Cellipse cx='723' cy='587' rx='4.1' ry='4.8' fill='url(%23d)'/%3E%3Cellipse cx='721.9' cy='584.9' rx='1.3' ry='1.0' fill='url(%23s)'/%3E%3Cellipse cx='758' cy='5' rx='5.9' ry='8.0' fill='url(%23d)'/%3E%3Cellipse cx='756.4' cy='1.6' rx='1.9' ry='1.6' fill='url(%23s)'/%3E%3Cellipse cx='394' cy='277' rx='4.7' ry='6.4' fill='url(%23d)'/%3E%3Cellipse cx='392.3' cy='274.0' rx='1.5' ry='1.3' fill='url(%23s)'/%3E%3Cellipse cx='865' cy='288' rx='6.9' ry='9.4' fill='url(%23d)'/%3E%3Cellipse cx='863.6' cy='283.8' rx='2.2' ry='1.9' fill='url(%23s)'/%3E%3Cellipse cx='788' cy='275' rx='8.7' ry='10.3' fill='url(%23d)'/%3E%3Cellipse cx='785.5' cy='271.1' rx='2.8' ry='2.1' fill='url(%23s)'/%3E%3Cellipse cx='342' cy='798' rx='11.0' ry='12.5' fill='url(%23d)'/%3E%3Cellipse cx='338.5' cy='792.6' rx='3.5' ry='2.5' fill='url(%23s)'/%3E%3Cellipse cx='1357' cy='370' rx='7.8' ry='8.3' fill='url(%23d)'/%3E%3Cellipse cx='1354.8' cy='366.6' rx='2.5' ry='1.7' fill='url(%23s)'/%3E%3Cellipse cx='397' cy='443' rx='4.7' ry='6.3' fill='url(%23d)'/%3E%3Cellipse cx='395.9' cy='439.9' rx='1.5' ry='1.3' fill='url(%23s)'/%3E%3Cellipse cx='1495' cy='203' rx='6.7' ry='9.0' fill='url(%23d)'/%3E%3Cellipse cx='1493.3' cy='199.1' rx='2.2' ry='1.8' fill='url(%23s)'/%3E%3Cellipse cx='704' cy='432' rx='13.3' ry='17.0' fill='url(%23d)'/%3E%3Cellipse cx='700.3' cy='424.9' rx='4.3' ry='3.4' fill='url(%23s)'/%3E%3Cellipse cx='376' cy='894' rx='5.8' ry='7.9' fill='url(%23d)'/%3E%3Cellipse cx='374.6' cy='890.4' rx='1.9' ry='1.6' fill='url(%23s)'/%3E%3Cellipse cx='516' cy='350' rx='8.7' ry='9.3' fill='url(%23d)'/%3E%3Cellipse cx='513.2' cy='346.3' rx='2.8' ry='1.9' fill='url(%23s)'/%3E%3Cellipse cx='1169' cy='406' rx='12.1' ry='15.0' fill='url(%23d)'/%3E%3Cellipse cx='1165.2' cy='399.6' rx='3.9' ry='3.0' fill='url(%23s)'/%3E%3Cellipse cx='510' cy='215' rx='7.4' ry='8.6' fill='url(%23d)'/%3E%3Cellipse cx='507.7' cy='211.9' rx='2.4' ry='1.7' fill='url(%23s)'/%3E%3Cellipse cx='1135' cy='177' rx='6.3' ry='8.8' fill='url(%23d)'/%3E%3Cellipse cx='1132.9' cy='172.9' rx='2.0' ry='1.8' fill='url(%23s)'/%3E%3Cellipse cx='674' cy='282' rx='6.2' ry='6.7' fill='url(%23d)'/%3E%3Cellipse cx='672.0' cy='279.1' rx='2.0' ry='1.3' fill='url(%23s)'/%3E%3Cellipse cx='1042' cy='807' rx='4.5' ry='5.9' fill='url(%23d)'/%3E%3Cellipse cx='1041.1' cy='804.8' rx='1.5' ry='1.2' fill='url(%23s)'/%3E%3Cellipse cx='496' cy='598' rx='5.0' ry='6.6' fill='url(%23d)'/%3E%3Cellipse cx='495.0' cy='595.4' rx='1.6' ry='1.3' fill='url(%23s)'/%3E%3Cellipse cx='867' cy='437' rx='3.4' ry='3.9' fill='url(%23d)'/%3E%3Cellipse cx='866.2' cy='435.8' rx='1.1' ry='0.8' fill='url(%23s)'/%3E%3Cellipse cx='514' cy='767' rx='9.3' ry='12.0' fill='url(%23d)'/%3E%3Cellipse cx='511.8' cy='761.7' rx='3.0' ry='2.4' fill='url(%23s)'/%3E%3Cellipse cx='977' cy='766' rx='4.7' ry='5.4' fill='url(%23d)'/%3E%3Cellipse cx='975.5' cy='763.6' rx='1.5' ry='1.1' fill='url(%23s)'/%3E%3Cellipse cx='872' cy='708' rx='13.0' ry='14.8' fill='url(%23d)'/%3E%3Cellipse cx='868.2' cy='701.9' rx='4.2' ry='3.0' fill='url(%23s)'/%3E%3Cellipse cx='120' cy='552' rx='10.3' ry='13.4' fill='url(%23d)'/%3E%3Cellipse cx='116.8' cy='546.4' rx='3.3' ry='2.7' fill='url(%23s)'/%3E%3Cellipse cx='1150' cy='666' rx='8.2' ry='9.0' fill='url(%23d)'/%3E%3Cellipse cx='1147.6' cy='662.1' rx='2.6' ry='1.8' fill='url(%23s)'/%3E%3Cellipse cx='1403' cy='320' rx='8.5' ry='9.0' fill='url(%23d)'/%3E%3Cellipse cx='1400.8' cy='316.4' rx='2.7' ry='1.8' fill='url(%23s)'/%3E%3Cellipse cx='595' cy='686' rx='4.3' ry='5.6' fill='url(%23d)'/%3E%3Cellipse cx='593.8' cy='683.9' rx='1.4' ry='1.1' fill='url(%23s)'/%3E%3Cellipse cx='1181' cy='532' rx='3.4' ry='4.4' fill='url(%23d)'/%3E%3Cellipse cx='1179.8' cy='530.6' rx='1.1' ry='0.9' fill='url(%23s)'/%3E%3Cellipse cx='1451' cy='540' rx='4.5' ry='6.1' fill='url(%23d)'/%3E%3Cellipse cx='1449.4' cy='537.3' rx='1.5' ry='1.2' fill='url(%23s)'/%3E%3Cellipse cx='556' cy='162' rx='2.7' ry='3.7' fill='url(%23d)'/%3E%3Cellipse cx='555.7' cy='160.4' rx='0.9' ry='0.7' fill='url(%23s)'/%3E%3Cellipse cx='640' cy='88' rx='9.1' ry='9.6' fill='url(%23d)'/%3E%3Cellipse cx='637.6' cy='84.4' rx='2.9' ry='1.9' fill='url(%23s)'/%3E%3Cellipse cx='119' cy='129' rx='4.9' ry='5.7' fill='url(%23d)'/%3E%3Cellipse cx='117.4' cy='127.0' rx='1.6' ry='1.1' fill='url(%23s)'/%3E%3Cellipse cx='399' cy='783' rx='8.6' ry='10.3' fill='url(%23d)'/%3E%3Cellipse cx='396.7' cy='778.5' rx='2.8' ry='2.1' fill='url(%23s)'/%3E%3Cellipse cx='1588' cy='583' rx='4.9' ry='6.8' fill='url(%23d)'/%3E%3Cellipse cx='1587.0' cy='580.3' rx='1.6' ry='1.4' fill='url(%23s)'/%3E%3Cellipse cx='909' cy='134' rx='7.2' ry='9.3' fill='url(%23d)'/%3E%3Cellipse cx='906.5' cy='129.9' rx='2.3' ry='1.9' fill='url(%23s)'/%3E%3Cellipse cx='785' cy='310' rx='2.9' ry='3.3' fill='url(%23d)'/%3E%3Cellipse cx='784.2' cy='308.3' rx='0.9' ry='0.7' fill='url(%23s)'/%3E%3Cellipse cx='571' cy='861' rx='9.4' ry='11.1' fill='url(%23d)'/%3E%3Cellipse cx='568.5' cy='856.7' rx='3.0' ry='2.2' fill='url(%23s)'/%3E%3Cellipse cx='694' cy='510' rx='4.2' ry='5.2' fill='url(%23d)'/%3E%3Cellipse cx='692.4' cy='508.1' rx='1.3' ry='1.0' fill='url(%23s)'/%3E%3Cellipse cx='949' cy='746' rx='11.9' ry='16.1' fill='url(%23d)'/%3E%3Cellipse cx='946.1' cy='739.1' rx='3.8' ry='3.2' fill='url(%23s)'/%3E%3Cellipse cx='1227' cy='442' rx='7.0' ry='9.0' fill='url(%23d)'/%3E%3Cellipse cx='1225.4' cy='438.3' rx='2.2' ry='1.8' fill='url(%23s)'/%3E%3Cellipse cx='1564' cy='849' rx='8.9' ry='10.1' fill='url(%23d)'/%3E%3Cellipse cx='1561.7' cy='844.7' rx='2.8' ry='2.0' fill='url(%23s)'/%3E%3Cellipse cx='713' cy='220' rx='8.6' ry='11.0' fill='url(%23d)'/%3E%3Cellipse cx='710.3' cy='215.2' rx='2.8' ry='2.2' fill='url(%23s)'/%3E%3Cellipse cx='963' cy='247' rx='11.9' ry='16.0' fill='url(%23d)'/%3E%3Cellipse cx='959.3' cy='240.1' rx='3.8' ry='3.2' fill='url(%23s)'/%3E%3Cellipse cx='41' cy='357' rx='2.6' ry='3.6' fill='url(%23d)'/%3E%3Cellipse cx='40.2' cy='355.1' rx='0.8' ry='0.7' fill='url(%23s)'/%3E%3Cellipse cx='748' cy='610' rx='8.7' ry='10.2' fill='url(%23d)'/%3E%3Cellipse cx='745.4' cy='605.5' rx='2.8' ry='2.0' fill='url(%23s)'/%3E%3Cellipse cx='259' cy='259' rx='8.1' ry='8.7' fill='url(%23d)'/%3E%3Cellipse cx='257.1' cy='255.2' rx='2.6' ry='1.7' fill='url(%23s)'/%3E%3Cellipse cx='1073' cy='438' rx='8.8' ry='9.4' fill='url(%23d)'/%3E%3Cellipse cx='1070.4' cy='434.1' rx='2.8' ry='1.9' fill='url(%23s)'/%3E%3Cellipse cx='911' cy='471' rx='4.2' ry='4.5' fill='url(%23d)'/%3E%3Cellipse cx='909.3' cy='468.8' rx='1.3' ry='0.9' fill='url(%23s)'/%3E%3Cellipse cx='893' cy='78' rx='4.7' ry='5.4' fill='url(%23d)'/%3E%3Cellipse cx='891.9' cy='76.0' rx='1.5' ry='1.1' fill='url(%23s)'/%3E%3Cellipse cx='1314' cy='332' rx='8.6' ry='11.6' fill='url(%23d)'/%3E%3Cellipse cx='1312.0' cy='327.6' rx='2.8' ry='2.3' fill='url(%23s)'/%3E%3Cellipse cx='1414' cy='900' rx='3.7' ry='4.7' fill='url(%23d)'/%3E%3Cellipse cx='1412.5' cy='898.0' rx='1.2' ry='0.9' fill='url(%23s)'/%3E%3Cellipse cx='1032' cy='21' rx='9.5' ry='11.6' fill='url(%23d)'/%3E%3Cellipse cx='1029.0' cy='16.2' rx='3.0' ry='2.3' fill='url(%23s)'/%3E%3Cellipse cx='998' cy='133' rx='3.6' ry='4.7' fill='url(%23d)'/%3E%3Cellipse cx='997.1' cy='131.4' rx='1.2' ry='0.9' fill='url(%23s)'/%3E%3Cellipse cx='628' cy='527' rx='5.3' ry='6.7' fill='url(%23d)'/%3E%3Cellipse cx='626.2' cy='524.3' rx='1.7' ry='1.3' fill='url(%23s)'/%3E%3Cellipse cx='966' cy='356' rx='5.9' ry='6.2' fill='url(%23d)'/%3E%3Cellipse cx='964.5' cy='352.9' rx='1.9' ry='1.2' fill='url(%23s)'/%3E%3Cellipse cx='242' cy='677' rx='12.4' ry='14.6' fill='url(%23d)'/%3E%3Cellipse cx='238.5' cy='670.7' rx='4.0' ry='2.9' fill='url(%23s)'/%3E%3Cellipse cx='938' cy='169' rx='13.2' ry='15.1' fill='url(%23d)'/%3E%3Cellipse cx='934.7' cy='162.7' rx='4.2' ry='3.0' fill='url(%23s)'/%3E%3Cellipse cx='607' cy='729' rx='3.8' ry='4.1' fill='url(%23d)'/%3E%3Cellipse cx='606.1' cy='727.3' rx='1.2' ry='0.8' fill='url(%23s)'/%3E%3Cellipse cx='1006' cy='381' rx='3.3' ry='4.5' fill='url(%23d)'/%3E%3Cellipse cx='1005.0' cy='379.4' rx='1.1' ry='0.9' fill='url(%23s)'/%3E%3Cellipse cx='1051' cy='698' rx='7.4' ry='7.9' fill='url(%23d)'/%3E%3Cellipse cx='1048.5' cy='694.8' rx='2.4' ry='1.6' fill='url(%23s)'/%3E%3Cellipse cx='479' cy='320' rx='5.7' ry='6.7' fill='url(%23d)'/%3E%3Cellipse cx='477.3' cy='317.1' rx='1.8' ry='1.3' fill='url(%23s)'/%3E%3Cellipse cx='808' cy='523' rx='2.5' ry='3.5' fill='url(%23d)'/%3E%3Cellipse cx='806.9' cy='521.6' rx='0.8' ry='0.7' fill='url(%23s)'/%3E%3Cellipse cx='1480' cy='285' rx='7.3' ry='8.6' fill='url(%23d)'/%3E%3Cellipse cx='1478.3' cy='281.8' rx='2.3' ry='1.7' fill='url(%23s)'/%3E%3Cellipse cx='1522' cy='650' rx='3.5' ry='4.4' fill='url(%23d)'/%3E%3Cellipse cx='1520.7' cy='647.9' rx='1.1' ry='0.9' fill='url(%23s)'/%3E%3Cellipse cx='1196' cy='197' rx='8.6' ry='11.2' fill='url(%23d)'/%3E%3Cellipse cx='1193.2' cy='191.9' rx='2.7' ry='2.2' fill='url(%23s)'/%3E%3Cellipse cx='1337' cy='95' rx='4.6' ry='6.2' fill='url(%23d)'/%3E%3Cellipse cx='1335.5' cy='92.6' rx='1.5' ry='1.2' fill='url(%23s)'/%3E%3Cellipse cx='615' cy='390' rx='11.7' ry='13.0' fill='url(%23d)'/%3E%3Cellipse cx='611.7' cy='384.8' rx='3.8' ry='2.6' fill='url(%23s)'/%3E%3Cellipse cx='1556' cy='492' rx='3.1' ry='3.8' fill='url(%23d)'/%3E%3Cellipse cx='1555.6' cy='490.3' rx='1.0' ry='0.8' fill='url(%23s)'/%3E%3Cellipse cx='406' cy='168' rx='9.3' ry='10.1' fill='url(%23d)'/%3E%3Cellipse cx='403.3' cy='163.7' rx='3.0' ry='2.0' fill='url(%23s)'/%3E%3Cellipse cx='543' cy='500' rx='11.3' ry='12.6' fill='url(%23d)'/%3E%3Cellipse cx='540.2' cy='495.1' rx='3.6' ry='2.5' fill='url(%23s)'/%3E%3Cellipse cx='456' cy='19' rx='7.2' ry='9.1' fill='url(%23d)'/%3E%3Cellipse cx='454.2' cy='15.0' rx='2.3' ry='1.8' fill='url(%23s)'/%3E%3Cellipse cx='266' cy='784' rx='8.8' ry='9.8' fill='url(%23d)'/%3E%3Cellipse cx='263.9' cy='780.3' rx='2.8' ry='2.0' fill='url(%23s)'/%3E%3Cellipse cx='123' cy='738' rx='4.2' ry='5.7' fill='url(%23d)'/%3E%3Cellipse cx='122.2' cy='735.5' rx='1.4' ry='1.1' fill='url(%23s)'/%3E%3Cellipse cx='407' cy='369' rx='12.7' ry='16.8' fill='url(%23d)'/%3E%3Cellipse cx='403.1' cy='362.2' rx='4.1' ry='3.4' fill='url(%23s)'/%3E%3Cellipse cx='765' cy='43' rx='8.9' ry='10.2' fill='url(%23d)'/%3E%3Cellipse cx='762.8' cy='38.3' rx='2.8' ry='2.0' fill='url(%23s)'/%3E%3Cellipse cx='224' cy='91' rx='4.9' ry='6.2' fill='url(%23d)'/%3E%3Cellipse cx='222.1' cy='88.2' rx='1.6' ry='1.2' fill='url(%23s)'/%3E%3Cellipse cx='1331' cy='857' rx='8.7' ry='10.2' fill='url(%23d)'/%3E%3Cellipse cx='1328.5' cy='852.5' rx='2.8' ry='2.0' fill='url(%23s)'/%3E%3Cellipse cx='564' cy='713' rx='5.0' ry='6.5' fill='url(%23d)'/%3E%3Cellipse cx='562.1' cy='710.5' rx='1.6' ry='1.3' fill='url(%23s)'/%3E%3Cellipse cx='962' cy='256' rx='5.3' ry='6.5' fill='url(%23d)'/%3E%3Cellipse cx='960.4' cy='253.0' rx='1.7' ry='1.3' fill='url(%23s)'/%3E%3Cellipse cx='83' cy='245' rx='9.5' ry='11.6' fill='url(%23d)'/%3E%3Cellipse cx='80.7' cy='240.3' rx='3.0' ry='2.3' fill='url(%23s)'/%3E%3Cellipse cx='1534' cy='404' rx='8.3' ry='11.6' fill='url(%23d)'/%3E%3Cellipse cx='1532.1' cy='399.5' rx='2.7' ry='2.3' fill='url(%23s)'/%3E%3Cellipse cx='697' cy='817' rx='8.4' ry='10.2' fill='url(%23d)'/%3E%3Cellipse cx='695.0' cy='812.9' rx='2.7' ry='2.0' fill='url(%23s)'/%3E%3Cellipse cx='418' cy='266' rx='8.1' ry='10.6' fill='url(%23d)'/%3E%3Cellipse cx='416.0' cy='262.0' rx='2.6' ry='2.1' fill='url(%23s)'/%3E%3Cellipse cx='956' cy='122' rx='2.8' ry='3.4' fill='url(%23d)'/%3E%3Cellipse cx='954.9' cy='120.9' rx='0.9' ry='0.7' fill='url(%23s)'/%3E%3Cellipse cx='886' cy='787' rx='7.6' ry='9.4' fill='url(%23d)'/%3E%3Cellipse cx='883.5' cy='783.0' rx='2.4' ry='1.9' fill='url(%23s)'/%3E%3Cellipse cx='78' cy='420' rx='9.4' ry='10.9' fill='url(%23d)'/%3E%3Cellipse cx='75.6' cy='415.7' rx='3.0' ry='2.2' fill='url(%23s)'/%3E%3Cellipse cx='1369' cy='253' rx='8.5' ry='9.0' fill='url(%23d)'/%3E%3Cellipse cx='1366.3' cy='248.9' rx='2.7' ry='1.8' fill='url(%23s)'/%3E%3Cellipse cx='1347' cy='531' rx='8.0' ry='10.3' fill='url(%23d)'/%3E%3Cellipse cx='1345.0' cy='526.4' rx='2.6' ry='2.1' fill='url(%23s)'/%3E%3Cellipse cx='1445' cy='867' rx='4.1' ry='5.7' fill='url(%23d)'/%3E%3Cellipse cx='1443.5' cy='864.7' rx='1.3' ry='1.1' fill='url(%23s)'/%3E%3Cellipse cx='673' cy='166' rx='3.1' ry='3.3' fill='url(%23d)'/%3E%3Cellipse cx='672.2' cy='164.9' rx='1.0' ry='0.7' fill='url(%23s)'/%3E%3Cellipse cx='660' cy='479' rx='7.8' ry='8.6' fill='url(%23d)'/%3E%3Cellipse cx='657.3' cy='475.2' rx='2.5' ry='1.7' fill='url(%23s)'/%3E%3Cellipse cx='300' cy='275' rx='5.3' ry='5.9' fill='url(%23d)'/%3E%3Cellipse cx='298.4' cy='272.3' rx='1.7' ry='1.2' fill='url(%23s)'/%3E%3Cellipse cx='624' cy='654' rx='10.1' ry='12.8' fill='url(%23d)'/%3E%3Cellipse cx='621.1' cy='649.0' rx='3.2' ry='2.6' fill='url(%23s)'/%3E%3Cellipse cx='793' cy='845' rx='3.4' ry='3.7' fill='url(%23d)'/%3E%3Cellipse cx='792.1' cy='843.8' rx='1.1' ry='0.7' fill='url(%23s)'/%3E%3Cellipse cx='863' cy='284' rx='8.6' ry='10.3' fill='url(%23d)'/%3E%3Cellipse cx='860.8' cy='279.5' rx='2.7' ry='2.1' fill='url(%23s)'/%3E%3Cellipse cx='1161' cy='130' rx='7.6' ry='9.6' fill='url(%23d)'/%3E%3Cellipse cx='1158.6' cy='125.6' rx='2.4' ry='1.9' fill='url(%23s)'/%3E%3Cellipse cx='298' cy='91' rx='2.5' ry='3.1' fill='url(%23d)'/%3E%3Cellipse cx='297.0' cy='89.7' rx='0.8' ry='0.6' fill='url(%23s)'/%3E%3Cellipse cx='560' cy='108' rx='3.6' ry='4.4' fill='url(%23d)'/%3E%3Cellipse cx='559.0' cy='106.1' rx='1.2' ry='0.9' fill='url(%23s)'/%3E%3Cellipse cx='1215' cy='345' rx='13.8' ry='16.6' fill='url(%23d)'/%3E%3Cellipse cx='1211.4' cy='338.3' rx='4.4' ry='3.3' fill='url(%23s)'/%3E%3Cellipse cx='945' cy='616' rx='3.5' ry='4.3' fill='url(%23d)'/%3E%3Cellipse cx='944.2' cy='613.9' rx='1.1' ry='0.9' fill='url(%23s)'/%3E%3Cellipse cx='558' cy='316' rx='8.2' ry='8.9' fill='url(%23d)'/%3E%3Cellipse cx='555.4' cy='311.9' rx='2.6' ry='1.8' fill='url(%23s)'/%3E%3Cellipse cx='1324' cy='893' rx='7.9' ry='10.6' fill='url(%23d)'/%3E%3Cellipse cx='1322.2' cy='888.3' rx='2.5' ry='2.1' fill='url(%23s)'/%3E%3Cellipse cx='694' cy='844' rx='6.1' ry='8.3' fill='url(%23d)'/%3E%3Cellipse cx='692.7' cy='841.0' rx='2.0' ry='1.7' fill='url(%23s)'/%3E%3Cellipse cx='436' cy='6' rx='7.3' ry='8.8' fill='url(%23d)'/%3E%3Cellipse cx='434.1' cy='2.1' rx='2.3' ry='1.8' fill='url(%23s)'/%3E%3Cellipse cx='1597' cy='896' rx='9.7' ry='10.9' fill='url(%23d)'/%3E%3Cellipse cx='1594.0' cy='891.5' rx='3.1' ry='2.2' fill='url(%23s)'/%3E%3Cellipse cx='975' cy='639' rx='6.8' ry='7.3' fill='url(%23d)'/%3E%3Cellipse cx='972.8' cy='636.2' rx='2.2' ry='1.5' fill='url(%23s)'/%3E%3Cellipse cx='1388' cy='412' rx='10.2' ry='11.7' fill='url(%23d)'/%3E%3Cellipse cx='1384.7' cy='407.6' rx='3.3' ry='2.3' fill='url(%23s)'/%3E%3Cellipse cx='587' cy='380' rx='4.1' ry='5.1' fill='url(%23d)'/%3E%3Cellipse cx='585.9' cy='377.8' rx='1.3' ry='1.0' fill='url(%23s)'/%3E%3Cellipse cx='1419' cy='318' rx='13.6' ry='15.0' fill='url(%23d)'/%3E%3Cellipse cx='1415.6' cy='311.6' rx='4.4' ry='3.0' fill='url(%23s)'/%3E%3Cellipse cx='1563' cy='588' rx='3.1' ry='3.4' fill='url(%23d)'/%3E%3Cellipse cx='1562.1' cy='586.9' rx='1.0' ry='0.7' fill='url(%23s)'/%3E%3Cellipse cx='330' cy='95' rx='4.4' ry='5.0' fill='url(%23d)'/%3E%3Cellipse cx='328.5' cy='93.0' rx='1.4' ry='1.0' fill='url(%23s)'/%3E%3Cellipse cx='378' cy='407' rx='11.8' ry='12.5' fill='url(%23d)'/%3E%3Cellipse cx='374.8' cy='401.9' rx='3.8' ry='2.5' fill='url(%23s)'/%3E%3Cellipse cx='1122' cy='721' rx='3.5' ry='3.9' fill='url(%23d)'/%3E%3Cellipse cx='1120.7' cy='719.1' rx='1.1' ry='0.8' fill='url(%23s)'/%3E%3Cellipse cx='298' cy='302' rx='8.5' ry='9.5' fill='url(%23d)'/%3E%3Cellipse cx='295.8' cy='298.0' rx='2.7' ry='1.9' fill='url(%23s)'/%3E%3Cellipse cx='1382' cy='678' rx='4.4' ry='6.0' fill='url(%23d)'/%3E%3Cellipse cx='1381.2' cy='675.8' rx='1.4' ry='1.2' fill='url(%23s)'/%3E%3Cellipse cx='37' cy='330' rx='4.2' ry='4.5' fill='url(%23d)'/%3E%3Cellipse cx='35.4' cy='328.2' rx='1.4' ry='0.9' fill='url(%23s)'/%3E%3Cellipse cx='1114' cy='216' rx='4.1' ry='5.3' fill='url(%23d)'/%3E%3Cellipse cx='1113.2' cy='214.2' rx='1.3' ry='1.1' fill='url(%23s)'/%3E%3Cellipse cx='1022' cy='387' rx='13.6' ry='17.9' fill='url(%23d)'/%3E%3Cellipse cx='1018.6' cy='379.2' rx='4.4' ry='3.6' fill='url(%23s)'/%3E%3Cellipse cx='125' cy='11' rx='4.5' ry='4.9' fill='url(%23d)'/%3E%3Cellipse cx='124.2' cy='8.8' rx='1.4' ry='1.0' fill='url(%23s)'/%3E%3Cellipse cx='384' cy='717' rx='6.8' ry='7.6' fill='url(%23d)'/%3E%3Cellipse cx='382.1' cy='714.2' rx='2.2' ry='1.5' fill='url(%23s)'/%3E%3Cellipse cx='484' cy='398' rx='13.2' ry='14.5' fill='url(%23d)'/%3E%3Cellipse cx='480.4' cy='391.9' rx='4.2' ry='2.9' fill='url(%23s)'/%3E%3Cellipse cx='1129' cy='649' rx='7.1' ry='9.8' fill='url(%23d)'/%3E%3Cellipse cx='1127.1' cy='644.9' rx='2.3' ry='2.0' fill='url(%23s)'/%3E%3Cellipse cx='931' cy='308' rx='2.6' ry='2.8' fill='url(%23d)'/%3E%3Cellipse cx='930.0' cy='306.8' rx='0.8' ry='0.6' fill='url(%23s)'/%3E%3Cellipse cx='1349' cy='426' rx='7.9' ry='10.9' fill='url(%23d)'/%3E%3Cellipse cx='1346.6' cy='421.5' rx='2.5' ry='2.2' fill='url(%23s)'/%3E%3Cellipse cx='28' cy='430' rx='7.1' ry='9.8' fill='url(%23d)'/%3E%3Cellipse cx='26.4' cy='425.4' rx='2.3' ry='2.0' fill='url(%23s)'/%3E%3Cellipse cx='916' cy='577' rx='6.8' ry='8.7' fill='url(%23d)'/%3E%3Cellipse cx='913.8' cy='573.0' rx='2.2' ry='1.7' fill='url(%23s)'/%3E%3C/svg%3E\") center / cover no-repeat;\n}\n.aur-root[data-fx=\"rain\"] .aur-fx-b::before {\ncontent: \"\";\nposition: absolute;\nleft: 0;\nright: 0;\ntop: -100%;\nheight: 200%;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1600 900' preserveAspectRatio='none'%3E%3Cdefs%3E%3ClinearGradient id='t' gradientUnits='userSpaceOnUse' x1='0' y1='0' x2='0' y2='900'%3E%3Cstop offset='0' stop-color='%23cfe2ff' stop-opacity='.05'/%3E%3Cstop offset='1' stop-color='%23cfe2ff' stop-opacity='.3'/%3E%3C/linearGradient%3E%3CradialGradient id='d' cx='.5' cy='.58' r='.55'%3E%3Cstop offset='0' stop-color='%23a9c8e8' stop-opacity='.3'/%3E%3Cstop offset='.72' stop-color='%230a1220' stop-opacity='.35'/%3E%3Cstop offset='1' stop-color='%23eaf3ff' stop-opacity='.7'/%3E%3C/radialGradient%3E%3CradialGradient id='s' cx='.5' cy='.5' r='.5'%3E%3Cstop offset='0' stop-color='%23fff' stop-opacity='1'/%3E%3Cstop offset='1' stop-color='%23fff' stop-opacity='0'/%3E%3C/radialGradient%3E%3C/defs%3E%3Cpath d='M617 22Q618 164 617 306' fill='none' stroke='%23cfe2ff' stroke-opacity='.2' stroke-width='4.0' stroke-linecap='round'/%3E%3Cellipse cx='617' cy='306' rx='8.0' ry='10.8' fill='url(%23d)'/%3E%3Cellipse cx='614.5' cy='301.7' rx='2.6' ry='1.6' fill='url(%23s)'/%3E%3Cpath d='M1093 287Q1094 412 1093 538' fill='none' stroke='%23cfe2ff' stroke-opacity='.2' stroke-width='4.7' stroke-linecap='round'/%3E%3Cellipse cx='1093' cy='538' rx='9.3' ry='12.6' fill='url(%23d)'/%3E%3Cellipse cx='1090.2' cy='533.1' rx='3.1' ry='1.9' fill='url(%23s)'/%3E%3Cpath d='M1233 417Q1227 517 1233 616' fill='none' stroke='%23cfe2ff' stroke-opacity='.2' stroke-width='6.0' stroke-linecap='round'/%3E%3Cellipse cx='1233' cy='616' rx='12.0' ry='16.2' fill='url(%23d)'/%3E%3Cellipse cx='1229.7' cy='609.7' rx='4.0' ry='2.4' fill='url(%23s)'/%3E%3Cpath d='M261 423Q263 542 261 661' fill='none' stroke='%23cfe2ff' stroke-opacity='.2' stroke-width='4.0' stroke-linecap='round'/%3E%3Cellipse cx='261' cy='661' rx='8.0' ry='10.8' fill='url(%23d)'/%3E%3Cellipse cx='258.5' cy='656.3' rx='2.6' ry='1.6' fill='url(%23s)'/%3E%3Cpath d='M122 429Q128 567 122 705' fill='none' stroke='%23cfe2ff' stroke-opacity='.2' stroke-width='3.6' stroke-linecap='round'/%3E%3Cellipse cx='122' cy='705' rx='7.2' ry='9.7' fill='url(%23d)'/%3E%3Cellipse cx='119.6' cy='700.7' rx='2.4' ry='1.4' fill='url(%23s)'/%3E%3Cpath d='M362 520Q366 592 362 663' fill='none' stroke='%23cfe2ff' stroke-opacity='.2' stroke-width='5.7' stroke-linecap='round'/%3E%3Cellipse cx='362' cy='663' rx='11.4' ry='15.4' fill='url(%23d)'/%3E%3Cellipse cx='359.3' cy='656.6' rx='3.8' ry='2.3' fill='url(%23s)'/%3E%3Cpath d='M221 501Q213 649 221 798' fill='none' stroke='%23cfe2ff' stroke-opacity='.2' stroke-width='5.6' stroke-linecap='round'/%3E%3Cellipse cx='221' cy='798' rx='11.1' ry='15.0' fill='url(%23d)'/%3E%3Cellipse cx='217.5' cy='791.4' rx='3.7' ry='2.2' fill='url(%23s)'/%3E%3Cpath d='M519 434Q526 510 519 586' fill='none' stroke='%23cfe2ff' stroke-opacity='.2' stroke-width='5.3' stroke-linecap='round'/%3E%3Cellipse cx='519' cy='586' rx='10.6' ry='14.4' fill='url(%23d)'/%3E%3Cellipse cx='516.4' cy='580.5' rx='3.5' ry='2.1' fill='url(%23s)'/%3E%3Cpath d='M1334 117Q1332 237 1334 357' fill='none' stroke='%23cfe2ff' stroke-opacity='.2' stroke-width='3.9' stroke-linecap='round'/%3E%3Cellipse cx='1334' cy='357' rx='7.9' ry='10.6' fill='url(%23d)'/%3E%3Cellipse cx='1331.4' cy='352.7' rx='2.6' ry='1.6' fill='url(%23s)'/%3E%3Cpath d='M1052 371Q1045 433 1052 495' fill='none' stroke='%23cfe2ff' stroke-opacity='.2' stroke-width='4.7' stroke-linecap='round'/%3E%3Cellipse cx='1052' cy='495' rx='9.4' ry='12.6' fill='url(%23d)'/%3E%3Cellipse cx='1048.9' cy='490.0' rx='3.1' ry='1.9' fill='url(%23s)'/%3E%3Cpath d='M736 410Q737 537 736 664' fill='none' stroke='%23cfe2ff' stroke-opacity='.2' stroke-width='4.8' stroke-linecap='round'/%3E%3Cellipse cx='736' cy='664' rx='9.6' ry='12.9' fill='url(%23d)'/%3E%3Cellipse cx='733.3' cy='659.1' rx='3.2' ry='1.9' fill='url(%23s)'/%3E%3C/svg%3E\") 0 0 / 100% 50% repeat-y;\nanimation: aur-rn-run 26s steps(390) infinite linear;\n}\n@keyframes aur-rn-run { to { transform: translateY(50%); } }\n.aur-root[data-fx=\"rain\"] .aur-fx-c {\ndisplay: block;\nleft: 0;\nright: 0;\ntop: -1000px;\nheight: calc(100% + 1000px);\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1000 1000' preserveAspectRatio='xMinYMin slice'%3E%3Cg stroke='%23bcd4f2' stroke-linecap='round' fill='none'%3E%3Cpath d='M317 151l-16.9 106' stroke-width='1.1' stroke-opacity='0.22'/%3E%3Cpath d='M317 -849l-16.9 106' stroke-width='1.1' stroke-opacity='0.22'/%3E%3Cpath d='M317 1151l-16.9 106' stroke-width='1.1' stroke-opacity='0.22'/%3E%3Cpath d='M360 58l-15.3 96' stroke-width='1.0' stroke-opacity='0.20'/%3E%3Cpath d='M360 -942l-15.3 96' stroke-width='1.0' stroke-opacity='0.20'/%3E%3Cpath d='M360 1058l-15.3 96' stroke-width='1.0' stroke-opacity='0.20'/%3E%3Cpath d='M53 91l-14.4 90' stroke-width='1.7' stroke-opacity='0.14'/%3E%3Cpath d='M53 -909l-14.4 90' stroke-width='1.7' stroke-opacity='0.14'/%3E%3Cpath d='M53 1091l-14.4 90' stroke-width='1.7' stroke-opacity='0.14'/%3E%3Cpath d='M212 627l-20.2 126' stroke-width='1.5' stroke-opacity='0.19'/%3E%3Cpath d='M212 -373l-20.2 126' stroke-width='1.5' stroke-opacity='0.19'/%3E%3Cpath d='M212 1627l-20.2 126' stroke-width='1.5' stroke-opacity='0.19'/%3E%3Cpath d='M995 47l-19.2 120' stroke-width='1.2' stroke-opacity='0.15'/%3E%3Cpath d='M995 -953l-19.2 120' stroke-width='1.2' stroke-opacity='0.15'/%3E%3Cpath d='M995 1047l-19.2 120' stroke-width='1.2' stroke-opacity='0.15'/%3E%3Cpath d='M103 308l-18.7 117' stroke-width='1.1' stroke-opacity='0.22'/%3E%3Cpath d='M103 -692l-18.7 117' stroke-width='1.1' stroke-opacity='0.22'/%3E%3Cpath d='M103 1308l-18.7 117' stroke-width='1.1' stroke-opacity='0.22'/%3E%3Cpath d='M644 372l-15.7 98' stroke-width='1.1' stroke-opacity='0.13'/%3E%3Cpath d='M644 -628l-15.7 98' stroke-width='1.1' stroke-opacity='0.13'/%3E%3Cpath d='M644 1372l-15.7 98' stroke-width='1.1' stroke-opacity='0.13'/%3E%3Cpath d='M194 680l-14.4 90' stroke-width='1.3' stroke-opacity='0.23'/%3E%3Cpath d='M194 -320l-14.4 90' stroke-width='1.3' stroke-opacity='0.23'/%3E%3Cpath d='M194 1680l-14.4 90' stroke-width='1.3' stroke-opacity='0.23'/%3E%3Cpath d='M451 300l-18.5 116' stroke-width='1.6' stroke-opacity='0.16'/%3E%3Cpath d='M451 -700l-18.5 116' stroke-width='1.6' stroke-opacity='0.16'/%3E%3Cpath d='M451 1300l-18.5 116' stroke-width='1.6' stroke-opacity='0.16'/%3E%3Cpath d='M577 525l-19.4 121' stroke-width='1.6' stroke-opacity='0.17'/%3E%3Cpath d='M577 -475l-19.4 121' stroke-width='1.6' stroke-opacity='0.17'/%3E%3Cpath d='M577 1525l-19.4 121' stroke-width='1.6' stroke-opacity='0.17'/%3E%3Cpath d='M999 118l-14.3 89' stroke-width='1.6' stroke-opacity='0.15'/%3E%3Cpath d='M999 -882l-14.3 89' stroke-width='1.6' stroke-opacity='0.15'/%3E%3Cpath d='M999 1118l-14.3 89' stroke-width='1.6' stroke-opacity='0.15'/%3E%3Cpath d='M489 39l-17.1 107' stroke-width='1.6' stroke-opacity='0.22'/%3E%3Cpath d='M489 -961l-17.1 107' stroke-width='1.6' stroke-opacity='0.22'/%3E%3Cpath d='M489 1039l-17.1 107' stroke-width='1.6' stroke-opacity='0.22'/%3E%3Cpath d='M890 314l-17.4 109' stroke-width='1.5' stroke-opacity='0.22'/%3E%3Cpath d='M890 -686l-17.4 109' stroke-width='1.5' stroke-opacity='0.22'/%3E%3Cpath d='M890 1314l-17.4 109' stroke-width='1.5' stroke-opacity='0.22'/%3E%3Cpath d='M454 840l-20.2 126' stroke-width='1.4' stroke-opacity='0.24'/%3E%3Cpath d='M454 -160l-20.2 126' stroke-width='1.4' stroke-opacity='0.24'/%3E%3Cpath d='M454 1840l-20.2 126' stroke-width='1.4' stroke-opacity='0.24'/%3E%3Cpath d='M43 701l-16.8 105' stroke-width='1.8' stroke-opacity='0.27'/%3E%3Cpath d='M43 -299l-16.8 105' stroke-width='1.8' stroke-opacity='0.27'/%3E%3Cpath d='M43 1701l-16.8 105' stroke-width='1.8' stroke-opacity='0.27'/%3E%3Cpath d='M276 386l-17.1 107' stroke-width='1.0' stroke-opacity='0.20'/%3E%3Cpath d='M276 -614l-17.1 107' stroke-width='1.0' stroke-opacity='0.20'/%3E%3Cpath d='M276 1386l-17.1 107' stroke-width='1.0' stroke-opacity='0.20'/%3E%3Cpath d='M155 117l-10.3 64' stroke-width='1.6' stroke-opacity='0.14'/%3E%3Cpath d='M155 -883l-10.3 64' stroke-width='1.6' stroke-opacity='0.14'/%3E%3Cpath d='M155 1117l-10.3 64' stroke-width='1.6' stroke-opacity='0.14'/%3E%3Cpath d='M238 391l-19.4 121' stroke-width='1.1' stroke-opacity='0.20'/%3E%3Cpath d='M238 -609l-19.4 121' stroke-width='1.1' stroke-opacity='0.20'/%3E%3Cpath d='M238 1391l-19.4 121' stroke-width='1.1' stroke-opacity='0.20'/%3E%3Cpath d='M551 883l-18.8 117' stroke-width='1.7' stroke-opacity='0.17'/%3E%3Cpath d='M551 -117l-18.8 117' stroke-width='1.7' stroke-opacity='0.17'/%3E%3Cpath d='M551 1883l-18.8 117' stroke-width='1.7' stroke-opacity='0.17'/%3E%3Cpath d='M412 359l-19.5 122' stroke-width='1.8' stroke-opacity='0.15'/%3E%3Cpath d='M412 -641l-19.5 122' stroke-width='1.8' stroke-opacity='0.15'/%3E%3Cpath d='M412 1359l-19.5 122' stroke-width='1.8' stroke-opacity='0.15'/%3E%3Cpath d='M163 232l-12.2 76' stroke-width='1.4' stroke-opacity='0.23'/%3E%3Cpath d='M163 -768l-12.2 76' stroke-width='1.4' stroke-opacity='0.23'/%3E%3Cpath d='M163 1232l-12.2 76' stroke-width='1.4' stroke-opacity='0.23'/%3E%3Cpath d='M253 4l-14.3 89' stroke-width='1.3' stroke-opacity='0.22'/%3E%3Cpath d='M253 -996l-14.3 89' stroke-width='1.3' stroke-opacity='0.22'/%3E%3Cpath d='M253 1004l-14.3 89' stroke-width='1.3' stroke-opacity='0.22'/%3E%3C/g%3E%3C/svg%3E\") 0 0 / 1000px 1000px repeat;\nanimation: aur-rn-fall 0.9s steps(14) infinite linear;\n}\n@keyframes aur-rn-fall { to { transform: translateY(1000px); } }\n.aur-root[data-fx=\"rain\"] .aur-fx-c::before {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1000 1000' preserveAspectRatio='xMinYMin slice'%3E%3Cg stroke='%23bcd4f2' stroke-linecap='round' fill='none'%3E%3Cpath d='M684 785l-10.6 66' stroke-width='1.1' stroke-opacity='0.13'/%3E%3Cpath d='M684 -215l-10.6 66' stroke-width='1.1' stroke-opacity='0.13'/%3E%3Cpath d='M684 1785l-10.6 66' stroke-width='1.1' stroke-opacity='0.13'/%3E%3Cpath d='M1017 289l-7.6 47' stroke-width='1.1' stroke-opacity='0.11'/%3E%3Cpath d='M1017 -711l-7.6 47' stroke-width='1.1' stroke-opacity='0.11'/%3E%3Cpath d='M1017 1289l-7.6 47' stroke-width='1.1' stroke-opacity='0.11'/%3E%3Cpath d='M320 268l-7.3 45' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M320 -732l-7.3 45' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M320 1268l-7.3 45' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M572 202l-7.0 44' stroke-width='1.0' stroke-opacity='0.15'/%3E%3Cpath d='M572 -798l-7.0 44' stroke-width='1.0' stroke-opacity='0.15'/%3E%3Cpath d='M572 1202l-7.0 44' stroke-width='1.0' stroke-opacity='0.15'/%3E%3Cpath d='M384 733l-12.8 80' stroke-width='1.1' stroke-opacity='0.09'/%3E%3Cpath d='M384 -267l-12.8 80' stroke-width='1.1' stroke-opacity='0.09'/%3E%3Cpath d='M384 1733l-12.8 80' stroke-width='1.1' stroke-opacity='0.09'/%3E%3Cpath d='M737 756l-9.6 60' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M737 -244l-9.6 60' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M737 1756l-9.6 60' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M931 834l-12.7 80' stroke-width='1.2' stroke-opacity='0.11'/%3E%3Cpath d='M931 -166l-12.7 80' stroke-width='1.2' stroke-opacity='0.11'/%3E%3Cpath d='M931 1834l-12.7 80' stroke-width='1.2' stroke-opacity='0.11'/%3E%3Cpath d='M547 731l-12.8 80' stroke-width='1.1' stroke-opacity='0.10'/%3E%3Cpath d='M547 -269l-12.8 80' stroke-width='1.1' stroke-opacity='0.10'/%3E%3Cpath d='M547 1731l-12.8 80' stroke-width='1.1' stroke-opacity='0.10'/%3E%3Cpath d='M631 105l-12.0 75' stroke-width='1.0' stroke-opacity='0.13'/%3E%3Cpath d='M631 -895l-12.0 75' stroke-width='1.0' stroke-opacity='0.13'/%3E%3Cpath d='M631 1105l-12.0 75' stroke-width='1.0' stroke-opacity='0.13'/%3E%3Cpath d='M479 120l-10.2 64' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M479 -880l-10.2 64' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M479 1120l-10.2 64' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M912 866l-13.5 85' stroke-width='1.0' stroke-opacity='0.08'/%3E%3Cpath d='M912 -134l-13.5 85' stroke-width='1.0' stroke-opacity='0.08'/%3E%3Cpath d='M912 1866l-13.5 85' stroke-width='1.0' stroke-opacity='0.08'/%3E%3Cpath d='M372 114l-12.0 75' stroke-width='1.1' stroke-opacity='0.10'/%3E%3Cpath d='M372 -886l-12.0 75' stroke-width='1.1' stroke-opacity='0.10'/%3E%3Cpath d='M372 1114l-12.0 75' stroke-width='1.1' stroke-opacity='0.10'/%3E%3Cpath d='M275 403l-12.3 77' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M275 -597l-12.3 77' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M275 1403l-12.3 77' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M684 45l-8.1 50' stroke-width='1.1' stroke-opacity='0.17'/%3E%3Cpath d='M684 -955l-8.1 50' stroke-width='1.1' stroke-opacity='0.17'/%3E%3Cpath d='M684 1045l-8.1 50' stroke-width='1.1' stroke-opacity='0.17'/%3E%3Cpath d='M85 66l-10.4 65' stroke-width='1.1' stroke-opacity='0.08'/%3E%3Cpath d='M85 -934l-10.4 65' stroke-width='1.1' stroke-opacity='0.08'/%3E%3Cpath d='M85 1066l-10.4 65' stroke-width='1.1' stroke-opacity='0.08'/%3E%3Cpath d='M434 275l-7.1 44' stroke-width='1.0' stroke-opacity='0.11'/%3E%3Cpath d='M434 -725l-7.1 44' stroke-width='1.0' stroke-opacity='0.11'/%3E%3Cpath d='M434 1275l-7.1 44' stroke-width='1.0' stroke-opacity='0.11'/%3E%3Cpath d='M466 112l-11.4 71' stroke-width='1.2' stroke-opacity='0.16'/%3E%3Cpath d='M466 -888l-11.4 71' stroke-width='1.2' stroke-opacity='0.16'/%3E%3Cpath d='M466 1112l-11.4 71' stroke-width='1.2' stroke-opacity='0.16'/%3E%3Cpath d='M51 648l-11.5 72' stroke-width='1.0' stroke-opacity='0.13'/%3E%3Cpath d='M51 -352l-11.5 72' stroke-width='1.0' stroke-opacity='0.13'/%3E%3Cpath d='M51 1648l-11.5 72' stroke-width='1.0' stroke-opacity='0.13'/%3E%3Cpath d='M659 950l-13.8 86' stroke-width='1.1' stroke-opacity='0.15'/%3E%3Cpath d='M659 -50l-13.8 86' stroke-width='1.1' stroke-opacity='0.15'/%3E%3Cpath d='M659 1950l-13.8 86' stroke-width='1.1' stroke-opacity='0.15'/%3E%3Cpath d='M977 211l-10.5 65' stroke-width='1.0' stroke-opacity='0.17'/%3E%3Cpath d='M977 -789l-10.5 65' stroke-width='1.0' stroke-opacity='0.17'/%3E%3Cpath d='M977 1211l-10.5 65' stroke-width='1.0' stroke-opacity='0.17'/%3E%3Cpath d='M660 211l-8.0 50' stroke-width='1.1' stroke-opacity='0.17'/%3E%3Cpath d='M660 -789l-8.0 50' stroke-width='1.1' stroke-opacity='0.17'/%3E%3Cpath d='M660 1211l-8.0 50' stroke-width='1.1' stroke-opacity='0.17'/%3E%3Cpath d='M121 323l-10.5 66' stroke-width='1.1' stroke-opacity='0.19'/%3E%3Cpath d='M121 -677l-10.5 66' stroke-width='1.1' stroke-opacity='0.19'/%3E%3Cpath d='M121 1323l-10.5 66' stroke-width='1.1' stroke-opacity='0.19'/%3E%3Cpath d='M734 955l-11.5 72' stroke-width='1.1' stroke-opacity='0.11'/%3E%3Cpath d='M734 -45l-11.5 72' stroke-width='1.1' stroke-opacity='0.11'/%3E%3Cpath d='M734 1955l-11.5 72' stroke-width='1.1' stroke-opacity='0.11'/%3E%3Cpath d='M505 429l-10.2 64' stroke-width='1.0' stroke-opacity='0.18'/%3E%3Cpath d='M505 -571l-10.2 64' stroke-width='1.0' stroke-opacity='0.18'/%3E%3Cpath d='M505 1429l-10.2 64' stroke-width='1.0' stroke-opacity='0.18'/%3E%3Cpath d='M141 458l-13.8 87' stroke-width='1.1' stroke-opacity='0.18'/%3E%3Cpath d='M141 -542l-13.8 87' stroke-width='1.1' stroke-opacity='0.18'/%3E%3Cpath d='M141 1458l-13.8 87' stroke-width='1.1' stroke-opacity='0.18'/%3E%3Cpath d='M251 467l-9.4 59' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M251 -533l-9.4 59' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M251 1467l-9.4 59' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M443 842l-14.2 89' stroke-width='1.0' stroke-opacity='0.16'/%3E%3Cpath d='M443 -158l-14.2 89' stroke-width='1.0' stroke-opacity='0.16'/%3E%3Cpath d='M443 1842l-14.2 89' stroke-width='1.0' stroke-opacity='0.16'/%3E%3Cpath d='M530 413l-6.7 42' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M530 -587l-6.7 42' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M530 1413l-6.7 42' stroke-width='1.1' stroke-opacity='0.12'/%3E%3Cpath d='M362 593l-9.3 58' stroke-width='1.1' stroke-opacity='0.11'/%3E%3Cpath d='M362 -407l-9.3 58' stroke-width='1.1' stroke-opacity='0.11'/%3E%3Cpath d='M362 1593l-9.3 58' stroke-width='1.1' stroke-opacity='0.11'/%3E%3Cpath d='M996 392l-14.2 89' stroke-width='1.0' stroke-opacity='0.16'/%3E%3Cpath d='M996 -608l-14.2 89' stroke-width='1.0' stroke-opacity='0.16'/%3E%3Cpath d='M996 1392l-14.2 89' stroke-width='1.0' stroke-opacity='0.16'/%3E%3Cpath d='M557 710l-10.5 66' stroke-width='1.2' stroke-opacity='0.15'/%3E%3Cpath d='M557 -290l-10.5 66' stroke-width='1.2' stroke-opacity='0.15'/%3E%3Cpath d='M557 1710l-10.5 66' stroke-width='1.2' stroke-opacity='0.15'/%3E%3Cpath d='M29 683l-11.3 71' stroke-width='1.0' stroke-opacity='0.17'/%3E%3Cpath d='M29 -317l-11.3 71' stroke-width='1.0' stroke-opacity='0.17'/%3E%3Cpath d='M29 1683l-11.3 71' stroke-width='1.0' stroke-opacity='0.17'/%3E%3Cpath d='M849 277l-7.6 47' stroke-width='1.1' stroke-opacity='0.15'/%3E%3Cpath d='M849 -723l-7.6 47' stroke-width='1.1' stroke-opacity='0.15'/%3E%3Cpath d='M849 1277l-7.6 47' stroke-width='1.1' stroke-opacity='0.15'/%3E%3Cpath d='M442 72l-10.0 62' stroke-width='1.1' stroke-opacity='0.15'/%3E%3Cpath d='M442 -928l-10.0 62' stroke-width='1.1' stroke-opacity='0.15'/%3E%3Cpath d='M442 1072l-10.0 62' stroke-width='1.1' stroke-opacity='0.15'/%3E%3C/g%3E%3C/svg%3E\") 0 0 / 700px 700px repeat;\nanimation: aur-rn-fall-far 1.3s steps(14) infinite linear;\n}\n@keyframes aur-rn-fall-far { to { transform: translateY(700px); } }\n.aur-root[data-fx=\"rain\"] .aur-fx::after {\ncontent: \"\";\nposition: absolute;\ninset: 0;\nbackground: radial-gradient(90% 70% at 50% 20%, rgba(210, 225, 255, 0.85), rgba(150, 175, 230, 0.4) 60%, transparent);\nopacity: 0;\nanimation: aur-rn-flash 27s linear infinite;\n}\n.aur-root[data-fx=\"rain\"][data-gap=\"on\"] .aur-fx::after { animation-duration: 14s; }\n@keyframes aur-rn-flash {\n0%, 95% { opacity: 0; }\n95.4% { opacity: 0.5; }\n96% { opacity: 0.08; }\n96.6% { opacity: 0.78; }\n100% { opacity: 0; }\n}\n.aur-root[data-fx=\"rain\"] .aur-bg-grain { opacity: 0.03; }\n.aur-root[data-look=\"rain\"] { --aur-glow-tint: #8fb4e6; }\n.aur-root[data-look=\"rain\"][data-color=\"white\"] { --aur-hi: #e8f1ff; }\n.aur-root[data-look=\"rain\"][data-motion=\"full\"] .aur-stage[data-mode=\"synced\"] .aur-line.is-active .aur-main { animation: aur-rn-wipe 1.5s var(--aur-ease); }\n@keyframes aur-rn-wipe { from { opacity: 0.3; filter: blur(7px); } }\n@keyframes aur-fx-flash-a { from { opacity: 1; } }\n@keyframes aur-fx-flash-b { from { opacity: 1; } }\n@keyframes aur-fx-swell-a { from { transform: scale(1.1); } }\n@keyframes aur-fx-swell-b { from { transform: scale(1.1); } }\n@keyframes aur-fx-blip-a { 0% { opacity: 0.75; } 100% { opacity: 0.55; } }\n@keyframes aur-fx-blip-b { 0% { opacity: 0.75; } 100% { opacity: 0.55; } }\n.aur-root[data-fx=\"aurora\"][data-bganim=\"on\"] .aur-bg[data-bar=\"a\"] .aur-fx::before { animation: aur-au-twinkle 8s steps(48) infinite alternate, aur-fx-flash-a 1.1s ease-out; }\n.aur-root[data-fx=\"aurora\"][data-bganim=\"on\"] .aur-bg[data-bar=\"b\"] .aur-fx::before { animation: aur-au-twinkle 8s steps(48) infinite alternate, aur-fx-flash-b 1.1s ease-out; }\n.aur-root[data-fx=\"neon\"][data-bganim=\"on\"] .aur-bg[data-bt=\"a\"] .aur-fx-c { animation: aur-fx-pulse 5s ease-in-out infinite, aur-fx-flash-a 0.35s ease-out; }\n.aur-root[data-fx=\"neon\"][data-bganim=\"on\"] .aur-bg[data-bt=\"b\"] .aur-fx-c { animation: aur-fx-pulse 5s ease-in-out infinite, aur-fx-flash-b 0.35s ease-out; }\n.aur-root[data-fx=\"neon\"][data-bganim=\"on\"] .aur-bg[data-bar=\"a\"] .aur-fx-b { animation: aur-fx-ignite 1.9s linear 0.25s both, aur-fx-stutter 17s linear 3s infinite reverse, aur-fx-buzz-a 0.32s steps(1); }\n.aur-root[data-fx=\"neon\"][data-bganim=\"on\"] .aur-bg[data-bar=\"b\"] .aur-fx-b { animation: aur-fx-ignite 1.9s linear 0.25s both, aur-fx-stutter 17s linear 3s infinite reverse, aur-fx-buzz-b 0.32s steps(1); }\n.aur-root[data-fx=\"karaoke\"][data-bganim=\"on\"] .aur-bg[data-bt=\"a\"] .aur-fx-c { animation: aur-ktv-bokeh 50s steps(1500) infinite alternate, aur-fx-flash-a 0.3s ease-out; }\n.aur-root[data-fx=\"karaoke\"][data-bganim=\"on\"] .aur-bg[data-bt=\"b\"] .aur-fx-c { animation: aur-ktv-bokeh 50s steps(1500) infinite alternate, aur-fx-flash-b 0.3s ease-out; }\n.aur-root[data-fx=\"karaoke\"][data-bganim=\"on\"] .aur-bg[data-bar=\"a\"] .aur-fx-a { animation: aur-ktv-spot 16s steps(480) infinite alternate, aur-fx-swell-a 0.8s ease-out; }\n.aur-root[data-fx=\"karaoke\"][data-bganim=\"on\"] .aur-bg[data-bar=\"b\"] .aur-fx-a { animation: aur-ktv-spot 16s steps(480) infinite alternate, aur-fx-swell-b 0.8s ease-out; }\n.aur-root[data-fx=\"karaoke\"][data-bganim=\"on\"] .aur-bg[data-bar=\"a\"] .aur-fx-b { animation: aur-ktv-spot 19s steps(570) infinite alternate-reverse, aur-fx-swell-a 0.8s ease-out; }\n.aur-root[data-fx=\"karaoke\"][data-bganim=\"on\"] .aur-bg[data-bar=\"b\"] .aur-fx-b { animation: aur-ktv-spot 19s steps(570) infinite alternate-reverse, aur-fx-swell-b 0.8s ease-out; }\n.aur-root[data-fx=\"retro\"][data-bganim=\"on\"] .aur-bg[data-bt=\"a\"] .aur-fx-a { animation: aur-fx-blip-a 0.12s steps(1); }\n.aur-root[data-fx=\"retro\"][data-bganim=\"on\"] .aur-bg[data-bt=\"b\"] .aur-fx-a { animation: aur-fx-blip-b 0.12s steps(1); }\n.aur-root[data-fx=\"synthwave\"] .aur-bg[data-beats=\"on\"] .aur-fx-b::before { animation-duration: calc(var(--aur-beat) * 2); }\n.aur-root[data-fx=\"synthwave\"][data-gap=\"on\"] .aur-bg[data-beats=\"on\"] .aur-fx-b::before { animation-duration: var(--aur-beat); }\n.aur-root[data-fx=\"synthwave\"][data-bganim=\"on\"] .aur-bg[data-bar=\"a\"] .aur-fx::after { animation: aur-fx-flash-a 0.7s ease-out; }\n.aur-root[data-fx=\"synthwave\"][data-bganim=\"on\"] .aur-bg[data-bar=\"b\"] .aur-fx::after { animation: aur-fx-flash-b 0.7s ease-out; }\n.aur-root[data-fx=\"gothic\"] .aur-fx::before { transform-origin: 50% 100%; }\n.aur-root[data-fx=\"gothic\"][data-bganim=\"on\"] .aur-bg[data-bar=\"a\"] .aur-fx::before { animation: aur-fx-flame 3.4s steps(27) infinite, aur-fx-swell-a 1s ease-out; }\n.aur-root[data-fx=\"gothic\"][data-bganim=\"on\"] .aur-bg[data-bar=\"b\"] .aur-fx::before { animation: aur-fx-flame 3.4s steps(27) infinite, aur-fx-swell-b 1s ease-out; }\n@keyframes aur-bm-stir-a { from { scale: 1.06 1.16; } }\n@keyframes aur-bm-stir-b { from { scale: 1.06 1.16; } }\n.aur-root[data-fx=\"blackmetal\"][data-bganim=\"on\"] .aur-bg[data-bar=\"a\"] .aur-fx-b::after { animation: aur-bm-fog 90s steps(2700) infinite alternate, aur-bm-stir-a 1.4s ease-out; }\n.aur-root[data-fx=\"blackmetal\"][data-bganim=\"on\"] .aur-bg[data-bar=\"b\"] .aur-fx-b::after { animation: aur-bm-fog 90s steps(2700) infinite alternate, aur-bm-stir-b 1.4s ease-out; }\n.aur-root[data-fx=\"sunset\"][data-bganim=\"on\"] .aur-bg[data-bar=\"a\"] .aur-fx-c::before { animation: aur-fx-glitter 1.8s steps(4) infinite, aur-fx-flash-a 0.8s ease-out; }\n.aur-root[data-fx=\"sunset\"][data-bganim=\"on\"] .aur-bg[data-bar=\"b\"] .aur-fx-c::before { animation: aur-fx-glitter 1.8s steps(4) infinite, aur-fx-flash-b 0.8s ease-out; }\n.aur-root[data-fx=\"midnight\"][data-bganim=\"on\"] .aur-bg[data-bar=\"a\"] .aur-fx-a { animation: aur-fx-twinkle 5s ease-in-out infinite alternate, aur-fx-flash-a 1s ease-out; }\n.aur-root[data-fx=\"midnight\"][data-bganim=\"on\"] .aur-bg[data-bar=\"b\"] .aur-fx-a { animation: aur-fx-twinkle 5s ease-in-out infinite alternate, aur-fx-flash-b 1s ease-out; }\n.aur-root[data-fx=\"vaporwave\"][data-bganim=\"on\"] .aur-bg[data-bar=\"a\"] .aur-fx::before { animation: aur-fx-swell-a 0.9s ease-out; }\n.aur-root[data-fx=\"vaporwave\"][data-bganim=\"on\"] .aur-bg[data-bar=\"b\"] .aur-fx::before { animation: aur-fx-swell-b 0.9s ease-out; }\n.aur-root[data-fx=\"vaporwave\"][data-bganim=\"on\"] .aur-bg[data-bt=\"a\"] .aur-fx::after { animation: aur-vw-twinkle 4s steps(24) infinite alternate, aur-fx-flash-a 0.3s ease-out; }\n.aur-root[data-fx=\"vaporwave\"][data-bganim=\"on\"] .aur-bg[data-bt=\"b\"] .aur-fx::after { animation: aur-vw-twinkle 4s steps(24) infinite alternate, aur-fx-flash-b 0.3s ease-out; }\n.aur-root[data-fx=\"ocean\"][data-bganim=\"on\"] .aur-bg[data-bar=\"a\"] .aur-fx-a { animation: aur-oc-sway 22s steps(330) infinite alternate, aur-fx-flash-a 1.2s ease-out; }\n.aur-root[data-fx=\"ocean\"][data-bganim=\"on\"] .aur-bg[data-bar=\"b\"] .aur-fx-a { animation: aur-oc-sway 22s steps(330) infinite alternate, aur-fx-flash-b 1.2s ease-out; }\n.aur-root[data-fx=\"rain\"][data-bganim=\"on\"] .aur-bg[data-bar=\"a\"] .aur-fx-a { animation: aur-rn-glow 9s steps(54) infinite alternate, aur-fx-flash-a 0.9s ease-out; }\n.aur-root[data-fx=\"rain\"][data-bganim=\"on\"] .aur-bg[data-bar=\"b\"] .aur-fx-a { animation: aur-rn-glow 9s steps(54) infinite alternate, aur-fx-flash-b 0.9s ease-out; }\n.aur-pb-btn {\n--aur-pb-c: #b98cff;\nposition: relative;\ndisplay: inline-grid !important;\nplace-items: center;\nwidth: 32px !important;\nheight: 32px !important;\nmin-width: 32px;\nmargin-inline: 4px;\npadding: 0 !important;\nborder: 0;\nborder-radius: 10px !important;\noverflow: hidden;\ncursor: pointer;\n}\n:is(.aur-pb-btn, .aur-topbar-btn) {\ncolor: rgba(255, 255, 255, 0.82) !important;\nbackground: linear-gradient(180deg, rgba(255, 255, 255, 0.15), rgba(255, 255, 255, 0.04)) !important;\nbox-shadow:\ninset 0 1px 0 rgba(255, 255, 255, 0.28),\ninset 0 0 0 1px rgba(255, 255, 255, 0.08),\n0 2px 8px rgba(0, 0, 0, 0.35);\nbackdrop-filter: blur(10px) saturate(1.4);\ntransition: background 0.3s ease, box-shadow 0.3s ease, color 0.2s ease, transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);\n}\n:is(.aur-pb-btn, .aur-topbar-btn)::before {\ncontent: \"\";\nposition: absolute;\ninset: 0 0 50%;\nborder-radius: inherit;\nborder-bottom-left-radius: 40% 8px;\nborder-bottom-right-radius: 40% 8px;\nbackground: linear-gradient(180deg, rgba(255, 255, 255, 0.18), transparent);\npointer-events: none;\n}\n:is(.aur-pb-btn, .aur-topbar-btn)::after { display: none !important; }\n.aur-pb-btn svg { position: relative; width: 16px; height: 16px; }\n:is(.aur-pb-btn, .aur-topbar-btn):hover { color: #fff !important; transform: translateY(-1px); background: linear-gradient(180deg, rgba(255, 255, 255, 0.22), rgba(255, 255, 255, 0.07)) !important; }\n:is(.aur-pb-btn, .aur-topbar-btn):active { transform: scale(0.94); }\n:is(.aur-pb-btn, .aur-topbar-btn).is-on {\ncolor: #fff !important;\nbackground:\nlinear-gradient(180deg, color-mix(in oklab, var(--aur-pb-c) 55%, rgba(255, 255, 255, 0.25)), color-mix(in oklab, var(--aur-pb-c) 28%, transparent)) !important;\nbox-shadow:\ninset 0 1px 0 rgba(255, 255, 255, 0.4),\ninset 0 0 0 1px color-mix(in oklab, var(--aur-pb-c) 50%, transparent),\n0 0 14px color-mix(in oklab, var(--aur-pb-c) 55%, transparent),\n0 2px 8px rgba(0, 0, 0, 0.35);\n}\n.aur-bg-custom { position: absolute; inset: 0; display: none; overflow: hidden; }\n.aur-root[data-bg=\"custom\"] .aur-bg-custom { display: block; }\n.aur-bg-custom > img,\n.aur-bg-custom > video {\nposition: absolute;\ninset: 0;\nwidth: 100%;\nheight: 100%;\nobject-fit: cover;\nfilter: blur(var(--aur-cblur, 0px));\ntransform: scale(calc(1 + var(--aur-cblur, 0px) / 400px));\nopacity: 0;\ntransition: opacity 0.8s ease;\n}\n.aur-bg-custom > .is-on { opacity: 1; }\n.aur-media { display: flex; flex-direction: column; gap: 10px; }\n.aur-media-name { font-size: 13px; color: rgba(255, 255, 255, 0.65); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }\n.aur-media-actions { display: flex; flex-wrap: wrap; gap: 8px; }\n.aur-float[data-next=\"off\"] .aur-float-next { display: none; }\n.aur-float[data-style=\"compact\"] { width: auto; max-width: min(460px, calc(100vw - 16px)); min-height: 42px; padding: 8px 18px; border-radius: 99px; }\n.aur-float[data-style=\"compact\"] .aur-float-art { display: none; }\n.aur-float[data-style=\"compact\"] .aur-float-cur { font-size: 15px; -webkit-line-clamp: 1; }\n.aur-float[data-style=\"compact\"] .aur-float-next { display: none; }\n.aur-float[data-style=\"bar\"] { width: min(920px, calc(100vw - 16px)); min-height: 76px; padding: 12px 28px; border-radius: 14px; text-align: center; background: linear-gradient(180deg, rgba(20, 20, 26, 0.9), rgba(8, 8, 12, 0.92)); }\n.aur-float[data-style=\"bar\"] .aur-float-art { display: none; }\n.aur-float[data-style=\"bar\"] .aur-float-cur { font-size: 24px; }\n.aur-float[data-style=\"bar\"] .aur-float-text::after {\ncontent: \"\";\ndisplay: block;\nheight: 2px;\nmargin: 8px auto 0;\nwidth: 40%;\nborder-radius: 2px;\nbackground: linear-gradient(90deg, transparent, color-mix(in oklab, var(--float-c) 40%, #fff), transparent);\nopacity: 0.6;\n}\n.aur-float[data-style=\"bare\"] { background: none; border-color: transparent; box-shadow: none; backdrop-filter: none; }\n.aur-float[data-style=\"bare\"] .aur-float-art { display: none; }\n.aur-float[data-style=\"bare\"] .aur-float-cur { font-size: 22px; text-shadow: 0 2px 12px rgba(0, 0, 0, 0.85), 0 0 2px rgba(0, 0, 0, 0.9); }\n.aur-float[data-style=\"bare\"] .aur-float-next { text-shadow: 0 1px 8px rgba(0, 0, 0, 0.9); color: rgba(255, 255, 255, 0.7); }\n.aur-float[data-style=\"bare\"] .aur-float-w { filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.85)); }\n.aur-float[data-style=\"bare\"]:hover { background: rgba(0, 0, 0, 0.25); }\n.aur-float[data-style=\"neon\"] {\nbackground: rgba(10, 8, 18, 0.88);\nborder: 1px solid color-mix(in oklab, var(--float-c) 40%, #ff4fd8);\nbox-shadow: 0 0 22px color-mix(in oklab, var(--float-c) 35%, rgba(255, 79, 216, 0.45)), inset 0 0 18px color-mix(in oklab, var(--float-c) 20%, rgba(255, 79, 216, 0.15));\n}\n.aur-float[data-style=\"neon\"] .aur-float-w.sung,\n.aur-float[data-style=\"neon\"] .aur-float-cur:not(:has(.aur-float-w:not([hidden]))) { color: #fff; text-shadow: 0 0 10px rgba(255, 120, 230, 0.7); }\n.aur-share-clip.is-recording { background: rgba(255, 70, 90, 0.2) !important; box-shadow: inset 0 0 0 1px rgba(255, 90, 110, 0.6); }\n.aur-share-clip.is-recording svg { color: #ff5a6e; animation: aur-rec-pulse 1s ease-in-out infinite; }\n@keyframes aur-rec-pulse { 50% { opacity: 0.35; } }";

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
		const root = (this.rootEl ||= this.stage.closest(".aur-root"));
		for (const a of ["data-gap", "data-intro", "data-soon"]) root?.removeAttribute(a);
		this.soon = null;
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
			if (this.lineProgress) el.style.setProperty("--aur-lp", p.toFixed(3));
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
			h("div", { class: "aur-fx" }, h("i", { class: "aur-fx-a" }), h("i", { class: "aur-fx-b" }), h("i", { class: "aur-fx-c" })),
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
			stage,
			dock,
			miniProgress,
			panel.el,
			share.el,
			tabsPop,
			upNext,
			toastEl,
		);

		const view = new LyricsView(stage, {
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
		ui = { trBtn, root, bgStack, cover, title, artist, artA, artB, artHint, sideTitle, sideArtist, sideAlbum, activeArt: artA, stage, dock, bar, miniProgress, elapsed, remaining, playBtn, shuffleBtn, repeatBtn, heartBtn, muteBtn, vol, source, offsetOut, fsBtn, toastEl, tabsPop, tabsBtn, bgCustom: bg.querySelector(".aur-bg-custom"), fx: bg.querySelector(".aur-fx"), bg, panel, share, view, upNext, upArt, upTitle, upArtist, upWhen };
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
	document.addEventListener("visibilitychange", () => document.hidden && (statsTick(), saveStats()));

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
	let playbarEl = null; // the player-bar button element, styled as a liquid-glass tile
	let topbarEl = null; // same look, larger, in the top bar
	let card = null;
	let mini = null;
	const overlay = createOverlay({
		onOpenChange: (open) => {
			if (playbarBtn) playbarBtn.active = open;
			for (const b of [playbarEl, topbarEl]) b?.classList.toggle("is-on", open);
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
			// Liquid-glass tile, sized like Spotify's global-nav buttons; styles in styles.css.
			const el = tb.element?.matches?.("button") ? tb.element : tb.element?.querySelector?.("button") || tb.element;
			el?.classList.add("aur-topbar-btn");
			topbarEl = el || null;
			tintButtons();
		}
	} catch (e) {
		console.warn(`[${EXT_ID}] topbar button unavailable`, e);
	}
	try {
		if (S.Playbar?.Button) {
			playbarBtn = new S.Playbar.Button(label, ICONS.lyrics(16), () => overlay.toggle(), false, false);
			const el = playbarBtn.element;
			playbarEl = el?.matches?.("button") ? el : el?.querySelector?.("button") || el || null;
			playbarEl?.classList.add("aur-pb-btn");
			tintButtons();
		}
	} catch (e) {
		console.warn(`[${EXT_ID}] playbar button unavailable`, e);
	}

	// The glass buttons glow in the album's colour while the lyrics are open.
	function tintButtons() {
		const uri = S.Player.data?.item?.uri;
		if (!uri || typeof S.colorExtractor !== "function") return;
		Promise.resolve(S.colorExtractor(uri))
			.then((c) => {
				if (!c) return;
				for (const b of [playbarEl, topbarEl]) b?.style.setProperty("--aur-pb-c", c.LIGHT_VIBRANT || c.VIBRANT || c.PROMINENT || "#b98cff");
			})
			.catch(() => {});
	}
	S.Player.addEventListener("songchange", () => (overlay.onSongChange(), card?.onSongChange(), tintButtons()));
	S.Player.addEventListener("onplaypause", () => (overlay.onPlayPause(), card?.onPlayPause(), mini?.onPlayPause()));
	S.Player.addEventListener("onprogress", () => (overlay.onProgress(), card?.onProgress(), mini?.onProgress()));

	// Small public handle for debugging from DevTools: window.AuroraLyrics.open()
	globalThis.AuroraLyrics = { open: overlay.open, close: overlay.close, toggle: overlay.toggle, testSources: overlay.testSources, toggleMini: () => mini?.toggle() };
	console.info(`[${EXT_ID}] loaded`);
}

main().catch((e) => console.error("[aurora-lyrics] failed to start", e));
})();
