// Converters from provider-specific formats into the Lyrics model (see lrc.js).
// Pure functions (no network, no DOM) so they can be unit-tested in Node.
//
//   Musixmatch  macro.subtitles.get → richsync (word) / subtitles (line) / lyrics (plain)
//   NetEase     YRC (word) / LRC (line)
//   TTML        Apple-Music-style timed text (Unison), incl. background vocals

import { parseLRC, parsePlain, finalizeSynced, hasContent } from "./lrc.js";

const byTime = (a, b) => a.time - b.time;

/**
 * Providers sometimes give syllables/words without the spaces between them. Re-attach
 * whitespace by walking the full line text alongside the word pieces.
 */
export function alignWordsToText(words, fullText) {
	if (!fullText || !words.length) return words;
	const joined = words.map((w) => w.text).join("");
	if (joined.replace(/\s+/g, " ").trim() === fullText.replace(/\s+/g, " ").trim()) return words;
	let pos = 0;
	for (const w of words) {
		const core = w.text.trim();
		const at = fullText.indexOf(core, pos);
		if (at < 0) continue;
		pos = at + core.length;
		let ws = "";
		while (pos < fullText.length && /\s/.test(fullText[pos])) ws += fullText[pos++];
		w.text = core + (ws ? " " : "");
	}
	return words;
}

// ---------------------------------------------------------------------------
// Musixmatch
// ---------------------------------------------------------------------------

/** richsync_body rows: [{ ts, te, x, l: [{ c, o }] }] — seconds; o is relative to ts. */
export function fromRichsync(rows, duration) {
	const lines = rows.map((r) => {
		const t0 = Number(r.ts) * 1000;
		const words = [];
		for (const piece of r.l || []) {
			const c = String(piece.c ?? "");
			// Spaces (and untimed pieces) attach to the previous word.
			if (typeof piece.o !== "number" || !c.trim()) {
				if (words.length) words[words.length - 1].text += c;
				continue;
			}
			words.push({ time: Math.round(t0 + piece.o * 1000), end: null, text: c });
		}
		const te = Number(r.te) * 1000;
		if (words.length && te > words[words.length - 1].time) words[words.length - 1].end = Math.round(te);
		return { time: Math.round(t0), text: r.x ?? words.map((w) => w.text).join(""), words: words.length ? words : null };
	});
	return finalizeSynced(lines.sort(byTime), {}, duration);
}

/**
 * Map a Musixmatch macro_calls object to a provider Result.
 * status "auth" means the user token must be renewed.
 */
