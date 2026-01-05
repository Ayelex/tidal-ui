# Tidal UI Copilot Instructions

## Project Overview
This is a high-fidelity music streaming UI built with SvelteKit, providing lossless playback, search, downloads, and lyrics for Tidal. It integrates with the HIFI API (external repo) and supports multiple deployment targets (Node, Cloudflare, Vercel).

## Architecture
- **Frontend**: SvelteKit with Svelte 5, Tailwind CSS v4, TypeScript
- **State Management**: Svelte stores (player, library, user preferences, downloads)
- **Audio Playback**: Shaka Player for DASH streaming with quality selection
- **API Integration**: Multiple failover endpoints, CORS proxy at `/api/proxy`, optional Redis caching
- **Downloads**: FFmpeg WASM for metadata embedding and format conversion
- **PWA**: Service worker, offline shell, installable

## Key Components
- `src/lib/components/AudioPlayer.svelte`: Main player with queue, controls, downloads
- `src/lib/stores/player.ts`: Playback state, queue management
- `src/lib/api.ts`: HIFI API client with failover logic
- `src/routes/api/proxy/+server.ts`: CORS proxy with Redis caching
- `src/lib/downloads.ts`: FFmpeg-based download processing

## Development Workflows
- **Start dev server**: `npm run dev` (Vite dev server)
- **Build**: `npm run build` (Vite build, excludes FFmpeg from SSR)
- **Lint**: `npm run lint` (Prettier + ESLint)
- **Type check**: `npm run check` (SvelteKit sync + svelte-check)
- **Docker**: `docker compose up --build` for production container

## Project-Specific Patterns
- **Artist formatting**: Use `formatArtists()` for UI display ("Artist1 & Artist2"), `formatArtistsForMetadata()` for tags ("Artist1; Artist2")
- **Filename sanitization**: `sanitizeForFilename()` replaces invalid chars with underscores
- **API failover**: `selectApiTargetForRegion()` chooses from weighted targets in `config.ts`
- **Quality derivation**: `deriveTrackQuality()` maps user prefs to available qualities
- **Error handling**: Check for `DASH_MANIFEST_UNAVAILABLE_CODE` in streaming failures
- **Caching**: Redis only for safe GET requests, configurable TTLs per endpoint type

## Integration Points
- **HIFI API**: External service at multiple endpoints (squid-api, kinoplus, etc.)
- **Redis**: Optional caching via `REDIS_URL`, tuned for search (300s), tracks (120s)
- **FFmpeg WASM**: Loaded from CDN, excluded from Vite optimization
- **Shaka Player**: DASH manifest parsing, networking filters for proxy
- **Color extraction**: colorthief for dynamic backgrounds
- **Lyrics**: YouLy+ API for synced lyrics with karaoke

## Conventions
- **Imports**: Use `$lib/` aliases for internal modules
- **Types**: Centralized in `src/lib/types.ts`
- **Environment**: `.env` for Redis, region prefs; no secrets in client code
- **Styling**: Tailwind utility classes, no custom CSS except `app.css`
- **Error boundaries**: Graceful fallbacks (e.g., downloads without FFmpeg)
- **Performance**: Stream prefetching, lazy loading, PWA caching

## Deployment
- **Adapters**: Choose based on target (Node for Docker, Cloudflare for edge)
- **Environment vars**: `PORT`, `REDIS_*`, `TITLE` for branding
- **Static assets**: Fonts/icons in `static/`, optimized with Vite

## Debugging Tips
- **API issues**: Check browser network tab for proxy failures, verify target selection
- **Playback**: Inspect Shaka player logs, check manifest availability
- **Downloads**: FFmpeg load errors fall back to raw streams
- **Caching**: Monitor Redis keys with `redis-cli KEYS "tidal:*"`</content>
<parameter name="filePath">c:\Users\Ayelex\src\tidal-ui\.github\copilot-instructions.md