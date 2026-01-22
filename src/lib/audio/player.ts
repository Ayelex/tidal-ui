import { get } from 'svelte/store';
import { dev } from '$app/environment';
import { losslessAPI } from '$lib/api';
import { getProxiedUrl } from '$lib/config';
import { userPreferencesStore } from '$lib/stores/userPreferences';
import { deriveTrackQuality } from '$lib/utils/audioQuality';
import { resolveSonglinkTrackToTidal, resolveUserCountry } from '$lib/utils/trackResolution';
import type { AudioQuality, PlayableTrack, SonglinkTrack, Track } from '$lib/types';
import { isSonglinkTrack } from '$lib/types';
import { audioReducer, type AudioState, type PlaybackStatus, type RepeatMode } from './state';
import { audioTelemetry } from './telemetry';
import { streamCache } from './streamCache';
import { createMediaSessionBridge } from './mediaSession';
import { createAudioElement, MockAudioElement, type AudioElementLike } from './mockAudio';

type ShakaPlayerInstance = {
	load: (uri: string) => Promise<void>;
	unload: () => Promise<void>;
	destroy: () => Promise<void>;
	getNetworkingEngine?: () => {
		registerRequestFilter: (
			callback: (type: unknown, request: { method: string; uris: string[] }) => void
		) => void;
	};
};

type ShakaNamespace = {
	Player: new (mediaElement: HTMLMediaElement) => ShakaPlayerInstance;
	polyfill?: {
		installAll?: () => void;
	};
};

type ShakaModule = { default: ShakaNamespace };

type LoadOptions = {
	resumeTime?: number;
	reason?: string;
	shouldPlay?: boolean;
	resetTime?: boolean;
};

type LoadOutcome = 'playing' | 'ready' | 'blocked' | 'error' | 'timeout' | 'stalled' | 'canceled';

type StreamCandidate = {
	url: string;
	quality: AudioQuality;
	source: 'cache' | 'api';
	replayGain: number | null;
	sampleRate: number | null;
	bitDepth: number | null;
	resolvedAt: number;
};

type ActiveStreamMeta = StreamCandidate & {
	trackId: number;
};

type CrossfadeState = {
	active: boolean;
	startTime: number;
	durationSec: number;
	progress: number;
	nextIndex: number;
	nextTrack: Track;
	nextPreferredQuality: AudioQuality;
	nextAudio: AudioElementLike;
	nextRealAudio: HTMLAudioElement | null;
	nextStreamMeta: ActiveStreamMeta;
	nextReplayGain: number | null;
	rafId: number | null;
};

const hiResQualities = new Set<AudioQuality>(['HI_RES_LOSSLESS']);

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const LOAD_ATTEMPT_LIMIT = 3;
const LOAD_TIMEOUT_MS = 12000;
const READY_TIMEOUT_MS = 8000;
const STALL_TIMEOUT_MS = 5000;
const RETRY_BACKOFF_MS = [0, 500, 1500];
const PREFETCH_GUARD_MS = 15000;
const PROBE_TIMEOUT_MS = 5000;
const PREFETCH_RANGE_BYTES = 65535;
const CROSSFADE_MAX_SECONDS = 12;
const CROSSFADE_MIN_SECONDS = 0;
const CROSSFADE_READY_TIMEOUT_MS = 4000;
const PREFETCH_NEXT_COUNT = 15;
const PREFETCH_HISTORY_COUNT = 10;
const PREFETCH_RECENT_WARM_COUNT = 5;
const PREFETCH_RESOLVE_ATTEMPTS = 3;

const SILENT_AUDIO_DATA_URI =
	'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

const allowedTransitions: Record<PlaybackStatus, PlaybackStatus[]> = {
	idle: ['loading', 'paused', 'blocked', 'error'],
	loading: ['paused', 'playing', 'buffering', 'blocked', 'error', 'idle'],
	playing: ['paused', 'buffering', 'loading', 'blocked', 'error', 'idle'],
	paused: ['playing', 'loading', 'buffering', 'blocked', 'error', 'idle'],
	buffering: ['playing', 'paused', 'loading', 'blocked', 'error', 'idle'],
	blocked: ['loading', 'paused', 'playing', 'error', 'idle'],
	error: ['loading', 'paused', 'blocked', 'idle']
};

function createSeededRng(seed: number) {
	let t = seed >>> 0;
	return () => {
		t += 0x6d2b79f5;
		let r = Math.imul(t ^ (t >>> 15), 1 | t);
		r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};
}

function resolveMockFlag(): boolean {
	if (typeof window === 'undefined') {
		return false;
	}
	return new URLSearchParams(window.location.search).get('audioMock') === '1';
}

function createSnapshot(state: AudioState, audio: AudioElementLike) {
	return {
		trackId: state.currentTrack?.id ?? null,
		src: audio.src ?? '',
		currentTime: audio.currentTime ?? 0,
		duration: audio.duration ?? 0,
		readyState: audio.readyState ?? -1,
		networkState: audio.networkState ?? -1,
		paused: audio.paused ?? true,
		ended: audio.ended ?? false
	};
}

export interface AudioControllerOptions {
	initialState: AudioState;
	setState: (state: AudioState) => void;
}

export class AudioController {
	private state: AudioState;
	private setState: (state: AudioState) => void;
	private audioPrimary: AudioElementLike;
	private audioSecondary: AudioElementLike;
	private realAudioPrimary: HTMLAudioElement | null;
	private realAudioSecondary: HTMLAudioElement | null;
	private audio: AudioElementLike;
	private realAudio: HTMLAudioElement | null;
	private shakaNamespace: ShakaNamespace | null = null;
	private shakaPlayer: ShakaPlayerInstance | null = null;
	private dashObjectUrl: string | null = null;
	private loadToken = 0;
	private pendingPlay = false;
	private playInFlight = false;
	private pendingSeek: number | null = null;
	private lastTimeUpdateAt = 0;
	private lastPositionUpdateAt = 0;
	private endedToken = -1;
	private random = Math.random;
	private unlocked = false;
	private unlocking = false;
	private shuffleBag: number[] = [];
	private shuffleHistory: number[] = [];
	private convertingTracks = new Map<number | string, Promise<Track>>();
	private destroyed = false;
	private useMock = false;
	private activeSrc: string | null = null;
	private commandQueue: Promise<void> = Promise.resolve();
	private commandId = 0;
	private loadOutcome: Promise<LoadOutcome> | null = null;
	private resolveLoadOutcome: ((outcome: LoadOutcome) => void) | null = null;
	private loadOutcomeToken = 0;
	private loadExpectPlay = false;
	private loadStartedAt = 0;
	private loadTimeoutId: ReturnType<typeof setTimeout> | null = null;
	private stallTimeoutId: ReturnType<typeof setTimeout> | null = null;
	private lastProgressAt = 0;
	private retryCount = 0;
	private lastRetryAt = 0;
	private activeStreamMeta: ActiveStreamMeta | null = null;
	private prefetchAbort: AbortController | null = null;
	private prefetching = false;
	private lastPrefetchAt = 0;
	private activeProbeController: AbortController | null = null;
	private crossfade: CrossfadeState | null = null;
	private crossfadeToken = 0;
	private crossfadePreparing = false;
	private lastCrossfadeAttemptAt = 0;
	private lastCrossfadeTrackId: number | null = null;
	private recentTracks: Track[] = [];
	private lastSeekRequest: { time: number; reason: string; at: number } | null = null;
	private lastSeekPrefetchAt = 0;
	private lastProgressPrefetchTrackId: number | null = null;
	private mediaSession = createMediaSessionBridge({
		onPlay: () => this.play('media-session'),
		onPause: () => this.pause('media-session'),
		onNext: () => this.next('media-session'),
		onPrevious: () => this.previous('media-session'),
		onSeekTo: (seconds) => this.seekTo(seconds, 'media-session'),
		getPositionState: () => ({
			duration: Number.isFinite(this.audio.duration) ? this.audio.duration : this.state.duration,
			position: this.audio.currentTime ?? this.state.currentTime,
			playbackRate: this.audio.playbackRate ?? 1
		})
	});

