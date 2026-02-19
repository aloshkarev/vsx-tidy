#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON_DIR="$ROOT_DIR/daemon"
BIN_DIR="$ROOT_DIR/extension/bin"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to build the Linux binary." >&2
  exit 1
fi

IMAGE=${RUST_DOCKER_IMAGE:-rust:1.86-bookworm}
PLATFORM=${DOCKER_PLATFORM:-linux/amd64}
TARGET=${TARGET:-x86_64-unknown-linux-gnu}
OUT_NAME=${OUT_NAME:-clang-tidy-daemon-linux-x64}

mkdir -p "$BIN_DIR"

# Build in Docker (Linux x64)
docker run --rm \
  --platform "$PLATFORM" \
  -u "$(id -u):$(id -g)" \
  -v "$ROOT_DIR":/work \
  -w /work/daemon \
  "$IMAGE" \
  bash -c "export PATH=/usr/local/cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; rustup target add $TARGET; cargo build --release --target $TARGET"

SRC_BIN="$DAEMON_DIR/target/$TARGET/release/clang-tidy-daemon"
DEST_BIN="$BIN_DIR/$OUT_NAME"

if [[ ! -f "$SRC_BIN" ]]; then
  echo "Build failed: $SRC_BIN not found" >&2
  exit 1
fi

cp -f "$SRC_BIN" "$DEST_BIN"
chmod +x "$DEST_BIN"

echo "Built and copied $DEST_BIN"
