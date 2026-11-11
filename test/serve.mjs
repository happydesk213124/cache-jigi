// 화면 시험용 정적 서버: node test/serve.mjs → http://localhost:5178/test/ui.html
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };
const port = Number(process.env.PORT || 5178);

http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const file = path.normalize(path.join(root, decodeURIComponent(url.pathname === '/' ? '/test/ui.html' : url.pathname)));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    try {
        const body = await readFile(file);
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(body);
    } catch {
        res.writeHead(404).end('not found');
    }
}).listen(port, () => console.log(`http://localhost:${port}/test/ui.html`));
