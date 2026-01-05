import { derived, readable } from 'svelte/store';
import { browser } from '$app/environment';
import { type PerformanceLevel } from '$lib/utils/performance';

/**
 * Performance mode is locked to low for maximum stability.
 */
export const effectivePerformanceLevel = readable<PerformanceLevel>('low');

/**
 * Store that tracks if user prefers reduced motion
 */
export const reducedMotion = readable(false, (set) => {
	if (!browser) {
		return;
	}

	const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

	set(mediaQuery.matches);

	const handler = (e: MediaQueryListEvent) => {
		set(e.matches);
	};

	mediaQuery.addEventListener('change', handler);

	return () => {
		mediaQuery.removeEventListener('change', handler);
	};
});

/**
 * Derived store that determines if animations should be enabled
 */
export const animationsEnabled = derived(
	[effectivePerformanceLevel, reducedMotion],
	([$perfLevel, $reducedMotion]) => {
		if ($reducedMotion) {
			return false;
		}

		return $perfLevel !== 'low';
	}
);
