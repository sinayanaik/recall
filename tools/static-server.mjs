// A minimal concurrent static server for the browser-driven checks.
// python3 -m http.server is single-threaded, which serialises the 130 module
// requests and makes any timing measurement meaningless.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.argv[2];
// Port 0 means "any free port", and the chosen one is printed on stdout for the
// caller to read. Fixed ports made the browser-driven checks quietly
// unreliable: a server left behind by an interrupted run keeps the port, the
// next run's bind fails, and the STALE server answers — serving a different
// tree, so the comparison is against something nobody intended.
const port = Number(process.argv[3] || 0);
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json",
  ".gif": "image/gif", ".webm": "video/webm", ".mp4": "video/mp4"
};

http.createServer(async (req, res) => {
  const clean = decodeURIComponent(req.url.split("?")[0]);
  const file = path.join(root, clean === "/" ? "/index.html" : clean);
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  try {
    const body = await readFile(file);
    const headers = {
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
      "accept-ranges": "bytes"
    };
    // One byte range, as a browser asks for a video it means to seek in.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2]));
      let end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      if (start >= body.length || start > end) {
        res.writeHead(416, { "content-range": `bytes */${body.length}` });
        res.end();
        return;
      }
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${body.length}`, "content-length": end - start + 1 });
      res.end(body.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(port, "127.0.0.1", function () {
  process.stdout.write(String(this.address().port) + "\n");
});
