<script lang="ts">
	import { Share2 } from 'lucide-svelte';
	import { createEventDispatcher } from 'svelte';
	import ShareModal from '$lib/components/ShareModal.svelte';

	interface Props {
		type: 'track' | 'album' | 'artist' | 'playlist';
		id: string | number;
		title?: string;
		size?: number;
		iconOnly?: boolean;
		variant?: 'ghost' | 'primary' | 'secondary' | 'custom';
		open?: boolean;
		buttonClass?: string;
		menuClass?: string;
		compact?: boolean;
		labelClass?: string;
		fullWidth?: boolean;
		wrapperClass?: string;
	}

	let {
		type,
		id,
		title = 'Share',
		size = 20,
		iconOnly = false,
		variant = 'ghost',
		open = undefined,
		buttonClass = '',
		menuClass = '',
		compact = false,
		labelClass = '',
		fullWidth = false,
		wrapperClass = ''
	}: Props = $props();

	let showModal = $state(false);
	const dispatch = createEventDispatcher<{ toggle: { open: boolean } }>();

	$effect(() => {
		if (typeof open === 'boolean') {
			showModal = open;
		}
	});

	function setModal(next: boolean) {
		if (typeof open === 'boolean') {
			dispatch('toggle', { open: next });
			return;
		}
		showModal = next;
		dispatch('toggle', { open: next });
	}

	const variantClasses = {
		ghost: 'text-gray-400 hover:text-white hover:bg-white/10',
		primary: 'bg-rose-600 text-white hover:bg-rose-700',
		secondary: 'bg-gray-800 text-white hover:bg-gray-700',
		custom: ''
	};
	const paddingClass = compact ? '' : iconOnly ? 'p-2' : 'px-4 py-2';
</script>

<div class="share-wrapper {fullWidth ? 'share-wrapper--full' : ''} {wrapperClass}">
	<button
		class="flex items-center gap-2 rounded-full transition-colors {variantClasses[variant]} {paddingClass} {buttonClass} {fullWidth ? 'w-full justify-center' : ''}"
		onclick={(e) => {
			e.stopPropagation();
			setModal(!showModal);
		}}
		{title}
		aria-label={title}
		aria-haspopup="dialog"
		aria-expanded={showModal}
	>
		<Share2 size={size} />
		{#if !iconOnly}
			<span class={labelClass}>Share</span>
		{/if}
	</button>

	<ShareModal
		open={showModal}
		type={type}
		id={id}
		title={title}
		on:close={() => setModal(false)}
	/>
</div>

<style>
	.share-wrapper {
		position: relative;
	}
	.share-wrapper--full {
		display: block;
		width: 100%;
	}
</style>
