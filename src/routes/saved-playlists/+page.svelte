<script lang="ts">
	import { losslessAPI } from '$lib/api';
	import { libraryStore } from '$lib/stores/library';
	import { playerStore } from '$lib/stores/player';
	import {
		isSonglinkTrack,
		type PlayableTrack,
		type Track,
		type SpotifyPlaylist,
		type SpotifyTrackMetadata
	} from '$lib/types';
	import { formatArtists } from '$lib/utils';
	import { prefetchStreamUrls } from '$lib/utils/streamPrefetch';
	import {
		buildSpotifySonglinkTracks,
		fetchTrackWithRetry,
		resolveSpotifyMetadataToTidal,
		resolveUserCountry
	} from '$lib/utils/trackResolution';
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
	const SPOTIFY_PREFETCH_COUNT = 50;
	const SPOTIFY_BACKGROUND_BATCH = 120;
	const SPOTIFY_BACKGROUND_DELAY_MS = 250;
	const SPOTIFY_RESOLVE_CONCURRENCY = 2;
	const SPOTIFY_LIKE_CONCURRENCY = 3;

	type SpotifyResolveEntry = {
		playlistId: string;
		track: SpotifyTrackMetadata;
		fetchTrack: boolean;
		priority: 'high' | 'low';
	};

	const spotifyResolveQueue: SpotifyResolveEntry[] = [];
	const spotifyResolvePending = new Set<string>();
	const spotifyBackgroundActive = new Set<string>();
	let spotifyResolveInFlight = 0;
	const songlinkUserCountry = resolveUserCountry();

	const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
		const start = Math.max(0, index - Math.floor(SPOTIFY_PREFETCH_COUNT / 2));
		ensureSpotifyBootstrapResolution(playlist, start);
		void startSpotifyBackgroundResolution(playlist);
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

	function queueSpotifyTrackResolution(
		playlistId: string,
		track: SpotifyTrackMetadata,
		options: { fetchTrack?: boolean; priority?: 'high' | 'low' } = {}
	) {
		const key = `${playlistId}:${track.spotifyId}`;
		if (spotifyResolvePending.has(key)) {
			return;
		}
		if (track.linkStatus === 'missing') {
			return;
		}
		const fetchTrack = options.fetchTrack ?? false;
		if (track.tidalId && track.linkStatus === 'ready' && track.albumImageUrl && !fetchTrack) {
			return;
		}
		const entry: SpotifyResolveEntry = {
			playlistId,
			track,
			fetchTrack,
			priority: options.priority ?? 'low'
		};
		spotifyResolvePending.add(key);
		if (entry.priority === 'high') {
			spotifyResolveQueue.unshift(entry);
		} else {
			spotifyResolveQueue.push(entry);
		}
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

	async function resolveSpotifyTrackMetadata(entry: SpotifyResolveEntry) {
		const result = await resolveSpotifyMetadataToTidal(entry.track, {
			userCountry: songlinkUserCountry,
			songIfSingle: true,
			fetchTrack: entry.fetchTrack
		});
		const patch: Partial<SpotifyTrackMetadata> = {};
		if (result.thumbnailUrl && !entry.track.albumImageUrl) {
			patch.albumImageUrl = result.thumbnailUrl;
		}
		if (result.tidalId) {
			patch.tidalId = result.tidalId;
			patch.linkUrl = result.linkUrl;
			patch.linkStatus = 'ready';
		} else if (entry.fetchTrack) {
			patch.linkStatus = 'missing';
		}
		if (Object.keys(patch).length > 0) {
			libraryStore.updateSpotifyTrackMetadata(entry.playlistId, entry.track.spotifyId, patch);
		}
		if (entry.fetchTrack && result.track) {
			prefetchStreamUrls([result.track], $playerStore.quality, 1);
		}
	}

	function ensureSpotifyBootstrapResolution(playlist: SpotifyPlaylist, startIndex = 0) {
		const slice = playlist.tracks.slice(startIndex, startIndex + SPOTIFY_PREFETCH_COUNT);
		for (const track of slice) {
			queueSpotifyTrackResolution(playlist.id, track, {
				fetchTrack: true,
				priority: 'high'
			});
		}
	}

	async function startSpotifyBackgroundResolution(playlist: SpotifyPlaylist) {
		if (spotifyBackgroundActive.has(playlist.id)) {
			return;
		}
		spotifyBackgroundActive.add(playlist.id);
		const latest = $libraryStore.spotifyPlaylists.find((item) => item.id === playlist.id);
		const sourceTracks = latest?.tracks ?? playlist.tracks;
		const unresolved = sourceTracks.filter(
			(track) => !track.tidalId && track.linkStatus !== 'missing'
		);
		for (let i = 0; i < unresolved.length; i += SPOTIFY_BACKGROUND_BATCH) {
			const batch = unresolved.slice(i, i + SPOTIFY_BACKGROUND_BATCH);
			for (const track of batch) {
				queueSpotifyTrackResolution(playlist.id, track, {
					fetchTrack: !track.albumImageUrl,
					priority: 'low'
				});
			}
			if (i + SPOTIFY_BACKGROUND_BATCH < unresolved.length) {
				await wait(SPOTIFY_BACKGROUND_DELAY_MS);
			}
		}
		spotifyBackgroundActive.delete(playlist.id);
	}

	function primeSpotifyMetadata(playlist: SpotifyPlaylist) {
		const visibleTracks = getSpotifyVisibleTracks(playlist);
		for (const track of visibleTracks) {
			queueSpotifyTrackResolution(playlist.id, track, {
				fetchTrack: true,
				priority: 'high'
			});
		}
		ensureSpotifyBootstrapResolution(playlist, 0);
		void startSpotifyBackgroundResolution(playlist);
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

	async function resolveSpotifyPlaylistTracks(
		playlist: SpotifyPlaylist,
		onProgress?: (done: number) => void
	): Promise<Track[]> {
		const latest = $libraryStore.spotifyPlaylists.find((item) => item.id === playlist.id);
		const sourceTracks = latest?.tracks ?? playlist.tracks;
		const total = sourceTracks.length;
		const results: Array<Track | null> = Array.from({ length: total }).fill(null);
		let completed = 0;
		let index = 0;
		const concurrency = Math.min(SPOTIFY_LIKE_CONCURRENCY, total);

		const workers = Array.from({ length: concurrency }, async () => {
			while (index < total) {
				const currentIndex = index;
				index += 1;
				const current = sourceTracks[currentIndex];
				let result = await resolveSpotifyMetadataToTidal(current, {
					userCountry: songlinkUserCountry,
					songIfSingle: true,
					fetchTrack: true,
					resolveAttempts: 5,
					searchAttempts: 4,
					minScore: 50,
					forceScore: 35,
					allowLooseTitle: true
				});

				if (!result.tidalId) {
					result = await resolveSpotifyMetadataToTidal(current, {
						userCountry: songlinkUserCountry,
						songIfSingle: true,
						fetchTrack: true,
						resolveAttempts: 6,
						searchAttempts: 5,
						minScore: 45,
						forceScore: 30,
						allowLooseTitle: true
					});
				}
				const patch: Partial<SpotifyTrackMetadata> = {};
				if (result.thumbnailUrl && !current.albumImageUrl) {
					patch.albumImageUrl = result.thumbnailUrl;
				}
				if (result.tidalId) {
					patch.tidalId = result.tidalId;
					patch.linkUrl = result.linkUrl;
					patch.linkStatus = 'ready';
				} else if (!current.tidalId) {
					patch.linkStatus = 'missing';
				}
				if (Object.keys(patch).length > 0) {
					libraryStore.updateSpotifyTrackMetadata(playlist.id, current.spotifyId, patch);
				}
				let resolvedTrack = result.track ?? null;
				if (!resolvedTrack && result.tidalId) {
					resolvedTrack = await fetchTrackWithRetry(result.tidalId, 4);
				}
				if (resolvedTrack) {
					results[currentIndex] = resolvedTrack;
				}
				completed += 1;
				onProgress?.(completed);
			}
		});

		await Promise.all(workers);
		return results.filter((track): track is Track => Boolean(track));
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
			const resolvedTracks = await resolveSpotifyPlaylistTracks(playlist, (done) => {
				const current = likingSpotifyProgress[playlist.id];
				if (!current) return;
				likingSpotifyProgress = {
					...likingSpotifyProgress,
					[playlist.id]: { ...current, done }
				};
			});

			// Add in reverse batches so addLikedTracks (which prepends) preserves Spotify order.
			for (let end = resolvedTracks.length; end > 0; end -= 30) {
				const start = Math.max(0, end - 30);
				const batch = resolvedTracks.slice(start, end);
				if (batch.length > 0) {
					libraryStore.addLikedTracks(batch);
				}
			}
			prefetchStreamUrls(resolvedTracks, $playerStore.quality, 20);
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
