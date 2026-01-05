import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import crypto from 'crypto';

// Browser version for headers
const BROWSER_VERSION = '131';

// Common headers for Spotify requests
const COMMON_HEADERS = {
	'Content-Type': 'application/json',
	'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${BROWSER_VERSION}.0.0.0 Safari/537.36`,
	'Sec-Ch-Ua': `"Chromium";v="${BROWSER_VERSION}", "Not(A:Brand";v="24", "Google Chrome";v="${BROWSER_VERSION}"`
};

// Fallback secret (from SpotAPI code)
const FALLBACK_SECRET = [
	44, 55, 47, 42, 70, 40, 34, 114, 76, 74, 50, 111, 120, 97, 75, 76, 94, 102, 43, 69, 49, 120, 118,
	80, 64, 78
];

// Function to fetch latest secret
async function getLatestTotpSecret() {
	return { version: 61, secret: FALLBACK_SECRET };
}

// Generate TOTP
function generateTotp(secret: number[]) {
	const transformed = secret.map((e, t) => e ^ ((t % 33) + 9));
	const joined = transformed.map((num) => num.toString()).join('');
	const hexStr = Buffer.from(joined, 'ascii').toString('hex');
	const base32Secret = Buffer.from(hexStr, 'hex').toString('base64').replace(/=/g, '');

	// Simple TOTP generation (using crypto for HMAC)
	const timeStep = Math.floor(Date.now() / 1000 / 30);
	const timeHex = timeStep.toString(16).padStart(16, '0');
	const hmac = crypto.createHmac('sha1', Buffer.from(base32Secret, 'base64'));
	hmac.update(Buffer.from(timeHex, 'hex'));
	const digest = hmac.digest();
	const offset = digest[19] & 0xf;
	const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
	return code.toString().padStart(6, '0');
}

// Extract all JavaScript links from HTML
function extractJsLinks(html: string): string[] {
	const jsLinks: string[] = [];
	const scriptTagRegex = /<script[^>]+src="([^"]+\.js)"[^>]*>/g;
	let match;

	while ((match = scriptTagRegex.exec(html)) !== null) {
		jsLinks.push(match[1]);
	}

	return jsLinks;
}

// Cache session data briefly to avoid re-scraping Spotify on every request.
let cachedSession:
	| { deviceId: string; clientVersion: string; jsPack: string; expiresAt: number }
	| null = null;
const SESSION_TTL_MS = 5 * 60 * 1000;

type SpotifyCoverSource = {
	url?: string;
};

type SpotifyTrackData = {
	uri?: string;
	name?: string;
	duration?: { totalMilliseconds?: number };
	trackNumber?: number;
	externalIds?: { isrc?: string };
	artists?: { items?: Array<{ profile?: { name?: string } }> };
	album?: {
		name?: string;
		coverArt?: { sources?: SpotifyCoverSource[]; images?: SpotifyCoverSource[] };
		images?: SpotifyCoverSource[];
	};
};

type SpotifyPlaylistItem = {
	itemV2?: {
		data?: SpotifyTrackData;
	};
};

function hasSpotifyTrackUri(
	item: SpotifyPlaylistItem
): item is SpotifyPlaylistItem & { itemV2: { data: SpotifyTrackData & { uri: string } } } {
	return typeof item.itemV2?.data?.uri === 'string';
}

