<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { losslessAPI, type TrackDownloadProgress } from '$lib/api';
	import { hasRegionTargets } from '$lib/config';
	import { downloadAlbum, getExtensionForQuality } from '$lib/downloads';
	import { formatArtists } from '$lib/utils';
	import { playerStore } from '$lib/stores/player';
	import { downloadUiStore } from '$lib/stores/downloadUi';
	import { downloadPreferencesStore } from '$lib/stores/downloadPreferences';
	import { userPreferencesStore } from '$lib/stores/userPreferences';
	import { regionStore, type RegionOption } from '$lib/stores/region';
	import { isTidalUrl } from '$lib/utils/urlParser';
	import {
		isSupportedStreamingUrl,
		convertToTidal,
		getPlatformName,
		isSpotifyPlaylistUrl,
		convertSpotifyPlaylist,
		spotifyPlaylistConversionEnabled
	} from '$lib/utils/songlink';
	import type {
		Track,
		Album,
		Artist,
		Playlist,
		AudioQuality,
		SonglinkTrack,
		PlayableTrack,
		SpotifyTrackMetadata
	} from '$lib/types';
	import { isSonglinkTrack } from '$lib/types';
	import { libraryStore } from '$lib/stores/library';
	import { prefetchStreamUrls } from '$lib/utils/streamPrefetch';
	import {
		Search,
		ChevronDown,
		Music,
		User,
		Disc,
		Download,
		ListPlus,
		ListVideo,
		LoaderCircle,
		Laptop,
		ListChecks,
		ClipboardPaste,
		Share2,
		Skull,
		Heart,
		X,
		Earth,
		Ban,
		Link2,
		MoreVertical,
		List,
		Play,
		Shuffle,
		Copy,
		Code
	} from 'lucide-svelte';

	import { searchStore } from '$lib/stores/searchStore.svelte';

	function getLongLink(type: 'track' | 'album' | 'artist' | 'playlist', id: string | number) {
		return `https://music.binimum.org/${type}/${id}`;
	}

	function getShortLink(type: 'track' | 'album' | 'artist' | 'playlist', id: string | number) {
		const prefixMap = {
			track: 't',
			album: 'al',
			artist: 'ar',
			playlist: 'p'
		};
		return `https://okiw.me/${prefixMap[type]}/${id}`;
	}

	function getEmbedCode(type: 'track' | 'album' | 'artist' | 'playlist', id: string | number) {
		if (type === "track") return `<iframe src="https://music.binimum.org/embed/${type}/${id}" width="100%" height="150" style="border:none; overflow:hidden; border-radius: 0.5em;" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"></iframe>`;
		return `<iframe src="https://music.binimum.org/embed/${type}/${id}" width="100%" height="450" style="border:none; overflow:hidden; border-radius: 0.5em;" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"></iframe>`;
	}

	async function copyToClipboard(text: string) {
		try {
			if (navigator.clipboard && navigator.clipboard.writeText) {
				await navigator.clipboard.writeText(text);
			} else {
				// Fallback for non-secure contexts
				const textArea = document.createElement('textarea');
				textArea.value = text;
				textArea.style.position = 'fixed';
				textArea.style.left = '-9999px';
				textArea.style.top = '0';
				document.body.appendChild(textArea);
				textArea.focus();
				textArea.select();
				try {
					document.execCommand('copy');
				} catch (err) {
					console.error('Fallback: Oops, unable to copy', err);
					throw err;
				}
				document.body.removeChild(textArea);
			}
		} catch (err) {
			console.error('Failed to copy:', err);
		}
	}

	let downloadingIds = $state(new Set<number | string>());
	let downloadTaskIds = $state(new Map<number | string, string>());
	let cancelledIds = $state(new Set<number | string>());
	let activeMenuId = $state<number | string | null>(null);

	const albumDownloadQuality = $derived($userPreferencesStore.playbackQuality as AudioQuality);
	const albumDownloadMode = $derived($downloadPreferencesStore.mode);
	const convertAacToMp3Preference = $derived($userPreferencesStore.convertAacToMp3);
	const downloadCoverSeperatelyPreference = $derived(
		$userPreferencesStore.downloadCoversSeperately
	);
	let selectedRegion = $state<RegionOption>('auto');
	let isRegionSelectorOpen = $state(false);
	// Playlist state moved to searchStore

	const regionAvailability: Record<RegionOption, boolean> = {
		auto: hasRegionTargets('auto'),
		us: hasRegionTargets('us'),
		eu: hasRegionTargets('eu')
	};

	const ensureSupportedRegion = (value: RegionOption): RegionOption => {
		if (value !== 'auto' && !regionAvailability[value]) {
			return 'auto';
		}
		return value;
	};

	$effect(() => {
		if (searchStore.tracks.length === 0) {
			return;
		}
		const eligible = searchStore.tracks.filter(
			(track): track is Track => !isSonglinkTrack(track)
		);
		if (eligible.length === 0) {
			return;
		}
		prefetchStreamUrls(eligible, $playerStore.quality, 6);
	});

	const unsubscribeRegion = regionStore.subscribe((value) => {
		const nextRegion = ensureSupportedRegion(value);
		if (nextRegion !== value) {
			regionStore.setRegion(nextRegion);
		}
		selectedRegion = nextRegion;
	});

	onDestroy(unsubscribeRegion);

	const MIN_QUERY_LENGTH = 2;
	const AUTO_SEARCH_DELAY_MS = 300;

	// Computed property to check if current query is a Tidal URL
	const isQueryATidalUrl = $derived(searchStore.query.trim().length > 0 && isTidalUrl(searchStore.query.trim()));

	// Computed property to check if current query is a supported streaming platform URL
	const isQueryAStreamingUrl = $derived(
		searchStore.query.trim().length > 0 && isSupportedStreamingUrl(searchStore.query.trim())
	);

	// Computed property to check if current query is a Spotify playlist URL
	const isQueryASpotifyPlaylist = $derived(
		searchStore.query.trim().length > 0 && isSpotifyPlaylistUrl(searchStore.query.trim())
	);
	const isSpotifyPlaylistConversionReady = $derived(
		spotifyPlaylistConversionEnabled && isQueryASpotifyPlaylist
	);

	// Combined URL check
	const isQueryAUrl = $derived(
		isQueryATidalUrl || isQueryAStreamingUrl || isQueryASpotifyPlaylist
	);

	const isSearchQueryReady = $derived(
		searchStore.query.trim().length >= MIN_QUERY_LENGTH && !isQueryAUrl
	);

	const hasSearchResults = $derived(
		searchStore.tracks.length > 0 ||
			searchStore.albums.length > 0 ||
			searchStore.artists.length > 0 ||
			searchStore.playlists.length > 0
	);

	type SearchSection = 'tracks' | 'albums' | 'artists' | 'playlists';

	const defaultSectionOrder: SearchSection[] = ['tracks', 'albums', 'artists', 'playlists'];
	let sectionOrder = $state<SearchSection[]>([...defaultSectionOrder]);

	type AlbumDownloadState = {
		downloading: boolean;
		completed: number;
		total: number;
		error: string | null;
	};

	let albumDownloadStates = $state<Record<number, AlbumDownloadState>>({});

	const trackSkeletons = Array.from({ length: 6 }, (_, index) => index);
	const gridSkeletons = Array.from({ length: 8 }, (_, index) => index);

	type SearchMode = 'auto' | 'manual';

	let autoSearchTimeout: ReturnType<typeof setTimeout> | null = null;
	let activeSearchToken = 0;
	let lastAutoQuery = '';

	interface Props {
		onTrackSelect?: (track: PlayableTrack) => void;
	}

	let { onTrackSelect }: Props = $props();

	// Close track menus when clicking outside
	onMount(() => {
		const handleClickOutside = (event: MouseEvent) => {
			const target = event.target as HTMLElement;
			// Check if click is outside any menu
			if (
				!target.closest('.track-menu-container') &&
				!target.closest('button[title="Queue actions"]')
			) {
				activeMenuId = null;
			}
		};

		document.addEventListener('click', handleClickOutside);

		return () => {
			document.removeEventListener('click', handleClickOutside);
		};
	});

	async function fetchWithRetry<T>(
		action: () => Promise<T>,
		attempts = 3,
		delayMs = 250
	): Promise<T> {
		let lastError: unknown = null;
		for (let attempt = 1; attempt <= attempts; attempt += 1) {
			try {
				return await action();
			} catch (err) {
				lastError = err;
				if (attempt < attempts) {
					await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
				}
			}
		}
		throw lastError instanceof Error ? lastError : new Error('Request failed');
	}

	function normalizeSearchText(value: string): string {
		return value.toLowerCase().trim();
	}

	function scoreTextMatch(query: string, target: string | undefined | null): number {
		if (!target) return 0;
		const normalizedTarget = normalizeSearchText(target);
		if (!normalizedTarget) return 0;
		if (normalizedTarget === query) return 100;
		if (normalizedTarget.startsWith(query)) return 80;
		if (normalizedTarget.includes(query)) return 60;

		const tokens = query.split(/\s+/).filter(Boolean);
		if (tokens.length === 0) return 0;

		let matches = 0;
		for (const token of tokens) {
			if (normalizedTarget.includes(token)) {
				matches += 1;
			}
		}

		if (matches === tokens.length && tokens.length > 1) {
			return 50;
		}

		return matches > 0 ? Math.round((30 * matches) / tokens.length) : 0;
	}

	function getArtistMatchScore(query: string, artists: Artist[] | undefined | null): number {
		if (!artists || artists.length === 0) return 0;
		let best = 0;
		for (const artist of artists) {
			best = Math.max(best, scoreTextMatch(query, artist.name));
		}
		return best;
	}

	function scoreTrackMatch(query: string, track: Track): number {
		const titleScore = scoreTextMatch(query, track.title);
		const artistScore = Math.max(
			scoreTextMatch(query, track.artist?.name),
			getArtistMatchScore(query, track.artists)
		);
		return Math.max(titleScore, artistScore * 0.6);
	}

	function scoreAlbumMatch(query: string, album: Album): number {
		const titleScore = scoreTextMatch(query, album.title);
		const artistScore = Math.max(
			scoreTextMatch(query, album.artist?.name),
			getArtistMatchScore(query, album.artists)
		);
		return Math.max(titleScore, artistScore * 0.5);
	}

	function scoreArtistMatch(query: string, artist: Artist): number {
		return scoreTextMatch(query, artist.name);
	}

	function scorePlaylistMatch(query: string, playlist: Playlist): number {
		const titleScore = scoreTextMatch(query, playlist.title);
		const creatorScore = scoreTextMatch(query, playlist.creator?.name);
		return Math.max(titleScore, creatorScore * 0.4);
	}

	function sortByRelevance<T>(
		items: T[],
		getScore: (item: T) => number,
		getPopularity: (item: T) => number
	): T[] {
		return items
			.map((item) => ({
				item,
				score: getScore(item),
				popularity: getPopularity(item)
			}))
			.sort((a, b) => {
				if (b.score !== a.score) return b.score - a.score;
				if (b.popularity !== a.popularity) return b.popularity - a.popularity;
				return 0;
			})
			.map(({ item }) => item);
	}

	function getCategoryStats<T>(
		items: T[],
		getScore: (item: T) => number,
		getPopularity: (item: T) => number
	): { maxScore: number; maxPopularity: number } {
		let maxScore = 0;
		let maxPopularity = 0;
		for (const item of items) {
			const score = getScore(item);
			const popularity = getPopularity(item);
			if (score > maxScore) {
				maxScore = score;
				maxPopularity = popularity;
			} else if (score === maxScore && popularity > maxPopularity) {
				maxPopularity = popularity;
			}
		}
		return { maxScore, maxPopularity };
	}

	function getCategoryIntent<T>(
		items: T[],
		getIntentScore: (item: T) => number
	): number {
		let maxIntent = 0;
		for (const item of items) {
			const score = getIntentScore(item);
			if (score > maxIntent) {
				maxIntent = score;
			}
		}
		return maxIntent;
	}

	function updateSectionOrder(
		query: string,
		tracks: Track[],
		albums: Album[],
		artists: Artist[],
		playlists: Playlist[]
	) {
		const categoryStats: Record<SearchSection, { maxScore: number; maxPopularity: number }> = {
			tracks: getCategoryStats(
				tracks,
				(track) => scoreTrackMatch(query, track),
				(track) => track.popularity ?? 0
			),
			albums: getCategoryStats(
				albums,
				(album) => scoreAlbumMatch(query, album),
				(album) => album.popularity ?? 0
			),
			artists: getCategoryStats(
				artists,
				(artist) => scoreArtistMatch(query, artist),
				(artist) => artist.popularity ?? 0
			),
			playlists: getCategoryStats(
				playlists,
				(playlist) => scorePlaylistMatch(query, playlist),
				(playlist) => playlist.popularity ?? 0
			)
		};

		const categoryIntent: Record<SearchSection, number> = {
			tracks: getCategoryIntent(tracks, (track) => scoreTextMatch(query, track.title)),
			albums: getCategoryIntent(albums, (album) => scoreTextMatch(query, album.title)),
			artists: getCategoryIntent(artists, (artist) => scoreTextMatch(query, artist.name)),
			playlists: getCategoryIntent(playlists, (playlist) => scoreTextMatch(query, playlist.title))
		};

		const maxIntent = Math.max(...Object.values(categoryIntent));
		let intentWinner: SearchSection | null = null;

		if (maxIntent > 0) {
			const contenders = (Object.keys(categoryIntent) as SearchSection[]).filter(
				(section) => categoryIntent[section] === maxIntent
			);
			if (contenders.includes('artists') && categoryIntent.artists >= 90) {
				intentWinner = 'artists';
			} else if (contenders.length === 1) {
				intentWinner = contenders[0] ?? null;
			} else if (contenders.length > 1) {
				intentWinner = contenders.sort((a, b) => {
					const aPopularity = categoryStats[a].maxPopularity;
					const bPopularity = categoryStats[b].maxPopularity;
					if (bPopularity !== aPopularity) return bPopularity - aPopularity;
					return defaultSectionOrder.indexOf(a) - defaultSectionOrder.indexOf(b);
				})[0] ?? null;
			}
		}

		sectionOrder = [...defaultSectionOrder].sort((a, b) => {
			if (intentWinner) {
				if (a === intentWinner && b !== intentWinner) return -1;
				if (b === intentWinner && a !== intentWinner) return 1;
			}
			const aIntent = categoryIntent[a];
			const bIntent = categoryIntent[b];
			if (bIntent !== aIntent) return bIntent - aIntent;
			const aScore = categoryStats[a].maxScore;
			const bScore = categoryStats[b].maxScore;
			if (bScore !== aScore) return bScore - aScore;
			const aPopularity = categoryStats[a].maxPopularity;
			const bPopularity = categoryStats[b].maxPopularity;
			if (bPopularity !== aPopularity) return bPopularity - aPopularity;
			return defaultSectionOrder.indexOf(a) - defaultSectionOrder.indexOf(b);
		});
	}

	function clearSearchResults() {
		searchStore.tracks = [];
		searchStore.albums = [];
		searchStore.artists = [];
		searchStore.playlists = [];
		searchStore.error = null;
		searchStore.isLoading = false;
		sectionOrder = [...defaultSectionOrder];
	}

	function handleQueryInput() {
		if (autoSearchTimeout) {
			clearTimeout(autoSearchTimeout);
			autoSearchTimeout = null;
		}

		const query = searchStore.query.trim();

		if (!query || isQueryAUrl || query.length < MIN_QUERY_LENGTH) {
			activeSearchToken += 1;
			lastAutoQuery = '';
			searchStore.isPlaylistConversionMode = false;
			searchStore.playlistLoadingMessage = null;
			clearSearchResults();
			return;
		}

		autoSearchTimeout = setTimeout(() => {
			void handleSearch('auto');
		}, AUTO_SEARCH_DELAY_MS);
	}

	function markCancelled(trackId: number | string) {
		const next = new Set(cancelledIds);
		next.add(trackId);
		cancelledIds = next;
		setTimeout(() => {
			const updated = new Set(cancelledIds);
			updated.delete(trackId);
			cancelledIds = updated;
		}, 1500);
	}

	function handleCancelDownload(trackId: number | string, event: MouseEvent) {
		event.stopPropagation();
		const taskId = downloadTaskIds.get(trackId);
		if (taskId) {
			downloadUiStore.cancelTrackDownload(taskId);
		}
		const next = new Set(downloadingIds);
		next.delete(trackId);
		downloadingIds = next;
		const taskMap = new Map(downloadTaskIds);
		taskMap.delete(trackId);
		downloadTaskIds = taskMap;
		markCancelled(trackId);
	}

	async function handleDownload(track: PlayableTrack, event?: MouseEvent) {
		if (event) {
			event.stopPropagation();
		}

		let trackId: number;
		let artistName: string;
		let albumTitle: string | undefined;

		// Handle SonglinkTracks
		if (isSonglinkTrack(track)) {
			if (track.tidalId) {
				trackId = track.tidalId;
				artistName = track.artistName;
				albumTitle = undefined;
			} else {
				console.warn('Cannot download SonglinkTrack directly - play it first to convert to TIDAL');
				alert('This track needs to be played first before it can be downloaded. Click to play it, then download.');
				return;
			}
		} else {
			trackId = track.id;
			artistName = formatArtists(track.artists);
			albumTitle = track.album?.title;
		}

		// Guard against non-numeric IDs
		if (!Number.isFinite(trackId) || trackId <= 0) {
			console.error('Cannot download track with invalid ID:', track.id);
			alert('Cannot download this track - invalid track ID');
			return;
		}

		// Use the original ID for tracking active downloads in the UI to avoid confusion
		// (since the UI list might still be using the string ID)
		const uiTrackId = track.id;

		if (downloadingIds.has(uiTrackId)) {
			return;
		}
		const next = new Set(downloadingIds);
		next.add(uiTrackId);
		downloadingIds = next;

		const quality = $userPreferencesStore.playbackQuality;
		const extension = getExtensionForQuality(quality, convertAacToMp3Preference);
		
		// Format title with version if present
		let title = track.title;
		if ('version' in track && track.version) {
			title = `${title} (${track.version})`;
		}
		
		const filename = `${artistName} - ${title}.${extension}`;
		const { taskId, controller } = downloadUiStore.beginTrackDownload(track, filename, {
			subtitle: albumTitle ?? artistName
		});
		const taskMap = new Map(downloadTaskIds);
		taskMap.set(uiTrackId, taskId);
		downloadTaskIds = taskMap;
		downloadUiStore.skipFfmpegCountdown();

		try {
			await losslessAPI.downloadTrack(trackId, quality, filename, {
				signal: controller.signal,
				onProgress: (progress: TrackDownloadProgress) => {
					if (progress.stage === 'downloading') {
						downloadUiStore.updateTrackProgress(
							taskId,
							progress.receivedBytes,
							progress.totalBytes
						);
					} else {
						downloadUiStore.updateTrackStage(taskId, progress.progress);
					}
				},
				onFfmpegCountdown: ({ totalBytes }) => {
					if (typeof totalBytes === 'number') {
						downloadUiStore.startFfmpegCountdown(totalBytes, { autoTriggered: false });
					} else {
						downloadUiStore.startFfmpegCountdown(0, { autoTriggered: false });
					}
				},
				onFfmpegStart: () => downloadUiStore.startFfmpegLoading(),
				onFfmpegProgress: (value) => downloadUiStore.updateFfmpegProgress(value),
				onFfmpegComplete: () => downloadUiStore.completeFfmpeg(),
				onFfmpegError: (error) => downloadUiStore.errorFfmpeg(error),
				ffmpegAutoTriggered: false,
				convertAacToMp3: convertAacToMp3Preference,
				downloadCoverSeperately: downloadCoverSeperatelyPreference
			});

			downloadUiStore.completeTrackDownload(taskId);
		} catch (error) {
			if (error instanceof DOMException && error.name === 'AbortError') {
				downloadUiStore.completeTrackDownload(taskId);
			} else {
				console.error('Failed to download track:', error);
				const fallbackMessage = 'Failed to download track. Please try again.';
				const message = error instanceof Error && error.message ? error.message : fallbackMessage;
				downloadUiStore.errorTrackDownload(taskId, message);
				alert(message);
			}
		} finally {
			const next = new Set(downloadingIds);
			next.delete(uiTrackId);
			downloadingIds = next;
			const taskMap = new Map(downloadTaskIds);
			taskMap.delete(uiTrackId);
			downloadTaskIds = taskMap;
		}
	}

	function patchAlbumDownloadState(albumId: number, patch: Partial<AlbumDownloadState>) {
		const previous = albumDownloadStates[albumId] ?? {
			downloading: false,
			completed: 0,
			total: 0,
			error: null
		};
		albumDownloadStates = {
			...albumDownloadStates,
			[albumId]: { ...previous, ...patch }
		};
	}

	async function handleAlbumDownloadClick(album: Album, event: MouseEvent) {
		event.preventDefault();
		event.stopPropagation();

		if (albumDownloadStates[album.id]?.downloading) {
			return;
		}

		patchAlbumDownloadState(album.id, {
			downloading: true,
			completed: 0,
			total: album.numberOfTracks ?? 0,
			error: null
		});

		const quality = albumDownloadQuality;

		try {
			await downloadAlbum(
				album,
				quality,
				{
					onTotalResolved: (total) => {
						patchAlbumDownloadState(album.id, { total });
					},
					onTrackDownloaded: (completed, total) => {
						patchAlbumDownloadState(album.id, { completed, total });
					}
				},
				album.artist?.name,
				{
					mode: albumDownloadMode,
					convertAacToMp3: convertAacToMp3Preference,
					downloadCoverSeperately: downloadCoverSeperatelyPreference
				}
			);
			const finalState = albumDownloadStates[album.id];
			patchAlbumDownloadState(album.id, {
				downloading: false,
				completed: finalState?.total ?? finalState?.completed ?? 0,
				error: null
			});
		} catch (err) {
			console.error('Failed to download album:', err);
			const message =
				err instanceof Error && err.message
					? err.message
					: 'Failed to download album. Please try again.';
			patchAlbumDownloadState(album.id, { downloading: false, error: message });
		}
	}

	function handleTrackActivation(track: PlayableTrack) {
		onTrackSelect?.(track);
	}

	function handleAddToQueue(track: PlayableTrack, event: MouseEvent) {
		event.stopPropagation();
		playerStore.enqueue(track);
	}

	function handlePlayNext(track: PlayableTrack, event: MouseEvent) {
		event.stopPropagation();
		playerStore.enqueueNext(track);
	}

	function handleTrackKeydown(event: KeyboardEvent, track: PlayableTrack) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			handleTrackActivation(track);
		}
	}

	$effect(() => {
		const activeIds = new Set(searchStore.albums.map((album) => album.id));
		let mutated = false;
		const nextState: Record<number, AlbumDownloadState> = {};
		for (const [albumId, state] of Object.entries(albumDownloadStates)) {
			const numericId = Number(albumId);
			if (activeIds.has(numericId)) {
				nextState[numericId] = state;
			} else {
				mutated = true;
			}
		}
		if (mutated) {
			albumDownloadStates = nextState;
		}
	});

	async function handleUrlImport() {
		if (!searchStore.query.trim()) return;

		searchStore.isLoading = true;
		searchStore.error = null;

		try {
			const result = await losslessAPI.importFromUrl(searchStore.query);

			// Clear previous results
			searchStore.tracks = [];
			searchStore.albums = [];
			searchStore.artists = [];
			searchStore.playlists = [];

			// Set results based on type
			switch (result.type) {
				case 'track':
					searchStore.tracks = [result.data as Track];
					searchStore.activeTab = 'tracks';
					break;
				case 'album':
					searchStore.albums = [result.data as Album];
					searchStore.activeTab = 'albums';
					break;
				case 'artist':
					searchStore.artists = [result.data as Artist];
					searchStore.activeTab = 'artists';
					break;
				case 'playlist': {
					const playlistData = result.data as { playlist: Playlist; tracks: Track[] };
					searchStore.playlists = [playlistData.playlist];
					searchStore.tracks = playlistData.tracks;
					searchStore.activeTab = 'playlists';
					break;
				}
			}
		} catch (err) {
			searchStore.error = err instanceof Error ? err.message : 'Failed to import from URL';
			console.error('URL import error:', err);
		} finally {
			searchStore.isLoading = false;
		}
	}

	async function handleSearch(mode: SearchMode = 'manual') {
		const query = searchStore.query.trim();
		const normalizedQuery = normalizeSearchText(query);
		if (!query) return;

		if (autoSearchTimeout) {
			clearTimeout(autoSearchTimeout);
			autoSearchTimeout = null;
		}

		if (mode === 'auto') {
			if (query.length < MIN_QUERY_LENGTH || isQueryAUrl) {
				return;
			}
			if (normalizedQuery === lastAutoQuery) {
				return;
			}
		}

		searchStore.isPlaylistConversionMode = false;
		searchStore.playlistLoadingMessage = null;

		if (mode === 'manual') {
			// Auto-detect: if query is a Tidal URL, import it directly
			if (isQueryATidalUrl) {
				await handleUrlImport();
				return;
			}

			// Auto-detect: if query is a Spotify playlist, convert it
			if (isSpotifyPlaylistConversionReady) {
				await handleSpotifyPlaylistConversion();
				return;
			}

			// Auto-detect: if query is a streaming platform URL, convert it first
			if (isQueryAStreamingUrl) {
				await handleStreamingUrlConversion();
				return;
			}
		}

		const token = ++activeSearchToken;
		lastAutoQuery = normalizedQuery;

		searchStore.isLoading = true;
		searchStore.error = null;

		try {
			const [tracksResult, albumsResult, artistsResult, playlistsResult] = await Promise.allSettled([
				fetchWithRetry(() => losslessAPI.searchTracks(query, selectedRegion)),
				fetchWithRetry(() => losslessAPI.searchAlbums(query, selectedRegion)),
				fetchWithRetry(() => losslessAPI.searchArtists(query, selectedRegion)),
				fetchWithRetry(() => losslessAPI.searchPlaylists(query, selectedRegion))
			]);

			if (token !== activeSearchToken) {
				return;
			}

			const fromResult = <T>(
				result: PromiseSettledResult<{ items?: T[] }>
			): T[] =>
				result.status === 'fulfilled' && Array.isArray(result.value?.items)
					? result.value.items
					: [];

			const rawTracks = fromResult<Track>(tracksResult);
			const rawAlbums = fromResult<Album>(albumsResult);
			const rawArtists = fromResult<Artist>(artistsResult);
			const rawPlaylists = fromResult<Playlist>(playlistsResult);

			const sortedTracks = sortByRelevance(
				rawTracks,
				(track) => scoreTrackMatch(normalizedQuery, track),
				(track) => track.popularity ?? 0
			);
			const sortedAlbums = sortByRelevance(
				rawAlbums,
				(album) => scoreAlbumMatch(normalizedQuery, album),
				(album) => album.popularity ?? 0
			);
			const sortedArtists = sortByRelevance(
				rawArtists,
				(artist) => scoreArtistMatch(normalizedQuery, artist),
				(artist) => artist.popularity ?? 0
			);
			const sortedPlaylists = sortByRelevance(
				rawPlaylists,
				(playlist) => scorePlaylistMatch(normalizedQuery, playlist),
				(playlist) => playlist.popularity ?? 0
			);

			searchStore.tracks = sortedTracks;
			searchStore.albums = sortedAlbums;
			searchStore.artists = sortedArtists;
			searchStore.playlists = sortedPlaylists;

			updateSectionOrder(
				normalizedQuery,
				sortedTracks,
				sortedAlbums,
				sortedArtists,
				sortedPlaylists
			);

			const failures = [tracksResult, albumsResult, artistsResult, playlistsResult].filter(
				(result) => result.status === 'rejected'
			);

			if (failures.length === 4) {
				searchStore.error = 'Search failed';
			}
		} catch (err) {
			if (token !== activeSearchToken) {
				return;
			}
			searchStore.error = err instanceof Error ? err.message : 'Search failed';
			console.error('Search error:', err);
		} finally {
			if (token === activeSearchToken) {
				searchStore.isLoading = false;
			}
		}
	}

	async function handleStreamingUrlConversion() {
		if (!searchStore.query.trim()) {
			return;
		}

		searchStore.isLoading = true;
		searchStore.error = null;

		try {
			const platformName = getPlatformName(searchStore.query.trim());
			console.log(`Converting ${platformName || 'streaming'} URL to TIDAL...`);

			const tidalInfo = await convertToTidal(searchStore.query.trim(), {
				userCountry: 'US',
				songIfSingle: true
			});

			if (!tidalInfo) {
				searchStore.error = `Could not find TIDAL equivalent for this ${platformName || 'streaming platform'} link. The content might not be available on TIDAL.`;
				searchStore.isLoading = false;
				return;
			}

			console.log('Converted to TIDAL:', tidalInfo);

			// Load the TIDAL content based on type
			switch (tidalInfo.type) {
				case 'track': {
					const trackLookup = await losslessAPI.getTrack(Number(tidalInfo.id));
					if (trackLookup?.track) {
						// Pre-cache the stream URL for this track
						try {
							const quality = $playerStore.quality;
							await losslessAPI.getStreamUrl(trackLookup.track.id, quality);
							console.log(`Cached stream for track ${trackLookup.track.id}`);
						} catch (cacheErr) {
							console.warn(`Failed to cache stream for track ${trackLookup.track.id}:`, cacheErr);
						}

						playerStore.playTrack(trackLookup.track);
						searchStore.query = '';
					}
					break;
				}
				case 'album': {
					const albumData = await losslessAPI.getAlbum(Number(tidalInfo.id));
					if (albumData?.album) {
						searchStore.activeTab = 'albums';
						searchStore.albums = [albumData.album];
						searchStore.query = '';
					}
					break;
				}
				case 'playlist': {
					const playlistData = await losslessAPI.getPlaylist(tidalInfo.id);
					if (playlistData?.playlist) {
						searchStore.activeTab = 'playlists';
						searchStore.playlists = [playlistData.playlist];
						searchStore.query = '';
					}
					break;
				}
			}
		} catch (err) {
			searchStore.error = err instanceof Error ? err.message : 'Failed to convert URL';
			console.error('Streaming URL conversion error:', err);
		} finally {
			searchStore.isLoading = false;
		}
	}

	function buildSpotifySonglinkTracks(tracks: SpotifyTrackMetadata[]): SonglinkTrack[] {
		return tracks.map((track) => {
			const durationMs = track.duration ?? 180000;
			const durationSeconds = Math.max(1, Math.round(durationMs / 1000));
			return {
				id: `spotify:track:${track.spotifyId}`,
				title: track.title || 'Unknown Track',
				artistName: track.artistName || 'Unknown Artist',
				duration: durationSeconds,
				thumbnailUrl: track.albumImageUrl ?? '',
				sourceUrl: `https://open.spotify.com/track/${track.spotifyId}`,
				songlinkData: undefined,
				isSonglinkTrack: true,
				tidalId: track.tidalId,
				audioQuality: 'LOSSLESS'
			};
		});
	}

	async function handleSpotifyPlaylistConversion() {
		if (!searchStore.query.trim()) {
			return;
		}

		const sourceUrl = searchStore.query.trim();
		searchStore.error = null;
		searchStore.playlistLoadingMessage = 'Saving playlist...';
		searchStore.isPlaylistConversionMode = true;
		searchStore.playlistSourceUrl = sourceUrl;
		searchStore.playlistTitle = 'Spotify Playlist';
		searchStore.isLoading = true;

		try {
			libraryStore.saveSpotifyPlaylist(
				searchStore.playlistTitle ?? 'Spotify Playlist',
				sourceUrl,
				[],
				undefined,
				true
			);

			searchStore.playlistLoadingMessage = 'Saved. Fetching tracks...';
			searchStore.query = '';

			const playlistData = await convertSpotifyPlaylist(sourceUrl);
			const trackMetadata = Array.isArray(playlistData.trackMetadata)
				? playlistData.trackMetadata
				: [];
			const playlistTitle = playlistData.playlistTitle || searchStore.playlistTitle || 'Spotify Playlist';
			const playlistDescription = playlistData.playlistDescription || undefined;
			const totalTracks = playlistData.totalTracks || trackMetadata.length;

			searchStore.playlistTitle = playlistTitle;
			searchStore.playlistConversionTotal = totalTracks;
			searchStore.activeTab = 'tracks';
			searchStore.tracks = buildSpotifySonglinkTracks(trackMetadata);

			libraryStore.saveSpotifyPlaylist(playlistTitle, sourceUrl, trackMetadata, playlistDescription);
			if (totalTracks && totalTracks !== trackMetadata.length) {
				libraryStore.updateSpotifyPlaylistBySourceUrl(sourceUrl, { totalTracks });
			}

			searchStore.isLoading = false;

			if (trackMetadata.length === 0) {
				searchStore.playlistLoadingMessage = 'Saved, but no tracks were found.';
				searchStore.isPlaylistConversionMode = false;
				return;
			}

			searchStore.playlistLoadingMessage = `Saved ${trackMetadata.length} tracks.`;
			setTimeout(() => {
				searchStore.playlistLoadingMessage = null;
			}, 2500);
		} catch (err) {
			searchStore.error = err instanceof Error ? err.message : 'Failed to save Spotify playlist';
			console.error('Spotify playlist loading error:', err);
			searchStore.playlistLoadingMessage = null;
			searchStore.isPlaylistConversionMode = false;
		} finally {
			searchStore.isLoading = false;
		}
	}

	function handlePlayAll() {
		if (searchStore.tracks.length > 0) {
			playerStore.playQueue(searchStore.tracks, 0);
		}
	}

	function handleShuffleAll() {
		if (searchStore.tracks.length > 0) {
			// Shuffle the tracks
			const shuffled = [...searchStore.tracks].sort(() => Math.random() - 0.5);
			playerStore.playQueue(shuffled, 0);
		}
	}

	async function handleDownloadAll() {
		if (searchStore.tracks.length === 0) return;

		const quality = $playerStore.quality;
		const convertAacToMp3Preference = $userPreferencesStore.convertAacToMp3;
		const downloadCoverSeperatelyPreference = $userPreferencesStore.downloadCoversSeperately;

		for (const track of searchStore.tracks) {
			try {
				// Use tidalId if available (for Songlink tracks), otherwise use id
				const trackId = 'tidalId' in track && track.tidalId ? track.tidalId : track.id;
				
				// Skip if we don't have a valid numeric ID (e.g. unconverted Songlink track)
				if (typeof trackId !== 'number') {
					console.warn(`Skipping download for track ${track.title}: No valid TIDAL ID`);
					continue;
				}

				const artistName = 'artistName' in track ? track.artistName : formatArtists(track.artists);
				const albumTitle = 'album' in track ? track.album?.title : undefined;
				
				let title = track.title;
				if ('version' in track && track.version) {
					title = `${title} (${track.version})`;
				}
				
				const filename = `${artistName} - ${title}.${getExtensionForQuality(quality)}`;
				
				const { taskId, controller } = downloadUiStore.beginTrackDownload(track, filename, {
					subtitle: albumTitle ?? artistName
				});

				await losslessAPI.downloadTrack(trackId, quality, filename, {
					signal: controller.signal,
					onProgress: (progress: TrackDownloadProgress) => {
						if (progress.stage === 'downloading') {
							downloadUiStore.updateTrackProgress(
								taskId,
								progress.receivedBytes,
								progress.totalBytes
							);
						} else {
							downloadUiStore.updateTrackStage(taskId, progress.progress);
						}
					},
					onFfmpegCountdown: ({ totalBytes }) => {
						if (typeof totalBytes === 'number') {
							downloadUiStore.startFfmpegCountdown(totalBytes, { autoTriggered: false });
						} else {
							downloadUiStore.startFfmpegCountdown(0, { autoTriggered: false });
						}
					},
					onFfmpegStart: () => downloadUiStore.startFfmpegLoading(),
					onFfmpegProgress: (value) => downloadUiStore.updateFfmpegProgress(value),
					onFfmpegComplete: () => downloadUiStore.completeFfmpeg(),
					onFfmpegError: (error) => downloadUiStore.errorFfmpeg(error),
					ffmpegAutoTriggered: false,
					convertAacToMp3: convertAacToMp3Preference,
					downloadCoverSeperately: downloadCoverSeperatelyPreference
				});

				downloadUiStore.completeTrackDownload(taskId);
			} catch (error) {
				console.error(`Failed to download track ${track.title}:`, error);
			}
		}
	}

	function handleKeyPress(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			handleSearch('manual');
		}
	}

	function handleRegionChange(event: Event) {
		const target = event.currentTarget as HTMLSelectElement | null;
		if (!target) return;
		const value = ensureSupportedRegion(target.value as RegionOption);
		if (value !== selectedRegion) {
			regionStore.setRegion(value);
			// Only trigger search if we have a query and it's not a URL
			if (searchStore.query.trim() && !isQueryAUrl) {
				handleSearch('manual');
			}
		}
		// Close the selector after selection
		isRegionSelectorOpen = false;
	}

	function handleRegionClick(event: MouseEvent) {
		const target = event.currentTarget as HTMLSelectElement | null;
		if (!target) return;
		// Toggle the open state when clicking
		isRegionSelectorOpen = !isRegionSelectorOpen;
	}

	function displayTrackTotal(total?: number | null): number {
		if (!Number.isFinite(total)) return 0;
		return total && total > 0 ? total : (total ?? 0);
	}

	function formatQualityLabel(quality?: string | null): string {
		if (!quality) return 'Unknown';
		const normalized = quality.toUpperCase();
		if (normalized === 'LOSSLESS') {
			return 'CD - 16-bit/44.1 kHz FLAC';
		}
		if (normalized === 'HI_RES_LOSSLESS') {
			return 'Hi-Res - up to 24-bit/192 kHz FLAC';
		}
		return quality;
	}

	function asTrack(track: PlayableTrack): Track {
		return track as Track;
	}
