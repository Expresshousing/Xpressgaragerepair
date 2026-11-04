#!/usr/bin/env bash
# Run on the server after you upload new website files:  bash deploy/update.sh
# Takes a backup first, rebuilds the pages for your domain, restarts the site, and checks it came back healthy.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a                       # reads SITE_URL etc.
echo "1/4 backup";   node backup.mjs || echo "(no database yet, skipping)"
echo "2/4 build";    node build.mjs | tail -1
echo "3/4 tests";    node verify.mjs | head -2
echo "4/4 restart";  sudo systemctl restart xpress
sleep 2
curl -fsS "http://127.0.0.1:${PORT:-4190}/healthz" && echo "  <- site is healthy"
