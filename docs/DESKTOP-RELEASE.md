# Desktop releases

The desktop apps are the Tauri shell in `shells/tauri` around the same web
page, talking to the native wallet engine and prover (`crates/vault-bridge`)
instead of the wasm packages. `.github/workflows/release-desktop.yml` builds
them for Windows (x64), Linux (x64) and macOS (Apple silicon and Intel).

## Making a release

1. Set the version in `web/package.json`; the desktop apps take it from there.
2. Push a tag named `desktop-v<version>` with that same version, for example
   `desktop-v0.2.0`. The running apps compare the tag's version with their
   own to tell people a new version is out, so the two must match.
3. The workflow builds for the four targets and attaches the installers to a
   **draft** release. Try them, then publish the draft on GitHub. Only a
   published release reaches the apps' update notice; a draft never does.

A run started by hand from the Actions tab only builds. Every run, tagged or
not, also keeps the installers as workflow artifacts, for as long as the
repository's artifact retention setting says (90 days unless changed).

What each platform gets:

| Platform | Files |
|---|---|
| Windows | `.msi` and a `-setup.exe` (NSIS) |
| Linux | `.deb`, `.rpm` and an `.AppImage` |
| macOS | `.app` in a `.dmg` (and a `.app.tar.gz`), one per chip |

## Building locally

Install the web app's dependencies once (`npm ci` in `web`); the Rust
toolchain comes from `rust-toolchain.toml`. Then:

```
cd shells/tauri
npx --prefix ../../web tauri build
```

On Windows keep the target directory short (for example
`CARGO_TARGET_DIR=C:/nvnative`) or the linker can fail on long paths.
The installers land in `<target>/release/bundle/`.

`tauri dev` runs the shell against the web dev server on port 4400.

## The app icon

The icons in `shells/tauri/icons` are all generated from one source,
`shells/tauri/app-icon.svg`: the brand mark in the light accent (`#7db4f5`) on
a navy tile, light enough to read at taskbar size. After changing it,
regenerate every size and format from `shells/tauri`:

```
npx --prefix ../../web tauri icon app-icon.svg
```

## Not done yet: signing and updates

These need keys only the maintainer can create. None of them goes in the
repository: each is a secret under Settings, Secrets and variables, Actions,
and the workflow will pass them to `tauri-action` once they exist (today it
passes only `GITHUB_TOKEN`).

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

**Updates** (without them, a new version is a new download). Generate a key
pair with `npx tauri signer generate`, keep the private key and its
password as `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and put the public key in the updater
plugin's config; the app then checks the release's `latest.json`. The
plugin is not in the shell yet. Until then the app only tells people that a
newer version is out: it asks GitHub's releases API every few hours
(`web/src/components/DesktopUpdateNotice.tsx`) and links the release page.

Linux packages are usually not signed.
