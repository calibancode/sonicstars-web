#!/usr/bin/env bash
# Serve the web build locally and open it. Ctrl+C to stop.
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-8765}"
URL="http://localhost:$PORT/"
( sleep 0.6; xdg-open "$URL" >/dev/null 2>&1 || open "$URL" >/dev/null 2>&1 || true ) &
echo "SonicStars at $URL  (Ctrl+C to stop)"
exec python3 -m http.server "$PORT" --bind 127.0.0.1
