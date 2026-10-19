#!/data/data/com.termux/files/usr/bin/bash
# PocketPhotos installer for Termux (Android).
# Usage:  bash scripts/termux-install.sh [/path/to/media/folder]
set -e

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
echo "==> Installing packages (nodejs-lts, ffmpeg, openssl, termux-api)…"
pkg update -y
pkg install -y nodejs-lts ffmpeg openssl-tool termux-api || pkg install -y nodejs ffmpeg openssl-tool termux-api

if [ ! -d "$HOME/storage" ]; then
  echo "==> Requesting storage permission – tap ALLOW on the phone."
  termux-setup-storage
  sleep 4
fi

echo
echo "==> Storage volumes visible to Termux:"
ls -1 /storage 2>/dev/null | grep -v -e '^self$' -e '^emulated$' | while read -r v; do echo "    /storage/$v"; done
echo "    (your USB SSD looks like /storage/XXXX-XXXX)"
echo

MEDIA="$1"
if [ -z "$MEDIA" ]; then
  read -r -p "Media folder on the SSD (e.g. /storage/1A2B-3C4D/Photos): " MEDIA
fi
if [ -z "$MEDIA" ]; then
  echo "No folder given. Edit $APP_DIR/config.json later."; MEDIA="$HOME/storage/shared/PocketPhotos"
fi
mkdir -p "$MEDIA" 2>/dev/null || true

if [ ! -f "$APP_DIR/config.json" ]; then
  cat > "$APP_DIR/config.json" <<EOF
{
  "mediaDir": "$MEDIA",
  "port": 8080,
  "workers": 2
}
EOF
  echo "==> Wrote $APP_DIR/config.json"
fi

# Auto-start on boot via the Termux:Boot add-on (install it from F-Droid and open it once).
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/pocketphotos" <<EOF
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
cd "$APP_DIR" && exec ./scripts/start.sh >> "$HOME/pocketphotos.log" 2>&1
EOF
chmod +x "$HOME/.termux/boot/pocketphotos" "$APP_DIR/scripts/"*.sh

echo
echo "==> Done. Start the server with:   $APP_DIR/scripts/start.sh"
echo "    It will also start automatically after reboot if Termux:Boot is installed."
echo "    Create user IDs/passwords on THIS phone at:  http://localhost:8080/admin"
