import { execSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';

import { defineConfig, type Plugin } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD').toString().trim();
} catch {
  // Not a git checkout (a plain source archive); the version still shows.
}
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The build's date is the commit's, not the clock's: two builds of one
// commit must come out byte for byte the same, or nobody can check that the
// site serves what the repository holds. SOURCE_DATE_EPOCH, the usual
// convention, wins when set; the clock is only for a plain source archive.
let builtAt = new Date().toISOString();
try {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  builtAt = epoch ? new Date(Number(epoch) * 1000).toISOString() : new Date(execSync('git log -1 --format=%cI').toString().trim()).toISOString();
} catch {
  // Not a git checkout.
}

// The build's identity as a file next to its assets, so a running app can
// read which build is waiting for it (components/UpdateStrip). It is never
// precached (json is not in the service worker's glob) and is fetched with
// no-store, so what comes back is always the build the host serves now.
// The desktop app talks to the native engine, never the wasm packages, and
// is not served by the web host: those files would only make the installer
// tens of megabytes larger.
function desktopTrim(): Plugin {
  let outDir = 'dist';
  return {
    name: 'vault-desktop-trim',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      for (const web of ['wasm', 'bench', 'staticwebapp.config.json']) rmSync(`${outDir}/${web}`, { recursive: true, force: true });
    },
  };
}

function versionJson(): Plugin {
  const body = JSON.stringify({ version: pkg.version, commit, builtAt });
  return {
    name: 'vault-version-json',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: body });
    },
    configureServer(server) {
      server.middlewares.use('/version.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(body);
      });
    },
  };
}

// Cross-origin isolation is required for SharedArrayBuffer, which the
// threaded prover needs. Production hosting must send the same two headers.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// The preview server sends exactly the headers production sends, read from
// the hosting config, so the Content-Security-Policy is tested against a
// real build before it ships. The dev server cannot carry it: Vite's hot
// reload needs inline scripts the policy exists to forbid.
const hosting = JSON.parse(readFileSync(new URL('./public/staticwebapp.config.json', import.meta.url), 'utf8')) as { globalHeaders: Record<string, string> };
const regtestProxy = { '/regtest-node': { target: 'http://127.0.0.1:9797', changeOrigin: true, rewrite: (p: string) => p.replace(/^\/regtest-node/, '') } };

// `vite build --mode desktop` builds the page the native shell loads: the
// same app without the service worker, which in an installed desktop app
// would only cache an old page and offer web updates it cannot apply.
export default defineConfig(({ mode }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(commit),
    __APP_BUILT_AT__: JSON.stringify(builtAt),
  },
  plugins: [
    react(),
    versionJson(),
    ...(mode === 'desktop' ? [desktopTrim()] : []),
    VitePWA({
      disable: mode === 'desktop',
      // A new build is downloaded and offered, and never applied while the app
      // is open; it takes over when the person taps Update or the app is next
      // started. components/UpdateStrip says what that does and does not promise.
      registerType: 'prompt',
      includeAssets: ['icons/*.png', 'favicon.svg'],
      manifest: {
        name: 'Neptune Vault',
        short_name: 'Neptune Vault',
        description: 'Neptune Cash wallet that runs in your browser',
        theme_color: '#111923',
        background_color: '#111923',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The wasm modules are several MB; let the service worker cache them.
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,wasm,png,svg,woff2}'],
      },
    }),
  ],
  server: {
    // no-store: a response cached without the isolation headers (for
    // example from a dev server started with an older config) would make
    // Chrome block the wallet worker script on every later load.
    headers: { ...isolationHeaders, 'Cache-Control': 'no-store' },
    port: 4400,
    // Same-origin path to a local regtest node, so development needs no CORS.
    // 9797 is the node's JSON-RPC listener (--listen-rpc); 9799 stays the
    // tarpc port used by neptune-cli.
    // The key is a prefix match, so it must not collide with /node_modules.
    proxy: regtestProxy,
  },
  preview: { headers: hosting.globalHeaders, port: 4401, proxy: regtestProxy },
  worker: { format: 'es' },
  build: { target: 'es2022' },
}));
