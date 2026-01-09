# Upstream Compare

Upstream source: C:\Users\Ayelex\src\Music\tidal-ui
Upstream commit: 98e65392802136552a8263df16a55115d0148a5f

Playback-related diffs referenced:
- src/lib/api.ts (isV2ApiContainer version check; upstream accepts any 2.x, this repo had 2.0 only)

Pulled upstream behavior:
- Accept API container versions that start with "2." to avoid mis-parsing 2.x responses.