export function fromMusixmatch(calls, duration) {
	const matcher = calls?.["matcher.track.get"]?.message;
	const code = matcher?.header?.status_code;
	if (code === 404) return { status: "notfound" };
	if (code === 401) return { status: "auth", message: matcher?.header?.hint || "unauthorized" };
	if (code !== 200) return { status: "error", message: `Musixmatch: ${matcher?.header?.hint || code || "bad response"}` };

	const track = matcher.body?.track || {};
	if (track.instrumental) return { status: "notfound", instrumental: true };
	const lyricsMsg = calls["track.lyrics.get"]?.message;
	if (lyricsMsg?.body?.lyrics?.restricted) return { status: "notfound" };

	const rich = calls["track.richsync.get"]?.message;
	if (rich?.header?.status_code === 200 && rich.body?.richsync?.richsync_body) {
		try {
			const l = fromRichsync(JSON.parse(rich.body.richsync.richsync_body), duration);
			if (hasContent(l)) return { status: "found", lyrics: l };
		} catch {
			/* fall through to line sync */
		}
	}

	const sub = calls["track.subtitles.get"]?.message?.body?.subtitle_list?.[0]?.subtitle?.subtitle_body;
	if (sub) {
		// The mobile API returns the "mxm" JSON format; the desktop API returns LRC text.
		try {
			const l = /^\s*\[/.test(sub) && !/^\s*\[\s*\{/.test(sub)
				? parseLRC(sub, { duration })
				: finalizeSynced(JSON.parse(sub).map((r) => ({ time: Math.round(Number(r.time?.total) * 1000), text: r.text || "" })).sort(byTime), {}, duration);
			if (hasContent(l) && l.synced) return { status: "found", lyrics: l };
		} catch {
			/* fall through to plain */
		}
	}

	const plain = lyricsMsg?.body?.lyrics?.lyrics_body;
	if (plain) {
		// Strip the "******* This Lyrics is NOT for Commercial use *******" footer.
		const l = parsePlain(plain.replace(/\n*\*{5,}[\s\S]*$/, ""));
		if (hasContent(l)) return { status: "found", lyrics: l };
	}
	return { status: "notfound" };
}

// ---------------------------------------------------------------------------
// NetEase
// ---------------------------------------------------------------------------

// Credit lines NetEase puts at the top (作词 / 作曲 / 制作人 … : name). Same list lyrics-plus uses.
const NETEASE_CREDITS = new RegExp(
	`^(${[
		"\\s?作?\\s*词|\\s?作?\\s*曲|\\s?编\\s*曲?|\\s?监\\s*制?",
		".*编写|.*和音|.*和声|.*合声|.*提琴|.*录|.*工程|.*工作室|.*设计|.*剪辑|.*制作|.*发行|.*出品|.*后期|.*混音|.*缩混",
		"原唱|翻唱|题字|文案|海报|古筝|二胡|钢琴|吉他|贝斯|笛子|鼓|弦乐",
		"lrc|publish|vocal|guitar|program|produce|write|mix",
	].join("|")}).*(:|：)`,
	"i",
);
export const isNeteaseCredit = (text) => NETEASE_CREDITS.test(String(text || "").trim());
export const isNeteaseInstrumental = (text) => /纯音乐\s*[,，]?\s*请欣赏/.test(String(text || ""));

/** YRC: "[lineStart,lineDur](wordStart,wordDur,0)word(…)…" — absolute ms. JSON lines are credits. */
export function parseYrc(text, duration) {
	const lines = [];
	for (const raw of String(text || "").split(/\r?\n/)) {
		const m = raw.match(/^\[(\d+),(\d+)\](.*)$/);
		if (!m) continue;
		const parts = m[3].split(/\((\d+),(\d+),-?\d+\)/);
		const words = [];
		for (let i = 1; i + 1 < parts.length; i += 3) {
			const t = Number(parts[i]);
			const d = Number(parts[i + 1]);
			const txt = parts[i + 2] ?? "";
			if (!txt) continue;
			if (!txt.trim()) {
				if (words.length) words[words.length - 1].text += txt;
				continue;
			}
			words.push({ time: t, end: t + d, text: txt });
		}
		const plain = (words.length ? words.map((w) => w.text).join("") : parts[0]).replace(/\s+/g, " ").trim();
		if (!plain || isNeteaseCredit(plain)) continue;
		lines.push({ time: Number(m[1]), text: plain, words: words.length ? words : null });
	}
	if (!lines.length) return null;
	return finalizeSynced(lines.sort(byTime), {}, duration);
}

/** NetEase LRC with credit lines removed. */
export function parseNeteaseLrc(text, duration) {
	const cleaned = String(text || "")
		.split(/\r?\n/)
		.filter((l) => !isNeteaseCredit(l.replace(/^(\[[^\]]*\])+/, "")))
		.join("\n");
	return parseLRC(cleaned, { duration });
}

// ---------------------------------------------------------------------------
// TTML (Apple Music style; served by Unison)
// ---------------------------------------------------------------------------

/** "1:02:03.45" | "02:03.450" | "12.5" | "12.5s" | "1250ms" → ms */
export function parseClock(v) {
	if (v == null || v === "") return null;
	const s = String(v).trim();
	let m;
	if ((m = s.match(/^([\d.]+)ms$/))) return Math.round(Number(m[1]));
	if ((m = s.match(/^([\d.]+)s$/))) return Math.round(Number(m[1]) * 1000);
	const parts = s.split(":").map(Number);
	if (parts.some((n) => !Number.isFinite(n))) return null;
	let secs = 0;
	for (const p of parts) secs = secs * 60 + p;
	return Math.round(secs * 1000);
}

function decodeEntities(s) {
	return s
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function attrs(tag) {
	const out = {};
	for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1].replace(/^.*:/, "")] = m[2];
	return out;
}

const stripParens = (s) => s.replace(/^\s*\(\s*/, "").replace(/\s*\)\s*$/, "");

/**
 * Small regex-based TTML reader (no DOMParser needed). Handles <p begin end> lines,
 * timed <span> words/syllables (with or without spaces between them), and
 * <span ttm:role="x-bg"> background vocals. Untimed TTML becomes plain text.
 */
export function parseTTML(xml, duration) {
	const body = String(xml || "");
	const lines = [];
	let anyTimed = false;
	for (const pm of body.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
		const pa = attrs(pm[1]);
		const buckets = { main: { words: [], text: "" }, bg: { words: [], text: "" } };
		const stack = []; // open spans: { begin, end, bg }
		for (const tm of pm[2].matchAll(/<(\/?)span\b([^>]*?)(\/?)>|<br\s*\/?>|([^<]+)/g)) {
			if (tm[1] === "/") {
				stack.pop();
				continue;
			}
			if (tm[0].startsWith("<span")) {
				if (tm[3] === "/") continue; // self-closing, no content
				const a = attrs(tm[2]);
				const parent = stack[stack.length - 1];
				stack.push({ begin: parseClock(a.begin), end: parseClock(a.end), bg: a.role === "x-bg" || !!parent?.bg });
				continue;
			}
			if (tm[0].startsWith("<br")) continue;
			const text = decodeEntities(tm[4] || "");
			const ctx = stack[stack.length - 1];
			const bucket = ctx?.bg ? buckets.bg : buckets.main;
			bucket.text += text;
			if (ctx && ctx.begin != null && text.trim()) {
				anyTimed = true;
				bucket.words.push({ time: ctx.begin, end: ctx.end, text });
			} else if (bucket.words.length) {
				bucket.words[bucket.words.length - 1].text += text; // whitespace between spans
			}
		}
		const norm = (s) => s.replace(/\s+/g, " ").trim();
		const mainText = norm(buckets.main.text);
		const bgText = norm(stripParens(buckets.bg.text));
		const begin = parseClock(pa.begin) ?? buckets.main.words[0]?.time ?? buckets.bg.words[0]?.time ?? null;
		if (begin != null) anyTimed = true;
		if (!mainText && !bgText) continue;
		const mainWords = buckets.main.words.length ? alignWordsToText(buckets.main.words, mainText) : null;
		let bgWords = null;
		if (buckets.bg.words.length) {
			bgWords = buckets.bg.words;
			bgWords[0].text = bgWords[0].text.replace(/^\s*\(/, "");
			bgWords[bgWords.length - 1].text = bgWords[bgWords.length - 1].text.replace(/\)\s*$/, "");
		}
		lines.push({ time: begin, text: mainText, words: mainWords, bg: bgText ? { text: bgText, words: bgWords } : null });
	}
	if (!lines.length) return null;
	if (!anyTimed || lines.every((l) => l.time == null)) return parsePlain(lines.map((l) => l.text).join("\n"));
	return finalizeSynced(lines.filter((l) => l.time != null).sort(byTime), {}, duration);
}

// ---------------------------------------------------------------------------
// Paxsenix (Apple Music lyrics as JSON)
// ---------------------------------------------------------------------------

/**
 * /apple-music/lyrics response: { type: "Syllable"|"Line"|…, content: [{ timestamp, endtime,
 * text: [{ text, timestamp, endtime, part }], backgroundText: [...], oppositeTurn }] } (ms).
 * `part: true` = this syllable continues into the next one (no space between them).
 */
export function fromPaxsenixApple(json, duration) {
	const content = json?.content;
	if (!Array.isArray(content) || !content.length) return null;
	const type = String(json.type || "").toLowerCase();
	const toWords = (parts) =>
		(parts || [])
			.filter((t) => t && String(t.text ?? "").length && Number.isFinite(Number(t.timestamp)))
			.map((t) => ({ time: Number(t.timestamp), end: Number(t.endtime) || null, text: String(t.text).trim() + (t.part ? "" : " ") }));
	const joinText = (words) => words.map((w) => w.text).join("").replace(/\s+/g, " ").trim();

	if (!content.some((l) => Number.isFinite(Number(l.timestamp)))) {
		return parsePlain(content.map((l) => joinText(toWords(l.text)) || (l.text || []).map((t) => t.text).join(" ")).join("\n"));
	}
	const wordSynced = type === "syllable" || type === "word";
	const lines = content.map((l) => {
		const main = toWords(l.text);
		const bg = toWords(l.backgroundText);
		const bgText = stripParens(joinText(bg));
		if (bg.length) {
			bg[0].text = bg[0].text.replace(/^\s*\(/, "");
			bg[bg.length - 1].text = bg[bg.length - 1].text.replace(/\)\s*$/, "");
		}
		return {
			time: Number(l.timestamp) || main[0]?.time || 0,
			text: joinText(main),
			words: wordSynced && main.length ? main : null,
			bg: bgText ? { text: bgText, words: wordSynced && bg.length ? bg : null } : null,
			opposite: !!l.oppositeTurn,
		};
	});
	return finalizeSynced(lines.sort(byTime), {}, duration);
}

/** Unison /lyrics response → Lyrics */
export function fromUnison(data, duration) {
	const format = String(data?.format || "").toLowerCase();
	if (format === "ttml") return parseTTML(data.lyrics, duration);
	if (format === "lrc") return parseLRC(data.lyrics, { duration });
	if (format === "plain") return parsePlain(data.lyrics);
	return null;
}
