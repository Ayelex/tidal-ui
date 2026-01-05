/**
 * Songlink API utilities for converting streaming links between platforms
 */

import { env } from '$env/dynamic/public';
import { dev } from '$app/environment';

const SONGLINK_API_BASE = 'https://api.song.link/v1-alpha.1/links';
const SONGLINK_BACKUP_API_BASE = 'https://tracks.monochrome.tf/api/links';
const spotifyPlaylistApi = (env.PUBLIC_SPOTIFY_PLAYLIST_API || '/api/spotify-playlist').trim();
export const spotifyPlaylistConversionEnabled = Boolean(spotifyPlaylistApi);

export interface SonglinkResponse {
	entityUniqueId: string;
	userCountry: string;
	pageUrl: string;
	entitiesByUniqueId: Record<string, SonglinkEntity>;
	linksByPlatform: Record<string, SonglinkPlatformLink>;
}

export interface SonglinkEntity {
	id: string;
	type: 'song' | 'album';
	title?: string;
	artistName?: string;
	thumbnailUrl?: string;
	thumbnailWidth?: number;
	thumbnailHeight?: number;
	apiProvider: string;
	platforms: string[];
}

export interface SonglinkPlatformLink {
	country: string;
	url: string;
	nativeAppUriMobile?: string;
	nativeAppUriDesktop?: string;
	entityUniqueId: string;
}

export interface TidalInfo {
	type: 'track' | 'album' | 'playlist';
	id: string;
	url: string;
}

/**
 * Supported streaming platforms
 */
export const SUPPORTED_PLATFORMS = [
	{ id: 'spotify', name: 'Spotify', pattern: /spotify\.com\/(track|album|playlist)/ },
	{ id: 'appleMusic', name: 'Apple Music', pattern: /music\.apple\.com/ },
	{ id: 'youtubeMusic', name: 'YouTube Music', pattern: /music\.youtube\.com/ },
	{ id: 'deezer', name: 'Deezer', pattern: /deezer\.com\/(track|album|playlist)/ },
	{ id: 'soundcloud', name: 'SoundCloud', pattern: /soundcloud\.com/ },
	{ id: 'tidal', name: 'TIDAL', pattern: /tidal\.com\/(browse\/)?(track|album|playlist)/ },
	{ id: 'amazon', name: 'Amazon Music', pattern: /music\.amazon\.com/ },
	{ id: 'pandora', name: 'Pandora', pattern: /pandora\.com/ }
] as const;

/**
 * Detect if URL is from a supported streaming platform
 */
export function isSupportedStreamingUrl(url: string): boolean {
	try {
		const parsedUrl = new URL(url);
		return SUPPORTED_PLATFORMS.some((platform) => platform.pattern.test(parsedUrl.href));
	} catch {
		return false;
	}
}

/**
 * Detect if URL is a Spotify playlist
 */
export function isSpotifyPlaylistUrl(url: string): boolean {
	try {
		const parsedUrl = new URL(url);
		return /spotify\.com\/playlist/.test(parsedUrl.href);
	} catch {
		return false;
	}
}

/**
 * Extract TIDAL information from Songlink response
 */
export function extractTidalInfo(response: SonglinkResponse): TidalInfo | null {
	// Find TIDAL link in linksByPlatform
	const tidalLink = response.linksByPlatform.tidal;
	if (!tidalLink?.url) {
		return null;
	}

	// Parse TIDAL URL to extract type and ID
	const url = tidalLink.url;
	const match = url.match(/tidal\.com\/(?:browse\/)?(\w+)\/(\d+)/);

	if (!match) {
		return null;
	}

	const [, type, id] = match;

	// Map Songlink types to our types
	let tidalType: 'track' | 'album' | 'playlist';
	if (type === 'track' || type === 'song') {
		tidalType = 'track';
	} else if (type === 'album') {
		tidalType = 'album';
	} else if (type === 'playlist') {
		tidalType = 'playlist';
	} else {
		return null;
	}

	// Validate that the ID is numeric
	const numericId = Number(id);
	if (!Number.isFinite(numericId) || numericId <= 0) {
		console.warn('TIDAL ID is not a valid number:', id);
		return null;
	}

	return {
		type: tidalType,
		id,
		url
	};
}

/**
 * Fetch Songlink data for a given URL
 */
