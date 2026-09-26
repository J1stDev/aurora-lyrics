// Key/value persistence. Prefers Spicetify.LocalStorage (namespaced per Spotify user
// in recent Spicetify builds), falls back to window.localStorage, then to memory.

const memory = new Map();

function backend() {
	const S = globalThis.Spicetify;
	if (S?.LocalStorage?.get && S?.LocalStorage?.set) return S.LocalStorage;
	try {
		if (globalThis.localStorage) {
			return {
				get: (k) => globalThis.localStorage.getItem(k),
				set: (k, v) => globalThis.localStorage.setItem(k, v),
				remove: (k) => globalThis.localStorage.removeItem(k),
			};
		}
	} catch {
		/* storage blocked */
	}
	return { get: (k) => (memory.has(k) ? memory.get(k) : null), set: (k, v) => memory.set(k, v), remove: (k) => memory.delete(k) };
}

/**
 * One-time move of data saved under the extension's old name ("fullscreen-animated-lyrics:…")
 * to the current prefix. Matches the prefix anywhere in the key, so it also works if the
 * storage layer adds its own namespace in front. Existing new keys are never overwritten.
 * @param {Storage} ls  anything with length / key() / getItem() / setItem() / removeItem()
 * @returns {number} keys moved
 */
export function migrateLegacyKeys(ls, from = "fullscreen-animated-lyrics:", to = "aurora-lyrics:") {
	let moved = 0;
	try {
		const keys = [];
		for (let i = 0; i < ls.length; i++) {
			const k = ls.key(i);
			if (k && k.includes(from)) keys.push(k);
		}
		for (const k of keys) {
			const next = k.replace(from, to);
			if (ls.getItem(next) == null) {
				ls.setItem(next, ls.getItem(k));
				moved++;
			}
			ls.removeItem(k);
		}
	} catch (e) {
		console.warn("[aurora-lyrics] could not migrate old settings", e);
	}
	return moved;
}
try {
	if (globalThis.localStorage && typeof window !== "undefined") migrateLegacyKeys(globalThis.localStorage);
} catch {
	/* storage blocked */
}

export const store = {
	getJSON(key, fallback = null) {
		try {
			const raw = backend().get(key);
			return raw == null ? fallback : JSON.parse(raw);
		} catch {
			return fallback;
		}
	},
	/** Returns false when the write failed (e.g. quota exceeded). */
	setJSON(key, value) {
		try {
			backend().set(key, JSON.stringify(value));
			return true;
		} catch (e) {
			console.warn("[aurora-lyrics] storage write failed", key, e);
			return false;
		}
	},
	remove(key) {
		try {
			backend().remove(key);
		} catch {
			/* ignore */
		}
	},
};
