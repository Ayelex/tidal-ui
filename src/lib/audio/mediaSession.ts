import type { PlayableTrack } from '$lib/types';
import { isSonglinkTrack } from '$lib/types';
import { formatArtists } from '$lib/utils';
import { losslessAPI } from '$lib/api';

type MediaSessionState = 'playing' | 'paused' | 'none';

export interface MediaSessionBridgeOptions {
	onPlay: () => void;
	onPause: () => void;
	onNext: () => void;
	onPrevious: () => void;
	onSeekTo: (seconds: number) => void;
	getPositionState: () => { duration: number; position: number; playbackRate: number };
}

const canUseMediaSession = typeof navigator !== 'undefined' && 'mediaSession' in navigator;

function buildArtwork(track: PlayableTrack): MediaImage[] {
	if (isSonglinkTrack(track)) {
		if (track.thumbnailUrl) {
			return [
				{
					src: track.thumbnailUrl,
					sizes: '640x640',
					type: 'image/jpeg'
				}
			];
		}
		return [];
	}
	if (!track.album?.cover) {
		return [];
	}
	const sizes = ['80', '160', '320', '640', '1280'] as const;
	const artwork = sizes.map((size): MediaImage | null => {
			const src = losslessAPI.getCoverUrl(track.album.cover!, size);
			return src
				? {
						src,
						sizes: `${size}x${size}`,
						type: 'image/jpeg'
				  }
				: null;
		});
	return artwork.filter((entry): entry is MediaImage => entry !== null);
}

export function createMediaSessionBridge(options: MediaSessionBridgeOptions) {
	if (!canUseMediaSession) {
		return {
			enabled: false,
			updateMetadata: (_track: PlayableTrack | null) => {},
			updatePlaybackState: (_state: MediaSessionState) => {},
			updatePositionState: () => {},
			refreshHandlers: () => {},
			destroy: () => {}
		};
	}

	let lastTrackId: number | string | null = null;
	let lastPlaybackState: MediaSessionState = 'none';

	const safeSetHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
		try {
			navigator.mediaSession.setActionHandler(action, handler);
		} catch {
			// Unsupported action.
		}
	};

	const refreshHandlers = () => {
		safeSetHandler('play', () => options.onPlay());
		safeSetHandler('pause', () => options.onPause());
		safeSetHandler('previoustrack', () => options.onPrevious());
		safeSetHandler('nexttrack', () => options.onNext());
		safeSetHandler('seekforward', null);
		safeSetHandler('seekbackward', null);
		safeSetHandler('seekto', (details) => {
			if (typeof details.seekTime !== 'number') {
				return;
			}
			options.onSeekTo(details.seekTime);
			updatePositionState();
		});
	};

	const updateMetadata = (track: PlayableTrack | null) => {
		if (!track) {
			lastTrackId = null;
			try {
				navigator.mediaSession.metadata = null;
			} catch {}
			return;
		}
		if (lastTrackId === track.id) {
			return;
		}
		lastTrackId = track.id;
		try {
			navigator.mediaSession.metadata = new MediaMetadata({
				title: track.title ?? '',
				artist: isSonglinkTrack(track) ? track.artistName : formatArtists(track.artists),
				album: isSonglinkTrack(track) ? '' : (track.album?.title ?? ''),
				artwork: buildArtwork(track)
			});
		} catch {}
	};

	const updatePlaybackState = (state: MediaSessionState) => {
		if (lastPlaybackState === state) {
			return;
		}
		lastPlaybackState = state;
		try {
			navigator.mediaSession.playbackState = state;
		} catch {}
	};

	const updatePositionState = () => {
		if (typeof navigator.mediaSession.setPositionState !== 'function') {
			return;
		}
		const position = options.getPositionState();
		try {
			navigator.mediaSession.setPositionState({
				duration: position.duration,
				position: position.position,
				playbackRate: position.playbackRate
			});
		} catch {}
	};

	const destroy = () => {
		const actions: MediaSessionAction[] = [
			'play',
			'pause',
			'previoustrack',
			'nexttrack',
			'seekforward',
			'seekbackward',
			'seekto',
			'stop'
		];
		for (const action of actions) {
			safeSetHandler(action, null);
		}
		try {
			navigator.mediaSession.metadata = null;
			navigator.mediaSession.playbackState = 'none';
		} catch {}
	};

	refreshHandlers();

	return {
		enabled: true,
		updateMetadata,
		updatePlaybackState,
		updatePositionState,
		refreshHandlers,
		destroy
	};
}
