// Listening stats: time spent with the fullscreen lyrics open while music plays, broken down by
// song, artist, day and theme, plus lines sung along. One small JSON object in local storage.
// The functions here are pure (they take and change a stats object); overlay.js drives them.

const STATS_MAX_SONGS = 400;
const STATS_MAX_DAYS = 120;
const STREAK_MIN_MS = 60000; // a day counts toward the streak after a minute of lyrics

const pad2 = (n) => String(n).padStart(2, "0");
/** Local calendar day, "YYYY-MM-DD". */
export function dayKey(ts) {
	const d = new Date(ts);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function emptyStats(now) {
	return { v: 1, since: now, ms: 0, lines: 0, days: {}, songs: {}, themes: {} };
}

/** A stored object, repaired or replaced if it isn't one of ours. */
export function validStats(s, now) {
	if (!s || s.v !== 1 || typeof s.ms !== "number") return emptyStats(now);
	for (const k of ["days", "songs", "themes"]) if (!s[k] || typeof s[k] !== "object") s[k] = {};
	s.lines = Number(s.lines) || 0;
	s.since = Number(s.since) || now;
	return s;
}

/**
 * Add listening time. `fresh` marks the first time counted for this play of the track, so the
 * song's play count goes up once per play.
 */
export function addTime(s, { ms, now, track, theme, fresh = false }) {
	if (!(ms > 0)) return;
	s.ms += ms;
	const d = dayKey(now);
	s.days[d] = (s.days[d] || 0) + ms;
	if (track?.uri) {
		const e = (s.songs[track.uri] ||= { t: "", a: "", ms: 0, n: 0, l: 0, last: 0 });
		e.t = track.title || e.t;
		e.a = track.artist || e.a;
		e.ms += ms;
		e.last = now;
		if (fresh) e.n++;
	}
	if (theme) s.themes[theme] = (s.themes[theme] || 0) + ms;
}

export function addLine(s, uri) {
	s.lines++;
	if (uri && s.songs[uri]) s.songs[uri].l++;
}

/** Keep the object small: the newest days and the most-listened songs. */
export function pruneStats(s) {
	const days = Object.keys(s.days).sort();
	for (const d of days.slice(0, Math.max(0, days.length - STATS_MAX_DAYS))) delete s.days[d];
	const songs = Object.entries(s.songs);
	if (songs.length > STATS_MAX_SONGS) {
		songs.sort((a, b) => b[1].ms - a[1].ms);
		for (const [uri] of songs.slice(STATS_MAX_SONGS)) delete s.songs[uri];
	}
	return s;
}

/** Days in a row with lyrics, ending today (or yesterday, so an unfinished today doesn't break it). */
export function streak(s, now) {
	const has = (t) => (s.days[dayKey(t)] || 0) >= STREAK_MIN_MS;
	const DAY = 86400000;
	let t = now;
	if (!has(t)) t -= DAY;
	let n = 0;
	while (has(t)) (n++, (t -= DAY));
	return n;
}

/** Everything the Stats page shows. */
export function summarize(s, now, days = 14) {
	const songs = Object.entries(s.songs).map(([uri, e]) => ({ uri, title: e.t, artist: e.a, ms: e.ms, plays: e.n, lines: e.l }));
	const artists = new Map();
	for (const e of songs) {
		const name = (e.artist || "").split(/,\s*/)[0];
		if (!name) continue;
		const a = artists.get(name) || { name, ms: 0, songs: 0 };
		a.ms += e.ms;
		a.songs++;
		artists.set(name, a);
	}
	const lastDays = [];
	for (let i = days - 1; i >= 0; i--) {
		const t = now - i * 86400000;
		lastDays.push({ day: dayKey(t), date: t, ms: s.days[dayKey(t)] || 0 });
	}
	const theme = Object.entries(s.themes).sort((a, b) => b[1] - a[1])[0];
	return {
		since: s.since,
		totalMs: s.ms,
		lines: s.lines,
		songCount: songs.length,
		streak: streak(s, now),
		todayMs: s.days[dayKey(now)] || 0,
		topSongs: songs.sort((a, b) => b.ms - a.ms).slice(0, 5),
		topArtists: [...artists.values()].sort((a, b) => b.ms - a.ms).slice(0, 5),
		lastDays,
		favTheme: theme ? { id: theme[0], ms: theme[1] } : null,
	};
}

/** "3 h 12 min", "12 min", "45 s". */
export function fmtDuration(ms) {
	const m = Math.floor(ms / 60000);
	if (m < 1) return `${Math.round(ms / 1000)} s`;
	if (m < 60) return `${m} min`;
	const h = Math.floor(m / 60);
	return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
