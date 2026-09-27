// Custom background: an image or video the user picks, stored in IndexedDB (files are far too
// big for localStorage). Settings only keep a small description ({ kind, name, size }); the
// file itself lives here and is served to the overlay as an object URL.

const MEDIA_DB = "aurora-lyrics";
const MEDIA_STORE = "media";
const BG_KEY = "custom-bg";
export const MAX_MEDIA_BYTES = 300 * 1024 * 1024;

let dbPromise = null;
function db() {
	if (!dbPromise) {
		dbPromise = new Promise((resolve, reject) => {
			const req = indexedDB.open(MEDIA_DB, 1);
			req.onupgradeneeded = () => req.result.createObjectStore(MEDIA_STORE);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}
	return dbPromise;
}

function tx(mode, run) {
	return db().then(
		(d) =>
			new Promise((resolve, reject) => {
				const t = d.transaction(MEDIA_STORE, mode);
				const req = run(t.objectStore(MEDIA_STORE));
				t.oncomplete = () => resolve(req?.result);
				t.onerror = () => reject(t.error);
				t.onabort = () => reject(t.error);
			}),
	);
}

/** "image" / "video" for a supported file, else null. */
export function mediaKind(type) {
	if (/^image\/(png|jpe?g|webp|gif|avif|bmp)$/i.test(type || "")) return "image";
	if (/^video\/(mp4|webm|ogg|quicktime)$/i.test(type || "")) return "video";
	return null;
}

/** Store the file; resolves the settings description. Throws a readable Error when invalid. */
export async function saveBackground(file) {
	const kind = mediaKind(file?.type);
	if (!kind) throw new Error("Pick an image (PNG, JPG, WebP, GIF) or a video (MP4, WebM)");
	if (file.size > MAX_MEDIA_BYTES) throw new Error("That file is too large (max 300 MB)");
	await tx("readwrite", (s) => s.put(file, BG_KEY));
	return { kind, name: file.name, size: file.size };
}

export function loadBackground() {
	return tx("readonly", (s) => s.get(BG_KEY));
}

export function removeBackground() {
	return tx("readwrite", (s) => s.delete(BG_KEY));
}
