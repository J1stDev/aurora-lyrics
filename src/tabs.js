// Songsterr: find the guitar / bass / drum tabs for the playing song and open them in the
// browser. Only Songsterr's public song search is used (through the CORS proxy, since it
// sends no CORS headers); the tabs themselves are viewed on songsterr.com.

import { titleMatches, artistMatches, normalizeTitle } from "./util.js";
import { getJSON } from "./net.js";

const SEARCH = "https://www.songsterr.com/api/songs";
const tabCache = new Map(); // track uri → result

function slug(s) {
	return normalizeTitle(s).replace(/\s+/g, "-") || "song";
}

/** Songsterr's search page for a free-text query (used when there's no exact match). */
export function songsterrSearchUrl(track) {
	return `https://www.songsterr.com/?pattern=${encodeURIComponent(`${track.artist} ${track.title}`.trim())}`;
}

/** Which instrument family a Songsterr track is. */
export function instrumentKind(t) {
	const s = `${t?.instrument || ""} ${t?.name || ""}`.toLowerCase();
	if (/drum|percussion/.test(s)) return "drums";
	if (/bass/.test(s)) return "bass";
	if (/guitar/.test(s)) return "guitar";
	if (/vocal|voice|choir|aahs/.test(s)) return "vocals";
	return "other";
}

/**
 * Pick the search result that is the playing song, and summarise it.
 * @returns {null | { url, title, artist, parts: { guitar, bass, drums, vocals, other }, difficulty: number|null }}
 */
export function pickSongsterr(results, track) {
	if (!Array.isArray(results)) return null;
	const song = results.find((r) => r && titleMatches(track.title, r.title) && artistMatches(track.artist, [r.artist]));
	if (!song?.songId) return null;
	const parts = { guitar: 0, bass: 0, drums: 0, vocals: 0, other: 0 };
	let difficulty = null;
	for (const t of song.tracks || []) {
		const kind = instrumentKind(t);
		parts[kind]++;
		if (kind === "guitar" && Number.isFinite(t.difficulty)) difficulty = Math.max(difficulty ?? 0, t.difficulty);
	}
	return {
		url: `https://www.songsterr.com/a/wsa/${slug(song.artist)}-${slug(song.title)}-tab-s${song.songId}`,
		title: song.title,
		artist: song.artist,
		parts,
		difficulty,
	};
}

/** Look the track up on Songsterr (cached per track). Resolves null when there's no tab. */
export async function findTabs(track, { signal } = {}) {
	if (!track?.title) return null;
	if (tabCache.has(track.uri)) return tabCache.get(track.uri);
	const pattern = `${track.artist.split(",")[0]} ${track.title}`.trim();
	const res = await getJSON(`${SEARCH}?pattern=${encodeURIComponent(pattern)}&size=10`, { signal, proxy: true });
	if (!res.ok) throw new Error(`Songsterr: HTTP ${res.status}`);
	const found = pickSongsterr(res.json, track);
	tabCache.set(track.uri, found);
	return found;
}
