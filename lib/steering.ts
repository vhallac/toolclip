/**
 * Steering reminder for toolclip.
 *
 * The failure mode this targets: the agent sees `[tool-result-pending-replacement]`
 * markers but never circles back to call `replace_tool_result` — it *collects*
 * pending replacements, deferring "until I need this" and then never does.
 *
 * The steering is count-based, not turn-based: it fires when the number of
 * un-replaced pending results enters a new multiple of `multiple` (default 5:
 * 5–9, 10–14, 15–19, ...). A growing pile is therefore nagged repeatedly —
 * once per band — instead of once per round, which is what the observed
 * failure needs: the turn-based reminder fired once and the pile kept growing
 * in silence afterwards.
 *
 * Re-arming: when the count drops below the announced band (the agent acted),
 * the band follows it down silently. A pile that is later re-grown past the
 * next band crossing gets a fresh reminder. Without this, a pile announced at
 * 10 that was partially replaced and re-grown to 9 would stay un-nagged.
 *
 * Cache safety: the reminder is appended to the *end* of the context as a new
 * `user` message. Pi's standard steering path does exactly this — a user
 * message added at the tail does not touch the cached prefix; only the tail
 * re-prepills. The original prompt and all prior messages are untouched.
 *
 * This module is pure: it owns the per-round steering state and exposes the
 * eligibility decision plus the message builder. No pi deps, no I/O — mirrors
 * the testable shape used by the rest of `lib/`.
 */

import type { ToolclipRuntimeState } from "./types.ts";

/**
 * Per-round steering state. Reset at each round boundary (in
 * `before_agent_start`) so a pile persisting into a new round is re-announced
 * on that round's first LLM call.
 *
 * `announcedBand` is the highest pending-count band (in units of `multiple`)
 * already announced this round. Band `k` covers counts `[k*multiple,
 * (k+1)*multiple)`. A band is announced when the count first enters it.
 */
export interface SteeringState {
	/** Highest pending-count band already announced this round. */
	announcedBand: number;
}

/**
 * Create fresh steering state for a new round.
 */
export function createSteeringState(): SteeringState {
	return { announcedBand: 0 };
}

/**
 * Reset steering state for a new round. Same shape as `createSteeringState`
 * but mutates in place — used by the round-boundary handler so the same state
 * object survives across rounds without re-allocation.
 */
export function resetSteering(state: SteeringState): void {
	state.announcedBand = 0;
}

/**
 * Collect the ids of tracked tool results that are still pending (recorded
 * but not yet replaced). Reads from the shared runtime state. The count of
 * pending results is `ids.length`.
 */
export function unreplacedPendingIds(rt: ToolclipRuntimeState): string[] {
	const ids: string[] = [];
	for (const [id, entry] of rt.entries) {
		if (entry.replacement === undefined) {
			ids.push(id);
		}
	}
	return ids;
}

/**
 * Observe the current pending count and decide whether a steering reminder
 * should fire on this LLM call.
 *
 * Band `k = floor(count / multiple)`. Fires exactly when the count enters a
 * band strictly above the announced one — i.e. once per band crossing. When
 * the count drops below the announced band (the agent replaced results), the
 * band follows it down silently: a later re-grown pile is nagged again.
 *
 * Mutates `state.announcedBand` (the tracked band). Returns whether to fire.
 * With `enabled` false, nothing ever fires and the band is not tracked.
 */
export function observePendingBand(
	state: SteeringState,
	count: number,
	multiple: number,
	enabled: boolean,
): boolean {
	if (!enabled) {
		return false;
	}
	const band = Math.floor(count / multiple);
	if (band > state.announcedBand) {
		state.announcedBand = band;
		return true;
	}
	if (band < state.announcedBand) {
		state.announcedBand = band;
	}
	return false;
}

/**
 * Build the steering reminder text: a count summary, the extract-then-replace
 * method, the anti-hoarding rule ("do not save for just in case"), and the
 * explicit list of pending ids so the agent can act on them directly in a
 * single batched `replace_tool_result` call. Kept short and imperative.
 *
 * @param count - How many marked results are still un-replaced.
 * @param ids - The pending tool-call ids, in the order reported.
 */
export function buildSteeringMessage(count: number, ids: string[]): string {
	const lines = [
		`Steering: you have ${count} tool-result-pending-replacements — consider distilling their results. ` +
			`Extract ALL information you may still need from each into its replacement and replace them now, ` +
			`in a single replace_tool_result call. Do not save a result for just in case: ` +
			`anything you might need later belongs inside its replacement, and an un-replaced original ` +
			`keeps costing full context on every call.`,
	];
	for (const id of ids) {
		lines.push(`- ${id}`);
	}
	return lines.join("\n");
}