// Get session and extract data
async function getSessionData() {
	if (cachedSession && Date.now() < cachedSession.expiresAt) {
		return cachedSession;
	}
	const response = await fetch('https://open.spotify.com', {
		headers: COMMON_HEADERS
	});
	const html = await response.text();
	const cookie = response.headers.get('set-cookie')?.match(/sp_t=([^;]+)/)?.[1] || '';

	// Extract base64-encoded appServerConfig
	const appServerConfigMatch = html.match(
		/<script id="appServerConfig" type="text\/plain">([^<]+)<\/script>/
	);

	let clientVersion = '';
	if (appServerConfigMatch) {
		try {
			const base64Config = appServerConfigMatch[1];
			const decodedConfig = Buffer.from(base64Config, 'base64').toString('utf-8');
			const serverConfig = JSON.parse(decodedConfig);
			clientVersion = serverConfig.clientVersion || '';
		} catch (e) {
			console.error('Failed to parse appServerConfig, falling back to regex');
			// Fallback to old method if parsing fails
			clientVersion = html.match(/"clientVersion":"([^"]+)"/)?.[1] || '';
		}
	} else {
		// Fallback to old method if appServerConfig not found
		clientVersion = html.match(/"clientVersion":"([^"]+)"/)?.[1] || '';
	}

	// Extract all JS links and find the web-player one
	const allJsLinks = extractJsLinks(html);
	const jsPackRelative =
		allJsLinks.find((link) => link.includes('web-player/web-player') && link.endsWith('.js')) || '';
	const jsPack = jsPackRelative.startsWith('http')
		? jsPackRelative
		: `https://open.spotify.com${jsPackRelative}`;

	const session = {
		deviceId: cookie,
		clientVersion,
		jsPack,
		expiresAt: Date.now() + SESSION_TTL_MS
	};
	cachedSession = session;
	return session;
}

// Get access token
async function getAccessToken(totp: string, totpVer: number) {
	const params = new URLSearchParams({
		reason: 'init',
		productType: 'web-player',
		totp,
		totpVer: totpVer.toString(),
		totpServer: totp
	});
	const response = await fetch(`https://open.spotify.com/api/token?${params}`, {
		headers: COMMON_HEADERS
	});
	const data = await response.json();
	return { accessToken: data.accessToken, clientId: data.clientId };
}

// Get client token
async function getClientToken(clientVersion: string, clientId: string, deviceId: string) {
	const payload = {
		client_data: {
			client_version: clientVersion,
			client_id: clientId,
			js_sdk_data: {
				device_brand: 'unknown',
				device_model: 'unknown',
				os: 'windows',
				os_version: 'NT 10.0',
				device_id: deviceId,
				device_type: 'computer'
			}
		}
	};
	const response = await fetch('https://clienttoken.spotify.com/v1/clienttoken', {
		method: 'POST',
		headers: {
			...COMMON_HEADERS,
			Authority: 'clienttoken.spotify.com',
			Accept: 'application/json'
		},
		body: JSON.stringify(payload)
	});
	const data = await response.json();
	return data.granted_token.token;
}

// Extract mappings from JS code
function extractMappings(jsCode: string): [Record<string, string>, Record<string, string>] {
	// Pattern to match objects like: {123:"value",456:"another"}
	const pattern = /\{\d+:"[^"]+"(?:,\d+:"[^"]+")*\}/g;
	const matches = jsCode.match(pattern);

	if (!matches || matches.length < 5) {
		console.warn(`Found only ${matches?.length || 0} mappings, need at least 5`);
		return [{}, {}];
	}

	// Parse the 4th match (index 3) as mapping1 (chunk names)
	const mapping1: Record<string, string> = {};
	const match3 = matches[3];
	const entries3 = match3.slice(1, -1).split(/,(?=\d+:)/);

	for (const entry of entries3) {
		const colonIndex = entry.indexOf(':');
		if (colonIndex === -1) continue;

		const key = entry.substring(0, colonIndex).trim();
		const value = entry
			.substring(colonIndex + 1)
			.trim()
			.replace(/^"|"$/g, '');
		mapping1[key] = value;
	}

	// Parse the 5th match (index 4) as mapping2 (chunk hashes)
	const mapping2: Record<string, string> = {};
	const match4 = matches[4];
	const entries4 = match4.slice(1, -1).split(/,(?=\d+:)/);

	for (const entry of entries4) {
		const colonIndex = entry.indexOf(':');
		if (colonIndex === -1) continue;

		const key = entry.substring(0, colonIndex).trim();
		const value = entry
			.substring(colonIndex + 1)
			.trim()
			.replace(/^"|"$/g, '');
		mapping2[key] = value;
	}

	return [mapping1, mapping2];
}

// Combine chunks from mappings
function combineChunks(
	strMapping: Record<string, string>,
	hashMapping: Record<string, string>
): string[] {
	const chunks: string[] = [];
	for (const [key, str] of Object.entries(strMapping)) {
		const hash = hashMapping[key];
		if (hash) {
			chunks.push(`${str}.${hash}.js`);
		}
	}
	return chunks;
}

