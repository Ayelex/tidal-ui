import { browser, dev } from '$app/environment';
import { derived, writable } from 'svelte/store';
import { get } from 'svelte/store';
import type { AudioQuality, PlayableTrack } from '$lib/types';
import { userPreferencesStore } from '$lib/stores/userPreferences';
import { AudioController } from '$lib/audio/player';
import { createInitialState, type AudioState, type RepeatMode } from '$lib/audio/state';
import { loadAudioPreferences, persistAudioPreferences } from '$lib/audio/persistence';

const stored = loadAudioPreferences();
const prefs = get(userPreferencesStore);

const initialState: AudioState = {
	...createInitialState({
		volume: stored.volume,
		quality: prefs.playbackQuality,
		repeatMode: stored.repeatMode,
		qualitySource: 'manual'
	}),
	muted: stored.muted,
	shuffleEnabled: stored.shuffleEnabled
};

const stateStore = writable<AudioState>(initialState);
let controller: AudioController | null = null;

const GLOBAL_KEY = '__tidalAudioController';

if (browser) {
	const win = window as unknown as Record<string, AudioController | null>;
	if (win[GLOBAL_KEY]) {
		win[GLOBAL_KEY]?.destroy();
		win[GLOBAL_KEY] = null;
	}
	controller = new AudioController({
		initialState,
		setState: (state) => stateStore.set(state)
	});
	win[GLOBAL_KEY] = controller;
	stateStore.subscribe((state) => {
		persistAudioPreferences(state);
	});
	userPreferencesStore.subscribe((prefsState) => {
		const current = controller?.getState();
		if (!current) {
			return;
		}
		if (prefsState.playbackQuality !== current.quality) {
			controller?.setQuality(prefsState.playbackQuality, 'manual');
		}
	});
	const debugEnabled = dev || new URLSearchParams(window.location.search).get('audioMock') === '1';
	if (debugEnabled) {
		(win as unknown as Record<string, unknown>).__audioDebug = {
			setQueue: (queue: PlayableTrack[], index = 0) => controller?.setQueue(queue, index),
			playQueue: (queue: PlayableTrack[], index = 0) => controller?.playQueue(queue, index),
			play: () => controller?.play('debug'),
			pause: () => controller?.pause('debug'),
			seekTo: (seconds: number) => controller?.seekTo(seconds, 'debug'),
			next: () => controller?.next('debug'),
			previous: () => controller?.previous('debug'),
			setRepeatMode: (mode: RepeatMode) => controller?.setRepeatMode(mode),
			toggleShuffle: () => controller?.toggleShuffle(),
			setShuffleSeed: (seed: number | null) => controller?.setShuffleSeed(seed),
			getState: () => controller?.getState()
		};
	}
}

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		const win = typeof window !== 'undefined' ? (window as unknown as Record<string, AudioController | null>) : null;
		controller?.destroy();
		if (win) {
			win[GLOBAL_KEY] = null;
		}
	});
}

const withController = (fn: (ctrl: AudioController) => void) => {
	if (!controller) {
		return;
	}
	fn(controller);
};

export const playerStore = {
	subscribe: stateStore.subscribe,
	setQueue: (queue: PlayableTrack[], startIndex = 0) => withController((ctrl) => ctrl.setQueue(queue, startIndex)),
	setTrack: (track: PlayableTrack) => withController((ctrl) => ctrl.setQueue([track], 0)),
	playQueue: (queue: PlayableTrack[], startIndex = 0) =>
		withController((ctrl) => ctrl.playQueue(queue, startIndex, 'ui')),
	playTrack: (track: PlayableTrack) => withController((ctrl) => ctrl.playQueue([track], 0, 'ui')),
	play: () => withController((ctrl) => ctrl.play('ui')),
	pause: () => withController((ctrl) => ctrl.pause('ui')),
	togglePlay: () => withController((ctrl) => ctrl.togglePlay()),
	playAtIndex: (index: number, shouldPlay = true) =>
		withController((ctrl) => ctrl.playAtIndex(index, { reason: 'queue', shouldPlay })),
	next: () => withController((ctrl) => ctrl.next('ui')),
	previous: () => withController((ctrl) => ctrl.previous('ui')),
	seekTo: (seconds: number) => withController((ctrl) => ctrl.seekTo(seconds, 'ui')),
	setVolume: (volume: number) => withController((ctrl) => ctrl.setVolume(volume)),
	setMuted: (muted: boolean) => withController((ctrl) => ctrl.setMuted(muted)),
	setQuality: (quality: AudioQuality) => withController((ctrl) => ctrl.setQuality(quality, 'manual')),
	setRepeatMode: (repeatMode: RepeatMode) => withController((ctrl) => ctrl.setRepeatMode(repeatMode)),
	cycleRepeatMode: () => withController((ctrl) => ctrl.cycleRepeatMode()),
	toggleShuffle: () => withController((ctrl) => ctrl.toggleShuffle()),
	enqueue: (track: PlayableTrack) => withController((ctrl) => ctrl.enqueue(track)),
	enqueueNext: (track: PlayableTrack) => withController((ctrl) => ctrl.enqueueNext(track)),
	replaceQueueItem: (index: number, track: PlayableTrack) => withController((ctrl) => ctrl.replaceQueueItem(index, track)),
	removeFromQueue: (index: number) => withController((ctrl) => ctrl.removeFromQueue(index)),
	clearQueue: () => withController((ctrl) => ctrl.clearQueue()),
	reset: () => withController((ctrl) => ctrl.reset()),
	setCurrentTime: (time: number) => withController((ctrl) => ctrl.seekTo(time, 'external')),
	setDuration: (_duration: number) => {},
	setSampleRate: (_sampleRate: number | null) => {},
	setBitDepth: (_bitDepth: number | null) => {},
	setReplayGain: (_replayGain: number | null) => {},
	setLoading: (_isLoading: boolean) => {}
};

export const currentTrack = derived(playerStore, ($store) => $store.currentTrack);
export const isPlaying = derived(playerStore, ($store) => $store.isPlaying);
export const currentTime = derived(playerStore, ($store) => $store.currentTime);
export const duration = derived(playerStore, ($store) => $store.duration);
export const volume = derived(playerStore, ($store) => $store.volume);
export const progress = derived(playerStore, ($store) =>
	$store.duration > 0 ? ($store.currentTime / $store.duration) * 100 : 0
);


