#!/usr/bin/env bash
# Double-clickable launcher for macOS Finder. Opens the UI in your browser
# once the server is up, then keeps running -- close this Terminal window (or
# press Ctrl+C) to stop the server.
cd "$(dirname "$0")"

PORT="${PORT:-8080}"

# Wait for the server to answer, then open a browser tab. Runs in the
# background so the server itself stays in the foreground of this window.
(
  for _ in $(seq 1 60); do
    if curl -fsS -m 1 "http://localhost:$PORT/health" >/dev/null 2>&1; then
      open "http://localhost:$PORT"
      exit 0
    fi
    sleep 1
  done
) &

./start.sh
