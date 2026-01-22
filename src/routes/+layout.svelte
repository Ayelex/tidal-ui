<script lang="ts">
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { fade } from 'svelte/transition';
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import AudioPlayer from '$lib/components/AudioPlayer.svelte';
	import LyricsPopup from '$lib/components/LyricsPopup.svelte';
	import DynamicBackgroundWebGL from '$lib/components/DynamicBackground.svelte';
	import { playerStore } from '$lib/stores/player';
	import { downloadUiStore } from '$lib/stores/downloadUi';
	import { downloadPreferencesStore, type DownloadMode } from '$lib/stores/downloadPreferences';
	import { userPreferencesStore } from '$lib/stores/userPreferences';
	import { effectivePerformanceLevel } from '$lib/stores/performance';
	import { losslessAPI, type TrackDownloadProgress } from '$lib/api';
	import { sanitizeForFilename, getExtensionForQuality, buildTrackLinksCsv } from '$lib/downloads';
	import { formatArtists } from '$lib/utils';
	import { navigating, page } from '$app/stores';
	import { goto } from '$app/navigation';
	import JSZip from 'jszip';
	import {
		Archive,
		FileSpreadsheet,
		ChevronDown,
		LoaderCircle,
		Download,
		Check,
		Settings,
		Skull
	} from 'lucide-svelte';
	import type { Navigation } from '@sveltejs/kit';
	import { type Track, type AudioQuality, type PlayableTrack, isSonglinkTrack } from '$lib/types';

	let { children, data } = $props();
	const pageTitle = $derived(data?.title ?? 'BiniLossless');
	let headerHeight = $state(0);
	let playerHeight = $state(0);
	let viewportHeight = $state(0);
	let navigationState = $state<Navigation | null>(null);
	let showSettingsMenu = $state(false);
	let isZipDownloading = $state(false);
	let isCsvExporting = $state(false);
	let isLegacyQueueDownloading = $state(false);
	let settingsMenuContainer = $state<HTMLDivElement | null>(null);
	let libraryOpen = $state(false);
	let platform = $state<'ios' | 'default'>('default');

	const detectPlatform = () => {
		if (typeof navigator === 'undefined') {
			return 'default';
		}
		const ua = navigator.userAgent || '';
		const isIOS =
			/(iPad|iPhone|iPod)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
		return isIOS ? 'ios' : 'default';
	};

	function toggleLibrary() {
		libraryOpen = !libraryOpen;
	}

	function closeLibrary() {
		libraryOpen = false;
	}

	// Close dropdown when clicking anywhere outside of it.
	// NOTE: <svelte:window> must be top-level in the component (not nested in markup).

	const downloadMode = $derived($downloadPreferencesStore.mode);
	const queueActionBusy = $derived(
		downloadMode === 'zip'
			? Boolean(isZipDownloading || isLegacyQueueDownloading || isCsvExporting)
			: downloadMode === 'csv'
				? Boolean(isCsvExporting)
				: Boolean(isLegacyQueueDownloading)
	);

	const isEmbed = $derived($page.url.pathname.startsWith('/embed'));

	$effect(() => {
		const current = $playerStore.currentTrack;
		if (current && !isSonglinkTrack(current)) {
			const newPath = `/track/${current.id}`;
			const isTrackPage = $page.url.pathname.startsWith('/track/');

			if ($page.url.pathname !== newPath && !$navigating) {
				if (isTrackPage) {
					goto(newPath, { keepFocus: true, noScroll: true });
				}
			}
		}
	});
	const mainMinHeight = $derived(() => Math.max(0, viewportHeight - headerHeight - playerHeight));
	const contentPaddingBottom = $derived(() => Math.max(playerHeight, 24));
	const mainMarginBottom = $derived(() => Math.max(playerHeight, 128));
	const settingsMenuOffset = $derived(() => Math.max(0, headerHeight + 12));
	const FRIENDLY_ROUTE_MESSAGES: Record<string, string> = {
		album: 'Opening album',
		artist: 'Visiting artist',
		playlist: 'Loading playlist'
	};

	const QUALITY_OPTIONS: Array<{ value: AudioQuality; label: string; description: string; disabled?: boolean }> = [
		{
			value: 'HI_RES_LOSSLESS',
			label: 'Hi-Res',
			description: '24-bit FLAC (DASH) up to 192 kHz',
			disabled: false
		},
		{
			value: 'LOSSLESS',
			label: 'CD Lossless',
			description: '16-bit / 44.1 kHz FLAC'
		},
		{
			value: 'HIGH',
			label: '320kbps AAC',
			description: 'High quality AAC streaming'
		},
		{
			value: 'LOW',
			label: '96kbps AAC',
			description: 'Data saver AAC streaming'
		}
	];

	const playbackQualityLabel = $derived(() => {
		const quality = $playerStore.quality;
		if (quality === 'HI_RES_LOSSLESS') {
			return 'Hi-Res';
		}
		if (quality === 'LOSSLESS') {
			return 'CD';
		}
		return QUALITY_OPTIONS.find((option) => option.value === quality)?.label ?? 'Quality';
	});

	const crossfadeLabel = $derived(() => {
		const value = $playerStore.crossfadeSeconds;
		return value > 0 ? `${value}s` : 'Off';
	});

	const convertAacToMp3 = $derived($userPreferencesStore.convertAacToMp3);
	const downloadCoversSeperately = $derived($userPreferencesStore.downloadCoversSeperately);

	function selectPlaybackQuality(quality: AudioQuality): void {
		playerStore.setQuality(quality);
		showSettingsMenu = false;
	}

	function toggleAacConversion(): void {
		userPreferencesStore.toggleConvertAacToMp3();
	}

	function toggleDownloadCoversSeperately(): void {
		userPreferencesStore.toggleDownloadCoversSeperately();
	}

	function handleCrossfadeChange(event: Event): void {
		const target = event.currentTarget as HTMLInputElement | null;
		if (!target) {
			return;
		}
		const value = Number(target.value);
		if (!Number.isFinite(value)) {
			return;
		}
		playerStore.setCrossfadeSeconds(value);
	}

	function setDownloadMode(mode: DownloadMode): void {
		downloadPreferencesStore.setMode(mode);
	}

	const navigationMessage = $derived(() => {
		if (!navigationState) return '';
		const pathname = navigationState.to?.url?.pathname ?? '';
		const [primarySegment] = pathname.split('/').filter(Boolean);
		if (!primarySegment) return 'Loading';
		const key = primarySegment.toLowerCase();
		if (key in FRIENDLY_ROUTE_MESSAGES) {
			return FRIENDLY_ROUTE_MESSAGES[key]!;
		}
		const normalized = key.replace(/[-_]+/g, ' ');
		return `Loading ${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
	});

	// Update page title with currently playing song
	$effect(() => {
		if (typeof document === 'undefined') return;
		
		const track = $playerStore.currentTrack;
		const isPlaying = $playerStore.isPlaying;
		
		if (track) {
			const artist = isSonglinkTrack(track) ? track.artistName : formatArtists(track.artists);
			const title = track.title ?? 'Unknown Track';
			const prefix = isPlaying ? 'Playing:' : 'Paused:';
			document.title = `${prefix} ${title} - ${artist} | BiniLossless`;
		} else {
			document.title = pageTitle;
		}
	});

	function collectQueueState(): { tracks: PlayableTrack[]; quality: AudioQuality } {
		const state = get(playerStore);
		const tracks = state.queue.length
			? state.queue
			: state.currentTrack
				? [state.currentTrack]
				: [];
		return { tracks, quality: state.quality };
	}

	function buildQueueFilename(track: PlayableTrack, index: number, quality: AudioQuality): string {
		const ext = getExtensionForQuality(quality, convertAacToMp3);
		const order = `${index + 1}`.padStart(2, '0');
		const artistName = sanitizeForFilename(isSonglinkTrack(track) ? track.artistName : formatArtists(track.artists));
		const titleName = sanitizeForFilename(track.title ?? `Track ${order}`);
		return `${order} - ${artistName} - ${titleName}.${ext}`;
	}

	function triggerFileDownload(blob: Blob, filename: string): void {
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = filename;
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
		URL.revokeObjectURL(url);
	}

	function timestampedFilename(extension: string): string {
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		return `tidal-export-${stamp}.${extension}`;
	}

	async function downloadQueueAsZip(tracks: PlayableTrack[], quality: AudioQuality): Promise<void> {
		isZipDownloading = true;

		try {
			const zip = new JSZip();
			for (const [index, track] of tracks.entries()) {
				const trackId = isSonglinkTrack(track) ? track.tidalId : track.id;
				if (!trackId) continue;

				const filename = buildQueueFilename(track, index, quality);
				const { blob } = await losslessAPI.fetchTrackBlob(trackId, quality, filename, {
					ffmpegAutoTriggered: false,
					convertAacToMp3
				});
				zip.file(filename, blob);
			}

			const zipBlob = await zip.generateAsync({
				type: 'blob',
				compression: 'DEFLATE',
				compressionOptions: { level: 6 }
			});

			triggerFileDownload(zipBlob, timestampedFilename('zip'));
		} catch (error) {
			console.error('Failed to build ZIP export', error);
			alert('Unable to build ZIP export. Please try again.');
		} finally {
			isZipDownloading = false;
		}
	}

	async function exportQueueAsCsv(tracks: PlayableTrack[], quality: AudioQuality): Promise<void> {
		isCsvExporting = true;

		try {
			// @ts-ignore - buildTrackLinksCsv needs update but we can cast for now or update it later
			const csvContent = await buildTrackLinksCsv(tracks, quality);
			const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
			triggerFileDownload(blob, timestampedFilename('csv'));
		} catch (error) {
			console.error('Failed to export queue as CSV', error);
			alert('Unable to export CSV. Please try again.');
		} finally {
			isCsvExporting = false;
		}
	}

	async function handleExportQueueCsv(): Promise<void> {
		const { tracks, quality } = collectQueueState();
		if (tracks.length === 0) {
			showSettingsMenu = false;
			alert('Add tracks to the queue before exporting.');
			return;
		}

		showSettingsMenu = false;
		await exportQueueAsCsv(tracks, quality);
	}

	async function downloadQueueIndividually(tracks: PlayableTrack[], quality: AudioQuality): Promise<void> {
		if (isLegacyQueueDownloading) {
			return;
		}

		isLegacyQueueDownloading = true;
		const errors: string[] = [];

		try {
			for (const [index, track] of tracks.entries()) {
				const trackId = isSonglinkTrack(track) ? track.tidalId : track.id;
				if (!trackId) continue;

				const filename = buildQueueFilename(track, index, quality);
				// @ts-ignore - downloadUiStore needs update to accept PlayableTrack or we cast
				const { taskId, controller } = downloadUiStore.beginTrackDownload(track as Track, filename, {
					subtitle: isSonglinkTrack(track) ? track.artistName : (track.album?.title ?? formatArtists(track.artists))
				});
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
							const bytes = typeof totalBytes === 'number' ? totalBytes : 0;
							downloadUiStore.startFfmpegCountdown(bytes, { autoTriggered: false });
						},
						onFfmpegStart: () => downloadUiStore.startFfmpegLoading(),
						onFfmpegProgress: (value) => downloadUiStore.updateFfmpegProgress(value),
						onFfmpegComplete: () => downloadUiStore.completeFfmpeg(),
						onFfmpegError: (error) => downloadUiStore.errorFfmpeg(error),
						ffmpegAutoTriggered: false,
						convertAacToMp3,
						downloadCoverSeperately: downloadCoversSeperately
					});
					downloadUiStore.completeTrackDownload(taskId);
				} catch (error) {
					if (error instanceof DOMException && error.name === 'AbortError') {
						downloadUiStore.completeTrackDownload(taskId);
						continue;
					}
					console.error('Failed to download track from queue:', error);
					downloadUiStore.errorTrackDownload(taskId, error);
					const label = `${isSonglinkTrack(track) ? track.artistName : formatArtists(track.artists)} - ${track.title ?? 'Unknown Track'}`;
					const message =
						error instanceof Error && error.message
							? error.message
							: 'Failed to download track. Please try again.';
					errors.push(`${label}: ${message}`);
				}
			}

			if (errors.length > 0) {
				const summary = [
					'Unable to download some tracks individually:',
					...errors.slice(0, 3),
					errors.length > 3 ? `...and ${errors.length - 3} more` : undefined
				]
					.filter(Boolean)
					.join('\n');
				alert(summary);
			}
		} finally {
			isLegacyQueueDownloading = false;
		}
	}

	async function handleQueueDownload(): Promise<void> {
		if (queueActionBusy) {
			return;
		}

		const { tracks, quality } = collectQueueState();
		if (tracks.length === 0) {
			showSettingsMenu = false;
			alert('Add tracks to the queue before downloading.');
			return;
		}

		showSettingsMenu = false;

		if (downloadMode === 'csv') {
			await exportQueueAsCsv(tracks, quality);
			return;
		}

		const useZip = downloadMode === 'zip' && tracks.length > 1;
		if (useZip) {
			await downloadQueueAsZip(tracks, quality);
			return;
		}

		await downloadQueueIndividually(tracks, quality);
	}

	const handlePlayerHeight = (height: number) => {
		playerHeight = height;
	};

	let controllerChangeHandler: (() => void) | null = null;

	onMount(() => {
		// Subscribe to performance level and update data attribute
		const unsubPerf = effectivePerformanceLevel.subscribe((level) => {
			if (typeof document !== 'undefined') {
				document.documentElement.setAttribute('data-performance', level);
			}
		});

		if (typeof document !== 'undefined') {
			const nextPlatform = detectPlatform();
			platform = nextPlatform;
			document.documentElement.setAttribute('data-platform', nextPlatform);
		}

		const updateViewportHeight = () => {
			viewportHeight = window.innerHeight;
		};
		updateViewportHeight();
		window.addEventListener('resize', updateViewportHeight);
		const handleDocumentClick = (event: MouseEvent) => {
			const target = event.target as Node | null;
			if (showSettingsMenu) {
				const root = settingsMenuContainer;
				if (!root || !target || !root.contains(target)) {
					showSettingsMenu = false;
				}
			}
		};
		document.addEventListener('click', handleDocumentClick);
		const unsubscribe = navigating.subscribe((value) => {
			navigationState = value;
		});

		let unsubscribePlayer: (() => void) | null = null;

		if ('serviceWorker' in navigator) {
			const registerServiceWorker = async () => {
				try {
					const registration = await navigator.serviceWorker.register('/service-worker.js');
					const sendSkipWaiting = () => {
						if (registration.waiting) {
							registration.waiting.postMessage({ type: 'SKIP_WAITING' });
						}
					};

					if (registration.waiting) {
						sendSkipWaiting();
					}

					registration.addEventListener('updatefound', () => {
						const newWorker = registration.installing;
						if (!newWorker) return;
						newWorker.addEventListener('statechange', () => {
							if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
								sendSkipWaiting();
							}
						});
					});
				} catch (error) {
					console.error('Service worker registration failed', error);
				}
			};

			registerServiceWorker();

			let refreshing = false;
			let pendingRefresh = false;

			const canReloadNow = () => {
				const state = get(playerStore);
				return !state.isPlaying && !state.isLoading;
			};

			const requestReload = () => {
				if (refreshing) return;
				if (canReloadNow()) {
					refreshing = true;
					window.location.reload();
					return;
				}
				pendingRefresh = true;
			};

			controllerChangeHandler = () => {
				requestReload();
			};
			navigator.serviceWorker.addEventListener('controllerchange', controllerChangeHandler);

			unsubscribePlayer = playerStore.subscribe((state) => {
				if (!pendingRefresh) {
					return;
				}
				if (!state.isPlaying && !state.isLoading) {
					pendingRefresh = false;
					if (!refreshing) {
						refreshing = true;
						window.location.reload();
					}
				}
			});
		}
		return () => {
			window.removeEventListener('resize', updateViewportHeight);
			document.removeEventListener('click', handleDocumentClick);
			unsubscribe();
			unsubPerf();
			if (controllerChangeHandler) {
				navigator.serviceWorker.removeEventListener('controllerchange', controllerChangeHandler);
			}
			if (unsubscribePlayer) {
				unsubscribePlayer();
			}
		};
	});

</script>

<!-- Must be top-level (not nested) -->
<svelte:window onclick={() => closeLibrary()} />

<svelte:head>
	<title>{pageTitle}</title>
	<link rel="icon" href={favicon} />
	<link rel="manifest" href="/manifest.webmanifest" />
	<link rel="icon" href="/icons/icon.svg" type="image/svg+xml" />
	<meta name="theme-color" content="#140608" />
	<meta name="apple-mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
</svelte:head>

{#if isEmbed}
	{@render children?.()}
	<AudioPlayer headless={true} />
{:else}
	<div class="app-root">
		<DynamicBackgroundWebGL />
		<div class="app-shell">
			<header class="app-header glass-panel" bind:clientHeight={headerHeight}>
				<div class="app-header__inner">
				<a href="/" class="brand" aria-label="Home">
					<div class="brand__text">
						<h1 class="brand__title">{data.title}</h1>
						<p class="brand__subtitle">Oh-ho a pirate's life for me!</p>
					</div>
				</a>

				<div class="toolbar">
					<div class="settings-trigger" bind:this={settingsMenuContainer}>
						<button
							onclick={() => {
								showSettingsMenu = !showSettingsMenu;
							}}
							type="button"
							class={`toolbar-button glass-button ${showSettingsMenu ? 'is-active' : ''}`}
							aria-haspopup="true"
							aria-expanded={showSettingsMenu}
							aria-label={`Settings menu (${playbackQualityLabel()})`}
						>
							<span class="toolbar-button__label">
								<Settings size={16} />
								<span class="toolbar-button__text">Settings</span>
							</span>
							<span class="text-gray-400">{playbackQualityLabel()}</span>
							<span class={`toolbar-button__chevron ${showSettingsMenu ? 'is-open' : ''}`}>
								<ChevronDown size={16} />
							</span>
						</button>
						{#if showSettingsMenu}
							<div
								class="settings-menu glass-popover"
								style={`--settings-menu-offset: ${settingsMenuOffset()}px;`}
							>
								<div class="settings-grid">
									<section class="settings-section settings-section--wide">
										<p class="section-heading">Streaming & Downloads</p>
										<div class="option-grid">
											{#each QUALITY_OPTIONS as option}
												<button
													type="button"
													onclick={() => selectPlaybackQuality(option.value)}
													class={`glass-option ${option.value === $playerStore.quality ? 'is-active' : ''} ${option.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
													aria-pressed={option.value === $playerStore.quality}
													disabled={option.disabled}
												>
													<div class="glass-option__content">
														<span class="glass-option__label">{option.label}</span>
														<span class="glass-option__description">{option.description}</span>
													</div>
													{#if option.value === $playerStore.quality}
														<Check size={16} class="glass-option__check" />
													{/if}
												</button>
											{/each}
										</div>
									</section>
									<section class="settings-section settings-section--wide">
										<p class="section-heading">Playback</p>
										<div class="glass-option glass-option--slider">
											<div class="glass-option__content">
												<span class="glass-option__label">Crossfade</span>
												<span class="glass-option__description">
													Blend tracks by {crossfadeLabel()} (skips Hi-Res/DASH).
												</span>
											</div>
											<div class="crossfade-controls">
												<input
													type="range"
													min="0"
													max="12"
													step="1"
													value={$playerStore.crossfadeSeconds}
													oninput={handleCrossfadeChange}
													class="crossfade-slider"
													aria-label="Crossfade duration"
												/>
												<span class="crossfade-value">{crossfadeLabel()}</span>
											</div>
										</div>
									</section>
									<section class="settings-section settings-section--wide">
										<p class="section-heading">Conversions</p>
										<button
											type="button"
											onclick={toggleAacConversion}
											class={`glass-option ${convertAacToMp3 ? 'is-active' : ''}`}
											aria-pressed={convertAacToMp3}
										>
											<span class="glass-option__content">
												<span class="glass-option__label">Convert AAC downloads to MP3</span>
												<span class="glass-option__description">Applies to 320kbps and 96kbps downloads.</span>
											</span>
											<span class={`glass-option__chip ${convertAacToMp3 ? 'is-active' : ''}`}>
												{convertAacToMp3 ? 'On' : 'Off'}
											</span>
										</button>
										<button
											type="button"
											onclick={toggleDownloadCoversSeperately}
											class={`glass-option ${downloadCoversSeperately ? 'is-active' : ''}`}
											aria-pressed={downloadCoversSeperately}
										>
											<span class="glass-option__content">
												<span class="glass-option__label">Download covers separately</span>
												<span class="glass-option__description">Save cover.jpg alongside audio files.</span>
											</span>
											<span class={`glass-option__chip ${downloadCoversSeperately ? 'is-active' : ''}`}>
												{downloadCoversSeperately ? 'On' : 'Off'}
											</span>
										</button>
									</section>
									<section class="settings-section settings-section--wide">
										<p class="section-heading">Queue exports</p>
										<div class="option-grid option-grid--compact">
											<button
												type="button"
												onclick={() => setDownloadMode('individual')}
												class={`glass-option glass-option--compact ${downloadMode === 'individual' ? 'is-active' : ''}`}
												aria-pressed={downloadMode === 'individual'}
											>
												<span class="glass-option__content">
													<span class="glass-option__label">
														<Download size={16} />
														<span>Individual files</span>
													</span>
												</span>
												{#if downloadMode === 'individual'}
													<Check size={14} class="glass-option__check" />
												{/if}
											</button>
											<button
												type="button"
												onclick={() => setDownloadMode('zip')}
												class={`glass-option glass-option--compact ${downloadMode === 'zip' ? 'is-active' : ''}`}
												aria-pressed={downloadMode === 'zip'}
											>
												<span class="glass-option__content">
													<span class="glass-option__label">
														<Archive size={16} />
														<span>ZIP archive</span>
													</span>
												</span>
												{#if downloadMode === 'zip'}
													<Check size={14} class="glass-option__check" />
												{/if}
											</button>
											<button
												type="button"
												onclick={() => setDownloadMode('csv')}
												class={`glass-option glass-option--compact ${downloadMode === 'csv' ? 'is-active' : ''}`}
												aria-pressed={downloadMode === 'csv'}
											>
												<span class="glass-option__content">
													<span class="glass-option__label">
														<FileSpreadsheet size={16} />
														<span>Export links</span>
													</span>
												</span>
												{#if downloadMode === 'csv'}
													<Check size={14} class="glass-option__check" />
												{/if}
											</button>
										</div>
									</section>
									<section class="settings-section settings-section--bordered">
										<p class="section-heading">Queue actions</p>
										<div class="actions-column">
											<button
												onclick={handleQueueDownload}
												type="button"
												class="glass-action"
												disabled={queueActionBusy}
											>
												<span class="glass-action__label">
													{#if downloadMode === 'zip'}
														<Archive size={16} />
														<span>Download queue</span>
													{:else if downloadMode === 'csv'}
														<FileSpreadsheet size={16} />
														<span>Export queue links</span>
													{:else}
														<Download size={16} />
														<span>Download queue</span>
													{/if}
												</span>
												{#if queueActionBusy}
													<LoaderCircle size={16} class="glass-action__spinner" />
												{/if}
											</button>
											<button
												onclick={handleExportQueueCsv}
												type="button"
												class="glass-action"
												disabled={isCsvExporting}
											>
												<span class="glass-action__label">
													<FileSpreadsheet size={16} />
													<span>Export links as CSV</span>
												</span>
												{#if isCsvExporting}
													<LoaderCircle size={16} class="glass-action__spinner" />
												{/if}
											</button>
										</div>
										<p class="section-footnote">
											Queue actions follow your selection above. ZIP bundles require at least two tracks,
											while CSV exports capture the track links without downloading audio.
										</p>
									</section>
								</div>
							</div>
						{/if}
					</div>
					<!-- Library dropdown -->
					<div class="toolbar-dropdown">
						<button
							class="toolbar-icon toolbar-dropdown__btn"
							class:is-open={libraryOpen}
							type="button"
							aria-haspopup="true"
							aria-expanded={libraryOpen}
							aria-label="Library"
							onclick={(e) => {
								e.stopPropagation();
								toggleLibrary();
							}}
						>
							<span class="toolbar-button__label">
								<Skull size={16} />
							</span>
						</button>

						{#if libraryOpen}
							<div class="library-menu glass-popover" role="menu" aria-label="Library menu">
								<p class="section-heading">Library</p>
								<div class="library-menu__grid">
									<a
										href="/liked-tracks"
										onclick={() => closeLibrary()}
										class="glass-option glass-option--compact"
									>
										<span class="glass-option__content">
											<span class="glass-option__label">Liked Tracks</span>
										</span>
									</a>
									<a
										href="/saved-albums"
										onclick={() => closeLibrary()}
										class="glass-option glass-option--compact"
									>
										<span class="glass-option__content">
											<span class="glass-option__label">Saved Albums</span>
										</span>
									</a>
									<a
										href="/saved-playlists"
										onclick={() => closeLibrary()}
										class="glass-option glass-option--compact"
									>
										<span class="glass-option__content">
											<span class="glass-option__label">Saved Playlists</span>
										</span>
									</a>
									<a
										href="/liked-artists"
										onclick={() => closeLibrary()}
										class="glass-option glass-option--compact"
									>
										<span class="glass-option__content">
											<span class="glass-option__label">Liked Artists</span>
										</span>
									</a>
								</div>
							</div>
						{/if}
					</div>

				</div>
			</div>
		</header>

		<main
			class="app-main glass-panel !mb-56 !sm:mb-40"
			style={`min-height: ${mainMinHeight}px; margin-bottom: ${mainMarginBottom}px;`}
		>
			<div class="app-main__inner">
				{@render children?.()}
			</div>
		</main>

		<AudioPlayer onHeightChange={handlePlayerHeight} />
	</div>
</div>

<LyricsPopup />
{/if}

<!--
{#if navigationState}
	<div
		transition:fade={{ duration: 200 }}
		class="navigation-overlay"
	>
		<div class="navigation-overlay__progress">
			<div class="navigation-progress"></div>
		</div>
		<div class="navigation-overlay__content">
			<span class="navigation-overlay__label">{navigationMessage()}</span>
		</div>
	</div>
{/if}
-->

<style>
	:global(:root) {
		--bloom-primary: #140608;
		--bloom-secondary: #1b0b12;
		--bloom-accent: #ef4444;
		--bloom-glow: rgba(239, 68, 68, 0.35);
		--bloom-tertiary: rgba(244, 63, 94, 0.32);
		--bloom-quaternary: rgba(185, 28, 28, 0.28);
		--surface-color: rgba(18, 10, 16, 0.62);
		--surface-border: rgba(255, 255, 255, 0.12);
		--surface-highlight: rgba(239, 68, 68, 0.28);
		--accent-color: var(--bloom-accent);
		--ink-strong: #f8fafc;
		--ink-muted: rgba(248, 226, 226, 0.72);
		--ink-soft: rgba(214, 189, 189, 0.8);
		--glass-tint: rgba(12, 6, 10, 0.68);
		--glass-strong: rgba(12, 6, 10, 0.82);
	}

	:global(body) {
		margin: 0;
		min-height: 100vh;
		overflow-x: hidden;
		font-family:
			'Figtree',
			-apple-system,
			BlinkMacSystemFont,
			'Segoe UI',
			Roboto,
			'Helvetica Neue',
			Arial,
			sans-serif;
		color: var(--ink-strong);
		background:
			radial-gradient(900px 520px at 10% -10%, rgba(239, 68, 68, 0.22), transparent 60%),
			radial-gradient(860px 520px at 95% 0%, rgba(244, 63, 94, 0.18), transparent 55%),
			radial-gradient(680px 460px at 15% 95%, rgba(185, 28, 28, 0.18), transparent 55%),
			linear-gradient(160deg, #0a0608 0%, #14070c 45%, #1c0a12 100%);
		background-attachment: fixed;
		-webkit-tap-highlight-color: transparent;
	}

	.app-root {
		position: relative;
		min-height: 100vh;
		color: inherit;
		isolation: isolate;
	}

	.app-root::before,
	.app-root::after {
		content: '';
		position: fixed;
		z-index: 0;
		pointer-events: none;
		border-radius: 999px;
		filter: blur(0px);
		opacity: 0.6;
	}

	.app-root::before {
		width: min(60vw, 520px);
		height: min(60vw, 520px);
		top: -120px;
		left: -140px;
		background: radial-gradient(circle, rgba(239, 68, 68, 0.25), transparent 65%);
	}

	.app-root::after {
		width: min(55vw, 480px);
		height: min(55vw, 480px);
		bottom: -160px;
		right: -120px;
		background: radial-gradient(circle, rgba(244, 63, 94, 0.22), transparent 65%);
	}

	.app-shell {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		min-height: 100vh;
	}

	.glass-panel {
		background: linear-gradient(140deg, rgba(30, 12, 18, 0.78), rgba(12, 6, 10, 0.62));
		border: 1px solid var(--surface-border, rgba(255, 255, 255, 0.12));
		border-radius: 22px;
		backdrop-filter: blur(var(--perf-blur-high, 32px)) saturate(var(--perf-saturate, 160%));
		-webkit-backdrop-filter: blur(var(--perf-blur-high, 32px)) saturate(var(--perf-saturate, 160%));
		box-shadow:
			0 22px 55px rgba(3, 8, 18, 0.5),
			0 4px 14px rgba(18, 10, 16, 0.3),
			inset 0 1px 0 rgba(255, 255, 255, 0.08),
			inset 0 0 46px rgba(255, 255, 255, 0.02);
		transition: 
			border-color 1.2s cubic-bezier(0.4, 0, 0.2, 1),
			box-shadow 0.3s ease;
	}

	.app-header {
		position: sticky;
		top: 0;
		padding: calc(0.65rem + env(safe-area-inset-top, 0px)) clamp(1rem, 2.5vw, 2.2rem) 0.65rem;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		z-index: 12;
		border-radius: 0 0 24px 24px;
		border-left: none;
		border-right: none;
		border-top: none;
		box-shadow:
			0 20px 40px rgba(3, 8, 18, 0.35),
			inset 0 -1px 0 rgba(255, 255, 255, 0.04);
	}

	.app-header__inner {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: clamp(0.75rem, 1.5vw, 2rem);
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		text-decoration: none;
		color: inherit;
		font-weight: 600;
		transition: opacity 150ms ease, transform 180ms ease;
	}

	.brand:hover {
		opacity: 0.88;
		transform: translateY(-1px);
	}

	.brand__title {
		font-size: clamp(1.35rem, 2.4vw, 2rem);
		margin: 0;
		font-family: 'Bungee', 'Figtree', sans-serif;
		letter-spacing: 0.02em;
		line-height: 1.1;
		font-weight: 400;
		padding-bottom: 0.08em;
		text-transform: uppercase;
		background-image: linear-gradient(135deg, #fecaca 0%, #ef4444 40%, #7f1d1d 70%, #450a0a 100%);
		background-clip: text;
		-webkit-background-clip: text;
		color: transparent;
	}

	.brand__subtitle {
		margin: 0.15rem 0 0;
		font-size: 0.72rem;
		color: var(--ink-muted);
		font-weight: normal;
	}

	.toolbar {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.toolbar-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2.2rem;
		height: 2.2rem;
		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.14);
		background: rgba(18, 10, 16, 0.55);
		backdrop-filter: blur(var(--perf-blur-low, 24px)) saturate(var(--perf-saturate, 160%));
		-webkit-backdrop-filter: blur(var(--perf-blur-low, 24px)) saturate(var(--perf-saturate, 160%));
		color: inherit;
		transition: border-color 160ms ease, transform 180ms ease, box-shadow 180ms ease;
	}

	.toolbar-icon:hover {
		transform: translateY(-1px);
		border-color: rgba(239, 68, 68, 0.45);
		box-shadow: 0 10px 24px rgba(8, 11, 19, 0.35);
	}

	.toolbar-icon__svg {
		width: 16px;
		height: 16px;
		flex-shrink: 0;
	}

	.toolbar-button {
		display: inline-flex;
		align-items: center;
		gap: 0.75rem;
		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.14);
		padding: 0.55rem 1rem 0.55rem 0.9rem;
		font-size: 0.8rem;
		line-height: 1;
		font-weight: 600;
		color: inherit;
		cursor: pointer;
		background: rgba(18, 10, 16, 0.55);
		backdrop-filter: blur(var(--perf-blur-low, 24px)) saturate(var(--perf-saturate, 160%));
		-webkit-backdrop-filter: blur(var(--perf-blur-low, 24px)) saturate(var(--perf-saturate, 160%));
		transition: 
			border-color 1.2s cubic-bezier(0.4, 0, 0.2, 1),
			box-shadow 160ms ease, 
			transform 160ms ease;
	}

	.toolbar-button:hover {
		border-color: rgba(239, 68, 68, 0.55);
		box-shadow: 0 12px 28px rgba(8, 11, 19, 0.35);
	}

	.toolbar-button.is-active {
		border-color: rgba(239, 68, 68, 0.75);
		box-shadow:
			0 12px 30px rgba(8, 11, 19, 0.35),
			0 0 26px rgba(239, 68, 68, 0.35),
			inset 0 0 18px rgba(239, 68, 68, 0.18);
	}

	.toolbar-button__label {
		display: inline-flex;
		align-items: center;
		gap: 0.6rem;
	}

	.toolbar-button__text {
		display: none;
	}

	.toolbar-button__chip {
		font-size: 0.65rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		padding: 0.3rem 0.6rem;
		border-radius: 999px;
		background: rgba(239, 68, 68, 0.12);
		backdrop-filter: blur(12px) saturate(130%);
		-webkit-backdrop-filter: blur(12px) saturate(130%);
		border: 1px solid rgba(239, 68, 68, 0.4);
		color: rgba(254, 202, 202, 0.95);
	}

	.toolbar-button__chevron {
		transition: transform 180ms ease;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.toolbar-button__chevron.is-open {
		transform: rotate(180deg);
	}
	
	/* --- DROPDOWN (Library) --- */

	.toolbar-dropdown {
		position: relative;
		display: inline-flex;
		align-items: center;
	}

	/* Make the button match your pill style */
	.toolbar-dropdown__btn {
		/* inherit your existing button look */
		display: inline-flex;
		align-items: center;
		gap: 0.75rem;

		border-radius: 999px;
		border: 1px solid rgba(255, 255, 255, 0.14);
		padding: 0.55rem 0.95rem 0.55rem 0.85rem;

		font-size: 0.8rem;
		line-height: 1;
		font-weight: 600;
		color: inherit;

		cursor: pointer;
		background: rgba(18, 10, 16, 0.55);

		backdrop-filter: blur(var(--perf-blur-low, 24px)) saturate(var(--perf-saturate, 160%));
		-webkit-backdrop-filter: blur(var(--perf-blur-low, 24px)) saturate(var(--perf-saturate, 160%));

		transition:
			border-color 1.2s cubic-bezier(0.4, 0, 0.2, 1),
			box-shadow 160ms ease,
			transform 160ms ease;
	}

	.toolbar-dropdown__btn:hover {
		transform: translateY(-1px);
		border-color: rgba(239, 68, 68, 0.45);
		box-shadow: 0 10px 28px rgba(8, 11, 19, 0.32);
	}

	.toolbar-dropdown__btn.is-open {
		border-color: rgba(239, 68, 68, 0.75);
		box-shadow:
			0 12px 30px rgba(8, 11, 19, 0.35),
			0 0 24px rgba(239, 68, 68, 0.35),
			inset 0 0 18px rgba(239, 68, 68, 0.18);
	}


	.toolbar-dropdown__chev {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transition: transform 180ms ease;
		opacity: 0.9;
	}

	.toolbar-dropdown__chev.is-open {
		transform: rotate(180deg);
	}

	/* The actual dropdown menu (hidden by default) */
	.toolbar-dropdown__menu {
		position: absolute;
		top: calc(100% + 10px);
		right: 0;

		min-width: 220px;
		display: block; /* shown when rendered via {#if} */
		z-index: 9999;

		padding: 0.35rem;
		border-radius: 14px;

		background: rgba(10, 14, 24, 0.92);
		backdrop-filter: blur(var(--perf-blur-low, 24px)) saturate(var(--perf-saturate, 160%));
		-webkit-backdrop-filter: blur(var(--perf-blur-low, 24px)) saturate(var(--perf-saturate, 160%));

		border: 1px solid rgba(148, 163, 184, 0.18);
		box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
	}

	.library-menu {
		position: absolute;
		top: calc(100% + 10px);
		right: 0;
		min-width: 240px;
		z-index: 9999;
		padding: 0.6rem;
		border-radius: 16px;
		background: rgba(18, 10, 16, 0.78);
		border: 1px solid rgba(239, 68, 68, 0.28);
		backdrop-filter: blur(40px) saturate(170%) brightness(1.05);
		-webkit-backdrop-filter: blur(40px) saturate(170%) brightness(1.05);
		box-shadow:
			0 18px 42px rgba(2, 6, 23, 0.55),
			0 3px 12px rgba(12, 80, 76, 0.32),
			inset 0 1px 0 rgba(255, 255, 255, 0.06);
		animation: dropdown-pop 180ms ease;
	}

	.library-menu__grid {
		display: grid;
		gap: 0.45rem;
		margin-top: 0.45rem;
	}

	.library-menu .glass-option {
		text-decoration: none;
	}

	@keyframes dropdown-pop {
		from {
			opacity: 0;
			transform: translateY(-6px) scale(0.98);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}

	.settings-trigger {
		position: relative;
	}

	.settings-menu {
		position: fixed;
		top: var(--settings-menu-offset, 88px);
		left: calc(env(safe-area-inset-left, 0px) + 0.75rem);
		right: calc(env(safe-area-inset-right, 0px) + 0.75rem);
		margin: 0;
		max-height: calc(100vh - var(--settings-menu-offset, 88px) - 8rem);
		overflow-y: auto;
		padding: clamp(0.85rem, 1.5vw, 1.2rem);
		border-radius: 18px;
		background: rgba(12, 6, 10, 0.82);
		border: 1px solid rgba(255, 255, 255, 0.14);
		backdrop-filter: blur(48px) saturate(180%) brightness(1.05);
		-webkit-backdrop-filter: blur(48px) saturate(180%) brightness(1.05);
		box-shadow: 
			0 25px 60px rgba(2, 6, 23, 0.55),
			0 3px 15px rgba(12, 6, 10, 0.35),
			inset 0 1px 0 rgba(255, 255, 255, 0.06),
			inset 0 0 42px rgba(239, 68, 68, 0.04);
		z-index: 100;
		isolation: isolate;
		will-change: transform;
		transform: translateZ(0);
		transition: 
			border-color 1.2s cubic-bezier(0.4, 0, 0.2, 1),
			box-shadow 0.3s ease;
		animation: dropdown-pop 180ms ease;
	}
	/* Hide scrollbar for Chrome, Safari and Opera */
	.settings-menu::-webkit-scrollbar {
		display: none;
	}

	/* Hide scrollbar for IE, Edge and Firefox */
	.settings-menu {
		-ms-overflow-style: none;  /* IE and Edge */
		scrollbar-width: none;  /* Firefox */
	}

	.settings-grid {
		display: grid;
		gap: 0.85rem;
	}

	.settings-section {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.settings-section--wide {
		grid-column: span 1;
	}

	.section-heading {
		font-size: 0.65rem;
		text-transform: uppercase;
		letter-spacing: 0.16em;
		font-weight: 700;
		margin: 0;
		color: rgba(191, 219, 254, 0.7);
	}

	.option-grid {
		display: grid;
		gap: 0.45rem;
	}

	.option-grid--compact {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
		gap: 0.4rem;
	}

	.glass-option {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
		border-radius: 12px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		background: rgba(18, 10, 16, 0.5);
		backdrop-filter: blur(var(--perf-blur-medium, 28px)) saturate(var(--perf-saturate, 160%));
		-webkit-backdrop-filter: blur(var(--perf-blur-medium, 28px)) saturate(var(--perf-saturate, 160%));
		padding: 0.5rem 0.65rem;
		color: inherit;
		font-size: 0.8rem;
		cursor: pointer;
		text-align: left;
		transition: border-color 140ms ease, transform 140ms ease, box-shadow 160ms ease;
	}

	.glass-option--slider {
		cursor: default;
	}

	.glass-option--compact {
		padding: 0.45rem 0.6rem;
		gap: 0.5rem;
		border-radius: 10px;
	}

	.glass-option--compact .glass-option__label {
		font-size: 0.75rem;
		font-weight: 600;
	}

	.glass-option--compact .glass-option__description {
		display: none;
	}

	.glass-option:hover {
		transform: translateY(-1px);
		box-shadow: 0 8px 24px rgba(18, 10, 16, 0.22);
		border-color: rgba(239, 68, 68, 0.4);
	}

	.glass-option.is-active {
		border-color: rgba(239, 68, 68, 0.7);
		background: rgba(239, 68, 68, 0.08);
		box-shadow: 
			0 12px 28px rgba(239, 68, 68, 0.18),
			inset 0 0 32px rgba(239, 68, 68, 0.08);
	}

	.glass-option__content {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	.glass-option__label {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		font-weight: 600;
		font-size: 0.8rem;
	}

	.glass-option__description {
		font-size: 0.68rem;
		opacity: 0.58;
		line-height: 1.3;
	}

	.glass-option__check {
		color: rgba(191, 219, 254, 0.95);
		flex-shrink: 0;
	}

	.glass-option__chip {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 0.66rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		padding: 0.2rem 0.55rem;
		border-radius: 999px;
		background: rgba(239, 68, 68, 0.12);
		backdrop-filter: blur(16px) saturate(140%);
		-webkit-backdrop-filter: blur(16px) saturate(140%);
		border: 1px solid rgba(239, 68, 68, 0.35);
		color: rgba(254, 202, 202, 0.95);
		flex-shrink: 0;
	}

	.glass-option__chip.is-active {
		border-color: rgba(239, 68, 68, 0.7);
		color: rgba(254, 226, 226, 0.95);
		box-shadow: inset 0 0 20px rgba(239, 68, 68, 0.18);
	}

	.crossfade-controls {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.crossfade-slider {
		width: 140px;
		height: 0.3rem;
		cursor: pointer;
		appearance: none;
		border-radius: 999px;
		background: rgba(148, 163, 184, 0.35);
		accent-color: rgba(239, 68, 68, 0.9);
	}

	.crossfade-value {
		font-size: 0.7rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: rgba(248, 226, 226, 0.82);
	}

	.settings-section--bordered {
		padding-top: 0.65rem;
		border-top: 1px solid rgba(148, 163, 184, 0.12);
	}

	.actions-column {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.glass-action {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.85rem;
		border-radius: 14px;
		border: 1px solid rgba(255, 255, 255, 0.14);
		background: rgba(18, 10, 16, 0.55);
		backdrop-filter: blur(var(--perf-blur-medium, 28px)) saturate(var(--perf-saturate, 160%));
		-webkit-backdrop-filter: blur(var(--perf-blur-medium, 28px)) saturate(var(--perf-saturate, 160%));
		padding: 0.7rem 0.9rem;
		font-size: 0.8rem;
		font-weight: 600;
		color: inherit;
		cursor: pointer;
		transition: border-color 140ms ease, box-shadow 160ms ease, transform 160ms ease;
	}

	.glass-action:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.glass-action:hover:not(:disabled) {
		transform: translateY(-1px);
		border-color: rgba(239, 68, 68, 0.45);
		box-shadow: 0 10px 28px rgba(8, 11, 19, 0.32);
	}

	.glass-action__label {
		display: inline-flex;
		align-items: center;
		gap: 0.55rem;
	}

	.glass-action__spinner {
		animation: spin 1s linear infinite;
		color: rgba(203, 213, 225, 0.85);
	}

	.section-footnote {
		margin: 0;
		font-size: 0.68rem;
		color: rgba(203, 213, 225, 0.58);
		line-height: 1.4;
	}

	.app-main {
		flex: 1;
		padding: clamp(1.6rem, 2.6vw, 3rem);
		margin: clamp(1rem, 1.6vw, 2rem) clamp(0.75rem, 2.2vw, 1.8rem);
		border-radius: 26px;
		position: relative;
		z-index: 1;
	}

	.app-main__inner {
		max-width: min(1100px, 100%);
		margin: 0 auto;
	}

	.navigation-overlay {
		position: fixed;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2rem;
		background: transparent;
		backdrop-filter: blur(var(--perf-blur-high, 32px)) saturate(var(--perf-saturate, 160%));
		-webkit-backdrop-filter: blur(var(--perf-blur-high, 32px)) saturate(var(--perf-saturate, 160%));
		z-index: 50;
	}

	.navigation-overlay__progress {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		height: 3px;
		overflow: hidden;
		background: transparent;
		backdrop-filter: blur(8px) saturate(120%);
		-webkit-backdrop-filter: blur(8px) saturate(120%);
		box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.15);
	}

	.navigation-progress {
		position: absolute;
		top: 0;
		bottom: 0;
		left: -40%;
		width: 60%;
		background: linear-gradient(
			90deg,
			transparent,
			var(--bloom-accent, rgba(239, 68, 68, 0.9)),
			transparent
		);
		box-shadow: 0 0 12px var(--bloom-accent, rgba(239, 68, 68, 0.5));
		animation: shimmer 1.2s ease-in-out infinite;
	}

	.navigation-overlay__content {
		font-size: 0.78rem;
		letter-spacing: 0.28em;
		text-transform: uppercase;
		color: rgba(226, 232, 240, 0.9);
	}

	@keyframes shimmer {
		0% {
			transform: translateX(0);
			opacity: 0.2;
		}
		50% {
			transform: translateX(250%);
			opacity: 0.85;
		}
		100% {
			transform: translateX(400%);
			opacity: 0;
		}
	}

	:global(.animate-spin-slower) {
		animation: spin-slower 1.8s cubic-bezier(0.4, 0, 0.2, 1) infinite;
	}

	@keyframes spin {
		0% {
			transform: rotate(0deg);
		}
		100% {
			transform: rotate(360deg);
		}
	}

	@keyframes spin-slower {
		0% {
			transform: rotate(0deg);
		}
		100% {
			transform: rotate(360deg);
		}
	}

	@media (min-width: 520px) {
		.toolbar-button__text {
			display: inline;
		}
	}

	@media (min-width: 768px) {
		.settings-menu {
			position: absolute;
			right: 0;
			left: auto;
			width: 30rem;
			max-height: calc(100vh - var(--settings-menu-offset, 88px) - 8rem);
			padding: 1.3rem;
			border-radius: 18px;
			top: calc(var(--settings-menu-offset, 88px) - 8px);
		}
		

		.settings-grid {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 1.2rem;
		}

		.settings-section--wide {
			grid-column: span 2;
		}

		.option-grid--compact {
			grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
		}

		.settings-section--bordered {
			border-top: none;
			padding-top: 0;
		}
	}

	@media (max-width: 640px) {
		.app-header {
			border-radius: 0;
			padding: 0.65rem 1rem;
		}

		.toolbar {
			gap: 0.5rem;
		}

		.toolbar-button {
			padding: 0.5rem 0.8rem;
		}

		.app-main {
			padding: 1.4rem;
			margin: 1rem 0.75rem;
		}
	}
</style>
