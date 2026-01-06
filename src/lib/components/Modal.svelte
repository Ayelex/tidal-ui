<script lang="ts">
	import { browser } from '$app/environment';
	import { createEventDispatcher, onDestroy, tick } from 'svelte';

	interface Props {
		open: boolean;
		ariaLabel?: string;
		ariaLabelledby?: string;
		ariaDescribedby?: string;
		panelClass?: string;
		overlayClass?: string;
		closeOnOverlay?: boolean;
		closeOnEscape?: boolean;
	}

	let {
		open,
		ariaLabel = 'Dialog',
		ariaLabelledby,
		ariaDescribedby,
		panelClass = '',
		overlayClass = '',
		closeOnOverlay = true,
		closeOnEscape = true
	}: Props = $props();

	const dispatch = createEventDispatcher<{ close: undefined }>();
	let overlayRef = $state<HTMLDivElement | null>(null);
	let panelRef = $state<HTMLDivElement | null>(null);
	let previousActive: HTMLElement | null = null;
	let restoreOverflow = '';
	let restorePaddingRight = '';

	const focusableSelector =
		'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), details > summary, [tabindex]:not([tabindex="-1"])';

	const getFocusable = () => {
		if (!panelRef) return [];
		return Array.from(panelRef.querySelectorAll<HTMLElement>(focusableSelector)).filter(
			(el) => !el.hasAttribute('disabled') && !el.getAttribute('aria-hidden')
		);
	};

	const lockScroll = () => {
		if (!browser) return;
		restoreOverflow = document.body.style.overflow;
		restorePaddingRight = document.body.style.paddingRight;
		const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
		document.body.style.overflow = 'hidden';
		if (scrollbarWidth > 0) {
			document.body.style.paddingRight = `${scrollbarWidth}px`;
		}
	};

	const unlockScroll = () => {
		if (!browser) return;
		document.body.style.overflow = restoreOverflow;
		document.body.style.paddingRight = restorePaddingRight;
	};

	const focusFirst = async () => {
		await tick();
		const focusable = getFocusable();
		if (focusable.length > 0) {
			focusable[0]?.focus();
		} else {
			panelRef?.focus();
		}
	};

	const handleOverlayClick = (event: MouseEvent) => {
		if (!closeOnOverlay) return;
		if (event.target === event.currentTarget) {
			dispatch('close');
		}
	};

	const handleKeydown = (event: KeyboardEvent) => {
		if (event.key === 'Escape' && closeOnEscape) {
			event.preventDefault();
			dispatch('close');
			return;
		}
		if (event.key !== 'Tab') return;
		const focusable = getFocusable();
		if (focusable.length === 0) {
			event.preventDefault();
			panelRef?.focus();
			return;
		}
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		const active = document.activeElement as HTMLElement | null;
		if (event.shiftKey && active === first) {
			event.preventDefault();
			last?.focus();
		} else if (!event.shiftKey && active === last) {
			event.preventDefault();
			first?.focus();
		}
	};

	$effect(() => {
		if (!browser) return;
		if (open) {
			previousActive = document.activeElement as HTMLElement | null;
			lockScroll();
			void focusFirst();
		} else {
			unlockScroll();
			previousActive?.focus();
			previousActive = null;
		}
	});

	onDestroy(() => {
		if (!browser) return;
		if (open) {
			unlockScroll();
		}
	});
</script>

{#if open}
	<div
		bind:this={overlayRef}
		class={`modal-overlay ${overlayClass}`}
		role="presentation"
		onclick={handleOverlayClick}
		onkeydown={handleKeydown}
		tabindex="-1"
	>
		<div
			bind:this={panelRef}
			class={`modal-panel ${panelClass}`}
			role="dialog"
			aria-modal="true"
			aria-label={ariaLabel}
			aria-labelledby={ariaLabelledby}
			aria-describedby={ariaDescribedby}
			tabindex="-1"
		>
			<slot />
		</div>
	</div>
{/if}

<style>
	.modal-overlay {
		position: fixed;
		inset: 0;
		z-index: 90;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.5rem;
		background: rgba(5, 3, 6, 0.72);
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
	}

	.modal-panel {
		width: min(420px, 100%);
		max-height: min(80vh, 720px);
		overflow: auto;
		border-radius: 1.25rem;
		background: linear-gradient(140deg, var(--bloom-primary), var(--bloom-secondary));
		border: 1px solid rgba(239, 68, 68, 0.4);
		box-shadow:
			0 30px 80px rgba(2, 6, 23, 0.65),
			0 4px 18px rgba(18, 10, 16, 0.45),
			inset 0 1px 0 rgba(255, 255, 255, 0.06);
	}

	@media (max-width: 640px) {
		.modal-overlay {
			padding: 1rem;
		}

		.modal-panel {
			width: 100%;
			max-height: min(85vh, 640px);
		}
	}
</style>
