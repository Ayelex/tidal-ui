import devtoolsJson from 'vite-plugin-devtools-json';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), '');
	process.env = { ...process.env, ...env };

	const parsedPort = env.PORT ? Number.parseInt(env.PORT, 10) : undefined;
	const isCloudflare = Boolean(process.env.CF_PAGES || process.env.CF_WORKER);
	const redisCloudflarePath = resolve(process.cwd(), 'src/lib/server/redis.cloudflare.ts');
	const alias = isCloudflare
		? [{ find: '$lib/server/redis', replacement: redisCloudflarePath }]
		: [];

	return {
		plugins: [tailwindcss(), sveltekit(), devtoolsJson()],
		resolve: {
			alias
		},
		server: {
			watch: { usePolling: true },
			host: '0.0.0.0',
			port: Number.isFinite(parsedPort) ? parsedPort : undefined
		},
		optimizeDeps: {
			exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util']
		},
		ssr: {
			external: ['@ffmpeg/ffmpeg', '@ffmpeg/util']
		},
		test: {
			environment: 'node',
			include: ['tests/unit/**/*.test.ts']
		}
	};
});
