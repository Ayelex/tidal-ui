import { writable } from 'svelte/store';
import { dev } from '$app/environment';
import type { AudioState } from './state';

export type AudioLogKind = 'event' | 'command' | 'state';

export interface AudioLogEntry {
	ts: number;
	kind: AudioLogKind;
	name: string;
	trackId: number | string | null;
	src: string;
	currentTime: number;
	duration: number;
	readyState: number;
	networkState: number;
	paused: boolean;
	ended: boolean;
	detail?: Record<string, unknown>;
}

export interface AudioMetrics {
	resolveAttempts: number;
	resolveSuccesses: number;
	resolveFailures: number;
	streamCacheHits: number;
	streamCacheMisses: number;
	playbackStarts: number;
	playbackFailures: number;
	startupLatencyMsAvg: number;
	startupLatencySamples: number;
	lastStartupLatencyMs?: number;
	lastResolveLatencyMs?: number;
	prefetchCount: number;
}

const LOG_LIMIT = 600;

function resolveEnabled() {
	if (!dev) {
		return false;
	}
	if (typeof window === 'undefined') {
		return true;
	}
	const flag = window.localStorage.getItem('tidal-debug-audio');
	return flag !== '0';
}

export function createAudioTelemetry() {
	const enabled = resolveEnabled();
	const logs = writable<AudioLogEntry[]>([]);
	const metrics = writable<AudioMetrics>({
		resolveAttempts: 0,
		resolveSuccesses: 0,
		resolveFailures: 0,
		streamCacheHits: 0,
		streamCacheMisses: 0,
		playbackStarts: 0,
		playbackFailures: 0,
		startupLatencyMsAvg: 0,
		startupLatencySamples: 0,
		lastStartupLatencyMs: undefined,
		lastResolveLatencyMs: undefined,
		prefetchCount: 0
	});

	const logToConsole = (entry: AudioLogEntry) => {
		if (!enabled) {
			return;
		}
		if (entry.kind === 'state') {
			return;
		}
		const label = `[audio] ${entry.kind}:${entry.name}`;
		const base = {
			trackId: entry.trackId,
			src: entry.src,
			currentTime: entry.currentTime,
			duration: entry.duration,
			readyState: entry.readyState,
			networkState: entry.networkState,
			paused: entry.paused,
			ended: entry.ended
		};
		const payload = entry.detail ? { ...base, ...entry.detail } : base;
		console.debug(label, payload);
	};

	const push = (entry: AudioLogEntry) => {
		if (!enabled) {
			return;
		}
		logs.update((items) => {
			const next = items.length >= LOG_LIMIT ? items.slice(1) : items.slice();
			next.push(entry);
			return next;
		});
		logToConsole(entry);
	};

	return {
		enabled,
		logs,
		metrics,
		clear: () => logs.set([]),
		logEntry: (entry: Omit<AudioLogEntry, 'ts'>) => push({ ts: Date.now(), ...entry }),
		logEvent: (name: string, snapshot: Omit<AudioLogEntry, 'ts' | 'kind' | 'name'>, detail?: Record<string, unknown>) =>
			push({ ts: Date.now(), kind: 'event', name, ...snapshot, detail }),
		logCommand: (
			name: string,
			snapshot: Omit<AudioLogEntry, 'ts' | 'kind' | 'name'>,
			detail?: Record<string, unknown>
		) => push({ ts: Date.now(), kind: 'command', name, ...snapshot, detail }),
		logState: (name: string, state: AudioState, detail?: Record<string, unknown>) =>
			push({
				ts: Date.now(),
				kind: 'state',
				name,
				trackId: state.currentTrack?.id ?? null,
				src: state.activeQuality ?? '',
				currentTime: state.currentTime,
				duration: state.duration,
				readyState: -1,
				networkState: -1,
				paused: !state.isPlaying,
				ended: false,
				detail
			}),
		recordResolveAttempt: () =>
			metrics.update((current) => ({
				...current,
				resolveAttempts: current.resolveAttempts + 1
			})),
		recordResolveSuccess: (latencyMs?: number) =>
			metrics.update((current) => ({
				...current,
				resolveSuccesses: current.resolveSuccesses + 1,
				lastResolveLatencyMs: typeof latencyMs === 'number' ? latencyMs : current.lastResolveLatencyMs
			})),
		recordResolveFailure: () =>
			metrics.update((current) => ({
				...current,
				resolveFailures: current.resolveFailures + 1
			})),
		recordCacheHit: () =>
			metrics.update((current) => ({
				...current,
				streamCacheHits: current.streamCacheHits + 1
			})),
		recordCacheMiss: () =>
			metrics.update((current) => ({
				...current,
				streamCacheMisses: current.streamCacheMisses + 1
			})),
		recordPlaybackStart: (latencyMs?: number) =>
			metrics.update((current) => {
				const samples = current.startupLatencySamples + (typeof latencyMs === 'number' ? 1 : 0);
				const avg =
					typeof latencyMs === 'number'
						? (current.startupLatencyMsAvg * current.startupLatencySamples + latencyMs) /
						  Math.max(1, samples)
						: current.startupLatencyMsAvg;
				return {
					...current,
					playbackStarts: current.playbackStarts + 1,
					startupLatencySamples: samples,
					startupLatencyMsAvg: avg,
					lastStartupLatencyMs:
						typeof latencyMs === 'number' ? latencyMs : current.lastStartupLatencyMs
				};
			}),
		recordPlaybackFailure: () =>
			metrics.update((current) => ({
				...current,
				playbackFailures: current.playbackFailures + 1
			})),
		recordPrefetch: () =>
			metrics.update((current) => ({
				...current,
				prefetchCount: current.prefetchCount + 1
			}))
	};
}

export const audioTelemetry = createAudioTelemetry();