</script>

<div class="w-full">
	<!-- Search Input -->
	<div class="mb-6">
		<div
			class="search-glass rounded-lg border px-3 py-2 pr-2 shadow-sm transition-colors focus-within:border-rose-500"
		>
			<div class="flex flex-row gap-2 sm:items-center sm:justify-between">
				<div class="flex min-w-0 flex-1 items-center gap-2">
					<input
						type="text"
						bind:value={searchStore.query}
						oninput={handleQueryInput}
						onkeypress={handleKeyPress}
						placeholder={isQueryATidalUrl
							? 'Tidal URL detected - press Enter to import'
							: isSpotifyPlaylistConversionReady
							? 'Spotify playlist detected - press Enter to save'
								: isQueryAStreamingUrl
									? `${getPlatformName(searchStore.query)} URL detected - press Enter to convert`
									: 'Search for tracks, albums, artists... or paste a URL'}
						class="w-full min-w-0 flex-1 border-none bg-transparent p-0 pl-1 text-white ring-0 placeholder:text-gray-400 focus:outline-none"
					/>
				</div>
				<div class="flex w-auto flex-row items-center gap-2">
					{#if false} <!-- hide the region selector that doesn't even work lol -->
						<div class="relative w-auto">
							<label class="sr-only" for="region-select">Region</label>
							<Earth
								size={18}
								color="#ffffff"
								class="text0white pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
								style="color: #ffffff; z-index: 99;"
							/>
							<select
								id="region-select"
								class="region-selector w-[52px] cursor-pointer appearance-none rounded-md border py-2 pr-9 pl-9 text-sm font-medium text-white ring-0 transition-colors focus:outline-none sm:w-auto"
								value={selectedRegion}
								onchange={handleRegionChange}
								onmousedown={handleRegionClick}
								onblur={() => (isRegionSelectorOpen = false)}
								title="Change search region"
							>
								<option value="auto">Auto</option>
								<option
									value="us"
									disabled={!regionAvailability.us}
									class:opacity-50={!regionAvailability.us}
								>
									US
								</option>
								<option
									value="eu"
									disabled={!regionAvailability.eu}
									class:opacity-50={!regionAvailability.eu}
								>
									EU
								</option>
							</select>
							<span
								class={`region-chevron pointer-events-none absolute top-1/2 right-3 text-gray-400 ${isRegionSelectorOpen ? 'rotate-180' : ''}`}
							>
								<ChevronDown size={16} />
							</span>
						</div>
					{/if}
					<button
						onclick={() => handleSearch('manual')}
						disabled={searchStore.isLoading || !searchStore.query.trim()}
						class="search-button flex h-full items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-semibold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
					>
						{#if isSpotifyPlaylistConversionReady}
							<Link2 size={16} class="text-white" />
							<span class="hidden sm:inline">{searchStore.isLoading ? 'Saving...' : 'Save Playlist'}</span>
						{:else if isQueryAStreamingUrl}
							<Link2 size={16} class="text-white" />
							<span class="hidden sm:inline">{searchStore.isLoading ? 'Converting...' : 'Convert & Play'}</span>
						{:else if isQueryATidalUrl}
							<Link2 size={16} class="text-white" />
							<span class="hidden sm:inline">{searchStore.isLoading ? 'Importing...' : 'Import'}</span>
						{:else}
							<Search size={16} class="text-white" />
							<span class="hidden sm:inline">{searchStore.isLoading ? 'Searching...' : 'Search'}</span>
						{/if}
					</button>
				</div>
			</div>
		</div>
	</div>

	<!-- Loading State -->
	{#if searchStore.isLoading}
		<div class="space-y-8">
			<div>
				<div class="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-rose-300">
					<Music size={14} />
					<span>Tracks</span>
				</div>
				<div class="space-y-2">
					{#each trackSkeletons as _}
						<div class="flex w-full items-center gap-3 rounded-lg bg-gray-800/70 p-3">
							<div class="h-12 w-12 flex-shrink-0 animate-pulse rounded bg-gray-700/80"></div>
							<div class="flex-1 space-y-2">
								<div class="h-4 w-2/3 animate-pulse rounded bg-gray-700/80"></div>
								<div class="h-3 w-1/3 animate-pulse rounded bg-gray-700/60"></div>
								<div class="h-3 w-1/4 animate-pulse rounded bg-gray-700/40"></div>
							</div>
							<div class="h-6 w-12 animate-pulse rounded-full bg-gray-700/80"></div>
						</div>
					{/each}
				</div>
			</div>
			<div>
				<div class="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-rose-300">
					<Disc size={14} />
					<span>Albums</span>
				</div>
				<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
					{#each gridSkeletons as _}
						<div class="space-y-3">
							<div class="aspect-square w-full animate-pulse rounded-lg bg-gray-800/70"></div>
							<div class="h-4 w-3/4 animate-pulse rounded bg-gray-700/80"></div>
							<div class="h-3 w-1/2 animate-pulse rounded bg-gray-700/60"></div>
						</div>
					{/each}
				</div>
			</div>
			<div>
				<div class="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-rose-300">
					<User size={14} />
					<span>Artists</span>
				</div>
				<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
					{#each gridSkeletons as _}
						<div class="flex flex-col items-center gap-3">
							<div class="aspect-square w-full animate-pulse rounded-full bg-gray-800/70"></div>
							<div class="h-4 w-3/4 animate-pulse rounded bg-gray-700/80"></div>
							<div class="h-3 w-1/2 animate-pulse rounded bg-gray-700/60"></div>
						</div>
					{/each}
				</div>
			</div>
			<div>
				<div class="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-rose-300">
					<List size={14} />
					<span>Playlists</span>
				</div>
				<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
					{#each gridSkeletons as _}
						<div class="space-y-3">
							<div class="aspect-square w-full animate-pulse rounded-lg bg-gray-800/70"></div>
							<div class="h-4 w-3/4 animate-pulse rounded bg-gray-700/80"></div>
							<div class="h-3 w-1/2 animate-pulse rounded bg-gray-700/60"></div>
						</div>
					{/each}
				</div>
			</div>
		</div>
	{/if}

	<!-- Error State -->
	{#if searchStore.error}
		<div class="rounded-lg border border-red-900 bg-red-900/20 p-4 text-red-400">
			{searchStore.error}
		</div>
	{/if}

	<!-- Playlist Loading Progress -->
	{#if searchStore.playlistLoadingMessage}
		<div
			class="mb-4 flex items-center gap-3 rounded-lg border border-rose-900/60 bg-rose-900/30 p-4 text-rose-200"
		>
			<LoaderCircle class="animate-spin" size={20} />
			<span>{searchStore.playlistLoadingMessage}</span>
		</div>
	{/if}

	<!-- Results -->
	{#if !searchStore.isLoading && !searchStore.error}
		{#if hasSearchResults}
			<div class="space-y-10">
				{#each sectionOrder as section}
					{#if section === 'tracks'}
						{#if searchStore.tracks.length > 0}
							<section class="space-y-4">
						<div class="flex items-center gap-2 text-sm font-semibold text-white">
							<Music size={18} class="text-rose-300" />
							<span>Tracks</span>
						</div>
						<!-- Playlist Controls (shown when in playlist conversion mode) -->
						{#if searchStore.isPlaylistConversionMode}
							<div class="mb-6 flex flex-wrap items-center gap-3">
								<button
									onclick={handlePlayAll}
									class="flex items-center gap-2 rounded-full bg-rose-600 px-6 py-3 font-semibold transition-colors hover:bg-rose-700"
								>
									<Play size={20} fill="currentColor" />
									Play All
								</button>
								<button
									onclick={handleShuffleAll}
									class="flex items-center gap-2 rounded-full bg-orange-600 px-6 py-3 font-semibold transition-colors hover:bg-orange-700"
								>
									<Shuffle size={20} />
									Shuffle All
								</button>
								<button
									onclick={handleDownloadAll}
									class="flex items-center gap-2 rounded-full bg-red-700 px-6 py-3 font-semibold transition-colors hover:bg-red-800"
								>
									<Download size={20} />
									Download All
								</button>
								<div class="ml-auto text-sm text-gray-400">
									{searchStore.tracks.length} of {searchStore.playlistConversionTotal} tracks
								</div>
							</div>
						{/if}

						<div class="space-y-2">
							{#each searchStore.tracks as track}
								<div
									role="button"
									tabindex="0"
									onclick={(e) => {
										if (e.target instanceof Element && (e.target.closest('a') || e.target.closest('button'))) return;
										handleTrackActivation(track);
									}}
									onkeydown={(event) => handleTrackKeydown(event, track)}
									class="track-glass group flex w-full cursor-pointer items-center gap-3 rounded-lg p-3 transition-colors hover:brightness-110 focus:ring-2 focus:ring-rose-500 focus:outline-none {activeMenuId === track.id ? 'z-20 relative' : ''}"
								>
									{#if isSonglinkTrack(track)}
										<!-- Display for SonglinkTrack -->
										<img
											src={track.thumbnailUrl || '/placeholder-album.jpg'}
											alt={`${track.title} by ${track.artistName}`}
											loading="lazy"
											decoding="async"
											class="h-12 w-12 flex-shrink-0 rounded object-cover"
										/>
										<div class="min-w-0 flex-1">
											<h3 class="truncate font-semibold text-white group-hover:text-rose-300">
												{track.title}
											</h3>
											<p class="truncate text-sm text-gray-400">
												{track.artistName}
											</p>
											<p class="text-xs text-gray-500">
												{formatQualityLabel(track.audioQuality)}
											</p>
										</div>
										<!-- Queue actions for Songlink tracks -->
										<div class="flex items-center gap-2 text-sm text-gray-400">
											<div class="relative">
												<button
													onclick={(event) => {
														event.stopPropagation();
														activeMenuId = activeMenuId === track.id ? null : track.id;
													}}
													class="rounded-full p-2 text-gray-400 transition-colors hover:text-white"
													title="Queue actions"
													aria-label="Queue actions for {track.title}"
												>
													<MoreVertical size={18} />
												</button>
												<!-- Dropdown menu for queue actions -->
												{#if activeMenuId === track.id}
													<div
														class="track-menu-container absolute right-0 top-full z-10 mt-1 w-48 rounded-lg border border-gray-700 bg-gray-800 shadow-lg"
													>
														<button
															onclick={(event) => {
																handlePlayNext(track, event);
																activeMenuId = null;
															}}
															class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700"
														>
															<ListVideo size={16} />
															Play Next
														</button>
														<button
															onclick={(event) => {
																handleAddToQueue(track, event);
																activeMenuId = null;
															}}
															class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700"
														>
															<ListPlus size={16} />
															Add to Queue
														</button>
														<div class="my-1 border-t border-gray-700"></div>
														<button
															onclick={(event) => {
																event.stopPropagation();
																copyToClipboard(getLongLink('track', track.id));
																activeMenuId = null;
															}}
															class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700"
														>
															<Link2 size={16} />
															Share Link
														</button>
														<button
															onclick={(event) => {
																event.stopPropagation();
																copyToClipboard(getShortLink('track', track.id));
																activeMenuId = null;
															}}
															class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700"
														>
															<Copy size={16} />
															Share Short Link
														</button>
														<button
															onclick={(event) => {
																event.stopPropagation();
																copyToClipboard(getEmbedCode('track', track.id));
																activeMenuId = null;
															}}
															class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700"
														>
															<Code size={16} />
															Copy Embed Code
														</button>
													</div>
												{/if}
											</div>
										</div>
								{:else}
									<!-- Display for regular Track -->
									{#if asTrack(track).album.cover}
										<img
											src={losslessAPI.getCoverUrl(asTrack(track).album.cover, '160')}
											alt={track.title}
											loading="lazy"
											decoding="async"
											class="h-12 w-12 rounded object-cover"
										/>
									{/if}
									<div class="min-w-0 flex-1">
										<h3 class="truncate font-semibold text-white group-hover:text-rose-300">
											{track.title}{asTrack(track).version ? ` (${asTrack(track).version})` : ''}
											{#if asTrack(track).explicit}
												<svg
													class="inline h-4 w-4 flex-shrink-0 align-middle"
													xmlns="http://www.w3.org/2000/svg"
													fill="currentColor"
													height="24"
													viewBox="0 0 24 24"
													width="24"
													focusable="false"
													aria-hidden="true"
													><path
														d="M20 2H4a2 2 0 00-2 2v16a2 2 0 002 2h16a2 2 0 002-2V4a2 2 0 00-2-2ZM8 6h8a1 1 0 110 2H9v3h5a1 1 0 010 2H9v3h7a1 1 0 010 2H8a1 1 0 01-1-1V7a1 1 0 011-1Z"
													></path></svg>
											{/if}
										</h3>
										<a
											href={`/artist/${asTrack(track).artist.id}`}
											class="inline-block truncate text-sm text-gray-400 hover:text-rose-300 hover:underline"
											data-sveltekit-preload-data
										>
											{formatArtists(asTrack(track).artists)}
										</a>
										<p class="text-xs text-gray-500">
											<a
												href={`/album/${asTrack(track).album.id}`}
												class="hover:text-rose-300 hover:underline"
												data-sveltekit-preload-data
											>
												{asTrack(track).album.title}
											</a>
											- {formatQualityLabel(track.audioQuality)}
										</p>
									</div>
									<div class="flex items-center gap-2 text-sm text-gray-400">
										<button
											onclick={(event) =>
												downloadingIds.has(track.id)
													? handleCancelDownload(track.id, event)
													: handleDownload(track, event)}
											class="rounded-full p-2 text-gray-400 transition-colors hover:text-white"
											title={downloadingIds.has(track.id) ? 'Cancel download' : 'Download track'}
											aria-label={downloadingIds.has(track.id)
												? `Cancel download for ${track.title}`
												: `Download ${track.title}`}
											aria-busy={downloadingIds.has(track.id)}
											aria-pressed={downloadingIds.has(track.id)}
										>
											{#if downloadingIds.has(track.id)}
												<span class="flex h-4 w-4 items-center justify-center">
													{#if cancelledIds.has(track.id)}
														<X size={14} />
													{:else}
														<span
															class="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
														></span>
													{/if}
												</span>
											{:else if cancelledIds.has(track.id)}
												<X size={18} />
											{:else}
												<Download size={18} />
											{/if}
										</button>
										<div class="relative">
											<button
												onclick={(event) => {
													event.stopPropagation();
													activeMenuId = activeMenuId === track.id ? null : track.id;
												}}
												class="rounded-full p-2 text-gray-400 transition-colors hover:text-white"
												title="Queue actions"
												aria-label="Queue actions for {track.title}"
											>
												<MoreVertical size={18} />
											</button>
											{#if activeMenuId === track.id}
												<div
													class="track-menu-container absolute right-0 top-full z-10 mt-1 w-48 rounded-lg border border-gray-700 bg-gray-800 shadow-lg"
												>
													<button
														onclick={(event) => {
															handlePlayNext(track, event);
															activeMenuId = null;
														}}
														class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700"
													>
														<ListVideo size={16} />
														Play Next
													</button>
													<button
														onclick={(event) => {
															handleAddToQueue(track, event);
															activeMenuId = null;
														}}
														class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700"
													>
														<ListPlus size={16} />
														Add to Queue
													</button>
													<div class="my-1 border-t border-gray-700"></div>
													<button
														onclick={(event) => {
															event.stopPropagation();
															copyToClipboard(getLongLink('track', track.id));
															activeMenuId = null;
														}}
														class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700"
													>
														<Link2 size={16} />
														Share Link
													</button>
													<button
														onclick={(event) => {
															event.stopPropagation();
															copyToClipboard(getShortLink('track', track.id));
															activeMenuId = null;
														}}
														class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700"
													>
														<Copy size={16} />
														Share Short Link
													</button>
													<button
														onclick={(event) => {
															event.stopPropagation();
															copyToClipboard(getEmbedCode('track', track.id));
															activeMenuId = null;
														}}
														class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-gray-300 hover:bg-gray-700"
													>
														<Code size={16} />
														Copy Embed Code
													</button>
												</div>
											{/if}
										</div>
									</div>
								{/if}
								{#if !('isSonglinkTrack' in track && track.isSonglinkTrack)}
									<span>{losslessAPI.formatDuration(track.duration)}</span>
								{/if}
							</div>
						{/each}
					</div>
							</section>
						{/if}
					{:else if section === 'albums'}
						{#if searchStore.albums.length > 0}
							<section class="space-y-4">
								<div class="flex items-center gap-2 text-sm font-semibold text-white">
									<Disc size={18} class="text-rose-300" />
									<span>Albums</span>
								</div>
								<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
						{#each searchStore.albums as album}
							<div class="group relative text-left">
								<button
									onclick={(event) => handleAlbumDownloadClick(album, event)}
									type="button"
									class="absolute top-3 right-3 z-40 flex items-center justify-center rounded-full bg-black/50 p-2 text-gray-200 backdrop-blur-md transition-colors hover:bg-rose-600/80 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
									disabled={albumDownloadStates[album.id]?.downloading}
									aria-label={`Download ${album.title}`}
								>
									{#if albumDownloadStates[album.id]?.downloading}
										<LoaderCircle size={16} class="animate-spin" />
									{:else}
										<Download size={16} />
									{/if}
								</button>
								<a
									href={`/album/${album.id}`}
									class="flex w-full flex-col text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-900"
									data-sveltekit-preload-data
								>
									<div class="relative mb-2 aspect-square overflow-hidden rounded-lg">
										{#if album.videoCover}
											<video
												src={losslessAPI.getVideoCoverUrl(album.videoCover, '640')}
												poster={album.cover ? losslessAPI.getCoverUrl(album.cover, '640') : undefined}
												aria-label={album.title}
												class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
												autoplay
												loop
												muted
												playsinline
												preload="metadata"
											></video>
										{:else if album.cover}
											<img
												src={losslessAPI.getCoverUrl(album.cover, '640')}
												alt={album.title}
												loading="lazy"
												decoding="async"
												class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
											/>
										{:else}
											<div
												class="flex h-full w-full items-center justify-center bg-gray-800 text-sm text-gray-500"
											>
												No artwork
											</div>
										{/if}
									</div>
									<h3 class="truncate font-semibold text-white group-hover:text-rose-300">
										{album.title}
										{#if album.explicit}
											<svg
												class="inline h-4 w-4 flex-shrink-0 align-middle"
												xmlns="http://www.w3.org/2000/svg"
												fill="currentColor"
												height="24"
												viewBox="0 0 24 24"
												width="24"
												focusable="false"
												aria-hidden="true"
												><path
													d="M20 2H4a2 2 0 00-2 2v16a2 2 0 002 2h16a2 2 0 002-2V4a2 2 0 00-2-2ZM8 6h8a1 1 0 110 2H9v3h5a1 1 0 010 2H9v3h7a1 1 0 010 2H8a1 1 0 01-1-1V7a1 1 0 011-1Z"
												></path></svg>
										{/if}
									</h3>
									{#if album.artist}
										<p class="truncate text-sm text-gray-400">{album.artist.name}</p>
									{/if}
									{#if album.releaseDate}
										<p class="text-xs text-gray-500">{album.releaseDate.split('-')[0]}</p>
									{/if}
								</a>
								{#if albumDownloadStates[album.id]?.downloading}
									<p class="mt-2 text-xs text-rose-200">
										Downloading
										{#if albumDownloadStates[album.id]?.total}
											{albumDownloadStates[album.id]?.completed ?? 0}/{displayTrackTotal(
												albumDownloadStates[album.id]?.total ?? 0
											)}
										{:else}
											{albumDownloadStates[album.id]?.completed ?? 0}
										{/if}
										tracks...
									</p>
								{:else if albumDownloadStates[album.id]?.error}
									<p class="mt-2 text-xs text-red-400" role="alert">
										{albumDownloadStates[album.id]?.error}
									</p>
								{/if}
							</div>
						{/each}
					</div>
							</section>
						{/if}
					{:else if section === 'artists'}
						{#if searchStore.artists.length > 0}
							<section class="space-y-4">
								<div class="flex items-center gap-2 text-sm font-semibold text-white">
									<User size={18} class="text-rose-300" />
									<span>Artists</span>
								</div>
								<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
						{#each searchStore.artists as artist}
							<a href={`/artist/${artist.id}`} class="group text-center" data-sveltekit-preload-data>
								<div class="relative mb-2 aspect-square overflow-hidden rounded-full">
									{#if artist.picture}
										<img
											src={losslessAPI.getArtistPictureUrl(artist.picture)}
											alt={artist.name}
											loading="lazy"
											decoding="async"
											class="h-full w-full object-cover transition-transform group-hover:scale-105"
										/>
									{:else}
										<div class="flex h-full w-full items-center justify-center bg-gray-800">
											<User size={48} class="text-gray-600" />
										</div>
									{/if}
								</div>
								<h3 class="truncate font-semibold text-white group-hover:text-rose-300">
									{artist.name}
								</h3>
								<p class="text-xs text-gray-500">Artist</p>
							</a>
						{/each}
					</div>
							</section>
						{/if}
					{:else if section === 'playlists'}
						{#if searchStore.playlists.length > 0}
							<section class="space-y-4">
								<div class="flex items-center gap-2 text-sm font-semibold text-white">
									<List size={18} class="text-rose-300" />
									<span>Playlists</span>
								</div>
								<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
						{#each searchStore.playlists as playlist}
							<a
								href={`/playlist/${playlist.uuid}`}
								class="group text-left"
								data-sveltekit-preload-data
							>
								<div class="relative mb-2 aspect-square overflow-hidden rounded-lg">
									{#if playlist.squareImage || playlist.image}
										<img
											src={losslessAPI.getCoverUrl(playlist.squareImage || playlist.image, '640')}
											alt={playlist.title}
											loading="lazy"
											decoding="async"
											class="h-full w-full object-cover transition-transform group-hover:scale-105"
										/>
									{/if}
								</div>
								<h3 class="truncate font-semibold text-white group-hover:text-rose-300">
									{playlist.title}
								</h3>
								<p class="truncate text-sm text-gray-400">{playlist.creator.name}</p>
								<p class="text-xs text-gray-500">{playlist.numberOfTracks} tracks</p>
							</a>
						{/each}
					</div>
							</section>
						{/if}
					{/if}
				{/each}
			</div>
		{:else if !searchStore.query.trim()}
			<!-- News Section -->
			<div class="py-12 text-gray-200">
				<div class="mx-auto max-w-2xl rounded-2xl border border-white/10 bg-gray-900/40 p-6 shadow-xl backdrop-blur">
					<p class="text-sm uppercase tracking-[0.2em] text-rose-300">News</p>
					<h3 class="mt-2 text-xl font-semibold text-white">
						Import your Spotify Liked Songs
					</h3>
					<p class="mt-2 text-sm text-gray-300">
						This keeps the original order. Large libraries can take a while to process, so be
						patient if you have thousands of tracks.
					</p>
					<div class="mt-5 grid gap-3 text-sm text-gray-200 sm:grid-cols-2">
						<div class="flex items-start gap-3 rounded-lg border border-white/10 bg-black/20 p-3">
							<Laptop size={18} class="mt-0.5 text-rose-300" />
							<div class="flex flex-1 items-start gap-3">
								<span class="mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-rose-500/20 text-xs font-semibold text-rose-200">
									1
								</span>
								<p class="text-sm font-medium leading-5 text-gray-100">
									On desktop Spotify, create a new empty playlist.
								</p>
							</div>
						</div>
						<div class="flex items-start gap-3 rounded-lg border border-white/10 bg-black/20 p-3">
							<ListChecks size={18} class="mt-0.5 text-rose-300" />
							<div class="flex flex-1 items-start gap-3">
								<span class="mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-rose-500/20 text-xs font-semibold text-rose-200">
									2
								</span>
								<p class="text-sm font-medium leading-5 text-gray-100">
									Open Liked Songs, press Ctrl + A, then copy.
								</p>
							</div>
						</div>
						<div class="flex items-start gap-3 rounded-lg border border-white/10 bg-black/20 p-3">
							<ClipboardPaste size={18} class="mt-0.5 text-rose-300" />
							<div class="flex flex-1 items-start gap-3">
								<span class="mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-rose-500/20 text-xs font-semibold text-rose-200">
									3
								</span>
								<p class="text-sm font-medium leading-5 text-gray-100">
									Paste into the empty playlist to make a full copy.
								</p>
							</div>
						</div>
						<div class="flex items-start gap-3 rounded-lg border border-white/10 bg-black/20 p-3">
							<Share2 size={18} class="mt-0.5 text-rose-300" />
							<div class="flex flex-1 items-start gap-3">
								<span class="mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-rose-500/20 text-xs font-semibold text-rose-200">
									4
								</span>
								<p class="text-sm font-medium leading-5 text-gray-100">
									Share the playlist and copy the share link.
								</p>
							</div>
						</div>
						<div class="flex items-start gap-3 rounded-lg border border-white/10 bg-black/20 p-3">
							<Link2 size={18} class="mt-0.5 text-rose-300" />
							<div class="flex flex-1 items-start gap-3">
								<span class="mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-rose-500/20 text-xs font-semibold text-rose-200">
									5
								</span>
								<p class="text-sm font-medium leading-5 text-gray-100">
									Paste the link into the search bar here and press Enter.
								</p>
							</div>
						</div>
						<div class="flex items-start gap-3 rounded-lg border border-white/10 bg-black/20 p-3">
							<Skull size={18} class="mt-0.5 text-rose-300" />
							<div class="flex flex-1 items-start gap-3">
								<span class="mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-rose-500/20 text-xs font-semibold text-rose-200">
									6
								</span>
								<p class="text-sm font-medium leading-5 text-gray-100">
									Open the pirate logo to go to your Library, then Saved Playlists.
								</p>
							</div>
						</div>
						<div class="flex items-start gap-3 rounded-lg border border-white/10 bg-black/20 p-3">
							<Heart size={18} class="mt-0.5 text-rose-300" />
							<div class="flex flex-1 items-start gap-3">
								<span class="mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-rose-500/20 text-xs font-semibold text-rose-200">
									7
								</span>
								<p class="text-sm font-medium leading-5 text-gray-100">
									Hit the heart to like all tracks. Let it run.
								</p>
							</div>
						</div>
						<div class="flex items-start gap-3 rounded-lg border border-white/10 bg-black/20 p-3">
							<ListPlus size={18} class="mt-0.5 text-rose-300" />
							<div class="flex flex-1 items-start gap-3">
								<span class="mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-rose-500/20 text-xs font-semibold text-rose-200">
									8
								</span>
								<p class="text-sm font-medium leading-5 text-gray-100">
									Your Liked Songs show up in the same order as Spotify.
								</p>
							</div>
						</div>
					</div>
				</div>
			</div>
		{:else if isQueryATidalUrl}
			<div class="py-12 text-center text-gray-400">
				<div class="flex flex-col items-center gap-4">
					<Link2 size={48} class="text-rose-300" />
					<p class="text-lg text-white">Tidal URL detected</p>
					<p class="text-sm">Press Enter or click Import to load this content</p>
				</div>
			</div>
		{:else if isSpotifyPlaylistConversionReady}
			<div class="py-12 text-center text-gray-400">
				<div class="flex flex-col items-center gap-4">
					<Link2 size={48} class="text-rose-300" />
					<p class="text-lg text-white">Spotify playlist detected</p>
					<p class="text-sm">Press Enter or click Save Playlist to import it.</p>
				</div>
			</div>
		{:else if isQueryAStreamingUrl}
			<div class="py-12 text-center text-gray-400">
				<div class="flex flex-col items-center gap-4">
					<Link2 size={48} class="text-rose-300" />
					<p class="text-lg text-white">Streaming URL detected</p>
					<p class="text-sm">
						Press Enter or click Convert & Play to import this {getPlatformName(searchStore.query) || 'streaming'} link.
					</p>
				</div>
			</div>
		{:else if isSearchQueryReady}
			<div class="py-12 text-center text-gray-400">
				<p>No results found...</p>
			</div>
		{/if}
	{/if}
</div>

<style>
	.search-glass {
		background: linear-gradient(145deg, rgba(28, 12, 18, 0.75), rgba(12, 6, 10, 0.6));
		border-color: rgba(255, 255, 255, 0.14);
		backdrop-filter: blur(var(--perf-blur-high, 32px)) saturate(var(--perf-saturate, 160%));
		-webkit-backdrop-filter: blur(var(--perf-blur-high, 32px)) saturate(var(--perf-saturate, 160%));
		box-shadow:
			0 14px 36px rgba(2, 6, 23, 0.5),
			0 2px 10px rgba(18, 10, 16, 0.35),
			inset 0 1px 0 rgba(255, 255, 255, 0.08);
		transition:
			border-color 1.2s cubic-bezier(0.4, 0, 0.2, 1),
			box-shadow 0.3s ease;
	}

	.search-glass:focus-within {
		border-color: rgba(239, 68, 68, 0.6);
		box-shadow:
			0 12px 26px rgba(2, 6, 23, 0.45),
			0 0 0 2px rgba(239, 68, 68, 0.18);
	}

	.track-glass {
		position: relative;
		background: rgba(18, 10, 16, 0.55);
		border: 1px solid rgba(255, 255, 255, 0.1);
		backdrop-filter: blur(var(--perf-blur-medium, 28px)) saturate(var(--perf-saturate, 160%));
		-webkit-backdrop-filter: blur(var(--perf-blur-medium, 28px))
			saturate(var(--perf-saturate, 160%));
		box-shadow:
			0 6px 16px rgba(2, 6, 23, 0.35),
			inset 0 1px 0 rgba(255, 255, 255, 0.05);
		transition:
			border-color 1.2s cubic-bezier(0.4, 0, 0.2, 1),
			box-shadow 0.3s ease,
			filter 0.2s ease;
	}

	.track-menu-container {
		z-index: 9999;
	}

	.region-selector {
		background: rgba(18, 10, 16, 0.55);
		border-color: rgba(255, 255, 255, 0.14);
		backdrop-filter: blur(var(--perf-blur-high, 32px)) saturate(var(--perf-saturate, 160%));
		-webkit-backdrop-filter: blur(var(--perf-blur-high, 32px)) saturate(var(--perf-saturate, 160%));
		transition:
			border-color 1.2s cubic-bezier(0.4, 0, 0.2, 1),
			box-shadow 0.3s ease;
	}

	.region-selector:hover {
		border-color: rgba(239, 68, 68, 0.45);
		box-shadow:
			0 6px 20px rgba(2, 6, 23, 0.45),
			0 2px 8px rgba(18, 10, 16, 0.3),
			inset 0 1px 0 rgba(255, 255, 255, 0.08);
	}

	.region-selector:focus {
		border-color: rgba(239, 68, 68, 0.75);
		box-shadow:
			0 6px 20px rgba(2, 6, 23, 0.45),
			0 2px 8px rgba(18, 10, 16, 0.3),
			0 0 0 3px color-mix(in srgb, var(--bloom-accent, #ef4444) 20%, transparent),
			inset 0 1px 0 rgba(255, 255, 255, 0.08);
	}

	.region-chevron {
		transition: transform 200ms ease;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transform: translateY(-50%);
	}

	.region-chevron.rotate-180 {
		transform: translateY(-50%) rotate(180deg);
	}

	/* Search button acrylic styling */
	.search-button {
		background: linear-gradient(135deg, rgba(239, 68, 68, 0.95), rgba(185, 28, 28, 0.85));
		border: 1px solid rgba(239, 68, 68, 0.45);
		backdrop-filter: blur(16px) saturate(140%);
		-webkit-backdrop-filter: blur(16px) saturate(140%);
		box-shadow:
			0 6px 18px rgba(239, 68, 68, 0.35),
			inset 0 1px 0 rgba(255, 255, 255, 0.1);
		transition:
			background 0.3s ease,
			border-color 0.3s ease,
			box-shadow 0.3s ease,
			opacity 0.2s ease;
	}

	.search-button:hover:not(:disabled) {
		background: linear-gradient(135deg, rgba(239, 68, 68, 1), rgba(127, 29, 29, 0.95));
		box-shadow:
			0 8px 20px rgba(239, 68, 68, 0.45),
			inset 0 1px 0 rgba(255, 255, 255, 0.15);
	}

	/* Improved contrast for grey text */
	:global(.text-gray-400) {
		color: rgba(226, 209, 209, 0.88) !important;
	}

	:global(.text-gray-500) {
		color: rgba(189, 160, 160, 0.68) !important;
	}

	/* Better placeholder contrast */
	input::placeholder {
		color: rgb(197, 169, 169) !important;
		opacity: 1;
	}

	/* Hide scrollbar for mobile tabs */
	.scrollbar-hide {
		-ms-overflow-style: none;
		scrollbar-width: none;
	}

	.scrollbar-hide::-webkit-scrollbar {
		display: none;
	}
</style>
