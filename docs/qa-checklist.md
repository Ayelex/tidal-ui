# QA Checklist

Status: In progress (baseline updated after fixes).

## Environment
- Date: 2025-12-27
- Device(s): Pending
- Browser(s): Pending
- Build/version: npm run build (warnings only)

## Test Steps
1) Baseline checks: npm run check, npm run lint, npm run build.
2) Audio playback: play/pause, next/prev, seek, repeat, shuffle.
3) Backgrounding: lock/unlock, app switch, return to app.
4) Navigation: move between routes while playing; verify continuity.
5) Search: query, clear on home, return behavior.
6) Touch targets: tap controls near player/shadows; no blocked taps.

## Results
- npm run check: pass
- npm run lint: fails (Prettier formatting in multiple files)
- npm run build: pass (Svelte fork warnings + chunk size warning)
- Manual iOS/desktop QA: pending
