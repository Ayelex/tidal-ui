<script lang="ts">
	import { createEventDispatcher } from 'svelte';
	import { Link, Code, X } from 'lucide-svelte';
	import Modal from '$lib/components/Modal.svelte';

	interface Props {
		open: boolean;
		type: 'track' | 'album' | 'artist' | 'playlist';
		id: string | number;
		title?: string;
	}

	let { open, type, id, title = 'Share' }: Props = $props();
	const dispatch = createEventDispatcher<{ close: undefined }>();
	const titleId = 'share-modal-title';

	function getLongLink() {
		return `https://riptify.uk/${type}/${id}`;
	}

	function getEmbedCode() {
		if (type === 'track') {
			return `<iframe src="https://riptify.uk/embed/${type}/${id}" width="100%" height="150" style="border:none; overflow:hidden; border-radius: 0.5em;" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"></iframe>`;
		}
		return `<iframe src="https://riptify.uk/embed/${type}/${id}" width="100%" height="450" style="border:none; overflow:hidden; border-radius: 0.5em;" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"></iframe>`;
	}

	async function copyToClipboard(text: string) {
		try {
			if (navigator.clipboard && navigator.clipboard.writeText) {
				await navigator.clipboard.writeText(text);
			} else {
				const textArea = document.createElement('textarea');
				textArea.value = text;
				textArea.style.position = 'fixed';
				textArea.style.left = '-9999px';
				textArea.style.top = '0';
				document.body.appendChild(textArea);
				textArea.focus();
				textArea.select();
				try {
					document.execCommand('copy');
				} catch (err) {
					console.error('Fallback: unable to copy', err);
					throw err;
				}
				document.body.removeChild(textArea);
			}
		} catch (err) {
			console.error('Failed to copy:', err);
		}
	}

	async function handleCopy(value: string) {
		await copyToClipboard(value);
		dispatch('close');
	}
</script>

<Modal
	open={open}
	ariaLabelledby={titleId}
	panelClass="share-modal-panel"
	on:close={() => dispatch('close')}
>
	<header class="share-modal-header">
		<h2 id={titleId} class="share-modal-title">{title}</h2>
		<button
			class="share-modal-close"
			type="button"
			onclick={() => dispatch('close')}
			aria-label="Close share menu"
		>
			<X size={18} />
		</button>
	</header>
	<div class="share-modal-body">
		<button class="share-modal-action" type="button" onclick={() => handleCopy(getLongLink())}>
			<Link size={18} />
			Copy Link
		</button>
		<button class="share-modal-action" type="button" onclick={() => handleCopy(getEmbedCode())}>
			<Code size={18} />
			Copy Embed Code
		</button>
	</div>
</Modal>

<style>
	.share-modal-panel {
		width: min(420px, 100%);
	}

	.share-modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 1.25rem 1.5rem 0.75rem;
		border-bottom: 1px solid rgba(148, 163, 184, 0.2);
	}

	.share-modal-title {
		margin: 0;
		font-size: 1.1rem;
		font-weight: 600;
		color: #f8fafc;
	}

	.share-modal-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border-radius: 9999px;
		border: 1px solid rgba(239, 68, 68, 0.35);
		background: #120a10;
		color: rgba(254, 202, 202, 0.95);
		transition: border-color 160ms ease, color 160ms ease, box-shadow 160ms ease;
	}

	.share-modal-close:hover {
		border-color: rgba(239, 68, 68, 0.7);
		color: #fff;
		box-shadow: inset 0 0 16px rgba(239, 68, 68, 0.18);
	}

	.share-modal-body {
		display: grid;
		gap: 0.5rem;
		padding: 1rem 1.25rem 1.25rem;
	}

	.share-modal-action {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		border-radius: 0.9rem;
		border: 1px solid rgba(239, 68, 68, 0.3);
		background: rgba(18, 10, 16, 0.6);
		color: rgba(254, 226, 226, 0.95);
		padding: 0.85rem 1rem;
		font-size: 0.95rem;
		font-weight: 500;
		text-align: left;
		transition: border-color 160ms ease, background 160ms ease, color 160ms ease;
	}

	.share-modal-action:hover {
		border-color: rgba(239, 68, 68, 0.7);
		background: rgba(239, 68, 68, 0.18);
		color: #fff;
	}

	@media (max-width: 640px) {
		.share-modal-header {
			padding-inline: 1rem;
		}

		.share-modal-body {
			padding: 0.9rem 1rem 1.1rem;
		}
	}
</style>
