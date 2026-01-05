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

	const push = (entry: AudioLogEntry) => {
		if (!enabled) {
			return;
		}
		logs.update((items) => {
			const next = items.length >= LOG_LIMIT ? items.slice(1) : items.slice();
			next.push(entry);
			return next;
		});
	};

	return {
		enabled,
		logs,
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
			})
	};
}

export const audioTelemetry = createAudioTelemetry();
