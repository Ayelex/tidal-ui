import { describe, expect, it } from 'vitest';
import { audioReducer, createInitialState } from '../../src/lib/audio/state';
import type { PlayableTrack } from '../../src/lib/types';

const makeTrack = (id: number, duration = 120): PlayableTrack =>
	({ id, title: `Track ${id}`, duration } as PlayableTrack);

describe('audioReducer', () => {
	it('maps playback status to flags', () => {
		const base = createInitialState({ volume: 1, quality: 'LOSSLESS' });

		const playing = audioReducer(base, { type: 'SET_STATUS', status: 'playing' });
		expect(playing.isPlaying).toBe(true);
		expect(playing.isLoading).toBe(false);

		const buffering = audioReducer(base, { type: 'SET_STATUS', status: 'buffering' });
		expect(buffering.isPlaying).toBe(true);
		expect(buffering.isLoading).toBe(true);

		const loading = audioReducer(base, { type: 'SET_STATUS', status: 'loading' });
		expect(loading.isPlaying).toBe(false);
		expect(loading.isLoading).toBe(true);
	});

	it('preserves time when queue updates do not change track', () => {
		const track = makeTrack(1, 100);
		const track2 = makeTrack(2, 140);
		const base = createInitialState({ volume: 1, quality: 'LOSSLESS' });
		const state = {
			...base,
			currentTrack: track,
			queue: [track],
			queueIndex: 0,
			currentTime: 42,
			duration: 100
		};

		const next = audioReducer(state, {
			type: 'SET_QUEUE',
			queue: [track, track2],
			queueIndex: 0,
			currentTrack: track
		});

		expect(next.currentTime).toBe(42);
		expect(next.duration).toBe(100);
	});

	it('resets time when queue updates swap the active track', () => {
		const track = makeTrack(1, 100);
		const track2 = makeTrack(2, 140);
		const base = createInitialState({ volume: 1, quality: 'LOSSLESS' });
		const state = {
			...base,
			currentTrack: track,
			queue: [track],
			queueIndex: 0,
			currentTime: 42,
			duration: 100
		};

		const next = audioReducer(state, {
			type: 'SET_QUEUE',
			queue: [track2],
			queueIndex: 0,
			currentTrack: track2
		});

		expect(next.currentTime).toBe(0);
		expect(next.duration).toBe(140);
	});
});
