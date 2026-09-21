#!/usr/bin/env sh
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  printf "Paste your Nansen API key (or press Enter for demo mode): "
  read KEY
  printf "NANSEN_API_KEY=%s\nPORT=3000\nMAX_HOLD_HOURS=48\nCALIBRATION_SAMPLE=60\nDEMO=0\n" "$KEY" > .env
fi
# Local run: keep the alert settings reachable without a token (a hosted deploy never sets this).
DEV_OPEN_ADMIN=1 node server.js
