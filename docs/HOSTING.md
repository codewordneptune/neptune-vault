# Hosting on Azure Static Web Apps

The web app is static files: `web/dist` after `npm run build`, with the
two wasm packages under `wasm/` (`core` and `prover`). The site is
`https://vault.dev.useneptune.org`. The desktop and Android apps carry
their own files and do not use this hosting at all.

Any static host works if it can set these response headers on every file.
The first two are required: the wallet engine and the prover need shared
memory, which a page only gets when it is cross-origin isolated. Without
them the app stops at start and says so.

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The rest are the site's security policy and belong on any host too:

- `Cross-Origin-Resource-Policy: same-origin`
- a strict `Content-Security-Policy`: scripts only from the site (which
  may compile wasm), fonts only from the site (the app ships its own,
  Inter), and connections only to the site, to any `https:`
  address (nodes and the price sites), and to nodes on `localhost` or
  `127.0.0.1`
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: no-referrer`
- a `Permissions-Policy` that allows the camera, clipboard writes, wake
  lock, sharing and passkeys for the site itself, and turns off the
  microphone, location, payments, USB, serial, HID, Bluetooth, screen
  capture and clipboard reads

Azure Static Web Apps sets all of them through `globalHeaders` in
`web/public/staticwebapp.config.json`, which Vite copies into `dist`. The
same file maps `.wasm` and `.webmanifest` to their MIME types and routes
unknown paths to `index.html` for the router (except assets, wasm, icons
and top-level `.js`, `.json` and `.webmanifest` files). `vite preview`
serves the same headers.

## One-time setup

1. Create a Static Web App in the Azure portal. The Free plan is enough
   and includes custom domains with their certificates; Standard adds an
   SLA. Deployment source: "Other", since the GitHub Actions workflow
   uploads a prebuilt `dist`.
2. Copy its deployment token (Overview, "Manage deployment token") into
   the GitHub repository secret `AZURE_STATIC_WEB_APPS_API_TOKEN_DEV`.
3. Add the custom domain under the app's Custom domains; Azure issues the
   TLS certificate itself. `vault.dev.useneptune.org` has been configured
   since 2026-09-13.
4. Use a node that allows the site's origin (see
   [What the hosted app can talk to](#what-the-hosted-app-can-talk-to)).

## Deploying

`.github/workflows/deploy-web.yml` runs on every push to `main` that
touches `web/`, `crates/`, the root Cargo files, `.cargo/`,
`rust-toolchain.toml` or the workflow itself, and by hand from the Actions
tab. A newer run cancels one still in progress. It:

1. runs the wallet core's Rust tests (`cargo test -p vault-core`);
2. builds the two wasm packages with the pinned nightly and wasm-pack,
   both installed on every run (the cargo registry and the build
   directory are cached between runs);
3. runs `npm ci --ignore-scripts`, the web tests and `npm run build`;
4. publishes the SHA-256 of every file it is about to upload (below);
5. uploads `dist`.

A run takes about half an hour, most of it building the two wasm packages;
the cargo cache saves downloads more than time.

To deploy from this PC instead, in an emergency only: it publishes no hash
list, so the site serves files no run has listed until the next deploy
from `main`. From a clean checkout of a pushed commit, after
`cargo test -p vault-core` at the root:

```
cd web
npm ci --ignore-scripts
npm run wasm:core
npm run wasm:prover
npm test
npm run build
npx @azure/static-web-apps-cli deploy dist --deployment-token <token> --env production
```

Run `npm run build` again after any `tauri build`, which replaces
`web/dist` with the desktop page (no wasm, no service worker, no
`staticwebapp.config.json`).

## Who can deploy

A deploy needs a push to `main` that touches the paths above, or a run by
hand from the Actions tab; nothing else approves it. A run by hand can be
started on any branch, and deploys that branch's build. As of 2026-10-03,
`main` cannot be deleted or force-pushed (the repository's "Basic"
ruleset), and no review is required before a push. The deployment token
uploads anything without either, so it lives only in the repository
secret; if it leaks, reset it under Manage deployment token.

## Checking a deployment

1. On a phone, open the site and create or unlock a wallet. Settings,
   Backup says whether the browser keeps the wallet's data (the
   persistent-storage request).
2. Open Report a problem (`/diagnostics`, or Settings, About; Diagnostics
   under Advanced shows the same rows). Cross-origin isolation must read
   "Yes: the wallet engine can run, and proving uses every core".
3. Install the app from the browser menu and open it from the home
   screen. It must open in standalone mode with the icon, and Running as
   must read "Installed app".
4. In Chrome on a computer, DevTools, Application, Service workers must
   show the site's `sw.js` as activated.

## What the hosted app can talk to

- The node set in Settings, by default
  `https://wallet.neptunefundamentals.org`. The page calls it directly
  (JSON-RPC over POST), so the node must answer the browser's CORS
  preflight and allow this site's origin, or any origin as the default
  node does. A node that does not can only be reached through a proxy
  that adds the headers.
- CoinGecko, and CoinPaprika when CoinGecko does not answer, only while
  "Value in another currency" is on.
- Its own site, for its files and `version.json`.

The GitHub releases check belongs to the desktop app only. The regtest
proxy in `vite.config.ts` exists only in `npm run dev` and `vite preview`,
never on the hosted site. [PRIVACY.md](PRIVACY.md) says what each of
these learns.

## Checking that the site serves what the repository holds

Every deploy run lists the SHA-256 of each file it uploads, in the run's
summary on GitHub and as an artifact named `dist-sha256-<commit>`, kept for
90 days. Three things make that list worth comparing against:

- The build's date comes from the commit (or `SOURCE_DATE_EPOCH`), never
  from the clock in a git checkout, so the bundle does not change from one
  run to the next.
- Absolute paths are trimmed from the wasm (`trim-paths` in
  `.cargo/config.toml` and the release profile), so the binaries do not
  carry the builder's directories, and a local build does not publish the
  builder's user name.
- The Rust nightly and Node are pinned exactly; the runner image is named
  by its Ubuntu version (`ubuntu-24.04`), which GitHub keeps updating.

To check a deploy, in Git Bash or another Unix shell: `version.json` names
the commit the site serves, in its short form; the artifact's name carries
the full commit. Download that commit's `dist-sha256-<commit>`
artifact from its run, unzip `dist.sha256` into the current folder, and
hash every listed file as the site serves it:

```bash
curl -s https://vault.dev.useneptune.org/version.json
while read -r hash path; do
  echo "$(curl -sL "https://vault.dev.useneptune.org/${path#./}" | sha256sum | cut -d' ' -f1)  $path"
done < dist.sha256 | diff dist.sha256 -
```

`diff` prints only the files that differ. One always does:
`staticwebapp.config.json`, which Azure reads and does not serve.

To go further, build the same commit on Linux, as the workflow does, and
compare `web/dist` file by file. On Windows, clone with
`git clone -c core.autocrlf=false <repository URL>`, or Git rewrites line
endings and the copied files differ. What is not pinned yet, and can still
make two builds differ: wasm-pack, which the workflow installs at its
newest, and the wasm-opt it downloads. wasm-bindgen follows `Cargo.lock`.
