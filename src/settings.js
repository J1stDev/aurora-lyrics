// Settings schema, defaults, validation and persistence.
// The schema also drives the settings panel UI (see panel.js):
//   type: "range" | "select" | "toggle" | "color" | "media" | "providers"
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
	mono: { label: "Mono", web: "JetBrains+Mono:wght@500;700;800", stack: '"JetBrains Mono", "Cascadia Code", Consolas, ui-monospace, monospace' },
	condensed: { label: "Condensed", web: "Oswald:wght@500;600;700", stack: '"Oswald", "Bahnschrift SemiCondensed", "Arial Narrow", sans-serif' },
	serif: { label: "Serif", web: "Playfair+Display:wght@500;700;800;900", stack: '"Playfair Display", "Iowan Old Style", "Palatino Linotype", Georgia, serif' },
	gothic: { label: "Gothic", web: "Grenze+Gotisch:wght@500;700;800;900", stack: '"Grenze Gotisch", "Old English Text MT", "Palatino Linotype", Georgia, serif' },
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
export const LOOK_KEYS = ["view", "font", "fontWeight", "textAlign", "textColor", "glow", "accent", "animation", "wordAnim", "depthBlur", "bgStyle", "bgOpacity"];
export const THEMES = [
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
];

/** The full look a theme produces (defaults + its own values). */
export function themeLook(theme) {
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
export function matchTheme(all) {
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

export const DEFAULTS = Object.fromEntries(SCHEMA.map((s) => [s.key, s.default]));

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
			if (current.customLook) this.setMany({ ...current.customLook, themeFx: current.customLook.themeFx || "none" });
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
