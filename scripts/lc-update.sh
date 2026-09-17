#!/usr/bin/env bash
#
# Update Low Context in place, without sudo.
#
# Why this exists: `npm install -g` replaces a package by renaming the old
# directory aside first, so an interrupted install leaves a `.low-context-XXXX`
# directory behind and every later install fails with ENOTEMPTY — or EACCES when
# the target is root-owned. Installing into a directory you own, after clearing
# leftovers, removes both failure modes.
#
# The install source is the explicit HTTPS git URL, not the `github:owner/repo`
# shorthand: npm resolves the shorthand through SSH on some versions, which
# fails with "Permission denied (publickey)" on a machine without an SSH key.
# A public repository needs no credentials over HTTPS.
#
# Usage:  lc-update                  install the latest main from GitHub
#         lc-update --target <spec>  install any npm spec instead
set -euo pipefail

REPO_HTTPS="git+https://github.com/amazingcli/Low-Context-Cli.git"
ROOT="${LOW_CONTEXT_LAUNCHER:-$HOME/.local/share/low-context}"
TARGET="$REPO_HTTPS"

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:?--target needs an npm spec}"; shift 2 ;;
    --ref)    TARGET="$REPO_HTTPS#$2"; shift 2 ;;
    -h|--help) sed -n '3,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$ROOT"
cd "$ROOT"
if [ ! -f package.json ]; then
  printf '{\n  "name": "low-context-launcher",\n  "private": true,\n  "version": "1.0.0"\n}\n' > package.json
fi

echo "· removing previous copy (and any npm leftovers)"
rm -rf "$ROOT/node_modules/low-context" "$ROOT/node_modules/.low-context-"*
rm -f "$ROOT/package-lock.json"

echo "· installing $TARGET"
if ! npm install --no-audit --no-fund "$TARGET"; then
  if [ "$TARGET" = "$REPO_HTTPS" ]; then
    echo "· HTTPS clone failed, retrying with the npm shorthand"
    npm install --no-audit --no-fund github:amazingcli/Low-Context-Cli
  else
    exit 1
  fi
fi

BIN="$ROOT/node_modules/low-context/bin/low-context.js"
if [ ! -f "$BIN" ]; then
  echo "✖ install finished but $BIN is missing — your PATH was left untouched." >&2
  exit 1
fi

chmod +x "$BIN"
mkdir -p "$HOME/.local/bin"
ln -sfn "$BIN" "$HOME/.local/bin/lc"
ln -sfn "$BIN" "$HOME/.local/bin/low-context"

echo "✔ updated: $("$HOME/.local/bin/lc" version)"
echo "  at: $BIN"
