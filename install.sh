#!/usr/bin/env sh
# Installs Voice Coding Companion from a source checkout on macOS or Linux.
# Usage (from the repository folder):  sh install.sh [--models|--no-models]
set -e
cd "$(dirname "$0")"

fail() { echo "x $1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Install Node.js 20+ from https://nodejs.org and run this again."
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 20 ] || fail "Node.js $(node --version) is too old. Install Node.js 20 or newer."
echo "Node.js $(node --version) found."

echo "Installing dependencies (npm ci)..."
npm ci --no-audit --no-fund || fail "npm ci failed. See the output above."

echo "Building..."
npm run build || fail "Build failed. See the output above."

case "$1" in
  --no-models) ;;
  --models) npm run models -- moonshine-base ;;
  *)
    printf "Download on-device speech recognition (~65 MB from huggingface.co) so speech works offline? [Y/n] "
    read -r answer || answer=""
    case "$answer" in [Nn]*) echo "Skipped. Download later from the setup wizard or with: npm run models" ;; *) npm run models -- moonshine-base ;; esac
    ;;
esac

npm run doctor || true
echo
echo "Start the app with: npm start"
