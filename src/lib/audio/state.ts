import type { AudioQuality, PlayableTrack } from '$lib/types';

export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'blocked' | 'error';
export type RepeatMode = 'off' | 'all' | 'one';

export interface AudioState {
	currentTrack: PlayableTrack | null;
	queue: PlayableTrack[];
	queueIndex: number;
	status: PlaybackStatus;
	isPlaying: boolean;
	isLoading: boolean;
	currentTime: number;
	duration: number;
	volume: number;
	crossfadeSeconds: number;
	muted: boolean;
	quality: AudioQuality;
	qualitySource: 'auto' | 'manual';
	activeQuality: AudioQuality | null;
	repeatMode: RepeatMode;
	shuffleEnabled: boolean;
	sampleRate: number | null;
	bitDepth: number | null;
	replayGain: number | null;
	bufferedPercent: number;
	needsGesture: boolean;
	error: string | null;
	generation: number;
}

export type AudioAction =
	| { type: 'INIT'; payload: Partial<AudioState> }
	| {
			type: 'SET_QUEUE';
			queue: PlayableTrack[];
			queueIndex: number;
			currentTrack: PlayableTrack | null;
	  }
	| { type: 'SET_TRACK'; track: PlayableTrack | null; queueIndex: number }
	| { type: 'SET_STATUS'; status: PlaybackStatus }
	| { type: 'SET_TIME'; currentTime: number }
	| { type: 'SET_DURATION'; duration: number }
	| { type: 'SET_BUFFERED'; bufferedPercent: number }
	| { type: 'SET_VOLUME'; volume: number; muted?: boolean }
	| { type: 'SET_CROSSFADE'; seconds: number }
	| { type: 'SET_MUTED'; muted: boolean }
	| { type: 'SET_QUALITY'; quality: AudioQuality; source: 'auto' | 'manual' }
	| { type: 'SET_ACTIVE_QUALITY'; activeQuality: AudioQuality | null }
	| { type: 'SET_REPEAT'; repeatMode: RepeatMode }
	| { type: 'SET_SHUFFLE'; enabled: boolean }
	| { type: 'SET_METADATA'; sampleRate?: number | null; bitDepth?: number | null; replayGain?: number | null }
	| { type: 'SET_NEEDS_GESTURE'; needsGesture: boolean }
	| { type: 'SET_ERROR'; error: string | null }
	| { type: 'BUMP_GENERATION' };

export function createInitialState(params: {
	volume: number;
	quality: AudioQuality;
	qualitySource?: 'auto' | 'manual';
	repeatMode?: RepeatMode;
	crossfadeSeconds?: number;
}): AudioState {
	return {
		currentTrack: null,
		queue: [],
		queueIndex: -1,
		status: 'idle',
		isPlaying: false,
		isLoading: false,
		currentTime: 0,
		duration: 0,
		volume: params.volume,
		crossfadeSeconds: params.crossfadeSeconds ?? 0,
		muted: false,
		quality: params.quality,
		qualitySource: params.qualitySource ?? 'manual',
		activeQuality: null,
		repeatMode: params.repeatMode ?? 'all',
		shuffleEnabled: false,
		sampleRate: null,
		bitDepth: null,
		replayGain: null,
		bufferedPercent: 0,
		needsGesture: false,
		error: null,
		generation: 0
	};
}

function applyStatus(state: AudioState, status: PlaybackStatus): AudioState {
	const isPlaying = status === 'playing' || status === 'buffering';
	const isLoading = status === 'loading' || status === 'buffering';
	return { ...state, status, isPlaying, isLoading };
}

export function audioReducer(state: AudioState, action: AudioAction): AudioState {
	switch (action.type) {
		case 'INIT':
			return { ...state, ...action.payload };
		case 'SET_QUEUE': {
			const trackChanged = action.currentTrack?.id !== state.currentTrack?.id;
			return {
				...state,
				queue: action.queue,
				queueIndex: action.queueIndex,
				currentTrack: action.currentTrack,
				currentTime: trackChanged ? 0 : state.currentTime,
				duration: trackChanged ? action.currentTrack?.duration ?? 0 : state.duration,
				activeQuality: trackChanged ? null : state.activeQuality,
				bufferedPercent: trackChanged ? 0 : state.bufferedPercent,
				error: trackChanged ? null : state.error
			};
		}
		case 'SET_TRACK':
			return {
				...state,
				currentTrack: action.track,
				queueIndex: action.queueIndex,
				currentTime: 0,
				duration: action.track?.duration ?? 0,
				activeQuality: null,
				bufferedPercent: 0,
				error: null
			};
		case 'SET_STATUS':
			return applyStatus(state, action.status);
		case 'SET_TIME':
			return { ...state, currentTime: action.currentTime };
		case 'SET_DURATION':
			return { ...state, duration: action.duration };
		case 'SET_BUFFERED':
			return { ...state, bufferedPercent: action.bufferedPercent };
		case 'SET_VOLUME':
			return {
				...state,
				volume: action.volume,
				muted: action.muted ?? state.muted
			};
		case 'SET_CROSSFADE':
			return {
				...state,
				crossfadeSeconds: action.seconds
			};
		case 'SET_MUTED':
			return { ...state, muted: action.muted };
		case 'SET_QUALITY':
			return { ...state, quality: action.quality, qualitySource: action.source };
		case 'SET_ACTIVE_QUALITY':
			return { ...state, activeQuality: action.activeQuality };
		case 'SET_REPEAT':
			return { ...state, repeatMode: action.repeatMode };
		case 'SET_SHUFFLE':
			return { ...state, shuffleEnabled: action.enabled };
		case 'SET_METADATA':
			return {
				...state,
				sampleRate: action.sampleRate ?? state.sampleRate,
				bitDepth: action.bitDepth ?? state.bitDepth,
				replayGain: action.replayGain ?? state.replayGain
			};
		case 'SET_NEEDS_GESTURE':
			return { ...state, needsGesture: action.needsGesture };
		case 'SET_ERROR':
			return { ...state, error: action.error };
		case 'BUMP_GENERATION':
			return { ...state, generation: state.generation + 1 };
		default:
			return state;
	}
}
