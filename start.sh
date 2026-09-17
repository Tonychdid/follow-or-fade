#!/usr/bin/env sh
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  printf "Paste your Nansen API key (or press Enter for demo mode): "
  read KEY
  printf "NANSEN_API_KEY=%s\nPORT=3000\nMAX_HOLD_HOURS=48\nCALIBRATION_SAMPLE=60\nDEMO=0\n" "$KEY" > .env
fi
node server.js
