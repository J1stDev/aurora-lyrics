// Entry point: wait for Spicetify, inject CSS, register buttons and player listeners.

import { EXT_ID, sleep } from "./util.js";
import { ICONS } from "./icons.js";
import { createOverlay } from "./overlay.js";
import { createNowPlayingCard } from "./npv.js";
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
	if (globalThis.__falLoaded) return; // guard against double injection
	globalThis.__falLoaded = true;

	const S = await waitForSpicetify();

	const style = document.createElement("style");
	style.id = `${EXT_ID}-style`;
	style.textContent = CSS;
	document.head.append(style);

	let playbarBtn = null;
	let card = null;
	const overlay = createOverlay({
		onOpenChange: (open) => {
			if (playbarBtn) playbarBtn.active = open;
			if (!open) card?.onOverlayClosed();
		},
		onLyrics: (uri, lyrics, source) => card?.useLyrics(uri, lyrics, source),
	});
	// Our lyrics card in Spotify's right-hand Now Playing panel.
	try {
		card = createNowPlayingCard({ openOverlay: () => overlay.open(), isOverlayOpen: () => overlay.isOpen() });
	} catch (e) {
		console.warn(`[${EXT_ID}] Now Playing card unavailable`, e);
	}

	// Buttons: each API is optional across Spicetify versions, so register what exists.
	const label = "Aurora Lyrics (Alt+L)";
	try {
		if (S.Topbar?.Button) new S.Topbar.Button(label, ICONS.lyrics(16), () => overlay.toggle());
	} catch (e) {
		console.warn(`[${EXT_ID}] topbar button unavailable`, e);
	}
	try {
		if (S.Playbar?.Button) playbarBtn = new S.Playbar.Button(label, ICONS.lyrics(16), () => overlay.toggle(), false, false);
	} catch (e) {
		console.warn(`[${EXT_ID}] playbar button unavailable`, e);
	}

	S.Player.addEventListener("songchange", () => (overlay.onSongChange(), card?.onSongChange()));
	S.Player.addEventListener("onplaypause", () => (overlay.onPlayPause(), card?.onPlayPause()));
	S.Player.addEventListener("onprogress", () => (overlay.onProgress(), card?.onProgress()));

	// Small public handle for debugging from DevTools: window.FullscreenLyrics.open()
	globalThis.FullscreenLyrics = { open: overlay.open, close: overlay.close, toggle: overlay.toggle, testSources: overlay.testSources };
	console.info(`[${EXT_ID}] loaded`);
}
