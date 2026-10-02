// Lounge: a late-night jazz bar (the Lounge theme's scene; see scenes.js).
//
// Warm dark wood. Behind the bar three shelves of bottles glow, out of focus, lit from behind by a
// strip of light under each. A pendant lamp hangs at the top; its cone of light has smoke curling
// through it and dust turning in it. Golden lights float far back in the room. At the bottom is the
// bar, polished, with a glass of whisky standing on it: amber liquid, an ice cube, bright edges on
// the glass and a patch of caustic light thrown across the wood. The lamp flickers like a candle;
// on every beat the bokeh swells, on every new line the smoke is stirred; in a break the room
// settles and the smoke thickens.

import { SCENE_HEAD } from "./scene-glsl.js";

export const LOUNGE_FRAG =
	SCENE_HEAD +
	`
float aspect;

float sdBox(vec2 p, vec2 b) {
	vec2 d = abs(p) - b;
	return length(max(d, 0.)) + min(max(d.x, d.y), 0.);
}

// the back bar: three shelves of bottles, out of focus, glowing from behind
vec3 shelves(vec2 p, float calm) {
	vec3 acc = vec3(0.);
	for (int r = 0; r < 3; r++) {
		float fr = float(r);
		float sy = -.3 + fr * .2;                         // the shelf each row stands on
		float cells = 8. + fr * .8;
		float cx = (p.x + fr * .13) * cells;
		float id = floor(cx);
		vec4 h = h42(vec2(id, fr * 7. + 2.));
		if (h.w < .1) continue;                           // a gap in the row
		float w = mix(.022, .036, h.x);
		float bh = mix(.075, .125, h.y);
		float c = (id + .5 + (h.z - .5) * .3) / cells - fr * .13;
		float body = sdBox(vec2(p.x - c, p.y - (sy - bh * .33)), vec2(w * .5, bh * .33));
		float neck = sdBox(vec2(p.x - c, p.y - (sy - bh * .78)), vec2(w * .17, bh * .24));
		float d = min(body, neck) - .004;
		float shape = sst(.02, -.02, d);                  // soft: far out of focus
		float up = clamp((sy - p.y) / bh, 0., 1.);
		vec3 glass = h.x > .7 ? vec3(.08, .3, .14) : (h.y > .55 ? uB : uA);
		vec3 c1 = glass * (.4 + .9 * up) + vec3(1., .85, .6) * sst(.12, .0, abs((p.x - c) / w + .22)) * .35;
		acc += c1 * shape * (.5 + .5 * h.z) * .4;
		// the strip of light under the shelf
		acc += uA * exp(-abs(p.y - (sy + .014)) * 70.) * sst(.0, .05, .5 * aspect - abs(p.x)) * .1;
	}
	return acc * calm;
}

// golden lights far back in the room
vec3 bokeh(vec2 p) {
	vec3 acc = vec3(0.);
	for (int i = 0; i < 3; i++) {
		float fi = float(i);
		vec2 g = p * mix(2.4, 5.4, fi / 2.) + vec2(uTime * (.01 + .006 * fi), uTime * .004 * (fi + 1.));
		vec2 id = floor(g);
		vec4 r = h42(id + fi * 61.);
		vec2 f = fract(g) - .5 - (r.yz - .5) * .45;
		float rad = mix(.2, .4, r.x);
		float d = length(f);
		float disc = sst(rad, rad * .86, d) * (.55 + .45 * sst(rad * .6, rad, d));
		float on = step(.72 - .1 * fi, r.w);
		acc += mix(uA, uC, fract(r.x * 5.)) * disc * on * (.085 - .02 * fi) * (1. + .6 * uBeat * step(.5, r.y));
	}
	return acc;
}

// a glass of whisky: rgb and how much of p it covers. g is in glass units: x across, y down, the origin at the middle
// of the foot, so the glass stands from y = -1 (the rim) to 0 (the foot).
vec4 tumbler(vec2 g) {
	float hw = mix(.44, .5, clamp(-g.y, 0., 1.));              // a little narrower at the foot
	float body = sdBox(vec2(g.x, g.y + .5), vec2(hw, .5));
	if (body > .08) return vec4(0.);
	float inside = sst(.012, -.012, body);
	vec3 col = vec3(0.);
	float a = 0.;

	// the liquid: lighter at the surface, deeper towards the foot, brighter through the middle
	float lq = inside * sst(-.64, -.62, g.y) * sst(-.08, -.1, g.y) * sst(hw - .02, hw - .07, abs(g.x));
	vec3 amber = mix(uA, uB, sst(-.62, -.12, g.y) * .85) * (.62 + .5 * sst(.34, .0, abs(g.x)));
	col += amber * lq;
	a = max(a, lq * .96);
	col += vec3(1., .85, .6) * sst(.03, .0, abs(g.y + .62)) * inside * .5;      // the meniscus

	// the ice cube, tilted, half under the surface
	vec2 q = g - vec2(.06, -.5);
	float cs = sin(.28), cc = cos(.28);
	q = vec2(cc * q.x + cs * q.y, -cs * q.x + cc * q.y);
	float cube = sst(.012, -.012, sdBox(q, vec2(.15)) - .035);
	vec3 ice = mix(vec3(.78, .9, .96), amber * 1.3, .35);
	ice += vec3(1.) * sst(.05, .0, abs(q.x + .1)) * .3 + vec3(1.) * sst(.04, .0, abs(q.y - .09)) * .22;
	col = mix(col, ice, cube * .72);
	a = max(a, cube * .8);

	// the glass: bright thin edges, a thick clear foot, a rim
	float wallL = sst(.035, .0, abs(g.x + hw - .025)) * inside;
	float wallR = sst(.035, .0, abs(g.x - hw + .025)) * inside;
	col += vec3(1., .95, .88) * (wallL * .55 + wallR * .35);
	float foot = sst(-.02, -.1, g.y) * inside;
	col += vec3(1., .92, .8) * foot * .22;
	col += vec3(.45, .4, .35) * inside * .1;
	col += vec3(1.) * sst(.025, .0, abs(length((g - vec2(0., -1.)) * vec2(1., 3.2)) - .48)) * .5 * sst(-.98, -1.04, g.y);
	a = max(a, (wallL + wallR) * .6 + inside * .14 + foot * .2);
	return vec4(col, clamp(a, 0., 1.));
}

void main() {
	aspect = uRes.x / uRes.y;
	vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1. - gl_FragCoord.y / uRes.y);
	vec2 p = vec2((uv.x - .5) * aspect, uv.y - .5);
	float W = aspect * .5;
	float t = uTime;
	float calm = 1. - .4 * inText(uv);

	// the lamp flickers like a candle
	float flick = .9 + .1 * vnoise(vec2(t * 2.3, 1.)) + .05 * sin(t * 7.1) * .5;
	float lampX = -W * .6;

	// the wall: dark wood, lit a little from the lamp
	vec3 col = mix(vec3(.02, .012, .008), uBase * .55 + vec3(.03, .018, .01), sst(-.5, .4, p.y));
	col += vec3(.1, .055, .025) * exp(-length(p - vec2(lampX, -.2)) * 1.5) * flick * .55;

	col += shelves(p, calm);
	col += bokeh(p) * (1. - .5 * uGap);

	// the lamp: a dome of dark metal, a hot bulb, and the cone of light below it, smoky and dusty
	// the shade: a cone of dark metal, lit warm along its lower rim from the bulb inside
	vec2 sp = vec2(p.x - lampX, p.y + .5);
	float shw = mix(.026, .09, clamp(sp.y / .07, 0., 1.));
	float dome = sst(.004, -.004, abs(sp.x) - shw) * sst(-.02, .0, sp.y) * sst(.072, .066, sp.y);
	float shadeRim = sst(.006, .0, abs(sp.y - .07)) * sst(.004, -.004, abs(sp.x) - .092);
	float bulb = exp(-length(p - vec2(lampX, -.44)) * 38.);
	float cw = .035 + (p.y + .5) * .34;
	float cone = sst(cw, cw * .1, abs(p.x - lampX)) * exp(-(p.y + .5) * 1.25) * sst(-.46, -.4, p.y);
	float dens = fbm(vec2((p.x - lampX) * 3.4 + sin(t * .11) * .3, p.y * 2.2 - t * .05)) * 1.2 + .25 * sin(t * .3);
	dens += uGap * .4 + uLine * .3;
	vec3 lamp = vec3(1., .72, .4);
	col += lamp * cone * (.28 + .75 * clamp(dens, 0., 1.5)) * flick * calm;
	col += lamp * bulb * 1.2 * flick;
	col = mix(col, vec3(.012, .009, .007) + lamp * shadeRim * .5 + lamp * sst(.07, .0, sp.y) * .05, dome);
	// dust turning in the light
	vec2 dg = p * 14. + vec2(sin(t * .2), -t * .06);
	vec4 dr = h42(floor(dg));
	col += lamp * sst(.12, .02, length(fract(dg) - .5 - (dr.xy - .5) * .5)) * step(.75, dr.w) * cone * 2.;

	// the bar: polished wood, the lamp and the shelves in it, a bright edge along the back
	float BAR = .31;
	float db = p.y - BAR;
	if (db > 0.) {
		vec3 wood = mix(vec3(.07, .038, .02), vec3(.015, .009, .006), sst(0., .18, db));
		wood += lamp * exp(-abs(p.x - lampX) / (.05 + db * .4)) * exp(-db * 7.) * .3 * flick;
		wood += uA * exp(-db * 9.) * (.04 + .05 * fbm(vec2(p.x * 6., db * 30.)));
		col = mix(col, wood, sst(0., .004, db));
	}
	col += uC * exp(-abs(db) * 90.) * .22 * sst(-.02, .0, db + .01);

	// a glass of whisky on the bar, at the right
	vec2 gp = vec2(W * .62, BAR + .006);
	float S = .115;
	vec2 g = (p - gp) / S;
	// caustic light thrown across the wood, in front of the glass
	float cz = exp(-pow((p.x - (gp.x - .04)) / .07, 2.)) * exp(-pow((p.y - (BAR + .045)) / .02, 2.));
	col += uA * cz * .5 * (.8 + .4 * sin(t * .8));
	vec4 gl = tumbler(vec2(g.x, g.y));
	col = mix(col, gl.rgb, gl.a);

	// grade: a warm shoulder, a vignette, a little grain
	float m = max(col.r, max(col.g, col.b));
	col *= 1.2 / (1. + max(m - .7, 0.) * 1.1);
	col *= vec3(1.04, 1., .93);
	col *= 1. - .55 * pow(length((uv - .5) * vec2(1.05, 1.2)), 2.4);
	col += (h21(gl_FragCoord.xy + fract(uTime) * 91.) - .5) * .02;
	fragColor = vec4(clamp(col, 0., 1.), 1.);
}`;
