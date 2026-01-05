import { get } from 'svelte/store';
import { dev } from '$app/environment';
import { losslessAPI } from '$lib/api';
import { getProxiedUrl } from '$lib/config';
import { userPreferencesStore } from '$lib/stores/userPreferences';
import { deriveTrackQuality } from '$lib/utils/audioQuality';
import { convertToTidal, extractTidalInfo, fetchSonglinkData } from '$lib/utils/songlink';
import type { AudioQuality, PlayableTrack, SonglinkTrack, Track } from '$lib/types';
import { isSonglinkTrack } from '$lib/types';
import { audioReducer, type AudioState, type PlaybackStatus, type RepeatMode } from './state';
import { audioTelemetry } from './telemetry';
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

const hiResQualities = new Set<AudioQuality>(['HI_RES_LOSSLESS']);

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

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
	private audio: AudioElementLike;
	private realAudio: HTMLAudioElement | null;
	private shakaNamespace: ShakaNamespace | null = null;
	private shakaPlayer: ShakaPlayerInstance | null = null;
	private dashObjectUrl: string | null = null;
	private loadToken = 0;
	private pendingPlay = false;
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
		const created = createAudioElement({ mock: useMock });
		this.audio = created.element;
		this.realAudio = created.realElement;
		this.useMock = this.audio instanceof MockAudioElement;

		if (this.realAudio) {
			this.realAudio.className = 'audio-engine';
			this.realAudio.style.display = 'none';
			this.realAudio.setAttribute('playsinline', 'true');
			if (typeof document !== 'undefined') {
				document.body.appendChild(this.realAudio);
			}
		}

		this.attachListeners();
		this.applyVolume();
		audioTelemetry.logState('init', this.state);
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

	private attachListeners() {
		this.audio.addEventListener('timeupdate', this.handleTimeUpdate);
		this.audio.addEventListener('loadedmetadata', this.handleLoadedMetadata);
		this.audio.addEventListener('loadeddata', this.handleLoadedData);
		this.audio.addEventListener('durationchange', this.handleDurationChange);
		this.audio.addEventListener('progress', this.handleProgress);
		this.audio.addEventListener('canplay', this.handleCanPlay);
		this.audio.addEventListener('playing', this.handlePlaying);
		this.audio.addEventListener('play', this.handlePlay);
		this.audio.addEventListener('pause', this.handlePause);
		this.audio.addEventListener('waiting', this.handleWaiting);
		this.audio.addEventListener('stalled', this.handleStalled);
		this.audio.addEventListener('ended', this.handleEnded);
		this.audio.addEventListener('error', this.handleError);
		this.audio.addEventListener('seeking', this.handleSeeking);
		this.audio.addEventListener('seeked', this.handleSeeked);
	}

	private detachListeners() {
		this.audio.removeEventListener('timeupdate', this.handleTimeUpdate);
		this.audio.removeEventListener('loadedmetadata', this.handleLoadedMetadata);
		this.audio.removeEventListener('loadeddata', this.handleLoadedData);
		this.audio.removeEventListener('durationchange', this.handleDurationChange);
		this.audio.removeEventListener('progress', this.handleProgress);
		this.audio.removeEventListener('canplay', this.handleCanPlay);
		this.audio.removeEventListener('playing', this.handlePlaying);
		this.audio.removeEventListener('play', this.handlePlay);
		this.audio.removeEventListener('pause', this.handlePause);
		this.audio.removeEventListener('waiting', this.handleWaiting);
		this.audio.removeEventListener('stalled', this.handleStalled);
		this.audio.removeEventListener('ended', this.handleEnded);
		this.audio.removeEventListener('error', this.handleError);
		this.audio.removeEventListener('seeking', this.handleSeeking);
		this.audio.removeEventListener('seeked', this.handleSeeked);
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
		const currentTime = this.audio.currentTime ?? 0;
		if (Number.isFinite(currentTime)) {
			this.dispatch({ type: 'SET_TIME', currentTime });
		}
		this.updateBufferedPercent();
		this.updateMediaSessionPositionState(now);
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('timeupdate', createSnapshot(this.state, this.audio));
		}
	};

	private handleLoadedMetadata = () => {
		if (this.shouldIgnoreEvent()) {
			return;
		}
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
		this.syncDuration();
		this.applyPendingSeek();
		this.setStatus(this.state.isPlaying ? 'playing' : 'paused', 'loadeddata');
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('loadeddata', createSnapshot(this.state, this.audio));
		}
	};

	private handleDurationChange = () => {
		if (this.shouldIgnoreEvent()) {
			return;
		}
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
		this.updateBufferedPercent();
	};

	private handleCanPlay = () => {
		if (this.shouldIgnoreEvent()) {
			return;
		}
		if (this.pendingPlay) {
			this.setStatus('buffering', 'canplay');
		} else if (this.state.status === 'loading') {
			this.setStatus('paused', 'canplay');
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
		this.setStatus('playing', 'playing');
		this.dispatch({ type: 'SET_NEEDS_GESTURE', needsGesture: false });
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('playing', createSnapshot(this.state, this.audio));
		}
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

	private handleWaiting = () => {
		if (this.shouldIgnoreEvent()) {
			return;
		}
		this.setStatus('buffering', 'waiting');
		this.updateMediaSessionPlaybackState();
	};

	private handleStalled = () => {
		if (this.shouldIgnoreEvent()) {
			return;
		}
		this.setStatus('buffering', 'stalled');
		this.updateMediaSessionPlaybackState();
	};

	private handleEnded = () => {
		if (this.destroyed) {
			return;
		}
		if (this.shouldIgnoreEvent()) {
			return;
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
	};

	private handleError = () => {
		if (this.shouldIgnoreEvent()) {
			return;
		}
		if (audioTelemetry.enabled) {
			audioTelemetry.logEvent('error', createSnapshot(this.state, this.audio));
		}
		const message = 'Playback error';
		this.dispatch({ type: 'SET_ERROR', error: message });
		this.setStatus('error', 'error');
		this.updateMediaSessionPlaybackState();
		if (this.state.currentTrack && !isSonglinkTrack(this.state.currentTrack)) {
			void this.retryCurrentTrack();
		}
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
		this.audio.volume = volume;
		this.audio.muted = this.state.muted;
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
			if (track.tidalId) {
				const lookup = await losslessAPI.getTrack(track.tidalId);
				return lookup.track;
			}
			let songlinkData = track.songlinkData;
			if (!songlinkData) {
				try {
					songlinkData = await fetchSonglinkData(track.sourceUrl);
					track.songlinkData = songlinkData;
				} catch (error) {
					if (dev) {
						console.warn('Songlink fetch failed, falling back to conversion', error);
					}
				}
			}
			const tidalInfo = songlinkData ? extractTidalInfo(songlinkData) : null;
			if (!tidalInfo) {
				const fallback = await convertToTidal(track.sourceUrl);
				if (!fallback?.id) {
					throw new Error('Unable to resolve track');
				}
				const lookup = await losslessAPI.getTrack(Number(fallback.id));
				return lookup.track;
			}
			const lookup = await losslessAPI.getTrack(Number(tidalInfo.id));
			return lookup.track;
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
	private async loadTrack(track: PlayableTrack, options?: LoadOptions) {
		if (this.destroyed) {
			return;
		}
		const token = ++this.loadToken;
		this.endedToken = -1;
		this.activeSrc = null;
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
		try {
			if (hiResQualities.has(effectiveQuality)) {
				try {
					await this.loadDashTrack(resolvedTrack as Track, token);
				} catch (error) {
					if (token !== this.loadToken) {
						return;
					}
					if (dev) {
						console.warn('DASH load failed, falling back to lossless', error);
					}
					await this.loadStandardTrack(resolvedTrack as Track, 'LOSSLESS', token);
				}
			} else {
				try {
					await this.loadStandardTrack(resolvedTrack as Track, effectiveQuality, token);
				} catch (error) {
					if (token !== this.loadToken) {
						return;
					}
					if (effectiveQuality !== 'LOSSLESS') {
						await this.loadStandardTrack(resolvedTrack as Track, 'LOSSLESS', token);
					} else {
						throw error;
					}
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
		} catch (error) {
			if (token !== this.loadToken) {
				return;
			}
			this.dispatch({
				type: 'SET_ERROR',
				error: error instanceof Error ? error.message : 'Unable to load stream'
			});
			this.setStatus('error', 'load-failed');
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

	private async loadStandardTrack(track: Track, quality: AudioQuality, token: number) {
		await this.destroyShakaPlayer();
		if (this.useMock) {
			this.audio.src = `mock://track/${track.id}?q=${quality}`;
			this.activeSrc = this.audio.src;
			(this.audio as MockAudioElement).setMockDuration(track.duration ?? 120);
			this.audio.load();
			this.dispatch({ type: 'SET_ACTIVE_QUALITY', activeQuality: quality });
			this.dispatch({
				type: 'SET_METADATA',
				sampleRate: null,
				bitDepth: null,
				replayGain: null
			});
			this.applyVolume();
			return;
		}
		const data = await losslessAPI.getStreamData(track.id, quality);
		if (token !== this.loadToken) {
			return;
		}
		const url = getProxiedUrl(data.url);
		this.audio.src = url;
		this.activeSrc = this.audio.src;
		this.audio.load();
		this.dispatch({ type: 'SET_ACTIVE_QUALITY', activeQuality: quality });
		this.dispatch({
			type: 'SET_METADATA',
			sampleRate: data.sampleRate ?? null,
			bitDepth: data.bitDepth ?? null,
			replayGain: data.replayGain ?? null
		});
		this.applyVolume();
	}

	private async loadDashTrack(track: Track, token: number) {
		if (!this.realAudio || this.useMock) {
			await this.loadStandardTrack(track, 'LOSSLESS', token);
			return;
		}
		const manifest = await losslessAPI.getDashManifestWithMetadata(track.id, 'HI_RES_LOSSLESS');
		if (token !== this.loadToken) {
			return;
		}
		if (manifest.result.kind === 'flac') {
			await this.loadStandardTrack(track, 'LOSSLESS', token);
			return;
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

	private async retryCurrentTrack() {
		const track = this.state.currentTrack;
		if (!track || isSonglinkTrack(track)) {
			return;
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
		if (this.audio.readyState < 2) {
			return;
		}
		void this.attemptPlay(reason);
	}

	private async attemptPlay(reason: string) {
		if (!this.state.currentTrack) {
			return;
		}
		this.endedToken = -1;
		this.pendingPlay = true;
		this.logCommand('play', { reason });
		try {
			await this.audio.play();
			this.unlocked = true;
			this.pendingPlay = false;
			this.dispatch({ type: 'SET_NEEDS_GESTURE', needsGesture: false });
		} catch (error) {
			const name = error instanceof DOMException ? error.name : 'Error';
			this.pendingPlay = false;
			if (name === 'NotAllowedError') {
				this.dispatch({ type: 'SET_NEEDS_GESTURE', needsGesture: true });
				this.setStatus('blocked', 'gesture');
			} else {
				this.dispatch({
					type: 'SET_ERROR',
					error: error instanceof Error ? error.message : 'Play failed'
				});
				this.setStatus('error', 'play-failed');
			}
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
			if (this.audio.readyState >= 2 && this.activeSrc) {
				void this.attemptPlay(reason);
				return;
			}
			this.setStatus('loading', 'play-request');
		});
	}

	pause(reason = 'user') {
		this.scheduleCommand('pause', () => {
			this.pendingPlay = false;
			this.logCommand('pause', { reason });
			this.audio.pause();
			this.setStatus('paused', 'pause-request');
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

	setQuality(quality: AudioQuality, source: 'auto' | 'manual' = 'manual') {
		this.scheduleCommand('setQuality', () => {
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
		this.logCommand('toggleShuffle', { enabled: !this.state.shuffleEnabled });
		this.dispatch({ type: 'SET_SHUFFLE', enabled: !this.state.shuffleEnabled });
		this.resetShuffle();
		this.mediaSession.refreshHandlers();
	}

	setShuffleSeed(seed: number | null) {
		this.random = seed === null ? Math.random : createSeededRng(seed);
		this.logCommand('setShuffleSeed', { seed });
		this.resetShuffle();
	}

	replaceQueueItem(index: number, track: PlayableTrack) {
		this.scheduleCommand('replaceQueueItem', () => {
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
			this.setStatus('idle', 'reset');
		});
	}

	destroy() {
		this.destroyed = true;
		this.detachListeners();
		this.mediaSession.destroy();
		this.destroyShakaPlayer().catch(() => {});
		if (this.realAudio && this.realAudio.parentElement) {
			this.realAudio.parentElement.removeChild(this.realAudio);
		}
	}
}