	constructor(options: AudioControllerOptions) {
		this.state = options.initialState;
		this.setState = options.setState;

		const useMock = resolveMockFlag();
		const primary = createAudioElement({ mock: useMock });
		const secondary = createAudioElement({ mock: useMock });
		this.audioPrimary = primary.element;
		this.audioSecondary = secondary.element;
		this.realAudioPrimary = primary.realElement;
		this.realAudioSecondary = secondary.realElement;
		this.audio = this.audioPrimary;
		this.realAudio = this.realAudioPrimary;
		this.useMock = this.audio instanceof MockAudioElement;

		const attachRealAudio = (element: HTMLAudioElement | null, label: string) => {
			if (!element) {
				return;
			}
			element.className = `audio-engine audio-engine--${label}`;
			element.style.display = 'none';
			element.setAttribute('playsinline', 'true');
			if (typeof document !== 'undefined') {
				document.body.appendChild(element);
			}
		};

		attachRealAudio(this.realAudioPrimary, 'primary');
		attachRealAudio(this.realAudioSecondary, 'secondary');

		this.attachListeners();
		this.applyVolume();
		audioTelemetry.logState('init', this.state);
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('audio-init', createSnapshot(this.state, this.audio), {
				crossOrigin: this.audio.crossOrigin,
				preload: this.audio.preload,
				autoplay: this.audio.autoplay
			});
		}
	}
	subscribe = (listener: (state: AudioState) => void) => {
		listener(this.state);
		const unsubscribe = this.internalSubscribe(listener);
		return unsubscribe;
	};

	private subscribers = new Set<(state: AudioState) => void>();

	private internalSubscribe(listener: (state: AudioState) => void) {
		let active = true;
		const notify = (state: AudioState) => {
			if (!active) {
				return;
			}
			listener(state);
		};
		this.subscribers.add(notify);
		return () => {
			active = false;
			this.subscribers.delete(notify);
		};
	}

	private scheduleCommand(name: string, run: () => void | Promise<void>) {
		const commandId = ++this.commandId;
		this.commandQueue = this.commandQueue
			.then(async () => {
				if (this.destroyed) {
					return;
				}
				try {
					await run();
				} catch (error) {
					this.reportInvariant('command-failed', {
						name,
						commandId,
						message: error instanceof Error ? error.message : 'Unknown error'
					});
				}
			})
			.catch(() => {
				// Prevent unhandled promise rejections in the command queue.
			});
	}

	private isUnlockingPlayback() {
		return this.unlocking && this.audio.src === SILENT_AUDIO_DATA_URI;
	}

	private async unlockAudioFromGesture() {
		if (this.unlocked || this.unlocking || this.useMock) {
			return;
		}
		if (typeof window === 'undefined') {
			return;
		}
		this.unlocking = true;
		const previousSrc = this.audio.src;
		const previousLoop = this.audio.loop;
		const previousMuted = this.audio.muted;
		const previousVolume = this.audio.volume;
		const previousRate = this.audio.playbackRate;
		try {
			this.audio.src = SILENT_AUDIO_DATA_URI;
			this.audio.loop = false;
			this.audio.muted = false;
			this.audio.volume = 0;
			this.audio.playbackRate = 1;
			await this.audio.play();
			this.audio.pause();
			this.unlocked = true;
		} catch {
			// Ignore unlock failures; playback will request a user gesture.
		} finally {
			if (this.audio.src === SILENT_AUDIO_DATA_URI) {
				this.audio.pause();
				this.audio.src = previousSrc;
				this.audio.loop = previousLoop;
				this.audio.playbackRate = previousRate;
				this.audio.muted = previousMuted;
				this.audio.volume = previousVolume;
				if (previousSrc) {
					this.audio.load();
				}
			} else {
				this.audio.loop = previousLoop;
				this.audio.playbackRate = previousRate;
				this.audio.muted = previousMuted;
				this.audio.volume = previousVolume;
			}
			this.unlocking = false;
			this.applyVolume();
		}
	}

	private logCommand(name: string, detail?: Record<string, unknown>) {
		if (!audioTelemetry.enabled) {
			return;
		}
		audioTelemetry.logCommand(name, createSnapshot(this.state, this.audio), detail);
	}

	private reportInvariant(name: string, detail?: Record<string, unknown>) {
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent(`invariant:${name}`, createSnapshot(this.state, this.audio), detail);
			return;
		}
		if (dev) {
			console.warn('Audio invariant', name, detail);
		}
	}

	private clearLoadTimers() {
		if (this.loadTimeoutId) {
			clearTimeout(this.loadTimeoutId);
			this.loadTimeoutId = null;
		}
		if (this.stallTimeoutId) {
			clearTimeout(this.stallTimeoutId);
			this.stallTimeoutId = null;
		}
		if (this.activeProbeController) {
			this.activeProbeController.abort();
			this.activeProbeController = null;
		}
	}

	private startLoadOutcome(token: number, expectPlay: boolean, timeoutMs: number) {
		this.cancelLoadOutcome('new-load');
		this.loadOutcomeToken = token;
		this.loadExpectPlay = expectPlay;
		this.loadStartedAt =
			typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
		this.lastProgressAt = Date.now();
		this.loadOutcome = new Promise((resolve) => {
			this.resolveLoadOutcome = resolve;
		});
		this.clearLoadTimers();
		this.loadTimeoutId = setTimeout(() => {
			this.resolveLoadOutcomeIfPending('timeout', { timeoutMs });
		}, timeoutMs);
	}

	private resolveLoadOutcomeIfPending(outcome: LoadOutcome, detail?: Record<string, unknown>) {
		if (!this.resolveLoadOutcome) {
			return;
		}
		if (this.loadOutcomeToken !== this.loadToken) {
			return;
		}
		if (outcome !== 'playing') {
			this.loadStartedAt = 0;
		}
		const resolve = this.resolveLoadOutcome;
		this.resolveLoadOutcome = null;
		this.clearLoadTimers();
		resolve(outcome);
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('load-outcome', createSnapshot(this.state, this.audio), {
				outcome,
				...detail
			});
		}
	}

	private cancelLoadOutcome(reason: string) {
		if (!this.resolveLoadOutcome) {
			return;
		}
		const resolve = this.resolveLoadOutcome;
		this.resolveLoadOutcome = null;
		this.clearLoadTimers();
		this.loadStartedAt = 0;
		resolve('canceled');
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('load-outcome', createSnapshot(this.state, this.audio), {
				outcome: 'canceled',
				reason
			});
		}
	}

	private async waitForLoadOutcome(token: number): Promise<LoadOutcome> {
		if (!this.loadOutcome || this.loadOutcomeToken !== token) {
			return 'canceled';
		}
		try {
			return await this.loadOutcome;
		} catch {
			return 'error';
		}
	}

	private markProgress() {
		this.lastProgressAt = Date.now();
		if (this.stallTimeoutId) {
			clearTimeout(this.stallTimeoutId);
			this.stallTimeoutId = null;
		}
	}

	private isLoadPending() {
		return Boolean(this.resolveLoadOutcome && this.loadOutcomeToken === this.loadToken);
	}

	private scheduleStallRecovery(reason: string) {
		if (this.stallTimeoutId) {
			return;
		}
		this.stallTimeoutId = setTimeout(() => {
			this.stallTimeoutId = null;
			const stalledFor = Date.now() - this.lastProgressAt;
			if (stalledFor < STALL_TIMEOUT_MS) {
				return;
			}
			this.resolveLoadOutcomeIfPending('stalled', { reason, stalledForMs: stalledFor });
			if (!this.isLoadPending() && this.state.status === 'buffering') {
				void this.retryCurrentTrack();
			}
		}, STALL_TIMEOUT_MS);
	}

	private canTransition(from: PlaybackStatus, to: PlaybackStatus): boolean {
		if (from === to) {
			return true;
		}
		const allowed = allowedTransitions[from] ?? [];
		return allowed.includes(to);
	}

	private setStatus(status: PlaybackStatus, reason?: string) {
		if (!this.canTransition(this.state.status, status)) {
			this.reportInvariant('invalid-transition', {
				from: this.state.status,
				to: status,
				reason
			});
			return;
		}
		this.dispatch({ type: 'SET_STATUS', status }, reason ? { reason } : undefined);
	}

	private dispatch(action: Parameters<typeof audioReducer>[1], detail?: Record<string, unknown>) {
		const next = audioReducer(this.state, action);
		this.state = next;
		this.setState(next);
		for (const subscriber of this.subscribers.values()) {
			subscriber(next);
		}
		if (audioTelemetry.enabled) {
			audioTelemetry.logState(action.type, next, detail);
		}
	}

	getState() {
		return this.state;
	}

	private attachListeners(target: AudioElementLike = this.audio) {
		target.addEventListener('loadstart', this.handleLoadStart);
		target.addEventListener('timeupdate', this.handleTimeUpdate);
		target.addEventListener('loadedmetadata', this.handleLoadedMetadata);
		target.addEventListener('loadeddata', this.handleLoadedData);
		target.addEventListener('durationchange', this.handleDurationChange);
		target.addEventListener('progress', this.handleProgress);
		target.addEventListener('canplay', this.handleCanPlay);
		target.addEventListener('canplaythrough', this.handleCanPlayThrough);
		target.addEventListener('playing', this.handlePlaying);
		target.addEventListener('play', this.handlePlay);
		target.addEventListener('pause', this.handlePause);
		target.addEventListener('abort', this.handleAbort);
		target.addEventListener('waiting', this.handleWaiting);
		target.addEventListener('stalled', this.handleStalled);
		target.addEventListener('ended', this.handleEnded);
		target.addEventListener('error', this.handleError);
		target.addEventListener('seeking', this.handleSeeking);
		target.addEventListener('seeked', this.handleSeeked);
	}

	private detachListeners(target: AudioElementLike = this.audio) {
		target.removeEventListener('loadstart', this.handleLoadStart);
		target.removeEventListener('timeupdate', this.handleTimeUpdate);
		target.removeEventListener('loadedmetadata', this.handleLoadedMetadata);
		target.removeEventListener('loadeddata', this.handleLoadedData);
		target.removeEventListener('durationchange', this.handleDurationChange);
		target.removeEventListener('progress', this.handleProgress);
		target.removeEventListener('canplay', this.handleCanPlay);
		target.removeEventListener('canplaythrough', this.handleCanPlayThrough);
		target.removeEventListener('playing', this.handlePlaying);
		target.removeEventListener('play', this.handlePlay);
		target.removeEventListener('pause', this.handlePause);
		target.removeEventListener('abort', this.handleAbort);
		target.removeEventListener('waiting', this.handleWaiting);
		target.removeEventListener('stalled', this.handleStalled);
		target.removeEventListener('ended', this.handleEnded);
		target.removeEventListener('error', this.handleError);
		target.removeEventListener('seeking', this.handleSeeking);
		target.removeEventListener('seeked', this.handleSeeked);
	}

	private shouldIgnoreEvent(): boolean {
		if (this.destroyed) {
			return true;
		}
		if (this.isUnlockingPlayback()) {
			return true;
		}
		if (!this.activeSrc) {
			return true;
		}
		if (this.activeSrc && this.audio.src && this.audio.src !== this.activeSrc) {
			return true;
		}
		return false;
	}

	private handleLoadStart = () => {
		if (this.shouldIgnoreEvent()) {
			return;
		}
		this.markProgress();
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('loadstart', createSnapshot(this.state, this.audio));
		}
	};

	private handleTimeUpdate = () => {
		if (this.shouldIgnoreEvent()) {
			return;
		}
		if (!this.state.currentTrack) {
			this.reportInvariant('timeupdate-without-track');
			return;
		}
		const now = Date.now();
		if (now - this.lastTimeUpdateAt < 250) {
			return;
		}
		this.lastTimeUpdateAt = now;
		if (this.pendingSeek !== null) {
			return;
		}
		this.markProgress();
		const currentTime = this.audio.currentTime ?? 0;
		if (Number.isFinite(currentTime)) {
			this.dispatch({ type: 'SET_TIME', currentTime });
		}
		this.updateBufferedPercent();
		this.updateMediaSessionPositionState(now);
		this.maybeStartCrossfade(currentTime);
		this.maybeTriggerProgressPrefetch(currentTime);
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('timeupdate', createSnapshot(this.state, this.audio));
		}
	};

	private handleCanPlayThrough = () => {
		if (this.shouldIgnoreEvent()) {
			return;
		}
		this.markProgress();
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('canplaythrough', createSnapshot(this.state, this.audio));
		}
	};

	private handleLoadedMetadata = () => {
		if (this.shouldIgnoreEvent()) {
			return;
		}
		this.markProgress();
		this.syncDuration();
		this.applyPendingSeek();
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('loadedmetadata', createSnapshot(this.state, this.audio));
		}
	};

	private handleLoadedData = () => {
		if (this.shouldIgnoreEvent()) {
			return;
		}
		this.markProgress();
		this.syncDuration();
		this.applyPendingSeek();
		this.setStatus(this.state.isPlaying ? 'playing' : 'paused', 'loadeddata');
		if (!this.loadExpectPlay) {
			this.resolveLoadOutcomeIfPending('ready', { event: 'loadeddata' });
		}
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('loadeddata', createSnapshot(this.state, this.audio));
		}
	};

	private handleDurationChange = () => {
		if (this.shouldIgnoreEvent()) {
			return;
		}
		this.markProgress();
		this.syncDuration();
		this.updateBufferedPercent();
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('durationchange', createSnapshot(this.state, this.audio));
		}
	};

	private handleProgress = () => {
		if (this.shouldIgnoreEvent()) {
			return;
		}
		this.markProgress();
		this.updateBufferedPercent();
	};

	private handleCanPlay = () => {
		if (this.shouldIgnoreEvent()) {
			return;
		}
		this.markProgress();
		if (this.pendingPlay) {
			this.setStatus('buffering', 'canplay');
		} else if (this.state.status === 'loading') {
			this.setStatus('paused', 'canplay');
		}
		if (!this.loadExpectPlay) {
			this.resolveLoadOutcomeIfPending('ready', { event: 'canplay' });
		}
		this.tryAutoPlay('canplay');
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('canplay', createSnapshot(this.state, this.audio));
		}
	};

	private handlePlaying = () => {
		if (this.shouldIgnoreEvent()) {
			return;
		}
		this.markProgress();
		this.setStatus('playing', 'playing');
		this.dispatch({ type: 'SET_NEEDS_GESTURE', needsGesture: false });
		this.retryCount = 0;
		let latencyMs: number | null = null;
		if (this.loadStartedAt > 0) {
			const now =
				typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
			latencyMs = Math.max(0, Math.round(now - this.loadStartedAt));
			this.loadStartedAt = 0;
		}
		if (latencyMs !== null) {
			audioTelemetry.recordPlaybackStart(latencyMs);
		}
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('playing', createSnapshot(this.state, this.audio), {
				startupLatencyMs: latencyMs ?? undefined
			});
		}
		this.resolveLoadOutcomeIfPending('playing', { event: 'playing' });
		const currentTrack = this.state.currentTrack;
		if (
			currentTrack &&
			this.activeStreamMeta &&
			this.activeStreamMeta.trackId === currentTrack.id
		) {
			streamCache.setValidated({
				trackId: currentTrack.id,
				quality: this.activeStreamMeta.quality,
				url: this.activeStreamMeta.url,
				replayGain: this.activeStreamMeta.replayGain,
				sampleRate: this.activeStreamMeta.sampleRate,
				bitDepth: this.activeStreamMeta.bitDepth,
				fetchedAt: this.activeStreamMeta.resolvedAt
			});
			if (audioTelemetry.enabled) {
				audioTelemetry.logEvent('stream-cache-write', createSnapshot(this.state, this.audio), {
					trackId: currentTrack.id,
					quality: this.activeStreamMeta.quality,
					source: this.activeStreamMeta.source
				});
			}
		}
		if (currentTrack && !isSonglinkTrack(currentTrack)) {
			this.recordRecentlyPlayed(currentTrack as Track);
		}
		void this.prefetchQueueWindow('playing', {
			count: PREFETCH_NEXT_COUNT,
			warmAll: true,
			warmRecent: true,
			allowRetry: true,
			allowSlow: true
		});
		this.updateMediaSessionPlaybackState();
	};

	private handlePlay = () => {
		if (this.shouldIgnoreEvent()) {
			return;
		}
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('play', createSnapshot(this.state, this.audio));
		}
	};

	private handlePause = () => {
		if (this.destroyed) {
			return;
		}
		if (this.shouldIgnoreEvent()) {
			return;
		}
		if (this.audio.ended) {
			return;
		}
		this.setStatus('paused', 'pause');
		this.updateMediaSessionPlaybackState();
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('pause', createSnapshot(this.state, this.audio));
		}
	};

	private handleAbort = () => {
		if (this.shouldIgnoreEvent()) {
			return;
		}
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('abort', createSnapshot(this.state, this.audio));
		}
	};

	private handleWaiting = () => {
		if (this.shouldIgnoreEvent()) {
			return;
		}
		this.setStatus('buffering', 'waiting');
		this.scheduleStallRecovery('waiting');
		this.updateMediaSessionPlaybackState();
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('waiting', createSnapshot(this.state, this.audio));
		}
	};

	private handleStalled = () => {
		if (this.shouldIgnoreEvent()) {
			return;
		}
		this.setStatus('buffering', 'stalled');
		this.scheduleStallRecovery('stalled');
		this.updateMediaSessionPlaybackState();
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('stalled', createSnapshot(this.state, this.audio));
		}
	};

	private handleEnded = () => {
		if (this.destroyed) {
			return;
		}
		if (this.shouldIgnoreEvent()) {
			return;
		}
		if (this.crossfade?.active) {
			return;
		}
		if (this.crossfadePreparing) {
			this.cancelCrossfade('ended');
		}
		if (this.endedToken === this.loadToken) {
			return;
		}
		this.endedToken = this.loadToken;
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('ended', createSnapshot(this.state, this.audio));
		}
		this.advanceAfterEnd();
	};

	private handleSeeking = () => {
		if (this.shouldIgnoreEvent()) {
			return;
		}
		this.setStatus(this.state.isPlaying ? 'buffering' : 'loading', 'seeking');
	};

	private handleSeeked = () => {
		if (this.shouldIgnoreEvent()) {
			return;
		}
		this.markProgress();
		this.pendingSeek = null;
		const currentTime = this.audio.currentTime ?? 0;
		if (Number.isFinite(currentTime)) {
			this.dispatch({ type: 'SET_TIME', currentTime });
		}
		this.setStatus(this.state.isPlaying ? 'playing' : 'paused', 'seeked');
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('seeked', createSnapshot(this.state, this.audio));
		}
		this.updateMediaSessionPositionState(Date.now());
		// Allow crossfade to retry immediately after a user seek near the end.
		this.lastCrossfadeAttemptAt = 0;
		this.lastCrossfadeTrackId = null;
		if (Number.isFinite(currentTime)) {
			this.maybeStartCrossfade(currentTime);
		}
		const seek = this.lastSeekRequest;
		this.lastSeekRequest = null;
		if (seek && this.isManualSeekReason(seek.reason)) {
			const duration = this.audio.duration;
			if (Number.isFinite(duration) && duration > 0 && Number.isFinite(currentTime)) {
				const progress = currentTime / duration;
				const count = this.resolveSeekPrefetchCount(progress);
				this.lastSeekPrefetchAt = Date.now();
				const currentId = this.state.currentTrack
					? isSonglinkTrack(this.state.currentTrack)
						? this.state.currentTrack.tidalId ?? null
						: this.state.currentTrack.id
					: null;
				if (currentId) {
					this.lastProgressPrefetchTrackId = currentId;
				}
				void this.prefetchQueueWindow(`seek-${Math.round(progress * 100)}`, {
					count,
					warmAll: true,
					warmRecent: true,
					force: true,
					allowRetry: true,
					allowSlow: true
				});
			}
		}
	};

	private handleError = () => {
		if (this.shouldIgnoreEvent()) {
			return;
		}
		this.cancelCrossfade('error');
		const errorCode = this.audio.error?.code;
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('error', createSnapshot(this.state, this.audio), {
				errorCode
			});
		}
		const message = 'Playback error';
		this.dispatch({ type: 'SET_ERROR', error: message });
		this.setStatus('error', 'error');
		this.updateMediaSessionPlaybackState();
		audioTelemetry.recordPlaybackFailure();
		const current = this.state.currentTrack;
		if (current && !isSonglinkTrack(current)) {
			if (this.activeStreamMeta && this.activeStreamMeta.trackId === current.id) {
				streamCache.recordFailure(current.id, this.activeStreamMeta.quality);
				if (this.activeStreamMeta.source === 'cache') {
					streamCache.invalidate(current.id, this.activeStreamMeta.quality);
				}
				losslessAPI.invalidateStreamDataCache(current.id, this.activeStreamMeta.quality);
			}
			if (!this.isLoadPending()) {
				void this.retryCurrentTrack();
			}
		}
		this.resolveLoadOutcomeIfPending('error', { errorCode });
	};
	private updateBufferedPercent() {
		const duration = this.audio.duration;
		if (!Number.isFinite(duration) || duration <= 0) {
			this.dispatch({ type: 'SET_BUFFERED', bufferedPercent: 0 });
			return;
		}
		const buffered = this.audio.buffered;
		if (!buffered || buffered.length === 0) {
			this.dispatch({ type: 'SET_BUFFERED', bufferedPercent: 0 });
			return;
		}
		let bufferedEnd = 0;
		for (let i = 0; i < buffered.length; i += 1) {
			const start = buffered.start(i);
			const end = buffered.end(i);
			if (start <= this.audio.currentTime && end >= this.audio.currentTime) {
				bufferedEnd = end;
				break;
			}
			bufferedEnd = Math.max(bufferedEnd, end);
		}
		const percent = clamp((bufferedEnd / duration) * 100, 0, 100);
		this.dispatch({ type: 'SET_BUFFERED', bufferedPercent: percent });
	}

	private syncDuration() {
		const duration = this.audio.duration;
		if (Number.isFinite(duration) && duration > 0) {
			this.dispatch({ type: 'SET_DURATION', duration });
		}
	}

	private applyPendingSeek() {
		if (this.pendingSeek === null) {
			return;
		}
		const target = this.pendingSeek;
		this.pendingSeek = null;
		this.performSeek(target, 'pending');
	}

	private updateMediaSessionMetadata() {
		if (!this.mediaSession.enabled) {
			return;
		}
		this.mediaSession.updateMetadata(this.state.currentTrack);
	}

	private updateMediaSessionPlaybackState() {
		if (!this.mediaSession.enabled) {
			return;
		}
		const state = this.state.isPlaying ? 'playing' : this.state.currentTrack ? 'paused' : 'none';
		this.mediaSession.updatePlaybackState(state);
	}

	private updateMediaSessionPositionState(now: number) {
		if (!this.mediaSession.enabled) {
			return;
		}
		if (now - this.lastPositionUpdateAt < 1000) {
			return;
		}
		this.lastPositionUpdateAt = now;
		this.mediaSession.updatePositionState();
	}

	private applyVolume() {
		const base = clamp(this.state.volume, 0, 1);
		const gain = this.state.replayGain ? Math.pow(10, this.state.replayGain / 20) : 1;
		const volume = clamp(base * gain, 0, 1);
		const muted = this.state.muted;
		if (this.crossfade?.active) {
			const nextGain = this.crossfade.nextReplayGain
				? Math.pow(10, this.crossfade.nextReplayGain / 20)
				: 1;
			const nextVolume = clamp(base * nextGain, 0, 1);
			const currentFade = clamp(1 - this.crossfade.progress, 0, 1);
			const nextFade = clamp(this.crossfade.progress, 0, 1);
			this.audio.volume = volume * currentFade;
			this.audio.muted = muted;
			this.crossfade.nextAudio.volume = nextVolume * nextFade;
			this.crossfade.nextAudio.muted = muted;
			return;
		}
		this.audio.volume = volume;
		this.audio.muted = muted;
	}

	private normalizeCrossfadeSeconds(value: number): number {
		if (!Number.isFinite(value)) {
			return 0;
		}
		return clamp(Math.round(value), CROSSFADE_MIN_SECONDS, CROSSFADE_MAX_SECONDS);
	}

	private isManualSeekReason(reason: string) {
		return ['ui', 'external', 'media-session', 'user', 'debug'].includes(reason);
	}

	private resolveSeekPrefetchCount(progress: number) {
		if (!Number.isFinite(progress)) {
			return PREFETCH_NEXT_COUNT;
		}
		if (progress < 0.25) {
			return 7;
		}
		if (progress < 0.5) {
			return 4;
		}
		if (progress < 0.75) {
			return 4;
		}
		if (progress < 0.85) {
			return 2;
		}
		return 1;
	}

	private resolveQualityForPrefetch(track: Track): AudioQuality {
		if (this.state.qualitySource === 'auto') {
			return deriveTrackQuality(track) ?? 'LOSSLESS';
		}
		return this.state.quality;
	}

	private getUpcomingIndices(limit: number): number[] {
		const { queue, queueIndex, repeatMode, shuffleEnabled } = this.state;
		if (!Number.isFinite(limit) || limit <= 0) {
			return [];
		}
		if (queue.length <= 1) {
			return [];
		}
		const allowWrap = repeatMode === 'all';
		const indices: number[] = [];
		const seen = new Set<number>();
		if (!shuffleEnabled) {
			let idx = queueIndex + 1;
			while (indices.length < limit) {
				if (idx >= queue.length) {
					if (!allowWrap) {
						break;
					}
					idx = 0;
				}
				if (idx === queueIndex || seen.has(idx)) {
					idx += 1;
					continue;
				}
				indices.push(idx);
				seen.add(idx);
				idx += 1;
			}
			return indices;
		}
		if (this.shuffleBag.length > 0) {
			for (const next of this.shuffleBag) {
				if (indices.length >= limit) {
					break;
				}
				if (next === queueIndex || seen.has(next)) {
					continue;
				}
				indices.push(next);
				seen.add(next);
			}
		}
		if (indices.length < limit && allowWrap) {
			const bag = this.buildShuffleBag(queue, queueIndex);
			for (const next of bag) {
				if (indices.length >= limit) {
					break;
				}
				if (next === queueIndex || seen.has(next)) {
					continue;
				}
				indices.push(next);
				seen.add(next);
			}
		}
		return indices;
	}

	private recordRecentlyPlayed(track: Track) {
		if (!track || !Number.isFinite(track.id)) {
			return;
		}
		const next = [track, ...this.recentTracks.filter((entry) => entry.id !== track.id)];
		this.recentTracks = next.slice(0, PREFETCH_HISTORY_COUNT);
	}

	private swapActiveAudio(nextAudio: AudioElementLike, nextRealAudio: HTMLAudioElement | null) {
		if (this.audio === nextAudio) {
			return;
		}
		this.detachListeners(this.audio);
		this.audio = nextAudio;
		this.realAudio = nextRealAudio;
		this.attachListeners(this.audio);
	}

	private getInactiveAudio(): { audio: AudioElementLike; realAudio: HTMLAudioElement | null } {
		if (this.audio === this.audioPrimary) {
			return { audio: this.audioSecondary, realAudio: this.realAudioSecondary };
		}
		return { audio: this.audioPrimary, realAudio: this.realAudioPrimary };
	}

	private async ensureShakaPlayer() {
		if (!this.realAudio) {
			throw new Error('Shaka player requires a real audio element');
		}
		if (!this.shakaNamespace) {
			// @ts-expect-error Shaka Player bundle is not typed.
			const module = await import('shaka-player/dist/shaka-player.compiled.js');
			const resolved =
				(module as ShakaModule | { default: ShakaNamespace }).default ??
				(module as unknown as ShakaNamespace);
			this.shakaNamespace = resolved;
			this.shakaNamespace?.polyfill?.installAll?.();
		}
		if (!this.shakaNamespace) {
			throw new Error('Shaka namespace unavailable');
		}
		if (!this.shakaPlayer) {
			this.shakaPlayer = new this.shakaNamespace.Player(this.realAudio);
			const networking = this.shakaPlayer.getNetworkingEngine?.();
			if (networking) {
				networking.registerRequestFilter((_type, request) => {
					if (request.method === 'HEAD') {
						request.method = 'GET';
					}
					if (Array.isArray(request.uris)) {
						request.uris = request.uris.map((uri) => getProxiedUrl(uri));
					}
				});
			}
		}
		return this.shakaPlayer;
	}

	private revokeDashObjectUrl() {
		if (this.dashObjectUrl) {
			URL.revokeObjectURL(this.dashObjectUrl);
			this.dashObjectUrl = null;
		}
	}

	private async destroyShakaPlayer() {
		this.revokeDashObjectUrl();
		if (this.shakaPlayer) {
			try {
				await this.shakaPlayer.destroy();
			} catch {
				// ignore teardown errors
			}
		}
		this.shakaPlayer = null;
	}

	private async resolveSonglinkTrack(track: SonglinkTrack): Promise<Track> {
		const existing = this.convertingTracks.get(track.id);
		if (existing) {
			return existing;
		}
		const conversion = (async () => {
			const resolved = await resolveSonglinkTrackToTidal(track, {
				userCountry: resolveUserCountry(),
				songIfSingle: true,
				fetchTrack: true
			});
			if (!resolved.track) {
				throw new Error('Unable to resolve track');
			}
			return resolved.track;
		})();
		this.convertingTracks.set(track.id, conversion);
		try {
			return await conversion;
		} finally {
			this.convertingTracks.delete(track.id);
		}
	}

	private async resolvePlayableTrack(track: PlayableTrack): Promise<{
		track: Track;
		wasSonglink: boolean;
		sourceId: number | string;
	}> {
		if (isSonglinkTrack(track)) {
			const resolved = await this.resolveSonglinkTrack(track);
			return { track: resolved, wasSonglink: true, sourceId: track.id };
		}
		return { track: track as Track, wasSonglink: false, sourceId: track.id };
	}

	private replaceResolvedTrack(sourceId: number | string, resolved: Track) {
		const queueIndex = this.state.queue.findIndex((entry) => entry.id === sourceId);
		if (queueIndex >= 0) {
			const queue = this.state.queue.slice();
			queue[queueIndex] = resolved;
			const currentTrack =
				this.state.currentTrack?.id === sourceId ? resolved : this.state.currentTrack;
			this.dispatch({
				type: 'SET_QUEUE',
				queue,
				queueIndex: this.state.queueIndex,
				currentTrack
			});
			return;
		}
		if (this.state.currentTrack?.id === sourceId) {
			this.dispatch({ type: 'SET_TRACK', track: resolved, queueIndex: this.state.queueIndex });
		}
	}

	private resolveQuality(track: Track): AudioQuality {
		if (this.state.qualitySource === 'auto') {
			const derived = deriveTrackQuality(track);
			const nextQuality: AudioQuality = derived ?? 'LOSSLESS';
			this.dispatch({ type: 'SET_QUALITY', quality: nextQuality, source: 'auto' });
			return nextQuality;
		}
		return this.state.quality;
	}

	private async resolveStreamCandidate(
		track: Track,
		quality: AudioQuality,
		options: { allowCache: boolean; attempt: number }
	): Promise<StreamCandidate | null> {
		const snapshot = createSnapshot(this.state, this.audio);
		if (options.allowCache) {
			const cached = streamCache.get(track.id, quality);
			if (cached) {
				audioTelemetry.recordCacheHit();
				if (audioTelemetry.enabled) {
					audioTelemetry.logEvent('resolve-cache-hit', snapshot, {
						trackId: track.id,
						quality,
						ageMs: Math.max(0, Date.now() - cached.validatedAt),
						attempt: options.attempt
					});
				}
				return {
					url: cached.url,
					quality,
					source: 'cache',
					replayGain: cached.replayGain ?? null,
					sampleRate: cached.sampleRate ?? null,
					bitDepth: cached.bitDepth ?? null,
					resolvedAt: cached.validatedAt
				};
			}
			audioTelemetry.recordCacheMiss();
			if (audioTelemetry.enabled) {
				audioTelemetry.logEvent('resolve-cache-miss', snapshot, {
					trackId: track.id,
					quality,
					attempt: options.attempt
				});
			}
		}

		const start = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
		audioTelemetry.recordResolveAttempt();
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('resolve-start', snapshot, {
				trackId: track.id,
				quality,
				attempt: options.attempt
			});
		}

		try {
			const data = await losslessAPI.getStreamData(track.id, quality);
			const end = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
			const latencyMs = Math.max(0, Math.round(end - start));
			audioTelemetry.recordResolveSuccess(latencyMs);
			if (audioTelemetry.enabled) {
				audioTelemetry.logEvent('resolve-success', snapshot, {
					trackId: track.id,
					quality,
					latencyMs
				});
			}
			return {
				url: data.url,
				quality,
				source: 'api',
				replayGain: data.replayGain ?? null,
				sampleRate: data.sampleRate ?? null,
				bitDepth: data.bitDepth ?? null,
				resolvedAt: Date.now()
			};
		} catch (error) {
			audioTelemetry.recordResolveFailure();
			if (audioTelemetry.enabled) {
				audioTelemetry.logEvent('resolve-failure', snapshot, {
					trackId: track.id,
					quality,
					attempt: options.attempt,
					message: error instanceof Error ? error.message : String(error)
				});
			}
			return null;
		}
	}

	private async applyStreamCandidate(track: Track, candidate: StreamCandidate, token: number) {
		await this.destroyShakaPlayer();
		if (this.useMock) {
			this.audio.src = `mock://track/${track.id}?q=${candidate.quality}`;
			this.activeSrc = this.audio.src;
			this.activeStreamMeta = null;
			(this.audio as MockAudioElement).setMockDuration(track.duration ?? 120);
			this.audio.load();
			this.dispatch({ type: 'SET_ACTIVE_QUALITY', activeQuality: candidate.quality });
			this.dispatch({
				type: 'SET_METADATA',
				sampleRate: null,
				bitDepth: null,
				replayGain: null
			});
			this.applyVolume();
			return;
		}
		if (token !== this.loadToken) {
			return;
		}
		const url = getProxiedUrl(candidate.url);
		this.activeStreamMeta = { ...candidate, trackId: track.id };
		this.audio.src = url;
		this.activeSrc = this.audio.src;
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('stream-src', createSnapshot(this.state, this.audio), {
				trackId: track.id,
				quality: candidate.quality,
				source: candidate.source,
				url: candidate.url,
				proxiedUrl: url
			});
		}
		this.audio.load();
		this.dispatch({ type: 'SET_ACTIVE_QUALITY', activeQuality: candidate.quality });
		this.dispatch({
			type: 'SET_METADATA',
			sampleRate: candidate.sampleRate ?? null,
			bitDepth: candidate.bitDepth ?? null,
			replayGain: candidate.replayGain ?? null
		});
		this.applyVolume();
	}

	private async loadStandardTrackWithRetries(
		track: Track,
		quality: AudioQuality,
		token: number
	): Promise<LoadOutcome> {
		if (this.useMock) {
			const candidate: StreamCandidate = {
				url: `mock://track/${track.id}?q=${quality}`,
				quality,
				source: 'api',
				replayGain: null,
				sampleRate: null,
				bitDepth: null,
				resolvedAt: Date.now()
			};
			this.startLoadOutcome(token, this.pendingPlay, this.pendingPlay ? LOAD_TIMEOUT_MS : READY_TIMEOUT_MS);
			await this.applyStreamCandidate(track, candidate, token);
			if (token !== this.loadToken) {
				return 'canceled';
			}
			if (this.pendingPlay) {
				void this.attemptPlay('load-track');
			}
			return this.waitForLoadOutcome(token);
		}
		let lastOutcome: LoadOutcome = 'error';
		for (let attempt = 1; attempt <= LOAD_ATTEMPT_LIMIT; attempt += 1) {
			if (token !== this.loadToken) {
				return 'canceled';
			}
			const allowCache = attempt === 1;
			const candidate = await this.resolveStreamCandidate(track, quality, {
				allowCache,
				attempt
			});
			if (!candidate) {
				lastOutcome = 'error';
				continue;
			}
			if (audioTelemetry.enabled) {
				audioTelemetry.logEvent('stream-candidate', createSnapshot(this.state, this.audio), {
					trackId: track.id,
					quality: candidate.quality,
					source: candidate.source,
					attempt
				});
			}
			void this.probeStreamUrl(candidate, token, attempt);
			this.startLoadOutcome(token, this.pendingPlay, this.pendingPlay ? LOAD_TIMEOUT_MS : READY_TIMEOUT_MS);
			await this.applyStreamCandidate(track, candidate, token);
			if (token !== this.loadToken) {
				return 'canceled';
			}
			if (this.pendingPlay) {
				void this.attemptPlay('load-track');
			}
			const outcome = await this.waitForLoadOutcome(token);
			if (outcome === 'playing' || outcome === 'ready' || outcome === 'blocked') {
				return outcome;
			}
			if (outcome === 'canceled') {
				return outcome;
			}
			if (outcome === 'timeout' || outcome === 'stalled') {
				audioTelemetry.recordPlaybackFailure();
			}
			lastOutcome = outcome;
			streamCache.recordFailure(track.id, quality);
			if (candidate.source === 'cache') {
				streamCache.invalidate(track.id, quality);
			}
			losslessAPI.invalidateStreamDataCache(track.id, quality);
			if (attempt < LOAD_ATTEMPT_LIMIT) {
				const delayMs = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)] ?? 0;
				if (delayMs > 0) {
					await new Promise((resolve) => setTimeout(resolve, delayMs));
				}
			}
		}
		return lastOutcome;
	}

	private async loadDashTrackWithOutcome(track: Track, token: number): Promise<LoadOutcome> {
		this.activeStreamMeta = null;
		this.startLoadOutcome(token, this.pendingPlay, this.pendingPlay ? LOAD_TIMEOUT_MS : READY_TIMEOUT_MS);
		await this.loadDashTrack(track, token);
		if (token !== this.loadToken) {
			return 'canceled';
		}
		if (this.pendingPlay) {
			void this.attemptPlay('load-dash');
		}
		return this.waitForLoadOutcome(token);
	}
	private async loadTrack(track: PlayableTrack, options?: LoadOptions) {
		if (this.destroyed) {
			return;
		}
		this.cancelCrossfade('load-track');
		const token = ++this.loadToken;
		this.endedToken = -1;
		this.activeSrc = null;
		this.activeStreamMeta = null;
		this.cancelLoadOutcome('track-change');
		this.clearLoadTimers();
		if (this.prefetchAbort) {
			this.prefetchAbort.abort();
			this.prefetchAbort = null;
			this.prefetching = false;
		}
		const resumeTime =
			typeof options?.resumeTime === 'number' && options.resumeTime > 0
				? options.resumeTime
				: null;
		const resetTime = options?.resetTime !== false;
		this.pendingSeek = resetTime ? 0 : resumeTime;
		if (typeof options?.shouldPlay === 'boolean') {
			this.pendingPlay = options.shouldPlay;
		}

		this.dispatch({ type: 'BUMP_GENERATION' });
		this.setStatus('loading', options?.reason ?? 'load-track');
		this.dispatch({ type: 'SET_ACTIVE_QUALITY', activeQuality: null });
		this.dispatch({ type: 'SET_ERROR', error: null });
		this.dispatch({ type: 'SET_BUFFERED', bufferedPercent: 0 });
		this.dispatch({ type: 'SET_METADATA', sampleRate: null, bitDepth: null, replayGain: null });

		if (resetTime) {
			this.dispatch({ type: 'SET_TIME', currentTime: 0 });
		}

		if (this.audio.paused === false) {
			this.audio.pause();
		}
		this.audio.loop = false;

		let resolvedTrack = track as Track;
		let wasSonglink = false;
		let sourceId = track.id;
		try {
			const resolved = await this.resolvePlayableTrack(track);
			resolvedTrack = resolved.track;
			wasSonglink = resolved.wasSonglink;
			sourceId = resolved.sourceId;
		} catch (error) {
			this.dispatch({
				type: 'SET_ERROR',
				error: error instanceof Error ? error.message : 'Track conversion failed'
			});
			this.setStatus('error', 'resolve-failed');
			return;
		}
		if (token !== this.loadToken) {
			return;
		}
		if (wasSonglink) {
			this.replaceResolvedTrack(sourceId, resolvedTrack);
		}
		const quality = this.resolveQuality(resolvedTrack as Track);
		const effectiveQuality = this.normalizeQuality(resolvedTrack as Track, quality);
		const isSuccess = (outcome: LoadOutcome | null) =>
			outcome === 'playing' || outcome === 'ready' || outcome === 'blocked';
		let outcome: LoadOutcome | null = null;
		try {
			if (hiResQualities.has(effectiveQuality)) {
				try {
					outcome = await this.loadDashTrackWithOutcome(resolvedTrack as Track, token);
				} catch (error) {
					if (token !== this.loadToken) {
						return;
					}
					if (dev) {
						console.warn('DASH load failed, falling back to lossless', error);
					}
				}
				if (!isSuccess(outcome)) {
					outcome = await this.loadStandardTrackWithRetries(resolvedTrack as Track, 'LOSSLESS', token);
				}
			} else {
				outcome = await this.loadStandardTrackWithRetries(
					resolvedTrack as Track,
					effectiveQuality,
					token
				);
				if (!isSuccess(outcome) && effectiveQuality !== 'LOSSLESS') {
					outcome = await this.loadStandardTrackWithRetries(resolvedTrack as Track, 'LOSSLESS', token);
				}
			}
			if (
				token === this.loadToken &&
				options?.resetTime === false &&
				options?.resumeTime &&
				options.resumeTime > 0
			) {
				this.pendingSeek = options.resumeTime;
			}
			if (outcome === 'canceled') {
				return;
			}
			if (!isSuccess(outcome)) {
				throw new Error('Unable to load stream');
			}
		} catch (error) {
			if (token !== this.loadToken) {
				return;
			}
			audioTelemetry.recordPlaybackFailure();
			this.dispatch({
				type: 'SET_ERROR',
				error: error instanceof Error ? error.message : 'Unable to load stream'
			});
			this.setStatus('error', 'load-failed');
			this.pendingPlay = false;
		}
		this.updateMediaSessionMetadata();
		this.updateMediaSessionPlaybackState();
		this.tryAutoPlay('load-track');
	}

	private normalizeQuality(track: Track, requested: AudioQuality): AudioQuality {
		const trackBest = deriveTrackQuality(track);
		if (hiResQualities.has(requested) && trackBest && !hiResQualities.has(trackBest)) {
			return trackBest;
		}
		return requested;
	}

	private async loadDashTrack(track: Track, token: number) {
		if (!this.realAudio || this.useMock) {
			throw new Error('DASH playback unavailable for this environment');
		}
		const manifest = await losslessAPI.getDashManifestWithMetadata(track.id, 'HI_RES_LOSSLESS');
		if (token !== this.loadToken) {
			return;
		}
		if (manifest.result.kind === 'flac') {
			throw new Error('DASH manifest returned direct stream');
		}
		this.revokeDashObjectUrl();
		const blob = new Blob([manifest.result.manifest], {
			type: manifest.result.contentType ?? 'application/dash+xml'
		});
		this.dashObjectUrl = URL.createObjectURL(blob);
		const player = await this.ensureShakaPlayer();
		if (token !== this.loadToken) {
			return;
		}
		await player.unload();
		this.activeSrc = this.dashObjectUrl;
		await player.load(this.dashObjectUrl);
		this.activeSrc = this.realAudio.currentSrc || this.dashObjectUrl;
		this.dispatch({ type: 'SET_ACTIVE_QUALITY', activeQuality: 'HI_RES_LOSSLESS' });
		this.dispatch({
			type: 'SET_METADATA',
			sampleRate: manifest.trackInfo.sampleRate ?? null,
			bitDepth: manifest.trackInfo.bitDepth ?? null,
			replayGain: manifest.trackInfo.replayGain ?? null
		});
		this.applyVolume();
	}

	private async probeStreamUrl(candidate: StreamCandidate, token: number, attempt: number) {
		if (!audioTelemetry.enabled || this.useMock) {
			return;
		}
		if (token !== this.loadToken) {
			return;
		}
		if (this.activeProbeController) {
			this.activeProbeController.abort();
		}
		const controller = new AbortController();
		this.activeProbeController = controller;
		const probeUrl = getProxiedUrl(candidate.url);
		const startedAt =
			typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
		const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
		try {
			const response = await fetch(probeUrl, {
				method: 'GET',
				headers: {
					Range: `bytes=0-${PREFETCH_RANGE_BYTES}`
				},
				signal: controller.signal
			});
			const endedAt =
				typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
			const latencyMs = Math.max(0, Math.round(endedAt - startedAt));
			const contentType = response.headers.get('content-type');
			const acceptRanges = response.headers.get('accept-ranges');
			const contentRange = response.headers.get('content-range');
			void response.body?.cancel?.();
			audioTelemetry.logEvent('stream-probe', createSnapshot(this.state, this.audio), {
				trackId: this.state.currentTrack?.id ?? null,
				quality: candidate.quality,
				source: candidate.source,
				attempt,
				status: response.status,
				latencyMs,
				contentType,
				acceptRanges,
				contentRange,
				redirected: response.redirected,
				finalUrl: response.url
			});
		} catch (error) {
			const endedAt =
				typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
			const latencyMs = Math.max(0, Math.round(endedAt - startedAt));
			audioTelemetry.logEvent('stream-probe-failure', createSnapshot(this.state, this.audio), {
				trackId: this.state.currentTrack?.id ?? null,
				quality: candidate.quality,
				source: candidate.source,
				attempt,
				latencyMs,
				message: error instanceof Error ? error.message : String(error)
			});
		} finally {
			clearTimeout(timeoutId);
			if (this.activeProbeController === controller) {
				this.activeProbeController = null;
			}
		}
	}

	private shouldPrefetch(options?: { allowSlow?: boolean; ignoreGuard?: boolean }): boolean {
		if (this.prefetching) {
			return false;
		}
		const now = Date.now();
		if (!options?.ignoreGuard && now - this.lastPrefetchAt < PREFETCH_GUARD_MS) {
			return false;
		}
		if (typeof navigator === 'undefined') {
			return false;
		}
		const connection = (navigator as Navigator & {
			connection?: { saveData?: boolean; effectiveType?: string };
		}).connection;
		if (connection?.saveData) {
			return false;
		}
		if (
			!options?.allowSlow &&
			connection?.effectiveType &&
			['slow-2g', '2g'].includes(connection.effectiveType)
		) {
			return false;
		}
		return true;
	}

	private async warmStreamUrl(
		url: string,
		signal: AbortSignal,
		trackId: number,
		quality: AudioQuality
	) {
		const start = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
		try {
			const response = await fetch(url, {
				method: 'GET',
				headers: {
					Range: `bytes=0-${PREFETCH_RANGE_BYTES}`
				},
				signal
			});
			void response.body?.cancel?.();
			if (audioTelemetry.enabled) {
				const end =
					typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
				audioTelemetry.logEvent('prefetch-warm', createSnapshot(this.state, this.audio), {
					trackId,
					quality,
					status: response.status,
					latencyMs: Math.max(0, Math.round(end - start))
				});
			}
		} catch (error) {
			if (audioTelemetry.enabled) {
				const end =
					typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
				audioTelemetry.logEvent('prefetch-warm-failure', createSnapshot(this.state, this.audio), {
					trackId,
					quality,
					latencyMs: Math.max(0, Math.round(end - start)),
					message: error instanceof Error ? error.message : String(error)
				});
			}
		}
	}

	private async prefetchQueueWindow(
		trigger: string,
		options?: {
			count?: number;
			warmAll?: boolean;
			warmRecent?: boolean;
			force?: boolean;
			allowSlow?: boolean;
			allowRetry?: boolean;
		}
	): Promise<number> {
		if (this.useMock) {
			return 0;
		}
		if (this.prefetching && options?.force && this.prefetchAbort) {
			this.prefetchAbort.abort();
			this.prefetchAbort = null;
			this.prefetching = false;
		}
		if (this.prefetching && !options?.force) {
			return 0;
		}
		const allowSlow = options?.allowSlow ?? true;
		const ignoreGuard = Boolean(options?.force);
		if (!this.shouldPrefetch({ allowSlow, ignoreGuard })) {
			return 0;
		}
		const upcomingCount = options?.count ?? PREFETCH_NEXT_COUNT;
		const upcomingIndices = this.getUpcomingIndices(upcomingCount);
		const upcoming = upcomingIndices
			.map((index) => this.state.queue[index])
			.filter((track): track is PlayableTrack => Boolean(track));
		const current = this.state.currentTrack;
		const recent = this.recentTracks.filter((track) => track.id !== current?.id);

		const items: Array<{ trackId: number; quality: AudioQuality; warm: boolean }> = [];
		const seen = new Set<string>();
		const pushItem = (trackId: number, quality: AudioQuality, warm: boolean) => {
			const key = `${trackId}:${quality}`;
			if (seen.has(key)) {
				return;
			}
			seen.add(key);
			items.push({ trackId, quality, warm });
		};

		const warmAll = Boolean(options?.warmAll);
		const warmRecent = Boolean(options?.warmRecent);
		const resolveAttempts = options?.allowRetry ? PREFETCH_RESOLVE_ATTEMPTS : 1;
		const delayForAttempt = async (attempt: number) => {
			const delayMs = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)] ?? 0;
			if (delayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			}
		};

		for (const track of upcoming) {
			let resolvedTrack: Track | null = null;
			let trackId: number | null = null;
			for (let attempt = 1; attempt <= resolveAttempts; attempt += 1) {
				if (isSonglinkTrack(track)) {
					if (!track.tidalId || this.state.qualitySource === 'auto') {
						try {
							resolvedTrack = await this.resolveSonglinkTrack(track);
							this.replaceResolvedTrack(track.id, resolvedTrack);
						} catch {
							resolvedTrack = null;
						}
					}
					trackId = resolvedTrack?.id ?? track.tidalId ?? null;
				} else {
					resolvedTrack = track as Track;
					trackId = resolvedTrack.id;
				}
				if (Number.isFinite(trackId)) {
					break;
				}
				if (attempt < resolveAttempts) {
					await delayForAttempt(attempt);
				}
			}
			if (!Number.isFinite(trackId)) {
				continue;
			}
			const preferred = resolvedTrack ? this.resolveQualityForPrefetch(resolvedTrack) : this.state.quality;
			const effectiveQuality = resolvedTrack ? this.normalizeQuality(resolvedTrack, preferred) : preferred;
			pushItem(trackId, effectiveQuality, warmAll || items.length === 0);
		}

		const warmRecentCount = warmRecent ? PREFETCH_RECENT_WARM_COUNT : 0;
		for (const track of recent.slice(0, warmRecentCount || recent.length)) {
			const preferred = this.resolveQualityForPrefetch(track);
			const effectiveQuality = this.normalizeQuality(track, preferred);
			pushItem(track.id, effectiveQuality, warmRecent);
		}

		if (items.length === 0) {
			return 0;
		}

		if (this.prefetchAbort) {
			this.prefetchAbort.abort();
		}
		this.prefetching = true;
		this.lastPrefetchAt = Date.now();
		const controller = new AbortController();
		this.prefetchAbort = controller;
		let resolvedCount = 0;
		try {
			for (const item of items) {
				if (controller.signal.aborted) {
					return resolvedCount;
				}
				const cached = streamCache.get(item.trackId, item.quality);
				if (cached) {
					if (item.warm) {
						await this.warmStreamUrl(
							getProxiedUrl(cached.url),
							controller.signal,
							item.trackId,
							item.quality
						);
					}
					resolvedCount += 1;
					continue;
				}
				let resolved = false;
				for (let attempt = 1; attempt <= resolveAttempts; attempt += 1) {
					if (controller.signal.aborted) {
						return resolvedCount;
					}
					try {
						const data = await losslessAPI.getStreamData(item.trackId, item.quality);
						streamCache.setValidated({
							trackId: item.trackId,
							quality: item.quality,
							url: data.url,
							replayGain: data.replayGain ?? null,
							sampleRate: data.sampleRate ?? null,
							bitDepth: data.bitDepth ?? null,
							fetchedAt: Date.now()
						});
						resolved = true;
						resolvedCount += 1;
						audioTelemetry.recordPrefetch();
						if (audioTelemetry.enabled) {
							audioTelemetry.logEvent('prefetch-resolve', createSnapshot(this.state, this.audio), {
								trackId: item.trackId,
								quality: item.quality,
								trigger,
								attempt
							});
						}
						if (controller.signal.aborted) {
							return;
						}
						if (item.warm) {
							await this.warmStreamUrl(
								getProxiedUrl(data.url),
								controller.signal,
								item.trackId,
								item.quality
							);
						}
						break;
					} catch (error) {
						if (audioTelemetry.enabled) {
							audioTelemetry.logEvent('prefetch-failure', createSnapshot(this.state, this.audio), {
								trackId: item.trackId,
								trigger,
								attempt,
								message: error instanceof Error ? error.message : String(error)
							});
						}
						if (attempt < resolveAttempts) {
							await delayForAttempt(attempt);
						}
					}
				}
				if (!resolved && audioTelemetry.enabled) {
					audioTelemetry.logEvent('prefetch-abort-item', createSnapshot(this.state, this.audio), {
						trackId: item.trackId,
						trigger
					});
				}
			}
		} finally {
			this.prefetching = false;
			if (this.prefetchAbort === controller) {
				this.prefetchAbort = null;
			}
		}
		return resolvedCount;
	}

	private maybeStartCrossfade(currentTime: number) {
		if (this.crossfade || this.crossfadePreparing) {
			return;
		}
		if (this.state.status !== 'playing') {
			return;
		}
		if (this.state.repeatMode === 'one') {
			return;
		}
		const seconds = this.normalizeCrossfadeSeconds(this.state.crossfadeSeconds);
		if (seconds <= 0) {
			return;
		}
		if (hiResQualities.has(this.state.activeQuality ?? 'LOSSLESS')) {
			return;
		}
		const duration = this.audio.duration;
		if (!Number.isFinite(duration) || duration <= 0) {
			return;
		}
		const remaining = duration - currentTime;
		if (!Number.isFinite(remaining) || remaining > seconds || remaining <= 0) {
			return;
		}
		const nowMs = Date.now();
		const currentId = this.state.currentTrack
			? isSonglinkTrack(this.state.currentTrack)
				? this.state.currentTrack.tidalId ?? null
				: this.state.currentTrack.id
			: null;
		if (
			currentId &&
			this.lastCrossfadeTrackId === currentId &&
			nowMs - this.lastCrossfadeAttemptAt < 2000
		) {
			return;
		}
		const nextIndex = this.getUpcomingIndices(1)[0];
		if (!Number.isFinite(nextIndex)) {
			return;
		}
		const nextTrack = this.state.queue[nextIndex];
		if (!nextTrack) {
			return;
		}
		if (currentId) {
			this.lastCrossfadeAttemptAt = nowMs;
			this.lastCrossfadeTrackId = currentId;
		}
		void this.startCrossfade(nextIndex, nextTrack, seconds);
	}

	private maybeTriggerProgressPrefetch(currentTime: number) {
		if (this.state.status !== 'playing') {
			return;
		}
		const duration = this.audio.duration;
		if (!Number.isFinite(duration) || duration <= 0) {
			return;
		}
		const progress = currentTime / duration;
		if (!Number.isFinite(progress) || progress < 0.5) {
			return;
		}
		const currentId = this.state.currentTrack
			? isSonglinkTrack(this.state.currentTrack)
				? this.state.currentTrack.tidalId ?? null
				: this.state.currentTrack.id
			: null;
		if (!currentId || this.lastProgressPrefetchTrackId === currentId) {
			return;
		}
		if (Date.now() - this.lastSeekPrefetchAt < 3000) {
			return;
		}
		this.lastProgressPrefetchTrackId = currentId;
		void this.prefetchQueueWindow('progress-50', {
			count: 5,
			warmAll: true,
			warmRecent: true,
			force: true,
			allowRetry: true,
			allowSlow: true
		});
	}

	private async waitForCrossfadeReady(
		audio: AudioElementLike,
		token: number,
		timeoutMs: number = CROSSFADE_READY_TIMEOUT_MS
	): Promise<boolean> {
		if (token !== this.crossfadeToken) {
			return false;
		}
		if (audio.readyState >= 2) {
			return true;
		}
		return new Promise((resolve) => {
			let resolved = false;
			const finish = (result: boolean) => {
				if (resolved) {
					return;
				}
				resolved = true;
				audio.removeEventListener('canplay', handleReady);
				audio.removeEventListener('loadedmetadata', handleReady);
				audio.removeEventListener('error', handleError);
				clearTimeout(timeoutId);
				resolve(result && token === this.crossfadeToken);
			};
			const handleReady = () => finish(true);
			const handleError = () => finish(false);
			const timeoutId = setTimeout(() => finish(false), timeoutMs);
			audio.addEventListener('canplay', handleReady);
			audio.addEventListener('loadedmetadata', handleReady);
			audio.addEventListener('error', handleError);
		});
	}

	private async prepareCrossfadeTrack(
		nextTrack: PlayableTrack,
		token: number
	): Promise<{
		nextTrack: Track;
		nextPreferredQuality: AudioQuality;
		nextAudio: AudioElementLike;
		nextRealAudio: HTMLAudioElement | null;
		nextStreamMeta: ActiveStreamMeta;
	} | null> {
		let resolvedTrack: Track;
		let wasSonglink = false;
		let sourceId = nextTrack.id;
		try {
			const resolved = await this.resolvePlayableTrack(nextTrack);
			resolvedTrack = resolved.track;
			wasSonglink = resolved.wasSonglink;
			sourceId = resolved.sourceId;
		} catch {
			return null;
		}
		if (token !== this.crossfadeToken) {
			return null;
		}
		if (wasSonglink) {
			this.replaceResolvedTrack(sourceId, resolvedTrack);
		}
		const preferred = this.resolveQualityForPrefetch(resolvedTrack);
		const effectiveQuality = this.normalizeQuality(resolvedTrack, preferred);
		if (hiResQualities.has(effectiveQuality)) {
			return null;
		}

		let candidate: StreamCandidate | null = null;
		if (this.useMock) {
			candidate = {
				url: `mock://track/${resolvedTrack.id}?q=${effectiveQuality}`,
				quality: effectiveQuality,
				source: 'api',
				replayGain: null,
				sampleRate: null,
				bitDepth: null,
				resolvedAt: Date.now()
			};
		} else {
			candidate = await this.resolveStreamCandidate(resolvedTrack, effectiveQuality, {
				allowCache: true,
				attempt: 1
			});
		}
		if (!candidate || token !== this.crossfadeToken) {
			return null;
		}

		const { audio: nextAudio, realAudio: nextRealAudio } = this.getInactiveAudio();
		const cleanup = () => {
			nextAudio.pause();
			nextAudio.currentTime = 0;
			nextAudio.src = '';
		};
		nextAudio.pause();
		nextAudio.currentTime = 0;
		nextAudio.src = getProxiedUrl(candidate.url);
		nextAudio.load();

		const ready = await this.waitForCrossfadeReady(nextAudio, token);
		if (!ready || token !== this.crossfadeToken) {
			cleanup();
			return null;
		}

		const nextStreamMeta: ActiveStreamMeta = {
			...candidate,
			trackId: resolvedTrack.id
		};

		return {
			nextTrack: resolvedTrack,
			nextPreferredQuality: preferred,
			nextAudio,
			nextRealAudio,
			nextStreamMeta
		};
	}

	private async startCrossfade(nextIndex: number, nextTrack: PlayableTrack, seconds: number) {
		if (this.crossfade || this.crossfadePreparing) {
			return;
		}
		if (this.destroyed) {
			return;
		}
		this.crossfadePreparing = true;
		const token = ++this.crossfadeToken;
		try {
			const prepared = await this.prepareCrossfadeTrack(nextTrack, token);
			if (!prepared || token !== this.crossfadeToken) {
				return;
			}
			const {
				nextAudio,
				nextRealAudio,
				nextStreamMeta,
				nextTrack: resolvedTrack,
				nextPreferredQuality
			} = prepared;
			nextAudio.volume = 0;
			nextAudio.muted = this.state.muted;
			try {
				await nextAudio.play();
			} catch {
				nextAudio.pause();
				nextAudio.currentTime = 0;
				nextAudio.src = '';
				return;
			}
			if (token !== this.crossfadeToken) {
				return;
			}
			const currentTime = Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0;
			const duration = this.audio.duration;
			const remaining =
				Number.isFinite(duration) && duration > 0 ? Math.max(0, duration - currentTime) : seconds;
			const durationSec = Math.max(0.2, Math.min(seconds, remaining || seconds));
			this.crossfade = {
				active: true,
				startTime: currentTime,
				durationSec,
				progress: 0,
				nextIndex,
				nextTrack: resolvedTrack,
				nextPreferredQuality,
				nextAudio,
				nextRealAudio,
				nextStreamMeta,
				nextReplayGain: nextStreamMeta.replayGain ?? null,
				rafId: null
			};
			this.applyVolume();
			this.tickCrossfade(token);
		} finally {
			if (token === this.crossfadeToken) {
				this.crossfadePreparing = false;
			}
		}
	}

	private tickCrossfade(token: number) {
		const state = this.crossfade;
		if (!state || token !== this.crossfadeToken) {
			return;
		}
		const currentTime = Number.isFinite(this.audio.currentTime)
			? this.audio.currentTime
			: state.startTime;
		const elapsed = Math.max(0, currentTime - state.startTime);
		const progress = clamp(elapsed / state.durationSec, 0, 1);
		state.progress = progress;
		this.crossfade = state;
		this.applyVolume();
		if (progress >= 1) {
			this.finishCrossfade(token);
			return;
		}
		if (typeof requestAnimationFrame === 'function') {
			state.rafId = requestAnimationFrame(() => this.tickCrossfade(token));
		} else {
			state.rafId = (setTimeout(() => this.tickCrossfade(token), 50) as unknown) as number;
		}
	}

	private finishCrossfade(token: number) {
		const state = this.crossfade;
		if (!state || token !== this.crossfadeToken) {
			return;
		}
		if (state.rafId) {
			if (typeof cancelAnimationFrame === 'function') {
				cancelAnimationFrame(state.rafId);
			} else {
				clearTimeout(state.rafId);
			}
		}
		const oldAudio = this.audio;
		this.activeSrc = null;
		oldAudio.pause();
		oldAudio.currentTime = 0;
		oldAudio.src = '';

		this.swapActiveAudio(state.nextAudio, state.nextRealAudio);
		this.activeSrc = this.audio.src;
		this.activeStreamMeta = state.nextStreamMeta;
		this.commitShuffleAdvance(state.nextIndex);

		this.dispatch({ type: 'SET_TRACK', track: state.nextTrack, queueIndex: state.nextIndex });
		if (this.state.qualitySource === 'auto') {
			this.dispatch({
				type: 'SET_QUALITY',
				quality: state.nextPreferredQuality,
				source: 'auto'
			});
		}
		this.syncDuration();
		const currentTime = this.audio.currentTime ?? 0;
		if (Number.isFinite(currentTime) && currentTime > 0) {
			this.dispatch({ type: 'SET_TIME', currentTime });
		}
		this.dispatch({ type: 'SET_ACTIVE_QUALITY', activeQuality: state.nextStreamMeta.quality });
		this.dispatch({
			type: 'SET_METADATA',
			sampleRate: state.nextStreamMeta.sampleRate ?? null,
			bitDepth: state.nextStreamMeta.bitDepth ?? null,
			replayGain: state.nextStreamMeta.replayGain ?? null
		});
		this.dispatch({ type: 'SET_ERROR', error: null });
		this.setStatus('playing', 'crossfade');
		this.pendingPlay = false;
		this.updateMediaSessionMetadata();
		this.updateMediaSessionPlaybackState();
		this.updateMediaSessionPositionState(Date.now());
		this.mediaSession.refreshHandlers();
		this.recordRecentlyPlayed(state.nextTrack);
		streamCache.setValidated({
			trackId: state.nextTrack.id,
			quality: state.nextStreamMeta.quality,
			url: state.nextStreamMeta.url,
			replayGain: state.nextStreamMeta.replayGain,
			sampleRate: state.nextStreamMeta.sampleRate,
			bitDepth: state.nextStreamMeta.bitDepth,
			fetchedAt: state.nextStreamMeta.resolvedAt
		});
		void this.prefetchQueueWindow('crossfade', {
			count: PREFETCH_NEXT_COUNT,
			warmAll: true,
			warmRecent: true,
			allowRetry: true,
			allowSlow: true
		});
		this.applyVolume();
		this.crossfade = null;
	}

	private cancelCrossfade(reason: string) {
		if (!this.crossfade && !this.crossfadePreparing) {
			return;
		}
		this.crossfadeToken += 1;
		this.crossfadePreparing = false;
		const state = this.crossfade;
		if (state?.rafId) {
			if (typeof cancelAnimationFrame === 'function') {
				cancelAnimationFrame(state.rafId);
			} else {
				clearTimeout(state.rafId);
			}
		}
		if (state?.nextAudio) {
			state.nextAudio.pause();
			state.nextAudio.currentTime = 0;
			state.nextAudio.src = '';
		}
		this.crossfade = null;
		this.applyVolume();
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('crossfade-cancel', createSnapshot(this.state, this.audio), { reason });
		}
	}

	private async retryCurrentTrack() {
		const track = this.state.currentTrack;
		if (!track || isSonglinkTrack(track)) {
			return;
		}
		const now = Date.now();
		const shouldReset = now - this.lastRetryAt > 15000;
		const retryIndex = shouldReset ? 0 : this.retryCount;
		this.retryCount = retryIndex + 1;
		this.lastRetryAt = now;
		const delayMs = RETRY_BACKOFF_MS[Math.min(retryIndex, RETRY_BACKOFF_MS.length - 1)] ?? 0;
		if (delayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
		const token = ++this.loadToken;
		this.dispatch({ type: 'BUMP_GENERATION' });
		const resumeTime = this.audio.currentTime ?? this.state.currentTime;
		await this.loadTrack(track, { resumeTime, reason: 'retry', resetTime: false });
		if (token !== this.loadToken) {
			return;
		}
		this.tryAutoPlay('retry');
	}

	private tryAutoPlay(reason: string) {
		if (!this.pendingPlay || !this.state.currentTrack) {
			return;
		}
		if (!this.activeSrc) {
			return;
		}
		void this.attemptPlay(reason);
	}

	private async attemptPlay(reason: string) {
		if (!this.state.currentTrack) {
			return;
		}
		if (this.playInFlight) {
			return;
		}
		this.playInFlight = true;
		this.endedToken = -1;
		this.pendingPlay = true;
		this.logCommand('play', { reason });
		try {
			await this.audio.play();
			this.unlocked = true;
			this.pendingPlay = false;
			this.dispatch({ type: 'SET_NEEDS_GESTURE', needsGesture: false });
			this.resolveLoadOutcomeIfPending('playing', { event: 'play-resolved' });
		} catch (error) {
			const name = error instanceof DOMException ? error.name : 'Error';
			this.pendingPlay = false;
			if (name === 'NotAllowedError') {
				this.dispatch({ type: 'SET_NEEDS_GESTURE', needsGesture: true });
				this.setStatus('blocked', 'gesture');
				this.resolveLoadOutcomeIfPending('blocked', { event: 'play-rejected', name });
			} else {
				this.dispatch({
					type: 'SET_ERROR',
					error: error instanceof Error ? error.message : 'Play failed'
				});
				this.setStatus('error', 'play-failed');
				audioTelemetry.recordPlaybackFailure();
				this.resolveLoadOutcomeIfPending('error', { event: 'play-rejected', name });
			}
			if (audioTelemetry.enabled) {
				audioTelemetry.logEvent('play-reject', createSnapshot(this.state, this.audio), {
					name,
					message: error instanceof Error ? error.message : String(error)
				});
			}
		} finally {
			this.playInFlight = false;
		}
	}

	private advanceAfterEnd() {
		if (this.state.repeatMode === 'one') {
			this.seekTo(0, 'repeat-one');
			this.play('repeat-one');
			return;
		}
		const wasPlaying = this.state.isPlaying;
		const nextIndex = this.getNextIndex();
		if (nextIndex === null) {
			this.pendingPlay = false;
			this.pause('ended');
			return;
		}
		this.playAtIndex(nextIndex, { reason: 'ended', shouldPlay: wasPlaying });
	}

	private getNextIndex(): number | null {
		const { queue, queueIndex, repeatMode, shuffleEnabled } = this.state;
		if (queue.length === 0) {
			return null;
		}
		const allowWrap = repeatMode === 'all';
		if (!shuffleEnabled) {
			if (queueIndex < queue.length - 1) {
				return queueIndex + 1;
			}
			return allowWrap ? 0 : null;
		}
		if (queue.length <= 1) {
			return allowWrap ? queueIndex : null;
		}
		if (this.shuffleBag.length === 0) {
			if (!allowWrap) {
				return null;
			}
			this.shuffleBag = this.buildShuffleBag(queue, queueIndex);
		}
		const nextIndex = this.shuffleBag.shift();
		if (typeof nextIndex !== 'number') {
			return null;
		}
		this.shuffleHistory.push(queueIndex);
		return nextIndex;
	}

	private commitShuffleAdvance(nextIndex: number) {
		const { queue, queueIndex, repeatMode, shuffleEnabled } = this.state;
		if (!shuffleEnabled || queue.length <= 1) {
			return;
		}
		const allowWrap = repeatMode === 'all';
		if (this.shuffleBag.length === 0) {
			if (!allowWrap) {
				return;
			}
			this.shuffleBag = this.buildShuffleBag(queue, queueIndex);
		}
		if (this.shuffleBag.length > 0) {
			if (this.shuffleBag[0] === nextIndex) {
				this.shuffleBag.shift();
			} else {
				const idx = this.shuffleBag.indexOf(nextIndex);
				if (idx >= 0) {
					this.shuffleBag.splice(idx, 1);
				}
			}
		}
		this.shuffleHistory.push(queueIndex);
	}

	private getPreviousIndex(): number | null {
		const { queue, queueIndex, repeatMode, shuffleEnabled } = this.state;
		if (queue.length === 0) {
			return null;
		}
		const allowWrap = repeatMode === 'all';
		if (!shuffleEnabled) {
			if (queueIndex > 0) {
				return queueIndex - 1;
			}
			return allowWrap ? Math.max(0, queue.length - 1) : null;
		}
		if (this.shuffleHistory.length > 0) {
			return this.shuffleHistory.pop() ?? null;
		}
		return allowWrap ? Math.max(0, queue.length - 1) : null;
	}

	private buildShuffleBag(queue: PlayableTrack[], currentIndex: number): number[] {
		const indices: number[] = [];
		for (let i = 0; i < queue.length; i += 1) {
			if (i !== currentIndex) {
				indices.push(i);
			}
		}
		for (let i = indices.length - 1; i > 0; i -= 1) {
			const j = Math.floor(this.random() * (i + 1));
			[indices[i], indices[j]] = [indices[j]!, indices[i]!];
		}
		return indices;
	}

	private resetShuffle() {
		this.shuffleBag = [];
		this.shuffleHistory = [];
		if (this.state.shuffleEnabled) {
			this.shuffleBag = this.buildShuffleBag(this.state.queue, this.state.queueIndex);
		}
	}

	private performSeek(seconds: number, reason: string) {
		if (!this.state.currentTrack) {
			return;
		}
		const duration =
			Number.isFinite(this.audio.duration) && this.audio.duration > 0
				? this.audio.duration
				: this.state.duration;
		const clamped =
			Number.isFinite(duration) && duration > 0
				? clamp(seconds, 0, duration)
				: Math.max(0, seconds);
		this.pendingSeek = clamped;
		this.logCommand('seek', { reason, target: clamped });
		if (this.audio.readyState < 1) {
			return;
		}
		if (typeof this.audio.fastSeek === 'function') {
			this.audio.fastSeek(clamped);
		} else {
			this.audio.currentTime = clamped;
		}
	}
	setQueue(queue: PlayableTrack[], startIndex = 0) {
		this.scheduleCommand('setQueue', () => {
			this.cancelCrossfade('set-queue');
			const hasTracks = queue.length > 0;
			const clampedIndex = hasTracks
				? Math.min(Math.max(startIndex, 0), queue.length - 1)
				: -1;
			const nextTrack = hasTracks ? queue[clampedIndex]! : null;
			this.dispatch({
				type: 'SET_QUEUE',
				queue,
				queueIndex: clampedIndex,
				currentTrack: nextTrack
			});
			this.resetShuffle();
			this.mediaSession.refreshHandlers();
			this.updateMediaSessionMetadata();
			this.updateMediaSessionPlaybackState();
			this.logCommand('setQueue', { size: queue.length, index: clampedIndex });
			if (!nextTrack) {
				this.pendingPlay = false;
				this.setStatus('idle', 'queue-empty');
				return;
			}
			void this.loadTrack(nextTrack, { reason: 'set-queue', shouldPlay: this.state.isPlaying });
		});
	}

	play(reason = 'user') {
		this.scheduleCommand('playRequest', () => {
			if (!this.state.currentTrack && this.state.queue.length > 0) {
				const nextTrack = this.state.queue[0]!;
				this.dispatch({ type: 'SET_TRACK', track: nextTrack, queueIndex: 0 });
				this.resetShuffle();
				void this.loadTrack(nextTrack, { reason: 'play', shouldPlay: true });
			}
			if (!this.state.currentTrack) {
				return;
			}
			void this.unlockAudioFromGesture();
			this.pendingPlay = true;
			this.logCommand('playRequest', { reason });
			if (this.activeSrc) {
				void this.attemptPlay(reason);
				return;
			}
			this.setStatus('loading', 'play-request');
		});
	}

	pause(reason = 'user') {
		this.scheduleCommand('pause', () => {
			this.cancelCrossfade('pause');
			this.pendingPlay = false;
			this.logCommand('pause', { reason });
			this.audio.pause();
			this.setStatus('paused', 'pause-request');
			this.loadExpectPlay = false;
			this.resolveLoadOutcomeIfPending('ready', { event: 'pause-request' });
		});
	}

	togglePlay() {
		if (this.state.isPlaying) {
			this.pause('toggle');
		} else {
			this.play('toggle');
		}
	}

	playQueue(queue: PlayableTrack[], startIndex = 0, reason = 'play-queue') {
		this.scheduleCommand('playQueue', () => {
			this.cancelCrossfade('play-queue');
			const hasTracks = queue.length > 0;
			const clampedIndex = hasTracks
				? Math.min(Math.max(startIndex, 0), queue.length - 1)
				: -1;
			const nextTrack = hasTracks ? queue[clampedIndex]! : null;
			this.dispatch({
				type: 'SET_QUEUE',
				queue,
				queueIndex: clampedIndex,
				currentTrack: nextTrack
			});
			this.resetShuffle();
			this.mediaSession.refreshHandlers();
			this.updateMediaSessionMetadata();
			this.updateMediaSessionPlaybackState();
			this.pendingPlay = true;
			this.logCommand('playQueue', { size: queue.length, index: clampedIndex, reason });
			if (!nextTrack) {
				this.pendingPlay = false;
				this.setStatus('idle', 'queue-empty');
				return;
			}
			void this.loadTrack(nextTrack, {
				reason,
				shouldPlay: true,
				resetTime: true
			});
		});
	}

	playAtIndex(index: number, options?: { reason?: string; shouldPlay?: boolean }) {
		this.scheduleCommand('playAtIndex', () => {
			this.cancelCrossfade('play-at-index');
			if (index < 0 || index >= this.state.queue.length) {
				return;
			}
			const nextTrack = this.state.queue[index] ?? null;
			this.logCommand('playAtIndex', { index, reason: options?.reason ?? 'index' });
			this.dispatch({ type: 'SET_TRACK', track: nextTrack, queueIndex: index });
			this.resetShuffle();
			this.mediaSession.refreshHandlers();
			this.updateMediaSessionMetadata();
			this.updateMediaSessionPlaybackState();
			if (typeof options?.shouldPlay === 'boolean') {
				this.pendingPlay = options.shouldPlay;
			}
			if (nextTrack) {
				void this.loadTrack(nextTrack, {
					reason: options?.reason ?? 'index',
					shouldPlay: this.pendingPlay,
					resetTime: true
				});
			}
		});
	}

	next(reason = 'user') {
		this.scheduleCommand('next', () => {
			this.cancelCrossfade('next');
			const wasPlaying = this.state.isPlaying;
			const nextIndex = this.getNextIndex();
			this.logCommand('next', { reason, nextIndex });
			if (nextIndex === null) {
				this.pause(reason);
				return;
			}
			this.playAtIndex(nextIndex, { reason, shouldPlay: wasPlaying });
		});
	}

	previous(reason = 'user') {
		this.scheduleCommand('previous', () => {
			this.cancelCrossfade('previous');
			const wasPlaying = this.state.isPlaying;
			const currentTime = this.audio.currentTime ?? 0;
			this.logCommand('previous', { reason, currentTime });
			if (currentTime > 5) {
				this.seekTo(0, reason);
				return;
			}
			const prevIndex = this.getPreviousIndex();
			if (prevIndex === null) {
				this.seekTo(0, reason);
				return;
			}
			this.playAtIndex(prevIndex, { reason, shouldPlay: wasPlaying });
		});
	}

	seekTo(seconds: number, reason = 'user') {
		this.scheduleCommand('seek', () => {
			this.lastSeekRequest = { time: seconds, reason, at: Date.now() };
			this.cancelCrossfade('seek');
			this.performSeek(seconds, reason);
		});
	}

	setVolume(volume: number) {
		const nextVolume = clamp(volume, 0, 1);
		this.logCommand('setVolume', { volume: nextVolume });
		this.dispatch({ type: 'SET_VOLUME', volume: nextVolume });
		this.applyVolume();
	}

	setMuted(muted: boolean) {
		this.logCommand('setMuted', { muted });
		this.dispatch({ type: 'SET_MUTED', muted });
		this.applyVolume();
	}

	setCrossfadeSeconds(seconds: number) {
		this.scheduleCommand('setCrossfade', () => {
			const normalized = this.normalizeCrossfadeSeconds(seconds);
			this.logCommand('setCrossfade', { seconds: normalized });
			this.dispatch({ type: 'SET_CROSSFADE', seconds: normalized });
			if (normalized <= 0) {
				this.cancelCrossfade('disabled');
			}
		});
	}

	setQuality(quality: AudioQuality, source: 'auto' | 'manual' = 'manual') {
		this.scheduleCommand('setQuality', () => {
			this.cancelCrossfade('quality-change');
			this.logCommand('setQuality', { quality, source });
			this.dispatch({ type: 'SET_QUALITY', quality, source });
			if (source === 'manual') {
				userPreferencesStore.setPlaybackQuality(quality);
			}
			const track = this.state.currentTrack;
			if (track && !isSonglinkTrack(track)) {
				const resumeTime = this.audio.currentTime ?? this.state.currentTime;
				void this.loadTrack(track, {
					resumeTime,
					reason: 'quality-change',
					shouldPlay: this.state.isPlaying,
					resetTime: false
				});
			}
		});
	}

	setRepeatMode(repeatMode: RepeatMode) {
		this.cancelCrossfade('repeat-mode');
		this.logCommand('setRepeatMode', { repeatMode });
		this.dispatch({ type: 'SET_REPEAT', repeatMode });
	}

	cycleRepeatMode() {
		const next =
			this.state.repeatMode === 'off'
				? 'all'
				: this.state.repeatMode === 'all'
					? 'one'
					: 'off';
		this.setRepeatMode(next);
	}

	toggleShuffle() {
		this.cancelCrossfade('shuffle');
		this.logCommand('toggleShuffle', { enabled: !this.state.shuffleEnabled });
		this.dispatch({ type: 'SET_SHUFFLE', enabled: !this.state.shuffleEnabled });
		this.resetShuffle();
		this.mediaSession.refreshHandlers();
	}

	setShuffleSeed(seed: number | null) {
		this.cancelCrossfade('shuffle-seed');
		this.random = seed === null ? Math.random : createSeededRng(seed);
		this.logCommand('setShuffleSeed', { seed });
		this.resetShuffle();
	}

	replaceQueueItem(index: number, track: PlayableTrack) {
		this.scheduleCommand('replaceQueueItem', () => {
			this.cancelCrossfade('replace-queue-item');
			if (index < 0 || index >= this.state.queue.length) {
				return;
			}
			this.logCommand('replaceQueueItem', { index });
			const queue = this.state.queue.slice();
			queue[index] = track;
			const currentTrack = index === this.state.queueIndex ? track : this.state.currentTrack;
			this.dispatch({ type: 'SET_QUEUE', queue, queueIndex: this.state.queueIndex, currentTrack });
			this.mediaSession.refreshHandlers();
		});
	}

	enqueue(track: PlayableTrack) {
		this.scheduleCommand('enqueue', () => {
			this.cancelCrossfade('enqueue');
			this.logCommand('enqueue', { trackId: track.id });
			const queue = this.state.queue.slice();
			queue.push(track);
			this.mediaSession.refreshHandlers();
			if (this.state.queueIndex === -1) {
				this.dispatch({ type: 'SET_QUEUE', queue, queueIndex: 0, currentTrack: track });
				this.updateMediaSessionMetadata();
				this.updateMediaSessionPlaybackState();
				void this.loadTrack(track, { reason: 'enqueue', shouldPlay: true });
				this.pendingPlay = true;
				return;
			}
			this.dispatch({
				type: 'SET_QUEUE',
				queue,
				queueIndex: this.state.queueIndex,
				currentTrack: this.state.currentTrack
			});
		});
	}

	enqueueNext(track: PlayableTrack) {
		this.scheduleCommand('enqueueNext', () => {
			this.cancelCrossfade('enqueue-next');
			this.logCommand('enqueueNext', { trackId: track.id });
			const queue = this.state.queue.slice();
			this.mediaSession.refreshHandlers();
			if (queue.length === 0 || this.state.queueIndex === -1) {
				this.dispatch({ type: 'SET_QUEUE', queue: [track], queueIndex: 0, currentTrack: track });
				this.updateMediaSessionMetadata();
				this.updateMediaSessionPlaybackState();
				void this.loadTrack(track, { reason: 'enqueue-next', shouldPlay: true });
				this.pendingPlay = true;
				return;
			}
			const insertIndex = Math.min(this.state.queueIndex + 1, queue.length);
			queue.splice(insertIndex, 0, track);
			this.dispatch({
				type: 'SET_QUEUE',
				queue,
				queueIndex: this.state.queueIndex,
				currentTrack: this.state.currentTrack
			});
		});
	}

	removeFromQueue(index: number) {
		this.scheduleCommand('removeFromQueue', () => {
			this.cancelCrossfade('remove-from-queue');
			if (index < 0 || index >= this.state.queue.length) {
				return;
			}
			this.logCommand('removeFromQueue', { index });
			const queue = this.state.queue.slice();
			queue.splice(index, 1);
			this.mediaSession.refreshHandlers();
			let queueIndex = this.state.queueIndex;
			let currentTrack = this.state.currentTrack;
			if (queue.length === 0) {
				queueIndex = -1;
				currentTrack = null;
				this.dispatch({ type: 'SET_QUEUE', queue, queueIndex, currentTrack });
				this.pause('queue-clear');
				return;
			}
			if (index === queueIndex) {
				queueIndex = Math.min(queueIndex, queue.length - 1);
				currentTrack = queue[queueIndex] ?? null;
			} else if (index < queueIndex) {
				queueIndex -= 1;
			}
			this.dispatch({ type: 'SET_QUEUE', queue, queueIndex, currentTrack });
			this.updateMediaSessionMetadata();
			this.updateMediaSessionPlaybackState();
			if (index === this.state.queueIndex && currentTrack) {
				void this.loadTrack(currentTrack, {
					reason: 'queue-remove',
					shouldPlay: this.state.isPlaying,
					resetTime: true
				});
			}
		});
	}

	clearQueue() {
		this.scheduleCommand('clearQueue', () => {
			this.cancelCrossfade('clear-queue');
			this.logCommand('clearQueue');
			this.dispatch({ type: 'SET_QUEUE', queue: [], queueIndex: -1, currentTrack: null });
			this.mediaSession.refreshHandlers();
			this.updateMediaSessionMetadata();
			this.updateMediaSessionPlaybackState();
			this.pause('queue-clear');
		});
	}

	setLoading(isLoading: boolean) {
		this.logCommand('setLoading', { isLoading });
		this.setStatus(isLoading ? 'loading' : 'paused', 'set-loading');
	}

	reset() {
		this.scheduleCommand('reset', () => {
			this.cancelCrossfade('reset');
			this.logCommand('reset');
			const prefs = get(userPreferencesStore);
			const base = {
				...this.state,
				queue: [],
				queueIndex: -1,
				currentTrack: null,
				status: 'idle',
				isPlaying: false,
				isLoading: false,
				currentTime: 0,
				duration: 0,
				quality: prefs.playbackQuality,
				qualitySource: 'manual',
				activeQuality: null,
				repeatMode: 'all',
				shuffleEnabled: false,
				sampleRate: null,
				bitDepth: null,
				replayGain: null,
				bufferedPercent: 0,
				needsGesture: false,
				error: null
			} as AudioState;
			this.state = base;
			this.setState(base);
			this.audio.pause();
			this.audio.currentTime = 0;
			this.audio.src = '';
			this.activeSrc = null;
			this.recentTracks = [];
			this.lastCrossfadeAttemptAt = 0;
			this.lastCrossfadeTrackId = null;
			this.setStatus('idle', 'reset');
		});
	}

	destroy() {
		this.destroyed = true;
		this.cancelCrossfade('destroy');
		this.cancelLoadOutcome('destroy');
		this.clearLoadTimers();
		if (this.prefetchAbort) {
			this.prefetchAbort.abort();
			this.prefetchAbort = null;
		}
		this.detachListeners(this.audioPrimary);
		this.detachListeners(this.audioSecondary);
		this.mediaSession.destroy();
		this.destroyShakaPlayer().catch(() => {});
		if (this.realAudioPrimary && this.realAudioPrimary.parentElement) {
			this.realAudioPrimary.parentElement.removeChild(this.realAudioPrimary);
		}
		if (this.realAudioSecondary && this.realAudioSecondary.parentElement) {
			this.realAudioSecondary.parentElement.removeChild(this.realAudioSecondary);
		}
	}
}
