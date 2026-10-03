// Retro: an amber CRT terminal (the Retro theme's scene; see scenes.js).
//
// The whole screen is the face of a tube. It bulges a little, its corners are rounded, and a black
// moulded bezel holds it; phosphor light spills onto the bezel and a window is reflected faintly in
// the glass. On the tube a log scrolls up, a line at a time: hex addresses, words made of dot-matrix
// glyphs, now and then a row of solid blocks. The top row is a status bar whose blocks fill as the song
// plays. Along the bottom a level meter of lit cells jumps with the beat. Over everything lie the
// scanlines, a slow bright refresh bar rolling down, a flicker and a little grain. The log keeps clear
// of the words: it dims where the lyrics and the song title are. On every new line the picture tears
// sideways for a moment; in a break the meter falls to a flat line and a thin trace sweeps the screen.

import { SCENE_HEAD } from "./scene-glsl.js";

export const RETRO_FRAG =
	SCENE_HEAD +
	`
float aspect;

float sdRound(vec2 p, vec2 b, float r) {
	vec2 d = abs(p) - b + r;
	return length(max(d, 0.)) + min(max(d.x, d.y), 0.) - r;
}

// one character cell: a 5x7 dot-matrix glyph (id picks which one), each dot a soft round spot of phosphor
float glyph(vec2 f, float id) {
	vec2 g = vec2(f.x * 6., f.y * 9.);
	vec2 c = floor(g);
	if (c.x > 4. || c.y < 1. || c.y > 7.) return 0.;
	float stem = c.x == 2. ? .16 : 0.;
	float mid = c.y == 4. ? .12 : 0.;
	float on = step(.56 - stem - mid, h21(c + id * vec2(7.13, 3.71)));
	return on * sst(.66, .16, length(g - c - .5));
}

// the log that scrolls up the screen: x is the glyph's ink, y how much text is there (for the bloom round it)
vec2 logLine(vec2 xy, float rowH, float scroll) {
	float cw = rowH * .56;
	float cxF = (xy.x + aspect * .5) / cw;
	float ryF = xy.y / rowH + scroll;
	float row = floor(ryF);
	vec2 f = vec2(fract(cxF), fract(ryF));
	float cx = floor(cxF);
	vec4 hr = h42(vec2(row, 3.7));
	if (hr.x < .08) {                                         // a row of solid blocks: a progress bar
		float on = step(1., cx) * step(cx, 10. + floor(hr.y * 30.));
		float cell = sst(.5, .4, abs(f.x - .5)) * sst(.46, .36, abs(f.y - .5));
		return vec2(on * cell * .9, on * .45);
	}
	if (hr.x < .22) return vec2(0.);                          // a blank row
	float gutter = hr.x > .7 ? 10. : 0.;                      // some rows begin with an address
	float indent = hr.w > .5 ? floor(hr.z * 3.) * 4. : 0.;
	float c = cx - gutter - indent;
	float lvl = .9;
	float present;
	if (cx < gutter) {
		present = step(cx, 7.);
		lvl = .6;
	} else {
		float len = 6. + 54. * hr.y * hr.y;
		float seg = 3. + floor(hr.w * 5.);
		present = step(0., c) * step(c, len) * (1. - step(seg - 1., mod(c + hr.z * 7., seg)));
		if (hr.y > .82 && c < 5.) lvl = 1.35;                 // a status word at the start of the line
	}
	if (present < .5) return vec2(0.);
	float id = h21(vec2(cx * 1.31 + 3., row * 7.7)) * 31.;
	return vec2(glyph(f, id) * lvl, .46 * lvl);
}

// how bright a lit phosphor reads: dim and deep, then the colour itself, then hot
vec3 phosphor(float i) {
	vec3 c = mix(uB, uA, sst(.05, .7, i));
	c = mix(c, uC, sst(.8, 1.7, i));
	return c * i;
}

void main() {
	aspect = uRes.x / uRes.y;
	vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1. - gl_FragCoord.y / uRes.y);
	float t = uTime;
	vec2 n = (uv - .5) * 2.;
	vec2 q = vec2((uv.x - .5) * aspect, uv.y - .5) * (1. + .03 * dot(n, n));   // the glass bulges

	// the tube: a rounded screen inside a bezel
	float mg = .03;
	vec2 ext = vec2(aspect * .5 - mg, .5 - mg);
	float d = sdRound(q, ext, .09);

	float flick = .965 + .035 * h11(floor(t * 30.));

	// every new line tears the picture sideways for a moment, a band at a height of its own
	float ty = .2 + .15 * uLineId;
	float tear = uLine * sst(.07, .0, abs(uv.y - ty));
	vec2 qc = q;
	qc.x += tear * (h11(floor(uv.y * 70.) + uLineId * 5.) - .5) * .09;
	qc.x += (h11(floor(uv.y * 240.) + floor(t * 20.)) - .5) * .0007;       // the picture shivers a hair
	qc.x += tear * .004;

	float calm = 1. - .72 * inText(uv);
	float rowH = .034;
	float sp = t * 1.15;
	float scroll = floor(sp) + sst(0., .22, fract(sp));                    // a line feed: the log jumps up a row

	// the log
	vec2 lg = logLine(vec2(qc.x, qc.y + .5), rowH, scroll);
	float cwid = rowH * .56;
	float li = (lg.x * .66 + lg.y * .08) * calm * (1. - .45 * uGap) * (1. + .12 * uBeat);

	// the status bar across the top: dim glyphs on a lit band, and blocks that fill as the song plays
	float bh = rowH * 1.3;
	float topY = q.y + ext.y;
	float band = sst(bh + .003, bh - .003, topY) * sst(-.003, .003, topY);
	float bx = (qc.x + aspect * .5) / cwid;
	float stx = glyph(vec2(fract(bx), fract(topY / (bh * .86))), floor(bx) * 1.7 + 5.) * step(.5, h21(vec2(floor(bx), 8.1))) * step(bx, 46.);
	float segf = (qc.x + ext.x) / (2. * ext.x);
	float pr = sst(bh, bh - .006, topY) * sst(bh - .016, bh - .01, topY) * (1. - step(.84, fract(bx)));
	li += band * (.16 + .34 * stx) * (1. + .3 * step(segf, uSong));
	li += pr * mix(.1, .75, step(segf, uSong));

	// the level meter along the bottom: cells that light up from the floor
	float ch = rowH * .52;
	float colW = rowH * 1.15;
	float mBot = ext.y - .045;
	float ex = (qc.x + aspect * .5) / colW;
	float eid = floor(ex);
	float nb = floor(aspect / colW);
	float u = eid / nb;
	float lvlF = fbm(vec2(eid * .27, t * 1.2)) * mix(1.35, .6, u) * 1.5 + uBeat * .3 * (1. - u) + uBar * .15 + .05;
	lvlF *= 1. - .92 * uGap;
	float lvlD = fbm(vec2(eid * .27, t * 1.2 - .5)) * mix(1.35, .6, u) * 1.5 + .05;
	lvlD *= 1. - .92 * uGap;
	float cells = 9.;
	float lit = floor(clamp(lvlF, 0., 1.) * cells);
	float peak = max(lit, floor(clamp(lvlD, 0., 1.) * cells));
	float jf = (mBot - qc.y) / ch;
	float j = floor(jf);
	vec2 mf = vec2(fract(ex), fract(jf));
	float inM = step(0., jf) * step(j, cells - 1.) * step(1., eid) * step(eid, nb - 1.);
	float cell = sst(.04, -.06, sdRound(mf - .5, vec2(.36, .34), .12));
	float cellOn = step(j, lit - 1.);
	float isPeak = step(abs(j - peak), .5) * step(lit + .5, peak);
	vec3 meter = (cellOn * phosphor(.35 + .55 * j / cells + .35 * step(j, lit - .5) * step(lit - .5, j)) + isPeak * phosphor(1.3) + (1. - cellOn) * (1. - isPeak) * uB * .05) * cell * inM * calm;
	meter *= .85;

	// a break: a thin trace sweeps across the screen
	float wy = .64 + .05 * sin(qc.x * 7. + t * 1.4) * sin(t * .7) + .012 * sin(qc.x * 31. - t * 5.);
	float trace = exp(-pow((uv.y - wy) * 190., 2.)) * (.5 + .5 * sst(.5, 1., sin(qc.x * 3. - t * 1.6) * .5 + .5));
	vec3 traceC = phosphor(1.) * trace * uGap * .6;

	vec3 screen = phosphor(li) * 1.0 + meter + traceC;

	// the tube lights its own glass a little: a lift towards the middle
	screen += uBase * .6 + uB * (.05 + .03 * uBeat) * sst(1.5, .0, dot(n, n));
	// the refresh bar rolling down, and a faint slow interference band
	float rb = uv.y - (fract(t / 8.5) * 1.5 - .25);
	screen += uB * .09 * exp(-rb * rb / .003);
	screen *= 1. + .035 * sin(uv.y * 9. - t * 2.1);
	// a line is struck: the tear is brighter
	screen += uA * tear * .12;
	// scanlines
	float sl = .5 + .5 * cos(gl_FragCoord.y * 3.14159);
	screen *= 1. - .34 * sl;
	// the tube dims towards its rim
	screen *= 1. - .62 * sst(-.26, .0, d);
	screen *= flick * (1. + .05 * uBeat);

	// the glass: a window reflected faintly, a streak of light across it
	vec2 gq = q - vec2(-aspect * .22, -.2);
	float win = sst(.08, -.04, sdRound(gq, vec2(.19, .12), .03));
	win *= 1. - .85 * (sst(.006, .0, abs(gq.x)) + sst(.006, .0, abs(gq.y + .02)));
	screen += vec3(.62, .72, .9) * win * .03;
	float streak = sst(.05, .0, abs(dot(q, normalize(vec2(1., .55))) + .16)) * sst(.0, -.1, d + .1);
	screen += vec3(.7, .78, .95) * streak * .012;

	// the bezel: black moulded plastic, a lit lip where it meets the glass, phosphor spilled on it
	vec3 bz = vec3(.014, .012, .01) + vec3(.012, .011, .01) * sst(.5, -.5, uv.y - .2);
	bz += uA * .05 * exp(-d * 24.) * (.5 + .5 * sst(1.8, 0., dot(n, n)));
	bz += vec3(.06, .055, .05) * sst(.016, .0, abs(d - .012)) * (.3 + .7 * sst(-.6, .6, -n.y - n.x * .5));
	bz *= 1. - .35 * sst(.0, .5, d);
	vec3 col = mix(bz, screen, sst(.004, -.004, d));
	col += uA * .06 * sst(.006, .0, abs(d + .004)) * .35;   // the glass's own edge catches the glow

	col += (h21(gl_FragCoord.xy + fract(uTime) * 91.) - .5) * .028;
	fragColor = vec4(clamp(col, 0., 1.), 1.);
}`;
