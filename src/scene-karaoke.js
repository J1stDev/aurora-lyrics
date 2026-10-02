// Karaoke: a KTV room (the Karaoke theme's scene; see scenes.js).
//
// A dark room full of party light. Six moving-head spotlights hang along the top and sweep slowly
// through the haze, each a cone with a bright core. A mirror ball hangs at the top right: its tiles
// turn, each reflecting a different colour and flashing now and then, and the light it throws is
// scattered over the room as a drift of small bright spots. In the centred layouts (Captions, Stage)
// a row of glass equaliser columns stands either side of the cover. On every beat the spots and the
// columns jump, on the bar the beams swing and widen, on every new line a different beam flares, and
// in a break the room dims and slows.

import { SCENE_HEAD } from "./scene-glsl.js";

export const KARAOKE_FRAG =
	SCENE_HEAD +
	`
float aspect;

// one moving-head beam: from s, along the angle a (0 = straight down), half-angle h, fading over len
float beam(vec2 p, vec2 s, float a, float h, float len) {
	vec2 dir = vec2(sin(a), cos(a));
	vec2 v = p - s;
	float along = dot(v, dir);
	float perp = abs(v.x * dir.y - v.y * dir.x);
	float w = .003 + max(along, 0.) * tan(h);
	float cone = sst(w, w * .2, perp);
	float core = exp(-perp / (w * .25));
	return (cone * .5 + core * .5) * exp(-max(along, 0.) / len) * sst(0., .05, along);
}

vec3 pick(float i) {
	float k = mod(i, 3.);
	return k < .5 ? uA : (k < 1.5 ? uB : uC);
}

// the spotlights
vec3 beams(vec2 p, float haze) {
	float t = uTime * (1. - .4 * uGap);
	float kick = .045 * uBeat + .09 * uBar;
	vec3 acc = vec3(0.);
	for (int i = 0; i < 6; i++) {
		float fi = float(i);
		float sx = (fi / 5. - .5) * aspect * .96;
		float a = (fi - 2.5) * .13 + .4 * sin(t * (.31 + .055 * fi) + fi * 1.9) + kick * (mod(fi, 2.) < 1. ? 1. : -1.);
		float wake = 1. + 1.6 * uLine * step(abs(uLineId - mod(fi, 5.)), .5);
		acc += pick(fi) * beam(p, vec2(sx, -.53), a, .034 + .016 * uBar, 1.15) * haze * (.5 + .3 * uBeat) * wake;
	}
	return acc;
}

// the mirror ball
vec4 ball(vec2 p, vec2 c, float R) {
	vec2 q = (p - c) / R;
	float r2 = dot(q, q);
	if (r2 > 1.) return vec4(0.);
	vec3 n = vec3(q, sqrt(1. - r2));
	float lon = atan(n.x, n.z) + uTime * .45;
	float lat = asin(clamp(n.y, -1., 1.));
	vec2 g = vec2(lon * 3.8197, lat * 5.093);
	vec2 id = floor(g), f = fract(g);
	vec4 r = h42(id + 5.);
	float edge = min(min(f.x, 1. - f.x), min(f.y, 1. - f.y));
	float tile = sst(.03, .14, edge);
	vec3 tc = mix(vec3(.2, .22, .32), mix(uA, uB, r.x), .45 + .45 * r.y);
	float flash = pow(max(0., sin(uTime * (1. + r.z * 2.5) + r.w * 40.)), 16.) * (.35 + r.y);
	vec3 col = (tc * (.3 + .55 * n.z) + vec3(flash * .9)) * tile;
	col *= .3 + .7 * n.z;
	col += uC * pow(1. - n.z, 3.) * .55;
	col += vec3(1.) * pow(max(0., dot(n, normalize(vec3(-.5, -.6, .65)))), 22.) * .8;
	return vec4(col, sst(1., .96, sqrt(r2)));
}

// the light the ball throws: small bright spots turning slowly round it
vec3 spots(vec2 p, vec2 c, float calm) {
	vec2 d = p - c;
	float rad = length(d);
	float ang = atan(d.y, d.x) + uTime * .09;
	vec2 g = vec2(ang * 7., rad * 12.);
	vec2 id = floor(g);
	vec4 r = h42(id + 3.1);
	vec2 f = fract(g) - .5 - (r.xy - .5) * .4;
	float s = sst(.24, .08, length(f)) * step(.52, r.z);
	float near = exp(-rad * 1.05) * sst(.1, .2, rad);
	vec3 col = mix(uA, mix(uB, uC, r.x), r.y);
	float tw = .5 + .5 * sin(uTime * (.8 + r.w) + r.x * 30.);
	return col * s * near * (.35 + .65 * tw) * (.55 + .5 * uBeat) * calm;
}

// the equaliser: two rows of segmented glass columns either side of the cover
vec3 eq(vec2 p) {
	float ax = abs(p.x);
	float k = floor((ax - .26) / .036);
	if (k < 0. || k > 11.) return vec3(0.);
	float side = p.x < 0. ? 0. : 1.;
	float cx = .26 + (k + .5) * .036;
	float dx = ax - cx;
	float level = .3 + .7 * vnoise(vec2(k * 1.3 + side * 7.1, uTime * (1.4 + .11 * k)));
	float h = (.05 + .21 * level * (.62 + .55 * uBeat + .25 * uBar)) * (1. - .55 * uGap);
	float base = .055;
	float pitch = .0128;
	float n = (base - p.y) / pitch;                       // segments counted up from the baseline
	if (n < 0. || n > 24.) return vec3(0.);
	float idx = floor(n);
	float nLit = floor(h / pitch);
	float lit = step(idx, nLit - 1.);                     // this segment is lit
	float peak = step(abs(idx - (nLit + 1.)), .5) * .45;  // and a dim mark floats just above the top
	float w = .0112;
	float cellX = sst(w, w * .72, abs(dx));
	float cellY = sst(.5, .34, abs(fract(n) - .5));       // rounded gaps between the segments
	float tt = idx / 18.;
	vec3 c = mix(uB, mix(uC, uA, sst(.2, .8, tt)), sst(0., .9, tt));
	float on = clamp(lit + peak, 0., 1.);
	vec3 col = c * (.5 + .65 * tt) * on + c * (1. - on) * .07;      // unlit glass keeps a faint ghost
	col += vec3(1.) * lit * step(abs(idx - (nLit - 1.)), .5) * .4;   // the top lit segment is brightest
	col += vec3(1.) * sst(w * .22, 0., abs(dx + w * .4)) * on * .22; // a highlight down the glass
	float halo = exp(-max(abs(dx) - w, 0.) / .012) * step(0., n) * step(n, nLit) * .14;
	return col * cellX * cellY + c * halo;
}

void main() {
	aspect = uRes.x / uRes.y;
	vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1. - gl_FragCoord.y / uRes.y);
	vec2 p = vec2((uv.x - .5) * aspect, uv.y - .5);
	float calm = 1. - .5 * inText(uv);

	// the dark room: deep violet, a little lighter at the top where the lights hang
	vec3 col = mix(vec3(.018, .01, .045), uBase * .75 + vec3(.02, .012, .05), sst(-.5, .5, p.y));
	col += uC * exp(-length(p - vec2(0., -.52)) * 1.7) * .07;
	float haze = (.4 + .9 * fbm(p * 2. + vec2(uTime * .015, -uTime * .01))) * calm;

	col += beams(p, haze);

	// the mirror ball, top right, on a thread; it sways a little
	vec2 bc = vec2(aspect * .5 * .66 + sin(uTime * .33) * .005, -.352);
	col += spots(p, bc, calm);
	col += mix(uB, uC, .5) * exp(-length(p - bc) / .1) * .2 * (1. + .8 * uBeat);
	col += vec3(.8) * sst(.0013, 0., abs(p.x - bc.x)) * step(p.y, bc.y) * .3;
	vec4 b = ball(p, bc, .072);
	col = mix(col, b.rgb, b.a);

	// the equaliser, in the centred layouts only (there the cover sits between the two rows)
	if (uCentered > .5) col += eq(p) * (1. - .35 * inText(uv));

	// a soft pool of colour along the bottom, where the stage is
	col += uA * exp(-abs(p.y - .46) * 9.) * .05 * (1. + uBeat);

	// grade
	float m = max(col.r, max(col.g, col.b));
	col *= 1.25 / (1. + max(m - .7, 0.) * 1.1);
	col += vec3(max(m - 1.5, 0.)) * .12;
	col *= 1. - .55 * pow(length((uv - .5) * vec2(1.05, 1.2)), 2.4);
	col += (h21(gl_FragCoord.xy + fract(uTime) * 91.) - .5) * .012;
	fragColor = vec4(clamp(col, 0., 1.), 1.);
}`;
