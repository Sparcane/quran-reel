/* global __dirname, URL */
// Minimal static server for the exported app. Playwright needs a real origin
// (and a secure context) to run workers and codecs; `file://` will not do.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'apps', 'web', 'out');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

http
  .createServer((request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    let relative = pathname.replace(/^\/+/, '');
    if (relative.endsWith('/')) relative += 'index.html';
    else if (!path.extname(relative)) relative += '/index.html';

    let file = path.join(root, relative);
    if (!file.startsWith(root)) {
      response.writeHead(403).end();
      return;
    }

    // The static export ships only /rendu/_/ for the dynamic result route. A
    // real host rewrites /rendu/<id> to that page (see apps/web/vercel.json);
    // mirror it here so the journey exercises the same behaviour. The browser
    // keeps the original URL, so useParams() still sees the real job id.
    if (!fs.existsSync(file)) {
      const resultRoute = relative.match(/^rendu\/[^/]+\/(.*)$/);
      if (resultRoute) {
        const fallback = path.join(root, 'rendu', '_', resultRoute[1]);
        if (fs.existsSync(fallback)) file = fallback;
      }
    }

    fs.readFile(file, (error, bytes) => {
      if (error) {
        response.writeHead(404).end('not found');
        return;
      }
      response.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      response.end(bytes);
    });
  })
  .listen(3100, '127.0.0.1');
