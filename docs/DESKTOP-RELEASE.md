# Desktop releases

The desktop apps are the Tauri shell in `shells/tauri` around the same web
page, talking to the native wallet engine and prover (`crates/vault-bridge`)
instead of the wasm packages. `.github/workflows/release-desktop.yml` builds
them for Windows (x64), Linux (x64) and macOS (Apple silicon and Intel).
The Android app is built from the same shell; see [ANDROID.md](ANDROID.md).

## Making a release

1. Set the version from `web`, which updates `package.json` and
   `package-lock.json`:

   ```
   npm version <version> --no-git-tag-version
   ```

   The web app and the desktop apps both take their version from there,
   so pushing it to `main` also deploys the web app under that version.
2. Commit and push that change, then tag the same commit and push the tag,
   for example:

   ```
   git tag desktop-v0.4.0
   git push origin desktop-v0.4.0
   ```

   The running apps compare the tag's version with their own to tell
   people a new version is out, so the two must match; nothing checks this
   for you.
3. The workflow builds for the four targets and attaches the installers to
   a **draft** pre-release whose notes say "Unsigned test build". Try the
   installers, replace the notes with what people should read (the app's
   Download button opens this page), then publish the draft. Only a
   published release reaches the apps' update notice; a draft never does.

A run started by hand from the Actions tab only builds. Every run, tagged or
not, also keeps the installers as workflow artifacts, for as long as the
repository's artifact retention setting says (90 days unless changed).

What each platform should get:

| Platform | Files |
|---|---|
| Windows | `.msi` and a `-setup.exe` (NSIS) |
| Linux | `.deb`, `.rpm` and an `.AppImage` |
| macOS | `.app` in a `.dmg` (and a `.app.tar.gz`), one per chip |

No release has been published yet. Runs started by hand (the last on
2026-10-04) produce exactly these files.

## Building locally

Install Tauri's prerequisites for your system (on Linux, the packages the
workflow installs: `libwebkit2gtk-4.1-dev libappindicator3-dev
librsvg2-dev patchelf`), and the web app's dependencies once (`npm ci` in
`web`; the Tauri CLI is one of them). The Rust toolchain comes from
`rust-toolchain.toml`. Then, from `shells/tauri`:

```
npx --prefix ../../web tauri dev
npx --prefix ../../web tauri build
```

- `tauri dev` runs the shell against the web dev server on port 4400.
- `tauri build` makes the installers, in `target/release/bundle/` at the
  repository root unless `CARGO_TARGET_DIR` says otherwise. On Windows,
  keep that directory short, or the linker can fail on long paths: in
  PowerShell, run `$env:CARGO_TARGET_DIR = 'C:\nvnative'` first.
- `tauri build` replaces `web/dist` with the desktop page, which has no
  wasm, no service worker and no `staticwebapp.config.json`. Run
  `npm run build` in `web` again before you preview or deploy the web app.

## The app icon

The desktop icons (the files at the top of `shells/tauri/icons`, and
`ios/`) are generated from `shells/tauri/app-icon.svg`: the brand mark in
the light accent (`#7db4f5`) on a navy tile, light enough to read at
taskbar size. The Android launcher icon in `icons/android/` has its own
source; see [shells/tauri/icons/README.md](../shells/tauri/icons/README.md).

After changing `app-icon.svg`, generate into an empty folder, from
`shells/tauri`, then copy everything except its `android/` folder over
`icons/`:

```
npx --prefix ../../web tauri icon app-icon.svg -o <an empty folder>
```

Without `-o`, the command also overwrites the Android icon.

## Not done yet: signing and updates

These need keys only the maintainer can create. None of them goes in the
repository: each is a secret under Settings, Secrets and variables,
Actions. Adding a secret is not enough: name it in the `env` of the
`tauri-action` step in `release-desktop.yml`, which today passes only
`GITHUB_TOKEN`.

**macOS** (without it, macOS refuses to open the app until the person
allows it in System Settings, Privacy and Security). An Apple Developer
account, then:
`APPLE_CERTIFICATE` (the Developer ID Application certificate, a base64
.p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and for
notarization `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password) and
`APPLE_TEAM_ID`.

**Windows** (without it, SmartScreen warns on first run). A code signing
certificate from a certificate authority, or Azure Trusted Signing; the
signing command goes into `bundle.windows` in `tauri.conf.json`.

**Updates** (without them, a new version is a new download). From
`shells/tauri`, generate a key pair with
`npx --prefix ../../web tauri signer generate -w <a path outside the repository>`,
and keep the private key and its password as `TAURI_SIGNING_PRIVATE_KEY`
and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Then add the plugin to the shell
(`tauri-plugin-updater`, and `updater:default` in
`capabilities/default.json`), put the public key in
`plugins.updater.pubkey` and the endpoint in `plugins.updater.endpoints`,
and set `bundle.createUpdaterArtifacts` to `true`; the app then checks the
release's `latest.json`. GitHub's `releases/latest` skips pre-releases, so
turn off `prerelease` in the workflow before pointing the endpoint there.

Until then the app only tells people that a newer version is out: when it
starts, and every six hours, it asks GitHub's releases API
(`web/src/components/DesktopUpdateNotice.tsx`) and links the release page.

Linux packages are usually not signed.
