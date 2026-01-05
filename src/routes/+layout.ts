import { env } from '$env/dynamic/public';

export const prerender = false;
export const ssr = false;

export const load = () => {
	return {
		title: env.PUBLIC_TITLE || 'BiniLossless',
		slogan: env.PUBLIC_SLOGAN || 'The easiest way to stream CD-quality lossless FLACs.'
	};
};
