// Share card: render a few lyric lines + cover art + track info into an image (canvas), with a
// live preview. Copy it to the clipboard or save it as a PNG.
//
// Opened from the overlay (share button, S, or right-click on a line). Everything is drawn
// locally; the only network use is loading the cover image (CORS-enabled Spotify CDN). If the
// cover can't be used on a canvas, the card falls back to the gradient background.

import { h } from "./util.js";
import { ICONS } from "./icons.js";

export const SHARE_FORMATS = {
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
export function wrapText(ctx, text, maxW) {
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
export function drawShareCard(canvas, o) {
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
export function createShareSheet(ctx) {
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
