#!/usr/bin/env bash
# DEVELOPMENT ONLY. Editors install the single .ccx instead (docs/INSTALL.md).
# Installs the engine into a private Python virtual environment and
# creates a double-clickable starter. macOS (works on Linux too).
#
#   bash installer/install-companion-macos.sh
#
# Nothing is downloaded except Python packages from PyPI. FFmpeg is not
# installed automatically; the script tells you how if it is missing.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPANION_SRC="$(cd "$HERE/../companion" && pwd)"
if [[ "$(uname)" == "Darwin" ]]; then
  APP_HOME="${ATHEER_HOME:-$HOME/Library/Application Support/AtheerPodcastStudio}"
else
  APP_HOME="${ATHEER_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/atheer-podcast-studio}"
fi
VENV="$APP_HOME/venv"
WITH_AI=0
[[ "${1:-}" == "--with-ai" ]] && WITH_AI=1

say() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

say "Checking Python (3.10 or newer)"
PY=""
for cand in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
    PY="$(command -v "$cand")"; break
  fi
done
[[ -n "$PY" ]] || fail "Python 3.10+ not found. Install it from https://www.python.org/downloads/ and run this again."
echo "Using $PY ($("$PY" --version))"

say "Creating virtual environment in $VENV"
mkdir -p "$APP_HOME"
"$PY" -m venv "$VENV"
"$VENV/bin/python" -m pip install --upgrade pip >/dev/null

say "Installing the companion"
if [[ $WITH_AI -eq 1 ]]; then
  "$VENV/bin/python" -m pip install "$COMPANION_SRC[ai]"
else
  "$VENV/bin/python" -m pip install "$COMPANION_SRC"
fi
"$VENV/bin/python" -m atheer_companion --version

say "Checking FFmpeg"
if command -v ffprobe >/dev/null 2>&1 && command -v ffmpeg >/dev/null 2>&1; then
  ffprobe -hide_banner -version | head -1
else
  echo "FFmpeg is NOT installed. Install it, then restart the companion:"
  echo "  macOS (Homebrew):  brew install ffmpeg"
  echo "  or download a static build and set ATHEER_FFMPEG / ATHEER_FFPROBE to its files."
fi

STARTER="$APP_HOME/Start ATHEER Companion.command"
cat > "$STARTER" <<EOF
#!/usr/bin/env bash
# Keep this window open while editing in Premiere.
export PATH="/opt/homebrew/bin:/usr/local/bin:\$PATH"
exec "$VENV/bin/python" -m atheer_companion "\$@"
EOF
chmod +x "$STARTER"

say "Done"
echo "Start the companion by double-clicking:"
echo "  $STARTER"
echo "Then enter the pairing code it shows in the Premiere panel."
