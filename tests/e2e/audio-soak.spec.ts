import { expect, test } from '@playwright/test';

type TrackPayload = {
	id: number;
	title: string;
	duration: number;
	allowStreaming: boolean;
	streamReady: boolean;
	premiumStreamingOnly: boolean;
	trackNumber: number;
	volumeNumber: number;
	version: string | null;
	popularity: number;
	url: string;
	editable: boolean;
	explicit: boolean;
	audioQuality: string;
	audioModes: string[];
	artist: { id: number; name: string; type: string };
	artists: Array<{ id: number; name: string; type: string }>;
	album: { id: number; title: string; cover: string; videoCover: string | null };
};

const makeTrack = (id: number, title: string, duration = 30): TrackPayload => ({
	id,
	title,
	duration,
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
	album: { id: 1, title: 'Album', cover: 'cover', videoCover: null }
});

test('soak: play 50 mock tracks without deadlocks', async ({ page }) => {
	await page.goto('/?audioMock=1');
	await page.waitForFunction(
		() => Boolean((window as unknown as { __audioDebug?: unknown }).__audioDebug)
	);

	const tracks = Array.from({ length: 50 }, (_, index) =>
		makeTrack(5000 + index, `Track ${index + 1}`, 10)
	);

	await page.evaluate((queue) => {
		const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
		debug.playQueue(queue, 0);
	}, tracks);

	for (const track of tracks) {
		await page.waitForFunction(
			(id) => {
				const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
				const state = debug.getState();
				return state.currentTrack?.id === id && state.isPlaying && state.status !== 'error';
			},
			track.id,
			{ timeout: 4000 }
		);

		const status = await page.evaluate(() => {
			const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
			return debug.getState().status;
		});
		expect(status).not.toBe('error');

		await page.evaluate(() => {
			const debug = (window as unknown as { __audioDebug: any }).__audioDebug;
			debug.next();
		});
	}
});
