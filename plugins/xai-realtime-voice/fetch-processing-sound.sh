#!/usr/bin/env bash
# Generate the "working on it" loop — the quiet cue the voice bridge plays
# between accepting a request and answering it (processing-sound.ts). Without
# a sound file that feature is a logged no-op.
#
#   bash fetch-processing-sound.sh                 # synthesize (default, no network)
#   bash fetch-processing-sound.sh --url '<URL>' \
#        --start 0.4 --duration 3.2 --force        # derive from YOUR OWN media via yt-dlp
#
# No audio ships with this plugin: the default synthesizes a soft two-tone
# pulse with ffmpeg alone. The --url mode exists so you can derive a cue from
# media you have the rights to use — mind the licensing of whatever you point
# it at.
#
# Output is a mono Opus file (mono because the cue is ambience, not music, and
# it halves the bitrate the loop occupies on the shared Discord stream),
# loudness-normalized to -20 LUFS with fades that hide the loop seam.

set -euo pipefail

YTDLP="${YTDLP:-yt-dlp}"
FFMPEG="${FFMPEG:-ffmpeg}"
FFPROBE="${FFPROBE:-ffprobe}"
COOKIES="${COOKIES:-}"

URL=""
OUT="${OUT:-/root/.openclaw/media/processing-loop.opus}"
START="0"
DURATION="4"
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)      URL="$2"; shift 2 ;;
    --out)      OUT="$2"; shift 2 ;;
    --start)    START="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --synth)    URL=""; shift ;;   # explicit synth (also the default)
    --force)    FORCE=1; shift ;;
    -h|--help)  sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v "$FFMPEG" >/dev/null 2>&1 || { echo "!! ffmpeg not found ($FFMPEG) — set FFMPEG=/path/to/ffmpeg" >&2; exit 1; }

if [[ -f "$OUT" && $FORCE -eq 0 ]]; then
  echo "already installed: $OUT"
  echo "   (--force to replace)"
  exit 0
fi

mkdir -p "$(dirname "$OUT")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Fades hide the loop seam. Without them every repeat clicks, which is exactly
# the kind of detail that makes a background cue feel wrong rather than subtle.
FADE_SEC=0.18
fade_filter() {
  local dur="$1"
  local out_start
  out_start=$(awk -v d="$dur" -v f="$FADE_SEC" 'BEGIN{printf "%.3f", (d-f<0?0:d-f)}')
  echo "afade=t=in:st=0:d=${FADE_SEC},afade=t=out:st=${out_start}:d=${FADE_SEC}"
}

if [[ -z "$URL" ]]; then
  echo "== synthesising a ${DURATION}s two-tone working cue"
  # Two detuned sines under a slow tremolo: audible as "something is happening"
  # without carrying a melody that competes with speech.
  "$FFMPEG" -hide_banner -loglevel error -y \
    -f lavfi -i "sine=frequency=220:duration=${DURATION}" \
    -f lavfi -i "sine=frequency=277:duration=${DURATION}" \
    -filter_complex "[0:a][1:a]amix=inputs=2:duration=shortest,tremolo=f=3.2:d=0.7,highpass=f=120,lowpass=f=3000,$(fade_filter "$DURATION"),loudnorm=I=-20:TP=-2:LRA=11,volume=-3dB" \
    -ac 1 -ar 48000 -c:a libopus -b:a 48k -application audio "$OUT"
else
  command -v "$YTDLP" >/dev/null 2>&1 || { echo "!! yt-dlp not found ($YTDLP) — omit --url for a synthesized cue" >&2; exit 1; }
  echo "== downloading $URL"
  YT_ARGS=(-f "bestaudio/best" -o "$TMP/src.%(ext)s" --no-playlist --quiet --no-warnings)
  [[ -n "$COOKIES" && -f "$COOKIES" ]] && YT_ARGS+=(--cookies "$COOKIES")
  if ! "$YTDLP" "${YT_ARGS[@]}" "$URL"; then
    echo "!! download failed. Omit --url for a synthesized cue." >&2
    exit 1
  fi
  SRC="$(find "$TMP" -maxdepth 1 -type f -name 'src.*' | head -1)"
  [[ -n "$SRC" ]] || { echo "!! yt-dlp produced no file" >&2; exit 1; }

  # Clamp the window to what the source actually has. Asking for more silently
  # truncates the output, which would put the fade-out past the end of the file
  # — an unfaded cut, i.e. a click on every loop.
  if command -v "$FFPROBE" >/dev/null 2>&1; then
    SRC_DUR="$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$SRC" 2>/dev/null || echo '')"
    if [[ -n "$SRC_DUR" ]]; then
      DURATION="$(awk -v s="$SRC_DUR" -v st="$START" -v d="$DURATION" \
        'BEGIN{avail=s-st; if (avail<=0) {print d} else if (d>avail) {printf "%.3f", avail} else {print d}}')"
      echo "   source is ${SRC_DUR}s; using ${DURATION}s from ${START}s"
    fi
  fi

  echo "== trimming ${START}s +${DURATION}s and normalising"
  "$FFMPEG" -hide_banner -loglevel error -y \
    -ss "$START" -t "$DURATION" -i "$SRC" \
    -af "$(fade_filter "$DURATION"),loudnorm=I=-20:TP=-2:LRA=11,volume=-3dB" \
    -ac 1 -ar 48000 -c:a libopus -b:a 48k -application audio "$OUT"
fi

if command -v "$FFPROBE" >/dev/null 2>&1; then
  LEN="$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$OUT" 2>/dev/null || echo '?')"
else
  LEN='?'
fi
echo "installed: $OUT ($(stat -c %s "$OUT" 2>/dev/null || wc -c < "$OUT") bytes, ${LEN}s)"
echo
echo "The bridge picks it up on the next voice session — no restart needed."
echo "Tune with OPENCLAW_VOICE_PROCESSING_SOUND_VOLUME (default 0.35), or point"
echo "OPENCLAW_VOICE_PROCESSING_SOUND at a different file."
