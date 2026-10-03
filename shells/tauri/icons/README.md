# App icons

The files at the top level are the desktop apps' icons, and `ios/` is for
an iOS app that does not exist yet. Both are made from
`shells/tauri/app-icon.svg` with `tauri icon`
([docs/DESKTOP-RELEASE.md](../../../docs/DESKTOP-RELEASE.md)). That command
also rewrites `android/` unless told to write elsewhere: generate into an
empty folder, as that document says, or put `android/` back afterwards
(`git checkout -- icons/android`).

`android/` is the Android app's launcher icon: the installed web app's icon
(`web/public/icons/icon-maskable-512.png`) as an adaptive icon, with a
one-colour layer for Android's themed icons. The Android build copies it
into the Android project it generates.

`android-source/` holds what it is made from: the web app icon's gradient
without the mark, the mark from `web/public/favicon.svg` at 47.5 of 108 dp
(inside Android's 66 dp safe circle), and the mark in white. `icon.json`
lists the three layers and, for the plain launcher icons Android shows
where it has no adaptive ones, the web app's `icon-512.png`. To make
`android/` again, from `shells/tauri`:

```bash
npx --prefix ../../web tauri icon icons/android-source/icon.json -o <an empty folder>
```

Then copy that folder's `android/` over `icons/android/`. Without `-o`, the
command also overwrites the desktop icons here.
