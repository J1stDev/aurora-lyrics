// The buttons that open the lyrics.
//
// Normally there are two, placed by Spicetify's own button APIs: one in Spotify's top bar and one in
// the player bar. Those APIs depend on Spotify's markup, which changes from release to release, so
// this also checks that the buttons are really on screen (every couple of seconds, since Spotify
// redraws its bars) and, if the player-bar one isn't, puts a button of our own there; if there is
// no button on screen at all, a small floating one appears in the corner, so the lyrics can always
// be opened (Alt+L works too).

import { h } from "./util.js";
import { ICONS } from "./icons.js";

// Where the player bar's right-hand group of buttons lives, by class and by test id (the test ids
// of its neighbours are the steadier thing to find it by).
const PLAYBAR_HOSTS = [".main-nowPlayingBar-extraControls", '[data-testid="extra-controls"]', '[data-testid="now-playing-bar"] [class*="extraControls"]', "footer [class*='extraControls']"];
const PLAYBAR_ANCHORS = [
	'[data-testid="lyrics-button"]',
	'[data-testid="control-button-npv"]',
	'[data-testid="queue-button"]',
	'[data-testid="control-button-pip"]',
	'[data-testid="control-button-connect"]',
	'[data-testid="volume-bar-toggle-mute-button"]',
];

const isShown = (el) => !!el && el.isConnected && el.getClientRects().length > 0;

function firstMatch(selectors) {
	for (const s of selectors) {
		try {
			const el = document.querySelector(s);
			if (el) return el;
		} catch {}
	}
	return null;
}

/**
 * createLauncher({ label, onToggle, getUri }): sets the buttons up and keeps them on screen.
 * Returns { setOpen(open), retint(), state }.
 */
export function createLauncher({ label, onToggle, getUri }) {
	const S = globalThis.Spicetify;
	const state = { topbar: null, playbar: null, playbarApi: null, own: null, float: null, open: false, color: "", timer: 0, ticks: 0, report: "" };

	function makeButton(cls, size) {
		const b = h("button", {
			class: `aur-launch ${cls}`,
			type: "button",
			title: label,
			"aria-label": label,
			html: ICONS.lyrics(size),
			onclick: (e) => {
				e.preventDefault();
				e.stopPropagation();
				onToggle();
			},
		});
		if (state.color) b.style.setProperty("--aur-pb-c", state.color);
		b.classList.toggle("is-on", state.open);
		return b;
	}

	// Spicetify's own buttons, styled as glass tiles (styles.css). Each API is optional across versions.
	try {
		if (S?.Topbar?.Button) {
			const tb = new S.Topbar.Button(label, ICONS.lyrics(20), () => onToggle());
			const el = tb.element?.matches?.("button") ? tb.element : tb.element?.querySelector?.("button") || tb.element;
			el?.classList.add("aur-topbar-btn");
			state.topbar = el || null;
		}
	} catch (e) {
		console.warn("[aurora-lyrics] top bar button unavailable", e);
	}
	try {
		if (S?.Playbar?.Button) {
			state.playbarApi = new S.Playbar.Button(label, ICONS.lyrics(16), () => onToggle(), false, false);
			const el = state.playbarApi.element;
			state.playbar = el?.matches?.("button") ? el : el?.querySelector?.("button") || el || null;
			state.playbar?.classList.add("aur-pb-btn");
		}
	} catch (e) {
		console.warn("[aurora-lyrics] player bar button unavailable", e);
	}

	const every = () => [state.topbar, state.playbar, state.own, state.float];

	/** Our own player-bar button, in the group of buttons on the right (or beside one of its neighbours). */
	function placeOwn() {
		const host = firstMatch(PLAYBAR_HOSTS);
		let parent = host;
		let before = host?.firstChild || null;
		if (!host) {
			const anchor = firstMatch(PLAYBAR_ANCHORS);
			if (!anchor?.parentElement) return;
			parent = anchor.parentElement;
			before = anchor;
		}
		state.own ||= makeButton("aur-launch-pb", 16);
		parent.insertBefore(state.own, before);
	}

	function setFloat(on) {
		if (on && !state.float) {
			state.float = makeButton("aur-launch-float", 20);
			document.body.append(state.float);
		}
		if (state.float) state.float.hidden = !on;
	}

	function ensure() {
		const top = isShown(state.topbar);
		let bar = isShown(state.playbar);
		if (!bar) {
			if (!isShown(state.own)) placeOwn();
			bar = isShown(state.own);
		} else if (state.own) {
			state.own.remove(); // Spicetify's has appeared (or come back): one is enough
			state.own = null;
		}
		setFloat(!top && !bar);
		const report = `top bar ${top ? "yes" : "no"}, player bar ${isShown(state.playbar) ? "yes" : bar ? "own" : "no"}, floating ${top || bar ? "no" : "yes"}`;
		if (report !== state.report) {
			state.report = report;
			console.info(`[aurora-lyrics] buttons: ${report}`);
		}
	}

	// Look a few times while Spotify draws its bars, then now and then, since it redraws them.
	function schedule() {
		const delays = [400, 1000, 2000, 4000];
		state.timer = setTimeout(
			() => {
				ensure();
				state.ticks++;
				schedule();
			},
			delays[state.ticks] ?? 2500,
		);
	}
	schedule();

	return {
		state,
		/** The buttons are lit while the lyrics are open. */
		setOpen(open) {
			state.open = open;
			if (state.playbarApi) state.playbarApi.active = open;
			for (const b of every()) b?.classList.toggle("is-on", open);
		},
		/** They glow in the album's colour. */
		retint() {
			const uri = getUri?.();
			if (!uri || typeof S?.colorExtractor !== "function") return;
			Promise.resolve(S.colorExtractor(uri))
				.then((c) => {
					if (!c) return;
					state.color = c.LIGHT_VIBRANT || c.VIBRANT || c.PROMINENT || "#b98cff";
					for (const b of every()) b?.style.setProperty("--aur-pb-c", state.color);
				})
				.catch(() => {});
		},
	};
}
