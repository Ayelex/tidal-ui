import { browser } from '$app/environment';

type LogFn = (...args: unknown[]) => void;

export function createDevLogger(scope: string, flag = 'tidal-debug') {
	const isEnabled = () => {
		if (!import.meta.env.DEV || !browser) {
			return false;
		}
		try {
			return localStorage.getItem(flag) === '1';
		} catch {
			return false;
		}
	};

	const prefix = scope ? `[${scope}]` : '[dev]';
	const log: LogFn = (...args) => {
		if (isEnabled()) {
			console.info(prefix, ...args);
		}
	};
	const warn: LogFn = (...args) => {
		if (isEnabled()) {
			console.warn(prefix, ...args);
		}
	};
	const error: LogFn = (...args) => {
		if (isEnabled()) {
			console.error(prefix, ...args);
		}
	};

	return { enabled: isEnabled, log, warn, error };
}
