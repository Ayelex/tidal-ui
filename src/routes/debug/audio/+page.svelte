<script lang="ts">
	import { dev } from '$app/environment';
	import { audioTelemetry } from '$lib/audio/telemetry';
	import { playerStore } from '$lib/stores/player';

	const logs = audioTelemetry.logs;
	const metrics = audioTelemetry.metrics;

	const formatTime = (ts: number) => {
		const date = new Date(ts);
		return date.toLocaleTimeString();
	};
</script>

{#if !dev}
	<div class="debug-shell">
		<h1>Audio Debug</h1>
		<p>Audio telemetry is only available in dev builds.</p>
	</div>
{:else}
	<div class="debug-shell">
		<header class="debug-header">
			<h1>Audio Debug</h1>
			<div class="debug-actions">
				<button type="button" on:click={() => audioTelemetry.clear()}>Clear logs</button>
			</div>
		</header>

		<section class="debug-section">
			<h2>Current State</h2>
			<pre>{JSON.stringify($playerStore, null, 2)}</pre>
		</section>

		<section class="debug-section">
			<h2>Metrics</h2>
			<pre>{JSON.stringify($metrics, null, 2)}</pre>
		</section>

		<section class="debug-section">
			<h2>Event Timeline</h2>
			<div class="log-table">
				<div class="log-row log-row--header">
					<div>Time</div>
					<div>Kind</div>
					<div>Name</div>
					<div>Track</div>
					<div>Time</div>
					<div>Duration</div>
					<div>State</div>
					<div>Detail</div>
				</div>
				{#each $logs as entry (entry.ts)}
					<div class="log-row">
						<div>{formatTime(entry.ts)}</div>
						<div>{entry.kind}</div>
						<div>{entry.name}</div>
						<div>{entry.trackId ?? '-'}</div>
						<div>{entry.currentTime.toFixed(2)}</div>
						<div>{entry.duration.toFixed(2)}</div>
						<div>{entry.paused ? 'paused' : 'playing'}</div>
						<div class="log-detail" title={entry.detail ? JSON.stringify(entry.detail) : '-'}>
							{entry.detail ? JSON.stringify(entry.detail) : '-'}
						</div>
					</div>
				{/each}
				{#if $logs.length === 0}
					<p class="empty-state">No telemetry events yet.</p>
				{/if}
			</div>
		</section>
	</div>
{/if}

<style>
	.debug-shell {
		max-width: 1100px;
		margin: 0 auto;
		padding: 2rem;
		color: #f8fafc;
	}

	.debug-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.debug-actions button {
		border-radius: 999px;
		padding: 0.4rem 1rem;
		border: 1px solid rgba(239, 68, 68, 0.4);
		background: rgba(18, 10, 16, 0.6);
		color: #fef2f2;
		cursor: pointer;
	}

	.debug-section {
		margin-top: 2rem;
		background: rgba(15, 10, 16, 0.5);
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 16px;
		padding: 1.5rem;
	}

	pre {
		background: rgba(0, 0, 0, 0.35);
		border-radius: 12px;
		padding: 1rem;
		overflow-x: auto;
		font-size: 0.75rem;
	}

	.log-table {
		display: grid;
		gap: 0.4rem;
	}

	.log-row {
		display: grid;
		grid-template-columns: 120px 80px 140px 120px 80px 80px 80px 1fr;
		gap: 0.4rem;
		font-size: 0.75rem;
		padding: 0.2rem 0.4rem;
		border-bottom: 1px solid rgba(255, 255, 255, 0.05);
	}

	.log-detail {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.log-row--header {
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: rgba(226, 232, 240, 0.7);
	}

	.empty-state {
		margin: 1rem 0 0;
		color: rgba(226, 232, 240, 0.6);
	}

	@media (max-width: 900px) {
		.log-row {
			grid-template-columns: 1fr;
		}
	}
</style>
