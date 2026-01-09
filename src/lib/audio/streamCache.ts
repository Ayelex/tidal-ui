import { browser } from '$app/environment';
import type { AudioQuality } from '$lib/types';

export type StreamCacheEntry = {
	key: string;
	trackId: number;
	quality: AudioQuality;
	url: string;
	replayGain: number | null;
	sampleRate: number | null;
	bitDepth: number | null;
	fetchedAt: number;
	lastUsedAt: number;
	validatedAt: number;
	expiresAt?: number | null;
	failureCount?: number;
	lastFailureAt?: number;
};

type StreamCacheStats = {
	hits: number;
	misses: number;
	entries: number;
};

const DB_NAME = 'tidal-ui';
const STORE_NAME = 'stream-cache-v1';
const LOCAL_KEY = 'tidal-ui.stream-cache.v2';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 2;
const SAFETY_MARGIN_MS = 30 * 1000;
const MAX_ENTRIES = 600;

const canUseIdb = () => browser && typeof indexedDB !== 'undefined';

const getKey = (trackId: number, quality: AudioQuality) => `${trackId}:${quality}`;

const parseAmzDate = (value: string): number | null => {
	const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
	if (!match) {
		return null;
	}
	const [, year, month, day, hour, minute, second] = match;
	const ms = Date.UTC(
		Number(year),
		Number(month) - 1,
		Number(day),
		Number(hour),
		Number(minute),
		Number(second)
	);
	return Number.isFinite(ms) ? ms : null;
};

const parseExpiryFromUrl = (url: string): number | null => {
	try {
		const parsed = new URL(url);
		const expiresValue =
			parsed.searchParams.get('Expires') ?? parsed.searchParams.get('expires') ?? null;
		if (expiresValue) {
			const numeric = Number(expiresValue);
			if (Number.isFinite(numeric)) {
				if (numeric > 1e12) {
					return numeric;
				}
				if (numeric > 1e9) {
					return numeric * 1000;
				}
			}
		}

		const amzDate = parsed.searchParams.get('X-Amz-Date');
		const amzExpires = parsed.searchParams.get('X-Amz-Expires');
		if (amzDate && amzExpires) {
			const base = parseAmzDate(amzDate);
			const seconds = Number(amzExpires);
			if (Number.isFinite(base) && Number.isFinite(seconds)) {
				return base + seconds * 1000;
			}
		}
	} catch {
		return null;
	}
	return null;
};

const openDb = async (): Promise<IDBDatabase | null> => {
	if (!canUseIdb()) {
		return null;
	}
	return new Promise((resolve) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				db.createObjectStore(STORE_NAME, { keyPath: 'key' });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => resolve(null);
	});
};

const readAllFromDb = async (): Promise<StreamCacheEntry[] | null> => {
	const db = await openDb();
	if (!db) {
		return null;
	}
	return new Promise((resolve) => {
		const tx = db.transaction(STORE_NAME, 'readonly');
		const store = tx.objectStore(STORE_NAME);
		const request = store.getAll();
		request.onsuccess = () => {
			resolve(request.result as StreamCacheEntry[]);
			db.close();
		};
		request.onerror = () => {
			resolve(null);
			db.close();
		};
	});
};

const writeAllToDb = async (entries: StreamCacheEntry[]): Promise<boolean> => {
	const db = await openDb();
	if (!db) {
		return false;
	}
	return new Promise((resolve) => {
		const tx = db.transaction(STORE_NAME, 'readwrite');
		const store = tx.objectStore(STORE_NAME);
		store.clear();
		for (const entry of entries) {
			store.put(entry);
		}
		tx.oncomplete = () => {
			resolve(true);
			db.close();
		};
		tx.onerror = () => {
			resolve(false);
			db.close();
		};
	});
};

const readAllFromLocalStorage = (): StreamCacheEntry[] | null => {
	if (!browser) {
		return null;
	}
	try {
		const raw = localStorage.getItem(LOCAL_KEY);
		if (!raw) {
			return null;
		}
		const parsed = JSON.parse(raw) as Record<string, StreamCacheEntry>;
		if (!parsed || typeof parsed !== 'object') {
			return null;
		}
		return Object.values(parsed);
	} catch {
		return null;
	}
};

const writeAllToLocalStorage = (entries: StreamCacheEntry[]): void => {
	if (!browser) {
		return;
	}
	try {
		const payload: Record<string, StreamCacheEntry> = {};
		for (const entry of entries) {
			payload[entry.key] = entry;
		}
		localStorage.setItem(LOCAL_KEY, JSON.stringify(payload));
	} catch {
		// ignore storage failures
	}
};

class StreamCache {
	private entries = new Map<string, StreamCacheEntry>();
	private hydrated = false;
	private hydratePromise: Promise<void> | null = null;
	private persistScheduled = false;
	private preferIdb = canUseIdb();
	private stats: StreamCacheStats = { hits: 0, misses: 0, entries: 0 };

	private ensureHydrated() {
		if (!browser || this.hydrated) {
			return;
		}
		this.hydrated = true;
		void this.hydrate();
	}

	private schedulePersist() {
		if (!browser || this.persistScheduled) {
			return;
		}
		this.persistScheduled = true;
		setTimeout(() => {
			this.persistScheduled = false;
			void this.persist();
		}, 1000);
	}

