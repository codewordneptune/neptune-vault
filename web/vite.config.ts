import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Cross-origin isolation is required for SharedArrayBuffer, which the
// threaded prover needs. Production hosting must send the same two headers.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'Neptune Vault',
        short_name: 'Vault',
        description: 'Neptune Cash wallet that runs in your browser',
        theme_color: '#0b1b2b',
        background_color: '#0b1b2b',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
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
    headers: isolationHeaders,
    port: 4400,
    // Same-origin path to a local regtest node, so development needs no CORS.
    // 9797 is the node's JSON-RPC listener (--listen-rpc); 9799 stays the
    // tarpc port used by neptune-cli.
    // The key is a prefix match, so it must not collide with /node_modules.
    proxy: { '/regtest-node': { target: 'http://127.0.0.1:9797', changeOrigin: true, rewrite: (p) => p.replace(/^\/regtest-node/, '') } },
  },
  preview: { headers: isolationHeaders, port: 4401 },
  worker: { format: 'es' },
  build: { target: 'es2022' },
  optimizeDeps: {
    // wasm-pack output must not be pre-bundled: it locates its .wasm by URL.
    exclude: ['./src/wasm/prover/vault_prover.js', './src/wasm/core/vault_core.js'],
  },
});
