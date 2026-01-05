import { losslessAPI } from '$lib/api';
import type { SonglinkResponse, SonglinkTrack, SpotifyTrackMetadata, Track } from '$lib/types';
import { extractTidalInfo, extractTidalSongEntity, fetchSonglinkData } from '$lib/utils/songlink';

export type TrackSearchSource = {
	title?: string;
	artistName?: string;
	albumName?: string;
	isrc?: string;
	durationMs?: number;
};

export type ResolveOptions = {
	userCountry?: string;
	songIfSingle?: boolean;
	resolveAttempts?: number;
	searchAttempts?: number;
	minScore?: number;
	forceScore?: number;
	allowLooseTitle?: boolean;
	fetchTrack?: boolean;
	cacheKey?: string;
	existingSonglinkData?: SonglinkResponse;
	existingTidalId?: number | null;
	existingLinkUrl?: string | null;
	existingThumbnailUrl?: string | null;
};

export type ResolveResult = {
	tidalId: number | null;
	linkUrl?: string;
	thumbnailUrl?: string;
	songlinkData?: SonglinkResponse;
	track?: Track;
	status: 'ready' | 'missing';
};

const RESOLVE_RETRY_DELAYS_MS = [300, 800, 1600, 3000, 4500];
const TRACK_CACHE_LIMIT = 500;

const trackCache = new Map<number, Track>();
const resolveInFlight = new Map<string, Promise<ResolveResult>>();

export const resolveUserCountry = (): string | undefined => {
	if (typeof navigator === 'undefined') return undefined;
	const parts = navigator.language?.split('-');
	return parts?.[1]?.toUpperCase();
};

const normalizeText = (value: string) =>
	value
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9\s]+/gi, '')
		.toLowerCase()
		.trim();

const stripDecorations = (value: string) =>
	value
		.replace(/\s*[\(\[]\s*(feat|ft|featuring|with)\b[^\)\]]*[\)\]]/gi, '')
		.replace(/\s*-\s*(feat|ft|featuring|with)\b.+$/gi, '')
		.replace(
			/\s*-\s*(remaster(?:ed)?|mix|version|edit|live|mono|stereo|deluxe|bonus|explicit|clean|radio|instrumental|acoustic|demo)\b.*$/gi,
			''
		)
		.replace(/\s+/g, ' ')
		.trim();

const tokenOverlap = (sourceValue: string, candidateValue: string) => {
	if (!sourceValue || !candidateValue) return false;
	const tokens = sourceValue.split(' ').filter((token) => token.length >= 3);
	if (tokens.length === 0) return false;
	const matched = tokens.filter((token) => candidateValue.includes(token));
	if (tokens.length === 1) return matched.length === 1;
	return matched.length / tokens.length >= 0.6;
};

const isLikelyTitleMatch = (candidate: Track, targetTitle: string) => {
	const candidateTitle = normalizeText(candidate.title ?? '');
	if (!candidateTitle || !targetTitle) return false;
	if (candidateTitle === targetTitle) return true;
	if (candidateTitle.includes(targetTitle) || targetTitle.includes(candidateTitle)) {
		return true;
	}
	return tokenOverlap(candidateTitle, targetTitle) || tokenOverlap(targetTitle, candidateTitle);
};

const buildNormalizedSource = (source: TrackSearchSource) => {
	const rawTitle = source.title ?? '';
	const rawArtist = source.artistName ?? '';
	const rawAlbum = source.albumName ?? '';
	const cleanTitle = stripDecorations(rawTitle);
	const cleanArtist = stripDecorations(rawArtist);
	const cleanAlbum = stripDecorations(rawAlbum);
	return {
		targetTitle: normalizeText(cleanTitle || rawTitle),
		targetArtist: normalizeText(cleanArtist || rawArtist),
		targetAlbum: normalizeText(cleanAlbum || rawAlbum),
		targetIsrc: normalizeText(source.isrc ?? '')
	};
};

const getTrackArtistLabel = (track: Track): string => {
	if (track.artists?.length) {
		return track.artists.map((artist) => artist.name).filter(Boolean).join(', ');
	}
	return track.artist?.name ?? '';
};

