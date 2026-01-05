<script lang="ts">
	import TrackList from '$lib/components/TrackList.svelte';
	import { libraryStore } from '$lib/stores/library';
	import { formatArtists } from '$lib/utils';
	import { onMount } from 'svelte';

	const PAGE_SIZE = 120;
	let inputValue = $state('');
	let debouncedQuery = $state('');
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let visibleCount = $state(PAGE_SIZE);
	let lastQuery = $state('');
	let loadMoreAnchor = $state<HTMLDivElement | null>(null);

	function normalizeQuery(value: string): string {
		return value
			.normalize('NFD')
			.replace(/[\u0300-\u036f]/g, '')
			.toLowerCase()
			.trim();
	}

	$effect(() => {
		const nextValue = inputValue;
		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}
		debounceTimer = setTimeout(() => {
			debouncedQuery = nextValue;
		}, 160);
		return () => {
			if (debounceTimer) {
				clearTimeout(debounceTimer);
			}
		};
	});

	const searchIndex = $derived(() =>
		$libraryStore.likedTracks.map((track) => {
			const title = track.title ?? '';
			const artistLabel = track.artists?.length
				? formatArtists(track.artists)
				: track.artist?.name ?? '';
			const albumTitle = track.album?.title ?? '';
			return {
				track,
				haystack: normalizeQuery(`${title} ${artistLabel} ${albumTitle}`)
			};
		})
	);

	const activeQuery = $derived(() => normalizeQuery(debouncedQuery));

	const filteredTracks = $derived(() => {
		const normalizedQuery = activeQuery();
		if (!normalizedQuery) {
			return searchIndex().map((item) => item.track);
		}

		const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
		return searchIndex()
			.filter((item) => tokens.every((token) => item.haystack.includes(token)))
			.map((item) => item.track);
	});

	const showTotalCount = $derived(() => activeQuery().length === 0);
	const totalCount = $derived(() => $libraryStore.likedTracks.length);
	const matchCount = $derived(() => filteredTracks().length);
	const displayCount = $derived(() =>
		showTotalCount() ? totalCount() : matchCount()
	);
	const visibleTracks = $derived(() => filteredTracks().slice(0, visibleCount));
	const canLoadMore = $derived(() => visibleCount < filteredTracks().length);
	const hasLikedTracks = $derived(() => $libraryStore.likedTracks.length > 0);

	function handleClearAll() {
		const confirmed = window.confirm(
			'Are you sure you want to delete all songs and start fresh?'
		);
		if (!confirmed) {
			return;
		}
		inputValue = '';
		debouncedQuery = '';
		visibleCount = PAGE_SIZE;
		libraryStore.clearLikedTracks();
	}

	function loadMore() {
		visibleCount = Math.min(visibleCount + PAGE_SIZE, filteredTracks().length);
	}

	$effect(() => {
		const currentQuery = activeQuery();
		if (currentQuery !== lastQuery) {
			lastQuery = currentQuery;
			visibleCount = Math.min(PAGE_SIZE, filteredTracks().length);
			return;
		}
		if (visibleCount > filteredTracks().length) {
			visibleCount = filteredTracks().length;
		}
	});

	$effect(() => {
		if (!loadMoreAnchor || !canLoadMore()) {
			return;
		}
		if (typeof IntersectionObserver === 'undefined') {
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					loadMore();
				}
			},
			{ rootMargin: '240px' }
		);
		observer.observe(loadMoreAnchor);
		return () => observer.disconnect();
	});

	onMount(() => {
		libraryStore.syncFromStorage();
	});
</script>

<svelte:head>
	<title>Liked Tracks | BiniLossless</title>
</svelte:head>

