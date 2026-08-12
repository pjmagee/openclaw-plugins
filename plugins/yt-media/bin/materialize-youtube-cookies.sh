#!/bin/sh
# Materialize a YouTube Netscape cookie jar from COOKIES_COMMAND (a shell
# command that prints the jar to stdout — e.g. a password-manager reader).
# Validates and atomically replaces the jar so a failed refresh never
# clobbers a working one.
set -eu

OUT="${YOUTUBE_COOKIES_PATH:-/root/.openclaw/credentials/youtube-cookies.txt}"
CMD="${COOKIES_COMMAND:-}"
TMP="${OUT}.tmp.$$"

if [ -z "$CMD" ]; then
  echo "COOKIES_COMMAND is not set" >&2
  exit 1
fi

sh -c "$CMD" > "$TMP"
# Basic Netscape jar sanity
if ! head -1 "$TMP" | grep -q "Netscape\|HTTP Cookie File\|# "; then
  echo "refreshed cookies do not look like a Netscape cookie jar" >&2
  rm -f "$TMP"
  exit 1
fi

BYTES=$(wc -c < "$TMP" | tr -d ' ')
if [ "$BYTES" -lt 200 ]; then
  echo "cookie jar too small ($BYTES bytes)" >&2
  rm -f "$TMP"
  exit 1
fi

chmod 600 "$TMP"
mv -f "$TMP" "$OUT"
echo "youtube-cookies: $OUT ($BYTES bytes)"