const scoreTrackMatch = (
	candidate: Track,
	targetTitle: string,
	targetArtist: string,
	targetAlbum: string,
	targetIsrc?: string,
	targetDurationMs?: number
) => {
	const candidateTitle = normalizeText(candidate.title ?? '');
	const candidateArtist = normalizeText(getTrackArtistLabel(candidate));
	const candidateAlbum = normalizeText(candidate.album?.title ?? '');
	const candidateIsrc = normalizeText(candidate.isrc ?? '');
	let score = 0;

	if (targetIsrc && candidateIsrc && candidateIsrc === targetIsrc) {
		score += 80;
	}

	if (candidateTitle && targetTitle) {
		if (candidateTitle === targetTitle) {
			score += 60;
		} else if (candidateTitle.includes(targetTitle) || targetTitle.includes(candidateTitle)) {
			score += 35;
		}
	}

	if (candidateArtist && targetArtist) {
		if (candidateArtist === targetArtist) {
			score += 30;
		} else if (candidateArtist.includes(targetArtist) || targetArtist.includes(candidateArtist)) {
			score += 15;
		}
	}

	if (candidateAlbum && targetAlbum) {
		if (candidateAlbum === targetAlbum) {
			score += 20;
		} else if (candidateAlbum.includes(targetAlbum) || targetAlbum.includes(candidateAlbum)) {
			score += 10;
		}
	}

	if (typeof targetDurationMs === 'number' && Number.isFinite(targetDurationMs)) {
		const candidateDurationMs = (candidate.duration ?? 0) * 1000;
		if (candidateDurationMs > 0) {
			const diff = Math.abs(candidateDurationMs - targetDurationMs);
			if (diff <= 2000) {
				score += 15;
			} else if (diff <= 5000) {
				score += 8;
			} else if (diff > 15000) {
				score -= 10;
			}
		}
	}

	return score;
};

const findBestTrackMatch = (tracks: Track[], source: TrackSearchSource) => {
	const { targetTitle, targetArtist, targetAlbum, targetIsrc } = buildNormalizedSource(source);
	if (!targetTitle) {
		return { best: null as Track | null, bestScore: 0, targetTitle };
	}
	let best: Track | null = null;
	let bestScore = 0;

	for (const candidate of tracks) {
		const score = scoreTrackMatch(
			candidate,
			targetTitle,
			targetArtist,
			targetAlbum,
			targetIsrc,
			source.durationMs
		);
		if (score > bestScore) {
			bestScore = score;
			best = candidate;
		}
	}

	return { best, bestScore, targetTitle };
};

const collectQueries = (source: TrackSearchSource) => {
	const queries: string[] = [];
	const seen = new Set<string>();
	const pushQuery = (value?: string | null) => {
		if (!value) return;
		const trimmed = value.trim();
		if (!trimmed) return;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		queries.push(trimmed);
	};

	const title = source.title?.trim();
	const artist = source.artistName?.trim();
	const album = source.albumName?.trim();
	const isrc = source.isrc?.trim();
	const cleanTitle = title ? stripDecorations(title) : undefined;
	const cleanArtist = artist ? stripDecorations(artist) : undefined;
	const cleanAlbum = album ? stripDecorations(album) : undefined;

	if (isrc) {
		pushQuery(isrc);
		pushQuery(`isrc:${isrc}`);
	}
	if (title && artist && album) {
		pushQuery(`${title} ${artist} ${album}`);
	}
	if (title && artist) {
		pushQuery(`${title} ${artist}`);
	}
	if (title && album) {
		pushQuery(`${title} ${album}`);
	}
	if (cleanTitle && cleanArtist && cleanAlbum) {
		pushQuery(`${cleanTitle} ${cleanArtist} ${cleanAlbum}`);
	}
	if (cleanTitle && cleanArtist) {
		pushQuery(`${cleanTitle} ${cleanArtist}`);
	}
	if (cleanTitle && cleanAlbum) {
		pushQuery(`${cleanTitle} ${cleanAlbum}`);
	}
	if (cleanTitle) {
		pushQuery(cleanTitle);
	}
	if (title) {
		pushQuery(title);
	}

	return queries;
};

const getThumbnailFromSonglink = (response?: SonglinkResponse | null) => {
	if (!response) return null;
	const tidalEntity = extractTidalSongEntity(response);
	if (tidalEntity?.thumbnailUrl) {
		return tidalEntity.thumbnailUrl;
	}
	const spotifyEntity = Object.values(response.entitiesByUniqueId).find(
		(entity) => entity.apiProvider === 'spotify' && entity.thumbnailUrl
	);
	if (spotifyEntity?.thumbnailUrl) {
		return spotifyEntity.thumbnailUrl;
	}
	const anyEntity = Object.values(response.entitiesByUniqueId).find((entity) => entity.thumbnailUrl);
	return anyEntity?.thumbnailUrl ?? null;
};

const cacheTrack = (track: Track) => {
	trackCache.set(track.id, track);
	if (trackCache.size <= TRACK_CACHE_LIMIT) {
		return;
	}
	const oldestKey = trackCache.keys().next().value as number | undefined;
	if (typeof oldestKey === 'number') {
		trackCache.delete(oldestKey);
	}
};

