import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { fromSpotify, pickBestMatch, resolveLyrics, lyricsQuality } from "../src/providers.js";
import { lyricsCache, localLyrics } from "../src/cache.js";
import { DEFAULTS } from "../src/settings.js";
import { resetSourceBackoff } from "../src/sources.js";

const track = { uri: "spotify:track:abc", id: "abc", title: "My Song (feat. Guest)", artist: "Main Artist, Guest", album: "Album", duration: 200000, isTrack: true };

/** Settings with exactly these providers enabled, in this order. */
const using = (ids, extra = {}) => ({ ...DEFAULTS, providers: ids.map((id) => ({ id, on: true })), ...extra });

// In-memory Spicetify so cache/local stores and CosmosAsync work under Node.
// `routes` maps a URL substring to a response (or a function returning one / throwing).
function installSpicetify(routes = {}) {
	const mem = new Map();
	const calls = [];
	globalThis.Spicetify = {
		LocalStorage: { get: (k) => (mem.has(k) ? mem.get(k) : null), set: (k, v) => mem.set(k, v), remove: (k) => mem.delete(k) },
		CosmosAsync: {
			get: async (url) => {
				calls.push(url);
				for (const [frag, r] of Object.entries(routes)) if (url.includes(frag)) return typeof r === "function" ? r(url) : r;
				throw new Error("404 not found");
			},
		},
		Config: { version: "test" },
	};
	return calls;
}

function jsonResponse(status, body) {
	return { status, ok: status >= 200 && status < 300, headers: new Map([["retry-after", "30"]]), json: async () => body };
}

/** An LRCLIB record for the test track (real responses always include these fields). */
const lrclibRec = (synced) => ({ trackName: "My Song", artistName: "Main Artist", duration: 200, syncedLyrics: synced });

const spotifyLine = { lyrics: { syncType: "LINE_SYNCED", lines: [{ startTimeMs: "500", words: "hi" }] } };
const spotifyPlain = { lyrics: { syncType: "UNSYNCED", lines: [{ startTimeMs: "0", words: "plain" }] } };

/** fetch() mock: first route whose key is a substring of the URL wins; records URLs. */
function routeFetch(routes) {
	const urls = [];
	globalThis.fetch = async (url) => {
		const u = String(url);
		urls.push(u);
		for (const [frag, r] of Object.entries(routes)) {
			if (!u.includes(frag)) continue;
			const v = typeof r === "function" ? r(u) : r;
			return Array.isArray(v) ? jsonResponse(v[0], v[1]) : jsonResponse(200, v);
		}
		return jsonResponse(404, {});
	};
	return urls;
}

beforeEach(() => {
	installSpicetify();
	resetSourceBackoff();
	globalThis.fetch = async () => jsonResponse(404, {});
});

test("fromSpotify: LINE_SYNCED with ♪ gaps and string times", () => {
	const l = fromSpotify(
		{
			lyrics: {
				syncType: "LINE_SYNCED",
				lines: [
					{ startTimeMs: "1000", words: "one" },
					{ startTimeMs: "3000", words: "♪" },
					{ startTimeMs: "9000", words: "two" },
				],
			},
		},
		20000,
	);
	assert.equal(l.synced, true);
	assert.deepEqual(
		l.lines.map((x) => (x.gap ? "gap" : x.text)),
		["one", "gap", "two"],
	);
});

test("fromSpotify: UNSYNCED", () => {
	const l = fromSpotify(spotifyPlain);
	assert.equal(l.synced, false);
	assert.equal(l.lines.length, 1);
});

test("fromSpotify: syllable sync becomes word timing", () => {
	const l = fromSpotify({
		lyrics: {
			syncType: "SYLLABLE_SYNCED",
			lines: [{ startTimeMs: "1000", words: "Hello world", syllables: [{ startTimeMs: "1000", numChars: 6 }, { startTimeMs: "1400", numChars: 5 }] }],
		},
	});
	assert.equal(l.hasWords, true);
	assert.deepEqual(
		l.lines[l.lines.length - 1].words.map((w) => w.text),
		["Hello ", "world"],
	);
});

