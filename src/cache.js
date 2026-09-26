// Two stores:
//  - lyricsCache: fetched results (and "not found" results) per track URI, LRU-capped with TTLs.
//  - localLyrics: user-imported/pasted text, kept until removed. Stored under both the track URI
//    and a normalized "artist|title" key so it also applies to the same song on another album.

import { EXT_ID, nameKey } from "./util.js";
import { store } from "./storage.js";

// Bumped whenever older builds could have cached wrong results (v3: Musixmatch decoy matches).
const CACHE_VERSION = "cache3";
const INDEX_KEY = `${EXT_ID}:${CACHE_VERSION}-index`;
const ENTRY_PREFIX = `${EXT_ID}:${CACHE_VERSION}:`;
(function dropOldCaches() {
	for (const old of ["cache", "cache2"]) {
		const idx = store.getJSON(`${EXT_ID}:${old}-index`, null);
		if (!Array.isArray(idx)) continue;
		for (const k of idx) store.remove(`${EXT_ID}:${old}:${k}`);
		store.remove(`${EXT_ID}:${old}-index`);
	}
})();
const LOCAL_PREFIX = `${EXT_ID}:local:`;

const MAX_ENTRIES = 150;
const TTL_FOUND = 30 * 24 * 3600 * 1000;
const TTL_NOT_FOUND = 12 * 3600 * 1000; // retry misses twice a day

function readIndex() {
	const idx = store.getJSON(INDEX_KEY, []);
	return Array.isArray(idx) ? idx : [];
}

export const lyricsCache = {
	/** @returns {{ source: string, lyrics: object|null, notFound?: boolean } | null} */
	get(uri) {
		if (!uri) return null;
		const entry = store.getJSON(ENTRY_PREFIX + uri);
		if (!entry) return null;
		const ttl = entry.notFound ? TTL_NOT_FOUND : TTL_FOUND;
		if (Date.now() - entry.savedAt > ttl) {
			this.remove(uri);
			return null;
		}
		return entry;
	},

	/** extra: { notFound?: boolean, tried?: string[], instrumental?: boolean } */
	set(uri, source, lyrics, extra = {}) {
		if (!uri) return;
		const entry = { source, lyrics: extra.notFound ? null : lyrics, ...extra, savedAt: Date.now() };
		let idx = readIndex().filter((k) => k !== uri);
		idx.push(uri);
		// Evict least-recently-written entries.
		while (idx.length > MAX_ENTRIES) store.remove(ENTRY_PREFIX + idx.shift());
		// If the write fails (quota), evict harder and retry once.
		if (!store.setJSON(ENTRY_PREFIX + uri, entry)) {
			const drop = idx.splice(0, Math.ceil(idx.length / 3));
			for (const k of drop) store.remove(ENTRY_PREFIX + k);
			store.setJSON(ENTRY_PREFIX + uri, entry);
		}
		store.setJSON(INDEX_KEY, idx);
	},

	remove(uri) {
		store.remove(ENTRY_PREFIX + uri);
		store.setJSON(INDEX_KEY, readIndex().filter((k) => k !== uri));
	},

	clear() {
		for (const k of readIndex()) store.remove(ENTRY_PREFIX + k);
		store.setJSON(INDEX_KEY, []);
	},

	size() {
		return readIndex().length;
	},
};

export const localLyrics = {
	/** @returns {{ text: string, savedAt: number, fileName?: string } | null} */
	get(track) {
		if (!track) return null;
		return store.getJSON(LOCAL_PREFIX + track.uri) || store.getJSON(LOCAL_PREFIX + nameKey(track));
	},
	set(track, text, fileName) {
		const entry = { text, fileName: fileName || null, savedAt: Date.now(), title: track.title, artist: track.artist };
		store.setJSON(LOCAL_PREFIX + track.uri, entry);
		store.setJSON(LOCAL_PREFIX + nameKey(track), entry);
	},
	remove(track) {
		store.remove(LOCAL_PREFIX + track.uri);
		store.remove(LOCAL_PREFIX + nameKey(track));
	},
};
