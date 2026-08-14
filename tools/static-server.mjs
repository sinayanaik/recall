// A minimal concurrent static server for the browser-driven checks.
// python3 -m http.server is single-threaded, which serialises the 130 module
// requests and makes any timing measurement meaningless.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.argv[2];
const port = Number(process.argv[3]);
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json"
};

http.createServer(async (req, res) => {
  const clean = decodeURIComponent(req.url.split("?")[0]);
  const file = path.join(root, clean === "/" ? "/index.html" : clean);
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(port, "127.0.0.1");
