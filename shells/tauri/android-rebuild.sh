#!/bin/bash
# Builds the unsigned APK of one commit inside F-Droid's build image. Runs as
# root in the image and does the build itself as an ordinary user, from a
# fresh clone, as F-Droid does:
#
#   docker run --rm -e COMMIT=<commit> \
#     -v "$PWD/shells/tauri/android-rebuild.sh:/rebuild.sh:ro" -v "$PWD/out:/out" \
#     <image> bash /rebuild.sh
#
# The image is pinned in .github/workflows/android-repro.yml. BUILD_USER and
# BUILD_DIR default to F-Droid's own. Leaves in /out the APK, hashes of its
# web and native parts, and the versions of the tools.
set -euo pipefail

REPO=${REPO:-https://github.com/codewordneptune/neptune-vault.git}
BUILD_USER=${BUILD_USER:-vagrant}
BUILD_DIR=${BUILD_DIR:-/home/vagrant/build/org.useneptune.vault}
export REPO BUILD_DIR

NDK=30.0.16248370
CLI_RUST=1.97.1
NODE=22.20.0
NODE_SHA256=00bbd05e306ea68b6e13e17360d0e2f680b493ef95f2fea1c4296ff7437530bc

. /etc/profile.d/bsenv.sh
export JAVA_HOME=/usr/lib/jvm/default-java
export NDK_HOME="$ANDROID_HOME/ndk/$NDK"

# The build itself, as the ordinary user.
if [ "${1:-}" = as-user ]; then
  cd "$BUILD_DIR"
  git clone --quiet "$REPO" .
  git checkout --quiet "$COMMIT"

  channel=$(sed -n 's/^channel = "\(.*\)"$/\1/p' rust-toolchain.toml)
  rustup toolchain install "$channel" --profile minimal --component rust-src --target aarch64-linux-android
  rustup default "$channel"

  # Built from source at the version the lock file holds, not taken from npm,
  # and on stable: its locked rustix does not compile on the app's nightly.
  tauri_cli=$(node -p "require('./web/package-lock.json').packages['node_modules/@tauri-apps/cli'].version")
  rustup toolchain install "$CLI_RUST" --profile minimal
  cargo "+$CLI_RUST" install tauri-cli --version "$tauri_cli" --locked

  npm --prefix web ci

  cd shells/tauri
  cargo tauri android init --ci
  bash android-project.sh
  cargo tauri android build --apk --target aarch64 --ci

  {
    rustc -vV
    cargo tauri --version
    echo "node $(node -v), npm $(npm -v)"
    java -version 2>&1
    grep distributionUrl gen/android/gradle/wrapper/gradle-wrapper.properties || true
    echo "ndk: $(ls "$ANDROID_HOME/ndk")"
    echo "build-tools: $(ls "$ANDROID_HOME/build-tools" | sort -V | tail -n 1)"
    echo "platform: $(ls "$ANDROID_HOME/platforms" | sort -V | tail -n 1)"
  } > "$HOME/tools.txt"
  exit 0
fi

apt-get update -qq
apt-get install -y -qq --no-install-recommends rustup build-essential pkg-config libssl-dev cmake xz-utils

curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v$NODE/node-v$NODE-linux-x64.tar.xz"
echo "$NODE_SHA256  /tmp/node.tar.xz" | sha256sum --check --strict
tar -xJf /tmp/node.tar.xz --strip-components=1 -C /usr/local

sdkmanager "ndk;$NDK"
test -d "$NDK_HOME"

id "$BUILD_USER" > /dev/null 2>&1 || useradd --create-home "$BUILD_USER"
home=$(getent passwd "$BUILD_USER" | cut -d: -f6)
if [ "$BUILD_USER" != vagrant ]; then
  mkdir -p "$home/.gradle"
  cp /home/vagrant/.gradle/gradle.properties "$home/.gradle/"
fi
mkdir -p "$BUILD_DIR"
chown -R "$BUILD_USER" "$home" "$BUILD_DIR" "$ANDROID_HOME"

runuser -u "$BUILD_USER" -- env HOME="$home" bash "$0" as-user

cd "$BUILD_DIR"
cp shells/tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk /out/app-unsigned.apk
cp "$home/tools.txt" /out/
(cd web/dist && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) > /out/web-dist.sha256
find target/aarch64-linux-android/release -maxdepth 1 -name '*.so' -exec sha256sum {} + > /out/native.sha256
