<script lang="ts">
	import SearchInterface from '$lib/components/SearchInterface.svelte';
	import type { Track, PlayableTrack } from '$lib/types';
	import { playerStore } from '$lib/stores/player';
	import { onMount } from 'svelte';
	import { APP_VERSION } from '$lib/version';
	import { searchStore } from '$lib/stores/searchStore.svelte';

	let { data } = $props();

	onMount(() => {
		searchStore.reset();
		if (APP_VERSION) {
			try {
				window.umami?.track('app_loaded', { version: APP_VERSION, host: window.location.hostname });
			} catch {}
		}
	});

	function handleTrackSelect(track: PlayableTrack) {
		playerStore.playTrack(track);
	}
</script>

<svelte:head>
	<title>{data.title}</title>
	<meta name="description" content="Cool music streaming haha" />
</svelte:head>

<div class="space-y-8">
	<!-- Hero Section -->
	<div class="py-8 text-center">
		<div class="mb-4 flex items-baseline justify-center gap-2">
			<h2
				class="hero-title text-5xl font-bold text-transparent"
			>
				{data.title}
			</h2>
			<span class="text-sm text-gray-400">{APP_VERSION}</span>
		</div>
		<p class="mx-auto max-w-2xl text-xl text-gray-400">{data.slogan}</p>
		<p class="mt-3 text-sm uppercase tracking-[0.2em] text-gray-500">Spotify is buns</p>
	</div>

	<!-- Search Interface -->
	<SearchInterface onTrackSelect={handleTrackSelect} />
</div>

<style>
	.hero-title {
		font-family: 'Bungee', 'Figtree', sans-serif;
		letter-spacing: 0.02em;
		line-height: 1.1;
		font-weight: 400;
		padding-bottom: 0.08em;
		text-transform: uppercase;
		background-image: linear-gradient(135deg, #fecaca 0%, #ef4444 40%, #7f1d1d 70%, #450a0a 100%);
		background-clip: text;
		-webkit-background-clip: text;
		color: transparent;
	}
</style>
