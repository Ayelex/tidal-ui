<script lang="ts">
	import { onMount } from 'svelte';
	import { playerStore } from '$lib/stores/player';
	import { lyricsStore } from '$lib/stores/lyrics';
	import { losslessAPI, type TrackDownloadProgress } from '$lib/api';
	import { downloadUiStore, ffmpegBanner, activeTrackDownloads } from '$lib/stores/downloadUi';
	import { userPreferencesStore } from '$lib/stores/userPreferences';
	import { libraryStore } from '$lib/stores/library';
	import { buildTrackFilename } from '$lib/downloads';
	import { formatArtists } from '$lib/utils';
	import type { Track, PlayableTrack } from '$lib/types';
	import { isSonglinkTrack } from '$lib/types';
	import { slide } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import {
		Play,
		Pause,
		SkipForward,
		SkipBack,
		Volume2,
		VolumeX,
		ListMusic,
		Trash2,
		X,
		Shuffle,
		ScrollText,
		Download,
		LoaderCircle,
		Heart,
		Repeat,
		Repeat1,
		ChevronDown,
		ChevronUp
	} from 'lucide-svelte';

	const { onHeightChange = () => {}, headless = false } = $props<{
		onHeightChange?: (height: number) => void;
		headless?: boolean;
	}>();

	let containerElement = $state<HTMLDivElement | null>(null);
	let resizeObserver: ResizeObserver | null = null;
	let showQueuePanel = $state(false);
	let isMinimized = $state(false);
	let previousVolume = 0.8;
	let isDownloadingCurrentTrack = $state(false);
	let downloadTaskIdForCurrentTrack: string | null = null;
	let isCurrentTrackLiked = $state(false);
	let canToggleLike = $state(false);
	let seekBarElement = $state<HTMLButtonElement | null>(null);
	let isScrubbing = false;

	const repeatModeLabel = $derived(
		$playerStore.repeatMode === 'one'
			? 'Repeat one'
			: $playerStore.repeatMode === 'all'
				? 'Repeat'
				: 'Repeat off'
	);

	const canSkipNext = $derived(
		$playerStore.queue.length > 1 &&
			($playerStore.shuffleEnabled ||
				$playerStore.repeatMode === 'all' ||
				$playerStore.queueIndex < $playerStore.queue.length - 1)
	);

	const currentPlaybackQuality = $derived($playerStore.activeQuality);
	const shuffleEnabled = $derived($playerStore.shuffleEnabled);
	const sampleRateLabel = $derived(formatSampleRate($playerStore.sampleRate));
	const bitDepthLabel = $derived(formatBitDepth($playerStore.bitDepth));
	const bufferedPercent = $derived($playerStore.bufferedPercent);
	const isMuted = $derived($playerStore.muted);
	const showAutoplayPrompt = $derived($playerStore.needsGesture);

	$effect(() => {
		if (showQueuePanel && $playerStore.queue.length === 0) {
			showQueuePanel = false;
		}
	});

	$effect(() => {
		const current = $playerStore.currentTrack;
		if (!current || isSonglinkTrack(current)) {
			isCurrentTrackLiked = false;
			canToggleLike = false;
			return;
		}
		canToggleLike = true;
		isCurrentTrackLiked = $libraryStore.likedTracks.some((item) => item.id === current.id);
	});

	function toggleMinimized() {
		isMinimized = !isMinimized;
		onHeightChange(containerElement?.offsetHeight ?? 0);
	}

	function toggleQueuePanel() {
		showQueuePanel = !showQueuePanel;
	}

	function closeQueuePanel() {
		showQueuePanel = false;
	}

	function playFromQueue(index: number) {
		playerStore.playAtIndex(index, true);
	}

	function removeFromQueue(index: number, event?: MouseEvent) {
		if (event) {
			event.stopPropagation();
		}
		playerStore.removeFromQueue(index);
	}

	function clearQueue() {
		playerStore.clearQueue();
	}

	function handleShuffleQueue() {
		playerStore.toggleShuffle();
	}

	function toggleRepeatMode() {
		playerStore.cycleRepeatMode();
	}

	function toggleCurrentTrackLike() {
		const current = $playerStore.currentTrack;
		if (!current || isSonglinkTrack(current)) return;
		libraryStore.toggleLikedTrack(asTrack(current));
	}

	function handlePrevious() {
		playerStore.previous();
	}

	function handleNextClick() {
		playerStore.next();
	}

	function handleAutoplayPrompt() {
		playerStore.play();
	}

	function handleVolumeChange(event: Event) {
		const target = event.target as HTMLInputElement;
		const newVolume = parseFloat(target.value);
		playerStore.setVolume(newVolume);
		if (newVolume > 0 && $playerStore.muted) {
			playerStore.setMuted(false);
		}
	}

	function toggleMute() {
		if ($playerStore.muted) {
			playerStore.setMuted(false);
			if ($playerStore.volume === 0) {
				playerStore.setVolume(previousVolume || 0.8);
			}
			return;
		}
		previousVolume = $playerStore.volume || 0.8;
		playerStore.setMuted(true);
	}

	function getPercent(current: number, total: number): number {
		if (!Number.isFinite(total) || total <= 0) {
			return 0;
		}
		return Math.max(0, Math.min(100, (current / total) * 100));
	}

	function resolveSeekDuration(): number {
		const duration = $playerStore.duration;
		if (Number.isFinite(duration) && duration > 0) {
			return duration;
		}
		return 0;
	}

	function handleSeek(event: MouseEvent | TouchEvent) {
		if (!seekBarElement) return;
		const rect = seekBarElement.getBoundingClientRect();
		if (rect.width <= 0) {
			return;
		}
		const clientX = 'touches' in event ? event.touches[0].clientX : event.clientX;
		const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
		const duration = resolveSeekDuration();
		if (duration <= 0) {
			return;
		}
		playerStore.seekTo(percent * duration);
	}

	function handleSeekStart(event: MouseEvent | TouchEvent) {
		event.preventDefault();
		event.stopPropagation();
		isScrubbing = true;
		handleSeek(event);

		const handleMove = (e: MouseEvent | TouchEvent) => {
			if (isScrubbing) {
				handleSeek(e);
			}
		};

		const handleEnd = () => {
			isScrubbing = false;
			document.removeEventListener('mousemove', handleMove as EventListener);
			document.removeEventListener('mouseup', handleEnd);
			document.removeEventListener('touchmove', handleMove as EventListener);
			document.removeEventListener('touchend', handleEnd);
		};

		document.addEventListener('mousemove', handleMove as EventListener);
		document.addEventListener('mouseup', handleEnd);
		document.addEventListener('touchmove', handleMove as EventListener);
		document.addEventListener('touchend', handleEnd);
	}

	function setTapState(event: PointerEvent, active: boolean) {
		const target = event.currentTarget as HTMLElement | null;
		if (!target) {
			return;
		}
		if (active) {
			target.classList.add('is-tapping');
		} else {
			target.classList.remove('is-tapping');
			target.blur();
		}
	}

	async function handleDownloadCurrentTrack() {
		const track = $playerStore.currentTrack;
		if (!track || isDownloadingCurrentTrack || isSonglinkTrack(track)) {
			return;
		}

		const quality = $playerStore.quality;
		const convertAacToMp3 = $userPreferencesStore.convertAacToMp3;
		const downloadCoverSeperately = $userPreferencesStore.downloadCoversSeperately;
		const filename = buildTrackFilename(
			track.album,
			track,
			quality,
			formatArtists(track.artists),
			convertAacToMp3
		);

		const { taskId, controller } = downloadUiStore.beginTrackDownload(track, filename, {
			subtitle: track.album?.title ?? track.artist?.name
		});

		downloadTaskIdForCurrentTrack = taskId;
		isDownloadingCurrentTrack = true;
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
				convertAacToMp3,
				downloadCoverSeperately
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
			isDownloadingCurrentTrack = false;
			downloadTaskIdForCurrentTrack = null;
		}
	}

	function formatTime(seconds: number): string {
		if (isNaN(seconds)) return '0:00';
		const mins = Math.floor(seconds / 60);
		const secs = Math.floor(seconds % 60);
		return `${mins}:${secs.toString().padStart(2, '0')}`;
	}

	function marqueeOverflow(node: HTMLElement) {
		const text = node.querySelector<HTMLElement>('.marquee__single');
		if (!text) {
			return;
		}
		const update = () => {
			const shouldScroll = text.scrollWidth > node.clientWidth + 2;
			node.dataset.marquee = shouldScroll ? 'true' : 'false';
		};
		const observer = new ResizeObserver(update);
		observer.observe(node);
		observer.observe(text);
		update();
		return {
			destroy() {
				observer.disconnect();
			}
		};
	}

	function formatQualityLabel(quality?: string): string {
		if (!quality) return 'Unknown';
		const normalized = quality.toUpperCase();
		if (normalized === 'LOSSLESS') {
			return 'CD';
		}
		if (normalized === 'HI_RES_LOSSLESS') {
			return 'Hi-Res';
		}
		return quality;
	}

	function formatSampleRate(value?: number | null): string | null {
		if (!Number.isFinite(value ?? NaN) || !value || value <= 0) {
			return null;
		}
		const kilohertz = value / 1000;
		const precision =
			kilohertz >= 100 || Math.abs(kilohertz - Math.round(kilohertz)) < 0.05 ? 0 : 1;
		const formatted = kilohertz.toFixed(precision).replace(/\.0$/, '');
		return `${formatted} kHz`;
	}

	function formatBitDepth(value?: number | null): string | null {
		if (!Number.isFinite(value ?? NaN) || !value || value <= 0) {
			return null;
		}
		return `${value}-bit`;
	}

	function formatMegabytes(bytes?: number | null): string | null {
		if (!Number.isFinite(bytes ?? NaN) || !bytes || bytes <= 0) {
			return null;
		}
		const value = bytes / (1024 * 1024);
		const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
		return `${value.toFixed(digits)} MB`;
	}

	function formatPercent(value: number | null | undefined): string {
		if (!Number.isFinite(value ?? NaN)) {
			return '0%';
		}
		const percent = Math.max(0, Math.min(100, Math.round((value ?? 0) * 100)));
		return `${percent}%`;
	}

	function formatTransferStatus(received: number, total?: number): string {
		const receivedLabel = formatMegabytes(received) ?? '0 MB';
		const totalLabel = formatMegabytes(total) ?? null;
		return totalLabel ? `${receivedLabel} / ${totalLabel}` : receivedLabel;
	}

	$effect(() => {
		if ($ffmpegBanner.phase === 'ready') {
			const timeout = setTimeout(() => {
				downloadUiStore.dismissFfmpeg();
			}, 3200);
			return () => clearTimeout(timeout);
		}
	});

	onMount(() => {
		if (containerElement) {
			notifyContainerHeight();
			resizeObserver = new ResizeObserver(() => {
				notifyContainerHeight();
			});
			resizeObserver.observe(containerElement);
		}

		return () => {
			resizeObserver?.disconnect();
		};
	});

	function notifyContainerHeight() {
		if (typeof onHeightChange === 'function' && containerElement) {
			const height = containerElement.offsetHeight ?? 0;
			onHeightChange(height);
			if (typeof document !== 'undefined') {
				document.documentElement.style.setProperty('--player-height', `${height}px`);
			}
		}
	}

	function asTrack(track: PlayableTrack): Track {
		return track as Track;
	}
