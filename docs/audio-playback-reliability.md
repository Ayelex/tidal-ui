# Audio Playback Reliability Report

## Root Causes (Confirmed by Instrumentation)
- Media loads were CORS-enforced by default (`crossOrigin = "anonymous"`). TIDAL CDN responses frequently omit `Access-Control-Allow-Origin`, which produced `error` events with `MEDIA_ERR_NETWORK`/`MEDIA_ERR_SRC_NOT_SUPPORTED` and no `canplay`/`playing` transition. The new `audio-init`, `error`, and `stream-probe` logs expose this directly.
- Stream resolution was single-shot and would stall indefinitely without retries. Timeouts/stalls were not treated as failures, so the player could remain in `loading` forever. Cache entries were reused without validation on real playback.

## What Changed
- Rebuilt the load pipeline to use multiple attempts with backoff, treat timeouts/stalls as failures, and retry with fresh URLs.
- Added detailed telemetry for resolve attempts, chosen URL, probe status/content-type/range headers, audio events, and `play()` rejections.
- Added a persistent stream cache (IndexedDB, fallback to localStorage) that is validated only after `playing`.
- CORS enforcement is now opt-in (`?audioCors=1` or `localStorage.tidal-audio-cors=1`).
- Added cautious “preload next track” behavior with a small range warm-up, guarded by network conditions.

## Cache Behavior
- Key: `{trackId}:{quality}`.
- TTL: 6 hours, or earlier if the URL includes an expiry query param.
- Invalidated after repeated failures (or immediately when a cached URL fails).
- Writes occur on successful `playing` events and are persisted to IndexedDB with localStorage fallback.

## Validation Plan
- Play 50 tracks sequentially; watch console logs for `resolve-success`, `playing`, and low failure counts.
- Rapidly spam next/previous; confirm no `loading` hangs and retries occur after `timeout`/`stalled`.
- iOS/mobile: confirm `play-reject` logs show `NotAllowedError` (and UI requests a gesture).
- Optional: open `/debug/audio` in dev to inspect the event timeline and metrics.

## Automation
- `tests/e2e/audio-soak.spec.ts` exercises 50 sequential plays in mock mode to catch deadlocks/regressions.
