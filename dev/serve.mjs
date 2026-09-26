// Tiny static server for the preview harness: node dev/serve.mjs → http://localhost:5178/dev/preview.html
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5178;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json" };

createServer(async (req, res) => {
	const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
	if (path === "/") return res.writeHead(302, { location: "/dev/preview.html" }).end();
	const file = normalize(join(ROOT, path));
	if (!file.startsWith(ROOT)) return res.writeHead(403).end();
	try {
		const body = await readFile(file);
		res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" }).end(body);
	} catch {
		res.writeHead(404).end("not found");
	}
}).listen(PORT, () => console.log(`preview: http://localhost:${PORT}/dev/preview.html`));
