// Network helpers.
//
// Why not Spicetify.CosmosAsync for third-party hosts: on Spotify 1.3.x the Spicetify
// wrapper's version check sends every CosmosAsync call to Spotify's native resolver,
// which throws "Resolver not found" for non-Spotify URLs, and custom headers are dropped
// on every path. So:
//   - CORS-enabled hosts (LRCLIB, Unison, Musixmatch desktop API) → plain fetch()
//   - hosts without CORS (NetEase, Musixmatch mobile API) → Spicetify's CORS proxy
//   - Spotify's own endpoints → fetch() with the user's access token (spclient allows the
//     client origin), CosmosAsync only as a fallback.

import { fetchWithTimeout } from "./util.js";

const DEFAULT_PROXY = "https://cors-proxy.spicetify.app/{url}";

/** Wrap a URL with the CORS proxy (honours Spicetify's own "spicetify:corsProxyTemplate"). */
export function corsProxy(url) {
	let tpl = DEFAULT_PROXY;
	try {
		const custom = globalThis.localStorage?.getItem("spicetify:corsProxyTemplate");
		if (custom && custom.includes("{url}")) tpl = custom;
	} catch {
		/* storage blocked */
	}
	return tpl.replace("{url}", url);
}

/**
 * GET a URL and parse JSON. HTTP errors don't throw: check `ok` / `status`.
 * Network failures and timeouts do throw.
 * @returns {Promise<{ status: number, ok: boolean, json: any, headers: Headers }>}
 */
export async function getJSON(url, { signal, headers, proxy = false, timeout = 9000 } = {}) {
	const res = await fetchWithTimeout(proxy ? corsProxy(url) : url, { signal, headers }, timeout);
	let json = null;
	try {
		json = await res.json();
	} catch {
		/* not JSON (e.g. an HTML error page) */
	}
	return { status: res.status, ok: res.ok, json, headers: res.headers };
}

/** Headers for Spotify's own APIs, or null if no access token is available. */
export function spotifyAuthHeaders() {
	const S = globalThis.Spicetify;
	const token = S?.Platform?.AuthorizationAPI?.getState?.()?.token?.accessToken;
	if (!token) return null;
	const headers = { Authorization: `Bearer ${token}` };
	if (S.Platform?.PlatformData?.app_platform) headers["App-Platform"] = S.Platform.PlatformData.app_platform;
	if (S.Platform?.version) headers["Spotify-App-Version"] = S.Platform.version;
	return headers;
}
