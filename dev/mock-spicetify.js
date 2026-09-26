// Minimal Spicetify mock for previewing the extension in a normal browser.
// Simulates Player (clock, play/pause, seek, next/prev + events), LocalStorage,
// CosmosAsync (Spotify lyrics endpoint), Topbar/Playbar buttons and colorExtractor.
// Sample lyrics below are original placeholder text.

(() => {
	const art = (a, b) =>
		"data:image/svg+xml," +
		encodeURIComponent(
			`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="640" height="640" fill="url(#g)"/><circle cx="420" cy="220" r="150" fill="${b}" opacity=".6"/><circle cx="200" cy="460" r="110" fill="${a}" opacity=".7"/></svg>`,
		);

	// Timed lines: [startMs, text, msPerWord]. Each provider below serves them in its own format.
	const HARBOR = [
		[4200, "Paper lanterns drifting over the harbor", 520],
		[8400, "Every window hums a different tune", 560],
		[12600, "I kept the porch light on for you", 450],
		[16500, "Counting ferries till the morning comes", 560],
		[29000, "Salt on the railing, sugar in the tea", 440],
		[33200, "Half a map and nowhere left to be", 430],
		[37400, "Hold the line, the tide is turning slow", 480],
		[41600, "Follow the lanterns home", 1150], // long-held words → letter wave
		[46000, "Follow the lanterns, follow them home", 600],
	];
	const NEON = [
		[1000, "Static in the streetlights", 450],
		[4000, "Thunder made of neon signs", 420],
		[7200, "Run with me through the city rain", 380],
		[10600, "We are electric weather", 520],
		[14000, "Every heartbeat on the wire", 450],
		[17300, "Glowing like a brand new day", 430],
		[20600, "We are electric weather", 520],
		[28000, "Hold on hold on hold on", 400],
	];
	const ECHO = [
		// 5th field: TTML agent, so this track is a duet (v1 lead, v2 second singer, v1000 both).
		[1500, "Shout into the canyon", 500, "echo, echo", "v1"],
		[5200, "Hear it coming back to me", 420, "back to me", "v2"],
		[9000, "Every word a little softer", 430, null, "v1000"],
		[12800, "Till it fades into the sea", 520, "into the sea", "v1"],
	];
	const wordsOf = (start, text, step) => text.split(" ").map((w, i, arr) => ({ t: start + i * step, d: step, w: w + (i < arr.length - 1 ? " " : "") }));

	// Musixmatch richsync body (seconds; word offsets relative to line start).
	const richsync = (lines) =>
		JSON.stringify(
			lines.map(([t, text, step]) => {
				const ws = wordsOf(t, text, step);
				const l = [];
				ws.forEach((x) => {
					l.push({ c: x.w.trim(), o: (x.t - t) / 1000 });
					if (x.w.endsWith(" ")) l.push({ c: " " });
				});
				return { ts: t / 1000, te: (t + ws.length * step) / 1000, x: text, l };
			}),
		);
	// NetEase YRC: [lineStart,lineDur](wordStart,wordDur,0)word…  (absolute ms) + a credit line.
	const yrc = (lines) =>
		["[0,900](0,900,0)作曲 : Mock Composer"]
			.concat(lines.map(([t, text, step]) => `[${t},${text.split(" ").length * step}]` + wordsOf(t, text, step).map((x) => `(${x.t},${x.d},0)${x.w}`).join("")))
			.join("\n");
	// TTML (Unison) with background vocals in <span ttm:role="x-bg">.
	const clock = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${((ms % 60000) / 1000).toFixed(3).padStart(6, "0")}`;
	const ttml = (lines) =>
		`<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><head><metadata><ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/><ttm:agent type="group" xml:id="v1000"/></metadata></head><body><div>` +
		lines
			.map(([t, text, step, bg, agent]) => {
				const ws = wordsOf(t, text, step);
				const end = t + ws.length * step;
				const main = ws.map((x) => `<span begin="${clock(x.t)}" end="${clock(x.t + x.d)}">${x.w.trim()}</span>`).join(" ");
				const back = bg ? `<span ttm:role="x-bg">` + wordsOf(end, bg, 450).map((x, i, a) => `<span begin="${clock(x.t)}" end="${clock(x.t + x.d)}">${i === 0 ? "(" : ""}${x.w.trim()}${i === a.length - 1 ? ")" : ""}</span>`).join(" ") + `</span>` : "";
				return `<p begin="${clock(t)}" end="${clock(end + (bg ? 1400 : 0))}"${agent ? ` ttm:agent="${agent}"` : ""}>${main}${back}</p>`;
			})
			.join("") +
		`</div></body></tt>`;

	// Track 4: unsynced plain text from LRCLIB.
	const T4_PLAIN = "Morning on the balcony\nCoffee going cold\nPigeons reading headlines\nThat nobody has told\n\nSlow down, slow down\nThe day will wait for you\nSlow down, slow down\nThere's nothing left to do\n\nAfternoon in the garden\nShadows getting long\nHumming half a melody\nOf a someday song\n\nSlow down, slow down\nThe day will wait for you";

	const TRACKS = [
		{ uri: "spotify:track:mock1", name: "Harbor Lights", artist: "Mock Artist", album: "Preview Sessions", dur: 52000, img: art("#ff7a59", "#5b2a86") },
		{ uri: "spotify:track:mock2", name: "Neon Weather", artist: "The Placeholder Band", album: "Electric", dur: 33000, img: art("#00c2ff", "#1b1464") },
		{ uri: "spotify:track:mock3", name: "No Words Here", artist: "Silent Type", album: "Quiet", dur: 30000, img: art("#2ecc71", "#0b3d2e") },
		{ uri: "spotify:track:mock4", name: "Slow Down", artist: "Lazy Sunday", album: "Plain Text", dur: 60000, img: art("#f5c451", "#7a3e00") },
		{ uri: "spotify:track:mock5", name: "Echo Chamber", artist: "Canyon Choir", album: "Reverb", dur: 20000, img: art("#ff5fa2", "#2a1450") },
	];

	const listeners = {};
	const state = { idx: 0, playing: true, posAt: 0, tsAt: Date.now(), shuffle: false, repeat: 0, heart: false, volume: 0.7, mute: false };

	function buildData() {
		const t = TRACKS[state.idx];
		return {
			item: {
				uri: t.uri,
				name: t.name,
				artists: [{ name: t.artist }],
				album: { name: t.album, images: [{ url: t.img, width: 640 }] },
				duration: { milliseconds: t.dur },
				metadata: { title: t.name, artist_name: t.artist, album_title: t.album },
			},
			isPaused: !state.playing,
			isBuffering: false,
			positionAsOfTimestamp: state.posAt,
			timestamp: state.tsAt,
			duration: t.dur,
			speed: 1,
		};
	}
	const dispatch = (type, data) => (listeners[type] || []).forEach((fn) => fn({ type, data }));
	const pos = () => Math.min(TRACKS[state.idx].dur, state.posAt + (state.playing ? Date.now() - state.tsAt : 0));
	function commit(ev) {
		Player.data = buildData();
		if (ev) dispatch(ev, Player.data);
	}
	function go(idx) {
		state.idx = (idx + TRACKS.length) % TRACKS.length;
		state.posAt = 0;
		state.tsAt = Date.now();
		commit("songchange");
	}

	const Player = {
		data: null,
		addEventListener: (t, fn) => (listeners[t] ||= []).push(fn),
		getProgress: pos,
		getDuration: () => TRACKS[state.idx].dur,
		isPlaying: () => state.playing,
		seek: (ms) => {
			state.posAt = Math.max(0, Math.min(ms, TRACKS[state.idx].dur));
			state.tsAt = Date.now();
			commit("onprogress");
		},
		togglePlay: () => {
			state.posAt = pos();
			state.tsAt = Date.now();
			state.playing = !state.playing;
			commit("onplaypause");
		},
		next: () => go(state.idx + 1),
		// shuffle / repeat / like / volume (for the player controls)
		getShuffle: () => state.shuffle,
		toggleShuffle: () => (state.shuffle = !state.shuffle),
		getRepeat: () => state.repeat,
		toggleRepeat: () => (state.repeat = (state.repeat + 1) % 3),
		getHeart: () => state.heart,
		toggleHeart: () => (state.heart = !state.heart),
		getVolume: () => state.volume,
		setVolume: (v) => ((state.volume = v), (state.mute = false)),
		getMute: () => state.mute,
		toggleMute: () => (state.mute = !state.mute),
		back: () => go(state.idx - 1),
	};
	commit();

	// Auto-advance + ~1s progress events like the real client.
	setInterval(() => {
		if (state.playing && pos() >= TRACKS[state.idx].dur) {
			if (window.mock.autoAdvance) go(state.idx + 1);
			else Player.seek(0); // loop the track (like repeat-one)
		}
		else if (state.playing) dispatch("onprogress", pos());
	}, 1000);

	// CosmosAsync behaves like Spicetify on Spotify 1.3.x: only Spotify's own hosts resolve,
	// anything else throws "Resolver not found!" (which is why the extension uses fetch()).
	const ok = (body) => ({ message: { header: { status_code: 200 }, body } });
	const cosmosGet = async (url) => {
		await new Promise((r) => setTimeout(r, 350));
		if (!url.includes("spotify.com")) throw new Error("Resolver not found!");
		if (url.includes("color-lyrics") && url.includes("mock1")) {
			return { lyrics: { syncType: "LINE_SYNCED", lines: [...HARBOR.map(([t, w]) => ({ startTimeMs: String(t), words: w })), { startTimeMs: "20800", words: "♪" }].sort((a, b) => a.startTimeMs - b.startTimeMs) } };
		}
		return { code: 404, error: "Not Found", message: "Failed to fetch" };
	};

	// fetch(): Musixmatch (token + richsync via the CORS proxy),
	// NetEase (via the proxy), LRCLIB (track 4 plain text), Unison (track 5 TTML).
	const realFetch = window.fetch.bind(window);
	const delay = (ms) => new Promise((r) => setTimeout(r, ms));
	window.fetch = async (url, opts) => {
		const u = decodeURIComponent(String(url));
		const body = (status, json) => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
		const proxied = u.startsWith("https://cors-proxy.spicetify.app/");
		if (proxied && u.includes("musixmatch.com/ws/1.1/token.get")) return body(200, ok({ user_token: "mock-token-".padEnd(54, "0a") }));
		if (proxied && u.includes("apic-appmobile.musixmatch.com")) {
			await delay(1200); // slower: shows line sync first, then the word-sync upgrade
			if (!u.includes("Neon")) return body(200, ok({ macro_calls: { "matcher.track.get": { message: { header: { status_code: 404 } } } } }));
			const track = { track_name: "Neon Weather", artist_name: "The Placeholder Band", track_length: 33, has_richsync: 1 };
			return body(200, ok({ macro_calls: { "matcher.track.get": ok({ track }), "track.richsync.get": ok({ richsync: { richsync_body: richsync(NEON) } }) } }));
		}
		if (proxied && u.includes("music.163.com/api/search")) {
			await delay(300);
			return body(200, u.includes("Harbor") ? { code: 200, result: { songs: [{ id: 101, name: "Harbor Lights", artists: [{ name: "Mock Artist" }], duration: 52000 }] } } : { code: 200, result: { songs: [] } });
		}
		if (proxied && u.includes("music.163.com/api/song/lyric")) {
			await delay(900);
			return body(200, { code: 200, lrc: { lyric: "" }, yrc: { lyric: yrc(HARBOR) } });
		}
		if (u.includes("lrclib.net")) {
			await delay(400);
			if (u.includes("Slow")) return body(200, { syncedLyrics: null, plainLyrics: T4_PLAIN });
			return u.includes("/search") ? body(200, []) : body(404, {});
		}
		if (u.includes("unison.boidu.dev")) {
			await delay(300);
			if (u.includes("Echo")) return body(200, { success: true, data: { format: "ttml", lyrics: ttml(ECHO), syncType: "WORD" } });
			return body(404, { success: false, code: "NOT_FOUND" });
		}
		return realFetch(url, opts);
	};

	const topbar = document.getElementById("mock-topbar");
	class Button {
		constructor(label, icon, onClick) {
			this.element = document.createElement("button");
			this.element.className = "mock-btn";
			this.element.title = label;
			this.element.innerHTML = icon;
			this.element.onclick = () => onClick(this);
			topbar.append(this.element);
			this._active = false;
		}
		set active(v) {
			this._active = v;
			this.element.classList.toggle("active", v);
		}
		get active() {
			return this._active;
		}
	}

	window.Spicetify = {
		Player,
		LocalStorage: {
			get: (k) => localStorage.getItem(k),
			set: (k, v) => localStorage.setItem(k, v),
			remove: (k) => localStorage.removeItem(k),
		},
		CosmosAsync: { get: cosmosGet },
		Topbar: { Button },
		Playbar: { Button },
		Config: { version: "mock" },
		// Queue in Spicetify.Queue's shape (a delimiter first, like the real one sometimes has).
		get Queue() {
			const n = TRACKS[(state.idx + 1) % TRACKS.length];
			return {
				nextTracks: [
					{ contextTrack: { uri: "spotify:delimiter", metadata: {} }, provider: "context" },
					{ contextTrack: { uri: n.uri, metadata: { title: n.name, artist_name: n.artist, image_url: n.img } }, provider: "context" },
				],
			};
		},
		colorExtractor: async (uri) => {
			const c = { mock1: ["#ff7a59", "#5b2a86", "#ffc4a8"], mock2: ["#00c2ff", "#1b1464", "#a8e6ff"], mock3: ["#2ecc71", "#0b3d2e", "#b4f5cc"], mock4: ["#f5c451", "#7a3e00", "#ffe7a8"], mock5: ["#ff5fa2", "#2a1450", "#ffc2dc"] }[uri.split(":")[2]];
			return { VIBRANT: c[0], DARK_VIBRANT: c[1], LIGHT_VIBRANT: c[2] };
		},
	};

	// Transport controls for the preview page.
	window.mock = { Player, state, pos, TRACKS, autoAdvance: !/[?&]loop\b/.test(location.search) };
})();
