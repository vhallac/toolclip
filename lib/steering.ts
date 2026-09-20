/**
 * Steering reminder for toolclip.
 *
 * The failure mode this targets: the agent sees `[tool-result-pending-replacement]`
 * markers but never circles back to call `replace_tool_result` — it defers
 * "until I need this" and then never does. The cheapest possible detection
 * nudge is a single trailing user message, injected once per round, reminding
 * the agent to replace its marked results.
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
 * `before_agent_start`) so the reminder can fire at most once per round.
 *
 * `turnsWithPending` counts tool-result-bearing turns during which at least
 * one marked result was still un-replaced. It only advances when there *is*
 * something to remind about, so an empty/prompt-only context never trips it.
 */
export interface SteeringState {
	/** Whether the reminder has already fired this round. */
	fired: boolean;
	/** Turns elapsed with an un-replaced pending marker present. */
	turnsWithPending: number;
}

/**
 * Create fresh steering state for a new round.
 */
export function createSteeringState(): SteeringState {
	return { fired: false, turnsWithPending: 0 };
}

/**
 * Reset steering state for a new round. Same shape as `createSteeringState`
 * but mutates in place — used by the round-boundary handler so the same state
 * object survives across rounds without re-allocation.
 */
export function resetSteering(state: SteeringState): void {
	state.fired = false;
	state.turnsWithPending = 0;
}

/**
 * Count how many tracked tool results are still pending (recorded but not
 * yet replaced). Reads from the shared runtime state.
 */
export function unreplacedPendingCount(rt: ToolclipRuntimeState): number {
	let n = 0;
	for (const entry of rt.entries.values()) {
		if (entry.replacement === undefined) {
			n++;
		}
	}
	return n;
}

/**
 * Decide whether the steering reminder should fire on this turn, given the
 * current runtime state (pending markers) and steering state (turn count +
 * latch).
 *
 * Conditions (all must hold):
 * - `configEnabled` — the feature is not disabled via env.
 * - `!state.fired` — has not already fired this round (at-most-once).
 * - `unreplaced > 0` — there is at least one marked result still un-replaced;
 *   with nothing to act on, a reminder is just noise.
 * - `state.turnsWithPending >= turnThreshold` — the agent has had enough
 *   turns of opportunity to act on the markers and has not.
 *
 * This is a pure predicate. The caller is responsible for incrementing
 * `turnsWithPending` (via `observeTurn`) and setting `state.fired` after a
 * fire (via `markFired`).
 */
export function shouldFireSteering(
	state: SteeringState,
	unreplaced: number,
	turnThreshold: number,
	configEnabled: boolean,
): boolean {
	if (!configEnabled || state.fired) {
		return false;
	}
	if (unreplaced <= 0) {
		return false;
	}
	return state.turnsWithPending >= turnThreshold;
}

/**
 * Record one observed tool-result-bearing turn. Advances `turnsWithPending`
 * only when there is at least one un-replaced pending marker — so turns with
 * nothing to remind about do not consume the eligibility budget.
 *
 * Returns the new `turnsWithPending` value.
 */
export function observeTurn(state: SteeringState, unreplaced: number): number {
	if (unreplaced > 0) {
		state.turnsWithPending += 1;
	}
	return state.turnsWithPending;
}

/**
 * Mark the reminder as fired for this round. Idempotent.
 */
export function markFired(state: SteeringState): void {
	state.fired = true;
}

/**
 * Build the steering reminder text. Single line of user steering, scoped to
 * the current pending set. Kept short and imperative.
 *
 * @param unreplaced - How many marked results are still un-replaced.
 */
export function buildSteeringMessage(unreplaced: number): string {
	const noun = unreplaced === 1 ? "tool result is" : "tool results are";
	return (
		`Reminder: ${unreplaced} ${noun} still carrying the ` +
		`[tool-result-pending-replacement] marker. Per the system instructions, ` +
		`replace each with a distilled replace_tool_result(toolCallId, replacement) ` +
		`call before proceeding further — you have already extracted what you need.`
	);
}
