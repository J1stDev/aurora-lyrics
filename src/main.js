// Entry point: wait for Spicetify, inject CSS, register buttons and player listeners.

import { EXT_ID, sleep } from "./util.js";
import { createOverlay } from "./overlay.js";
import { createNowPlayingCard } from "./npv.js";
import { createMiniLyrics } from "./mini.js";
import { createLauncher } from "./launcher.js";
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

	let launcher = null;
	let card = null;
	let mini = null;
	const overlay = createOverlay({
		onOpenChange: (open) => {
			launcher?.setOpen(open);
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

	// The buttons that open the lyrics (top bar, player bar, or a floating one if neither is on screen).
	try {
		launcher = createLauncher({ label: "Aurora Lyrics (Alt+L)", onToggle: () => overlay.toggle(), getUri: () => S.Player.data?.item?.uri });
		launcher.retint();
	} catch (e) {
		console.warn(`[${EXT_ID}] buttons unavailable`, e);
	}

	S.Player.addEventListener("songchange", () => (overlay.onSongChange(), card?.onSongChange(), launcher?.retint()));
	S.Player.addEventListener("onplaypause", () => (overlay.onPlayPause(), card?.onPlayPause(), mini?.onPlayPause()));
	S.Player.addEventListener("onprogress", () => (overlay.onProgress(), card?.onProgress(), mini?.onProgress()));

	// Small public handle for debugging from DevTools: window.AuroraLyrics.open()
	globalThis.AuroraLyrics = { open: overlay.open, close: overlay.close, toggle: overlay.toggle, testSources: overlay.testSources, toggleMini: () => mini?.toggle() };
	console.info(`[${EXT_ID}] loaded`);
}
