#!/usr/bin/env bash
#
# upload-lap-assets.sh — bulk-push everything under `public/assets/laps/`
# to a Bunny Edge Storage zone. Required to recover after the pull zone
# was re-linked to a storage zone that didn't already have the lap JSONs.
#
# Idempotent: re-running just overwrites, which is what we want since the
# lap files use `?v=…` cache-busting and Bunny Storage is content-as-is.
#
# Usage:
#   BUNNY_STORAGE_ZONE=vr-poc-dev BUNNY_STORAGE_KEY=… \
#     ./scripts/upload-lap-assets.sh
#
# Optional vars:
#   BUNNY_REGION   region prefix when the storage zone is region-pinned
#                  (e.g. "ny" / "la" / "sg"). Empty = global.
#   ASSETS_DIR     override the source directory (defaults to
#                  public/assets/laps relative to repo root).

set -euo pipefail

ASSETS_DIR="${ASSETS_DIR:-public/assets/laps}"
REMOTE_PREFIX="assets/laps"

if [[ ! -d "$ASSETS_DIR" ]]; then
  echo "Source dir not found: $ASSETS_DIR" >&2
  exit 1
fi
if [[ -z "${BUNNY_STORAGE_ZONE:-}" || -z "${BUNNY_STORAGE_KEY:-}" ]]; then
  echo "Set BUNNY_STORAGE_ZONE and BUNNY_STORAGE_KEY first." >&2
  exit 1
fi

REGION_PREFIX=""
if [[ -n "${BUNNY_REGION:-}" ]]; then
  REGION_PREFIX="${BUNNY_REGION}."
fi
BASE_URL="https://${REGION_PREFIX}storage.bunnycdn.com/${BUNNY_STORAGE_ZONE}/${REMOTE_PREFIX}"

count=0
fails=0
while IFS= read -r -d '' file; do
  rel="${file#${ASSETS_DIR}/}"
  url="${BASE_URL}/${rel}"
  # Decide a sensible Content-Type. The lap files are all JSON.
  ct="application/json"
  case "$rel" in
    *.json) ct="application/json" ;;
    *)      ct="application/octet-stream" ;;
  esac
  printf "→ %-60s " "$rel"
  if curl -fsS -X PUT --data-binary "@${file}" \
       -H "AccessKey: ${BUNNY_STORAGE_KEY}" \
       -H "Content-Type: ${ct}" \
       "$url" >/dev/null; then
    echo "ok"
    count=$((count + 1))
  else
    echo "FAIL"
    fails=$((fails + 1))
  fi
done < <(find "$ASSETS_DIR" -type f -print0)

echo
echo "Uploaded: $count  Failed: $fails"
exit "$fails"
