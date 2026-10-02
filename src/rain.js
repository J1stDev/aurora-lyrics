// Rain on a window, drawn with WebGL (the Rain theme's ambience; if WebGL isn't there, the CSS
// scene in styles.css is used instead).
//
// The glass is misted, so the night city behind it is a blur of light. Drops of water on the glass
// are small lenses: through one you see the street sharp and upside down. The bigger drops run down
// in fits and starts and wipe a clear trail behind them; smaller beads come and go. All of that is
// worked out per pixel in one fragment shader from a few hashes (there are no textures for the drops).
// The only images are three copies of one night street, painted once with the 2D canvas and blurred
// by different amounts: the shader picks between them depending on how clear the glass is there.
//
// The pane of glass that holds the line being sung (the lens, glass.css) is a patch of this window
// that has just been wiped: clear, sharp, a little darker, with water standing at its edge and the
// drops gone. A small feedback texture remembers where the lens has been and lets the mist come
// back over a couple of seconds, so a pane gliding from line to line leaves a fading wipe behind it.

const RAIN_VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const RAIN_FRAG = `#version 300 es
precision highp float;

uniform vec2 uRes;
uniform float uTime;
uniform float uRain;   // how hard it rains, 0..1
uniform float uFlash;  // lightning, 0..1
uniform float uPulse;  // the beat, 0..1
uniform sampler2D uSharp;
uniform sampler2D uMid;
uniform sampler2D uFog;
uniform sampler2D uMask;  // where the glass has been wiped, 0..1 (see createRain)
out vec4 fragColor;

#define S smoothstep

float aspect;

float h11(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec4 h41(float n) { return fract(sin(n * vec4(12.9898, 78.233, 37.719, 93.989) + vec4(4.14, 1.32, 9.71, 2.55)) * 43758.5453); }
vec4 h42(vec2 p) {
	return fract(sin(vec4(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)), dot(p, vec2(419.2, 371.9)), dot(p, vec2(63.7, 91.3)))) * 43758.5453);
}
float vnoise(vec2 x) {
	vec2 i = floor(x), f = fract(x);
	f = f * f * (3. - 2. * f);
	return mix(mix(h21(i), h21(i + vec2(1., 0.)), f.x), mix(h21(i + vec2(0., 1.)), h21(i + vec2(1., 1.)), f.x), f.y);
}
float fbm(vec2 x) { return .62 * vnoise(x) + .38 * vnoise(x * 2.13 + 7.7); }

// ---- the night outside -----------------------------------------------------------------------
// Cars go by on the street: head lights one way, tail lights the other. How sharp the glass is
// there sets how big and soft each light is.
vec3 traffic(vec2 uv, float sharp) {
	vec3 acc = vec3(0.);
	float rad = mix(.05, .011, sharp);
	for (int i = 0; i < 4; i++) {
		float fi = float(i);
		vec4 r = h41(fi + 3.);
		float dir = (i % 2 == 0) ? 1. : -1.;
		float x = fract(dir * uTime / mix(24., 46., r.x) + r.y);
		float y = mix(.79, .9, r.z);
		vec3 col = dir > 0. ? vec3(1., .1, .06) : vec3(1., .86, .62);
		for (int k = 0; k < 2; k++) {
			vec2 c = vec2(x + (float(k) - .5) * mix(.026, .04, r.w), y);
			float d = length((uv - c) * vec2(aspect, 1.));
			acc += col * S(rad, rad * .3, d) * mix(.45, 1.15, sharp);
		}
	}
	return acc * .75;
}

vec3 world(vec2 uv, float sharp) {
	uv = clamp(uv, vec2(.003), vec2(.997));
	vec3 f = texture(uFog, uv).rgb;
	vec3 m = texture(uMid, uv).rgb;
	vec3 s = texture(uSharp, uv).rgb;
	vec3 c = mix(mix(f, m, S(0., .5, sharp)), s, S(.5, 1., sharp));
	c += traffic(uv, sharp);
	float lum = dot(c, vec3(.3, .59, .11));
	c *= 1. + uPulse * .3 * S(.2, .75, lum); // on the beat the lights swell
	c *= 1. + uFlash * .9;
	c += uFlash * vec3(.3, .42, .75) * S(.65, .0, uv.y) * .6; // lightning lights the low cloud
	return c;
}

// ---- drops ------------------------------------------------------------------------------------
struct Lens {
	float cov;   // how much of this pixel is inside a drop
	vec2 uv;     // where in the world it looks: a drop mirrors what is around it
	float rim;   // the dark edge of the drop
	float lit;   // the bright arc on its lower edge
	float spec;  // the sharp glint at its top
	float trail; // how clear the glass is here because a drop has run over it
	float edge;  // the thin bright line along each side of a trail, where the water stands
};

void lens(inout Lens L, vec2 p, vec2 c, float R, float squash, float K) {
	vec2 d = p - c;
	vec2 q = vec2(d.x, d.y / squash) / R;
	float r = length(q);
	float cov = S(1.03, .93, r);
	if (cov > L.cov) {
		L.cov = cov;
		L.uv = vec2(c.x / aspect, c.y) - vec2(d.x / aspect, d.y) * K; // inverted, and widened by K
		L.rim = S(.5, 1., r);
		vec2 n = q / max(r, .001);
		L.lit = S(.25, .95, dot(n, normalize(vec2(.55, .83)))) * S(.55, .95, r);
		L.spec = S(.42, .0, length(q - vec2(-.38, -.44)));
	}
}

// A drop slides down in four bursts, stalling in between (ph is 0..1 over its life).
float slide(float ph, vec4 r) {
	float a = mix(.12, .3, r.x), b = mix(.12, .3, r.y), c = mix(.1, .26, r.z);
	float d = max(1. - a - b - c, .14);
	float s = a * S(.05, .14, ph) + b * S(.3, .4, ph) + c * S(.55, .66, ph) + d * S(.78, .92, ph);
	return s / (a + b + c + d);
}

// How far a drop's path wanders sideways at height y.
float swayAt(float y, vec4 r) { return .006 * sin(y * 41. + r.w * 20.) + .0035 * sin(y * 103. + r.x * 9.); }

// A column of big drops: each column carries two, running out of step with each other.
void runners(inout Lens L, vec2 p, float colW, float rlo, float rhi, float seed, float speed) {
	float id = floor(p.x / colW);
	float cx = (id + .5) * colW;
	for (int k = 0; k < 2; k++) {
		vec4 r = h41(id * 7.13 + float(k) * 31.7 + seed);
		vec4 g = h41(id * 3.71 + float(k) * 11.3 + seed + 90.);
		if (r.x > mix(.4, 1., uRain)) continue;
		float T = mix(11., 25., r.y) / (speed * mix(.7, 1.5, uRain));
		float ph = fract(uTime / T + r.z);
		float y0 = mix(-.04, .62, g.x);
		float yh = y0 + slide(ph, g) * (1.2 - y0);
		float R = mix(rlo, rhi, g.y);
		float xo = (g.z - .5) * (colW - 3.4 * R);
		float x0 = cx + xo;
		// the drop itself
		lens(L, p, vec2(x0 + swayAt(yh, r), yh), R, 1.16, 2.5);
		// the trail it leaves: narrow at the start, wider toward the drop, and it fades as the life ends
		float k01 = clamp((p.y - y0) / max(yh - y0, .001), 0., 1.);
		float inT = S(y0 - .004, y0 + .02, p.y) * S(yh + .004, yh - .02, p.y);
		float w = R * (.13 + .55 * k01);
		float dx = abs(p.x - (x0 + swayAt(p.y, r)));
		float fade = S(1., .86, ph);
		L.trail = max(L.trail, S(w, w * .3, dx) * inT * fade);
		L.edge = max(L.edge, (S(w * 1.6, w * 1.08, dx) - S(w * 1.08, w * .72, dx)) * inT * fade * S(.02, .1, k01));
		// beads of water it drops along the way
		float by = p.y * 19. + g.w * 9.;
		float bi = floor(by);
		vec4 bh = h41(bi + id * 13. + seed + float(k) * 5.);
		if (bh.x < .38) {
			float bcy = (bi + .5 - g.w * 9.) / 19.;
			float inB = S(y0, y0 + .03, bcy) * S(yh - .01, yh - .05, bcy) * fade;
			if (inB > .5) lens(L, p, vec2(x0 + swayAt(bcy, r) + (bh.y - .5) * R * .9, bcy), R * mix(.22, .42, bh.z), 1.1, 2.2);
		}
	}
}

// Small beads that sit on the glass, come and go.
void beads(inout Lens L, vec2 p, float cs, float rmax, float seed, float dens) {
	vec2 g = p / cs;
	vec2 id = floor(g);
	vec4 h = h42(id + seed);
	if (h.w > dens * mix(.55, 1., uRain)) return;
	float life = fract(uTime / mix(14., 44., h.z) + h.x * 13.); // beads come and go, so the glass keeps changing
	float R = rmax * mix(.35, 1., h.y) * S(0., .06, life) * S(1., .8, life);
	if (R < .0015) return;
	vec2 c = (id + .5 + (h.xy - .5) * .38) * cs;
	lens(L, p, c, R, 1.12, 2.4);
}

void main() {
	aspect = uRes.x / uRes.y;
	vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1. - gl_FragCoord.y / uRes.y);
	vec2 p = vec2(uv.x * aspect, uv.y);

	Lens L = Lens(0., uv, 0., 0., 0., 0., 0.);
	runners(L, p, .17, .017, .03, 1., 1.);
	runners(L, p, .085, .0082, .0135, 40., 1.4);
	beads(L, p, .07, .02, 7., .55);
	beads(L, p, .034, .0102, 19., .62);
	beads(L, p, .017, .0052, 31., .5);

	// a wipe takes the water off the glass
	float m = texture(uMask, gl_FragCoord.xy / uRes).r;
	L.cov *= 1. - m;
	L.trail *= 1. - m;
	L.edge *= 1. - m;

	// the glass: misted, more toward the bottom, with patches wiped clearer here and there
	float wipe = S(.44, .8, fbm(p * 2.4 + vec2(3., uTime * .004)));
	vec2 haze = vec2(sin(p.y * 7. + uTime * .35), sin(p.x * 5. - uTime * .3)) * .0016 * (1. - m); // the mist shimmers a little
	vec3 col = world(uv + haze, max(wipe * .3, m * .94));
	col += vec3(.07, .1, .14) * (.35 + .65 * uv.y) * .55 * (1. - .75 * m);
	col *= 1. - .2 * m; // clear glass lets in the dark of the night; mist scatters light
	// the water left standing along the edge of a wiped patch: a bright line, and beads in it
	float ridge = m * (1. - m) * 4.;
	col += ridge * vec3(.5, .62, .85) * .12 * (.5 + vnoise(p * 70.));
	vec2 bg9 = gl_FragCoord.xy / 9.;
	vec4 br = h42(floor(bg9));
	float bead = step(.5, br.z) * S(.24, .1, length(fract(bg9) - .5 - (br.xy - .5) * .45)) * S(.1, .55, ridge);
	col += bead * vec3(.9, .95, 1.) * .55;       // beads of water along the edge
	col *= 1. - bead * .15 * (1. - ridge);

	// a trail is clear glass: the street is nearly sharp there, and bent a little, with water
	// standing along its two sides
	if (L.trail > .002) {
		vec2 uvT = uv + vec2(sin(p.y * 90.) * .0012, 0.);
		col = mix(col, mix(col, world(uvT, .62), .82) * 1.02, L.trail);
	}
	col += L.edge * vec3(.5, .62, .85) * .18;

	// a drop shows the street upside down and sharp, darker at its edge, with a glint on it
	if (L.cov > .002) {
		vec2 fringe = (L.uv - uv) * .045; // the lens bends red and blue a little differently
		vec3 d = vec3(world(L.uv + fringe, .94).r, world(L.uv, .94).g, world(L.uv - fringe, .94).b) * 1.35;
		d = mix(d, col * 1.15 + vec3(.02, .03, .05), .16); // some of the mist shows through
		d *= mix(1., .4, L.rim);
		d += L.lit * vec3(.5, .62, .8) * .5;
		d += L.spec * vec3(1., .97, .92) * .9;
		col = mix(col, d, L.cov);
	}

	// the window frame: a dark rim, with a thin lit edge where the glass meets it
	float rim = min(min(uv.x * aspect, (1. - uv.x) * aspect), min(uv.y, 1. - uv.y));
	float inFrame = S(.016, .012, rim);
	col = mix(col, vec3(.012, .016, .024), inFrame);
	col += S(.02, .016, rim) * (1. - inFrame) * vec3(.32, .4, .55) * .1;

	// grade: cool, a little desaturated, darker at the edges
	col = mix(vec3(dot(col, vec3(.3, .59, .11))), col, .9);
	col *= vec3(.95, 1., 1.07);
	col *= 1. - .55 * pow(length((uv - .5) * vec2(1.05, 1.25)), 2.3);
	col += (h21(gl_FragCoord.xy + fract(uTime) * 91.) - .5) * .014;
	fragColor = vec4(max(col, 0.), 1.);
}`;

