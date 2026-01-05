import { expect, test } from '@playwright/test';

type TrackPayload = {
	id: number;
	title: string;
	duration: number;
	replayGain?: number;
	peak?: number;
	allowStreaming: boolean;
	streamReady: boolean;
	streamStartDate?: string;
	premiumStreamingOnly: boolean;
	trackNumber: number;
	volumeNumber: number;
	version: string | null;
	popularity: number;
	copyright?: string;
	url: string;
	isrc?: string;
	editable: boolean;
	explicit: boolean;
	audioQuality: string;
	audioModes: string[];
	artist: { id: number; name: string; type: string };
	artists: Array<{ id: number; name: string; type: string }>;
	album: { id: number; title: string; cover: string; videoCover: string | null };
	mixes?: Record<string, string>;
	mediaMetadata?: { tags: string[] };
};

const makeTrack = (id: number, title: string, duration = 120): TrackPayload => ({
	id,
	title,
	duration,
	replayGain: 0,
	peak: 1,
	allowStreaming: true,
	streamReady: true,
	premiumStreamingOnly: false,
	trackNumber: 1,
	volumeNumber: 1,
	version: null,
	popularity: 1,
	url: '',
	editable: false,
	explicit: false,
	audioQuality: 'LOSSLESS',
	audioModes: [],
	artist: { id: 1, name: 'Artist', type: 'MAIN' },
	artists: [{ id: 1, name: 'Artist', type: 'MAIN' }],
	album: { id: 1, title: 'Album', cover: 'cover', videoCover: null },
	mediaMetadata: { tags: [] }
});

const mulberry32 = (seed: number) => {
	let t = seed >>> 0;
	return () => {
		t += 0x6d2b79f5;
		let r = Math.imul(t ^ (t >>> 15), 1 | t);
		r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};
};

const buildShuffleBag = (queueLength: number, currentIndex: number, seed: number) => {
	const indices: number[] = [];
	for (let i = 0; i < queueLength; i += 1) {
		if (i !== currentIndex) {
			indices.push(i);
		}
	}
	const random = mulberry32(seed);
	for (let i = indices.length - 1; i > 0; i -= 1) {
		const j = Math.floor(random() * (i + 1));
		[indices[i], indices[j]] = [indices[j]!, indices[i]!];
	}
	return indices;
};

test('play, seek, next, previous, pause/resume stay in sync', async ({ page }) => {
	await page.goto('/?audioMock=1');
	await page.waitForFunction(() => Boolean((window as unknown as { __audioDebug?: unknown }).__audioDebug));

	const tracks = [makeTrack(1, 'Alpha', 140), makeTrack(2, 'Beta', 140)];

	await page.evaluate((queue) => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		debug.setQueue(queue, 0);
		debug.play();
	}, tracks);

	await page.waitForFunction(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		return debug.getState().isPlaying;
	});

	const startTime = await page.evaluate(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		return debug.getState().currentTime;
	});
	expect(startTime).toBeLessThan(1.5);

	await page.evaluate(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		debug.seekTo(30);
	});
	await page.waitForFunction(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		return Math.abs(debug.getState().currentTime - 30) < 1;
	});

	const seekTime = await page.evaluate(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		return debug.getState().currentTime;
	});
	expect(seekTime).toBeGreaterThan(29);
	expect(seekTime).toBeLessThan(31);

	await page.evaluate(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		debug.next();
	});
	await page.waitForFunction(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		return debug.getState().currentTrack?.id === 2;
	});
	const nextTime = await page.evaluate(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		return debug.getState().currentTime;
	});
	expect(nextTime).toBeLessThan(1.5);

	await page.evaluate(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		debug.previous();
	});
	await page.waitForFunction(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		return debug.getState().currentTrack?.id === 1;
	});
	const prevTime = await page.evaluate(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		return debug.getState().currentTime;
	});
	expect(prevTime).toBeLessThan(1.5);

	await page.evaluate(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		debug.pause();
	});
	const pausedTime = await page.evaluate(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		return debug.getState().currentTime;
	});
	await page.waitForTimeout(600);
	const pausedTimeLater = await page.evaluate(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		return debug.getState().currentTime;
	});
	expect(Math.abs(pausedTimeLater - pausedTime)).toBeLessThan(0.4);

	await page.evaluate(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		debug.play();
	});
	await page.waitForTimeout(600);
	const resumedTime = await page.evaluate(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		return debug.getState().currentTime;
	});
	expect(resumedTime).toBeGreaterThan(pausedTime);
});

test('ended advances once and repeat-one loops', async ({ page }) => {
	await page.goto('/?audioMock=1');
	await page.waitForFunction(() => Boolean((window as unknown as { __audioDebug?: unknown }).__audioDebug));

	const shortTracks = [makeTrack(10, 'Short A', 2), makeTrack(11, 'Short B', 2)];

	await page.evaluate((queue) => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		debug.setQueue(queue, 0);
		debug.setRepeatMode('off');
		debug.play();
		debug.seekTo(1.75);
	}, shortTracks);

	await page.waitForFunction(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		return debug.getState().queueIndex === 1;
	});

	await page.waitForTimeout(800);
	const queueIndex = await page.evaluate(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		return debug.getState().queueIndex;
	});
	expect(queueIndex).toBe(1);

	const repeatTrack = makeTrack(20, 'Repeat One', 2);
	await page.evaluate((queue) => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		debug.setQueue(queue, 0);
		debug.setRepeatMode('one');
		debug.play();
		debug.seekTo(1.75);
	}, [repeatTrack]);

	await page.waitForFunction(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		const state = debug.getState();
		return state.currentTrack?.id === 20 && state.currentTime < 0.6 && state.isPlaying;
	});
});

test('shuffle order is deterministic with a seed', async ({ page }) => {
	await page.goto('/?audioMock=1');
	await page.waitForFunction(() => Boolean((window as unknown as { __audioDebug?: unknown }).__audioDebug));

	const tracks = [makeTrack(31, 'One', 120), makeTrack(32, 'Two', 120), makeTrack(33, 'Three', 120)];
	const seed = 123;
	const expectedOrder = buildShuffleBag(tracks.length, 0, seed);

	await page.evaluate((queue) => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		if (debug.getState().shuffleEnabled) {
			debug.toggleShuffle();
		}
		debug.setQueue(queue, 0);
		debug.setRepeatMode('off');
		debug.setShuffleSeed(123);
		debug.toggleShuffle();
	}, tracks);

	await page.evaluate(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		debug.next();
	});
	await page.waitForFunction(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		return debug.getState().queueIndex === 1 || debug.getState().queueIndex === 2;
	});
	const firstShuffleId = await page.evaluate(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		return debug.getState().currentTrack?.id;
	});
	expect(firstShuffleId).toBe(tracks[expectedOrder[0]!]!.id);

	await page.evaluate(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		debug.next();
	});
	await page.waitForFunction(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		return debug.getState().queueIndex !== 0;
	});
	const secondShuffleId = await page.evaluate(() => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		return debug.getState().currentTrack?.id;
	});
	expect(secondShuffleId).toBe(tracks[expectedOrder[1]!]!.id);
});