</script>





{#if !headless}
<div
	class="audio-player-backdrop fixed inset-x-0 bottom-0 z-50 px-4 pt-16 pb-5 sm:px-6 sm:pt-16 sm:pb-6"
	bind:this={containerElement}
>
	<div class="relative mx-auto w-full max-w-screen-2xl">
		{#if $ffmpegBanner.phase !== 'idle' || $activeTrackDownloads.length > 0}
			<div
				class="pointer-events-none absolute top-0 right-0 left-0 -translate-y-full transform pb-4"
			>
				<div class="mx-auto flex w-full max-w-2xl flex-col gap-2 px-4">
					{#if $ffmpegBanner.phase !== 'idle'}
						<div
							class="ffmpeg-banner pointer-events-auto rounded-2xl border px-4 py-3 text-sm text-rose-100 shadow-xl"
						>
							<div class="flex items-start gap-3">
								<div class="min-w-0 flex-1">
									<p class="leading-5 font-semibold text-rose-50">
										Downloading FFmpeg
										{#if formatMegabytes($ffmpegBanner.totalBytes)}
											<span class="text-rose-100/80">
												({formatMegabytes($ffmpegBanner.totalBytes)})</span
											>
										{/if}
									</p>
									{#if $ffmpegBanner.phase === 'countdown'}
										<p class="mt-1 text-xs text-rose-100/80">
											Starting in {$ffmpegBanner.countdownSeconds} seconds...
										</p>
									{:else if $ffmpegBanner.phase === 'loading'}
										<p class="mt-1 text-xs text-rose-100/80">
											Preparing encoder... {formatPercent($ffmpegBanner.progress)}
										</p>
									{:else if $ffmpegBanner.phase === 'ready'}
										<p class="mt-1 text-xs text-rose-100/80">FFmpeg is ready to use.</p>
									{:else if $ffmpegBanner.phase === 'error'}
										<p class="mt-1 text-xs text-red-200">
											{$ffmpegBanner.error ?? 'Failed to load FFmpeg.'}
										</p>
									{/if}
								</div>
								{#if $ffmpegBanner.dismissible}
									<button
										onclick={() => downloadUiStore.dismissFfmpeg()}
										class="rounded-full p-1 text-rose-100/70 transition-colors hover:bg-rose-500/20 hover:text-rose-50"
										aria-label="Dismiss FFmpeg download"
									>
										<X size={16} />
									</button>
								{/if}
							</div>
							{#if $ffmpegBanner.phase === 'loading'}
								<div class="mt-3 h-1.5 overflow-hidden rounded-full bg-rose-500/20">
									<div
										class="h-full rounded-full bg-rose-400 transition-all duration-200"
										style="width: {Math.min(Math.max($ffmpegBanner.progress * 100, 6), 100)}%"
									></div>
								</div>
							{/if}
						</div>
					{/if}

					{#each $activeTrackDownloads as task (task.id)}
						<div
							class="download-popup pointer-events-auto rounded-2xl border px-4 py-3 text-sm text-gray-100 shadow-xl"
						>
							<div class="flex items-start gap-3">
								<div class="flex min-w-0 flex-1 flex-col gap-1">
									<p class="flex items-center gap-2 text-sm font-semibold text-gray-50">
										{#if task.progress < 0.02}
											<LoaderCircle size={16} class="animate-spin text-rose-300" />
										{:else}
											<Download size={16} class="text-rose-300" />
										{/if}
										<span class="truncate">{task.title}</span>
									</p>
									{#if task.subtitle}
										<p class="truncate text-xs text-gray-400">{task.subtitle}</p>
									{/if}
									<div class="flex flex-wrap items-center gap-2 text-xs text-gray-400">
										<span>{formatTransferStatus(task.receivedBytes, task.totalBytes)}</span>
										<span aria-hidden="true">-</span>
										<span>{formatPercent(task.progress)}</span>
									</div>
								</div>
								<button
									onclick={() =>
										task.cancellable
											? downloadUiStore.cancelTrackDownload(task.id)
											: downloadUiStore.dismissTrackTask(task.id)}
									class="rounded-full p-1 text-gray-400 transition-colors hover:bg-gray-800 hover:text-white"
									aria-label={task.cancellable
										? `Cancel download for ${task.title}`
										: `Dismiss download for ${task.title}`}
								>
									<X size={16} />
								</button>
							</div>
							<div class="mt-3 h-1.5 overflow-hidden rounded-full bg-gray-800">
								<div
									class="h-full rounded-full bg-rose-500 transition-all duration-200"
									style="width: {Math.min(Math.max(task.progress * 100, 4), 100)}%"
								></div>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}
		<div class="audio-player-glass overflow-hidden rounded-2xl border shadow-2xl">
			<div class="relative px-4 py-3">
				<button
					onclick={toggleMinimized}
					class={`player-minimize-button ${isMinimized ? 'player-minimize-button--mini' : 'player-minimize-button--full'}`}
					type="button"
					aria-label={isMinimized ? 'Expand player' : 'Minimize player'}
				>
					{#if isMinimized}
						<ChevronUp size={16} />
					{:else}
						<ChevronDown size={16} />
					{/if}
				</button>
				{#if $playerStore.currentTrack}
					{#if isMinimized}
						<div class="player-mini">
							{#if $playerStore.currentTrack}
								<div class="player-mini__meta">
									<p class="player-mini__title marquee text-sm font-semibold text-white" use:marqueeOverflow>
										<span class="marquee__track">
											<span class="marquee__single">
												{$playerStore.currentTrack.title}
											</span>
											<span class="marquee__single marquee__clone" aria-hidden="true">
												{$playerStore.currentTrack.title}
											</span>
										</span>
									</p>
									<p class="player-mini__artist marquee text-xs text-gray-400" use:marqueeOverflow>
										<span class="marquee__track">
											<span class="marquee__single">
												{isSonglinkTrack($playerStore.currentTrack)
													? $playerStore.currentTrack.artistName
													: formatArtists(asTrack($playerStore.currentTrack).artists)}
											</span>
											<span class="marquee__single marquee__clone" aria-hidden="true">
												{isSonglinkTrack($playerStore.currentTrack)
													? $playerStore.currentTrack.artistName
													: formatArtists(asTrack($playerStore.currentTrack).artists)}
											</span>
										</span>
									</p>
								</div>
							{/if}
							<div class="player-mini__controls">
								<button
									onclick={handlePrevious}
									class="player-mini__control-button"
									aria-label="Previous track"
									onpointerdown={(event) => setTapState(event, true)}
									onpointerup={(event) => setTapState(event, false)}
									onpointercancel={(event) => setTapState(event, false)}
									onpointerleave={(event) => setTapState(event, false)}
								>
									<SkipBack size={16} />
								</button>
								<button
									onclick={() => playerStore.togglePlay()}
									class="player-mini__play"
									aria-label={$playerStore.isPlaying ? 'Pause' : 'Play'}
								>
									{#if $playerStore.isPlaying}
										<Pause size={18} fill="currentColor" />
									{:else}
										<Play size={18} fill="currentColor" />
									{/if}
								</button>
								<button
									onclick={handleNextClick}
									class="player-mini__control-button"
									aria-label="Next track"
									onpointerdown={(event) => setTapState(event, true)}
									onpointerup={(event) => setTapState(event, false)}
									onpointercancel={(event) => setTapState(event, false)}
									onpointerleave={(event) => setTapState(event, false)}
								>
									<SkipForward size={16} />
								</button>
							</div>
						</div>
					{:else}
						<!-- Progress Bar -->
						<div class="mb-3">
							<button
								bind:this={seekBarElement}
								onmousedown={handleSeekStart}
								ontouchstart={handleSeekStart}
								class="group relative h-1 w-full cursor-pointer overflow-hidden rounded-full bg-gray-700"
								type="button"
								aria-label="Seek position"
							>
								<div
									class="pointer-events-none absolute inset-y-0 left-0 bg-rose-400/30 transition-all"
									style="width: {bufferedPercent}%"
									aria-hidden="true"
								></div>
								<div
									class="pointer-events-none absolute inset-y-0 left-0 bg-rose-500 transition-all"
									style="width: {getPercent($playerStore.currentTime, $playerStore.duration)}%"
									aria-hidden="true"
								></div>
								<div
									class="pointer-events-none absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-rose-500 opacity-0 transition-opacity group-hover:opacity-100"
									style="left: {getPercent($playerStore.currentTime, $playerStore.duration)}%"
									aria-hidden="true"
								></div>
							</button>
							<div class="mt-1 flex justify-between text-xs text-gray-400">
								<span>{formatTime($playerStore.currentTime)}</span>
								<span>{formatTime($playerStore.duration)}</span>
							</div>
						</div>

						<div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
							<!-- Track Info -->
							{#if $playerStore.currentTrack}
								<div class="flex min-w-0 items-center gap-3 sm:flex-1">
									{#if !isSonglinkTrack($playerStore.currentTrack)}
										<!-- Only show album cover for regular tracks -->
										{#if asTrack($playerStore.currentTrack).album.videoCover}
											<video
												src={losslessAPI.getCoverUrl(asTrack($playerStore.currentTrack).album.videoCover!, '640')}
												autoplay
												loop
												muted
												playsinline
												class="h-16 w-16 flex-shrink-0 rounded-md object-cover"
											></video>
										{:else if asTrack($playerStore.currentTrack).album.cover}
											<img
												src={losslessAPI.getCoverUrl(asTrack($playerStore.currentTrack).album.cover!, '640')}
												alt={$playerStore.currentTrack.title}
												class="h-16 w-16 flex-shrink-0 rounded-md object-cover"
											/>
										{/if}
									{/if}
									<div class="min-w-0 flex-1">
										<h3 class="player-title marquee font-semibold text-white" use:marqueeOverflow>
											<span class="marquee__track">
												<span class="marquee__single">
													{$playerStore.currentTrack.title}{!isSonglinkTrack($playerStore.currentTrack) && asTrack($playerStore.currentTrack).version ? ` (${asTrack($playerStore.currentTrack).version})` : ''}
												</span>
												<span class="marquee__single marquee__clone" aria-hidden="true">
													{$playerStore.currentTrack.title}{!isSonglinkTrack($playerStore.currentTrack) && asTrack($playerStore.currentTrack).version ? ` (${asTrack($playerStore.currentTrack).version})` : ''}
												</span>
											</span>
										</h3>
										{#if isSonglinkTrack($playerStore.currentTrack)}
											<!-- Display for SonglinkTrack -->
											<p class="marquee text-sm text-gray-400" use:marqueeOverflow>
												<span class="marquee__track">
													<span class="marquee__single">
														{$playerStore.currentTrack.artistName}
													</span>
													<span class="marquee__single marquee__clone" aria-hidden="true">
														{$playerStore.currentTrack.artistName}
													</span>
												</span>
											</p>
										{:else}
											<!-- Display for regular Track -->
											<a
												href={`/artist/${asTrack($playerStore.currentTrack).artist.id}`}
												class="marquee text-sm text-gray-400 hover:text-rose-300 hover:underline inline-block"
												data-sveltekit-preload-data
												use:marqueeOverflow
											>
												<span class="marquee__track">
													<span class="marquee__single">
														{formatArtists(asTrack($playerStore.currentTrack).artists)}
													</span>
													<span class="marquee__single marquee__clone" aria-hidden="true">
														{formatArtists(asTrack($playerStore.currentTrack).artists)}
													</span>
												</span>
											</a>
											<p class="text-xs text-gray-500">
												<a
													href={`/album/${asTrack($playerStore.currentTrack).album.id}`}
													class="hover:text-rose-300 hover:underline"
													data-sveltekit-preload-data
												>
													{asTrack($playerStore.currentTrack).album.title}
												</a>
												{#if currentPlaybackQuality}
													<span class="mx-1" aria-hidden="true">-</span>
													<span>{formatQualityLabel(currentPlaybackQuality)}</span>
												{/if}
												{#if currentPlaybackQuality && asTrack($playerStore.currentTrack).audioQuality && currentPlaybackQuality !== asTrack($playerStore.currentTrack).audioQuality}
													<span class="mx-1 text-gray-600" aria-hidden="true">-</span>
													<span class="text-gray-500">
														({formatQualityLabel(asTrack($playerStore.currentTrack).audioQuality)} available)
													</span>
												{/if}
												{#if bitDepthLabel}
													<span class="mx-1 text-gray-600" aria-hidden="true">-</span>
													<span>{bitDepthLabel}</span>
												{/if}
												{#if sampleRateLabel}
													<span class="mx-1 text-gray-600" aria-hidden="true">-</span>
													<span>{sampleRateLabel}</span>
												{/if}
											</p>
										{/if}
									</div>
								</div>
							{/if}

						<div class="flex flex-col items-center gap-3 sm:gap-4 sm:flex-1">
							<!-- Primary Controls -->
							<div class="flex items-center justify-center gap-2 sm:gap-4">
								<button
									onclick={handleShuffleQueue}
									class={`p-2 sm:p-2.5 transition-colors hover:text-white disabled:opacity-50 ${
										shuffleEnabled
											? 'text-rose-300'
											: $playerStore.queue.length > 1
												? 'text-gray-400'
												: 'text-gray-600'
									}`}
									disabled={$playerStore.queue.length <= 1}
									aria-label="Shuffle queue"
									aria-pressed={shuffleEnabled}
								>
									<Shuffle size={20} class="sm:w-6 sm:h-6" />
								</button>
								<button
									onclick={handlePrevious}
									class="player-control-button p-2 sm:p-2.5 text-gray-400 transition-colors hover:text-white disabled:opacity-50"
									disabled={false}
									aria-label="Previous track"
									onpointerdown={(event) => setTapState(event, true)}
									onpointerup={(event) => setTapState(event, false)}
									onpointercancel={(event) => setTapState(event, false)}
									onpointerleave={(event) => setTapState(event, false)}
								>
									<SkipBack size={22} class="sm:w-7 sm:h-7" />
								</button>

								<button
									onclick={() => playerStore.togglePlay()}
									class="rounded-full bg-white p-3 sm:p-3.5 text-gray-900 transition-transform hover:scale-105"
									aria-label={$playerStore.isPlaying ? 'Pause' : 'Play'}
								>
									{#if $playerStore.isPlaying}
										<Pause size={22} class="sm:w-7 sm:h-7" fill="currentColor" />
									{:else}
										<Play size={22} class="sm:w-7 sm:h-7" fill="currentColor" />
									{/if}
								</button>

								<button
									onclick={handleNextClick}
									class="player-control-button p-2 sm:p-2.5 text-gray-400 transition-colors hover:text-white disabled:opacity-50"
									disabled={!canSkipNext}
									aria-label="Next track"
									onpointerdown={(event) => setTapState(event, true)}
									onpointerup={(event) => setTapState(event, false)}
									onpointercancel={(event) => setTapState(event, false)}
									onpointerleave={(event) => setTapState(event, false)}
								>
									<SkipForward size={22} class="sm:w-7 sm:h-7" />
								</button>
								<button
									onclick={toggleRepeatMode}
									class={`p-2 sm:p-2.5 transition-colors hover:text-white ${
										$playerStore.repeatMode === 'off' ? 'text-gray-400' : 'text-rose-300'
									}`}
									aria-label={repeatModeLabel}
									aria-pressed={$playerStore.repeatMode !== 'off'}
								>
									{#if $playerStore.repeatMode === 'one'}
										<Repeat1 size={20} class="sm:w-6 sm:h-6" />
									{:else}
										<Repeat size={20} class="sm:w-6 sm:h-6" />
									{/if}
								</button>
							</div>

							<!-- Secondary Controls -->
							<div class="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
								<button
									onclick={toggleCurrentTrackLike}
									class="player-toggle-button p-1.5 sm:p-2 {isCurrentTrackLiked
										? 'player-toggle-button--active'
										: ''}"
									aria-label={isCurrentTrackLiked
										? 'Remove from liked tracks'
										: 'Add to liked tracks'}
									aria-pressed={isCurrentTrackLiked}
									type="button"
									disabled={!canToggleLike}
								>
									<Heart
										size={16}
										class="sm:w-[18px] sm:h-[18px] {isCurrentTrackLiked
											? 'text-rose-300'
											: ''}"
										fill={isCurrentTrackLiked ? 'currentColor' : 'none'}
									/>
									<span class="hidden sm:inline">{isCurrentTrackLiked ? 'Liked' : 'Like'}</span>
								</button>
								<button
									onclick={handleDownloadCurrentTrack}
									class="player-toggle-button p-1.5 sm:p-2"
									aria-label="Download current track"
									type="button"
									disabled={!$playerStore.currentTrack || isDownloadingCurrentTrack}
								>
									{#if isDownloadingCurrentTrack}
										<LoaderCircle size={16} class="sm:w-[18px] sm:h-[18px] animate-spin" />
									{:else}
										<Download size={16} class="sm:w-[18px] sm:h-[18px]" />
									{/if}
									<span class="hidden sm:inline">Download</span>
								</button>
								<button
									onclick={() => lyricsStore.toggle()}
									class="player-toggle-button p-1.5 sm:p-2 {$lyricsStore.open
										? 'player-toggle-button--active'
										: ''}"
									aria-label={$lyricsStore.open ? 'Hide lyrics popup' : 'Show lyrics popup'}
									aria-expanded={$lyricsStore.open}
									type="button"
								>
									<ScrollText size={16} class="sm:w-[18px] sm:h-[18px]" />
									<span class="hidden sm:inline">Lyrics</span>
								</button>
								<button
									onclick={toggleQueuePanel}
									class="player-toggle-button p-1.5 sm:p-2 {showQueuePanel
										? 'player-toggle-button--active'
										: ''}"
									aria-label="Toggle queue panel"
									aria-expanded={showQueuePanel}
									type="button"
								>
									<ListMusic size={16} class="sm:w-[18px] sm:h-[18px]" />
									<span class="hidden sm:inline">Queue ({$playerStore.queue.length})</span>
								</button>
							</div>

							{#if showAutoplayPrompt}
								<button
									onclick={handleAutoplayPrompt}
									class="rounded-full border border-rose-400/60 bg-rose-500/10 px-4 py-1 text-xs font-semibold tracking-wide text-rose-100 transition hover:bg-rose-500/20"
									type="button"
								>
									Tap to continue playback
								</button>
							{/if}

							<!-- Volume Control -->
							<div class="hidden sm:flex items-center gap-2">
								<button
									onclick={toggleMute}
									class="p-2 text-gray-400 transition-colors hover:text-white"
									aria-label={isMuted ? 'Unmute' : 'Mute'}
								>
									{#if isMuted || $playerStore.volume === 0}
										<VolumeX size={20} />
									{:else}
										<Volume2 size={20} />
									{/if}
								</button>
								<input
									type="range"
									min="0"
									max="1"
									step="0.01"
									value={$playerStore.volume}
									oninput={handleVolumeChange}
									class="h-1 w-24 cursor-pointer appearance-none rounded-lg bg-gray-700 accent-white"
									aria-label="Volume"
								/>
							</div>
							</div>
						</div>
					{/if}

					{#if showQueuePanel}
						<div
							class="queue-panel mt-4 space-y-3 rounded-2xl border p-4 text-sm shadow-inner"
							transition:slide={{ duration: 220, easing: cubicOut }}
						>
							<div class="flex items-center justify-between gap-2">
								<div class="flex items-center gap-2 text-gray-300">
									<ListMusic size={18} />
									<span class="font-medium">Playback Queue</span>
									<span class="rounded-full bg-gray-800 px-2 py-0.5 text-xs text-gray-400">
										{$playerStore.queue.length}
									</span>
								</div>
								<div class="flex items-center gap-2">
									<button
										onclick={handleShuffleQueue}
										class={`flex items-center gap-1 rounded-full border px-3 py-1 text-xs tracking-wide uppercase transition-colors disabled:opacity-40 ${
											shuffleEnabled
												? 'border-rose-500 bg-rose-500/10 text-rose-200'
												: 'border-transparent text-gray-400 hover:border-rose-500 hover:text-rose-200'
										}`}
										type="button"
										disabled={$playerStore.queue.length <= 1}
										aria-pressed={shuffleEnabled}
									>
										<Shuffle size={14} />
										Shuffle
									</button>
									<button
										onclick={toggleRepeatMode}
										class={`flex items-center gap-1 rounded-full border px-3 py-1 text-xs tracking-wide uppercase transition-colors ${
											$playerStore.repeatMode === 'off'
												? 'border-transparent text-gray-400 hover:border-rose-500 hover:text-rose-200'
												: 'border-rose-500 bg-rose-500/10 text-rose-200'
										}`}
										type="button"
										aria-label={repeatModeLabel}
										aria-pressed={$playerStore.repeatMode !== 'off'}
									>
										{#if $playerStore.repeatMode === 'one'}
											<Repeat1 size={14} />
											Repeat 1
										{:else if $playerStore.repeatMode === 'all'}
											<Repeat size={14} />
											Repeat
										{:else}
											<Repeat size={14} />
											Off
										{/if}
									</button>
									<button
										onclick={clearQueue}
										class="flex items-center gap-1 rounded-full border border-transparent px-3 py-1 text-xs tracking-wide text-gray-400 uppercase transition-colors hover:border-red-500 hover:text-red-400"
										type="button"
										disabled={$playerStore.queue.length === 0}
									>
										<Trash2 size={14} />
										Clear
									</button>
									<button
										onclick={closeQueuePanel}
										class="rounded-full p-1 text-gray-400 transition-colors hover:text-white"
										aria-label="Close queue panel"
									>
										<X size={16} />
									</button>
								</div>
							</div>

							{#if $playerStore.queue.length > 0}
								<ul class="max-h-60 space-y-2 overflow-y-auto pr-1">
									{#each $playerStore.queue as queuedTrack, index}
										<li>
											<div
												onclick={() => playFromQueue(index)}
												onkeydown={(event) => {
													if (event.key === 'Enter' || event.key === ' ') {
														event.preventDefault();
														playFromQueue(index);
													}
												}}
												tabindex="0"
												role="button"
												class="group flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors {index ===
												$playerStore.queueIndex
													? 'bg-rose-500/10 text-white'
													: 'text-gray-200 hover:bg-gray-800/70'}"
											>
												<span
													class="w-6 text-xs font-semibold text-gray-500 group-hover:text-gray-300"
												>
													{index + 1}
												</span>
												<div class="min-w-0 flex-1">
													<p class="truncate text-sm font-medium">
														{queuedTrack.title}{!isSonglinkTrack(queuedTrack) && asTrack(queuedTrack).version ? ` (${asTrack(queuedTrack).version})` : ''}
													</p>
													{#if isSonglinkTrack(queuedTrack)}
														<p class="truncate text-xs text-gray-400">
															{queuedTrack.artistName}
														</p>
													{:else}
														<a
															href={`/artist/${asTrack(queuedTrack).artist.id}`}
															onclick={(e) => e.stopPropagation()}
															class="truncate text-xs text-gray-400 hover:text-rose-300 hover:underline inline-block"
															data-sveltekit-preload-data
														>
															{formatArtists(asTrack(queuedTrack).artists)}
														</a>
													{/if}
												</div>
												<button
													onclick={(event) => removeFromQueue(index, event)}
													class="rounded-full p-1 text-gray-500 transition-colors hover:text-red-400"
													aria-label={`Remove ${queuedTrack.title} from queue`}
													type="button"
												>
													<X size={14} />
												</button>
											</div>
										</li>
									{/each}
								</ul>
							{:else}
								<p
									class="rounded-lg border border-dashed border-gray-700 bg-gray-900/70 px-3 py-8 text-center text-gray-400"
								>
									Queue is empty
								</p>
							{/if}
						</div>
					{/if}

				{:else}
					<div class="flex h-20 items-center justify-center text-sm text-gray-400">
						Nothing is playing
					</div>
				{/if}
			</div>
		</div>
	</div>
</div>
{/if}

<style>
	.audio-player-glass {
		background: rgba(10, 6, 10, 0.92);
		border-color: rgba(239, 68, 68, 0.28);
		backdrop-filter: blur(var(--perf-blur-high, 32px)) saturate(var(--perf-saturate, 160%));
		-webkit-backdrop-filter: blur(var(--perf-blur-high, 32px)) saturate(var(--perf-saturate, 160%));
		box-shadow:
			0 30px 80px rgba(5, 7, 12, 0.72),
			0 4px 18px rgba(12, 80, 76, 0.35),
			inset 0 1px 0 rgba(255, 255, 255, 0.06),
			inset 0 0 40px rgba(239, 68, 68, 0.06);
		transition:
			border-color 1.2s cubic-bezier(0.4, 0, 0.2, 1),
			box-shadow 0.3s ease;
	}

	.player-minimize-button {
		position: absolute;
		right: 0.75rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		height: 30px;
		border-radius: 999px;
		border: 1px solid rgba(239, 68, 68, 0.4);
		background: transparent;
		color: rgba(254, 202, 202, 0.95);
		backdrop-filter: blur(12px) saturate(140%);
		-webkit-backdrop-filter: blur(12px) saturate(140%);
		transition: border-color 160ms ease, color 160ms ease, transform 160ms ease, box-shadow 160ms ease;
	}

	.player-minimize-button:hover {
		border-color: rgba(239, 68, 68, 0.7);
		color: rgba(255, 255, 255, 0.95);
		box-shadow: 0 8px 18px rgba(18, 10, 16, 0.25);
	}

	.player-minimize-button--full {
		bottom: 0.75rem;
	}

	.player-minimize-button--full:hover {
		transform: translateY(-1px);
	}

	.player-minimize-button--mini {
		top: 50%;
		transform: translateY(-50%);
		z-index: 3;
	}

	.player-minimize-button--mini:hover {
		transform: translateY(calc(-50% - 1px));
	}

	.player-mini {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.4rem 4.25rem 0.1rem 0.25rem;
	}

	.player-mini__meta {
		min-width: 0;
		flex: 1;
	}

	.marquee {
		position: relative;
		overflow: hidden;
		white-space: nowrap;
	}

	.marquee__track {
		display: inline-flex;
		align-items: center;
		gap: 2rem;
		white-space: nowrap;
	}

	.marquee__single {
		display: inline-block;
	}

	.marquee__clone {
		pointer-events: none;
	}

	:global(.marquee[data-marquee='false'] .marquee__clone) {
		display: none;
	}

	:global(.marquee[data-marquee='true'] .marquee__track) {
		animation: marquee-scroll 12s linear infinite;
	}

	@keyframes marquee-scroll {
		0% {
			transform: translateX(0);
		}
		100% {
			transform: translateX(-50%);
		}
	}

	.player-mini__controls {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}

	.player-mini__control-button,
	.player-mini__play {
		font: inherit;
	}

	.player-mini__control-button {
		border: none;
		background: transparent;
		color: #fff;
		width: 42px;
		height: 42px;
		min-width: 42px;
		border-radius: 999px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transition: background 160ms ease, color 160ms ease;
		-webkit-tap-highlight-color: transparent;
	}

	.player-mini__control-button.is-tapping {
		background: rgba(255, 255, 255, 0.18);
	}

	.player-mini__control-button:focus {
		outline: none;
		background: transparent;
		color: #fff;
	}

	.player-mini__control-button:focus-visible {
		outline: none;
		color: #fff;
	}

	.player-control-button {
		-webkit-tap-highlight-color: transparent;
	}

	.player-control-button.is-tapping {
		color: rgba(248, 250, 252, 0.85);
	}

	.player-control-button:focus {
		outline: none;
		color: inherit;
		background: transparent;
	}

	.player-control-button:focus-visible {
		outline: none;
		color: inherit;
		background: transparent;
	}

	@media (hover: hover) {
		.player-mini__control-button:hover {
			background: rgba(255, 255, 255, 0.08);
		}
	}

	.player-mini__play {
		border-radius: 999px;
		background: linear-gradient(135deg, rgba(239, 68, 68, 0.98), rgba(127, 29, 29, 0.92));
		color: #041319;
		width: 52px;
		height: 52px;
		padding: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		box-shadow: 0 8px 20px rgba(18, 10, 16, 0.3);
		transition: box-shadow 160ms ease;
		line-height: 0;
	}

	.player-mini__play :global(svg) {
		width: 22px;
		height: 22px;
	}

	.player-mini__play:hover {
		box-shadow: 0 10px 24px rgba(18, 10, 16, 0.35);
	}

	.queue-panel {
		background: transparent;
		border-color: rgba(239, 68, 68, 0.22);
		backdrop-filter: blur(var(--perf-blur-medium, 28px)) saturate(var(--perf-saturate, 160%));
		-webkit-backdrop-filter: blur(var(--perf-blur-medium, 28px))
			saturate(var(--perf-saturate, 160%));
		box-shadow:
			0 8px 24px rgba(5, 7, 12, 0.6),
			inset 0 1px 0 rgba(255, 255, 255, 0.05);
		transition:
			border-color 1.2s cubic-bezier(0.4, 0, 0.2, 1),
			box-shadow 0.3s ease;
	}

	.ffmpeg-banner {
		background: transparent;
		border-color: rgba(239, 68, 68, 0.7);
		backdrop-filter: blur(var(--perf-blur-high, 32px)) saturate(var(--perf-saturate, 160%));
		-webkit-backdrop-filter: blur(var(--perf-blur-high, 32px)) saturate(var(--perf-saturate, 160%));
		box-shadow:
			0 12px 32px rgba(5, 7, 12, 0.6),
			0 2px 8px rgba(239, 68, 68, 0.2),
			inset 0 1px 0 rgba(255, 255, 255, 0.08),
			inset 0 0 30px rgba(239, 68, 68, 0.08);
		transition:
			border-color 1.2s cubic-bezier(0.4, 0, 0.2, 1),
			box-shadow 0.3s ease;
	}

	.download-popup {
		background: linear-gradient(140deg, var(--bloom-primary), var(--bloom-secondary));
		border-color: rgba(239, 68, 68, 0.45);
		backdrop-filter: blur(var(--perf-blur-high, 32px)) saturate(var(--perf-saturate, 160%));
		-webkit-backdrop-filter: blur(var(--perf-blur-high, 32px)) saturate(var(--perf-saturate, 160%));
		box-shadow:
			0 12px 32px rgba(5, 7, 12, 0.55),
			0 2px 8px rgba(12, 80, 76, 0.35),
			inset 0 1px 0 rgba(255, 255, 255, 0.08);
		transition:
			border-color 1.2s cubic-bezier(0.4, 0, 0.2, 1),
			box-shadow 0.3s ease;
	}

	.audio-player-backdrop {
		isolation: isolate;
		pointer-events: none;
	}

	.audio-player-backdrop .audio-player-glass,
	.audio-player-backdrop .player-minimize-button,
	.audio-player-backdrop .queue-panel,
	.audio-player-backdrop .ffmpeg-banner,
	.audio-player-backdrop .download-popup {
		pointer-events: auto;
	}

	.audio-player-backdrop::before {
		content: '';
		position: absolute;
		inset: 0;
		pointer-events: none;
		z-index: 0;
		background: rgba(10, 6, 10, 0.75);
		backdrop-filter: blur(20px);
		-webkit-backdrop-filter: blur(20px);
		mask: linear-gradient(to bottom, transparent 0%, black 25%);
	}

	@supports (-webkit-touch-callout: none) {
		.audio-player-glass {
			backdrop-filter: none;
			-webkit-backdrop-filter: none;
		}

		.audio-player-backdrop::before {
			backdrop-filter: none;
			-webkit-backdrop-filter: none;
		}
	}

	.audio-player-backdrop > * {
		position: relative;
		z-index: 1;
		pointer-events: none;
	}

	input[type='range']::-webkit-slider-thumb {
		appearance: none;
		width: 12px;
		height: 12px;
		background: rgba(239, 68, 68, 0.95);
		border-radius: 50%;
		cursor: pointer;
	}

	input[type='range']::-moz-range-thumb {
		width: 12px;
		height: 12px;
		background: rgba(239, 68, 68, 0.95);
		border-radius: 50%;
		cursor: pointer;
		border: none;
	}


	/* Dynamic button styles */
	button.rounded-full {
		transition:
			border-color 1.2s cubic-bezier(0.4, 0, 0.2, 1),
			color 0.2s ease,
			background 0.2s ease;
	}

	button.rounded-full:hover {
		border-color: rgba(239, 68, 68, 0.7) !important;
	}

	/* Player toggle buttons (Lyrics, Queue) */
	.player-toggle-button {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		border-radius: 9999px;
		border: 1px solid rgba(239, 68, 68, 0.32);
		background: transparent;
		backdrop-filter: blur(16px) saturate(140%);
		-webkit-backdrop-filter: blur(16px) saturate(140%);
		padding: 0.5rem 0.75rem;
		font-size: 0.875rem;
		color: rgba(254, 202, 202, 0.95);
		transition:
			border-color 200ms ease,
			color 200ms ease,
			box-shadow 200ms ease;
	}

	.player-toggle-button:hover {
		border-color: rgba(239, 68, 68, 0.7);
		color: rgba(255, 255, 255, 0.95);
	}

	.player-toggle-button:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.player-toggle-button--active {
		border-color: rgba(239, 68, 68, 0.75);
		color: rgba(255, 255, 255, 0.98);
		box-shadow: inset 0 0 20px rgba(239, 68, 68, 0.18);
	}
</style>


