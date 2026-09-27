// Beat grid for the current song, from Spotify's audio analysis (Spicetify.getAudioData), used to
// time theme ambience to the music. Optional: when the analysis isn't available (the endpoint
// can be missing or refused) themes simply keep reacting to lyric lines.

const BEAT_CACHE_MAX = 30;
const beatCache = new Map(); // uri → parsed grid, or null when there is none

/**
 * Parse an audio-analysis response into what the ambience needs.
 * @returns {{ beats: number[], bars: number[], tempo: number, sections: { time: number, energy: number }[] } | null}
 *   times in ms; energy 0..1 per section (from its loudness)
 */
export function parseAnalysis(a) {
	const beats = (a?.beats || []).filter((b) => b && Number.isFinite(b.start)).map((b) => Math.round(b.start * 1000));
	if (beats.length < 8) return null;
	const bars = (a.bars || []).filter((b) => b && Number.isFinite(b.start)).map((b) => Math.round(b.start * 1000));
	const gaps = beats.slice(1).map((t, i) => t - beats[i]).sort((x, y) => x - y);
	const median = gaps[gaps.length >> 1];
	let tempo = Number(a.track?.tempo);
	if (!(tempo > 30 && tempo < 300)) tempo = median > 0 ? 60000 / median : 120;
	// Loudness in dB (about -35 quiet … -4 loud) → 0..1.
	const sections = (a.sections || [])
		.filter((s) => s && Number.isFinite(s.start))
		.map((s) => ({ time: Math.round(s.start * 1000), energy: Math.min(1, Math.max(0, ((Number(s.loudness) || -20) + 35) / 31)) }));
	return { beats, bars: bars.length >= 2 ? bars : beats.filter((_, i) => i % 4 === 0), tempo, sections };
}

/** Index of the last time <= pos, or -1 (binary search; times sorted). */
export function beatIndexAt(times, pos) {
	let lo = 0;
	let hi = times.length - 1;
	let ans = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (times[mid] <= pos) (ans = mid), (lo = mid + 1);
		else hi = mid - 1;
	}
	return ans;
}

/** The beat grid for a track uri (cached per session), or null. */
export async function loadBeats(uri) {
	if (!uri) return null;
	if (beatCache.has(uri)) return beatCache.get(uri);
	let grid = null;
	try {
		const get = globalThis.Spicetify?.getAudioData;
		if (typeof get === "function") grid = parseAnalysis(await get(uri));
	} catch {
		/* no analysis for this track, or the endpoint is unavailable */
	}
	beatCache.set(uri, grid);
	if (beatCache.size > BEAT_CACHE_MAX) beatCache.delete(beatCache.keys().next().value);
	return grid;
}
