// Mini lyrics: a small floating pill with the current line (word fill) and the next one, shown
// over Spotify while the fullscreen view is closed. Drag it anywhere (position is remembered),
// click the text to open the fullscreen view. Where the browser supports Document
// Picture-in-Picture it can also pop out into an always-on-top window of its own.
//
// Lyrics come from the Now Playing card's lookup (see npv.js → main.js), so there is no
// second search for the same song.

import { h, clamp } from "./util.js";
import { settings } from "./settings.js";
import { getCurrentTrack, getNextTrack, getPosition, getDuration, isPlaying } from "./player.js";
import { findLineIndex } from "./lrc.js";
import { ICONS } from "./icons.js";

const MINI_LEAD_MS = 40; // highlight words slightly early, as in the other views
const PIP_SIZE = { width: 480, height: 150 };
const MINI_UP_NEXT_MS = 20000; // same window as the overlay's "Up next" card

export function createMiniLyrics({ openOverlay, isOverlayOpen }) {
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
