import { browser } from '$app/environment';
import { losslessAPI } from '$lib/api';
import type { AudioQuality, Track } from '$lib/types';

type PrefetchItem = {
	trackId: number;
	quality: AudioQuality;
};

const queued = new Map<string, PrefetchItem>();
let draining = false;
const MAX_QUEUE = 30;
const DEFAULT_LIMIT = 8;

function getKey(item: PrefetchItem): string {
	return `${item.trackId}:${item.quality}`;
}

function scheduleDrain() {
	if (draining) {
		return;
	}
	draining = true;
	if (typeof requestIdleCallback === 'function') {
		requestIdleCallback(() => void drainQueue());
	} else {
		setTimeout(() => void drainQueue(), 0);
	}
}

async function drainQueue() {
	while (queued.size > 0) {
		const [key, item] = queued.entries().next().value as [string, PrefetchItem];
		queued.delete(key);
		try {
			await losslessAPI.getStreamData(item.trackId, item.quality);
		} catch (error) {
			console.debug('Stream prefetch failed', error);
		}
	}
	draining = false;
	if (queued.size > 0) {
		scheduleDrain();
	}
}

function normalizeTracks(tracks: Track[], limit: number): Track[] {
	if (!Array.isArray(tracks) || tracks.length === 0) {
		return [];
	}
	if (!Number.isFinite(limit) || limit <= 0) {
		return [];
	}
	return tracks.slice(0, Math.min(limit, tracks.length));
}

export function prefetchStreamUrls(
	tracks: Track[],
	quality: AudioQuality,
	limit: number = DEFAULT_LIMIT
): void {
	if (!browser) {
		return;
	}
	const candidates = normalizeTracks(tracks, limit);
	if (candidates.length === 0) {
		return;
	}
	for (const track of candidates) {
		if (!track || !Number.isFinite(track.id)) {
			continue;
		}
		if (queued.size >= MAX_QUEUE) {
			break;
		}
		const item: PrefetchItem = { trackId: track.id, quality };
		const key = getKey(item);
		if (queued.has(key)) {
			continue;
		}
		queued.set(key, item);
	}
	scheduleDrain();
}

