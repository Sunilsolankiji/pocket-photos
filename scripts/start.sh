#!/data/data/com.termux/files/usr/bin/bash
# Starts PocketPhotos and restarts it automatically if it ever crashes.
cd "$(dirname "$0")/.." || exit 1
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
while true; do
  node server.js
  code=$?
  [ "$code" -eq 0 ] && break
  echo "[$(date)] PocketPhotos exited with code $code – restarting in 10s…"
  sleep 10
done
