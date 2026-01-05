import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';

const rootDir = join(process.cwd(), 'build');
const port = Number(process.env.PORT) || 5000;

const contentTypes = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.ico': 'image/x-icon',
	'.webmanifest': 'application/manifest+json'
};

function sendFile(response, filePath) {
	const ext = extname(filePath).toLowerCase();
	const contentType = contentTypes[ext] || 'application/octet-stream';
	response.writeHead(200, { 'Content-Type': contentType });
	createReadStream(filePath).pipe(response);
}

function buildPublicEnv() {
	const publicEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith('PUBLIC_') && typeof value === 'string') {
			publicEnv[key] = value;
		}
	}
	if (!publicEnv.PUBLIC_TITLE && process.env.TITLE) {
		publicEnv.PUBLIC_TITLE = process.env.TITLE;
	}
	if (!publicEnv.PUBLIC_SLOGAN && process.env.SLOGAN) {
		publicEnv.PUBLIC_SLOGAN = process.env.SLOGAN;
	}
	return publicEnv;
}

const server = createServer((request, response) => {
	const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

	if (url.pathname === '/_app/env.js') {
		const envPayload = buildPublicEnv();
		response.writeHead(200, {
			'Content-Type': 'application/javascript; charset=utf-8',
			'Cache-Control': 'no-store'
		});
		response.end(`export const env=${JSON.stringify(envPayload)};`);
		return;
	}

	let filePath = join(rootDir, decodeURIComponent(url.pathname));

	if (filePath.endsWith('/') || extname(filePath) === '') {
		const indexPath = join(filePath, 'index.html');
		if (existsSync(indexPath)) {
			filePath = indexPath;
		}
	}

	if (existsSync(filePath) && statSync(filePath).isFile()) {
		sendFile(response, filePath);
		return;
	}

	const fallbackPath = join(rootDir, 'index.html');
	if (existsSync(fallbackPath)) {
		sendFile(response, fallbackPath);
		return;
	}

	response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
	response.end('Not Found');
});

server.listen(port, () => {
	console.log(`Serving static build on http://localhost:${port}`);
});
