#!/usr/bin/env bash
# Start the Zork Cartographer server, then open http://localhost:8765
set -e
cd "$(dirname "$0")"
# Load settings from .env (PORT, ZORK_PASSWORD, ANTHROPIC_API_KEY, ...)
if [ -f .env ]; then set -a; . ./.env; set +a; fi
if ! command -v dfrotz >/dev/null; then
  echo "dfrotz not found. Install it with: brew install frotz"; exit 1
fi
if [ ! -d .venv ]; then
  python3 -m venv .venv
  .venv/bin/pip install -q -r requirements.txt
fi
cd server
exec ../.venv/bin/uvicorn app:app --host 127.0.0.1 --port "${PORT:-8765}"
