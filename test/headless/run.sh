#!/usr/bin/env bash
# Storefront mobile-journey drive — mirrors mbg-dashboard/tests/headless:
# playwright-core lands here only (no repo-level build step / package.json).
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules/playwright-core ]; then
  npm install --no-save --no-audit --no-fund playwright-core@1.49.1
fi

node run.mjs
