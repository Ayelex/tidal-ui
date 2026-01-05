type EventHandler = (event: Event) => void;

export interface AudioElementLike {
	src: string;
	currentTime: number;
	duration: number;
	paused: boolean;
	ended?: boolean;
	readyState: number;
	networkState: number;
	preload: string;
	autoplay: boolean;
	loop: boolean;
	crossOrigin: string | null;
	volume: number;
	muted: boolean;
	buffered: TimeRanges;
	seekable: TimeRanges;
	playbackRate: number;
	play: () => Promise<void>;
	pause: () => void;
	load: () => void;
	addEventListener: (type: string, handler: EventHandler) => void;
	removeEventListener: (type: string, handler: EventHandler) => void;
	fastSeek?: (time: number) => void;
}

class MockTimeRanges implements TimeRanges {
	private endValue = 0;
	length = 1;

	setEnd(end: number) {
		this.endValue = Math.max(0, end);
	}

	start(index: number): number {
		if (index !== 0) {
			throw new Error('Index out of range');
		}
		return 0;
	}

	end(index: number): number {
		if (index !== 0) {
			throw new Error('Index out of range');
		}
		return this.endValue;
	}
}

export class MockAudioElement implements AudioElementLike {
	src = '';
	currentTime = 0;
	duration = 0;
	paused = true;
	ended = false;
	readyState = 0;
	networkState = 0;
	preload = 'auto';
	autoplay = false;
	loop = false;
	crossOrigin: string | null = null;
	volume = 1;
	muted = false;
	playbackRate = 1;
	buffered: MockTimeRanges = new MockTimeRanges();
	seekable: MockTimeRanges = new MockTimeRanges();

	private handlers = new Map<string, Set<EventHandler>>();
	private intervalId: ReturnType<typeof setInterval> | null = null;
	private mockDuration = 120;

	setMockDuration(seconds: number) {
		if (Number.isFinite(seconds) && seconds > 0) {
			this.mockDuration = seconds;
		}
	}

	addEventListener(type: string, handler: EventHandler) {
		const set = this.handlers.get(type) ?? new Set<EventHandler>();
		set.add(handler);
		this.handlers.set(type, set);
	}

	removeEventListener(type: string, handler: EventHandler) {
		const set = this.handlers.get(type);
		if (!set) {
			return;
		}
		set.delete(handler);
	}

	private emit(type: string) {
		const event = new Event(type);
		const set = this.handlers.get(type);
		if (!set) {
			return;
		}
		for (const handler of set.values()) {
			handler(event);
		}
	}

	load() {
		this.readyState = 2;
		this.duration = this.duration > 0 ? this.duration : this.mockDuration;
		this.buffered.setEnd(Math.min(this.duration, this.currentTime + 8));
		this.seekable.setEnd(this.duration);
		queueMicrotask(() => {
			this.emit('loadedmetadata');
			this.emit('loadeddata');
			this.emit('canplay');
		});
	}

	async play(): Promise<void> {
		if (!this.paused) {
			return;
		}
		this.paused = false;
		this.ended = false;
		this.emit('play');
		this.emit('playing');
		this.startClock();
	}

	pause() {
		if (this.paused) {
			return;
		}
		this.paused = true;
		this.stopClock();
		this.emit('pause');
	}

	fastSeek(time: number) {
		const duration = this.duration > 0 ? this.duration : this.mockDuration;
		this.duration = duration;
		this.emit('seeking');
		this.currentTime = Math.max(0, Math.min(duration, time));
		this.buffered.setEnd(Math.min(duration, this.currentTime + 8));
		this.seekable.setEnd(duration);
		this.emit('timeupdate');
		this.emit('seeked');
	}

	private startClock() {
		this.stopClock();
		this.intervalId = setInterval(() => {
			if (this.paused) {
				return;
			}
			this.currentTime = Math.min(this.duration, this.currentTime + 0.25);
			this.buffered.setEnd(Math.min(this.duration, this.currentTime + 8));
			this.emit('timeupdate');
			if (this.currentTime >= this.duration) {
				this.currentTime = this.duration;
				this.ended = true;
				this.emit('ended');
				if (!this.loop) {
					this.pause();
				}
			}
		}, 250);
	}

	private stopClock() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}
}

export function createAudioElement(options?: { mock?: boolean }) {
	if (options?.mock) {
		return { element: new MockAudioElement(), realElement: null as HTMLAudioElement | null };
	}
	const element = document.createElement('audio');
	element.preload = 'auto';
	element.autoplay = false;
	element.loop = false;
	element.crossOrigin = 'anonymous';
	return { element: element as AudioElementLike, realElement: element };
}