export const getCachedTrack = (trackId: number): Track | null => {
	return trackCache.get(trackId) ?? null;
};

export const fetchTrackWithRetry = async (
	id: number,
	attempts = 3
): Promise<Track | null> => {
	const cached = getCachedTrack(id);
	if (cached) return cached;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			const lookup = await losslessAPI.getTrack(id);
			if (lookup?.track) {
				cacheTrack(lookup.track);
				return lookup.track;
			}
		} catch {
			// ignore and retry
		}
		if (attempt < attempts) {
			const delayMs =
				RESOLVE_RETRY_DELAYS_MS[Math.min(attempt - 1, RESOLVE_RETRY_DELAYS_MS.length - 1)];
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
	return null;
};

const resolveFromSonglink = async (
	sourceUrl: string,
	options: ResolveOptions
): Promise<{
	tidalId: number | null;
	linkUrl?: string;
	thumbnailUrl?: string | null;
	songlinkData?: SonglinkResponse;
}> => {
	const attempts = options.resolveAttempts ?? 4;
	const songIfSingle = options.songIfSingle ?? true;
	const userCountry = options.userCountry ?? resolveUserCountry();
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			const data = await fetchSonglinkData(sourceUrl, { userCountry, songIfSingle });
			const tidalInfo = extractTidalInfo(data);
			const thumbnailUrl = getThumbnailFromSonglink(data);
			if (tidalInfo?.id) {
				const tidalId = Number(tidalInfo.id);
				if (Number.isFinite(tidalId)) {
					return {
						tidalId,
						linkUrl: tidalInfo.url,
						thumbnailUrl,
						songlinkData: data
					};
				}
			}
			return { tidalId: null, thumbnailUrl, songlinkData: data };
		} catch {
			if (attempt === attempts) {
				break;
			}
			const delayMs =
				RESOLVE_RETRY_DELAYS_MS[Math.min(attempt - 1, RESOLVE_RETRY_DELAYS_MS.length - 1)];
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
	return { tidalId: null };
};

const searchTidalFallback = async (
	source: TrackSearchSource,
	options: ResolveOptions
): Promise<Track | null> => {
	const queries = collectQueries(source);
	if (queries.length === 0) return null;
	const minScore = options.minScore ?? 50;
	const forceScore = options.forceScore ?? 35;
	const allowLooseTitle = options.allowLooseTitle ?? true;
	const attempts = options.searchAttempts ?? 3;

	const runQueries = async (scoreThreshold: number, allowLoose: boolean) => {
		for (const query of queries) {
			for (let attempt = 1; attempt <= attempts; attempt += 1) {
				try {
					const response = await losslessAPI.searchTracks(query);
					const items = response?.items ?? [];
					const { best, bestScore, targetTitle } = findBestTrackMatch(items, source);
					if (best) {
						if (bestScore >= scoreThreshold) {
							cacheTrack(best);
							return best;
						}
						if (allowLoose && allowLooseTitle && isLikelyTitleMatch(best, targetTitle)) {
							cacheTrack(best);
							return best;
						}
					}
				} catch {
					// ignore and retry
				}
				if (attempt < attempts) {
					const delayMs =
						RESOLVE_RETRY_DELAYS_MS[Math.min(attempt - 1, RESOLVE_RETRY_DELAYS_MS.length - 1)];
					await new Promise((resolve) => setTimeout(resolve, delayMs));
				}
			}
		}
		return null;
	};

	const strict = await runQueries(minScore, false);
	if (strict) return strict;
	return runQueries(forceScore, true);
};

