import { browser } from '$app/environment';
import type { AudioState, RepeatMode } from './state';

const STORAGE_KEY = 'tidal-ui.audioPreferences';

type StoredAudioPreferences = {
	volume: number;
	muted: boolean;
	repeatMode: RepeatMode;
	shuffleEnabled: boolean;
	crossfadeSeconds: number;
};

const DEFAULTS: StoredAudioPreferences = {
	volume: 0.8,
	muted: false,
	repeatMode: 'all',
	shuffleEnabled: false,
	crossfadeSeconds: 0
};

const clampCrossfade = (value: unknown): number => {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return DEFAULTS.crossfadeSeconds;
	}
	return Math.min(12, Math.max(0, Math.round(value)));
};

export function loadAudioPreferences(): StoredAudioPreferences {
	if (!browser) {
		return DEFAULTS;
	}
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return DEFAULTS;
		}
		const parsed = JSON.parse(raw) as Partial<StoredAudioPreferences>;
		return {
			volume:
				typeof parsed.volume === 'number' && Number.isFinite(parsed.volume)
					? Math.min(1, Math.max(0, parsed.volume))
					: DEFAULTS.volume,
			muted: typeof parsed.muted === 'boolean' ? parsed.muted : DEFAULTS.muted,
			repeatMode:
				parsed.repeatMode === 'off' || parsed.repeatMode === 'all' || parsed.repeatMode === 'one'
					? parsed.repeatMode
					: DEFAULTS.repeatMode,
			shuffleEnabled: typeof parsed.shuffleEnabled === 'boolean' ? parsed.shuffleEnabled : DEFAULTS.shuffleEnabled,
			crossfadeSeconds: clampCrossfade(parsed.crossfadeSeconds)
		};
	} catch (error) {
		console.warn('Failed to read audio preferences', error);
		return DEFAULTS;
	}
}

let lastSaved: StoredAudioPreferences | null = null;

export function persistAudioPreferences(state: AudioState): void {
	if (!browser) {
		return;
	}
	const next: StoredAudioPreferences = {
		volume: Math.min(1, Math.max(0, state.volume)),
		muted: Boolean(state.muted),
		repeatMode: state.repeatMode,
		shuffleEnabled: state.shuffleEnabled,
		crossfadeSeconds: clampCrossfade(state.crossfadeSeconds)
	};
	if (
		lastSaved &&
		lastSaved.volume === next.volume &&
		lastSaved.muted === next.muted &&
		lastSaved.repeatMode === next.repeatMode &&
		lastSaved.shuffleEnabled === next.shuffleEnabled &&
		lastSaved.crossfadeSeconds === next.crossfadeSeconds
	) {
		return;
	}
	lastSaved = next;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch (error) {
		console.warn('Failed to persist audio preferences', error);
	}
}
