#!/bin/zsh
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Embed Agent requires Node.js 22+."
  echo "Install Node.js, then run this launcher again."
  read -r "?Press Enter to close..."
  exit 1
fi

if node "$SCRIPT_DIR/scripts/open.mjs"; then
  exit 0
fi

echo
echo "Embed Agent failed to start."
read -r "?Press Enter to close..."
exit 1
