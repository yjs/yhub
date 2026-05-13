#!/bin/sh
# Builds the y-crdt/yn native binding from source and installs the compiled
# index.node into node_modules/yn/. Re-run after every `npm install` — npm
# wipes node_modules/yn, and the upstream repo has no prepare script or
# prebuilt binaries.
#
# Requires: cargo (rustup.rs), git, npm.
# Override the ref with YN_REF=<branch|tag|sha>.

set -eu

YN_REPO="https://github.com/y-crdt/yn.git"
YN_REF="${YN_REF:-main}"
YHUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
YN_DIR="$YHUB_DIR/node_modules/yn"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

command -v cargo >/dev/null 2>&1 || {
  echo "error: cargo not found. Install Rust via https://rustup.rs" >&2
  exit 1
}

# yn / yrs 0.25 require Rust edition 2024 (stable since 1.85).
RUSTC_MIN_MAJOR=1
RUSTC_MIN_MINOR=85
RUSTC_VER="$(rustc --version | awk '{print $2}')"
RUSTC_MAJOR="$(echo "$RUSTC_VER" | cut -d. -f1)"
RUSTC_MINOR="$(echo "$RUSTC_VER" | cut -d. -f2)"
if [ "$RUSTC_MAJOR" -lt "$RUSTC_MIN_MAJOR" ] ||
   { [ "$RUSTC_MAJOR" -eq "$RUSTC_MIN_MAJOR" ] && [ "$RUSTC_MINOR" -lt "$RUSTC_MIN_MINOR" ]; }; then
  echo "error: rustc $RUSTC_VER is too old. yn requires >= ${RUSTC_MIN_MAJOR}.${RUSTC_MIN_MINOR} (edition 2024)." >&2
  echo "       Run: rustup update stable" >&2
  exit 1
fi

echo "==> cloning $YN_REPO ($YN_REF) into $BUILD_DIR"
git clone --depth 1 --branch "$YN_REF" "$YN_REPO" "$BUILD_DIR"

echo "==> installing yn build dependencies"
(cd "$BUILD_DIR" && npm install)

echo "==> building yn (release)"
(cd "$BUILD_DIR" && npm run build)

[ -f "$BUILD_DIR/index.node" ] || {
  echo "error: build did not produce index.node" >&2
  exit 1
}

echo "==> installing into $YN_DIR"
mkdir -p "$YN_DIR"
cp "$BUILD_DIR/index.node" "$YN_DIR/index.node"
cp "$BUILD_DIR/package.json" "$YN_DIR/package.json"

echo "==> done. yn ready at $YN_DIR/index.node"
