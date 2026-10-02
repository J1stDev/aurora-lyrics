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

import { SCENE_VERT } from "./scene-glsl.js";
import { NEON_FRAG } from "./scene-neon.js";
import { KARAOKE_FRAG } from "./scene-karaoke.js";
import { GOTHIC_FRAG } from "./scene-gothic.js";
import { BLACKMETAL_FRAG } from "./scene-blackmetal.js";
import { LOUNGE_FRAG } from "./scene-lounge.js";
import { OCEAN_FRAG } from "./scene-ocean.js";
import { parseCssColor } from "./rain.js";

const SCENES = {
	neon: { frag: NEON_FRAG, palette: (accent, deep) => neonPalette(accent, deep) },
	karaoke: { frag: KARAOKE_FRAG, palette: (accent, deep) => ktvPalette(accent, deep) },
	gothic: { frag: GOTHIC_FRAG, palette: (accent, deep) => gothicPalette(accent, deep) },
	blackmetal: { frag: BLACKMETAL_FRAG, palette: (accent, deep) => blackmetalPalette(accent, deep) },
	lounge: { frag: LOUNGE_FRAG, palette: (accent, deep) => loungePalette(accent, deep) },
	ocean: { frag: OCEAN_FRAG, palette: (accent, deep) => oceanPalette(accent, deep) },
};

/** Does this theme have a WebGL scene? */
export const hasScene = (id) => Object.prototype.hasOwnProperty.call(SCENES, id);

// ---------------------------------------------------------------------------------------------
// Colour (OKLab, so a scene's colours are made the way the stylesheet's oklch(from …) makes them)
// ---------------------------------------------------------------------------------------------

const scLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const scGam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** [r, g, b] 0-255 → [L, C, h°] (OKLCH). Greys have no hue; it is 0, as in CSS. */
export function rgbToOklch([r, g, b]) {
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
export function oklchToRgb(L, C, h) {
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
export function neonPalette(accent, deep) {
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
export function ktvPalette(accent, deep) {
	const [, C, h] = rgbToOklch(accent || [255, 61, 139]);
	return {
		uA: oklchToRgb(0.72, Math.max(C, 0.2), C < 0.02 ? 0 : h),
		uB: [94 / 255, 225 / 255, 1],
		uC: [180 / 255, 140 / 255, 1],
		uBase: scBase(deep),
	};
}

/** Black Metal: moonlit greys. The accent is drained to a hint, the rest is cold blue. */
export function blackmetalPalette(accent, deep) {
	const [, C, h] = rgbToOklch(accent || [174, 191, 205]);
	return {
		uA: oklchToRgb(0.8, Math.min(C, 0.04), C < 0.01 ? 250 : h),
		uB: oklchToRgb(0.68, 0.05, 245),
		uC: oklchToRgb(0.92, 0.02, 230),
		uBase: scBase(deep),
	};
}

/** Ocean: the accent as cool aqua, a turquoise, and a violet-pink for what glows in the deep. */
export function oceanPalette(accent, deep) {
	const [, C, h] = rgbToOklch(accent || [95, 212, 255]);
	return {
		uA: oklchToRgb(0.82, Math.max(C, 0.1), C < 0.02 ? 215 : h),
		uB: oklchToRgb(0.78, 0.12, 185),
		uC: oklchToRgb(0.7, 0.2, 330),
		uBase: oklchToRgb(0.1, 0.05, 245),
	};
}

/** Lounge: always amber, whatever the album: amber, a deep red-brown and brass. */
export function loungePalette(accent, deep) {
	return {
		uA: oklchToRgb(0.76, 0.15, 68),
		uB: oklchToRgb(0.52, 0.14, 40),
		uC: oklchToRgb(0.84, 0.12, 90),
		uBase: scBase(deep),
	};
}

/** Gothic: the accent as deep crimson glass, with sapphire and amber for the rest of the window. */
export function gothicPalette(accent, deep) {
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
export function cssToRgb(str) {
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
export function createScenes(canvas, root, bg, fx, textRects) {
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