const resolveTidalFromSource = async (
	sourceUrl: string,
	source: TrackSearchSource,
	options: ResolveOptions = {}
): Promise<ResolveResult> => {
	const cacheKey = options.cacheKey ?? sourceUrl;
	if (cacheKey) {
		const existing = resolveInFlight.get(cacheKey);
		if (existing) {
			return existing;
		}
	}

	const run = (async () => {
		let tidalId = options.existingTidalId ?? null;
		let linkUrl = options.existingLinkUrl ?? undefined;
		let thumbnailUrl = options.existingThumbnailUrl ?? undefined;
		let songlinkData = options.existingSonglinkData;
		let resolvedTrack: Track | undefined;

		if (tidalId && options.fetchTrack) {
			const cached = getCachedTrack(tidalId);
			if (cached) {
				resolvedTrack = cached;
			} else {
				const fetched = await fetchTrackWithRetry(tidalId);
				if (fetched) {
					resolvedTrack = fetched;
					if (!thumbnailUrl && fetched.album?.cover) {
						thumbnailUrl = losslessAPI.getCoverUrl(fetched.album.cover, '320');
					}
				}
			}
		}

		if (!tidalId) {
			const songlinkResult = await resolveFromSonglink(sourceUrl, {
				...options,
				existingSonglinkData: songlinkData
			});
			if (songlinkResult.songlinkData) {
				songlinkData = songlinkResult.songlinkData;
			}
			if (!thumbnailUrl && songlinkResult.thumbnailUrl) {
				thumbnailUrl = songlinkResult.thumbnailUrl ?? undefined;
			}
			if (songlinkResult.tidalId) {
				tidalId = songlinkResult.tidalId;
				linkUrl = songlinkResult.linkUrl;
			}
		}

		if (!tidalId) {
			const fallbackTrack = await searchTidalFallback(source, options);
			if (fallbackTrack?.id) {
				tidalId = fallbackTrack.id;
				linkUrl = `https://tidal.com/browse/track/${fallbackTrack.id}`;
				resolvedTrack = resolvedTrack ?? fallbackTrack;
				if (!thumbnailUrl && fallbackTrack.album?.cover) {
					thumbnailUrl = losslessAPI.getCoverUrl(fallbackTrack.album.cover, '320');
				}
			}
		}

		if (tidalId && options.fetchTrack && !resolvedTrack) {
			const fetched = await fetchTrackWithRetry(tidalId);
			if (fetched) {
				resolvedTrack = fetched;
				if (!thumbnailUrl && fetched.album?.cover) {
					thumbnailUrl = losslessAPI.getCoverUrl(fetched.album.cover, '320');
				}
			}
		}

		return {
			tidalId,
			linkUrl,
			thumbnailUrl,
			songlinkData,
			track: resolvedTrack,
			status: tidalId ? 'ready' : 'missing'
		};
	})();

	if (cacheKey) {
		resolveInFlight.set(cacheKey, run);
	}

	try {
		return await run;
	} finally {
		if (cacheKey) {
			resolveInFlight.delete(cacheKey);
		}
	}
};

export const buildSpotifySonglinkTracks = (
	tracks: SpotifyTrackMetadata[]
): SonglinkTrack[] =>
	tracks.map((track) => {
		const durationMs = track.duration ?? 180000;
		const durationSeconds = Math.max(1, Math.round(durationMs / 1000));
		return {
			id: `spotify:track:${track.spotifyId}`,
			title: track.title || 'Unknown Track',
			artistName: track.artistName || 'Unknown Artist',
			albumName: track.albumName,
			isrc: track.isrc,
			duration: durationSeconds,
			thumbnailUrl: track.albumImageUrl ?? '',
			sourceUrl: `https://open.spotify.com/track/${track.spotifyId}`,
			songlinkData: undefined,
			isSonglinkTrack: true,
			tidalId: track.tidalId,
			audioQuality: 'LOSSLESS'
		};
	});

export const resolveSpotifyMetadataToTidal = async (
	track: SpotifyTrackMetadata,
	options: ResolveOptions = {}
): Promise<ResolveResult> => {
	const sourceUrl = `https://open.spotify.com/track/${track.spotifyId}`;
	const source: TrackSearchSource = {
		title: track.title,
		artistName: track.artistName,
		albumName: track.albumName,
		isrc: track.isrc,
		durationMs: track.duration
	};
	return resolveTidalFromSource(sourceUrl, source, {
		...options,
		cacheKey: options.cacheKey ?? `spotify:${track.spotifyId}`,
		existingTidalId: track.tidalId ?? options.existingTidalId,
		existingLinkUrl: track.linkUrl ?? options.existingLinkUrl,
		existingThumbnailUrl: track.albumImageUrl ?? options.existingThumbnailUrl
	});
};

export const resolveSonglinkTrackToTidal = async (
	track: SonglinkTrack,
	options: ResolveOptions = {}
): Promise<ResolveResult> => {
	const source: TrackSearchSource = {
		title: track.title,
		artistName: track.artistName,
		albumName: track.albumName,
		isrc: track.isrc,
		durationMs: track.duration ? track.duration * 1000 : undefined
	};
	const result = await resolveTidalFromSource(track.sourceUrl, source, {
		...options,
		cacheKey: options.cacheKey ?? track.id,
		existingSonglinkData: track.songlinkData ?? options.existingSonglinkData,
		existingTidalId: track.tidalId ?? options.existingTidalId,
		existingThumbnailUrl: track.thumbnailUrl ?? options.existingThumbnailUrl
	});
	if (result.songlinkData) {
		track.songlinkData = result.songlinkData;
	}
	if (result.tidalId && !track.tidalId) {
		track.tidalId = result.tidalId;
	}
	if (result.thumbnailUrl && !track.thumbnailUrl) {
		track.thumbnailUrl = result.thumbnailUrl;
	}
	return result;
};
