<script lang="ts">
	import type { Track } from '$lib/types';
	import { losslessAPI, type TrackDownloadProgress } from '$lib/api';
	import { getExtensionForQuality, buildTrackFilename } from '$lib/downloads';
	import { playerStore } from '$lib/stores/player';
	import { downloadUiStore } from '$lib/stores/downloadUi';
	import { userPreferencesStore } from '$lib/stores/userPreferences';
	import { formatArtists } from '$lib/utils';
	import { prefetchStreamUrls } from '$lib/utils/streamPrefetch';
	import ShareButton from '$lib/components/ShareButton.svelte';
	import { Play, Pause, Download, ListPlus, Plus, Clock, X } from 'lucide-svelte';

	interface Props {
		tracks: Track[];
		maxTracks?: number;
		columns?: number;
	}

	function getColumnClass(columns: number): string {
		if (columns >= 3) {
			return 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3';
		}
		if (columns === 2) {
			return 'grid-cols-1 sm:grid-cols-2';
		}
		return 'grid-cols-1';
	}

	let { tracks, maxTracks = 6, columns = 3 }: Props = $props();

	const columnClass = $derived(getColumnClass(columns));
	const displayedTracks = $derived(maxTracks ? tracks.slice(0, maxTracks) : tracks);

	let downloadingIds = $state(new Set<number>());
	let downloadTaskIds = $state(new Map<number, string>());
	let cancelledIds = $state(new Set<number>());
	let openShareId = $state<number | null>(null);
	const convertAacToMp3Preference = $derived($userPreferencesStore.convertAacToMp3);
	const downloadCoverSeperatelyPreference = $derived(
		$userPreferencesStore.downloadCoversSeperately
	);

	const IGNORED_TAGS = new Set(['HI_RES_LOSSLESS']);

	$effect(() => {
		if (displayedTracks.length === 0) {
			return;
		}
		prefetchStreamUrls(displayedTracks, $playerStore.quality, displayedTracks.length);
	});

	function getDisplayTags(tags?: string[] | null): string[] {
		if (!tags) return [];
		return tags.filter((tag) => tag && !IGNORED_TAGS.has(tag));
	}

	function handlePlayTrack(track: Track, index: number) {
		playerStore.playQueue(displayedTracks, index);
	}

	function handleAddToQueue(track: Track, event: MouseEvent) {
		event.stopPropagation();
		playerStore.enqueue(track);
	}

	function handlePlayNext(track: Track, event: MouseEvent) {
		event.stopPropagation();
		playerStore.enqueueNext(track);
	}

	function handleCardKeydown(event: KeyboardEvent, track: Track, index: number) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			handlePlayTrack(track, index);
		}
	}

	function isCurrentTrack(track: Track): boolean {
		return $playerStore.currentTrack?.id === track.id;
	}

	function isPlaying(track: Track): boolean {
		return isCurrentTrack(track) && $playerStore.isPlaying;
	}

	function markCancelled(trackId: number) {
		const next = new Set(cancelledIds);
		next.add(trackId);
		cancelledIds = next;
		setTimeout(() => {
			const updated = new Set(cancelledIds);
			updated.delete(trackId);
			cancelledIds = updated;
		}, 1500);
	}

	function handleCancelDownload(trackId: number, event: MouseEvent) {
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

	async function handleDownload(track: Track, event: MouseEvent) {
		event.stopPropagation();
		const next = new Set(downloadingIds);
		next.add(track.id);
		downloadingIds = next;

		const quality = $playerStore.quality;
		const filename = buildTrackFilename(
			track.album,
			track,
			quality,
			formatArtists(track.artists),
			convertAacToMp3Preference
		);
		const { taskId, controller } = downloadUiStore.beginTrackDownload(track, filename, {
			subtitle: track.album?.title ?? track.artist?.name
		});
		const taskMap = new Map(downloadTaskIds);
		taskMap.set(track.id, taskId);
		downloadTaskIds = taskMap;
		downloadUiStore.skipFfmpegCountdown();

		try {
			await losslessAPI.downloadTrack(track.id, quality, filename, {
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
				markCancelled(track.id);
			} else {
				console.error('Failed to download track:', error);
				const fallbackMessage = 'Failed to download track. Please try again.';
				const message = error instanceof Error && error.message ? error.message : fallbackMessage;
				downloadUiStore.errorTrackDownload(taskId, message);
				alert(message);
			}
		} finally {
			const updated = new Set(downloadingIds);
			updated.delete(track.id);
			downloadingIds = updated;
			const ids = new Map(downloadTaskIds);
			ids.delete(track.id);
			downloadTaskIds = ids;
		}
	}
</script>

<div class={`grid gap-4 ${columnClass}`}>
	{#if displayedTracks.length === 0}
		<div class="col-span-full py-12 text-center text-gray-400">
			<p>No tracks available</p>
		</div>
	{:else}
		{#each displayedTracks as track, index (track.id)}
			<div
				role="button"
				tabindex="0"
				onclick={() => handlePlayTrack(track, index)}
				onkeydown={(event) => handleCardKeydown(event, track, index)}
				class="top-track-card group flex h-full cursor-pointer flex-col gap-4 rounded-xl p-4 focus:outline-none"
			>
				<div class="flex items-start gap-4">
					<button
						onclick={(event) => {
							event.stopPropagation();
							handlePlayTrack(track, index);
						}}
						class="top-track-play flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full transition-transform hover:scale-110"
						aria-label={isPlaying(track) ? 'Pause' : 'Play'}
					>
						{#if isPlaying(track)}
							<Pause size={18} class="text-rose-300" />
						{:else if isCurrentTrack(track)}
							<Play size={18} class="text-rose-300" />
						{:else}
							<span class="text-sm font-semibold text-gray-300">{index + 1}</span>
						{/if}
					</button>

					{#if track.album?.cover}
						<img
							src={losslessAPI.getCoverUrl(track.album.cover, '320')}
							alt={track.title}
							loading="lazy"
							decoding="async"
							class="h-20 w-20 flex-shrink-0 rounded-lg object-cover shadow-lg"
						/>
					{/if}

					<div class="min-w-0 flex-1">
						<h3
							class="truncate text-lg font-semibold {isCurrentTrack(track)
								? 'text-rose-300'
								: 'text-white group-hover:text-rose-300'}"
						>
							{track.title}
							{#if track.explicit}
								<span class="ml-1 text-xs text-gray-500">[E]</span>
							{/if}
						</h3>
						<div class="mt-1 space-y-1 text-sm text-gray-400">
							<p class="truncate">{formatArtists(track.artists)}</p>
							{#if track.album}
								<p class="truncate text-xs text-gray-500">{track.album.title}</p>
							{/if}
						</div>
						{#if getDisplayTags(track.mediaMetadata?.tags).length > 0}
							<p class="mt-2 text-xs text-gray-500">
								{getDisplayTags(track.mediaMetadata?.tags).join(', ')}
							</p>
						{/if}
					</div>
				</div>

				<div
					class="mt-auto flex flex-wrap items-center justify-between gap-3 text-sm text-gray-400"
				>
					<div class="flex items-center gap-2">
						<button
							onclick={(event) => handlePlayNext(track, event)}
							class="top-track-action rounded-full p-2 transition-colors"
							title="Play next"
							aria-label={`Play ${track.title} next`}
						>
							<ListPlus size={18} />
						</button>
						<button
							onclick={(event) => handleAddToQueue(track, event)}
							class="top-track-action rounded-full p-2 transition-colors"
							title="Add to queue"
							aria-label={`Add ${track.title} to queue`}
						>
							<Plus size={18} />
						</button>
						<button
							onclick={(event) =>
								downloadingIds.has(track.id)
									? handleCancelDownload(track.id, event)
									: handleDownload(track, event)}
							class="top-track-action rounded-full p-2 transition-colors"
							title={downloadingIds.has(track.id) ? 'Cancel download' : 'Download track'}
							aria-label={downloadingIds.has(track.id) ? 'Cancel download' : 'Download track'}
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
						<ShareButton
							type="track"
							id={track.id}
							open={openShareId === track.id}
							iconOnly
							size={18}
							title="Share track"
							compact
							variant="custom"
							buttonClass="top-track-action rounded-full p-2"
							on:toggle={(event) => {
								openShareId = event.detail.open ? track.id : null;
							}}
						/>
					</div>
					<div class="flex items-center gap-1 text-xs text-gray-400">
						<Clock size={14} />
						<span>{losslessAPI.formatDuration(track.duration)}</span>
					</div>
				</div>
			</div>
		{/each}
	{/if}
</div>

<style>
	.top-track-card {
		border: 1px solid rgba(255, 255, 255, 0.12);
		background: rgba(18, 10, 16, 0.55);
		backdrop-filter: blur(var(--perf-blur-medium, 22px)) saturate(var(--perf-saturate, 160%));
		-webkit-backdrop-filter: blur(var(--perf-blur-medium, 22px))
			saturate(var(--perf-saturate, 160%));
		box-shadow:
			0 12px 28px rgba(3, 8, 18, 0.4),
			inset 0 1px 0 rgba(255, 255, 255, 0.05);
		transition:
			border-color 180ms ease,
			box-shadow 200ms ease,
			transform 200ms ease,
			background 200ms ease;
	}

	.top-track-card:hover {
		border-color: rgba(239, 68, 68, 0.45);
		background: rgba(20, 10, 16, 0.65);
		box-shadow:
			0 14px 32px rgba(3, 8, 18, 0.45),
			inset 0 0 18px rgba(239, 68, 68, 0.08);
		transform: translateY(-2px);
	}

	.top-track-card:focus-visible {
		box-shadow:
			0 0 0 2px rgba(239, 68, 68, 0.35),
			0 12px 28px rgba(3, 8, 18, 0.4);
	}

	.top-track-play {
		background: rgba(12, 6, 10, 0.85);
		border: 1px solid rgba(255, 255, 255, 0.12);
	}

	:global(.top-track-action) {
		color: rgba(226, 232, 240, 0.78);
		background: transparent;
	}

	:global(.top-track-action:hover) {
		background: rgba(239, 68, 68, 0.15);
		color: rgba(254, 226, 226, 0.95);
	}
</style>
