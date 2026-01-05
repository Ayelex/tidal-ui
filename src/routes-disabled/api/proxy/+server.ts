import { env } from '$env/dynamic/private';
import type Redis from 'ioredis';
import type { RequestHandler } from './$types';
import { isProxyTarget } from '$lib/config';
import { getRedisClient } from '$lib/server/redis';

const allowOrigin = (origin?: string | null): boolean => {
	void origin;
	return true;
};

const hopByHopHeaders = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade'
]);

const CACHE_NAMESPACE = 'tidal:proxy:v2:';
const textEncoder = new TextEncoder();

function arrayBufferToHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let hex = '';
	for (const byte of bytes) {
		hex += byte.toString(16).padStart(2, '0');
	}
	return hex;
}

async function sha256Hex(value: string): Promise<string> {
	if (!globalThis.crypto?.subtle) {
		throw new Error('Web Crypto is not available');
	}
	const data = textEncoder.encode(value);
	const hash = await globalThis.crypto.subtle.digest('SHA-256', data);
	return arrayBufferToHex(hash);
}

const DEFAULT_CACHE_TTL_SECONDS = getEnvNumber('REDIS_CACHE_TTL_SECONDS', 300);
const SEARCH_CACHE_TTL_SECONDS = getEnvNumber('REDIS_CACHE_TTL_SEARCH_SECONDS', 300);
const TRACK_CACHE_TTL_SECONDS = getEnvNumber('REDIS_CACHE_TTL_TRACK_SECONDS', 120);
const MAX_CACHE_BODY_BYTES = getEnvNumber('REDIS_CACHE_MAX_BODY_BYTES', 200_000);

interface CachedProxyEntry {
	status: number;
	statusText: string;
	headers: [string, string][];
	bodyBase64: string;
}

