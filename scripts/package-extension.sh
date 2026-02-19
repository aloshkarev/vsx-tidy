#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT_DIR/extension"

cd "$EXT_DIR"

# Ensure build is up to date
if [ ! -d "node_modules" ]; then
  npm install
fi
npm run build

# Package (prefer local vsce)
VSCe_BIN="${VSCe_BIN:-}"
if [ -z "$VSCe_BIN" ] && [ -x "/Users/alex/.nvm/versions/node/v20.10.0/bin/vsce" ]; then
  VSCe_BIN="/Users/alex/.nvm/versions/node/v20.10.0/bin/vsce"
fi
if [ -z "$VSCe_BIN" ]; then
  VSCe_BIN="$(command -v vsce || true)"
fi
if [ -z "$VSCe_BIN" ]; then
  echo "vsce not found. Set VSCe_BIN or install vsce." >&2
  exit 1
fi
"$VSCe_BIN" package