	private isEntryExpired(entry: StreamCacheEntry, now: number): boolean {
		if (entry.expiresAt && now >= entry.expiresAt - SAFETY_MARGIN_MS) {
			return true;
		}
		const base = Number.isFinite(entry.validatedAt) ? entry.validatedAt : entry.fetchedAt;
		if (!Number.isFinite(base)) {
			return true;
		}
		return now - base > CACHE_TTL_MS;
	}

	private pruneToLimit() {
		if (this.entries.size <= MAX_ENTRIES) {
			return;
		}
		const sorted = Array.from(this.entries.values()).sort(
			(a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0)
		);
		for (let i = 0; i < sorted.length - MAX_ENTRIES; i += 1) {
			const entry = sorted[i];
			this.entries.delete(entry.key);
		}
	}

	private async hydrate() {
		if (this.hydratePromise) {
			return this.hydratePromise;
		}
		this.hydratePromise = (async () => {
			const now = Date.now();
			let loaded: StreamCacheEntry[] | null = null;
			if (this.preferIdb) {
				loaded = await readAllFromDb();
			}
			if (!loaded || loaded.length === 0) {
				loaded = readAllFromLocalStorage();
				if (loaded && loaded.length > 0 && this.preferIdb) {
					void writeAllToDb(loaded);
				}
			}
			if (Array.isArray(loaded)) {
				for (const entry of loaded) {
					if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string') {
						continue;
					}
					if (!Number.isFinite(entry.trackId) || !entry.quality) {
						continue;
					}
					const fetchedAt = Number.isFinite(entry.fetchedAt) ? entry.fetchedAt : now;
					const validatedAt = Number.isFinite(entry.validatedAt) ? entry.validatedAt : fetchedAt;
					const lastUsedAt = Number.isFinite(entry.lastUsedAt) ? entry.lastUsedAt : validatedAt;
					const key = entry.key || getKey(entry.trackId, entry.quality);
					const normalized: StreamCacheEntry = {
						...entry,
						key,
						fetchedAt,
						validatedAt,
						lastUsedAt
					};
					if (this.isEntryExpired(normalized, now)) {
						continue;
					}
					this.entries.set(key, normalized);
				}
			}
			this.pruneToLimit();
			this.stats.entries = this.entries.size;
			this.schedulePersist();
		})();
		await this.hydratePromise;
	}

	private async persist() {
		const entries = Array.from(this.entries.values());
		this.stats.entries = entries.length;
		if (this.preferIdb) {
			const ok = await writeAllToDb(entries);
			if (!ok) {
				this.preferIdb = false;
				writeAllToLocalStorage(entries);
			}
			return;
		}
		writeAllToLocalStorage(entries);
	}

	get(trackId: number, quality: AudioQuality): StreamCacheEntry | null {
		this.ensureHydrated();
		const key = getKey(trackId, quality);
		const entry = this.entries.get(key);
		if (!entry) {
			this.stats.misses += 1;
			return null;
		}
		const now = Date.now();
		if (this.isEntryExpired(entry, now)) {
			this.entries.delete(key);
			this.stats.misses += 1;
			this.schedulePersist();
			return null;
		}
		entry.lastUsedAt = now;
		this.entries.set(key, entry);
		this.stats.hits += 1;
		this.schedulePersist();
		return entry;
	}

	setValidated(params: {
		trackId: number;
		quality: AudioQuality;
		url: string;
		replayGain: number | null;
		sampleRate: number | null;
		bitDepth: number | null;
		fetchedAt?: number;
	}) {
		this.ensureHydrated();
		const now = Date.now();
		const key = getKey(params.trackId, params.quality);
		const expiresAt = parseExpiryFromUrl(params.url);
		const entry: StreamCacheEntry = {
			key,
			trackId: params.trackId,
			quality: params.quality,
			url: params.url,
			replayGain: params.replayGain ?? null,
			sampleRate: params.sampleRate ?? null,
			bitDepth: params.bitDepth ?? null,
			fetchedAt: params.fetchedAt ?? now,
			lastUsedAt: now,
			validatedAt: now,
			expiresAt: expiresAt ?? undefined,
			failureCount: 0,
			lastFailureAt: undefined
		};
		this.entries.set(key, entry);
		this.pruneToLimit();
		this.schedulePersist();
	}

	recordFailure(trackId: number, quality: AudioQuality) {
		this.ensureHydrated();
		const key = getKey(trackId, quality);
		const entry = this.entries.get(key);
		if (!entry) {
			return;
		}
		const now = Date.now();
		const lastFailureAt = entry.lastFailureAt ?? 0;
		const withinWindow = now - lastFailureAt <= FAILURE_WINDOW_MS;
		const nextFailures = withinWindow ? (entry.failureCount ?? 0) + 1 : 1;
		if (nextFailures >= MAX_FAILURES) {
			this.entries.delete(key);
			this.schedulePersist();
			return;
		}
		entry.failureCount = nextFailures;
		entry.lastFailureAt = now;
		this.entries.set(key, entry);
		this.schedulePersist();
	}

	invalidate(trackId: number, quality?: AudioQuality) {
		this.ensureHydrated();
		if (quality) {
			this.entries.delete(getKey(trackId, quality));
			this.schedulePersist();
			return;
		}
		const prefix = `${trackId}:`;
		for (const key of this.entries.keys()) {
			if (key.startsWith(prefix)) {
				this.entries.delete(key);
			}
		}
		this.schedulePersist();
	}

	getStats(): StreamCacheStats {
		return {
			hits: this.stats.hits,
			misses: this.stats.misses,
			entries: this.entries.size
		};
	}
}

export const streamCache = new StreamCache();
