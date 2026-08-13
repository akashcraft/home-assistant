#!/usr/bin/env bash
#
# One-click launcher: builds the frontend if needed, then serves the whole app
# -- UI and API -- from a single python process on port 8080.
#
#   ./start.sh              build if stale, then run
#   ./start.sh --rebuild    force a fresh frontend build
#   ./start.sh --no-build   skip the build entirely (fastest start)
#
# On macOS you can double-click "Home Lights.command" in Finder instead.
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-8080}"
FORCE_BUILD=false
SKIP_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --rebuild)  FORCE_BUILD=true ;;
    --no-build) SKIP_BUILD=true ;;
    *) echo "Unknown option: $arg"; echo "Usage: ./start.sh [--rebuild|--no-build]"; exit 1 ;;
  esac
done

# --- Pick a python that actually has the dependencies --------------------
# Preference order: an explicit $PYTHON, a local venv, the project's conda env,
# then whatever python3 is on PATH. The music engine runs as subprocesses via
# sys.executable, so this same interpreter needs librosa/pygame for light shows.
pick_python() {
  if [ -n "${PYTHON:-}" ]; then echo "$PYTHON"; return; fi
  for candidate in \
    ".venv/bin/python" \
    "venv/bin/python" \
    "$HOME/miniconda3/envs/homeassistant-led/bin/python" \
    "/opt/homebrew/Caskroom/miniconda/base/envs/homeassistant-led/bin/python"
  do
    [ -x "$candidate" ] && { echo "$candidate"; return; }
  done
  command -v python3 || command -v python
}

PY="$(pick_python)"
if [ -z "$PY" ]; then
  echo "No python found. Install python3, or set PYTHON=/path/to/python." >&2
  exit 1
fi
echo "Python:   $PY"

if ! "$PY" -c "import flask, flask_socketio" >/dev/null 2>&1; then
  echo
  echo "Missing server dependencies for $PY."
  echo "Install them with:"
  echo "    $PY -m pip install -r requirements.txt"
  exit 1
fi

if ! "$PY" -c "import librosa, pygame" >/dev/null 2>&1; then
  echo "Note:     librosa/pygame missing -- lights and routines work, but music"
  echo "          playback and timeline generation will not."
fi

# --- Build the frontend if it's missing or out of date --------------------
needs_build() {
  $FORCE_BUILD && return 0
  [ -f "front-end/dist/index.html" ] || return 0
  # Rebuild when any source file is newer than the built entry point.
  [ -n "$(find front-end/src front-end/index.html front-end/package.json \
            -newer front-end/dist/index.html -print -quit 2>/dev/null)" ]
}

if $SKIP_BUILD; then
  echo "Build:    skipped (--no-build)"
elif needs_build; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm not found -- cannot build the frontend." >&2
    echo "Install Node.js, or run with --no-build if dist/ is already there." >&2
    exit 1
  fi
  echo "Build:    frontend out of date, building..."
  ( cd front-end && [ -d node_modules ] || npm install )
  ( cd front-end && npm run build )
else
  echo "Build:    up to date"
fi

# --- Report the address(es) the UI will be reachable at -------------------
LAN_IP="$( { ipconfig getifaddr en0 2>/dev/null \
           || hostname -I 2>/dev/null | awk '{print $1}'; } || true )"
echo
echo "Home Lights is starting on port $PORT"
echo "    http://localhost:$PORT"
[ -n "$LAN_IP" ] && echo "    http://$LAN_IP:$PORT   (phones, tablets, other machines)"
echo "Press Ctrl+C to stop."
echo

exec env PORT="$PORT" "$PY" server.py
