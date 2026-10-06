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
  when run by hand from the Actions tab, on `main` or a branch made from
  it. It also runs on a push to `cwn/android`, which was merged into `main`
  on 2026-10-01 and has not moved since. Each APK is signed with a key made
  for that run and thrown away, and is kept on the run's page for 14 days.
  A newer test build installs only after the older one is uninstalled,
  which deletes that app's wallet data.
- **The app's own parts of the Android project.** The workflow generates the
  project on each run, then adds the camera permission for the QR scanner,
  the launcher icon from `shells/tauri/icons/android` (the web app's icon,
  as an adaptive icon), and the app's navy as the window's background, so
  the launch screen is navy rather than white in a light system theme. The
  web view starts navy too (`shells/tauri/tauri.android.conf.json`), until
  the page paints. Everything else is Tauri's default. Not yet tried on a
  phone.
- **Pull to sync.** On Home, a pull down from the top of the page syncs, as
  Sync does (`web/src/app/pullToSync.ts`, in the phone apps only). Tried
  with touch events in Chrome, not yet on a phone.
- **Android's own screens.** Android asks for the camera on a screen over
  the app, which pauses it and hides the page. The wallet waits for the
  answer instead of locking, as it does for a file picker.
- **The seed phrase stays out of screen captures.** While a seed phrase is
  shown (in setup, and in Settings, Backup) or typed (restore, Forgot the
  password?),
  the window is kept out of screenshots, screen recordings and the
  recent-apps preview: the page asks the shell (`app_secure_screen`), which
  sets Android's FLAG_SECURE, and clears it once the phrase is off the
  screen. Not yet tried on a phone.
- **Payment links.** A `neptunecash:` link tapped in another app or on a
  web page opens the app (Tauri's deep-link plugin, phones only; when
  several apps take such links, Android asks which one). Send is filled in
  from it as from a scanned code, after the password if the wallet is
  locked, and nothing goes out without the review.
- **Measured** on a Galaxy S24 (Exynos 2400, 10 cores), 2026-10-01:
  - Mainnet sends from the app took 16, 23 and 17 s with Triton VM 9 (the
    Neptune crates 0.19), at a 976 MB peak on the first. The app computes
    a large table again when it needs it, as the web app does.
  - With Triton VM 8, which kept that table in memory, a send took 19 s at
    a 1,825 MB peak. The first Triton VM 9 build kept it too, and the app
    disappeared mid-send; the cause is not known yet.
  - The benchmark page in Chrome on the same phone took 97 s (Triton VM 9)
    and 151 s (Triton VM 8). Native code multiplies the prover's 64-bit
    numbers in one or two instructions where WebAssembly takes several.
  - Diagnostics shows the time and the app's peak memory of the last proof.

## Before a first release, in this order

1. **Measure a send** on the phone. If native proving is not clearly faster,
   stop here: the web app is the Android app. Done: 16 to 23 s against 97 s
   in Chrome on the same phone, so the plan goes on.
2. **Fix what the test build lacks** (not done yet):
   - Backup export. The shell writes the file to the path the save dialog
     returns, and on Android that is a content URI, not a path. Write through
     the Android file plugin instead. The save dialog is one of Android's
     own screens too, so the wallet must wait for it without locking.
   - Keep the screen on from the native side while a send is proved or a
     long scan or restore runs, as the web app asks the browser to
     (`web/src/app/wakeLock.ts`). Today the app asks only the web view.
   - Android's own backup. The generated project leaves
     `android:allowBackup` at its default, so Android may copy the app's
     data (the encrypted seed phrase and the wallet's sealed logs included)
     to the person's Google account, and to a new phone. Turn it off, and
     add data extraction rules that leave everything out of both the cloud
     backup and a transfer to a new phone, in the manifest the workflow
     patches: on Android 12 and later, turning backup off does not stop
     that transfer on some makers' phones.
3. **Fingerprint unlock** (not done yet), in place of passkey unlock, which
   the Android web view cannot offer (see below).
4. **Release pipeline and key** (see below).

## Fingerprint unlock (planned)

Not built yet. Passkeys need WebAuthn and a website that vouches for the
app; the web view the app runs in has neither, so Settings says passkey
unlock is not available. The plan is to use Android's own key storage, the
way native wallet apps do:

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
  unlock, turn off), and Security will show "Fingerprint unlock" on
  Android.

No website, no Google account and nothing synced is involved.

## Releases (planned)

Not built yet; today there are only test builds. The plan:

- **The key.** The maintainer makes the release signing key on their own
  machine and keeps it offline, with at least two backups. It never goes
  into GitHub. Losing it means installed apps can never be updated again.
- **Building and signing.** A tagged run will build an unsigned APK, its
  SHA-256 and a GitHub build attestation tying it to the commit and
  workflow. The maintainer checks the attestation, signs the APK on their
  own machine, and attaches it to the release.
- **Checking an APK.** The key's certificate fingerprint will be published
  in the README, on the website and in every release. Reproducible builds,
  so that anyone can rebuild an APK and compare, come later.
- **Distribution.** GitHub Releases, with Obtainium for updates.

## Google's developer verification

Since 30 September 2026 in Brazil, Indonesia, Singapore and Thailand, and
worldwide from 2027, certified Android phones (those with Google's
services) install apps normally only from developers verified with Google.
Without registration, people can still install the app over ADB, or
through Google's "advanced flow": a setting in Developer options, a
restart, a one-time wait of one day and a confirmation with the phone's
fingerprint, face or PIN; after that each install shows a warning with
"Install anyway". Phones without Google's certification, such as
GrapheneOS, are not affected.

Google also offers limited distribution accounts, which share an app with
up to 20 devices without an ID or a fee; that could cover test builds.
Registering an organization rather than a person is the fallback, if the
advanced flow proves too much for the people using the app; the key stays
with the maintainer either way.

Google's terms as checked on 2026-10-03:
[the requirement](https://android-developers.googleblog.com/2026/06/android-developer-verification.html)
and [the advanced flow](https://android-developers.googleblog.com/2026/03/android-developer-verification.html).
