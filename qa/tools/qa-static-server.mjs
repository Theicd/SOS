import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';

const root = process.cwd();
const port = Number(process.env.PORT || 8788);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  try {
    let p = decodeURIComponent(url.parse(req.url).pathname || '/');
    if (p === '/') p = '/videos.html';
    const fp = path.normalize(path.join(root, p));
    if (!fp.startsWith(root)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    fs.readFile(fp, (e, b) => {
      if (e) {
        res.writeHead(404);
        return res.end('missing');
      }
      res.writeHead(200, {
        'Content-Type': mime[path.extname(fp)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(b);
    });
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log('QA_HTTP_LISTEN', port, root);
});
