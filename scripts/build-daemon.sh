#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON_DIR="$ROOT_DIR/daemon"
BIN_DIR="$ROOT_DIR/extension/bin"

mkdir -p "$BIN_DIR"

OS=$(uname -s)
ARCH=$(uname -m)

if [[ "$OS" == "Darwin" ]]; then
  PLATFORM="darwin"
else
  PLATFORM="linux"
fi

if [[ "$ARCH" == "arm64" || "$ARCH" == "aarch64" ]]; then
  ARCH_TAG="arm64"
else
  ARCH_TAG="x64"
fi

cd "$DAEMON_DIR"

cargo build --release

SRC_BIN="$DAEMON_DIR/target/release/clang-tidy-daemon"
DEST_BIN="$BIN_DIR/clang-tidy-daemon-${PLATFORM}-${ARCH_TAG}"

cp -f "$SRC_BIN" "$DEST_BIN"
chmod +x "$DEST_BIN"

echo "Built and copied $DEST_BIN"
