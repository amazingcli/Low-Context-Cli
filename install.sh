#!/usr/bin/env bash
#
# Low Context installer.
#
#   ./install.sh              install dev dependencies, build, link globally
#   ./install.sh --no-link    build only, do not attempt `npm link`
#   ./install.sh --prod       skip dev dependencies (requires a prior build)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

LINK=1
INSTALL_DEPS=1
for arg in "$@"; do
  case "$arg" in
    --no-link) LINK=0 ;;
    --prod) INSTALL_DEPS=0 ;;
    -h|--help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "Node.js >= 18.17 is required." >&2; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js >= 18.17 is required (found $(node -v))." >&2
  exit 1
fi

if [ "$INSTALL_DEPS" -eq 1 ]; then
  echo "==> Installing dependencies (typescript + node types only)"
  npm install --no-audit --no-fund
fi

echo "==> Building"
npm run build

mkdir -p "$HOME/.low-context/config" "$HOME/.low-context/logs"

if [ "$LINK" -eq 1 ]; then
  echo "==> Linking 'low-context' globally"
  npm link --no-audit --no-fund >/dev/null 2>&1 || {
    echo "npm link failed (permissions?). You can still run: node $ROOT/bin/low-context.js"
  }
fi

echo
echo "Low Context installed."
echo "  Try: low-context doctor"
echo "  Or:  node $ROOT/bin/low-context.js doctor"
