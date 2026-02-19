#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT_DIR/extension/bin"

mkdir -p "$BIN_DIR"

# Expected inputs (provide paths via env vars or adjust below)
# Example:
#   DARWIN_X64_BIN=target/x86_64-apple-darwin/release/clang-tidy-daemon \
#   DARWIN_ARM64_BIN=target/aarch64-apple-darwin/release/clang-tidy-daemon \
#   LINUX_X64_BIN=target/x86_64-unknown-linux-gnu/release/clang-tidy-daemon \
#   ./scripts/package-daemon.sh

DARWIN_X64_BIN=${DARWIN_X64_BIN:-}
DARWIN_ARM64_BIN=${DARWIN_ARM64_BIN:-}
LINUX_X64_BIN=${LINUX_X64_BIN:-}

copy_bin() {
  local src="$1"
  local dest="$2"
  if [[ -z "$src" ]]; then
    echo "Skip $dest (source not provided)"
    return
  fi
  if [[ ! -f "$src" ]]; then
    echo "Missing source: $src" >&2
    exit 1
  fi
  cp -f "$src" "$BIN_DIR/$dest"
  chmod +x "$BIN_DIR/$dest"
  echo "Copied $src -> $BIN_DIR/$dest"
}

copy_bin "$DARWIN_X64_BIN" "clang-tidy-daemon-darwin-x64"
copy_bin "$DARWIN_ARM64_BIN" "clang-tidy-daemon-darwin-arm64"
copy_bin "$LINUX_X64_BIN" "clang-tidy-daemon-linux-x64"
