#!/usr/bin/env bash
#
# upload-lap-video.sh — push a local lap-cockpit MP4 to Bunny Edge Storage
# under `assets/videos/<lap_id>.mp4`, then optionally bump the `?v=` query
# in `public/assets/laps/manifest_video.json`.
#
# Why a shell script (not Node): keep the upload path single-binary so
# we don't pull dotenv + axios into the app's runtime tree just to ship
# 150 MB to Bunny once per session.
#
# Usage:
#   BUNNY_STORAGE_ZONE=... BUNNY_STORAGE_KEY=... \
#     ./scripts/upload-lap-video.sh \
#       videos/lap3-cockpit.mp4 um982_2952670682_lap3
#
# After: edit `public/assets/laps/manifest_video.json` and update the
# `video_path` for the lap to `/assets/videos/<lap_id>.mp4?v=<epoch>`
# (or pass --bump to do it automatically).

set -euo pipefail

SRC="${1:-}"
LAP_ID="${2:-}"
BUMP_MANIFEST="${3:-}"  # any non-empty value enables manifest bump

if [[ -z "$SRC" || -z "$LAP_ID" ]]; then
  echo "Usage: $0 <local-file.mp4> <lap_id> [--bump]"
  exit 1
fi
if [[ ! -f "$SRC" ]]; then
  echo "Source file not found: $SRC"
  exit 1
fi
if [[ -z "${BUNNY_STORAGE_ZONE:-}" || -z "${BUNNY_STORAGE_KEY:-}" ]]; then
  echo "Set BUNNY_STORAGE_ZONE and BUNNY_STORAGE_KEY (the storage zone Password — not the API key)."
  exit 1
fi

REGION_PREFIX=""
if [[ -n "${BUNNY_REGION:-}" ]]; then
  REGION_PREFIX="${BUNNY_REGION}."
fi

DST="assets/videos/${LAP_ID}.mp4"
URL="https://${REGION_PREFIX}storage.bunnycdn.com/${BUNNY_STORAGE_ZONE}/${DST}"

echo "→ PUT ${SRC} → ${URL}"
curl -fsS -X PUT \
  --data-binary "@${SRC}" \
  -H "AccessKey: ${BUNNY_STORAGE_KEY}" \
  -H "Content-Type: video/mp4" \
  "${URL}"
echo
echo "✓ uploaded"

if [[ "$BUMP_MANIFEST" == "--bump" ]]; then
  MANIFEST="public/assets/laps/manifest_video.json"
  if [[ ! -f "$MANIFEST" ]]; then
    echo "Manifest not found: $MANIFEST — skipping bump"
    exit 0
  fi
  EPOCH=$(date +%s)
  # In-place edit: find the lap entry by id and rewrite its video_path
  # `?v=<epoch>`. Use jq if available; otherwise fall back to a sed
  # heuristic.
  if command -v jq >/dev/null 2>&1; then
    tmpfile=$(mktemp)
    jq --arg id "$LAP_ID" --arg v "$EPOCH" \
      '(.laps[] | select(.id == $id) | .video_path) |= (sub("\\?v=[0-9]+"; "") + "?v=" + $v)' \
      "$MANIFEST" > "$tmpfile"
    mv "$tmpfile" "$MANIFEST"
    echo "✓ manifest bumped: ${LAP_ID}.video_path?v=${EPOCH}"
  else
    echo "jq not installed — manifest unchanged. Bump video_path manually."
  fi
fi
