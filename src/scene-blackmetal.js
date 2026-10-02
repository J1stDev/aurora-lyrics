// Black Metal: a frozen forest under the moon (the Black Metal theme's scene; see scenes.js).
//
// Cold monochrome, like the cover of an atmospheric black metal record. A moon with a halo and a
// faint ring round it hangs over banks of cloud lit on the side that faces it (now and then
// lightning stirs inside them). A low mountain range with snow on its crests, rows of spruces
// getting darker the nearer they are with fog between them, and big black spruces framing both
// sides so the middle stays open for the words. At the bottom the lake is frozen: black ice with a
// streak of moon on it and a web of cracks. Snow falls in three depths, frost creeps in from the
// edges of the screen, and the whole picture is heavy with grain. With beat data the fog swells on
// each bar; in a break the snow drives harder.

import { SCENE_HEAD } from "./scene-glsl.js";

export const BLACKMETAL_FRAG =
	SCENE_HEAD +
	`
float aspect;

float n1(float x) { return mix(h11(floor(x)), h11(floor(x) + 1.), sst(0., 1., fract(x))); }
float fbm1(float x) { return .5 * n1(x) + .3 * n1(x * 2.1 + 5.) + .2 * n1(x * 4.3 + 9.); }

// cells of a mosaic: x = distance to the nearest border (in cells)
float vorEdge(vec2 x) {
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
	return bd;
}

// the height of the mountain crest at x (y down): low in the middle, higher at the sides
float crest(float x) {
	float W = aspect * .5;
	float edge = pow(clamp(abs(x) / W, 0., 1.), 1.5);
	float m = fbm1(x * 2.7 + 1.) * .7 + fbm1(x * 9. + 4.) * .3;
	return mix(.2, .02, edge) - m * .13 * (.25 + .75 * edge);
}

// a row of spruces standing on baseY: 1 inside a tree. cells = trees per unit of width.
// Each tree is a triangle whose edge is a saw (the tiers of its branches).
float spruces(vec2 p, float cells, float baseY, float hMin, float hMax, float wK, float seed) {
	float cx = p.x * cells;
	float id0 = floor(cx);
	float cov = 0.;
	for (int k = -1; k <= 1; k++) {
		float id = id0 + float(k);
		vec4 r = h42(vec2(id, seed));
		float h = mix(hMin, hMax, r.y);
		float t = (baseY - p.y) / h;
		if (t < 0. || t > 1.) continue;
		float center = id + .5 + (r.x - .5) * .5;
		float w = mix(.36, .54, r.z) * wK;
		float tier = 6. + floor(r.w * 6.);
		float saw = .7 + .3 * abs(fract(t * tier) * 2. - 1.);
		float prof = (1. - t) * saw * w;
		cov = max(cov, sst(prof + .025, prof - .025, abs(cx - center)));
	}
	return cov;
}

// banks of cloud: x = density; the upper sky only
float clouds(vec2 p) {
	vec2 q = vec2(p.x * 1.2 + uTime * .004, p.y * 2.8);
	float f = fbm(q * 2. + vec2(0., 3.)) + .3 * fbm(q * 5. + 8.);
	return sst(.5, .86, f) * sst(.3, -.3, p.y);
}

// a band of fog lying at y0
float fogBand(vec2 p, float y0, float h, float dir, float seed) {
	float n = fbm(vec2(p.x * 1.7 + uTime * .006 * dir + seed, p.y * 5.));
	return exp(-pow((p.y - y0) / h, 2.)) * (.35 + .9 * n);
}

// snow of one depth: small flakes drifting down and sideways
float snow(vec2 p, float scale, float speed, float seed) {
	vec2 g = p * scale;
	g.y -= uTime * speed * (1. + .8 * uGap);
	g.x += uTime * speed * .3 + sin(uTime * .4 + g.y * .6) * .35;
	vec2 id = floor(g);
	vec4 r = h42(id + seed);
	vec2 f = fract(g) - .5 - (r.xy - .5) * .55;
	float rad = mix(.07, .17, r.z);
	return step(.5, r.w) * sst(rad, rad * .35, length(f));
}

void main() {
	aspect = uRes.x / uRes.y;
	vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1. - gl_FragCoord.y / uRes.y);
	vec2 p = vec2((uv.x - .5) * aspect, uv.y - .5);
	float W = aspect * .5;
	float calm = 1. - .35 * inText(uv);
	vec2 moon = vec2(W * .56, -.27);
	float R = .068;

	// the sky: black above, a cold glow towards the horizon
	vec3 col = mix(vec3(.008, .012, .02), vec3(.075, .1, .13), sst(-.5, .2, p.y));
	col += vec3(.1, .13, .17) * sst(.05, .26, p.y) * .5;

	// a few stars
	vec2 sg = p * 60.;
	vec4 sr = h42(floor(sg));
	float star = step(.987, sr.w) * sst(.16, .02, length(fract(sg) - .5 - (sr.xy - .5) * .6)) * (.5 + .5 * sin(uTime * (.5 + sr.z * 2.) + sr.x * 30.));
	col += vec3(.8, .88, 1.) * star * .7 * sst(.1, -.4, p.y);

	// the moon, its halo, and the ring round it
	float md = length(p - moon);
	vec2 q = (p - moon) / R;
	float craters = fbm(q * 3.4 + 7.);
	vec3 mc = vec3(.86, .92, .97) * (.7 + .55 * craters) * (1. - .4 * pow(min(length(q), 1.), 3.));
	col += vec3(.5, .62, .78) * exp(-max(md - R, 0.) / (R * 1.7)) * .3;
	col += vec3(.45, .58, .78) * exp(-pow((md - R * 4.7) / (R * .5), 2.)) * .06;
	col = mix(col, mc, sst(R, R * .95, md));

	// clouds, lit on the side that faces the moon; lightning now and then, inside them
	float cd = clouds(p);
	float lit = exp(-length(p - moon) * 2.1);
	vec3 cc = mix(vec3(.02, .03, .045), vec3(.46, .56, .68), lit * .85);
	float bolt = step(.9965, h11(floor(uTime * 1.3) + 7.)) * (.5 + .5 * sin(uTime * 60.)) + uLine * step(.6, h11(uLineId + 3.)) * .5;
	cc += vec3(.5, .62, .8) * bolt * exp(-length(p - vec2(-W * .3, -.2)) * 1.6) * 1.2;
	col = mix(col, cc, cd * .88);

	// the mountains: black, with snow on the crests and moonlight on the slopes that face the moon
	float cy = crest(p.x);
	float dm = p.y - cy;
	float slope = (crest(p.x + .01) - crest(p.x - .01)) / .02;
	float facing = sst(-.3, .5, -slope * sign(moon.x - p.x));
	vec3 mt = vec3(.012, .017, .024) + vec3(.1, .13, .17) * facing * .5 * sst(.1, .0, dm);
	mt += vec3(.55, .62, .7) * sst(.028, .0, dm) * (.5 + .5 * facing);       // snow on the crest
	col = mix(col, mt, sst(0., .004, dm));

	// fog, then the far treeline
	float fg = 1. + .35 * uBar;
	col = mix(col, vec3(.2, .25, .3), fogBand(p, .1, .09, 1., 3.) * .55 * fg);
	float far = spruces(p, 26., .2, .05, .1, 1., 11.);
	col = mix(col, vec3(.03, .04, .055), far * sst(.0, .03, p.y - .08));
	col = mix(col, vec3(.16, .2, .25), fogBand(p, .17, .08, -1., 8.) * .6 * fg);

	// the mid forest
	float mid = spruces(p, 15., .3, .1, .2, 1., 23.);
	col = mix(col, vec3(.014, .02, .03), mid);
	col = mix(col, vec3(.13, .17, .22), fogBand(p, .27, .07, 1., 14.) * .5 * fg);

	// the frozen lake
	float ICE = .335;
	float di = p.y - ICE;
	if (di > 0.) {
		vec3 ice = mix(vec3(.07, .09, .115), vec3(.008, .012, .018), sst(0., .15, di));
		float streak = exp(-pow((p.x - moon.x) / (.025 + di * .5), 2.)) * exp(-di * 6.) * (.5 + .5 * vnoise(vec2(p.x * 40., di * 60.)));
		ice += vec3(.5, .62, .78) * streak * .55;
		ice += vec3(.16, .23, .3) * (sst(.028, .0, vorEdge(vec2(p.x * 7., di * 12. + 2.))) * .8 + sst(.05, .0, vorEdge(vec2(p.x * 19., di * 30. + 7.))) * .3) * exp(-di * 4.5);       // cracks
		col = mix(col, ice, sst(0., .01, di));
	}

	// the near spruces, black, at both sides only
	float side = sst(W * .5, W * .78, abs(p.x));
	float nr = spruces(p, 7., .46, .26, .5, 1.1, 41.) * side;
	float nrUp = spruces(p + vec2(0., .004), 7., .46, .26, .5, 1.1, 41.) * side;
	col = mix(col, vec3(.004, .006, .009), nr);
	col += vec3(.35, .42, .5) * max(nrUp - nr, 0.) * .5;       // snow on their upper edges

	// snow, in three depths
	float sn = snow(p, 34., .05, 3.) * .5 + snow(p, 18., .09, 19.) * .75 + snow(p, 9., .15, 41.) * 1.;
	col += vec3(.8, .88, .96) * sn * .55 * (1. + .5 * uGap) * calm;

	// frost creeping in from the edges of the screen
	vec2 e = min(uv, 1. - uv);
	float dEdge = min(e.x * aspect, e.y);
	float ridge = 1. - abs(2. * vnoise(vec2(uv.x * aspect, uv.y) * 38. + 2.) - 1.);
	float fr = sst(.07, .0, dEdge + (fbm(vec2(uv.x * aspect, uv.y) * 13. + 5.) - .5) * .08 - ridge * .012);
	col = mix(col, vec3(.7, .8, .9), fr * .5);

	// grade: cold and nearly colourless, a vignette, and heavy grain
	float lum = dot(col, vec3(.3, .59, .11));
	col = mix(vec3(lum), col, .35) * vec3(.93, 1., 1.07);
	col *= 1. - .5 * pow(length((uv - .5) * vec2(1.05, 1.2)), 2.4);
	col += (h21(gl_FragCoord.xy + fract(uTime) * 91.) - .5) * .045;
	fragColor = vec4(clamp(col, 0., 1.), 1.);
}`;
