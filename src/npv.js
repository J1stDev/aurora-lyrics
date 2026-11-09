// Our own lyrics card in Spotify's right-hand "Now Playing" panel, replacing Spotify's
// "Lyrics preview" card: a pane of glass lit by the album's colours, the line being sung in a
// small glass lens that glides from line to line, synced and auto-scrolling, word fill, click a
// line to jump, click the card (or ⤢) to open the fullscreen view.
//
// Spotify's card is found by its stable test id; we hide it and put ours in its slot.
// When Spotify shows no card (no lyrics on Spotify), ours goes right after the track info.
// React re-renders the panel freely, so a (throttled) MutationObserver keeps us attached; it
// watches the right sidebar only, not the whole of Spotify, when that can be found.
//
// This card is on screen whenever Spotify plays with the Now Playing panel open, so it is kept
// cheap: it only runs frame by frame while a word is being sung (to fill it); otherwise it sleeps
// until the next line or word starts, and not at all while paused, hidden or covered.

import { h, albumColors } from "./util.js";
import { settings } from "./settings.js";
import { getCurrentTrack, getPosition, isPlaying, seek } from "./player.js";
import { resolveLyrics, SOURCE_LABELS } from "./providers.js";
import { findLineIndex, estimateWords } from "./lrc.js";
import { ICONS } from "./icons.js";
import { translateLyrics, resolveTarget } from "./translate.js";

const SPOTIFY_CARD = '[data-testid="lyrics-npv-section"]';
const NPV_ANCHOR = ".main-nowPlayingView-nowPlayingWidget";
const NPV_ROOTS = [".Root__right-sidebar", '[data-testid="now-playing-view"]', "aside"];
const ANCHOR_Y = 0.36; // active line position within the card body
const LEAD_MS = 40;
const IDLE_MAX_MS = 1000; // longest sleep between checks while playing (catches seeks Spotify doesn't announce)

