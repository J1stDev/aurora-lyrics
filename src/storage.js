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
			console.warn("[fal] storage write failed", key, e);
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
