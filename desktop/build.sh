#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 "$ROOT/desktop/prepare_build.py"
cd "$ROOT/desktop"
npm ci
PATH="$HOME/.cargo/bin:$PATH" npm run build
