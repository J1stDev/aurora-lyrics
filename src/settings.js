// Settings schema, defaults, validation and persistence.
// The schema also drives the settings panel UI (see panel.js):
//   type: "range" | "select" | "toggle"
//   ui (select only): "segmented" | "cards" | "fonts" | undefined (dropdown)

import { EXT_ID, clamp } from "./util.js";
import { store } from "./storage.js";
import { TRANSLATE_LANGS } from "./translate.js";

const SETTINGS_KEY = `${EXT_ID}:settings`;

/**
 * Font stacks. "web" fonts are loaded from Google Fonts on demand (only when selected);
 * every stack falls back to local fonts if the request is blocked.
 */
export const FONTS = {
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
export const PROVIDER_INFO = [
	{ id: "paxsenix", label: "Apple Music", words: true, on: true, desc: "Apple Music's syllable-synced lyrics with background vocals and duets, via the community Paxsenix API." },
	{ id: "musixmatch", label: "Musixmatch", words: true, on: true, desc: "Line-synced and plain lyrics for most songs; word-by-word (richsync) when Musixmatch allows it." },
	{ id: "spotify", label: "Spotify", words: false, on: true, desc: "Spotify's own lyrics. Mostly line-synced." },
	{ id: "netease", label: "NetEase", words: true, on: true, desc: "NetEase Cloud Music. Word-by-word (YRC) and line lyrics; great for Asian music." },
	{ id: "lrclib", label: "LRCLIB", words: false, on: true, desc: "Open community database of line-synced and plain lyrics." },
	{ id: "unison", label: "Unison", words: true, on: true, desc: "Community TTML lyrics with word timing and background vocals." },
];

export const SCHEMA = [
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

export const DEFAULTS = Object.fromEntries(SCHEMA.map((s) => [s.key, s.default]));

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

export const settings = {
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
