<script lang="ts">
	import { losslessAPI } from '$lib/api';
	import { libraryStore } from '$lib/stores/library';
	import { playerStore } from '$lib/stores/player';
	import {
		isSonglinkTrack,
		type PlayableTrack,
		type Track,
		type SonglinkTrack,
		type SpotifyPlaylist,
		type SpotifyTrackMetadata
	} from '$lib/types';
	import { formatArtists } from '$lib/utils';
	import { prefetchStreamUrls } from '$lib/utils/streamPrefetch';
	import { fetchSonglinkData, extractTidalInfo, extractTidalSongEntity } from '$lib/utils/songlink';
	import { Heart } from 'lucide-svelte';

	let openCustomId = $state<string | null>(null);
	let openSpotifyId = $state<string | null>(null);
	let editingSpotifyId = $state<string | null>(null);
	let editingSpotifyTitle = $state('');
	let likingSpotifyIds = $state(new Set<string>());
	let likingSpotifyDoneIds = $state(new Set<string>());
	let likingSpotifyProgress = $state<Record<string, { done: number; total: number }>>({});
	let prefetchedPlaylistIds = new Set<string>();
	let prefetchingPlaylists = false;
	const likingSpotifyDoneTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
	let spotifyVisibleCounts = $state<Record<string, number>>({});
	const SPOTIFY_VISIBLE_DEFAULT = 200;
	const SPOTIFY_VISIBLE_STEP = 200;
	const spotifyResolveQueue: Array<{ playlistId: string; track: SpotifyTrackMetadata }> = [];
	const spotifyResolvePending = new Set<string>();
	let spotifyResolveInFlight = 0;
	const SPOTIFY_RESOLVE_CONCURRENCY = 2;
	const SPOTIFY_LIKE_RESOLVE_ATTEMPTS = 4;
	const SPOTIFY_LIKE_SEARCH_ATTEMPTS = 2;
	const SPOTIFY_LIKE_FETCH_ATTEMPTS = 3;
	const SPOTIFY_LIKE_RETRY_DELAYS_MS = [250, 750, 1500, 2500];

	const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	const normalizeText = (value: string) =>
		value
			.normalize('NFD')
			.replace(/[\u0300-\u036f]/g, '')
			.replace(/[^a-z0-9\s]+/gi, '')
			.toLowerCase()
			.trim();

	const getTrackArtistLabel = (track: Track): string => {
		if (track.artists?.length) {
			return formatArtists(track.artists);
		}
		return track.artist?.name ?? '';
	};

	const scoreTrackMatch = (
		candidate: Track,
		targetTitle: string,
		targetArtist: string,
		targetDurationMs?: number
	) => {
		const candidateTitle = normalizeText(candidate.title ?? '');
		const candidateArtist = normalizeText(getTrackArtistLabel(candidate));
		let score = 0;

		if (candidateTitle && targetTitle) {
			if (candidateTitle === targetTitle) {
				score += 60;
			} else if (
				candidateTitle.includes(targetTitle) ||
				targetTitle.includes(candidateTitle)
			) {
				score += 35;
			}
		}

		if (candidateArtist && targetArtist) {
			if (candidateArtist === targetArtist) {
				score += 30;
			} else if (
				candidateArtist.includes(targetArtist) ||
				targetArtist.includes(candidateArtist)
			) {
				score += 15;
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

	const findBestTrackMatch = (tracks: Track[], source: SpotifyTrackMetadata): Track | null => {
		const targetTitle = normalizeText(source.title ?? '');
		const targetArtist = normalizeText(source.artistName ?? '');
		if (!targetTitle) return null;
		let best: Track | null = null;
		let bestScore = 0;

		for (const candidate of tracks) {
			const score = scoreTrackMatch(candidate, targetTitle, targetArtist, source.duration);
			if (score > bestScore) {
				bestScore = score;
				best = candidate;
			}
		}

		return bestScore >= 55 ? best : null;
	};

	const searchTidalFallback = async (
		source: SpotifyTrackMetadata
	): Promise<{ id: number; url: string } | null> => {
		const queryParts = [source.title, source.artistName].filter(Boolean);
		if (queryParts.length === 0) return null;
		const query = queryParts.join(' ');

		for (let attempt = 1; attempt <= SPOTIFY_LIKE_SEARCH_ATTEMPTS; attempt += 1) {
			try {
				const response = await losslessAPI.searchTracks(query);
				const items = response?.items ?? [];
				const best = findBestTrackMatch(items, source);
				if (best?.id && Number.isFinite(best.id)) {
					return {
						id: best.id,
						url: `https://tidal.com/browse/track/${best.id}`
					};
				}
			} catch (error) {
				if (attempt === SPOTIFY_LIKE_SEARCH_ATTEMPTS) {
					console.warn('Tidal search fallback failed', error);
				}
			}
			if (attempt < SPOTIFY_LIKE_SEARCH_ATTEMPTS) {
				const delayMs =
					SPOTIFY_LIKE_RETRY_DELAYS_MS[
						Math.min(attempt - 1, SPOTIFY_LIKE_RETRY_DELAYS_MS.length - 1)
					];
				await wait(delayMs);
			}
		}

		return null;
	};

	function toggleCustomOpen(id: string) {
		openCustomId = openCustomId === id ? null : id;
	}

	function handlePlayCustom(tracks: PlayableTrack[], index: number) {
		playerStore.playQueue(tracks, index);
	}

	function toggleSpotifyOpen(id: string) {
		if (openSpotifyId === id) {
			openSpotifyId = null;
			return;
		}
		openSpotifyId = id;
		if (!spotifyVisibleCounts[id]) {
			spotifyVisibleCounts = { ...spotifyVisibleCounts, [id]: SPOTIFY_VISIBLE_DEFAULT };
		}
		const playlist = $libraryStore.spotifyPlaylists.find((item) => item.id === id);
		if (playlist) {
			primeSpotifyMetadata(playlist);
		}
	}

	function buildSpotifySonglinkTracks(tracks: SpotifyTrackMetadata[]): SonglinkTrack[] {
		return tracks.map((track) => {
			const durationSeconds = Math.max(
				1,
				Math.round((track.duration ?? 180000) / 1000)
			);
			return {
				id: `spotify:track:${track.spotifyId}`,
				title: track.title,
				artistName: track.artistName,
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

	function getSpotifyVisibleCount(playlist: SpotifyPlaylist): number {
		const requested = spotifyVisibleCounts[playlist.id] ?? SPOTIFY_VISIBLE_DEFAULT;
		return Math.min(requested, playlist.tracks.length);
	}

	function getSpotifyVisibleTracks(playlist: SpotifyPlaylist): SpotifyTrackMetadata[] {
		return playlist.tracks.slice(0, getSpotifyVisibleCount(playlist));
	}

	function showMoreSpotifyTracks(playlist: SpotifyPlaylist) {
		const current = spotifyVisibleCounts[playlist.id] ?? SPOTIFY_VISIBLE_DEFAULT;
		const next = Math.min(current + SPOTIFY_VISIBLE_STEP, playlist.tracks.length);
		spotifyVisibleCounts = { ...spotifyVisibleCounts, [playlist.id]: next };
		primeSpotifyMetadata(playlist);
	}

	function showAllSpotifyTracks(playlist: SpotifyPlaylist) {
		spotifyVisibleCounts = { ...spotifyVisibleCounts, [playlist.id]: playlist.tracks.length };
		primeSpotifyMetadata(playlist);
	}

	function handlePlaySpotify(playlist: SpotifyPlaylist, index = 0) {
		if (!playlist.tracks.length) {
			return;
		}
		const playable = playlist.tracks.filter((track) => track.linkStatus !== 'missing');
		const selected = playlist.tracks[index];
		const playableIndex = playable.findIndex(
			(track) => track.spotifyId === selected?.spotifyId
		);
		if (playableIndex < 0) {
			return;
		}
		const queue = buildSpotifySonglinkTracks(playable);
		playerStore.playQueue(queue, playableIndex);
	}

	function findBestThumbnail(response: Awaited<ReturnType<typeof fetchSonglinkData>>): string | null {
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
	}

	function queueSpotifyTrackResolution(playlistId: string, track: SpotifyTrackMetadata) {
		const key = `${playlistId}:${track.spotifyId}`;
		if (spotifyResolvePending.has(key)) {
			return;
		}
		if (track.linkStatus === 'missing') {
			return;
		}
		if (track.linkUrl || track.tidalId) {
			if (track.albumImageUrl) {
				return;
			}
		}
		spotifyResolvePending.add(key);
		spotifyResolveQueue.push({ playlistId, track });
		drainSpotifyResolveQueue();
	}

	function drainSpotifyResolveQueue() {
		while (
			spotifyResolveInFlight < SPOTIFY_RESOLVE_CONCURRENCY &&
			spotifyResolveQueue.length > 0
		) {
			const entry = spotifyResolveQueue.shift();
			if (!entry) break;
			spotifyResolveInFlight += 1;
			resolveSpotifyTrackMetadata(entry)
				.catch((error) => {
					console.warn('Failed to resolve Spotify track metadata', error);
				})
				.finally(() => {
					spotifyResolveInFlight = Math.max(0, spotifyResolveInFlight - 1);
					const key = `${entry.playlistId}:${entry.track.spotifyId}`;
					spotifyResolvePending.delete(key);
					drainSpotifyResolveQueue();
				});
		}
	}

	async function resolveSpotifyTrackMetadata(entry: {
		playlistId: string;
		track: SpotifyTrackMetadata;
	}) {
		const spotifyUrl = `https://open.spotify.com/track/${entry.track.spotifyId}`;
		const songlinkData = await fetchSonglinkData(spotifyUrl, {
			userCountry: 'US',
			songIfSingle: true
		});
		const tidalInfo = extractTidalInfo(songlinkData);
		const thumbnailUrl = findBestThumbnail(songlinkData);
		const patch: Partial<SpotifyTrackMetadata> = {};
		if (thumbnailUrl && !entry.track.albumImageUrl) {
			patch.albumImageUrl = thumbnailUrl;
		}
		if (tidalInfo?.id) {
			const tidalId = Number(tidalInfo.id);
			if (Number.isFinite(tidalId)) {
				patch.tidalId = tidalId;
			}
			patch.linkUrl = tidalInfo.url;
			patch.linkStatus = 'ready';
		} else {
			patch.linkStatus = 'missing';
		}
		libraryStore.updateSpotifyTrackMetadata(entry.playlistId, entry.track.spotifyId, patch);
	}

	function primeSpotifyMetadata(playlist: SpotifyPlaylist) {
		const visibleTracks = getSpotifyVisibleTracks(playlist);
		for (const track of visibleTracks) {
			queueSpotifyTrackResolution(playlist.id, track);
		}
	}

	function beginRenameSpotifyPlaylist(playlist: SpotifyPlaylist) {
		editingSpotifyId = playlist.id;
		editingSpotifyTitle = playlist.title;
	}

	function cancelRenameSpotifyPlaylist() {
		editingSpotifyId = null;
		editingSpotifyTitle = '';
	}

	function commitRenameSpotifyPlaylist() {
		if (!editingSpotifyId) return;
		const nextTitle = editingSpotifyTitle.trim();
		if (!nextTitle) return;
		libraryStore.renameSpotifyPlaylist(editingSpotifyId, nextTitle);
		cancelRenameSpotifyPlaylist();
	}

	function canLikeSpotifyPlaylist(playlist: SpotifyPlaylist): boolean {
		return playlist.tracks.length > 0;
	}

	async function fetchTrackWithRetry(
		id: number,
		attempts = SPOTIFY_LIKE_FETCH_ATTEMPTS
	): Promise<Track | null> {
		for (let attempt = 1; attempt <= attempts; attempt += 1) {
			try {
				const data = await losslessAPI.getTrack(id);
				if (data?.track) {
					return data.track;
				}
			} catch (error) {
				if (attempt === attempts) {
					console.warn('Failed to fetch track after retries', error);
				}
			}
			if (attempt < attempts) {
				const delayMs =
					SPOTIFY_LIKE_RETRY_DELAYS_MS[Math.min(attempt - 1, SPOTIFY_LIKE_RETRY_DELAYS_MS.length - 1)];
				await wait(delayMs);
			}
		}
		return null;
	}

	async function fetchTidalTracks(ids: number[], concurrency = 4): Promise<Track[]> {
		if (ids.length === 0) return [];
		const results = new Map<number, Track>();
		let index = 0;
		const workers = Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
			while (index < ids.length) {
				const nextId = ids[index];
				index += 1;
				if (!Number.isFinite(nextId)) continue;
				const track = await fetchTrackWithRetry(nextId);
				if (track) {
					results.set(nextId, track);
				}
			}
		});
		await Promise.all(workers);
		return ids.map((id) => results.get(id)).filter((track): track is Track => Boolean(track));
	}

	async function handleLikeSpotifyPlaylist(playlist: SpotifyPlaylist) {
		if (likingSpotifyIds.has(playlist.id)) {
			return;
		}
		const existingTimeout = likingSpotifyDoneTimeouts.get(playlist.id);
		if (existingTimeout) {
			clearTimeout(existingTimeout);
			likingSpotifyDoneTimeouts.delete(playlist.id);
		}
		const nextDone = new Set(likingSpotifyDoneIds);
		nextDone.delete(playlist.id);
		likingSpotifyDoneIds = nextDone;
		likingSpotifyProgress = {
			...likingSpotifyProgress,
			[playlist.id]: { done: 0, total: playlist.tracks.length }
		};

		const next = new Set(likingSpotifyIds);
		next.add(playlist.id);
		likingSpotifyIds = next;
		let completed = false;
		try {
			await resolveSpotifyTidalIds(playlist, (done) => {
				const current = likingSpotifyProgress[playlist.id];
				if (!current) return;
				likingSpotifyProgress = {
					...likingSpotifyProgress,
					[playlist.id]: { ...current, done }
				};
			});

			const refreshed = $libraryStore.spotifyPlaylists.find((item) => item.id === playlist.id);
			const orderedIds = (refreshed?.tracks ?? playlist.tracks)
				.map((track) => track.tidalId)
				.filter((id): id is number => typeof id === 'number' && Number.isFinite(id));

			// Add in reverse batches so addLikedTracks (which prepends) preserves Spotify order.
			for (let end = orderedIds.length; end > 0; end -= 30) {
				const start = Math.max(0, end - 30);
				const batch = orderedIds.slice(start, end);
				const tracks = await fetchTidalTracks(batch, 6);
				if (tracks.length > 0) {
					libraryStore.addLikedTracks(tracks);
				}
			}
			completed = true;
		} finally {
			const cleared = new Set(likingSpotifyIds);
			cleared.delete(playlist.id);
			likingSpotifyIds = cleared;
			if (completed) {
				const total = playlist.tracks.length;
				likingSpotifyProgress = {
					...likingSpotifyProgress,
					[playlist.id]: { done: total, total }
				};
				const doneNext = new Set(likingSpotifyDoneIds);
				doneNext.add(playlist.id);
				likingSpotifyDoneIds = doneNext;
				const timeout = setTimeout(() => {
					const nextProgress = { ...likingSpotifyProgress };
					delete nextProgress[playlist.id];
					likingSpotifyProgress = nextProgress;
					const doneCleanup = new Set(likingSpotifyDoneIds);
					doneCleanup.delete(playlist.id);
					likingSpotifyDoneIds = doneCleanup;
					likingSpotifyDoneTimeouts.delete(playlist.id);
				}, 2000);
				likingSpotifyDoneTimeouts.set(playlist.id, timeout);
			} else {
				const nextProgress = { ...likingSpotifyProgress };
				delete nextProgress[playlist.id];
				likingSpotifyProgress = nextProgress;
			}
		}
	}

	async function resolveSpotifyTidalIds(
		playlist: SpotifyPlaylist,
		onProgress?: (done: number) => void,
		onResolved?: (tidalId: number) => void
	): Promise<number[]> {
		const existingIds = playlist.tracks
			.map((track) => track.tidalId)
			.filter((id): id is number => typeof id === 'number' && Number.isFinite(id));
		for (const id of existingIds) {
			onResolved?.(id);
		}
		const missing = playlist.tracks.filter((track) => !track.tidalId);
		onProgress?.(playlist.tracks.length - missing.length);
		if (missing.length === 0) {
			return existingIds;
		}

		const resolvedIds = [...existingIds];
		let index = 0;
		const concurrency = Math.min(SPOTIFY_RESOLVE_CONCURRENCY, missing.length);

		const workers = Array.from({ length: concurrency }, async () => {
			while (index < missing.length) {
				const current = missing[index];
				index += 1;
				const spotifyUrl = `https://open.spotify.com/track/${current.spotifyId}`;
				let resolvedId: number | null = null;
				let resolvedUrl: string | undefined;
				let resolvedThumbnail: string | null = null;

				for (let attempt = 1; attempt <= SPOTIFY_LIKE_RESOLVE_ATTEMPTS; attempt += 1) {
					try {
						const songlinkData = await fetchSonglinkData(spotifyUrl, {
							userCountry: 'US',
							songIfSingle: true
						});
						const tidalInfo = extractTidalInfo(songlinkData);
						if (!resolvedThumbnail) {
							resolvedThumbnail = findBestThumbnail(songlinkData);
						}
						if (tidalInfo?.id) {
							const tidalId = Number(tidalInfo.id);
							if (Number.isFinite(tidalId)) {
								resolvedId = tidalId;
								resolvedUrl = tidalInfo.url;
								break;
							}
						}
					} catch (error) {
						if (attempt === SPOTIFY_LIKE_RESOLVE_ATTEMPTS) {
							console.warn('Failed to resolve Spotify track for likes', error);
							break;
						}
					}
					const delayMs =
						SPOTIFY_LIKE_RETRY_DELAYS_MS[
							Math.min(attempt - 1, SPOTIFY_LIKE_RETRY_DELAYS_MS.length - 1)
						];
					await wait(delayMs);
				}

				if (!resolvedId) {
					const fallback = await searchTidalFallback(current);
					if (fallback?.id) {
						resolvedId = fallback.id;
						resolvedUrl = fallback.url;
					}
				}

				const patch: Partial<SpotifyTrackMetadata> = {};
				if (resolvedThumbnail && !current.albumImageUrl) {
					patch.albumImageUrl = resolvedThumbnail;
				}
				if (resolvedId && Number.isFinite(resolvedId)) {
					patch.tidalId = resolvedId;
					patch.linkUrl = resolvedUrl;
					patch.linkStatus = 'ready';
					resolvedIds.push(resolvedId);
					onResolved?.(resolvedId);
				} else {
					patch.linkStatus = 'missing';
				}
				if (Object.keys(patch).length > 0) {
					libraryStore.updateSpotifyTrackMetadata(playlist.id, current.spotifyId, patch);
				}
				onProgress?.(playlist.tracks.length - (missing.length - index));
			}
		});

		await Promise.all(workers);
		return resolvedIds;
	}

	async function prefetchSavedPlaylists() {
		if (prefetchingPlaylists) {
			return;
		}
		const quality = $playerStore.quality;
		const saved = $libraryStore.savedPlaylists.slice(0, 2);
		const custom = $libraryStore.customPlaylists.slice(0, 2);
		prefetchingPlaylists = true;

		for (const playlist of saved) {
			if (!playlist || prefetchedPlaylistIds.has(playlist.uuid)) {
				continue;
			}
			prefetchedPlaylistIds.add(playlist.uuid);
			try {
				const data = await losslessAPI.getPlaylist(playlist.uuid);
				const items = data?.items ?? [];
				const tracks = items
					.map((item) => item.item)
					.filter((track): track is Track => Boolean(track));
				if (tracks.length > 0) {
					prefetchStreamUrls(tracks, quality, 6);
				}
			} catch (error) {
				console.debug('Saved playlist prefetch failed', error);
			}
		}

		for (const playlist of custom) {
			const eligible = playlist.tracks.filter(
				(track): track is Track => !isSonglinkTrack(track)
			);
			if (eligible.length > 0) {
				prefetchStreamUrls(eligible, quality, 6);
			}
		}

		prefetchingPlaylists = false;
	}

	$effect(() => {
		void prefetchSavedPlaylists();
	});
</script>

<svelte:head>
	<title>Saved Playlists | BiniLossless</title>
</svelte:head>

<section class="page-shell">
	<h2>Saved Playlists</h2>
	<p class="page-subtitle">Playlists you've saved for quick access.</p>
	{#if $libraryStore.savedPlaylists.length === 0 && $libraryStore.customPlaylists.length === 0}
		<p class="empty-state">No saved playlists yet.</p>
		<a class="page-link" href="/">Return home</a>
	{:else if $libraryStore.savedPlaylists.length > 0}
		<div class="library-grid">
			{#each $libraryStore.savedPlaylists as playlist}
				<article class="library-card">
					<a
						href={`/playlist/${playlist.uuid}`}
						class="library-link"
						data-sveltekit-preload-data
					>
						{#if playlist.squareImage || playlist.image}
							<img
								src={losslessAPI.getCoverUrl(playlist.squareImage || playlist.image, '640')}
								alt={playlist.title}
								loading="lazy"
								decoding="async"
								class="library-cover"
							/>
						{:else}
							<div class="library-cover library-cover--empty">No artwork</div>
						{/if}
						<div class="library-meta">
							<h3>{playlist.title}</h3>
							<p>{playlist.creator?.name ?? 'Unknown creator'}</p>
						</div>
					</a>
					<button
						onclick={() => libraryStore.toggleSavedPlaylist(playlist)}
						class="library-action"
						aria-label={`Remove ${playlist.title} from saved playlists`}
					>
						Remove
					</button>
				</article>
			{/each}
		</div>
	{/if}

	{#if $libraryStore.customPlaylists.length > 0}
		<div class="custom-section">
			<h3>Imported Playlists</h3>
			<div class="custom-list">
				{#each $libraryStore.customPlaylists as playlist}
					<article class="custom-card">
						<div class="custom-header">
							<div>
								<h4>{playlist.title}</h4>
								<p>{playlist.tracks.length} tracks</p>
							</div>
							<div class="custom-actions">
								<button
									onclick={() => toggleCustomOpen(playlist.id)}
									class="custom-button"
								>
									{openCustomId === playlist.id ? 'Hide' : 'View'}
								</button>
								<button
									onclick={() => libraryStore.removeCustomPlaylist(playlist.id)}
									class="custom-button custom-button--danger"
								>
									Remove
								</button>
							</div>
						</div>
						{#if openCustomId === playlist.id}
							<ul class="custom-tracks">
								{#each playlist.tracks as track, index}
									<li>
										<button
											onclick={() => handlePlayCustom(playlist.tracks, index)}
											class="custom-track"
										>
											{#if isSonglinkTrack(track)}
												<img
													src={track.thumbnailUrl || '/placeholder-album.jpg'}
													alt={track.title}
													loading="lazy"
													decoding="async"
												/>
												<div>
													<strong>{track.title}</strong>
													<span>{track.artistName}</span>
												</div>
											{:else}
												{#if track.album?.cover}
													<img
														src={losslessAPI.getCoverUrl(track.album.cover, '320')}
														alt={track.title}
														loading="lazy"
														decoding="async"
													/>
												{:else}
													<div class="cover-fallback">No art</div>
												{/if}
												<div>
													<strong>{track.title}</strong>
													<span>{formatArtists(track.artists)}</span>
												</div>
											{/if}
										</button>
									</li>
								{/each}
							</ul>
						{/if}
					</article>
				{/each}
			</div>
		</div>
	{/if}

	{#if $libraryStore.spotifyPlaylists.length > 0}
		<div class="spotify-section">
			<h3>Spotify Playlists</h3>
			<div class="spotify-list">
				{#each $libraryStore.spotifyPlaylists as playlist}
					<article class="spotify-card">
						<div class="spotify-header">
							<div>
								{#if editingSpotifyId === playlist.id}
									<div class="spotify-rename">
										<input
											class="spotify-rename__input"
											type="text"
											bind:value={editingSpotifyTitle}
											onkeydown={(event) => {
												if (event.key === 'Enter') {
													commitRenameSpotifyPlaylist();
												} else if (event.key === 'Escape') {
													cancelRenameSpotifyPlaylist();
												}
											}}
											aria-label="Rename playlist"
										/>
										<div class="spotify-rename__actions">
											<button
												onclick={commitRenameSpotifyPlaylist}
												class="spotify-button spotify-button--play"
											>
												Save
											</button>
											<button
												onclick={cancelRenameSpotifyPlaylist}
												class="spotify-button"
											>
												Cancel
											</button>
										</div>
									</div>
								{:else}
									<h4>{playlist.title}</h4>
									<p>{playlist.totalTracks} tracks</p>
									{#if playlist.description}
										<p class="spotify-description">{playlist.description}</p>
									{/if}
								{/if}
							</div>
							<div class="spotify-actions">
								<button
									onclick={() => toggleSpotifyOpen(playlist.id)}
									class="spotify-button"
								>
									{openSpotifyId === playlist.id ? 'Hide' : 'View'}
								</button>
								{#if editingSpotifyId !== playlist.id}
									<button
										onclick={() => beginRenameSpotifyPlaylist(playlist)}
										class="spotify-button"
									>
										Rename
									</button>
								{/if}
								<button
									onclick={() => handleLikeSpotifyPlaylist(playlist)}
									class="spotify-button spotify-button--like"
									disabled={!canLikeSpotifyPlaylist(playlist) || likingSpotifyIds.has(playlist.id)}
									aria-label="Like all tracks in playlist"
									title={canLikeSpotifyPlaylist(playlist) ? 'Like all tracks' : 'No resolved tracks yet'}
								>
									<Heart size={16} />
								</button>
								{#if likingSpotifyProgress[playlist.id]}
									<span class="spotify-progress">
										{#if likingSpotifyDoneIds.has(playlist.id)}
											Done
										{:else if likingSpotifyProgress[playlist.id].done >= likingSpotifyProgress[playlist.id].total}
											Finalizing
										{:else}
											Liking
											{likingSpotifyProgress[playlist.id].done}/{likingSpotifyProgress[playlist.id].total}
										{/if}
									</span>
								{/if}
								<button
									onclick={() => handlePlaySpotify(playlist)}
									class="spotify-button spotify-button--play"
								>
									Play
								</button>
								<button
									onclick={() => libraryStore.removeSpotifyPlaylist(playlist.id)}
									class="spotify-button spotify-button--danger"
								>
									Remove
								</button>
							</div>
						</div>
						{#if openSpotifyId === playlist.id}
							<div class="spotify-tracks">
								{#if playlist.tracks.length === 0}
									<p class="spotify-error">No tracks found in this playlist.</p>
								{:else}
									<ul class="spotify-tracklist">
										{#each getSpotifyVisibleTracks(playlist) as track, index}
											<li>
												<button
													class={`spotify-track ${track.linkStatus === 'missing' ? 'spotify-track--disabled' : ''}`}
													onclick={() => handlePlaySpotify(playlist, index)}
													disabled={track.linkStatus === 'missing'}
													aria-disabled={track.linkStatus === 'missing'}
													title={track.linkStatus === 'missing'
														? 'No playable link found'
														: track.linkUrl ?? 'Play track'}
												>
													<span class="spotify-track__index">{index + 1}</span>
													{#if track.albumImageUrl}
														<img
															class="spotify-track__cover"
															src={track.albumImageUrl}
															alt={track.albumName ?? track.title}
															loading="lazy"
															decoding="async"
														/>
													{:else}
														<div class="spotify-track__cover spotify-track__cover--empty">
															No art
														</div>
													{/if}
													<span class="spotify-track__title">{track.title}</span>
													<span class="spotify-track__artist">{track.artistName}</span>
													{#if track.albumName}
														<span class="spotify-track__album">{track.albumName}</span>
													{/if}
												</button>
											</li>
										{/each}
									</ul>
									{#if getSpotifyVisibleCount(playlist) < playlist.tracks.length}
										<div class="spotify-track-actions">
											<button
												class="spotify-button"
												onclick={() => showMoreSpotifyTracks(playlist)}
											>
												Show more
											</button>
											<button
												class="spotify-button"
												onclick={() => showAllSpotifyTracks(playlist)}
											>
												Show all ({playlist.tracks.length})
											</button>
										</div>
									{/if}
								{/if}
							</div>
						{/if}
					</article>
				{/each}
			</div>
		</div>
	{/if}
</section>

<style>
	.page-shell {
		max-width: 880px;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	h2 {
		margin: 0;
		font-size: clamp(1.6rem, 2.4vw, 2.1rem);
		letter-spacing: -0.02em;
		background: linear-gradient(120deg, #f8fafc 0%, #b8f3ee 55%, #ffd6a3 100%);
		background-clip: text;
		-webkit-background-clip: text;
		color: transparent;
	}

	p {
		margin: 0;
		color: rgba(226, 232, 240, 0.78);
	}

	.page-subtitle {
		font-size: 0.9rem;
	}

	.empty-state {
		margin-top: 0.5rem;
		font-size: 0.95rem;
		color: rgba(203, 213, 225, 0.7);
	}

	.library-grid {
		display: grid;
		gap: 1rem;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		margin-top: 0.5rem;
	}

	.library-card {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		border-radius: 18px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		background: rgba(18, 10, 16, 0.55);
		backdrop-filter: blur(24px) saturate(150%);
		-webkit-backdrop-filter: blur(24px) saturate(150%);
		padding: 0.75rem;
	}

	.library-link {
		text-decoration: none;
		color: inherit;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		align-items: flex-start;
	}

	.library-cover {
		width: 100%;
		max-width: 120px;
		aspect-ratio: 1 / 1;
		border-radius: 16px;
		object-fit: cover;
		background: rgba(12, 6, 10, 0.7);
		align-self: flex-start;
	}

	.library-cover--empty {
		display: flex;
		align-items: center;
		justify-content: center;
		color: rgba(148, 163, 184, 0.7);
		font-size: 0.85rem;
	}

	.library-meta h3 {
		margin: 0;
		font-size: 0.95rem;
	}

	.library-meta p {
		margin: 0.25rem 0 0;
		font-size: 0.8rem;
		color: rgba(203, 213, 225, 0.75);
	}

	.library-action {
		align-self: flex-start;
		border: 1px solid rgba(239, 68, 68, 0.45);
		border-radius: 999px;
		padding: 0.35rem 0.8rem;
		background: rgba(239, 68, 68, 0.12);
		color: rgba(253, 186, 116, 0.95);
		font-size: 0.75rem;
		cursor: pointer;
	}

	.library-action:hover {
		border-color: rgba(239, 68, 68, 0.75);
		color: rgba(255, 237, 213, 1);
	}

	.custom-section {
		margin-top: 2rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.custom-section h3 {
		margin: 0;
		font-size: 1rem;
		color: rgba(226, 232, 240, 0.9);
	}

	.custom-list {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.custom-card {
		border-radius: 18px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		background: rgba(18, 10, 16, 0.55);
		backdrop-filter: blur(24px) saturate(150%);
		-webkit-backdrop-filter: blur(24px) saturate(150%);
		padding: 0.75rem;
	}

	.custom-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.custom-header h4 {
		margin: 0;
		font-size: 0.95rem;
	}

	.custom-header p {
		margin: 0.2rem 0 0;
		font-size: 0.8rem;
		color: rgba(203, 213, 225, 0.7);
	}

	.custom-actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.custom-button {
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 999px;
		padding: 0.25rem 0.75rem;
		background: rgba(18, 10, 16, 0.45);
		color: rgba(226, 232, 240, 0.88);
		font-size: 0.75rem;
		cursor: pointer;
	}

	.custom-button:hover {
		border-color: rgba(239, 68, 68, 0.6);
		color: rgba(254, 226, 226, 0.95);
	}

	.custom-button--danger {
		border-color: rgba(239, 68, 68, 0.45);
		color: rgba(253, 186, 116, 0.95);
	}

	.custom-button--danger:hover {
		border-color: rgba(239, 68, 68, 0.7);
		color: rgba(255, 237, 213, 1);
	}

	.custom-tracks {
		margin: 0.75rem 0 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.custom-track {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.6rem;
		align-items: center;
		width: 100%;
		text-align: left;
		background: rgba(18, 10, 16, 0.45);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 14px;
		padding: 0.5rem 0.6rem;
		color: inherit;
		cursor: pointer;
	}

	.custom-track img,
	.cover-fallback {
		width: 44px;
		height: 44px;
		border-radius: 12px;
		object-fit: cover;
		background: rgba(12, 6, 10, 0.7);
	}

	.cover-fallback {
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.65rem;
		color: rgba(148, 163, 184, 0.7);
	}

	.custom-track strong {
		display: block;
		font-size: 0.85rem;
	}

	.custom-track span {
		display: block;
		font-size: 0.75rem;
		color: rgba(203, 213, 225, 0.75);
	}

	.spotify-section h3 {
		margin: 0;
		font-size: 1rem;
		color: rgba(226, 232, 240, 0.9);
	}

	.spotify-list {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.spotify-card {
		border-radius: 18px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		background: rgba(18, 10, 16, 0.55);
		backdrop-filter: blur(24px) saturate(150%);
		-webkit-backdrop-filter: blur(24px) saturate(150%);
		padding: 0.75rem;
	}

	.spotify-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.spotify-header h4 {
		margin: 0;
		font-size: 0.95rem;
	}

	.spotify-header p {
		margin: 0.2rem 0 0;
		font-size: 0.8rem;
		color: rgba(203, 213, 225, 0.7);
	}

	.spotify-description {
		margin: 0.3rem 0 0;
		font-size: 0.75rem;
		color: rgba(148, 163, 184, 0.6);
		font-style: italic;
	}

	.spotify-actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.spotify-rename {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.spotify-rename__input {
		border-radius: 10px;
		border: 1px solid rgba(239, 68, 68, 0.4);
		background: rgba(12, 6, 10, 0.6);
		padding: 0.35rem 0.6rem;
		color: rgba(255, 255, 255, 0.95);
		font-size: 0.85rem;
	}

	.spotify-rename__input:focus {
		outline: none;
		border-color: rgba(239, 68, 68, 0.7);
		box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.2);
	}

	.spotify-rename__actions {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.spotify-button {
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 999px;
		padding: 0.25rem 0.75rem;
		background: rgba(18, 10, 16, 0.45);
		color: rgba(226, 232, 240, 0.9);
		font-size: 0.75rem;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
	}

	.spotify-button:hover:not(:disabled) {
		border-color: rgba(239, 68, 68, 0.6);
		color: rgba(254, 226, 226, 0.95);
	}

	.spotify-button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.spotify-button--play {
		border-color: rgba(239, 68, 68, 0.45);
		color: rgba(254, 202, 202, 0.95);
	}

	.spotify-button--play:hover:not(:disabled) {
		border-color: rgba(239, 68, 68, 0.75);
		color: rgba(254, 226, 226, 1);
	}

	.spotify-button--danger {
		border-color: rgba(239, 68, 68, 0.45);
		color: rgba(253, 186, 116, 0.95);
	}

	.spotify-button--like {
		border-color: rgba(239, 68, 68, 0.45);
		color: rgba(254, 202, 202, 0.95);
	}

	.spotify-progress {
		font-size: 0.7rem;
		color: rgba(253, 186, 116, 0.9);
	}

	.spotify-button--danger:hover {
		border-color: rgba(239, 68, 68, 0.75);
		color: rgba(255, 237, 213, 1);
	}

	.spotify-tracks {
		margin-top: 0.75rem;
	}

	.spotify-error {
		color: rgba(203, 213, 225, 0.7);
		font-size: 0.85rem;
	}

	.spotify-tracklist {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.spotify-track {
		display: grid;
		grid-template-columns: 2rem 2.25rem minmax(0, 2fr) minmax(0, 1.5fr) minmax(0, 1.5fr);
		gap: 0.75rem;
		align-items: center;
		width: 100%;
		text-align: left;
		background: rgba(18, 10, 16, 0.45);
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 12px;
		padding: 0.4rem 0.6rem;
		color: rgba(226, 232, 240, 0.9);
	}

	.spotify-track:hover {
		border-color: rgba(239, 68, 68, 0.55);
		color: #fff;
	}

	.spotify-track--disabled {
		opacity: 0.45;
		cursor: not-allowed;
		border-color: rgba(148, 163, 184, 0.15);
	}

	.spotify-track--disabled:hover {
		border-color: rgba(148, 163, 184, 0.2);
		color: rgba(226, 232, 240, 0.85);
	}

	.spotify-track__index {
		font-size: 0.75rem;
		color: rgba(148, 163, 184, 0.7);
		text-align: center;
	}

	.spotify-track__cover {
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 10px;
		object-fit: cover;
		background: rgba(12, 6, 10, 0.6);
	}

	.spotify-track__cover--empty {
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.6rem;
		color: rgba(148, 163, 184, 0.7);
	}

	.spotify-track__title,
	.spotify-track__artist,
	.spotify-track__album {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.8rem;
	}

	.spotify-track__album {
		color: rgba(148, 163, 184, 0.75);
	}

	.spotify-track-actions {
		margin-top: 0.6rem;
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.page-link {
		align-self: flex-start;
		color: rgba(191, 219, 254, 0.95);
		text-decoration: none;
		font-weight: 600;
	}

	.page-link:hover {
		text-decoration: underline;
	}
</style>
