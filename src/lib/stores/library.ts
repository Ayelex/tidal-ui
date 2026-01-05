import { browser } from '$app/environment';
import { writable, get } from 'svelte/store';
import type { Album, Artist, Playlist, Track, PlayableTrack, SpotifyPlaylist, SpotifyTrackMetadata } from '$lib/types';
import { userPreferencesStore } from '$lib/stores/userPreferences';
import { prefetchStreamUrls } from '$lib/utils/streamPrefetch';

type LibraryState = {
	likedTracks: Track[];
	savedAlbums: Album[];
	savedPlaylists: Playlist[];
	likedArtists: Artist[];
	customPlaylists: CustomPlaylist[];
	spotifyPlaylists: SpotifyPlaylist[];
};

type CustomPlaylist = {
	id: string;
	title: string;
	tracks: PlayableTrack[];
	sourceUrl?: string | null;
	createdAt: string;
};

const STORAGE_KEY = 'tidal-ui.library';
const DEFAULT_STATE: LibraryState = {
	likedTracks: [],
	savedAlbums: [],
	savedPlaylists: [],
	likedArtists: [],
	customPlaylists: [],
	spotifyPlaylists: []
};

function parseStoredLibrary(raw: string | null): LibraryState {
	if (!raw) return DEFAULT_STATE;
	try {
		const parsed = JSON.parse(raw) as Partial<LibraryState>;
		const spotifyPlaylists = Array.isArray(parsed.spotifyPlaylists)
			? parsed.spotifyPlaylists
					.map((playlist) => {
						if (!playlist || typeof playlist !== 'object') {
							return null;
						}
						const candidate = playlist as Partial<SpotifyPlaylist> & { csvData?: string };
						if (Array.isArray(candidate.tracks)) {
							return candidate as SpotifyPlaylist;
						}
						if (typeof candidate.csvData === 'string') {
							const tracks = csvToTracks(candidate.csvData);
							return {
								...candidate,
								totalTracks: candidate.totalTracks ?? tracks.length,
								tracks
							} as SpotifyPlaylist;
						}
						return null;
					})
					.filter(Boolean) as SpotifyPlaylist[]
			: [];
		return {
			likedTracks: Array.isArray(parsed.likedTracks) ? parsed.likedTracks : [],
			savedAlbums: Array.isArray(parsed.savedAlbums) ? parsed.savedAlbums : [],
			savedPlaylists: Array.isArray(parsed.savedPlaylists) ? parsed.savedPlaylists : [],
			likedArtists: Array.isArray(parsed.likedArtists) ? parsed.likedArtists : [],
			customPlaylists: Array.isArray(parsed.customPlaylists) ? parsed.customPlaylists : [],
			spotifyPlaylists
		};
	} catch (error) {
		console.warn('Failed to parse stored library', error);
		return DEFAULT_STATE;
	}
}

function csvToTracks(csvData: string): SpotifyTrackMetadata[] {
	const lines = csvData.split('\n');
	if (lines.length < 2) return [];
	
	const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').replace(/""/g, '"'));
	const titleIndex = headers.indexOf('title');
	const artistIndex = headers.indexOf('artistName');
	const albumIndex = headers.indexOf('albumName');
	const spotifyIdIndex = headers.indexOf('spotifyId');
	const durationIndex = headers.indexOf('duration');
	const isrcIndex = headers.indexOf('isrc');
	const trackNumberIndex = headers.indexOf('trackNumber');
	
	return lines.slice(1).map(line => {
		const fields = line.split(',').map(f => f.replace(/^"|"$/g, '').replace(/""/g, '"'));
		return {
			title: fields[titleIndex] || '',
			artistName: fields[artistIndex] || '',
			albumName: fields[albumIndex] || undefined,
			spotifyId: fields[spotifyIdIndex] || '',
			duration: fields[durationIndex] ? parseInt(fields[durationIndex]) : undefined,
			isrc: fields[isrcIndex] || undefined,
			trackNumber: fields[trackNumberIndex] ? parseInt(fields[trackNumberIndex]) : undefined
		};
	}).filter(track => track.title && track.artistName && track.spotifyId);
}

