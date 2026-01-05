<script lang="ts">
	import { losslessAPI } from '$lib/api';
	import { libraryStore } from '$lib/stores/library';
	import { playerStore } from '$lib/stores/player';
	import { prefetchStreamUrls } from '$lib/utils/streamPrefetch';
	import type { Track } from '$lib/types';

	let prefetchedAlbumIds = new Set<number>();
	let prefetchingAlbums = false;

	async function prefetchSavedAlbums() {
		if (prefetchingAlbums || $libraryStore.savedAlbums.length === 0) {
			return;
		}
		prefetchingAlbums = true;
		const quality = $playerStore.quality;
		const candidates = $libraryStore.savedAlbums.slice(0, 3);
		for (const album of candidates) {
			if (!album || prefetchedAlbumIds.has(album.id)) {
				continue;
			}
			prefetchedAlbumIds.add(album.id);
			try {
				const data = await losslessAPI.getAlbum(album.id);
				const tracks = (data?.tracks ?? []) as Track[];
				if (tracks.length > 0) {
					prefetchStreamUrls(tracks, quality, 6);
				}
			} catch (error) {
				console.debug('Saved album prefetch failed', error);
			}
		}
		prefetchingAlbums = false;
	}

	$effect(() => {
		void prefetchSavedAlbums();
	});
</script>

<svelte:head>
	<title>Saved Albums | BiniLossless</title>
</svelte:head>

<section class="page-shell">
	<h2>Saved Albums</h2>
	<p class="page-subtitle">Albums you've saved from their detail pages.</p>
	{#if $libraryStore.savedAlbums.length === 0}
		<p class="empty-state">No saved albums yet.</p>
		<a class="page-link" href="/">Return home</a>
	{:else}
		<div class="library-grid">
			{#each $libraryStore.savedAlbums as album}
				<article class="library-card">
					<a href={`/album/${album.id}`} class="library-link" data-sveltekit-preload-data>
						{#if album.cover}
							<img
								src={losslessAPI.getCoverUrl(album.cover, '640')}
								alt={album.title}
								class="library-cover"
							/>
						{:else}
							<div class="library-cover library-cover--empty">No artwork</div>
						{/if}
						<div class="library-meta">
							<h3>{album.title}</h3>
							{#if album.artist}
								<p>{album.artist.name}</p>
							{/if}
						</div>
					</a>
					<button
						onclick={() => libraryStore.toggleSavedAlbum(album)}
						class="library-action"
						aria-label={`Remove ${album.title} from saved albums`}
					>
						Remove
					</button>
				</article>
			{/each}
		</div>
	{/if}
</section>

<style>
	.page-shell {
		max-width: 720px;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	h2 {
		margin: 0;
		font-size: clamp(1.4rem, 2vw, 1.8rem);
	}

	p {
		margin: 0;
		color: rgba(226, 232, 240, 0.82);
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
		border-radius: 14px;
		border: 1px solid rgba(148, 163, 184, 0.18);
		background: rgba(18, 10, 16, 0.4);
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
		border-radius: 12px;
		object-fit: cover;
		background: rgba(18, 10, 16, 0.6);
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
		border: 1px solid rgba(239, 68, 68, 0.35);
		border-radius: 999px;
		padding: 0.35rem 0.8rem;
		background: transparent;
		color: rgba(248, 113, 113, 0.9);
		font-size: 0.75rem;
		cursor: pointer;
	}

	.library-action:hover {
		border-color: rgba(239, 68, 68, 0.6);
		color: rgba(248, 113, 113, 1);
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
