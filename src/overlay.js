// The overlay controller: builds the full-screen UI once (lazily), owns the playback loop,
// loads lyrics on track changes, and applies settings live.

import { h, clamp, nextFrame } from "./util.js";
import { settings, FONTS, PROVIDER_INFO } from "./settings.js";
import { getCurrentTrack, getNextTrack, openUri, getPosition, getDuration, isPlaying, seek, playerCommand, playerState, setVolume } from "./player.js";
import { resolveLyrics, lyricsQuality, SOURCE_LABELS } from "./providers.js";
import { lyricsCache, localLyrics } from "./cache.js";
import { toLRC, estimateWords } from "./lrc.js";
import { translateLyrics, resolveTarget } from "./translate.js";
import { LyricsView } from "./view.js";
import { createPanel, ensureFont } from "./panel.js";
import { createShareSheet } from "./share.js";
import { ICONS } from "./icons.js";

const CLOSE_MS = 420; // must match the overlay fade-out transition in styles.css
const BG_SIZE = 256; // px; background art is drawn small and scaled up (cheap heavy blur)
const RELAYOUT_KEYS = new Set(["fontSize", "lineSpacing", "textAlign", "animation", "fontWeight", "font", "showContext", "view", "showBgVocals", "*"]);
const SOURCE_KEYS = new Set(["providers", "searchUntil"]);
// Motion styles that stack lines at the centre (one line in focus) instead of a scrolling list.
const STACK_ANIMS = new Set(["fade", "cinematic", "swipe", "zoom", "flip"]);
const UP_NEXT_MS = 20000; // show the next track this long before the current one ends

function isTyping(target) {
	return !!target?.closest?.("input, textarea, select, [contenteditable='true']");
}

function fmtTime(ms) {
	const s = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function createOverlay({ onOpenChange, onLyrics } = {}) {
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
			h("div", { class: "aur-bg-gradient" }),
			h("div", { class: "aur-bg-shade" }),
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
			tip.textContent = fmtTime(f * getDuration());
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
			clearCache: () => {
				const n = lyricsCache.size();
				lyricsCache.clear();
				return n;
			},
			toast,
		});

		const share = createShareSheet({
			getContext: () => ({ track: state.track, lyrics: state.lyrics, active: ui?.view.active ?? -1, root }),
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
			upNext,
			toastEl,
		);

		const view = new LyricsView(stage, {
			onShare: (i) => openShare(i),
			onSeek: (t) => {
				// Seek so that the *effective* (offset-adjusted) position lands on the line.
				seek(t - settings.get("offset") + 20);
				setTimeout(kick, 60);
			},
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
		ui = { trBtn, root, bgStack, cover, title, artist, artA, artB, artHint, sideTitle, sideArtist, sideAlbum, activeArt: artA, stage, dock, bar, miniProgress, elapsed, remaining, playBtn, shuffleBtn, repeatBtn, heartBtn, muteBtn, vol, source, offsetOut, fsBtn, toastEl, panel, share, view, upNext, upArt, upTitle, upArtist, upWhen };
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
			depth: all.depthBlur ? "on" : "off",
			bg: all.bgStyle,
			bganim: all.bgAnimate && !reduced ? "on" : "off",
			words: all.wordSync ? "on" : "off",
			motion: reduced ? "reduced" : "full",
			transport: all.showTransport ? "on" : "off",
			info: all.showTrackInfo ? "on" : "off",
			pinned: all.pinControls ? "true" : "false",
			view: all.view,
			wordanim: all.wordAnim,
		});
		view.setOptions({ layout, wordSync: all.wordSync, autoScroll: all.unsyncedAutoScroll, reduced, wordAnim: all.wordAnim, showBg: all.showBgVocals });
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
		if (!only) {
			state.lyrics = null;
			state.source = null;
			state.cached = false;
			state.pinned = false;
			ui.view.freeze(); // don't let the old lyrics chase the new track's position
		}
		updateTrackChrome(track);
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
			ui.elapsed.textContent = fmtTime(pos);
			ui.remaining.textContent = `-${fmtTime(dur - pos)}`;
			ui.bar.setAttribute("aria-valuemax", String(Math.round(dur / 1000)));
			updateUpNext(pos, dur);
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
		ui.upWhen.textContent = ` · in ${Math.max(1, Math.ceil(left / 1000))}s`;
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

	function tick() {
		// Whichever of rAF / fallback timer fired first, cancel the other.
		if (state.raf) cancelAnimationFrame(state.raf);
		clearTimeout(state.timer);
		state.raf = 0;
		state.timer = 0;
		if (!state.open) return;
		ui.view.update(smoothPosition() + settings.get("offset"), state.track?.duration || getDuration());
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
		ui.root.focus({ preventScroll: true });
		wake();
		if (state.stale || state.track?.uri !== getCurrentTrack()?.uri) loadLyrics();
		else {
			ui.view.relayout();
			ui.view.playEnter();
		}
		kick();
		onOpenChange?.(true);
	}

	function close() {
		if (!state.open) return;
		state.open = false;
		ui.panel.close();
		ui.share.close();
		ui.view.stopBrowsing(true);
		ui.root.classList.remove("is-open");
		if (state.enteredFullscreen && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
		state.closeTimer = setTimeout(() => (ui.root.hidden = true), CLOSE_MS);
		kick(); // cancels pending frames because state.open is false
		state.lastFocus?.focus?.({ preventScroll: true });
		onOpenChange?.(false);
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
				if (ui.share.isOpen()) ui.share.close();
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
			else return;
			e.preventDefault();
			e.stopPropagation();
		},
		true,
	);

	// ---------------------------------------------------------------------------
	// Player events (wired by main.js)
	// ---------------------------------------------------------------------------
	return {
		open,
		close,
		toggle: () => (state.open ? close() : open()),
		isOpen: () => state.open,
		onSongChange() {
			if (state.open) loadLyrics();
			else state.stale = true;
		},
		onPlayPause: kick,
		testSources,
		onProgress() {
			// ~1/s while playing and on seeks. Cheap, and makes seeks show up immediately
			// even if animation frames are being throttled.
			if (state.open) kick();
		},
	};
}