// ---------------------------------------------------------------------------------------------
// Colour helpers (the album's accent tints the neon signs in the street)
// ---------------------------------------------------------------------------------------------

/** "rgb(…)", "rgba(…)", "color(srgb r g b)" or "#rgb"/"#rrggbb" → [r, g, b] (0-255), or null. */
export function parseCssColor(s) {
	if (typeof s !== "string") return null;
	s = s.trim().toLowerCase();
	let m = s.match(/^#([0-9a-f]{3,8})$/);
	if (m) {
		let h = m[1];
		if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
		if (h.length !== 6 && h.length !== 8) return null;
		return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
	}
	m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
	if (m) return [m[1], m[2], m[3]].map((v) => Math.max(0, Math.min(255, Math.round(Number(v)))));
	m = s.match(/^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
	if (m) return [m[1], m[2], m[3]].map((v) => Math.max(0, Math.min(255, Math.round(Number(v) * 255))));
	return null;
}

function rainHsl([r, g, b]) {
	r /= 255;
	g /= 255;
	b /= 255;
	const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
	if (mx === mn) return [0, 0, l];
	const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
	const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return [h * 60, s, l];
}

function rainRgb(h, s, l) {
	h = ((h % 360) + 360) % 360;
	const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
	const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

/** Two neon colours for the street ("r,g,b" strings): the accent made vivid, and one across the wheel
 *  from it. A dull accent (white, grey) falls back to a warm pink and a cool cyan. */
export function rainTint(rgb) {
	const [h, s] = rgb ? rainHsl(rgb) : [0, 0, 0];
	const base = s > 0.22 ? h : 330;
	return { a: rainRgb(base, 0.9, 0.58).join(","), b: rainRgb(base + (s > 0.22 ? 150 : 180), 0.85, 0.58).join(",") };
}

// ---------------------------------------------------------------------------------------------
// The street, painted once (512x288) and blurred three ways
// ---------------------------------------------------------------------------------------------
function rainRng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function rainGlow(g, x, y, r, rgb, a) {
	const k = g.createRadialGradient(x, y, 0, x, y, r);
	k.addColorStop(0, `rgba(${rgb},${a})`);
	k.addColorStop(1, `rgba(${rgb},0)`);
	g.fillStyle = k;
	g.fillRect(x - r, y - r, r * 2, r * 2);
}

const RAIN_WINDOWS = ["255,214,138", "255,243,208", "255,196,120", "181,212,255", "255,232,170"];

function rainSkyline(g, rnd, W, base, o) {
	let x = -10;
	while (x < W + 10) {
		const bw = o.minW + rnd() * (o.maxW - o.minW);
		const bh = o.minH + rnd() * (o.maxH - o.minH);
		g.fillStyle = o.fill;
		g.fillRect(x, base - bh, bw, bh + 40);
		if (rnd() < 0.35) g.fillRect(x + bw * 0.3, base - bh - 4 - rnd() * 8, bw * 0.12, 12); // a plant room on the roof
		const cw = o.ws * 2.2, ch = o.ws * 2.7;
		for (let wx = x + 3; wx < x + bw - cw - 2; wx += cw + 1.5) {
			for (let wy = base - bh + 5; wy < base - 4; wy += ch + 1.7) {
				if (rnd() > o.lit) continue;
				g.fillStyle = `rgba(${RAIN_WINDOWS[(rnd() * RAIN_WINDOWS.length) | 0]},${((0.35 + rnd() * 0.6) * o.dim).toFixed(2)})`;
				g.fillRect(wx, wy, o.ws, o.ws * 1.3);
			}
		}
		x += bw + rnd() * 3;
	}
}

function rainPaint(g, W, H, tint) {
	const rnd = rainRng(11);
	const sky = g.createLinearGradient(0, 0, 0, H);
	[[0, "#03050c"], [0.3, "#0a1226"], [0.55, "#182749"], [0.7, "#26294d"], [1, "#080b16"]].forEach(([o, c]) => sky.addColorStop(o, c));
	g.fillStyle = sky;
	g.fillRect(0, 0, W, H);
	// the city's glow on the low cloud
	rainGlow(g, W * 0.5, H * 0.62, W * 0.7, "255,150,90", 0.26);
	rainGlow(g, W * 0.16, H * 0.6, W * 0.34, tint.a, 0.2);
	rainGlow(g, W * 0.84, H * 0.58, W * 0.34, tint.b, 0.18);
	// two skylines: far and small, near and big
	rainSkyline(g, rnd, W, H * 0.74, { minH: H * 0.12, maxH: H * 0.34, minW: 14, maxW: 34, fill: "#0b1329", lit: 0.16, ws: 2.2, dim: 0.6 });
	rainSkyline(g, rnd, W, H * 0.77, { minH: H * 0.2, maxH: H * 0.5, minW: 26, maxW: 60, fill: "#060a17", lit: 0.26, ws: 3, dim: 1 });
	// red beacons on the towers
	g.globalCompositeOperation = "lighter";
	for (let i = 0; i < 4; i++) rainGlow(g, 30 + rnd() * (W - 60), H * (0.3 + rnd() * 0.08), 6, "255,60,50", 0.9);
	// neon signs: a rectangle, a ring, a zigzag
	const signs = [
		[0.1, 0.52, tint.a, "rect"],
		[0.33, 0.44, tint.b, "ring"],
		[0.62, 0.5, tint.a, "zig"],
		[0.86, 0.46, tint.b, "rect"],
	];
	for (const [fx, fy, rgb, kind] of signs) {
		const x = fx * W, y = fy * H;
		rainGlow(g, x, y, 34, rgb, 0.4);
		g.save();
		g.shadowColor = `rgb(${rgb})`;
		g.shadowBlur = 9;
		g.strokeStyle = `rgba(${rgb},0.95)`;
		g.lineWidth = 2;
		g.beginPath();
		if (kind === "rect") g.rect(x - 14, y - 8, 28, 16);
		else if (kind === "ring") g.arc(x, y, 10, 0, Math.PI * 2);
		else {
			g.moveTo(x - 16, y + 6);
			g.lineTo(x - 6, y - 8);
			g.lineTo(x + 4, y + 6);
			g.lineTo(x + 16, y - 8);
		}
		g.stroke();
		g.restore();
	}
	// the street: lamps, shop fronts, cars standing in the traffic
	const lights = [];
	for (let i = 0; i < 9; i++) lights.push([W * (0.04 + i * 0.115) + rnd() * 10, H * (0.72 + rnd() * 0.04), 3.2 + rnd() * 1.6, "255,190,108"]); // street lamps
	for (let i = 0; i < 6; i++) lights.push([rnd() * W, H * (0.8 + rnd() * 0.08), 2.4 + rnd() * 1.4, rnd() < 0.5 ? "255,52,44" : "255,236,190"]); // cars
	lights.push([W * 0.7, H * 0.7, 3, "60,255,140"], [W * 0.7, H * 0.66, 3, "255,60,50"]); // a traffic light
	// the road, wet: a dark surface and each light smeared down it
	const road = g.createLinearGradient(0, H * 0.77, 0, H);
	road.addColorStop(0, "rgba(10,14,28,0.9)");
	road.addColorStop(1, "rgba(4,6,14,1)");
	g.globalCompositeOperation = "source-over";
	g.fillStyle = road;
	g.fillRect(0, H * 0.77, W, H);
	g.globalCompositeOperation = "lighter";
	for (const [x, y, r, rgb] of lights) {
		rainGlow(g, x, y, r * 6, rgb, 0.45);
		rainGlow(g, x, y, r * 2, rgb, 0.95);
		const sm = g.createLinearGradient(0, y + r, 0, Math.min(H, y + r + 46));
		sm.addColorStop(0, `rgba(${rgb},0.34)`);
		sm.addColorStop(1, `rgba(${rgb},0)`);
		g.fillStyle = sm;
		g.fillRect(x - r * 0.9, y + r, r * 1.8, 46);
	}
	g.globalCompositeOperation = "source-over";
}

// ---------------------------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------------------------

// The wipe: a small texture, fed back to itself every frame, that remembers where the lens has been.
const MASK_W = 192;
const MASK_H = 108;
const MASK_HALF_LIFE = 1.7; // seconds for a wiped patch to be half misted over again

const MASK_FRAG = `#version 300 es
precision highp float;
uniform vec2 uMaskRes;
uniform vec4 uRect;    // the lens as fractions of the screen (x0, y0, x1, y1, y down); x1 < x0 means no lens
uniform float uDecay;  // how much of last frame's wipe is left
uniform float uAspect;
uniform sampler2D uPrev;
out vec4 o;
float sdRoundBox(vec2 p, vec2 b, float r) {
	vec2 q = abs(p) - b + r;
	return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r;
}
void main() {
	vec2 g = gl_FragCoord.xy / uMaskRes;
	float prev = texture(uPrev, g).r;
	vec2 uv = vec2(g.x, 1. - g.y);
	float m = 0.;
	if (uRect.z > uRect.x) {
		vec2 k = vec2(uAspect, 1.);
		vec2 c = (uRect.xy + uRect.zw) * .5;
		vec2 h = (uRect.zw - uRect.xy) * .5 * k;
		float d = sdRoundBox((uv - c) * k, h, min(.04, min(h.x, h.y)));
		m = smoothstep(.016, -.016, d);
	}
	o = vec4(max(prev * uDecay, m), 0., 0., 1.);
}`;

/**
 * createRain(canvas, root, bg, getLens): draws into `canvas`. `root` (.aur-root) and `bg` (.aur-bg) are read
 * for the signals that drive the scene: data-gap on root (an instrumental break: it rains harder)
 * and data-bt / data-bar on bg (the beat and the bar, flipping a/b). getLens() returns the box of the
 * lens pane on the page (null when there is none), which is wiped clear.
 * Returns { init, start, stop, still, flash, ok, running }; ok is null until init() has run.
 */
export function createRain(canvas, root, bg, getLens) {
	const S = {
		gl: null, loc: {}, tex: [], ok: null, running: false, raf: 0, last: 0, t0: 0, still: false,
		scale: 0.5, w: 0, h: 0, sized: false, tintKey: "", tintAt: 0, dts: [],
		flashAt: -1e9, nextFlash: 0, pulse: 0, bt: "", bar: "", rain: 0.55, lastNow: 0, lastWipe: 0, mask: null, prog: null,
	};
	const FRAME_MS = 1000 / 30;
	const TEX = 3;
	let observer = null;

	function compile(gl, type, src) {
		const sh = gl.createShader(type);
		gl.shaderSource(sh, src);
		gl.compileShader(sh);
		if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || "shader");
		return sh;
	}

	/** The wipe's two textures and the pass that updates them. */
	function initMask(gl) {
		const prog = gl.createProgram();
		gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, RAIN_VERT));
		gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, MASK_FRAG));
		gl.bindAttribLocation(prog, 0, "aPos");
		gl.linkProgram(prog);
		if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "mask link");
		const loc = {};
		for (const n of ["uMaskRes", "uRect", "uDecay", "uAspect", "uPrev"]) loc[n] = gl.getUniformLocation(prog, n);
		const tex = [];
		const fbo = [];
		for (let i = 0; i < 2; i++) {
			const t = gl.createTexture();
			gl.activeTexture(gl.TEXTURE4);
			gl.bindTexture(gl.TEXTURE_2D, t);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, MASK_W, MASK_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			const f = gl.createFramebuffer();
			gl.bindFramebuffer(gl.FRAMEBUFFER, f);
			gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
			if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("mask framebuffer");
			gl.clearColor(0, 0, 0, 1);
			gl.clear(gl.COLOR_BUFFER_BIT);
			tex.push(t);
			fbo.push(f);
		}
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		return { prog, loc, tex, fbo, cur: 0 };
	}

	/** One step of the wipe: last frame's mist-free glass fades a little, and the lens wipes its own place clear. */
	function wipeStep(w, h, dt) {
		const gl = S.gl;
		const g = S.mask;
		let rect = [1, 1, 0, 0];
		try {
			const r = getLens?.();
			const c = canvas.getBoundingClientRect();
			if (r && r.width > 0 && r.height > 0 && c.width > 0) rect = [(r.left - c.left) / c.width, (r.top - c.top) / c.height, (r.right - c.left) / c.width, (r.bottom - c.top) / c.height];
		} catch {}
		gl.bindFramebuffer(gl.FRAMEBUFFER, g.fbo[1 - g.cur]);
		gl.viewport(0, 0, MASK_W, MASK_H);
		gl.useProgram(g.prog);
		gl.activeTexture(gl.TEXTURE4);
		gl.bindTexture(gl.TEXTURE_2D, g.tex[g.cur]);
		gl.uniform1i(g.loc.uPrev, 4);
		gl.uniform2f(g.loc.uMaskRes, MASK_W, MASK_H);
		gl.uniform4f(g.loc.uRect, rect[0], rect[1], rect[2], rect[3]);
		gl.uniform1f(g.loc.uDecay, dt < 0 ? 0 : Math.pow(0.5, dt / MASK_HALF_LIFE));
		gl.uniform1f(g.loc.uAspect, w / h);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
		g.cur = 1 - g.cur;
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, w, h);
		gl.useProgram(S.prog);
		gl.activeTexture(gl.TEXTURE3);
		gl.bindTexture(gl.TEXTURE_2D, g.tex[g.cur]);
	}

	function init() {
		if (S.ok !== null) return S.ok;
		S.ok = false;
		try {
			const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
			if (!gl) return false;
			const prog = gl.createProgram();
			gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, RAIN_VERT));
			gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, RAIN_FRAG));
			gl.bindAttribLocation(prog, 0, "aPos"); // both programs read the same triangle from attribute 0
			gl.linkProgram(prog);
			if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "link");
			gl.useProgram(prog);
			const buf = gl.createBuffer();
			gl.bindBuffer(gl.ARRAY_BUFFER, buf);
			gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
			const a = gl.getAttribLocation(prog, "aPos");
			gl.enableVertexAttribArray(a);
			gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
			for (const n of ["uRes", "uTime", "uRain", "uFlash", "uPulse", "uSharp", "uMid", "uFog", "uMask"]) S.loc[n] = gl.getUniformLocation(prog, n);
			for (let i = 0; i < TEX; i++) {
				const t = gl.createTexture();
				gl.activeTexture(gl.TEXTURE0 + i);
				gl.bindTexture(gl.TEXTURE_2D, t);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
				S.tex.push(t);
			}
			gl.uniform1i(S.loc.uSharp, 0);
			gl.uniform1i(S.loc.uMid, 1);
			gl.uniform1i(S.loc.uFog, 2);
			gl.uniform1i(S.loc.uMask, 3);
			S.prog = prog;
			S.mask = initMask(gl);
			gl.useProgram(prog);
			S.gl = gl;
			canvas.style.color = "var(--aur-accent)"; // read back later, to tint the neon in the street
			canvas.addEventListener("webglcontextlost", (e) => {
				e.preventDefault();
				stop();
				S.ok = false;
				root.dataset.gl = "off";
			});
			if (typeof ResizeObserver === "function") {
				observer = new ResizeObserver((es) => {
					const r = es[0]?.contentRect;
					if (!r) return;
					S.w = r.width;
					S.h = r.height;
					S.sized = true;
					if (S.still && S.running === false && S.ok) requestAnimationFrame(() => draw(performance.now()));
				});
				observer.observe(canvas);
			}
			S.ok = true;
		} catch (err) {
			console.warn("[Aurora Lyrics] rain: WebGL scene unavailable, using the CSS one:", err?.message || err);
			S.ok = false;
		}
		return S.ok;
	}

	/** The colours of the neon in the street follow the album's accent (read from the CSS). */
	function readTint() {
		let rgb = null;
		try {
			rgb = parseCssColor(getComputedStyle(canvas).color);
		} catch {}
		return rainTint(rgb);
	}

	/** Paint the street and upload it, when it hasn't been yet or when the accent has changed (checked
	 *  every second and a half, not every frame, since reading the colour costs a style calculation). */
	function upload(now) {
		if (S.tintKey && now - S.tintAt < 1500) return;
		S.tintAt = now;
		const gl = S.gl;
		const tint = readTint();
		const key = tint.a + "|" + tint.b;
		if (key === S.tintKey) return;
		S.tintKey = key;
		const W = 512, H = 288;
		const base = document.createElement("canvas");
		base.width = W;
		base.height = H;
		rainPaint(base.getContext("2d"), W, H, tint);
		// sharp (barely softened), mid, and fog: the blur in px of the 512-wide picture
		[0.7, 3.6, 11].forEach((blur, i) => {
			const c = document.createElement("canvas");
			c.width = W;
			c.height = H;
			const g = c.getContext("2d");
			g.filter = `blur(${blur}px)`;
			const m = Math.ceil(blur * 2); // draw a little larger so the blur has no dark edge
			g.drawImage(base, -m, -m, W + m * 2, H + m * 2);
			gl.activeTexture(gl.TEXTURE0 + i);
			gl.bindTexture(gl.TEXTURE_2D, S.tex[i]);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
		});
	}

	function signals(now) {
		const dt = Math.min(0.25, Math.max(0, (now - S.lastNow) / 1000));
		S.lastNow = now;
		const gap = root.dataset.gap === "on";
		S.rain += ((gap ? 0.95 : 0.55) - S.rain) * Math.min(1, dt * 0.6);
		S.pulse *= Math.exp(-dt / 0.16);
		if (bg.dataset.bt && bg.dataset.bt !== S.bt) S.pulse = Math.max(S.pulse, 0.7);
		if (bg.dataset.bar && bg.dataset.bar !== S.bar) {
			S.pulse = 1;
			if (Math.random() < 0.06 && now - S.flashAt > 7000) S.flashAt = now; // now and then a bar brings lightning
		}
		S.bt = bg.dataset.bt || "";
		S.bar = bg.dataset.bar || "";
		if (now >= S.nextFlash) {
			if (S.nextFlash) S.flashAt = now;
			S.nextFlash = now + (gap ? 5000 + Math.random() * 8000 : 13000 + Math.random() * 26000);
		}
		const f = (now - S.flashAt) / 1000;
		const flash = f < 0 || f > 1.2 ? 0 : Math.max(f < 0.6 ? Math.exp(-f / 0.08) : 0, f > 0.18 ? 0.7 * Math.exp(-(f - 0.18) / 0.13) : 0);
		return flash * 0.85;
	}

	function draw(now) {
		const gl = S.gl;
		if (!gl || !S.sized || !S.w || !S.h) return;
		const w = Math.max(64, Math.round(S.w * S.scale)), h = Math.max(36, Math.round(S.h * S.scale));
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w;
			canvas.height = h;
			gl.viewport(0, 0, w, h);
		}
		upload(now);
		const dtWipe = S.still ? -1 : Math.min(0.25, Math.max(0, (now - S.lastWipe) / 1000));
		S.lastWipe = now;
		wipeStep(w, h, dtWipe);
		const flash = S.still ? 0 : signals(now);
		const t = S.still ? 41 : ((now - S.t0) / 1000) % 100000;
		gl.uniform2f(S.loc.uRes, w, h);
		gl.uniform1f(S.loc.uTime, t);
		gl.uniform1f(S.loc.uRain, S.rain);
		gl.uniform1f(S.loc.uFlash, flash);
		gl.uniform1f(S.loc.uPulse, S.pulse);
		gl.drawArrays(gl.TRIANGLES, 0, 3);
	}

	function loop(now) {
		S.raf = 0;
		if (!S.running) return;
		S.raf = requestAnimationFrame(loop);
		if (now - S.last < FRAME_MS - 2) return;
		// if frames arrive far slower than asked for, the machine is struggling: draw fewer pixels
		S.dts.push(now - S.last);
		S.last = now;
		if (S.dts.length >= 90) {
			const avg = S.dts.reduce((a, b) => a + b, 0) / S.dts.length;
			S.dts.length = 0;
			if (avg > FRAME_MS * 1.7 && S.scale > 0.3) S.scale = Math.max(0.3, S.scale * 0.8);
		}
		draw(now);
	}

	/** Animate. */
	function start() {
		if (!S.ok || S.running) return;
		S.still = false;
		S.running = true;
		if (!S.t0) S.t0 = performance.now();
		S.lastNow = performance.now();
		if (!S.nextFlash) S.nextFlash = S.lastNow + 6000 + Math.random() * 8000;
		S.raf = requestAnimationFrame(loop);
	}

	function stop() {
		S.running = false;
		if (S.raf) cancelAnimationFrame(S.raf);
		S.raf = 0;
	}

	/** One still frame (the animated background is off). */
	function still() {
		if (!S.ok) return;
		stop();
		S.still = true;
		requestAnimationFrame(() => draw(performance.now()));
	}

	/** Lightning, now. */
	function flash() {
		S.flashAt = performance.now();
	}

	return { init, start, stop, still, flash, get ok() { return S.ok; }, get running() { return S.running; } };
}
