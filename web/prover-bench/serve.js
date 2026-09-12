// Minimal static server for the prover benchmark. No dependencies.
// Serves the repository root so /web/prover-bench/ and /fixtures/ are reachable,
// binds all interfaces so a phone on the same network can open it.
//
//   node web/prover-bench/serve.js [port]          plain http
//   node web/prover-bench/serve.js [port] --https  https with certs/ (see README)
//
// wasm threads need a cross-origin isolated page, which needs a secure
// context: http://localhost works on the PC, but the phone needs https. With
// a self-signed certificate Chrome shows a warning once; tap Advanced and
// proceed, after that the page counts as secure.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const useHttps = args.includes('--https');
const port = Number(args.find((a) => /^\d+$/.test(a)) ?? (useHttps ? 4391 : 4390));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.json': 'application/json',
  '.ts': 'text/plain',
};

function handler(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(root, rel);
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      // Cross-origin isolation, required for SharedArrayBuffer and so for wasm threads.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    res.end(data);
  });
}

let server;
if (useHttps) {
  const certDir = path.join(__dirname, 'certs');
  const key = path.join(certDir, 'key.pem');
  const cert = path.join(certDir, 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    console.error(`missing ${key} or ${cert}; create them with:\n` +
      `  openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=neptune-vault-bench" ` +
      `-addext "subjectAltName=IP:<pc-ip>,DNS:localhost" -keyout ${key} -out ${cert}`);
    process.exit(1);
  }
  server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, handler);
} else {
  server = http.createServer(handler);
}

const scheme = useHttps ? 'https' : 'http';
server.listen(port, '0.0.0.0', () => {
  const addrs = Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
  console.log(`serving ${root}`);
  console.log(`local:  ${scheme}://localhost:${port}/web/prover-bench/`);
  for (const a of addrs) console.log(`phone:  ${scheme}://${a}:${port}/web/prover-bench/`);
});
