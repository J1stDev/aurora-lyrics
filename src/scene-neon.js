// Neon: glass tubes of light over a dark wet floor (the Neon theme's scene; see scenes.js).
//
// Long tubes of neon sweep across a dark room, each a wave made of a few sines, so how far a pixel is
// from the tube is cheap to work out. A tube is a hot core in a coloured body in a halo of light that
// spills into haze (the haze is noise, so the light has texture). Light runs along the tubes. Two glass
// signs, a ring and a bolt, stand at the edges and now and then stutter like a tired transformer.
// Below a horizon the floor is wet glass: the same lights, mirrored, blurred and rippled. Sparks of
// dust drift through it all. On every beat the light swells, on the bar it surges, and on every new
// line one part of the scene flares; in a break it all dims and slows.

import { SCENE_HEAD } from "./scene-glsl.js";

export const NEON_FRAG =
	SCENE_HEAD +
	`
float aspect;
 const float HORIZON = .3;

// height of a wave at x, and its slope
vec2 wave(float x, float y0, vec3 a, vec3 k, vec3 w, vec3 ph, float t) {
	vec3 s = k * x + w * t + ph;
	return vec2(y0 + dot(a, sin(s)), dot(a * k, cos(s)));
}

// light of a glass tube at signed distance d from its axis (+ below it), radius r;
// soft > 0 blurs it (the reflection), surge swells the spill, haze textures it
vec3 tube(float d, float r, vec3 col, float soft, float surge, float haze) {
	float ad = abs(d);
	float rr = r * (1. + soft);
	float body = sst(rr * 1.15, rr * .72, ad);                  // the gas glows right to the glass
	float core = sst(rr * .62, 0., ad);                         // and brightest in the middle
	float rim = sst(rr * 1.35, rr * 1.12, ad) * sst(rr * .9, rr * 1.12, ad); // the glass wall catches a little light
	float near = exp(-ad / (rr * 3.4));
	float spill = near * .42 + exp(-ad / (rr * 12.)) * .17 * haze + exp(-ad / (rr * 55.)) * .05 * haze;
	float glint = exp(-pow((d + rr * .55) / (rr * .2), 2.)) * (1. - soft);
	vec3 sat = pow(col, vec3(1.18));                            // colour deepens away from the tube
	vec3 c = col * body * 1.05 + sat * spill * surge * 1.25 + mix(col, vec3(1.), .62) * core * .85 + vec3(rim * .1 + glint * .22);
	return c / (1. + soft * 1.4);
}

// the tubes and signs as light; p is centred, one screen high, y down. calm holds the tubes back (the lyrics are here)
vec3 lights(vec2 p, float soft, float haze, float calm) {
	float t = uTime * (1. - .45 * uGap);
	float surge = (1. + .3 * uBeat + .55 * uBar) * (1. - .3 * uGap);
	vec3 acc = vec3(0.);
	vec2 c;
	float d, flow, wake, fl;

	// 1: the big one, in the accent colour, low across the room
	c = wave(p.x, .205, vec3(.055, .03, .004), vec3(1.5, 3.4, 8.), vec3(.19, .31, .57), vec3(0., 1.9, 4.2), t);
	d = (p.y - c.x) / sqrt(1. + c.y * c.y);
	flow = .8 + .2 * sin(p.x * 6.5 - t * 2.3);
	wake = 1. + 1.4 * uLine * step(abs(uLineId - 0.), .5);
	acc += tube(d, .0085, uA, soft, surge * flow * wake, haze) * calm;

	// 2: second colour, high up, slower
	c = wave(p.x, -.36, vec3(.07, .032, .004), vec3(1.1, 2.7, 9.), vec3(-.16, .27, .5), vec3(2.1, .4, 3.), t);
	d = (p.y - c.x) / sqrt(1. + c.y * c.y);
	flow = .8 + .2 * sin(p.x * 5.1 + t * 1.9 + 1.);
	wake = 1. + 1.4 * uLine * step(abs(uLineId - 1.), .5);
	acc += tube(d, .0068, uB, soft, surge * flow * wake, haze) * calm;

	// 3: a thin one through the middle, far away
	c = wave(p.x, -.17, vec3(.09, .035, .005), vec3(.8, 2.2, 7.), vec3(.12, -.2, .4), vec3(4., 2.2, 1.), t);
	d = (p.y - c.x) / sqrt(1. + c.y * c.y);
	flow = .72 + .28 * sin(p.x * 8. - t * 2.9 + 2.);
	wake = 1. + 1.4 * uLine * step(abs(uLineId - 2.), .5);
	acc += tube(d, .0036, uC, soft, surge * flow * wake, haze) * calm * .7;

	// 4: thin, accent, near the floor
	c = wave(p.x, .265, vec3(.035, .02, .003), vec3(1.9, 4.1, 10.), vec3(.24, -.33, .6), vec3(1., 3.1, 5.), t);
	d = (p.y - c.x) / sqrt(1. + c.y * c.y);
	flow = .72 + .28 * sin(p.x * 9. - t * 2.6 + 4.);
	acc += tube(d, .0038, uA, soft, surge * flow, haze) * calm * .75;

	// 5: thin, second colour, along the top
	c = wave(p.x, -.46, vec3(.03, .018, .003), vec3(1.7, 3.8, 9.), vec3(.2, .3, -.5), vec3(.3, 5., 2.), t);
	d = (p.y - c.x) / sqrt(1. + c.y * c.y);
	acc += tube(d, .0034, uB, soft, surge, haze) * calm * .7;

	// the ring sign, top right, half off the screen
	vec2 rc = vec2(aspect * .5 - .05, -.5 + .07);
	float rd = length(p - rc);
	fl = 1. - .8 * step(.992, h11(floor(uTime * 5.) + 3.));
	wake = 1. + 1.2 * uLine * step(abs(uLineId - 3.), .5);
	acc += (tube(rd - .21, .0074, uC, soft, surge * wake, haze) + tube(rd - .15, .0054, uC, soft, surge * wake, haze) * .85) * fl;

	// the bolt sign, bottom right: a closed outline of six corners
	vec2 bp = p - vec2(aspect * .5 - .11, .27);
	vec2 b0 = vec2(.048, -.178), b1 = vec2(-.092, .014), b2 = vec2(-.010, .014), b3 = vec2(-.062, .180), b4 = vec2(.100, -.040), b5 = vec2(.014, -.040);
	float bd = min(min(sdSeg(bp, b0, b1), sdSeg(bp, b1, b2)), min(sdSeg(bp, b2, b3), min(sdSeg(bp, b3, b4), min(sdSeg(bp, b4, b5), sdSeg(bp, b5, b0)))));
	fl = 1. - .85 * step(.97, h11(floor(uTime * 7.) + 11.));
	wake = 1. + 1.2 * uLine * step(abs(uLineId - 4.), .5);
	acc += tube(bd, .0078, uB, soft, surge * wake, haze) * fl;

	return acc;
}

// out-of-focus lights far behind everything: soft discs with a brighter edge, drifting very slowly
vec3 bokeh(vec2 p) {
	vec3 acc = vec3(0.);
	for (int i = 0; i < 3; i++) {
		float fi = float(i);
		vec2 g = p * mix(2.2, 5., fi / 2.) + vec2(uTime * (.012 + .008 * fi) * (fi > .5 ? -1. : 1.), uTime * .005 * (fi + 1.));
		vec2 id = floor(g);
		vec4 r = h42(id + fi * 57.);
		vec2 f = fract(g) - .5 - (r.yz - .5) * .45;
		float rad = mix(.18, .38, r.x);
		float d = length(f);
		float disc = sst(rad, rad * .86, d) * (.55 + .45 * sst(rad * .6, rad, d));
		float on = step(.74 - .1 * fi, r.w);
		acc += mix(uA, uB, fract(r.x * 7. + fi * .3)) * disc * on * (.075 - .018 * fi) * (1. + .6 * uBeat * step(.5, r.y));
	}
	return acc;
}

void main() {
	aspect = uRes.x / uRes.y;
	vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1. - gl_FragCoord.y / uRes.y);
	vec2 p = vec2((uv.x - .5) * aspect, uv.y - .5);
	float calm = 1. - .45 * inText(uv);

	// the dark: almost black, tinted by the album, lighter towards the floor
	vec3 col = mix(vec3(.010, .008, .026), uBase * .6 + vec3(.012, .01, .03), sst(-.5, .4, p.y));
	float haze = .4 + .8 * fbm(p * 1.8 + vec2(uTime * .011, uTime * .006));

	col += bokeh(p) * (1. - .6 * inText(uv)) * (1. - .5 * uGap);

	float depth = p.y - HORIZON;
	if (depth < .06) col += lights(p, 0., haze, calm) * sst(.06, -.02, depth);
	col += mix(uA, uB, .5) * exp(-abs(depth) * 18.) * (.05 + .05 * uBeat); // a glow where the room meets the floor
	if (depth > -.04) {
		// the floor: wet and dark; the room is in it, upside down, blurred and rippled
		float f = sst(-.04, .08, depth);
		vec2 q = vec2(p.x + sin(depth * 70. + uTime * 1.3) * .004 * (.4 + depth * 5.) + (vnoise(vec2(p.x * 9., depth * 40. - uTime * .4)) - .5) * .012, HORIZON - max(depth, 0.));
		vec3 refl = lights(q, 1.4 + max(depth, 0.) * 6., haze * .8, calm);
		float streak = .55 + .9 * vnoise(vec2(p.x * 5., depth * 55.));
		col = mix(col, col * .35 + uBase * .08, f);
		col += refl * streak * exp(-max(depth, 0.) * 3.4) * .5 * f;
	}

	// sparks of dust in the light
	for (int i = 0; i < 2; i++) {
		float fi = float(i);
		vec2 g = p * mix(7., 12., fi) + vec2(uTime * (.03 + .02 * fi), -uTime * (.05 + .03 * fi));
		vec2 id = floor(g);
		vec4 r = h42(id + fi * 31.);
		vec2 f = fract(g) - .5 - (r.yz - .5) * .5;
		float rad = mix(.05, .16, r.x) / (1. + fi * .6);
		float a = sst(rad, rad * .35, length(f)) * step(.68, r.w) * (.5 + .5 * sin(uTime * (.6 + r.x * 1.6) + r.y * 20.));
		col += mix(uA, uB, r.x) * a * .1 * (1. + uBeat * .8);
	}

	// grade: a hue-keeping shoulder so overlapping lights burn to white instead of clipping to a colour, a vignette, a little noise against banding
	float m = max(col.r, max(col.g, col.b));
	col *= 1.3 / (1. + max(m - .7, 0.) * 1.1);
	col += vec3(max(m - 1.5, 0.)) * .12;
	col *= 1. - .5 * pow(length((uv - .5) * vec2(1.05, 1.2)), 2.4);
	col += (h21(gl_FragCoord.xy + fract(uTime) * 91.) - .5) * .012;
	fragColor = vec4(clamp(col, 0., 1.), 1.);
}`;
