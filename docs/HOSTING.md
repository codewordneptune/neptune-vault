# Hosting on Azure Static Web Apps

The app is static files: `web/dist` after `npm run build`, with the wasm
packages under `wasm/`. Any static host works as long as it can set two
response headers on every file, because the threaded prover needs the page to
be cross-origin isolated (ARCHITECTURE.md section 7):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Azure Static Web Apps (R24) sets them through `globalHeaders` in
`web/public/staticwebapp.config.json`, which Vite copies into `dist`, and
which also maps `.wasm` to `application/wasm` and routes unknown paths to
`index.html` for the router. The site is `https://vault.dev.useneptune.org`.

## One-time setup (you)

1. Create a Static Web App in the Azure portal (Free tier is enough for a
   proof of concept; Standard adds a custom domain SLA). Deployment source:
   "Other", since our GitHub Actions workflow uploads a prebuilt `dist`.
2. Copy its deployment token (Overview, "Manage deployment token") into the
   GitHub repository secret `AZURE_STATIC_WEB_APPS_API_TOKEN_DEV`.
3. Custom domain: `vault.dev.useneptune.org` is configured (2026-09-13);
   Azure issues the TLS certificate itself.
4. The public mainnet node allows any origin since 2026-09-13
   (`Access-Control-Allow-Origin: *`); a new node must do the same.

## Deploying

Pushes to `main` that touch the web app or the crates run
`.github/workflows/deploy-web.yml`: it builds both wasm packages (the
nightly toolchain and wasm-pack, cached between runs), runs the web tests,
builds `dist`, and uploads it. The first run compiles everything and takes
about 30 minutes; later runs reuse the cargo cache.

To deploy from this PC instead, build locally and upload with the SWA CLI:

```
cd web
npm run wasm:core && npm run wasm:prover
npm run build
npx @azure/static-web-apps-cli deploy dist --deployment-token <token> --env production
```

## Checking a deployment

Open the site on the phone and look at Settings: it shows whether the
persistent-storage request was granted. Then open the diagnostics page at
`/diagnostics`: "Cross-origin isolated: yes" confirms the headers are in
place, and the prover will use all cores. Install to the home screen from
the browser menu; the app must open in standalone mode with the icon.

First deployment 2026-09-13 (workflow run 34764130991, about 35 minutes cold):
the live site serves every file with the isolation headers, `.wasm` as
`application/wasm`, and `/diagnostics` reports "Cross-origin isolated: yes".

Verified locally on 2026-09-13 with `npm run build` and `vite preview`: the
isolation headers, the wasm mime type, both bundled workers (the prover
starts its thread pool in production), and the precache list of 16 entries
(6.5 MB). Service-worker registration could not be checked from the
automation browser, which blocks service workers; check it once in Chrome
on the deployed site (Application tab, Service Workers).

## What the hosted app can talk to

The app calls the node from the browser, so the node must send CORS
headers; the public mainnet node does. A node that does not can only be
reached through a proxy that adds them. The regtest proxy in
`vite.config.ts` exists only on the dev server.