// Cache the persisted query hash for a short window to cut JS parsing cost.
let cachedQueryHash: { value: string; expiresAt: number } | null = null;
const QUERY_HASH_TTL_MS = 10 * 60 * 1000;

// Get sha256 hash
async function getSha256Hash(jsPack: string): Promise<string> {
	if (cachedQueryHash && Date.now() < cachedQueryHash.expiresAt) {
		return cachedQueryHash.value;
	}
	if (!jsPack) {
		console.warn('No JS pack URL, using fallback hash');
		return 'a67612f8c59f4cb4a9723d8e0e0e7b7cb8c5c3d45e3d8c4f5e6f7e8f9a0b1c2d';
	}

	try {
		// Fetch the main JS pack
		const response = await fetch(jsPack, {
			headers: COMMON_HEADERS
		});
		let rawHashes = await response.text();

		// Extract mappings and combine chunks
		const [strMapping, hashMapping] = extractMappings(rawHashes);
		const chunks = combineChunks(strMapping, hashMapping);

		// Fetch additional chunks
		for (const chunk of chunks) {
			const chunkUrl = `https://open.spotifycdn.com/cdn/build/web-player/${chunk}`;
			try {
				const chunkResponse = await fetch(chunkUrl, {
					headers: COMMON_HEADERS
				});
				rawHashes += await chunkResponse.text();
			} catch (e) {
				console.warn(`Failed to fetch chunk ${chunk}:`, e);
			}
		}

		// Extract the fetchPlaylist hash
		let hash = '';
		try {
			// Try as query first
			hash = rawHashes.split('"fetchPlaylist","query","')[1].split('"')[0];
		} catch (e) {
			try {
				// Try as mutation
				hash = rawHashes.split('"fetchPlaylist","mutation","')[1].split('"')[0];
			} catch (e2) {
				console.warn('Failed to extract fetchPlaylist hash, using fallback');
				hash = 'a67612f8c59f4cb4a9723d8e0e0e7b7cb8c5c3d45e3d8c4f5e6f7e8f9a0b1c2d';
			}
		}
		cachedQueryHash = { value: hash, expiresAt: Date.now() + QUERY_HASH_TTL_MS };
		return hash;
	} catch (error) {
		console.error('Failed to get sha256 hash:', error);
		return 'a67612f8c59f4cb4a9723d8e0e0e7b7cb8c5c3d45e3d8c4f5e6f7e8f9a0b1c2d';
	}
}

// Fetch playlist data
async function fetchPlaylist(
	accessToken: string,
	clientToken: string,
	clientVersion: string,
	playlistId: string,
	jsPack: string,
	offset = 0,
	limit = 25
) {
	const sha256Hash = await getSha256Hash(jsPack);
	const variables = {
		uri: `spotify:playlist:${playlistId}`,
		offset,
		limit,
		enableWatchFeedEntrypoint: false
	};
	const extensions = {
		persistedQuery: {
			version: 1,
			sha256Hash
		}
	};
	const params = JSON.stringify({
		operationName: 'fetchPlaylist',
		variables,
		extensions
	});
	console.log(params);
	const response = await fetch('https://api-partner.spotify.com/pathfinder/v2/query', {
		method: 'POST',
		headers: {
			'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${BROWSER_VERSION}.0.0.0 Safari/537.36`,
			'Sec-Ch-Ua': `"Chromium";v="${BROWSER_VERSION}", "Not(A:Brand";v="24", "Google Chrome";v="${BROWSER_VERSION}"`,
			Authorization: `Bearer ${accessToken}`,
			'Client-Token': clientToken,
			'Spotify-App-Version': clientVersion,
			'Content-Type': 'application/json;charset=UTF-8'
		},
		body: params
	});
	const data = await response.json();
	console.log(data);
	return data;
}