function getEnvNumber(name: string, fallback: number): number {
	const raw = env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sanitizeHeaderEntries(entries: Array<[string, string]>): Array<[string, string]> {
	const blocklist = new Set(['content-encoding', 'transfer-encoding']);
	return entries.filter(([key]) => !blocklist.has(key.toLowerCase()));
}

function isCacheableContentType(contentType: string | null): boolean {
	if (!contentType) return false;
	const normalized = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
	return normalized.includes('json') || normalized.startsWith('text/');
}

function isAudioContentType(contentType: string | null): boolean {
	if (!contentType) return false;
	const normalized = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
	return normalized.startsWith('audio/');
}

function hasDisqualifyingCacheControl(cacheControl: string | null): boolean {
	if (!cacheControl) return false;
	const normalized = cacheControl.toLowerCase();
	return normalized.includes('no-store') || normalized.includes('private');
}

function getCacheTtlSeconds(url: URL): number {
	const path = url.pathname.toLowerCase();
	if (path.includes('/track/') || path.includes('/song/')) {
		return TRACK_CACHE_TTL_SECONDS;
	}
	if (path.includes('/search/')) {
		return SEARCH_CACHE_TTL_SECONDS;
	}
	if (path.includes('/album/') || path.includes('/artist/') || path.includes('/playlist/')) {
		return DEFAULT_CACHE_TTL_SECONDS;
	}
	return DEFAULT_CACHE_TTL_SECONDS;
}

async function createCacheKey(url: URL, headers: Headers): Promise<string> {
	const accept = headers.get('accept') ?? '';
	const range = headers.get('range') ?? '';
	const keyMaterial = `${url.toString()}|accept=${accept}|range=${range}`;
	const hash = await sha256Hex(keyMaterial);
	return `${CACHE_NAMESPACE}${hash}`;
}

function applyProxyHeaders(sourceHeaders: Array<[string, string]>, origin: string | null): Headers {
	const headers = new Headers();
	const sanitized = sanitizeHeaderEntries(sourceHeaders);
	for (const [key, value] of sanitized) {
		headers.append(key, value);
	}
	headers.set('Access-Control-Allow-Origin', origin ?? '*');
	headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
	headers.set('Access-Control-Allow-Headers', 'Content-Type, Range');
	headers.set('Vary', ensureVaryIncludesOrigin(headers.get('vary')));
	if (!headers.has('Cache-Control')) {
		headers.set('Cache-Control', 'public, max-age=300');
	}
	return headers;
}

function isCachedProxyEntry(value: unknown): value is CachedProxyEntry {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Partial<CachedProxyEntry>;
	return (
		typeof candidate.status === 'number' &&
		typeof candidate.statusText === 'string' &&
		Array.isArray(candidate.headers) &&
		typeof candidate.bodyBase64 === 'string'
	);
}

function base64ToUint8Array(base64: string): Uint8Array {
	if (typeof atob === 'function') {
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	}
	if (typeof Buffer !== 'undefined') {
		return Uint8Array.from(Buffer.from(base64, 'base64'));
	}
	throw new Error('Base64 decode is not available');
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
	if (typeof btoa === 'function') {
		let binary = '';
		const chunkSize = 0x8000;
		for (let i = 0; i < bytes.length; i += chunkSize) {
			const chunk = bytes.subarray(i, i + chunkSize);
			binary += String.fromCharCode(...chunk);
		}
		return btoa(binary);
	}
	if (typeof Buffer !== 'undefined') {
		return Buffer.from(bytes).toString('base64');
	}
	throw new Error('Base64 encode is not available');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

async function readCachedResponse(redis: Redis, key: string): Promise<CachedProxyEntry | null> {
	try {
		const raw = await redis.get(key);
		if (!raw) {
			return null;
		}
		const parsed = JSON.parse(raw) as unknown;
		return isCachedProxyEntry(parsed) ? (parsed as CachedProxyEntry) : null;
	} catch (error) {
		console.error('Failed to read proxy cache entry:', error);
		return null;
	}
}

async function writeCachedResponse(
	redis: Redis,
	key: string,
	entry: CachedProxyEntry,
	ttlSeconds: number
): Promise<void> {
	if (ttlSeconds <= 0) return;
	try {
		await redis.set(key, JSON.stringify(entry), 'EX', ttlSeconds);
	} catch (error) {
		console.error('Failed to store proxy cache entry:', error);
	}
}

const ensureVaryIncludesOrigin = (value: string | null): string => {
	const entries = value
		? value
				.split(',')
				.map((v) => v.trim())
				.filter(Boolean)
		: [];
	if (!entries.includes('Origin')) {
		entries.push('Origin');
	}
	return entries.join(', ');
};

const RETRYABLE_PATH_SEGMENTS = ['/track/', '/search/'];

const TOKEN_INVALID_MESSAGE = 'token has invalid payload';

const MAX_RETRY_ATTEMPTS = 2;

function isRetryEligibleTarget(url: URL): boolean {
	const path = url.pathname.toLowerCase();
	return RETRYABLE_PATH_SEGMENTS.some((segment) => path.includes(segment));
}

async function shouldRetryInvalidToken(response: Response, targetUrl: URL): Promise<boolean> {
	if (response.status !== 401) {
		return false;
	}

	if (!isRetryEligibleTarget(targetUrl)) {
		return false;
	}

	const contentType = response.headers.get('content-type');
	if (!contentType || !contentType.toLowerCase().includes('application/json')) {
		return false;
	}

	try {
		const payload = (await response.clone().json()) as {
			subStatus?: unknown;
			userMessage?: unknown;
			detail?: unknown;
		};
		const rawSubStatus =
			typeof payload?.subStatus === 'number'
				? payload.subStatus
				: typeof payload?.subStatus === 'string'
					? Number.parseInt(payload.subStatus, 10)
					: undefined;
		const subStatus =
			typeof rawSubStatus === 'number' && Number.isFinite(rawSubStatus) ? rawSubStatus : undefined;
		const combinedMessage = [payload?.userMessage, payload?.detail]
			.filter((value): value is string => typeof value === 'string')
			.join(' ')
			.toLowerCase();

		if (subStatus === 11002) {
			return true;
		}

		if (combinedMessage.includes(TOKEN_INVALID_MESSAGE)) {
			return true;
		}
	} catch (error) {
		console.debug('Proxy retry check failed to parse response', error);
	}

	return false;
}

async function fetchWithRetry(
	url: URL,
	options: RequestInit,
	fetchFn: typeof fetch
): Promise<Response> {
	let response: Response | null = null;

	for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
		response = await fetchFn(url.toString(), options);
		if (attempt < MAX_RETRY_ATTEMPTS && (await shouldRetryInvalidToken(response, url))) {
			// Cancel the body if it exists to free resources before retrying
			try {
				if (response.body && typeof response.body.cancel === 'function') {
					await response.body.cancel();
				}
			} catch (error) {
				console.debug('Failed to cancel upstream response body before retry', error);
			}
			continue;
		}
		return response;
	}

	// Fallback: return the last response if all attempts exhausted without early return
	if (response) {
		return response;
	}

	return fetchFn(url.toString(), options);
}

export const GET: RequestHandler = async ({ url, request, fetch }) => {
	const target = url.searchParams.get('url');
	const origin = request.headers.get('origin');

	if (!allowOrigin(origin)) {
		return new Response('Forbidden', { status: 403 });
	}

	if (!target) {
		return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	let parsedTarget: URL;

	try {
		parsedTarget = new URL(target);
	} catch {
		return new Response(JSON.stringify({ error: 'Invalid target URL' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	if (!isProxyTarget(parsedTarget)) {
		return new Response(JSON.stringify({ error: 'Invalid target host' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	const upstreamHeaders = new Headers();
	let hasRangeRequest = false;
	let hasAuthorizationHeader = false;
	let hasCookieHeader = false;

	request.headers.forEach((value, key) => {
		const lowerKey = key.toLowerCase();
		if (hopByHopHeaders.has(lowerKey) || lowerKey === 'host') {
			return;
		}
		if (lowerKey === 'range') {
			hasRangeRequest = true;
		}
		if (lowerKey === 'authorization') {
			hasAuthorizationHeader = true;
		}
		if (lowerKey === 'cookie') {
			hasCookieHeader = true;
		}
		upstreamHeaders.set(key, value);
	});

	if (!upstreamHeaders.has('User-Agent')) {
		upstreamHeaders.set('User-Agent', 'Mozilla/5.0 (compatible; TIDAL-UI/1.0)');
	}

	// Force identity encoding so the upstream sends plain data that Node can forward without zstd artifacts.
	upstreamHeaders.set('Accept-Encoding', 'identity');

	const shouldUseCache = !hasRangeRequest && !hasAuthorizationHeader && !hasCookieHeader;
	const redis = shouldUseCache ? getRedisClient() : null;
	const cacheKey = redis ? await createCacheKey(parsedTarget, upstreamHeaders) : null;

	if (redis && cacheKey) {
		const cached = await readCachedResponse(redis, cacheKey);
		if (cached) {
			const headers = applyProxyHeaders(cached.headers, origin);
			const bodyBytes = base64ToUint8Array(cached.bodyBase64);
			return new Response(toArrayBuffer(bodyBytes), {
				status: cached.status,
				statusText: cached.statusText,
				headers
			});
		}
	}

	try {
		const upstream = await fetchWithRetry(
			parsedTarget,
			{
				headers: upstreamHeaders,
				redirect: 'follow'
			},
			fetch
		);
		const upstreamHeaderEntries = Array.from(upstream.headers.entries());
		const sanitizedHeaderEntries = sanitizeHeaderEntries(upstreamHeaderEntries);
		const headers = applyProxyHeaders(sanitizedHeaderEntries, origin);
		const contentType = upstream.headers.get('content-type');
		const isRangeResponse = upstream.status === 206 || upstream.headers.has('content-range');
		const shouldStreamBody = hasRangeRequest || isRangeResponse || isAudioContentType(contentType);

		if (shouldStreamBody) {
			if (!headers.has('Accept-Ranges')) {
				headers.set('Accept-Ranges', 'bytes');
			}
			return new Response(upstream.body, {
				status: upstream.status,
				statusText: upstream.statusText,
				headers
			});
		}

		const bodyArrayBuffer = await upstream.arrayBuffer();
		const bodyBytes = new Uint8Array(bodyArrayBuffer);

		if (redis && cacheKey) {
			const ttlSeconds = getCacheTtlSeconds(parsedTarget);
			const cacheControl = upstream.headers.get('cache-control');
			const byteLength = bodyBytes.byteLength;
			const cacheable =
				upstream.status === 200 &&
				ttlSeconds > 0 &&
				!hasDisqualifyingCacheControl(cacheControl) &&
				isCacheableContentType(contentType) &&
				byteLength <= MAX_CACHE_BODY_BYTES;

			if (cacheable) {
				const entry: CachedProxyEntry = {
					status: upstream.status,
					statusText: upstream.statusText,
					headers: sanitizedHeaderEntries,
					bodyBase64: uint8ArrayToBase64(bodyBytes)
				};
				await writeCachedResponse(redis, cacheKey, entry, ttlSeconds);
			}
		}

		return new Response(bodyArrayBuffer, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers
		});
	} catch (error) {
		console.error('Proxy error:', error);
		return new Response(
			JSON.stringify({
				error: 'Proxy request failed',
				message: error instanceof Error ? error.message : 'Unknown error'
			}),
			{
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			}
		);
	}
};

export const OPTIONS: RequestHandler = async ({ request }) => {
	const origin = request.headers.get('origin');

	if (!allowOrigin(origin)) {
		return new Response(null, { status: 403 });
	}

	const headers = new Headers();
	headers.set('Access-Control-Allow-Origin', origin ?? '*');
	headers.set('Vary', 'Origin');
	headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
	headers.set('Access-Control-Allow-Headers', 'Content-Type, Range');
	headers.set('Access-Control-Max-Age', '86400');

	return new Response(null, {
		status: 204,
		headers
	});
};
