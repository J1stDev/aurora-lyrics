// Share card: render lyric lines + cover art + track info into an image (canvas), with a live
// preview. Copy it, save it as a PNG, hand it to the system share sheet, or copy the text.
//
// Opened from the overlay (share button, S, or right-click on a line). Everything is drawn
// locally; the only network use is loading the cover image (CORS-enabled Spotify CDN). If the
// cover can't be used on a canvas, album-art backgrounds fall back to the gradient.

import { h, clamp, nextFrame } from "./util.js";
import { ICONS } from "./icons.js";
import { store } from "./storage.js";

export const SHARE_FORMATS = {
	square: { label: "Square", w: 1080, h: 1080 },
	portrait: { label: "Portrait", w: 1080, h: 1350 },
	story: { label: "Story", w: 1080, h: 1920 },
};
export const SHARE_STYLES = [
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
export function drawShareCard(canvas, opts) {
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
		drawLyrics(ctx, o, fit, alignX, cy + ip + header, o.align, pal);
	} else if (o.style === "center") {
		// Centred lyrics; small cover and track info centred at the bottom.
		const art = W * 0.1;
		const footer = o.info ? (showArt ? art + W * 0.035 : 0) + W * 0.075 : 0;
		const fit = fitLyrics(ctx, o, blocks, W - pad * 2, H - pad * 2.4 - footer, base);
		const top = pad + (H - pad * 2 - footer - fit.height) / 2;
		drawLyrics(ctx, o, fit, W / 2, top, "center", pal);
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
		drawLyrics(ctx, o, fit, x, lyricsTop, o.align, pal);
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
		drawLyrics(ctx, o, fit, o.align === "center" ? W / 2 : pad, top, o.align, pal);
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
	return canvas;
}

/** Plain-text version of the selection, for pasting into a message. */
export function shareText(lines, title, artist) {
	const credit = [title, artist].filter(Boolean).join(" · ");
	return `${lines.join("\n")}${credit ? `\n— ${credit}` : ""}`;
}

/**
 * The share sheet (lives inside the overlay).
 * @param {{ getContext: () => { track: object|null, lyrics: object|null, tr: (string|null)[]|null,
 *   active: number, root: HTMLElement }, toast: (m: string) => void, onClose?: () => void }} ctx
 */
export function createShareSheet(ctx) {
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
	const exportBtns = [copyBtn, saveBtn, shareBtn, textBtn];

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
		el.classList.remove("is-open");
		setTimeout(() => !el.classList.contains("is-open") && (el.hidden = true), 250);
		ctx.onClose?.();
	}

	return { el, open, close, isOpen: () => !el.hidden && el.classList.contains("is-open") };
}
