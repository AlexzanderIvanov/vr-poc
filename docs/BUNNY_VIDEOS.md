# Hosting lap videos on Bunny CDN

The app loads lap-cockpit videos from the same CDN as the rest of the
`/assets/` tree — `https://vr-raceai-me-poc.b-cdn.net` in production
(see `src/config.js`). On localhost the dev server serves them out of
`public/assets/videos/`; that directory is `.gitignored` because lap
recordings are 100+ MB each and GitHub rejects single files over 100 MB.

This doc covers two related questions:

1. How to push a new lap recording to Bunny CDN (one-time, after a
   shoot day).
2. How (and whether) to "preload" so the edge cache is warm before the
   first viewer hits it.

## Storage layout

Bunny has two products that look like video hosts:

| Product | Use | Storage cost | When to use |
|---|---|---|---|
| **Edge Storage** + **Pull/Push Zone** | Generic CDN — serves the file you uploaded as-is | ~$0.01 / GB | Pre-transcoded MP4s (our case) |
| **Stream** | Transcoded HLS/DASH with per-viewer DRM, captions, embed players | ~$0.005 / min watched | Adaptive bitrate streaming; we don't need it |

We use **Edge Storage** because the lap MP4s are already in the format /
bitrate we want and the playback path is the same HTML5 `<video>` tag
the rest of the app uses.

**Storage zone**: `vr-raceai-me-poc-storage` (or whatever was created
during the initial setup).
**Pull zone**: `vr-raceai-me-poc` (URL `https://vr-raceai-me-poc.b-cdn.net`).
**Path convention**: `/assets/videos/<lap_id>.mp4` and
`/assets/videos/<lap_id>_mobile.mp4` (+ matching `.m4a` for separate
audio when the mobile encode needs an out-of-band audio track).

## Upload (one-time per lap)

The app's manifest expects:

```json
{
  "video_path": "/assets/videos/<lap_id>.mp4?v=<timestamp>",
  "video_path_mobile": "/assets/videos/<lap_id>_mobile.mp4?v=<timestamp>",
  "audio_path_mobile": "/assets/videos/<lap_id>_mobile.m4a?v=<timestamp>",
  "video_lap_start_sec": <float>,
  "video_label": "Cockpit cam — lap N"
}
```

To get a file onto the CDN:

```bash
# Bunny Storage upload via their REST API
# (https://docs.bunny.net/reference/put_-storagezonename-path-filename)
#
# Required env:
#   BUNNY_STORAGE_ZONE  e.g. vr-raceai-me-poc-storage
#   BUNNY_STORAGE_KEY   the "Password" field in the storage zone settings
#                       (NOT the API key — different scope)
#   BUNNY_REGION        empty for "global", or e.g. "ny" / "la" / "sg" for
#                       a region-pinned storage zone

LAP_ID="um982_2952670682_lap3"
SRC="videos/lap3-cockpit.mp4"     # local copy
DST="assets/videos/${LAP_ID}.mp4"  # path inside the storage zone

curl -X PUT \
  --data-binary "@${SRC}" \
  -H "AccessKey: ${BUNNY_STORAGE_KEY}" \
  -H "Content-Type: video/mp4" \
  "https://${BUNNY_REGION:+${BUNNY_REGION}.}storage.bunnycdn.com/${BUNNY_STORAGE_ZONE}/${DST}"
```

Once uploaded, the file is available at
`https://vr-raceai-me-poc.b-cdn.net/${DST}` — but only after the **pull
zone** has cached it (next section).

### Bumping `?v=` in the manifest

The app's `assetUrl()` doesn't strip the query string when proxying to
the CDN; the CDN treats `?v=1` and `?v=2` as separate cache keys. So:

1. Upload the file to a stable path: `/assets/videos/lap3.mp4`.
2. Edit `public/assets/laps/manifest_video.json` and bump the
   `?v=<timestamp>` on every `video_path` / `video_path_mobile` /
   `audio_path_mobile` whose underlying file you changed.
3. Commit the manifest. Deploy.

Browsers and the service worker (`public/sw.js`) treat the URL-with-
query as the cache key, so a stale `?v=` → instant invalidation
without manually purging Bunny.

## Preload / warm the edge

Bunny supports **two** preload mechanisms; we use the second.

### 1. `bunnycdn.com/api/pullzone/{id}/preloadCache` (manual)

POSTs a list of URLs; Bunny fetches them from origin into every edge
PoP. Requires the pull zone's numeric ID and an account API key.
Useful when you've just pushed an update and want every region warm
before users see the link. Pseudocode:

```bash
curl -X POST \
  -H "AccessKey: ${BUNNY_API_KEY}" \
  -H "Content-Type: application/json" \
  --data '{"Url":"https://vr-raceai-me-poc.b-cdn.net/assets/videos/um982_2952670682_lap3.mp4?v=1777146964"}' \
  "https://api.bunny.net/pullzone/${PULL_ZONE_ID}/preloadCache"
```

### 2. `cache-state` HTTP request + `bunny-set-cache-strategy` (automatic)

The first viewer in each region pays the origin round-trip, then
subsequent viewers in that region get the cached copy. Combined with
the `Cache-Control: public, max-age=2592000, immutable` headers nginx
already sets (`nginx.conf`), one warm hit per region is enough — the
file then stays at the edge for 30 days unless `?v=` changes.

The trade-off: the FIRST viewer in a cold region pays an extra
~150–500 ms. Acceptable for our usage (the analysis layout shows the
video in a panel; users actively wait for it).

### Recommended workflow

1. Push manifest + file via the `curl PUT` above.
2. Do NOT manually pre-warm — let lazy-pull populate edges on demand.
3. After verifying the new manifest deploys, optionally request a
   manual purge of the manifest URL on Bunny so stale `manifest_video.json`
   doesn't linger at the edge (only the manifest is un-versioned).

## Quick verification

After upload, the simplest end-to-end check is:

```bash
curl -I "https://vr-raceai-me-poc.b-cdn.net/assets/videos/${LAP_ID}.mp4?v=$(date +%s)"
# Expect: 200, Content-Type: video/mp4, CDN-Cache: MISS on first call,
#         HIT on the next call from the same region.
```
