#!/usr/bin/env node
// Zero-dependency bundler for the extension.
//
// Spicetify loads each extension as ONE classic script, so the ES modules in src/ are
// concatenated (in dependency order) into a single IIFE:
//   - `import … from "./x.js"` lines are removed (everything shares one scope),
//   - `export` keywords are stripped,
//   - "./styles.js" is virtual: it becomes `const CSS = "<the stylesheets>"`: src/styles.css, then
//     src/glass.css (the liquid-glass kit shared by the glass themes), then src/themes/*.css in
//     alphabetical order.
// Rule for src/: top-level names must be unique across modules (checked below).
//
// Usage:
//   node build.mjs                       → dist/aurora-lyrics.js
//   node build.mjs --out <dir>           → also copy the result into <dir>
//   node build.mjs --watch [--out <dir>] → rebuild on changes in src/

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, existsSync, watch } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "src");
const NAME = "aurora-lyrics.js";
const OUT = join(ROOT, "dist", NAME);

// Dependency order (a module must come after everything it imports).
const ORDER = [
	"util.js",
	"storage.js",
	"translate.js",
	"settings.js",
	"lrc.js",
	"formats.js",
	"cache.js",
	"player.js",
	"beats.js",
	"stats.js",
	"scene-glsl.js",
	"scene-karaoke.js",
	"scene-gothic.js",
	"scene-blackmetal.js",
	"scene-lounge.js",
	"scene-ocean.js",
	"scene-retro.js",
	"scenes.js",
	"glass.js",
	"net.js",
	"sources.js",
	"providers.js",
	"icons.js",
	"styles.js", // virtual, generated from styles.css
	"view.js",
	"media.js",
	"panel.js",
	"share.js",
	"tabs.js",
	"overlay.js",
	"npv.js",
	"mini.js",
	"launcher.js",
	"main.js",
];

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const extraOut = outIdx >= 0 ? args[outIdx + 1] : null;
const watchMode = args.includes("--watch");

/** The stylesheets, in cascade order: the base, the shared glass kit, then one file per remade theme. */
function stylesheets() {
	const themes = join(SRC, "themes");
	const extra = existsSync(themes) ? readdirSync(themes).filter((f) => f.endsWith(".css")).sort().map((f) => join("themes", f)) : [];
	return ["styles.css", "glass.css", ...extra].filter((f) => existsSync(join(SRC, f)));
}

// Themes whose rules are split off the base stylesheet and only injected while that theme is in use.
const THEME_IDS = ["aurora", "neon", "minimal", "karaoke", "gothic", "blackmetal", "lounge", "retro", "synthwave", "zen", "sunset", "midnight", "vaporwave", "ocean", "rain"];

/** Top-level statements of a (comment-free) stylesheet: { prelude, text }. */
function statements(css) {
	const out = [];
	let depth = 0;
	let start = 0;
	let quote = "";
	for (let i = 0; i < css.length; i++) {
		const c = css[i];
		if (quote) {
			if (c === "\\") i++;
			else if (c === quote) quote = "";
			continue;
		}
		if (c === '"' || c === "'") quote = c;
		else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) {
			const text = css.slice(start, i + 1).trim();
			out.push({ prelude: text.slice(0, text.indexOf("{")).trim(), text });
			start = i + 1;
		} else if (c === ";" && depth === 0) {
			const text = css.slice(start, i + 1).trim(); // e.g. @import / @charset
			if (text) out.push({ prelude: text, text });
			start = i + 1;
		}
	}
	return out;
}

/** Selectors of a rule, split on top-level commas (not the ones inside :is() / :not()). */
function selectorList(prelude) {
	const parts = [];
	let depth = 0;
	let cur = "";
	for (const c of prelude) {
		if (c === "(") depth++;
		else if (c === ")") depth--;
		if (c === "," && depth === 0) (parts.push(cur), (cur = ""));
		else cur += c;
	}
	return parts.concat(cur).map((s) => s.trim()).filter(Boolean);
}

/**
 * Split the stylesheet into the base (always injected) and one chunk per theme. A rule goes to a theme when every
 * one of its selectors names that theme (data-fx / data-look), a @keyframes when only that theme's rules use it.
 * Order is kept within each part; a theme's chunk is injected after the base, as the theme files already were.
 */
