// Minimal static server for the prover benchmark. No dependencies.
// Serves the repository root so /web/prover-bench/ and /fixtures/ are reachable,
// binds all interfaces so a phone on the same network can open it.
//
//   node web/prover-bench/serve.js [port]
//
// Then open http://<this-machine-ip>:<port>/web/prover-bench/ on the phone.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.resolve(__dirname, '..', '..');
const port = Number(process.argv[2] ?? 4390);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.json': 'application/json',
  '.ts': 'text/plain',
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(root, rel);
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      // Cross-origin isolation, so a later threaded build can use SharedArrayBuffer.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    res.end(data);
  });
}).listen(port, '0.0.0.0', () => {
  const addrs = Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
  console.log(`serving ${root}`);
  console.log(`local:  http://localhost:${port}/web/prover-bench/`);
  for (const a of addrs) console.log(`phone:  http://${a}:${port}/web/prover-bench/`);
});
