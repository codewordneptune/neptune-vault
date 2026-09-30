# Android app

The Android app is the Tauri shell in `shells/tauri` around the same web
page, talking to the native wallet engine and prover (`crates/vault-bridge`),
as the desktop apps do. The installed web app stays the way onto Android that
needs nothing from Google. This file is the plan for the native app, and what
stands today.

## The goal

A high-trust app that needs no personal registration with Google:

- The code is fixed in a signed package. Nothing a website serves can change
  an installed app.
- Only the maintainer's key can update it. Android refuses an update signed
  with another key, so even a taken-over GitHub account cannot push one to
  people who have the app.
- Anyone can check an APK against the source it was built from.

## Where it stands

- **Test builds.** `.github/workflows/android-test.yml` builds an arm64 APK
  on each push to `cwn/android`, signed with a key made for that run and
  thrown away. A newer test build installs only after the older one is
  uninstalled, which deletes that app's wallet data.
- **First build installed** on a Galaxy S24 (2026-09-30). Still to measure:
  how long a send takes to prove, against the web app's (about 2 min 14 s in
  September on the same phone).

## Before a first release, in this order

1. **Measure a send** on the phone. If native proving is not clearly faster,
   stop here: the web app is the Android app.
2. **Fix what the test build lacks:**
   - Backup export. The shell writes the file to the path the save dialog
     returns, and on Android that is a content URI, not a path. Write through
     the Android file plugin instead.
   - The QR scanner needs the camera permission in the Android manifest,
     which means keeping the generated Android project in the repository.
   - Keep the screen on while a send is proved, from the native side.
3. **Fingerprint unlock** in place of passkey unlock, which the Android web
   view cannot offer (see below).
4. **Release pipeline and key** (see below).

## Fingerprint unlock

Passkeys need WebAuthn and a website that vouches for the app; the web view
the app runs in has neither, so Settings says passkey unlock is not
available. The app instead uses Android's own key storage, the way native
wallet apps do:

- Turning it on (after the password): a key is made in the Android Keystore
  that only a fingerprint or face (BiometricPrompt) can use, and never
  leaves the phone's secure hardware. It encrypts the wallet's content key,
  and the ciphertext is kept on the account record, as the passkey's
  wrapped key is today.
- Unlocking: the fingerprint opens the Keystore key, which decrypts the
  content key, which opens the wallet.
- New fingerprints enrolled on the phone make Android drop the key, so the
  password is asked again. The password always works, and the key is never
  in a backup file.
- It needs a small native plugin (Kotlin) with three commands (turn on,
  unlock, turn off), and Security shows "Fingerprint unlock" on Android.

No website, no Google account and nothing synced is involved.

## Releases

- **The key.** The maintainer makes the release signing key on their own
  machine and keeps it offline, with at least two backups. It never goes
  into GitHub. Losing it means installed apps can never be updated again.
- **Building and signing.** A tagged run builds an unsigned APK, its SHA-256
  and a GitHub build attestation tying it to the commit and workflow. The
  maintainer checks the attestation, signs the APK on their own machine,
  and attaches it to the release.
- **Checking an APK.** The key's certificate fingerprint is published in the
  README, on the website and in every release. Reproducible builds, so that
  anyone can rebuild an APK and compare, come later.
- **Distribution.** GitHub Releases, with Obtainium for updates.

## Google's developer verification

From 30 September 2026 in Brazil, Indonesia, Singapore and Thailand, and
worldwide in 2027, phones with Google's services install apps normally only
from developers verified with Google. Without registration, people can still
install the app over ADB, or through Google's "advanced flow": a setting in
Developer options, a restart and a one-time 24-hour wait, then "Install
anyway" on every install and update. Phones without Google's certification,
such as GrapheneOS, are not affected. Registering an organization rather
than a person is the fallback, if that proves too much for the people using
the app; the key stays with the maintainer either way.