export async function fetchSonglinkData(
	url: string,
	options?: {
		userCountry?: string;
		songIfSingle?: boolean;
	}
): Promise<SonglinkResponse> {
	const buildSonglinkUrl = (baseUrl: string): string => {
		const apiUrl = new URL(baseUrl);
		apiUrl.searchParams.set('url', url);
		if (options?.userCountry) {
			apiUrl.searchParams.set('userCountry', options.userCountry);
		}
		if (options?.songIfSingle !== undefined) {
			apiUrl.searchParams.set('songIfSingle', options.songIfSingle.toString());
		}
		return apiUrl.toString();
	};

	const fetchSonglink = async (apiUrl: string): Promise<SonglinkResponse> => {
		const response = await fetch(apiUrl);
		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'Unknown error' }));
			throw new Error(error.error || `Failed to fetch Songlink data: ${response.status}`);
		}
		return response.json();
	};

	const primaryUrl = buildSonglinkUrl(SONGLINK_API_BASE);
	const backupUrl = buildSonglinkUrl(SONGLINK_BACKUP_API_BASE);
	const preferBackup = Math.random() < 0.5;
	const firstUrl = preferBackup ? backupUrl : primaryUrl;
	const secondUrl = preferBackup ? primaryUrl : backupUrl;

	try {
		return await fetchSonglink(firstUrl);
	} catch {
		return fetchSonglink(secondUrl);
	}
}

/**
 * Convert a streaming platform URL to TIDAL information
 */
export async function convertToTidal(
	url: string,
	options?: {
		userCountry?: string;
		songIfSingle?: boolean;
	}
): Promise<TidalInfo | null> {
	try {
		const songlinkData = await fetchSonglinkData(url, options);
		return extractTidalInfo(songlinkData);
	} catch (error) {
		console.error('Failed to convert URL to TIDAL:', error);
		return null;
	}
}

/**
 * Get platform name from URL
 */
export function getPlatformName(url: string): string | null {
	try {
		const parsedUrl = new URL(url);
		const platform = SUPPORTED_PLATFORMS.find((p) => p.pattern.test(parsedUrl.href));
		return platform?.name || null;
	} catch {
		return null;
	}
}

/**
 * Extract TIDAL song entity from Songlink response for display
 * Prioritizes the entityUniqueId, then falls back to any TIDAL_SONG entity
 */
export function extractTidalSongEntity(response: SonglinkResponse): SonglinkEntity | null {
	// First try the primary entity if it's a TIDAL song
	const primaryEntity = response.entitiesByUniqueId[response.entityUniqueId];
	if (primaryEntity?.apiProvider === 'tidal') {
		return primaryEntity;
	}

	// Fallback: find any TIDAL_SONG entity
	const tidalKey = Object.keys(response.entitiesByUniqueId).find((key) =>
		key.startsWith('TIDAL_SONG::')
	);

	return tidalKey ? response.entitiesByUniqueId[tidalKey] || null : null;
}

/**
 * Convert a Spotify playlist URL to track metadata
 */
export async function convertSpotifyPlaylist(playlistUrl: string): Promise<{
	trackMetadata: SpotifyTrackMetadata[];
	playlistTitle: string;
	playlistDescription: string;
	totalTracks: number;
}> {
	if (!spotifyPlaylistApi) {
		throw new Error(
			'Spotify playlist conversion is disabled in static mode. Set PUBLIC_SPOTIFY_PLAYLIST_API to a worker endpoint to enable it.'
		);
	}
	try {
		const response = await fetch(spotifyPlaylistApi, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ playlistUrl })
		});

		if (!response.ok) {
			throw new Error(`API request failed: ${response.status}`);
		}

		const data = await response.json();
		
		if (data.error) {
			throw new Error(data.error);
		}

		return {
			trackMetadata: data.trackMetadata || [],
			playlistTitle: data.playlistTitle || 'Spotify Playlist',
			playlistDescription: data.playlistDescription || '',
			totalTracks: data.totalTracks || 0
		};
	} catch (error) {
		console.error('Failed to convert Spotify playlist:', error);
		throw error;
	}
}

/**
 * Spotify track metadata interface
 */
export interface SpotifyTrackMetadata {
	title: string;
	artistName: string;
	albumName?: string;
	albumImageUrl?: string;
	spotifyId: string;
	duration?: number;
	isrc?: string;
	trackNumber?: number;
}