function splitThemes(css) {
	const all = statements(css);
	const themeOf = (st) => {
		if (st.prelude.startsWith("@")) return null;
		let theme = null;
		for (const sel of selectorList(st.prelude)) {
			const ids = new Set([...sel.matchAll(/data-(?:fx|look)="(\w+)"/g)].map((m) => m[1]));
			if (ids.size !== 1) return null;
			const [id] = ids;
			if (!THEME_IDS.includes(id) || (theme && theme !== id)) return null;
			theme = id;
		}
		return theme;
	};
	const owner = all.map(themeOf);
	// keyframes: who uses each name
	const users = new Map();
	all.forEach((st, i) => {
		if (st.prelude.startsWith("@keyframes")) return;
		for (const m of st.text.matchAll(/\baur-[\w-]+/g)) {
			if (!users.has(m[0])) users.set(m[0], new Set());
			users.get(m[0]).add(owner[i] || "_base");
		}
	});
	all.forEach((st, i) => {
		const kf = /^@keyframes\s+([\w-]+)/.exec(st.prelude);
		if (!kf) return;
		const u = users.get(kf[1]);
		if (u && u.size === 1 && !u.has("_base")) owner[i] = [...u][0];
	});
	const base = [];
	const themes = {};
	all.forEach((st, i) => (owner[i] ? (themes[owner[i]] ||= []).push(st.text) : base.push(st.text)));
	return { base: base.join("\n"), themes: Object.fromEntries(Object.entries(themes).map(([k, v]) => [k, v.join("\n")])) };
}

function transform(file, code) {
	const stripped = code
		.replace(/^import\s[^;]*?from\s+["'][^"']+["'];?[ \t]*\r?\n/gm, "")
		.replace(/^export\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/gm, "");
	const leftover = stripped.match(/^\s*(import|export)\s.*$/m);
	if (leftover) throw new Error(`${file}: unsupported module syntax: ${leftover[0].trim()}`);
	return stripped;
}

function build() {
	const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8").replace(/^﻿/, ""));
	const seen = new Map();
	const parts = [];

	for (const file of ORDER) {
		let code;
		if (file === "styles.js") {
			// Light minification: drop comments and indentation (keeps the bundle readable-ish).
			const css = stylesheets()
				.map((f) => readFileSync(join(SRC, f), "utf8"))
				.join("\n")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/\s*\n\s*/g, "\n")
				.replace(/\n+/g, "\n")
				.trim();
			const { base, themes } = splitThemes(css);
			code = `const CSS = ${JSON.stringify(base)};\n// Each theme's own rules, injected only while that theme is in use (overlay.js).\nconst THEME_CSS = ${JSON.stringify(themes)};\n`;
			const kb = (s) => (s.length / 1024).toFixed(0);
			console.log(`[build] css: base ${kb(base)} KB, themes ${Object.entries(themes).map(([k, v]) => `${k} ${kb(v)}`).join(", ")} KB`);
		} else {
			code = transform(file, readFileSync(join(SRC, file), "utf8"));
		}
		// Duplicate top-level declarations would silently break the shared scope.
		for (const m of code.matchAll(/^(?:const|let|var|class|(?:async\s+)?function\*?)\s+([A-Za-z_$][\w$]*)/gm)) {
			if (seen.has(m[1])) throw new Error(`Top-level name "${m[1]}" is declared in both ${seen.get(m[1])} and ${file}`);
			seen.set(m[1], file);
		}
		parts.push(`// ---- ${file} ${"-".repeat(Math.max(0, 70 - file.length))}\n${code.trim()}\n`);
	}

	const out = `// Aurora Lyrics v${pkg.version} — full-screen animated lyrics for Spicetify
// Built from src/ by build.mjs — edit the sources, not this file.
// NAME: Aurora Lyrics
// AUTHOR: ${pkg.author || "you"}
// DESCRIPTION: ${pkg.description}

(function fullscreenAnimatedLyrics() {
"use strict";

${parts.join("\n")}
main().catch((e) => console.error("[aurora-lyrics] failed to start", e));
})();
`;

	mkdirSync(dirname(OUT), { recursive: true });
	writeFileSync(OUT, out);
	execFileSync(process.execPath, ["--check", OUT], { stdio: "inherit" }); // syntax check
	if (extraOut) {
		mkdirSync(extraOut, { recursive: true });
		copyFileSync(OUT, join(extraOut, NAME));
	}
	console.log(`[build] ${OUT} (${(out.length / 1024).toFixed(1)} KB)${extraOut ? ` → ${join(extraOut, NAME)}` : ""}`);
}

try {
	build();
} catch (e) {
	console.error(`[build] ${e.message}`);
	if (!watchMode) process.exit(1);
}

if (watchMode) {
	let t = 0;
	console.log("[build] watching src/ …");
	watch(SRC, { recursive: true }, () => {
		clearTimeout(t);
		t = setTimeout(() => {
			try {
				build();
			} catch (e) {
				console.error(`[build] ${e.message}`);
			}
		}, 120);
	});
}
