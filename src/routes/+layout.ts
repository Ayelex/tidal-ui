import { env } from '$env/dynamic/public';

export const prerender = false;
export const ssr = false;

export const load = () => {
	return {
		title: env.PUBLIC_TITLE || 'Riptify',
		slogan:
			env.PUBLIC_SLOGAN ||
			"Ayelex's Music Streaming Service. Enjoy lossless audio and download whatever you want for free!"
	};
};
