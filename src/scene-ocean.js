// Ocean: a dive that lasts one song (the Ocean theme's scene; see scenes.js).
//
// You start in bright shallows, looking up: the rippling underside of the surface, webs of light
// (caustics), shafts of sun, a manta ray and a school of fish passing through them. As the song plays
// you sink (uSong): the water turns from turquoise to deep blue, the sunlight fades, marine snow drifts
// up past you and jellyfish fade into view out of the dark, glowing. Bubbles rise throughout, glass
// spheres with a bright rim and two glints. On every beat the jellyfish pulse harder, on the bar the
// shafts flash, on every new line one shaft flares; in a break everything slows.

import { SCENE_HEAD } from "./scene-glsl.js";

export const OCEAN_FRAG =
	SCENE_HEAD +
	`
float aspect;

// webs of light, tileable (the usual four-fold folded sine trick)
float caustic(vec2 uv, float t) {
	vec2 p = mod(uv * 6.28318, 6.28318) - 250.;
	vec2 i = p;
	float c = 1.;
	float inten = .005;
	for (int n = 0; n < 4; n++) {
		float tt = t * (1. - (3.5 / float(n + 1)));
		i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
		c += 1. / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
	}
	c /= 4.;
	c = 1.17 - pow(c, 1.4);
	return pow(abs(c), 8.);
}

// the colour of the water at a depth (0 at the surface .. about 1.2 in the abyss)
vec3 waterColour(float d) {
	vec3 c = mix(vec3(.13, .6, .74), vec3(.03, .27, .46), sst(0., .45, d));
	c = mix(c, vec3(.006, .045, .13), sst(.3, .85, d));
	return mix(c, vec3(.002, .012, .045), sst(.75, 1.25, d));
}

// shafts of sunlight from the surface, fading with depth
vec3 rays(vec2 p, float D) {
	float k = 1. - sst(0., .8, D);
	if (k < .01) return vec3(0.);
	vec3 acc = vec3(0.);
	for (int i = 0; i < 7; i++) {
		float fi = float(i);
		float x0 = (fi - 3.) * .26 + sin(uTime * .07 + fi * 2.3) * .08;
		float a = .2 + .06 * sin(uTime * .05 + fi);
		vec2 dir = vec2(sin(a), cos(a));
		vec2 v = p - vec2(x0, -.62);
		float along = dot(v, dir);
		float perp = v.x * dir.y - v.y * dir.x;
		float w = .035 + max(along, 0.) * .065;
		float s = sst(w, 0., abs(perp)) * exp(-max(along, 0.) * .95) * sst(0., .12, along);
		float flicker = .55 + .8 * fbm(vec2(perp * 13., uTime * .11 + fi * 3.));
		float wake = 1. + 1.5 * uLine * step(abs(uLineId - mod(fi, 5.)), .5);
		acc += s * flicker * wake;
	}
	return acc * k * vec3(.5, .93, 1.) * (.68 + .35 * uBar);
}

// bubbles: glass spheres, a thin bright ring, a glint at the top left and a fainter one opposite
vec3 bubbles(vec2 p) {
	vec3 acc = vec3(0.);
	for (int L = 0; L < 3; L++) {
		float fl = float(L);
		vec2 g = p * mix(5., 13., fl / 2.);
		g.y += uTime * mix(.5, .85, fl / 2.) * (1. - .5 * uGap);
		vec2 id = floor(g);
		vec4 r = h42(id + fl * 71.);
		if (r.w > .36) continue;
		vec2 f = fract(g) - .5;
		f.x -= (r.x - .5) * .5 + sin(uTime * (.8 + r.y) + r.z * 6.) * .06;
		f.y -= (r.y - .5) * .4;
		float rad = mix(.07, .2, r.z) * mix(1., .72, fl / 2.);
		float d = length(f);
		if (d > rad * 1.15) continue;
		float ring = sst(rad, rad * .9, d) * sst(rad * .74, rad * .96, d);
		float fill = sst(rad, rad * .9, d) * .1;
		float spec = sst(rad * .3, 0., length((f - vec2(-.38, -.4) * rad) * vec2(1., 1.3)));
		float bounce = sst(rad * .24, 0., length(f - vec2(.42, .44) * rad)) * .35;
		acc += vec3(.75, .95, 1.) * (ring * .55 + fill) + vec3(1.) * (spec * .9 + bounce);
	}
	return acc;
}

// specks drifting up past you as you sink
float marineSnow(vec2 p, float D) {
	float acc = 0.;
	for (int L = 0; L < 2; L++) {
		float fl = float(L);
		vec2 g = p * mix(26., 14., fl) + vec2(sin(uTime * .1 + fl) * .6, uTime * mix(.18, .32, fl));
		vec2 id = floor(g);
		vec4 r = h42(id + fl * 13.);
		vec2 f = fract(g) - .5 - (r.xy - .5) * .6;
		acc += step(.5, r.w) * sst(mix(.1, .18, r.z), .03, length(f)) * mix(.5, 1., fl);
	}
	return acc * (.2 + .8 * sst(.1, .8, D));
}

// a jellyfish: a translucent bell that pulses, a lip, and trailing arms; rgb = light, a = how much it hides what is behind
vec4 jelly(vec2 p, float fi, vec3 glow) {
	vec4 h = h42(vec2(fi, 9.7));
	float s = mix(.06, .12, h.x);
	float cyc = fract(uTime * (.0055 + .004 * h.y) * (1. - .6 * uGap) + h.z);
	vec2 c = vec2(mix(-aspect * .46, aspect * .46, h.w) + sin(uTime * (.12 + h.x * .1) + fi * 3.) * .05, mix(.7, -.78, cyc));
	vec2 q = (p - c) / s;
	if (abs(q.x) > 2.4 || q.y < -1.3 || q.y > 4.2) return vec4(0.);
	float ph = fract(uTime * (.4 + .1 * h.y) + h.z * 5.);
	float pulse = sin(ph * 6.2832) + .8 * uBeat;
	q.x /= 1. + .13 * pulse;
	q.y /= 1. - .07 * pulse;
	// the bell: a dome with a lip
	float bell = max(length(vec2(q.x, q.y * 1.1)) - 1., q.y - .22);
	float body = sst(.04, -.04, bell);
	float rimLight = exp(bell * 6.) * step(bell, 0.);
	float ang = atan(q.x, -q.y);
	float canal = .5 + .5 * cos(ang * 14.);
	float lip = exp(-abs(q.y - .22) * 16.) * step(abs(q.x), .96);
	vec3 col = glow * (body * (.14 + .5 * rimLight) * (.85 + .3 * canal) + lip * .55) + vec3(.75, .92, 1.) * rimLight * body * .12;
	float a = body * .3 + lip * .1;
	// the arms: thin lines of light, waving
	float arms = 0.;
	float y = q.y - .2;
	if (y > 0.) {
		for (int k = 0; k < 8; k++) {
			float fk = float(k);
			float kx = (fk / 7. - .5) * 1.5 * (1. - .1 * y);
			float wob = sin(y * 4.5 - uTime * 1.8 + fk * 1.3 + ph * 6.) * .1 * y;
			float line = exp(-abs(q.x - kx - wob) * (mod(fk, 2.) < .5 ? 26. : 40.)) * sst(3.2, .2, y);
			arms += line * (mod(fk, 2.) < .5 ? .55 : .35);
		}
	}
	col += glow * arms * .8;
	a += min(arms, 1.) * .08;
	return vec4(col, a);
}

// the manta, a dark diamond with a tail gliding across the shallows
float manta(vec2 p, float D) {
	float vis = sst(.5, .15, D);
	if (vis < .01) return 0.;
	vec2 c = vec2(mix(-aspect * .8, aspect * .8, fract(uTime * .011 + .3)), -.3 + .04 * sin(uTime * .2));
	vec2 q = (p - c) / .17;
	float flap = sin(uTime * 1.1);
	q.y *= 1. + .1 * flap * (.5 + .5 * abs(q.x));
	float d = (abs(q.x * .82 - .06) + abs(q.y) * .6) - 1.;
	float body = sst(.08, -.08, d);
	float tail = sst(.035, 0., abs(q.y - sin(q.x * 3. - uTime * 2.) * .05)) * step(-3., q.x) * step(q.x, -.85);
	return max(body, tail) * vis;
}

// a school of small fish crossing at mid depth
vec2 school(vec2 p, float D) {
	float vis = sst(.1, .28, D) * sst(.78, .5, D);
	if (vis < .01) return vec2(0.);
	float t = uTime * .03;
	vec2 c = vec2(mix(-aspect * .75, aspect * .75, fract(t)), .02 + .1 * sin(t * 11.));
	if (abs(p.x - c.x) > .3 || abs(p.y - c.y) > .2) return vec2(0.);
	float body = 0., flash = 0.;
	for (int i = 0; i < 16; i++) {
		float fi = float(i);
		vec4 h = h42(vec2(fi, 3.3));
		vec2 off = (h.xy - .5) * vec2(.4, .2) + vec2(sin(uTime * .9 + fi) * .012, cos(uTime * 1.2 + fi * 1.7) * .01);
		vec2 d = (p - c - off) * vec2(1., 2.5);
		float b = sst(.011, .005, length(d));
		body += b;
		flash += b * pow(.5 + .5 * sin(uTime * 2. + fi * 5.), 8.);
	}
	return vec2(min(body, 1.), min(flash, 1.)) * vis;
}

void main() {
	aspect = uRes.x / uRes.y;
	vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1. - gl_FragCoord.y / uRes.y);
	vec2 p = vec2((uv.x - .5) * aspect, uv.y - .5);
	float calm = 1. - .5 * inText(uv);
	float D = uSong * .95 + (p.y + .5) * .3;          // how deep this part of the picture is

	vec3 col = waterColour(D);
	col *= 1. + .12 * uBeat * (1. - sst(0., .7, D));
	col *= 1. - .2 * inText(uv) * (1. - sst(.5, 1., D));            // a little darker under the words, so they read on the bright shallows

	// the surface above you at the start of the dive: a bright rippling ceiling that rises out of sight
	float ys = -.36 - uSong * 1.7 + .012 * sin(p.x * 9. + uTime * 1.2) + .008 * sin(p.x * 21. - uTime * .9);
	float above = sst(ys + .03, ys - .03, p.y);
	col = mix(col, vec3(.8, 1., 1.) * (.8 + .4 * vnoise(vec2(p.x * 30., uTime * .7))), above * .92);
	col += vec3(.25, .7, .8) * exp(-max(p.y - ys, 0.) * 7.) * (1. - above) * .8;

	// webs of light in the upper water, fading as you go down
	float wc = (1. - sst(0., .6, D)) * sst(.45, -.4, p.y) * calm;
	if (wc > .01) col += vec3(.45, .95, 1.) * (caustic(p * .55 + vec2(0., uTime * .004), uTime * .45) * .55 + caustic(p * .9 + 3.1, uTime * .3 + 7.) * .3) * wc * 1.05;

	col += rays(p, D) * calm;

	// the manta overhead
	col = mix(col, vec3(.01, .08, .12), manta(p, D) * .6);
	// the fish
	vec2 fish = school(p, D);
	col = mix(col, vec3(.01, .06, .1), fish.x * .6);
	col += vec3(.7, .9, 1.) * fish.y * .45;

	// jellyfish, out of the dark
	float jv = sst(.22, .62, D);
	if (jv > .01) {
		for (int j = 0; j < 6; j++) {
			float fj = float(j);
			vec3 g = mod(fj, 3.) < .5 ? uC : (mod(fj, 3.) < 1.5 ? uB : uA);
			vec4 jl = jelly(p, fj, g * (1.3 + .6 * uBeat + .5 * uBar));
			col = col * (1. - jl.a * jv * calm) + jl.rgb * jv * calm;
		}
	}

	col += vec3(.6, .85, 1.) * marineSnow(p, D) * .3;
	col += bubbles(p) * .55 * (.5 + .5 * calm);

	// grade
	col *= 1. - .5 * pow(length((uv - .5) * vec2(1.05, 1.2)), 2.4);
	col += (h21(gl_FragCoord.xy + fract(uTime) * 91.) - .5) * .014;
	fragColor = vec4(clamp(col, 0., 1.), 1.);
}`;