test("pickBestMatch prefers exact names + synced within duration", () => {
	const results = [
		{ trackName: "My Song", artistName: "Main Artist", duration: 260, syncedLyrics: "[00:01.00]x" }, // too long
		{ trackName: "My Song", artistName: "Main Artist", duration: 201, plainLyrics: "x" },
		{ trackName: "My Song", artistName: "Main Artist", duration: 199, syncedLyrics: "[00:01.00]x" },
		{ trackName: "Other", artistName: "Nobody", duration: 200, syncedLyrics: "[00:01.00]x" },
	];
	assert.equal(pickBestMatch(results, track), results[2]);
	assert.equal(pickBestMatch([results[3]], track), null);
	assert.equal(pickBestMatch([{ trackName: "My Song", artistName: "Cover Band", duration: 200, syncedLyrics: "[00:01.00]x" }], track), null, "title-only match rejected");
});

test("resolver: result is used and cached; force skips the cache", async () => {
	let n = 0;
	installSpicetify({ "color-lyrics": () => (n++, spotifyLine) });
	const s = using(["spotify"], { searchUntil: "synced" });
	assert.equal((await resolveLyrics(track, s)).source, "spotify");
	assert.equal((await resolveLyrics(track, s)).cached, true);
	assert.equal(n, 1);
	assert.equal((await resolveLyrics(track, s, { force: true })).cached, undefined);
	assert.equal(n, 2);
});

test("resolver: shows first result, upgrades to word sync, stops there", async () => {
	installSpicetify({ "color-lyrics": spotifyLine });
	let lrclibCalls = 0;
	globalThis.fetch = async (url) => {
		if (String(url).includes("unison")) return jsonResponse(200, { data: { format: "lrc", lyrics: "[00:01.00]<00:01.00>word <00:01.50>sync<00:02.00>" } });
		lrclibCalls++;
		return jsonResponse(404, {});
	};
	const updates = [];
	const r = await resolveLyrics(track, using(["spotify", "unison", "lrclib"]), { onUpdate: (u) => updates.push(u.source) });
	assert.deepEqual(updates, ["spotify"], "interim line-synced result shown first");
	assert.equal(r.source, "unison");
	assert.equal(lyricsQuality(r.lyrics), 3);
	assert.equal(lrclibCalls, 0, "search stops once word sync is found");
});

test("resolver: keeps searching past plain text, falls back to it", async () => {
	installSpicetify({ "color-lyrics": spotifyPlain });
	const r = await resolveLyrics(track, using(["spotify", "lrclib"]));
	assert.equal(r.source, "spotify");
	assert.equal(r.lyrics.synced, false);
});

test("resolver: cached lower-quality hit is reused once every source was tried", async () => {
	let n = 0;
	installSpicetify({ "color-lyrics": () => (n++, spotifyLine) });
	const s = using(["spotify", "lrclib"]); // wants word sync, none exists
	await resolveLyrics(track, s);
	const again = await resolveLyrics(track, s);
	assert.equal(again.cached, true);
	assert.equal(n, 1);
	// A newly enabled provider gets a chance.
	await resolveLyrics(track, using(["spotify", "lrclib", "unison"]));
	assert.equal(n, 2);
});

test("resolver: local import beats everything, across albums", async () => {
	localLyrics.set(track, "[00:01.00]mine");
	const r = await resolveLyrics(track, DEFAULTS);
	assert.equal(r.source, "local");
	assert.equal(r.lyrics.lines[0].text, "mine");
	const r2 = await resolveLyrics({ ...track, uri: "spotify:track:zzz", id: "zzz" }, DEFAULTS);
	assert.equal(r2.source, "local");
});

