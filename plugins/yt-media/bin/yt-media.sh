#!/bin/sh
# Resolve or download YouTube media audio with yt-dlp (+ optional cookies).
# The plugin passes YT_DLP_PATH / YOUTUBE_COOKIES_PATH / YT_MEDIA_CACHE /
# COOKIES_COMMAND via env and prepends the tool directories to PATH.
set -eu

YT_DLP="${YT_DLP_PATH:-yt-dlp}"
COOKIES="${YOUTUBE_COOKIES_PATH:-/root/.openclaw/credentials/youtube-cookies.txt}"
CACHE_DIR="${YT_MEDIA_CACHE:-/root/.openclaw/media/yt-media-cache}"
MODE="${1:-}"
QUERY="${2:-}"

usage() {
  cat >&2 <<'EOF'
Usage:
  yt-media.sh materialize-cookies
  yt-media.sh resolve "<query or url>"
  yt-media.sh download "<query or url>"
  yt-media.sh stream-url "<query or url>"
EOF
  exit 2
}

[ -n "$MODE" ] || usage

materialize() {
  if [ -z "${COOKIES_COMMAND:-}" ]; then
    echo "no COOKIES_COMMAND configured — nothing to materialize" >&2
    exit 1
  fi
  # via sh so a lost exec bit (tarball extract) cannot break cookie refresh
  sh "$(dirname "$0")/materialize-youtube-cookies.sh"
}

# Refresh only when a command is configured and the jar is missing/empty.
# Cookieless deployments simply run yt-dlp without --cookies.
ensure_cookies() {
  if [ -n "${COOKIES_COMMAND:-}" ] && [ ! -s "$COOKIES" ]; then
    materialize
  fi
}

# Prefer search for bare text; pass URLs through.
normalize_input() {
  q="$1"
  case "$q" in
    http://*|https://*|ytsearch*|ytsearchdate*)
      printf '%s' "$q"
      ;;
    *)
      printf 'ytsearch1:%s' "$q"
      ;;
  esac
}

ytdlp_base() {
  ensure_cookies
  set -- --js-runtimes node --no-playlist --no-warnings "$@"
  if [ -s "$COOKIES" ]; then
    set -- --cookies "$COOKIES" "$@"
  fi
  "$YT_DLP" "$@"
}

case "$MODE" in
  materialize-cookies)
    materialize
    ;;
  resolve)
    [ -n "$QUERY" ] || usage
    target=$(normalize_input "$QUERY")
    # JSON line: id|title|duration|webpage_url
    ytdlp_base \
      --print "%(id)s|||%(title)s|||%(duration)s|||%(webpage_url)s" \
      -f "ba/bestaudio/best" \
      --skip-download \
      "$target"
    ;;
  stream-url)
    [ -n "$QUERY" ] || usage
    target=$(normalize_input "$QUERY")
    ytdlp_base -f "ba/bestaudio/best" -g "$target"
    ;;
  download)
    [ -n "$QUERY" ] || usage
    target=$(normalize_input "$QUERY")
    mkdir -p "$CACHE_DIR"
    # Restrict templates; avoid path injection via title
    outtmpl="${CACHE_DIR}/%(id)s.%(ext)s"
    ytdlp_base \
      -f "ba/bestaudio/best" \
      -o "$outtmpl" \
      --print "after_move:%(filepath)s|||%(id)s|||%(title)s|||%(duration)s|||%(webpage_url)s" \
      "$target"
    ;;
  *)
    usage
    ;;
esac
