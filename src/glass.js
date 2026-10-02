// Liquid-glass refraction.
//
// A pane of thick glass bends what is behind it, most at its edge. The browser can do the same to
// the backdrop of an element: `backdrop-filter: url(#filter)` runs an SVG filter over the pixels
// behind it, and feDisplacementMap moves each pixel by an amount read from an image. The image here
// is a map of how far to move (red = across, green = down; grey = not at all): grey in the middle of
// the pane, and a band along each edge where the shift grows towards the edge, pulling the picture
// at the rim towards the middle, like looking through the curved lip of a glass.
//
// The maps are SVG made of gradients stuck to the four sides (the right and bottom ones sit in a
// nested <svg> placed at 100%), so a single filter fits an element of any size and keeps its rim the
// same number of pixels wide while the element grows and shrinks. Two displacement passes (across,
// then down) add up to the 2-D shift.
//
// Sizes: "s" for small chips and buttons, "m" for the player bar, "l" for the lens behind the lyric.
// A shift can't be more than about 0.85 x rim / power or the rim folds over itself and the picture
// repeats; the table keeps clear of that.

export const GLASS_SIZES = {
	s: { rim: 16, shift: 6, power: 1.6 },
	m: { rim: 28, shift: 11, power: 1.7 },
	l: { rim: 44, shift: 17, power: 1.8 },
};

/** One axis of a refraction map as an SVG image URL. axis "x": red varies; "y": green varies. */
export function glassMapUri(axis, rim, power) {
	const val = (sign, f) => Math.round(128 + sign * f * 127);
	const stops = (sign) =>
		Array.from({ length: 9 }, (_, i) => {
			const t = i / 8;
			const v = val(sign, Math.pow(1 - t, power));
			return `<stop offset='${t}' stop-color='rgb(${axis === "x" ? `${v},128,128` : `128,${v},128`})'/>`;
		}).join("");
	const g = (id, x1, y1, x2, y2, sign) => `<linearGradient id='${id}' x1='${x1}' y1='${y1}' x2='${x2}' y2='${y2}'>${stops(sign)}</linearGradient>`;
	const svg =
		axis === "x"
			? `<svg xmlns='http://www.w3.org/2000/svg' width='100%' height='100%' preserveAspectRatio='none'><defs>${g("a", 0, 0, 1, 0, 1)}${g("b", 1, 0, 0, 0, -1)}</defs>` +
				`<rect width='100%' height='100%' fill='rgb(128,128,128)'/><rect width='${rim}' height='100%' fill='url(#a)'/>` +
				`<svg x='100%' width='1' height='100%' overflow='visible'><rect x='${-rim}' width='${rim}' height='100%' fill='url(#b)'/></svg></svg>`
			: `<svg xmlns='http://www.w3.org/2000/svg' width='100%' height='100%' preserveAspectRatio='none'><defs>${g("a", 0, 0, 0, 1, 1)}${g("b", 0, 1, 0, 0, -1)}</defs>` +
				`<rect width='100%' height='100%' fill='rgb(128,128,128)'/><rect width='100%' height='${rim}' fill='url(#a)'/>` +
				`<svg y='100%' width='100%' height='1' overflow='visible'><rect y='${-rim}' width='100%' height='${rim}' fill='url(#b)'/></svg></svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * The hidden <svg> that holds the refraction filters (#aur-rf-s / -m / -l). Append it to the overlay;
 * styles.css names them in backdrop-filter. Returns the element.
 */
export function createGlassDefs() {
	const ns = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(ns, "svg");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("width", "0");
	svg.setAttribute("height", "0");
	svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
	svg.innerHTML =
		"<defs>" +
		Object.entries(GLASS_SIZES)
			.map(
				([id, { rim, shift, power }]) =>
					`<filter id="aur-rf-${id}" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">` +
					`<feImage href="${glassMapUri("x", rim, power)}" result="mx" preserveAspectRatio="none"/>` +
					`<feImage href="${glassMapUri("y", rim, power)}" result="my" preserveAspectRatio="none"/>` +
					`<feDisplacementMap in="SourceGraphic" in2="mx" scale="${shift * 2}" xChannelSelector="R" yChannelSelector="B" result="across"/>` +
					`<feDisplacementMap in="across" in2="my" scale="${shift * 2}" xChannelSelector="B" yChannelSelector="G"/>` +
					`</filter>`,
			)
			.join("") +
		"</defs>";
	return svg;
}
