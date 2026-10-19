import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PINDO_PORT || 8787);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  let file = decodeURIComponent(url.pathname);
  if (file === "/") file = "/index.html";
  const abs = path.normalize(path.join(root, file));
  if (!abs.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(abs, (err, data) => {
    if (err) {
      res.writeHead(err.code === "ENOENT" ? 404 : 500);
      res.end(err.code === "ENOENT" ? "Not found" : "Error");
      return;
    }
    res.writeHead(200, { "Content-Type": types[path.extname(abs)] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`http://127.0.0.1:${port}/`);
});
