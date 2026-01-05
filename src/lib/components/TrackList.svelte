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
	import { Play, Pause, Download, Clock, X } from 'lucide-svelte';

	interface Props {
		tracks: Track[];
		showAlbum?: boolean;
		showArtist?: boolean;
		showCover?: boolean;
	}

	let { tracks, showAlbum = true, showArtist = true, showCover = true }: Props = $props();
	let downloadingIds = $state(new Set<number>());
	let downloadTaskIds = $state(new Map<number, string>());
	let cancelledIds = $state(new Set<number>());
	let openShareId = $state<number | null>(null);
	const IGNORED_TAGS = new Set(['HI_RES_LOSSLESS']);
	const convertAacToMp3Preference = $derived($userPreferencesStore.convertAacToMp3);
	const downloadCoverSeperatelyPreference = $derived($userPreferencesStore.downloadCoversSeperately);

	$effect(() => {
		if (tracks.length === 0) {
			return;
		}
		prefetchStreamUrls(tracks, $playerStore.quality, 25);
	});

	function getDisplayTags(tags?: string[] | null): string[] {
		if (!tags) return [];
		return tags.filter((tag) => tag && !IGNORED_TAGS.has(tag));
	}

	function handlePlayTrack(track: Track, index: number) {
		playerStore.playQueue(tracks, index);
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
		const nextTasks = new Map(downloadTaskIds);
		nextTasks.delete(trackId);
		downloadTaskIds = nextTasks;
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
			subtitle: showAlbum ? (track.album?.title ?? track.artist?.name) : track.artist?.name
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

	function isCurrentTrack(track: Track): boolean {
		return $playerStore.currentTrack?.id === track.id;
	}

	function isPlaying(track: Track): boolean {
		return isCurrentTrack(track) && $playerStore.isPlaying;
	}
</script>

<div class="w-full">
	{#if tracks.length === 0}
		<div class="py-12 text-center text-gray-400">
			<p>No tracks available</p>
		</div>
	{:else}
		<div class="space-y-1">
			{#each tracks as track, index (track.id)}
				<div
					class="track-glass group flex w-full flex-col gap-2 rounded-lg p-3 text-left transition-colors sm:flex-row sm:items-center sm:gap-3 {isCurrentTrack(track) ? 'is-active' : 'hover:brightness-110'} {openShareId === track.id ? 'is-share-open' : ''}"
				>
					<div class="flex w-full min-w-0 items-center gap-3">
						<!-- Track Number / Play Button -->
						<button
							onclick={() => handlePlayTrack(track, index)}
							class="flex w-7 flex-shrink-0 items-center justify-center transition-transform hover:scale-110 sm:w-8"
							aria-label={isPlaying(track) ? 'Pause' : 'Play'}
						>
							{#if isPlaying(track)}
								<Pause size={16} class="track-accent" />
							{:else}
								<Play size={16} class="text-white" />
							{/if}
						</button>

						<!-- Cover -->
						{#if showCover && track.album.cover}
							<img
								src={losslessAPI.getCoverUrl(track.album.cover, '320')}
								alt={track.title}
								loading="lazy"
								decoding="async"
								class="h-14 w-14 flex-shrink-0 rounded object-cover sm:h-16 sm:w-16"
							/>
						{/if}

						<!-- Track Info -->
						<div class="min-w-0 flex-1">
							<button
								onclick={() => handlePlayTrack(track, index)}
								class="track-title w-full truncate text-left text-sm font-medium sm:text-base {isCurrentTrack(track) ? 'is-active' : ''}"
							>
								{track.title}
								{#if track.explicit}
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
										></path></svg
									>
								{/if}
							</button>
							<div class="flex flex-wrap items-center gap-1 text-xs text-gray-400 sm:text-sm sm:gap-2">
								{#if showArtist}
									<span class="truncate">{formatArtists(track.artists)}</span>
								{/if}
								{#if showAlbum && showArtist}
									<span>-</span>
								{/if}
								{#if showAlbum}
									<span class="truncate">{track.album.title}</span>
								{/if}
							</div>
							<div class="mt-0.5 text-xs text-gray-500">
								{#if getDisplayTags(track.mediaMetadata?.tags).length > 0}
									- {getDisplayTags(track.mediaMetadata?.tags).join(', ')}
								{/if}
							</div>
						</div>
					</div>

					<!-- Actions -->
					<div class="flex w-full flex-wrap items-center justify-between gap-2 sm:w-auto sm:flex-nowrap sm:justify-end">
						<!-- Duration -->
						<div class="flex w-14 items-center justify-center gap-1 text-xs text-gray-400 sm:w-16 sm:text-sm">
							<Clock size={14} />
							{losslessAPI.formatDuration(track.duration)}
						</div>

						<div class="track-share flex w-14 items-center justify-center text-gray-400 hover:text-white sm:w-16">
							<ShareButton
								type="track"
								id={track.id}
								open={openShareId === track.id}
								iconOnly
								size={18}
								title="Share track"
								on:toggle={(event) => {
									openShareId = event.detail.open ? track.id : null;
								}}
							/>
						</div>

						<button
							onclick={(e) =>
								downloadingIds.has(track.id)
									? handleCancelDownload(track.id, e)
									: handleDownload(track, e)}
							class="p-1.5 text-gray-400 transition-colors hover:text-white sm:p-2"
							aria-label={downloadingIds.has(track.id) ? 'Cancel download' : 'Download track'}
							title={downloadingIds.has(track.id) ? 'Cancel download' : 'Download track'}
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

					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.track-glass {
		position: relative;
		background: var(--surface-color, rgba(18, 10, 16, 0.55));
		border: 1px solid rgba(255, 255, 255, 0.1);
		backdrop-filter: blur(var(--perf-blur-medium, 24px)) saturate(var(--perf-saturate, 150%));
		-webkit-backdrop-filter: blur(var(--perf-blur-medium, 24px))
			saturate(var(--perf-saturate, 150%));
		overflow: visible;
		box-shadow: 
			0 6px 16px rgba(2, 6, 23, 0.3),
			inset 0 1px 0 rgba(255, 255, 255, 0.04);
		transition: 
			background 1.2s cubic-bezier(0.4, 0, 0.2, 1),
			border-color 1.2s cubic-bezier(0.4, 0, 0.2, 1),
			box-shadow 0.3s ease,
			filter 0.2s ease;
	}

	.track-glass.is-active {
		background: rgba(239, 68, 68, 0.12);
		border-color: rgba(239, 68, 68, 0.45);
		box-shadow:
			0 8px 18px rgba(2, 6, 23, 0.35),
			inset 0 0 18px rgba(239, 68, 68, 0.12);
	}

	.track-glass.is-share-open {
		z-index: 9999;
	}

	.track-title {
		color: rgba(248, 250, 252, 0.92);
		transition: color 180ms ease;
	}

	.track-title.is-active {
		color: rgba(254, 202, 202, 0.98);
	}

	.track-glass:hover .track-title {
		color: rgba(254, 226, 226, 0.95);
	}

	:global(.track-accent) {
		color: rgba(239, 68, 68, 0.95);
	}

	.track-share {
		position: relative;
		z-index: 200;
	}

</style>
