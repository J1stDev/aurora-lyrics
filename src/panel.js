// Side drawer with two tabs:
//  - Settings: generated from SCHEMA (segmented controls, style cards, font tiles,
//    filled sliders, switches), applied live.
//  - This track: paste / import .lrc or .txt lyrics for the current track.

import { h } from "./util.js";
import { SCHEMA, FONTS, PROVIDER_INFO, THEMES, DEFAULTS, settings } from "./settings.js";
import { ICONS, STYLE_ART, ARROWS } from "./icons.js";
import { saveBackground, removeBackground } from "./media.js";

const MAX_IMPORT_BYTES = 512 * 1024;
const SEGMENT_ICONS = { left: ICONS.alignLeft, center: ICONS.alignCenter, right: ICONS.alignRight };
const ACCENT_SWATCHES = ["#ff5fa2", "#ff7a45", "#ffc93d", "#3ddc84", "#2ec5ff", "#7aa2ff", "#b388ff", "#ffffff"];

let panelToast = () => {}; // set by createPanel (controls are built before it has a context)

const loadedFonts = new Set();
/** Load a Google web font the first time it is needed (no-op for local stacks). */
export function ensureFont(key) {
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
export function createPanel(ctx) {
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
