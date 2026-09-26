// Entry point: wait for Spicetify, inject CSS, register buttons and player listeners.

import { EXT_ID, sleep } from "./util.js";
import { ICONS } from "./icons.js";
import { createOverlay } from "./overlay.js";
import { createNowPlayingCard } from "./npv.js";
import { createMiniLyrics } from "./mini.js";
import { CSS } from "./styles.js";

async function waitForSpicetify(timeoutMs = 60000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const S = globalThis.Spicetify;
		if (S?.Player?.addEventListener && S?.Player?.data !== undefined && S?.LocalStorage && document.body) return S;
		await sleep(250);
	}
	throw new Error("Spicetify APIs did not become available");
}

export async function main() {
	if (globalThis.__auroraLyricsLoaded) return; // guard against double injection
	globalThis.__auroraLyricsLoaded = true;

	const S = await waitForSpicetify();

	const style = document.createElement("style");
	style.id = `${EXT_ID}-style`;
	style.textContent = CSS;
	document.head.append(style);

	let playbarBtn = null;
	let playbarEl = null; // the player-bar button element, styled as a liquid-glass tile
	let card = null;
	let mini = null;
	const overlay = createOverlay({
		onOpenChange: (open) => {
			if (playbarBtn) playbarBtn.active = open;
			playbarEl?.classList.toggle("is-on", open);
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
			// Round like Spotify's global-nav buttons (Home, Marketplace…); styles in styles.css.
			const el = tb.element?.matches?.("button") ? tb.element : tb.element?.querySelector?.("button") || tb.element;
			el?.classList.add("aur-topbar-btn");
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
			tintPlaybar();
		}
	} catch (e) {
		console.warn(`[${EXT_ID}] playbar button unavailable`, e);
	}

	// The glass tile glows in the album's colour while the lyrics are open.
	function tintPlaybar() {
		const uri = S.Player.data?.item?.uri;
		if (!playbarEl || !uri || typeof S.colorExtractor !== "function") return;
		Promise.resolve(S.colorExtractor(uri))
			.then((c) => c && playbarEl.style.setProperty("--aur-pb-c", c.LIGHT_VIBRANT || c.VIBRANT || c.PROMINENT || "#b98cff"))
			.catch(() => {});
	}
	S.Player.addEventListener("songchange", () => (overlay.onSongChange(), card?.onSongChange(), tintPlaybar()));
	S.Player.addEventListener("onplaypause", () => (overlay.onPlayPause(), card?.onPlayPause(), mini?.onPlayPause()));
	S.Player.addEventListener("onprogress", () => (overlay.onProgress(), card?.onProgress(), mini?.onProgress()));

	// Small public handle for debugging from DevTools: window.AuroraLyrics.open()
	globalThis.AuroraLyrics = { open: overlay.open, close: overlay.close, toggle: overlay.toggle, testSources: overlay.testSources, toggleMini: () => mini?.toggle() };
	console.info(`[${EXT_ID}] loaded`);
}
