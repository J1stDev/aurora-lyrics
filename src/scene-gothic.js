// Gothic: a cathedral at night (the Gothic theme's scene; see scenes.js).
//
// High in the dark a rose window glows: twelve identical sectors of coloured glass cut into mosaic
// cells, held by black lead and stone spokes and rings, lit from behind and never quite steady. Its
// light falls through the haze in long slanted shafts, with dust turning in them, and spills over the
// stone round it. The nave is black at the edges. Candles stand low at both sides, and mist creeps
// along the floor. Beat and bar make the whole window swell; each new line wakes one sector; in a
// break the light sinks.

import { SCENE_HEAD } from "./scene-glsl.js";

export const GOTHIC_FRAG =
	SCENE_HEAD +
	`
float aspect;
 const vec2 WIN = vec2(0., -.74);   // the middle of the rose window, above the top edge so only its lower part shows
 const float WR = .62;             // and its radius

// the window's glass: crimson, sapphire, amber (all from the theme's colours), emerald and violet
vec3 glassColour(float k) {
	if (k < .30) return uA;
	if (k < .56) return uB;
	if (k < .74) return uC;
	if (k < .88) return vec3(.04, .4, .25);
	return vec3(.34, .1, .5);
}

// cells of a mosaic: x = distance to the nearest border (in cells), y = which cell
vec2 vor(vec2 x) {
	vec2 n = floor(x), f = fract(x);
	vec2 mg = vec2(0.), mr = vec2(0.);
	float md = 8.;
	for (int j = -1; j <= 1; j++) {
		for (int i = -1; i <= 1; i++) {
			vec2 g = vec2(float(i), float(j));
			vec2 r = g + h42(n + g).xy - f;
			float d = dot(r, r);
			if (d < md) { md = d; mr = r; mg = g; }
		}
	}
	float bd = 8.;
	for (int j = -2; j <= 2; j++) {
		for (int i = -2; i <= 2; i++) {
			vec2 g = mg + vec2(float(i), float(j));
			vec2 r = g + h42(n + g).xy - f;
			if (dot(mr - r, mr - r) > 1e-4) bd = min(bd, dot(.5 * (mr + r), normalize(r - mr)));
		}
	}
	return vec2(bd, dot(n + mg, vec2(7.13, 113.7)));
}

// the rose window: rgb = what is seen, a = how much of p is window (0 outside)
vec4 rose(vec2 p, float level) {
	vec2 d = p - WIN;
	float R = length(d) / WR;
	if (R > 1.05) return vec4(0.);
	float th = atan(d.y, d.x);
	float sec = 6.2831853 / 12.;
	float sid = floor(th / sec);
	float phi = abs(mod(th, sec) - sec * .5);              // 0 mid-petal .. sec/2 at the spoke
	// stone: rings at .2 .54 .9 and 1, a spoke between every two sectors
	float dr = min(min(abs(R - .2), abs(R - .54)), min(abs(R - .9), abs(R - 1.)));
	float ds = (sec * .5 - phi) * R;
	float stone = sst(.013, .007, min(dr, ds)) ;
	// glass: a mosaic in each of the three rings, the same in every sector (the window is symmetrical)
	float ring = R < .2 ? 0. : (R < .54 ? 1. : 2.);
	float sc = ring < .5 ? 6. : (ring < 1.5 ? 9. : 8.);
	vec2 v = vor(vec2(R, phi * R) * sc + ring * 17.);
	float lead = sst(.075, .03, v.x);
	float pick = h11(v.y + ring * 3.1 + sid * 2.7);
	float tex = .55 + .6 * fbm(vec2(R, phi * R) * 26.);   // painted, uneven glass
	vec3 glass = glassColour(pick) * tex * level * (.8 + .5 * (1. - R)) * .62;
	vec3 col = mix(glass, vec3(.014, .01, .012), lead);
	col = mix(col, vec3(.04, .034, .036) * (.6 + .6 * fbm(d * 30.)), stone);
	return vec4(col, sst(1.05, 1., R));
}

// the light of the window falling through the haze
vec3 shafts(vec2 p, float haze, float level) {
	vec3 acc = vec3(0.);
	for (int i = 0; i < 5; i++) {
		float fi = float(i);
		vec2 s = WIN + vec2((fi - 2.) * .2, .5);
		float a = -.3 + fi * .13 + .025 * sin(uTime * .17 + fi * 2.);
		vec2 dir = vec2(sin(a), cos(a));
		vec2 v = p - s;
		float along = dot(v, dir);
		float perp = abs(v.x * dir.y - v.y * dir.x);
		float w = .04 + max(along, 0.) * .07;
		float shaft = sst(w, 0., perp) * exp(-max(along, 0.) * 1.15) * sst(0., .1, along);
		vec3 c = fi < .5 ? uA : (fi < 1.5 ? uB : (fi < 2.5 ? uC : (fi < 3.5 ? vec3(.1, .6, .4) : uA)));
		float wake = 1. + 1.4 * uLine * step(abs(uLineId - fi), .5);
		acc += c * shaft * haze * level * wake * .3;
	}
	return acc;
}

// candles: wax, a flame that wavers, and the glow round it
vec3 candles(vec2 p) {
	vec3 acc = vec3(0.);
	for (int i = 0; i < 6; i++) {
		float fi = float(i);
		float side = i < 3 ? -1. : 1.;
		float k = mod(fi, 3.);
		vec2 base = vec2(side * (aspect * .5 - .075 - k * .07), .325 - k * .012);
		float h = .045 + .05 * h11(fi * 3.7 + 1.);
		vec2 d = p - base;
		float wax = sst(.0075, .0055, abs(d.x)) * sst(.002, -.002, d.y) * sst(-h - .002, -h + .002, d.y);
		float fk = vnoise(vec2(uTime * 4.5 + fi * 9.3, fi)) - .5;
		vec2 fp = d - vec2(0., -h - .013);
		fp.x -= fk * .005 * (1. + fp.y * 30.);
		float flame = sst(.011, .003, length(fp * vec2(1.25, .62)));
		float glow = exp(-length(d - vec2(0., -h - .012)) * 13.) * (.8 + .5 * fk);
		acc += wax * vec3(.5, .42, .32) * (.4 + 1.6 * glow) + flame * vec3(1., .8, .45) * 1.7 + vec3(1., .5, .18) * glow * .42;
	}
	return acc;
}

void main() {
	aspect = uRes.x / uRes.y;
	vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1. - gl_FragCoord.y / uRes.y);
	vec2 p = vec2((uv.x - .5) * aspect, uv.y - .5);
	float calm = 1. - .6 * inText(uv);

	// the window is lit from behind and never steady; beat and bar make it swell, a break lets it sink
	float level = (.8 + .12 * vnoise(vec2(uTime * 1.7, 3.)) + .1 * sin(uTime * .31)) * (1. + .14 * uBeat + .28 * uBar) * (1. - .2 * uGap);

	// the stone of the nave: nearly black, warm, with a grain to it
	float grain = fbm(p * 9. + 4.);
	vec3 col = mix(vec3(.012, .008, .01), uBase * .45 + vec3(.014, .01, .012), sst(-.5, .5, p.y));
	col += vec3(.05, .036, .032) * grain * .5;

	// the window and the light it gives the wall round it
	float R = length(p - WIN) / WR;
	vec3 wall = mix(uA, uC, .4) * exp(-max(R - 1., 0.) * 3.2) * .14 * level;
	vec4 w = rose(p, level * mix(1., calm, .5));
	col = mix(col + wall * (.6 + .6 * grain), w.rgb, w.a);

	// shafts of coloured light, with dust turning in them
	float haze = .4 + .9 * fbm(p * 2.2 + vec2(uTime * .012, -uTime * .008));
	vec3 sh = shafts(p, haze, level) * calm;
	col += sh;
	for (int i = 0; i < 2; i++) {
		float fi = float(i);
		vec2 g = p * mix(9., 15., fi) + vec2(uTime * .02, -uTime * (.04 + .02 * fi));
		vec4 r = h42(floor(g) + fi * 17.);
		vec2 f = fract(g) - .5 - (r.yz - .5) * .5;
		float a = sst(.1, .03, length(f)) * step(.7, r.w);
		col += (sh + vec3(.02)) * a * 2.2;
	}

	// the edges of the nave sink into black
	col *= 1. - .9 * sst(aspect * .5 - .16, aspect * .5 - .02, abs(p.x));

	// candles at both sides, mist along the floor
	col += candles(p);
	float mist = fbm(vec2(p.x * 2.2 + uTime * .02, p.y * 7.)) * sst(.12, .46, p.y);
	col += vec3(.1, .09, .11) * mist * .5 * (1. + .0);

	// grade: a shoulder, a vignette, a little noise against banding
	float m = max(col.r, max(col.g, col.b));
	col *= 1.25 / (1. + max(m - .75, 0.) * 1.2);
	col *= 1. - .5 * pow(length((uv - .5) * vec2(1.05, 1.2)), 2.5);
	col += (h21(gl_FragCoord.xy + fract(uTime) * 91.) - .5) * .012;
	fragColor = vec4(clamp(col, 0., 1.), 1.);
}`;