<section class="page-shell">
	<div class="page-header">
		<div>
			<h2>Liked Tracks</h2>
			<p class="page-subtitle">All the songs you've liked from the player or track pages.</p>
		</div>
		<button
			class="danger-button"
			type="button"
			onclick={handleClearAll}
			disabled={!hasLikedTracks()}
		>
			Clear All
		</button>
	</div>
	{#if $libraryStore.likedTracks.length === 0}
		<p class="empty-state">No liked tracks yet.</p>
		<a class="page-link" href="/">Return home</a>
	{:else}
		<div class="search-row">
			<input
				class="search-input"
				type="search"
				placeholder="Search liked tracks"
				aria-label="Search liked tracks"
				bind:value={inputValue}
			/>
			{#if inputValue.trim().length > 0}
				<button
					class="clear-button"
					type="button"
					onclick={() => {
						inputValue = '';
						debouncedQuery = '';
					}}
				>
					Clear
				</button>
			{/if}
		</div>
		<p class="result-count">
			Showing {displayCount()} of {totalCount()}
			{#if canLoadMore()}
				<span class="result-note">Rendering {visibleTracks().length}</span>
			{/if}
		</p>
		{#if matchCount() === 0}
			<p class="empty-state">No liked tracks match your search.</p>
		{:else}
			<TrackList tracks={visibleTracks()} />
			{#if canLoadMore()}
				<div class="load-more" bind:this={loadMoreAnchor}>
					<button class="load-more-button" type="button" onclick={loadMore}>
						Load more
					</button>
				</div>
			{/if}
		{/if}
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

	.page-header {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: center;
		justify-content: space-between;
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

	.search-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem;
		align-items: center;
	}

	.search-input {
		flex: 1;
		min-width: 180px;
		border-radius: 999px;
		border: 1px solid rgba(148, 163, 184, 0.35);
		background: rgba(15, 23, 42, 0.4);
		color: rgba(248, 250, 252, 0.95);
		padding: 0.45rem 0.9rem;
		font-size: 0.9rem;
		transition: border-color 0.2s ease, box-shadow 0.2s ease;
	}

	.search-input:focus {
		outline: none;
		border-color: rgba(248, 113, 113, 0.6);
		box-shadow: 0 0 0 3px rgba(248, 113, 113, 0.2);
	}

	.clear-button {
		border-radius: 999px;
		border: 1px solid rgba(148, 163, 184, 0.35);
		background: rgba(30, 41, 59, 0.4);
		color: rgba(226, 232, 240, 0.9);
		padding: 0.35rem 0.85rem;
		font-size: 0.8rem;
		cursor: pointer;
		transition: border-color 0.2s ease, color 0.2s ease;
	}

	.clear-button:hover {
		border-color: rgba(248, 113, 113, 0.6);
		color: rgba(248, 113, 113, 0.95);
	}

	.danger-button {
		border-radius: 999px;
		border: 1px solid rgba(248, 113, 113, 0.6);
		background: rgba(127, 29, 29, 0.35);
		color: rgba(254, 202, 202, 0.95);
		padding: 0.35rem 0.85rem;
		font-size: 0.8rem;
		cursor: pointer;
		transition: border-color 0.2s ease, color 0.2s ease, background 0.2s ease;
	}

	.danger-button:hover {
		border-color: rgba(248, 113, 113, 0.9);
		color: rgba(254, 226, 226, 1);
		background: rgba(185, 28, 28, 0.4);
	}

	.danger-button:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}

	.result-count {
		font-size: 0.85rem;
		color: rgba(148, 163, 184, 0.9);
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
		align-items: center;
	}

	.result-note {
		color: rgba(226, 232, 240, 0.78);
		font-size: 0.75rem;
	}

	.empty-state {
		margin-top: 0.5rem;
		font-size: 0.95rem;
		color: rgba(203, 213, 225, 0.7);
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

	.load-more {
		display: flex;
		justify-content: center;
		padding: 0.75rem 0 0.25rem;
	}

	.load-more-button {
		border-radius: 999px;
		border: 1px solid rgba(148, 163, 184, 0.35);
		background: rgba(30, 41, 59, 0.4);
		color: rgba(226, 232, 240, 0.9);
		padding: 0.45rem 1.1rem;
		font-size: 0.85rem;
		cursor: pointer;
		transition: border-color 0.2s ease, color 0.2s ease;
	}

	.load-more-button:hover {
		border-color: rgba(248, 113, 113, 0.6);
		color: rgba(248, 113, 113, 0.95);
	}
</style>
