#!/bin/bash
# Gives the Android project that `tauri android init` generates what is the
# app's own. Run from shells/tauri, after the init.
#
# The camera, for the QR scanner (not required, so a phone without one still
# installs it). No Android backup: the wallet's data never leaves the phone
# in a cloud backup or a transfer to a new one, where its encrypted parts
# could be tried against password guesses offline (android-res/xml). The
# launcher icon, the web app's icon as an adaptive icon (icons/README.md).
# And the app's navy behind everything (the dark theme's page colour), so
# the launch screen and the moment before the page paints are never white;
# the web view's own background is in tauri.android.conf.json.
set -euo pipefail

manifest=gen/android/app/src/main/AndroidManifest.xml
sed -i 's|^\( *\)<uses-permission android:name="android.permission.INTERNET" />|&\n\1<uses-permission android:name="android.permission.CAMERA" />\n\1<uses-feature android:name="android.hardware.camera" android:required="false" />|' "$manifest"
grep -q 'android.permission.CAMERA' "$manifest"
grep -n 'uses-' "$manifest"
sed -i 's|<application\b|<application android:allowBackup="false" android:dataExtractionRules="@xml/data_extraction_rules"|' "$manifest"
test "$(grep -c 'android:allowBackup' "$manifest")" -eq 1
grep -q 'android:allowBackup="false" android:dataExtractionRules="@xml/data_extraction_rules"' "$manifest"
grep -n -A1 '<application' "$manifest"

cp -r android-res/. gen/android/app/src/main/res/
test -f gen/android/app/src/main/res/xml/data_extraction_rules.xml
cp -r icons/android/. gen/android/app/src/main/res/
ls gen/android/app/src/main/res/mipmap-anydpi-v26

for themes in gen/android/app/src/main/res/values/themes.xml gen/android/app/src/main/res/values-night/themes.xml; do
  sed -i 's|<!-- Customize your theme here. -->|<item name="android:windowBackground">#FF111923</item>|' "$themes"
  grep -q 'android:windowBackground' "$themes"
  cat "$themes"
done