function readInitialLibrary(): LibraryState {
	if (!browser) return DEFAULT_STATE;
	try {
		return parseStoredLibrary(localStorage.getItem(STORAGE_KEY));
	} catch (error) {
		console.warn('Unable to read library from storage', error);
		return DEFAULT_STATE;
	}
}

function createLibraryStore() {
	const { subscribe, set, update } = writable<LibraryState>(readInitialLibrary());

	if (browser) {
		subscribe((state) => {
			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
			} catch (error) {
				console.warn('Failed to persist library', error);
			}
		});

		window.addEventListener('storage', (event) => {
			if (event.key !== STORAGE_KEY) return;
			set(parseStoredLibrary(event.newValue));
		});
	}

	return {
		subscribe,
		syncFromStorage() {
			if (!browser) {
				return;
			}
			try {
				set(parseStoredLibrary(localStorage.getItem(STORAGE_KEY)));
			} catch (error) {
				console.warn('Unable to refresh library from storage', error);
			}
		},
		addLikedTracks(tracks: Track[]) {
			if (!tracks.length) {
				return;
			}
			update((state) => {
				const existing = new Set(state.likedTracks.map((item) => item.id));
				const additions = tracks.filter((track) => !existing.has(track.id));
				if (additions.length === 0) {
					return state;
				}
				const likedTracks = [...additions, ...state.likedTracks];
				return { ...state, likedTracks };
			});
			const quality = get(userPreferencesStore).playbackQuality;
			prefetchStreamUrls(tracks.slice(0, 8), quality, 4);
		},
		toggleLikedTrack(track: Track) {
			const isAdding = !get({ subscribe }).likedTracks.some((item) => item.id === track.id);
			update((state) => {
				const exists = state.likedTracks.some((item) => item.id === track.id);
				const likedTracks = exists
					? state.likedTracks.filter((item) => item.id !== track.id)
					: [track, ...state.likedTracks];
				return { ...state, likedTracks };
			});
			if (isAdding) {
				const quality = get(userPreferencesStore).playbackQuality;
				prefetchStreamUrls([track], quality, 1);
			}
		},
		toggleSavedAlbum(album: Album) {
			update((state) => {
				const exists = state.savedAlbums.some((item) => item.id === album.id);
				const savedAlbums = exists
					? state.savedAlbums.filter((item) => item.id !== album.id)
					: [album, ...state.savedAlbums];
				return { ...state, savedAlbums };
			});
		},
		toggleSavedPlaylist(playlist: Playlist) {
			update((state) => {
				const exists = state.savedPlaylists.some((item) => item.uuid === playlist.uuid);
				const savedPlaylists = exists
					? state.savedPlaylists.filter((item) => item.uuid !== playlist.uuid)
					: [playlist, ...state.savedPlaylists];
				return { ...state, savedPlaylists };
			});
		},
		toggleLikedArtist(artist: Artist) {
			update((state) => {
				const exists = state.likedArtists.some((item) => item.id === artist.id);
				const likedArtists = exists
					? state.likedArtists.filter((item) => item.id !== artist.id)
					: [artist, ...state.likedArtists];
				return { ...state, likedArtists };
			});
		},
		saveCustomPlaylist(
			title: string,
			tracks: PlayableTrack[],
			sourceUrl?: string | null
		) {
			update((state) => {
				if (tracks.length === 0) {
					return state;
				}
				const normalizedTitle = title.trim() || 'Imported Playlist';
				const existingIndex =
					sourceUrl && state.customPlaylists.findIndex((item) => item.sourceUrl === sourceUrl);
				if (typeof existingIndex === 'number' && existingIndex >= 0) {
					const next = state.customPlaylists.slice();
					next[existingIndex] = {
						...next[existingIndex]!,
						title: normalizedTitle,
						tracks
					};
					return { ...state, customPlaylists: next };
				}
				const id =
					typeof crypto !== 'undefined' && 'randomUUID' in crypto
						? crypto.randomUUID()
						: `${Date.now()}-${Math.random().toString(16).slice(2)}`;
				const customPlaylists = [
					{
						id,
						title: normalizedTitle,
						tracks,
						sourceUrl: sourceUrl ?? null,
						createdAt: new Date().toISOString()
					},
					...state.customPlaylists
				];
				return { ...state, customPlaylists };
			});
		},
		removeCustomPlaylist(id: string) {
			update((state) => ({
				...state,
				customPlaylists: state.customPlaylists.filter((item) => item.id !== id)
			}));
		},
		saveSpotifyPlaylist(
			title: string,
			sourceUrl: string,
			tracks: SpotifyTrackMetadata[],
			description?: string,
			allowEmpty = false
		) {
			update((state) => {
				if (tracks.length === 0 && !allowEmpty) {
					return state;
				}
				const normalizedTitle = title.trim() || 'Spotify Playlist';
				const existingIndex = state.spotifyPlaylists.findIndex((item) => item.sourceUrl === sourceUrl);
				if (existingIndex >= 0) {
					const next = state.spotifyPlaylists.slice();
					next[existingIndex] = {
						...next[existingIndex],
						title: normalizedTitle,
						totalTracks: tracks.length || next[existingIndex]!.totalTracks,
						description,
						tracks: tracks.length > 0 ? tracks : next[existingIndex]!.tracks
					};
					return { ...state, spotifyPlaylists: next };
				}
				const id =
					typeof crypto !== 'undefined' && 'randomUUID' in crypto
						? crypto.randomUUID()
						: `${Date.now()}-${Math.random().toString(16).slice(2)}`;
				const spotifyPlaylists = [
					{
						id,
						title: normalizedTitle,
						sourceUrl,
						description,
						totalTracks: tracks.length,
						createdAt: new Date().toISOString(),
						tracks
					},
					...state.spotifyPlaylists
				];
				return { ...state, spotifyPlaylists };
			});
		},
		updateSpotifyPlaylistBySourceUrl(
			sourceUrl: string,
			patch: Partial<Omit<SpotifyPlaylist, 'id' | 'createdAt' | 'sourceUrl'>>
		) {
			update((state) => ({
				...state,
				spotifyPlaylists: state.spotifyPlaylists.map((playlist) =>
					playlist.sourceUrl === sourceUrl ? { ...playlist, ...patch } : playlist
				)
			}));
		},
		renameSpotifyPlaylist(id: string, title: string) {
			const normalizedTitle = title.trim();
			if (!normalizedTitle) {
				return;
			}
			update((state) => ({
				...state,
				spotifyPlaylists: state.spotifyPlaylists.map((playlist) =>
					playlist.id === id ? { ...playlist, title: normalizedTitle } : playlist
				)
			}));
		},
		updateSpotifyTrackMetadata(
			playlistId: string,
			spotifyId: string,
			patch: Partial<SpotifyTrackMetadata>
		) {
			update((state) => ({
				...state,
				spotifyPlaylists: state.spotifyPlaylists.map((playlist) => {
					if (playlist.id !== playlistId) {
						return playlist;
					}
					const tracks = playlist.tracks.map((track) =>
						track.spotifyId === spotifyId ? { ...track, ...patch } : track
					);
					return { ...playlist, tracks };
				})
			}));
		},
		removeSpotifyPlaylist(id: string) {
			update((state) => ({
				...state,
				spotifyPlaylists: state.spotifyPlaylists.filter((item) => item.id !== id)
			}));
		},
		getSpotifyTracks(playlistId: string): SpotifyTrackMetadata[] {
			const state = get({ subscribe });
			const playlist = state.spotifyPlaylists.find(p => p.id === playlistId);
			if (!playlist) return [];
			return Array.isArray(playlist.tracks) ? playlist.tracks : [];
		},
		isTrackLiked(trackId: number) {
			return get({ subscribe }).likedTracks.some((item) => item.id === trackId);
		},
		isAlbumSaved(albumId: number) {
			return get({ subscribe }).savedAlbums.some((item) => item.id === albumId);
		},
		isPlaylistSaved(playlistId: string) {
			return get({ subscribe }).savedPlaylists.some((item) => item.uuid === playlistId);
		},
		isArtistLiked(artistId: number) {
			return get({ subscribe }).likedArtists.some((item) => item.id === artistId);
		},
		clearLikedTracks() {
			update((state) => ({ ...state, likedTracks: [] }));
		},
		clear() {
			set(DEFAULT_STATE);
		}
	};
}

export const libraryStore = createLibraryStore();
