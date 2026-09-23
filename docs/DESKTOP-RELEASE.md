# Desktop releases

The desktop apps are the Tauri shell in `shells/tauri` around the same web
page, talking to the native wallet engine and prover (`crates/vault-bridge`)
instead of the wasm packages. `.github/workflows/release-desktop.yml` builds
them for Windows (x64), Linux (x64) and macOS (Apple silicon and Intel).

## Making a release

1. Set the version in `web/package.json`; the desktop apps take it from there.
2. Push a tag named `desktop-v<version>`, for example `desktop-v0.2.0`.
3. The workflow builds the four installers and attaches them to a **draft**
   release. Try them, then publish the draft on GitHub.

A run started by hand from the Actions tab only builds; the installers are
kept as workflow artifacts for a few days.

What each platform gets:

| Platform | Files |
|---|---|
| Windows | `.msi` and a `-setup.exe` (NSIS) |
| Linux | `.deb`, `.rpm` and an `.AppImage` |
| macOS | `.app` in a `.dmg`, one per chip |

## Building locally

```
cd shells/tauri
npx --prefix ../../web tauri build
```

On Windows keep the target directory short (for example
`CARGO_TARGET_DIR=C:/nvnative`) or the linker can fail on long paths.
The installers land in `<target>/release/bundle/`.

`tauri dev` runs the shell against the web dev server on port 4400.

## Not done yet: signing and updates

These need keys only the maintainer can create. None of them goes in the
repository: each is a secret under Settings, Secrets and variables, Actions,
and the workflow passes them to `tauri-action`.

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
plugin is not in the shell yet.

Linux packages are usually not signed.