test("resolver: `only` pins a provider for the track", async () => {
	installSpicetify({ "color-lyrics": spotifyLine });
	globalThis.fetch = async () => jsonResponse(200, lrclibRec("[00:01.00]from lrclib"));
	const pinned = await resolveLyrics(track, using(["spotify", "lrclib"]), { only: "lrclib" });
	assert.equal(pinned.source, "lrclib");
	assert.equal(pinned.pinned, true);
	// Auto resolution now returns the pinned choice from cache.
	const auto = await resolveLyrics(track, using(["spotify", "lrclib"]));
	assert.equal(auto.source, "lrclib");
	assert.equal(auto.cached, true);
});

test("resolver: definitive miss is negative-cached; errors are not", async () => {
	let fetches = 0;
	globalThis.fetch = async () => (fetches++, jsonResponse(404, {}));
	const s = using(["lrclib"]);
	const r = await resolveLyrics(track, s);
	assert.equal(r.lyrics, null);
	assert.equal(r.error, undefined);
	const before = fetches;
	assert.equal((await resolveLyrics(track, s)).cached, true);
	assert.equal(fetches, before, "no new requests after a cached miss");

	lyricsCache.clear();
	globalThis.fetch = async () => jsonResponse(500, {});
	const r3 = await resolveLyrics(track, s);
	assert.match(r3.error, /LRCLIB HTTP 500/);
	assert.equal(lyricsCache.get(track.uri), null);
});

const ok = (body) => ({ message: { header: { status_code: 200 }, body } });
const mxmTrack = { track_name: "My Song", artist_name: "Main Artist feat. Guest", track_length: 200, has_richsync: 1 };
const richBody = JSON.stringify([{ ts: 1, te: 2.5, x: "Hi there", l: [{ c: "Hi", o: 0 }, { c: " " }, { c: "there", o: 0.6 }] }]);
const mxmMobile = (track = mxmTrack) =>
	ok({
		macro_calls: {
			"matcher.track.get": ok({ track }),
			"track.richsync.get": ok({ richsync: { richsync_body: richBody } }),
			"track.subtitles.get": ok({ subtitle_list: [{ subtitle: { subtitle_body: JSON.stringify([{ text: "line one", time: { total: 1.2 } }]) } }] }),
		},
	});
const tokenOk = () => ok({ user_token: "tok".padEnd(54, "a") });

test("spotify: direct authenticated fetch, no CosmosAsync needed", async () => {
	globalThis.Spicetify.Platform = { AuthorizationAPI: { getState: () => ({ token: { accessToken: "tkn" } }) }, version: "1.3.2", PlatformData: { app_platform: "Win32" } };
	globalThis.Spicetify.CosmosAsync.get = async () => {
		throw new Error("Resolver not found!");
	};
	let auth = null;
	globalThis.fetch = async (url, opts) => {
		if (String(url).includes("color-lyrics")) {
			auth = opts.headers.Authorization;
			return jsonResponse(200, spotifyLine);
		}
		return jsonResponse(404, {});
	};
	const r = await resolveLyrics(track, using(["spotify"]));
	assert.equal(r.source, "spotify");
	assert.equal(auth, "Bearer tkn");
});

test("spotify: CosmosAsync 'Resolver not found' is an error, {code:404} is a miss", async () => {
	globalThis.Spicetify.CosmosAsync.get = async () => {
		throw new Error("Resolver not found!");
	};
	const r = await resolveLyrics(track, using(["spotify"]));
	assert.match(r.error, /Spotify/);
	lyricsCache.clear();
	globalThis.Spicetify.CosmosAsync.get = async () => ({ code: 404, error: "Not Found", message: "Failed to fetch" });
	const r2 = await resolveLyrics(track, using(["spotify"]));
	assert.equal(r2.error, undefined);
	assert.equal(r2.lyrics, null);
});

