// The parts every scene shares (scenes.js draws them): the vertex shader and the head of a fragment
// shader (the signals a scene is driven by, and a few small helpers).

export const SCENE_VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

export const SCENE_HEAD = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uA;      // the theme's colours, from the album's accent (0..1)
uniform vec3 uB;
uniform vec3 uC;
uniform vec3 uBase;   // the album's deep colour, darkened: the tint of the dark
uniform float uBeat;  // 1 on a beat, falling away
uniform float uBar;   // 1 on the first beat of a bar
uniform float uLine;  // 1 when a new line starts
uniform float uLineId;// which of the scene's parts that new line wakes (0..4)
uniform float uGap;   // 0..1: an instrumental break
uniform float uSong;  // how far through the song, 0..1
uniform vec4 uText;   // where the lyrics are (x0, y0, x1, y1 in 0..1, y down): a scene keeps its brightest parts clear of it
uniform vec4 uMeta;   // and the song title beside the cover
out vec4 fragColor;

// smoothstep that is happy with its edges either way round
float sst(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0., 1.); return t * t * (3. - 2. * t); }
float h11(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec4 h42(vec2 p) {
	return fract(sin(vec4(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)), dot(p, vec2(419.2, 371.9)), dot(p, vec2(63.7, 91.3)))) * 43758.5453);
}
float vnoise(vec2 x) {
	vec2 i = floor(x), f = fract(x);
	f = f * f * (3. - 2. * f);
	return mix(mix(h21(i), h21(i + vec2(1., 0.)), f.x), mix(h21(i + vec2(0., 1.)), h21(i + vec2(1., 1.)), f.x), f.y);
}
float fbm(vec2 x) { return .5 * vnoise(x) + .3 * vnoise(x * 2.07 + 7.7) + .2 * vnoise(x * 4.3 + 3.1); }
float sdSeg(vec2 p, vec2 a, vec2 b) {
	vec2 pa = p - a, ba = b - a;
	return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0., 1.));
}
// 1 inside a box (feathered), 0 outside
float inBox(vec4 r, vec2 uv) {
	float bx = sst(r.x - .03, r.x + .06, uv.x) * sst(r.z + .03, r.z - .06, uv.x);
	float by = sst(r.y - .04, r.y + .08, uv.y) * sst(r.w + .02, r.w - .1, uv.y);
	return bx * by;
}
// 1 where there are words to read (the lyrics, the song title), 0 elsewhere
float inText(vec2 uv) { return max(inBox(uText, uv), inBox(uMeta, uv)); }
`;