export function createNowPlayingCard({ openOverlay, isOverlayOpen, onState, toggleMini }) {
	const state = { uri: null, lyrics: null, source: null, token: 0, active: -2, wordIdx: -1, raf: 0, timer: 0, visible: false, playing: false };
	let lineEls = [];
	let wordData = []; // per line: { words, spans } | null

	// ---- DOM
	const glassBtn = (title, icon, onclick) => h("button", { class: "aur-npv-btn", type: "button", title, "aria-label": title, html: icon, onclick: (e) => (e.stopPropagation(), onclick()) });
	const src = h("span", { class: "aur-npv-src" });
	const live = h("span", { class: "aur-npv-live", "aria-hidden": "true" });
	const lens = h("div", { class: "aur-npv-lens", "aria-hidden": "true" });
	const lines = h("div", { class: "aur-npv-lines" });
	const msg = h("div", { class: "aur-npv-msg", role: "status" });
	const body = h("div", { class: "aur-npv-body", title: "Open fullscreen lyrics", onclick: () => openOverlay() }, lens, lines, msg);
	const card = h(
		"section",
		{ class: "aur-npv", "data-aur-npv": "", "aria-label": "Lyrics" },
		h("div", { class: "aur-npv-head" }, live, h("h2", { class: "aur-npv-title" }, "Lyrics"), src, h("span", { class: "aur-npv-gap" }), glassBtn("Mini lyrics (Alt+M)", ICONS.mini(), () => toggleMini?.()), glassBtn("Open fullscreen lyrics (Alt+L)", ICONS.fullscreen(), openOverlay)),
		body,
	);

	// ---- mounting
	function unhideSpotify() {
		for (const el of document.querySelectorAll("[data-aur-hidden]")) el.removeAttribute("data-aur-hidden");
	}
	function mount() {
		if (!settings.get("npvCard")) {
			card.remove();
			unhideSpotify();
			watch(document.body);
			return;
		}
		const spotifyCard = document.querySelector(SPOTIFY_CARD);
		if (spotifyCard) {
			if (!spotifyCard.hasAttribute("data-aur-hidden")) spotifyCard.setAttribute("data-aur-hidden", "");
			if (spotifyCard.previousElementSibling !== card) spotifyCard.before(card);
		} else {
			const anchor = document.querySelector(NPV_ANCHOR);
			if (anchor && anchor.nextElementSibling !== card) anchor.after(card);
		}
		watch(npvRoot());
		if (state.uri !== getCurrentTrack()?.uri) load();
	}
	/** The smallest steady part of Spotify that holds the Now Playing panel (or the whole page). */
	function npvRoot() {
		for (const s of NPV_ROOTS) {
			const el = (card.isConnected && card.closest(s)) || document.querySelector(`${s} ${NPV_ANCHOR}`)?.closest(s);
			if (el) return el;
		}
		return document.body;
	}
	// Throttle, not debounce: Spotify's DOM changes constantly (progress times, animations), so a
	// debounce that restarts on every mutation could starve forever. Check at most every 250 ms.
	let mountTimer = 0;
	let watched = null;
	const observer = new MutationObserver(() => {
		if (mountTimer) return;
		mountTimer = setTimeout(() => {
			mountTimer = 0;
			if (watched !== document.body && !watched?.isConnected) watch(document.body); // the sidebar itself was replaced
			mount();
		}, 250);
	});
	function watch(root) {
		if (root === watched) return;
		observer.disconnect();
		observer.observe(root, { childList: true, subtree: true });
		watched = root;
	}

	// Only animate while the card is actually on screen.
	new IntersectionObserver((entries) => {
		state.visible = entries.some((e) => e.isIntersecting);
		kick();
	}).observe(card);
	document.addEventListener("visibilitychange", kick);

	settings.subscribe((key) => {
		if (key === "npvCard" || key === "*") mount();
		if (["providers", "searchUntil", "estimateWords", "*"].includes(key)) load();
		else if (key === "translate" || key === "translateTo") translateCard();
		if (key === "duetColors" || key === "*") card.dataset.duet = settings.get("duetColors") ? "on" : "off";
	});

	// ---- lyrics
	/** A message instead of lyrics; "loading" shows three shimmering placeholder lines. */
	function setMessage(text, kind = "") {
		msg.textContent = text;
		msg.dataset.kind = kind;
		lines.replaceChildren();
		lineEls = [];
		wordData = [];
		state.active = -2;
		card.classList.remove("is-unsynced");
		card.dataset.state = kind || "empty";
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
		setMessage("Loading lyrics…", "loading");
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
		else setMessage(res?.instrumental ? "Instrumental. Enjoy the music ♪" : "No lyrics found for this song");
	}

	/** Lyrics pushed from the overlay (imports, source picks, upgrades) for the same song. */
	function useLyrics(uri, lyrics, source) {
		if (!lyrics || uri !== state.uri) return;
		state.token++; // supersede any lookup still running here
		show(lyrics, source);
	}

	function tint(track) {
		if (!track?.uri) return;
		albumColors(track.uri).then((c) => {
			if (!c || state.uri !== track.uri) return;
			card.style.setProperty("--npv-c", c.VIBRANT || c.LIGHT_VIBRANT || c.PROMINENT || "#8a7bd8");
			card.style.setProperty("--npv-c2", c.DARK_VIBRANT || c.DESATURATED || c.PROMINENT || "#2c2440");
		});
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
		card.dataset.state = "lyrics";
		card.dataset.duet = settings.get("duetColors") ? "on" : "off";

		const frag = document.createDocumentFragment();
		lineEls = [];
		wordData = [];
		for (const line of l.lines) {
			let el;
			let wd = null;
			if (line.gap) {
				el = h("div", { class: "aur-npv-line is-gap" }, h("i"), h("i"), h("i"));
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
		card.classList.remove("has-lens");
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

	// ---- playback sync (only while visible, the window is showing and the fullscreen view is closed)
	function stop() {
		cancelAnimationFrame(state.raf);
		clearTimeout(state.timer);
		state.raf = state.timer = 0;
	}
	function tick() {
		stop();
		const playing = isPlaying();
		if (playing !== state.playing) card.classList.toggle("is-playing", (state.playing = playing));
		if (!state.visible || document.hidden || !card.isConnected || isOverlayOpen() || !state.lyrics?.synced) return;
		const pos = getPosition() + settings.get("offset");
		const ls = state.lyrics.lines;
		const idx = findLineIndex(ls, pos);
		if (idx !== state.active) activate(idx);
		const wd = idx >= 0 ? wordData[idx] : null;
		const singing = wd ? updateWords(wd, pos + LEAD_MS) : false;
		if (!playing) return; // paused: play / seek events wake us
		if (singing) {
			// a word is filling: every frame, with a slow timer in case frames stall (occluded window)
			state.raf = requestAnimationFrame(tick);
			state.timer = setTimeout(tick, 250);
			return;
		}
		// otherwise sleep until the next word or line starts
		let next = idx + 1 < ls.length ? ls[idx + 1].time : Infinity;
		if (wd) {
			const k = findLineIndex(wd.words, pos + LEAD_MS);
			if (k + 1 < wd.words.length) next = Math.min(next, wd.words[k + 1].time - LEAD_MS);
		}
		state.timer = setTimeout(tick, Math.max(16, Math.min(IDLE_MAX_MS, next - pos)));
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
		// lines already sung: only those between the old and the new position change (all of them after a fresh render)
		const from = prev < -1 ? 0 : Math.max(0, Math.min(prev, idx));
		const to = prev < -1 ? lineEls.length - 1 : Math.min(lineEls.length - 1, Math.max(prev, idx));
		for (let i = from; i <= to; i++) lineEls[i].classList.toggle("is-past", i < idx);
		state.active = idx;
		state.wordIdx = -1;
		const focus = lineEls[Math.max(idx, 0)];
		if (idx >= 0 && focus) focus.classList.add("is-active");
		if (!focus) return;
		const jump = prev < -1 || Math.abs(idx - prev) > 8;
		if (jump) card.classList.add("no-anim");
		const y = Math.round(Math.min(0, body.clientHeight * ANCHOR_Y - (focus.offsetTop + focus.offsetHeight / 2)));
		lines.style.transform = `translateY(${y}px)`;
		// the lens sits behind the line being sung (none before the first line or on a break)
		const onLine = idx >= 0 && !focus.classList.contains("is-gap");
		card.classList.toggle("has-lens", onLine);
		if (onLine) {
			lens.style.transform = `translateY(${focus.offsetTop + y}px)`;
			lens.style.height = `${focus.offsetHeight}px`;
		}
		if (jump) requestAnimationFrame(() => card.classList.remove("no-anim"));
	}

	/** Word fill on the active line; true while a word is being sung (so it needs every frame). */
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
		if (k < 0 || k >= spans.length) return false;
		const w = words[k];
		const p = w.end > w.time ? Math.min(1, Math.max(0, (pos - w.time) / (w.end - w.time))) : 1;
		spans[k].style.setProperty("--aur-wp", p.toFixed(3));
		return p < 1;
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