async function fetchPlaylistPage(
	accessToken: string,
	clientToken: string,
	clientVersion: string,
	playlistId: string,
	jsPack: string,
	offset: number,
	limit: number
): Promise<{ items: SpotifyPlaylistItem[]; totalCount: number }> {
	const data = await fetchPlaylist(
		accessToken,
		clientToken,
		clientVersion,
		playlistId,
		jsPack,
		offset,
		limit
	);
	const content = data?.data?.playlistV2?.content;
	if (!content) {
		return { items: [], totalCount: 0 };
	}
	return {
		items: Array.isArray(content.items) ? (content.items as SpotifyPlaylistItem[]) : [],
		totalCount: content.totalCount ?? 0
	};
}

// Paginate playlist (parallelized)
async function getAllTracks(
	accessToken: string,
	clientToken: string,
	clientVersion: string,
	playlistId: string,
	jsPack: string
): Promise<SpotifyPlaylistItem[]> {
	const limit = 50;
	const firstPage = await fetchPlaylistPage(
		accessToken,
		clientToken,
		clientVersion,
		playlistId,
		jsPack,
		0,
		limit
	);
	const tracks = [...firstPage.items];
	const totalCount = firstPage.totalCount || tracks.length;
	if (tracks.length >= totalCount) {
		return tracks;
	}

	const offsets: number[] = [];
	for (let offset = limit; offset < totalCount; offset += limit) {
		offsets.push(offset);
	}

	const CONCURRENCY = 4;
	for (let i = 0; i < offsets.length; i += CONCURRENCY) {
		const batch = offsets.slice(i, i + CONCURRENCY);
		const results = await Promise.all(
			batch.map((offset) =>
				fetchPlaylistPage(
					accessToken,
					clientToken,
					clientVersion,
					playlistId,
					jsPack,
					offset,
					limit
				)
			)
		);
		for (const result of results) {
			if (result.items.length > 0) {
				tracks.push(...result.items);
			}
		}
	}

	return tracks;
}

export const POST: RequestHandler = async ({ request }) => {
	try {
		const { playlistUrl } = await request.json();

		// Extract playlist ID from URL
		const playlistId = playlistUrl.includes('playlist/')
			? playlistUrl.split('playlist/')[1].split('?')[0]
			: playlistUrl;

		// Get session
		const { deviceId, clientVersion, jsPack } = await getSessionData();

		// Get TOTP
		const { secret, version } = await getLatestTotpSecret();
		const totp = generateTotp(secret);

		// Get tokens
		const { accessToken, clientId } = await getAccessToken(totp, version);
		const clientToken = await getClientToken(clientVersion, clientId, deviceId);

		// Get tracks
		const tracks = await getAllTracks(accessToken, clientToken, clientVersion, playlistId, jsPack);

		// Extract song links (track URIs in the format spotify:track:id)
		const trackMetadata = tracks
			.filter(hasSpotifyTrackUri)
			.map((item) => {
				const uri = item.itemV2.data.uri;
				const trackId = uri.split(':')[2];
				const trackData = item.itemV2.data;
				const coverSources =
					trackData?.album?.coverArt?.sources ??
					trackData?.album?.coverArt?.images ??
					trackData?.album?.images ??
					[];
				const albumImageUrl =
					Array.isArray(coverSources) && coverSources.length > 0
						? coverSources[coverSources.length - 1]?.url ?? coverSources[0]?.url
						: undefined;
				
				return {
					title: trackData.name || 'Unknown Title',
					artistName: trackData.artists?.items?.[0]?.profile?.name || 'Unknown Artist',
					albumName: trackData.album?.name,
					albumImageUrl,
					spotifyId: trackId,
					duration: trackData.duration?.totalMilliseconds,
					isrc: trackData.externalIds?.isrc,
					trackNumber: trackData.trackNumber
				};
			});

		console.log(`Extracted ${trackMetadata.length} track metadata entries from ${tracks.length} tracks`);
		
		return json({ 
			trackMetadata, 
			totalTracks: trackMetadata.length,
			rawTrackCount: tracks.length,
			playlistTitle: 'Spotify Playlist', // Could be extracted from playlist data if available
			playlistDescription: ''
		});
	} catch (error) {
		console.error('Spotify playlist fetch error:', error);
		return json(
			{
				error: 'Failed to fetch playlist',
				details: error instanceof Error ? error.message : 'Unknown error'
			},
			{ status: 500 }
		);
	}
};
