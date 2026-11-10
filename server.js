import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PORT, PATHS } from './src/config.js';
import { openDb } from './src/db.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.pdf': 'application/pdf', '.json': 'application/json; charset=utf-8',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

/** Serve `rel` from `dir`; refuses anything that resolves outside `dir`. */
function serveFile(res, dir, rel) {
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { return send(res, 400, 'bad path'); }
  const file = path.resolve(dir, '.' + path.sep + decoded);
  if (file !== dir && !file.startsWith(dir + path.sep)) return send(res, 404, 'not found');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, buf, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}

// Route table: [method, regex, handler(req, res, match, url)]. First match wins.
// Pipeline task: add /api/* routes here, above the static catch-all.
const routes = [
  ['GET', /^\/healthz$/, (req, res) => send(res, 200, 'ok')],
  ['GET', /^\/samples\/(.+)$/, (req, res, m) => serveFile(res, PATHS.samples, m[1])],
  ['GET', /^\/(.*)$/, (req, res, m) => serveFile(res, PATHS.public, m[1] || 'index.html')],
];

openDb();

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  for (const [method, re, handler] of routes) {
    const m = url.pathname.match(re);
    if (m && req.method === method) {
      return Promise.resolve(handler(req, res, m, url)).catch((e) => {
        console.error(e);
        if (!res.headersSent) send(res, 500, 'internal error');
      });
    }
  }
  send(res, 404, 'not found');
}).listen(PORT, () => console.log(`listening on :${PORT}`));