test("musixmatch: word sync via the mobile API through the proxy; token cached", async () => {
	let tokens = 0;
	const urls = routeFetch({
		"token.get": () => (tokens++, tokenOk()),
		"apic-appmobile.musixmatch.com/ws/1.1/macro": mxmMobile(),
	});
	const r = await resolveLyrics(track, using(["musixmatch"]));
	assert.equal(lyricsQuality(r.lyrics), 3);
	const line = r.lyrics.lines.find((l) => !l.gap);
	assert.deepEqual(
		line.words.map((w) => [w.time, w.text]),
		[
			[1000, "Hi "],
			[1600, "there"],
		],
	);
	assert.ok(urls.every((u) => u.startsWith("https://cors-proxy.spicetify.app/https://apic-appmobile.musixmatch.com/")));
	assert.ok(!urls.some((u) => u.includes("apic-desktop")), "never uses the decoy-prone desktop API");
	lyricsCache.clear();
	await resolveLyrics({ ...track, uri: "spotify:track:2" }, using(["musixmatch"]));
	assert.equal(tokens, 1, "token reused");
});

test("musixmatch: a different matched song (decoy / wrong match) is rejected", async () => {
	routeFetch({
		"token.get": tokenOk,
		"apic-appmobile.musixmatch.com/ws/1.1/macro": mxmMobile({ track_name: "NOKIA", artist_name: "Drake", track_length: 241, has_richsync: 1 }),
	});
	const r = await resolveLyrics(track, using(["musixmatch"]));
	assert.equal(r.lyrics, null);
	assert.equal(r.report.musixmatch.status, "notfound");
});

test("musixmatch: same title but other artist (a cover) is rejected", async () => {
	routeFetch({ "token.get": tokenOk, "apic-appmobile.musixmatch.com/ws/1.1/macro": mxmMobile({ ...mxmTrack, artist_name: "Some Cover Band" }) });
	assert.equal((await resolveLyrics(track, using(["musixmatch"]))).lyrics, null);
});

test("musixmatch: captcha'd token → skipped quietly, token requests paused", async () => {
	let tokenCalls = 0;
	routeFetch({ "token.get": () => (tokenCalls++, { message: { header: { status_code: 401, hint: "captcha" } } }) });
	const r = await resolveLyrics(track, using(["musixmatch", "lrclib"]));
	assert.equal(r.report.musixmatch.status, "skipped");
	lyricsCache.clear();
	await resolveLyrics(track, using(["musixmatch", "lrclib"]));
	assert.equal(tokenCalls, 1, "no token retry during the pause");
});

test("musixmatch: expired token is replaced once", async () => {
	let tokens = 0;
	let macro = 0;
	routeFetch({
		"token.get": () => ok({ user_token: `tok${++tokens}`.padEnd(54, "b") }),
		"apic-appmobile.musixmatch.com/ws/1.1/macro": () => (++macro === 1 ? { message: { header: { status_code: 401, hint: "renew" } } } : mxmMobile()),
	});
	const r = await resolveLyrics(track, using(["musixmatch"]));
	assert.equal(lyricsQuality(r.lyrics), 3);
	assert.equal(tokens, 2);
});

test("lrclib: records for another song (e.g. a cover in another language) are rejected", async () => {
	routeFetch({
		"lrclib.net/api/get": { trackName: "My Song", artistName: "Cover Singer", duration: 200, syncedLyrics: "[00:01.00]other language" },
		"lrclib.net/api/search": [{ trackName: "My Song", artistName: "Cover Singer", duration: 200, syncedLyrics: "[00:01.00]other language" }],
	});
	assert.equal((await resolveLyrics(track, using(["lrclib"]))).lyrics, null);
});

