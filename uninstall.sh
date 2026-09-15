#!/usr/bin/env bash
#
# Low Context uninstaller.
#
#   ./uninstall.sh              unlink the global command only
#   ./uninstall.sh --purge      also delete ~/.low-context (ALL MEMORY IS LOST)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

echo "==> Unlinking global command"
npm unlink --no-audit --no-fund >/dev/null 2>&1 || true

if [ "$PURGE" -eq 1 ]; then
  echo "==> Removing $HOME/.low-context"
  rm -rf "$HOME/.low-context"
  echo "Removed persistent memory, indexes, sessions and logs."
fi

echo "==> Removing build output"
rm -rf "$ROOT/dist" "$ROOT/node_modules"

echo "Low Context uninstalled. Project-local .low-context/ directories were left untouched."