test("netease: via the CORS proxy, duration match, YRC words, credits removed", async () => {
	const urls = routeFetch({
		"search/get": { code: 200, result: { songs: [{ id: 7, name: "My Song", artists: [{ name: "Main Artist" }], duration: 260000 }, { id: 8, name: "My Song", artists: [{ name: "Main Artist" }], duration: 200500 }] } },
		"song/lyric?id=8": { code: 200, lrc: { lyric: "[00:01.00]x" }, yrc: { lyric: '{"t":0,"c":[{"tx":"credits"}]}\n[0,1000](0,1000,0)作词 : someone\n[1000,1500](1000,700,0)Hello (1700,800,0)world' } },
	});
	const r = await resolveLyrics(track, using(["netease"]));
	assert.equal(r.source, "netease");
	assert.ok(urls.every((u) => u.startsWith("https://cors-proxy.spicetify.app/https://music.163.com/")));
	const lines = r.lyrics.lines.filter((l) => !l.gap);
	assert.equal(lines[0].text, "Hello world");
	assert.deepEqual(
		lines[0].words.map((w) => [w.time, w.end]),
		[
			[1000, 1700],
			[1700, 2500],
		],
	);
});

test("rate-limited providers are skipped silently and the next one is used", async () => {
	routeFetch({
		"search/get": { code: 405, msg: "操作频繁" }, // NetEase "too frequent"
		"lrclib.net/api/get": lrclibRec("[00:01.00]from lrclib"),
	});
	const r = await resolveLyrics(track, using(["netease", "lrclib"], { searchUntil: "synced" }));
	assert.equal(r.source, "lrclib");
	assert.equal(r.report.netease.status, "skipped");
	// Second track: NetEase is paused, so it isn't even asked.
	const urls = routeFetch({ "lrclib.net/api/get": lrclibRec("[00:01.00]again") });
	await resolveLyrics({ ...track, uri: "spotify:track:other" }, using(["netease", "lrclib"], { searchUntil: "synced" }));
	assert.ok(!urls.some((u) => u.includes("music.163.com")));
});

test("everything busy → friendly message, nothing cached", async () => {
	routeFetch({ "search/get": { code: 405 } });
	const r = await resolveLyrics(track, using(["netease"]));
	assert.match(r.error, /busy/);
	assert.equal(lyricsCache.get(track.uri), null);
});

test("provider backoff: LRCLIB 429 pauses further requests", async () => {
	let fetches = 0;
	globalThis.fetch = async () => (fetches++, jsonResponse(429, {}));
	const r = await resolveLyrics(track, using(["lrclib"]));
	assert.match(r.error, /rate limit/i);
	const r2 = await resolveLyrics(track, using(["lrclib"]));
	assert.match(r2.error, /rate-limited/i);
	assert.equal(fetches, 1);
});

test("resolver: all sources disabled", async () => {
	const r = await resolveLyrics(track, using([]));
	assert.match(r.error, /disabled/);
});

test("paxsenix: iTunes lookup (validated) → Apple Music syllable lyrics", async () => {
	const urls = routeFetch({
		"itunes.apple.com/search": { results: [{ kind: "song", trackId: 42, trackName: "My Song", artistName: "Main Artist", trackTimeMillis: 200500 }] },
		"lyrics.paxsenix.org/apple-music/lyrics?id=42": {
			type: "Syllable",
			content: [{ timestamp: 1000, endtime: 2000, text: [{ text: "Hi", timestamp: 1000, endtime: 1400, part: false }, { text: "there", timestamp: 1400, endtime: 2000, part: false }] }],
		},
	});
	const r = await resolveLyrics(track, using(["paxsenix"]));
	assert.equal(r.source, "paxsenix");
	assert.equal(lyricsQuality(r.lyrics), 3);
	assert.ok(urls.every((u) => !u.includes("cors-proxy")), "no proxy needed");
});

test("paxsenix: no validated iTunes match → not found (lyrics endpoint not called)", async () => {
	const urls = routeFetch({ "itunes.apple.com/search": { results: [{ kind: "song", trackId: 7, trackName: "My Song", artistName: "Somebody Else", trackTimeMillis: 200000 }] } });
	const r = await resolveLyrics(track, using(["paxsenix"]));
	assert.equal(r.lyrics, null);
	assert.ok(!urls.some((u) => u.includes("paxsenix")));
});
