/**
 * Steering reminder for toolclip.
 *
 * The failure mode this targets: the agent sees `[tool-result-pending-replacement]`
 * markers but never circles back to call `replace_tool_result` — it *collects*
 * pending replacements, deferring "until I need this" and then never does.
 *
 * Two independent triggers, each edge-triggered with its own latch ("once
 * per excursion"):
 *
 * - **count**: the number of un-replaced pending results strictly exceeds
 *   `countThreshold` (default 5). Fires once when the pile crosses the
 *   threshold; the latch re-arms when the count falls back to the threshold
 *   or below — so a pile that is partially replaced and then re-grown is
 *   nagged again, while one that stays above the threshold is not re-nagged
 *   on every LLM call.
 * - **size**: the total estimated tokens of un-replaced pending results
 *   strictly exceeds `sizeThresholdTokens` (default 5000). This catches
 *   what the count trigger is structurally blind to: a single huge un-
 *   replaced result never exceeds a count of 5 — the 2026-09-20 golden run
 *   left a ~30k-token base64 blob pending for 24 calls with no nag at all.
 *
 * The latches are independent on purpose. A single shared latch would let
 * one trigger's fire mask the other's later crossing: the count nag fires,
 * the pile is distilled down to one huge item, and the size trigger — the
 * only one that can still catch it — would stay suppressed. With separate
 * latches, each threshold nags once per excursion above it, and a nag for
 * one trigger never silences the other.
 *
 * Round boundary: state resets at each round boundary (in
 * `before_agent_start`) so a pile persisting into a new round is re-announced
 * on that round's first LLM call.
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
 * Each latch is true once its trigger has fired for the current excursion
 * above its threshold; both re-arm when their condition falls back to (or
 * below) the threshold. The latches are independent: a fire of one trigger
 * never suppresses the other.
 */
export interface SteeringState {
	/** True once the count trigger has fired for the current excursion. */
	countLatched: boolean;
	/** True once the size trigger has fired for the current excursion. */
	sizeLatched: boolean;
}

/** Options for the steering eligibility decision (from `ToolclipConfig`). */
export interface SteeringOptions {
	/** Nag when the pending count strictly exceeds this. */
	countThreshold: number;
	/** Nag when the total pending estimated tokens strictly exceed this. */
	sizeThresholdTokens: number;
	/** Master switch; when false nothing fires and no latch is tracked. */
	enabled: boolean;
}

/** Which triggers fired on this observation (at most one message is sent). */
export interface SteeringTriggers {
	count: boolean;
	size: boolean;
}

/** One un-replaced pending result: its id and original estimated tokens. */
export interface PendingItem {
	id: string;
	tokens: number;
}

/**
 * Create fresh steering state for a new round.
 */
export function createSteeringState(): SteeringState {
	return { countLatched: false, sizeLatched: false };
}

/**
 * Reset steering state for a new round. Same shape as `createSteeringState`
 * but mutates in place — used by the round-boundary handler so the same state
 * object survives across rounds without re-allocation.
 */
export function resetSteering(state: SteeringState): void {
	state.countLatched = false;
	state.sizeLatched = false;
}

/**
 * Summarize the un-replaced pending results: ids in insertion order with
 * their original estimated token counts, plus the total.
 */
export function pendingSummary(rt: ToolclipRuntimeState): {
	items: PendingItem[];
	totalTokens: number;
} {
	const items: PendingItem[] = [];
	let totalTokens = 0;
	for (const [id, entry] of rt.entries) {
		if (entry.replacement === undefined) {
			items.push({ id, tokens: entry.originalTokens });
			totalTokens += entry.originalTokens;
		}
	}
	return { items, totalTokens };
}

/**
 * Collect the ids of tracked tool results that are still pending (recorded
 * but not yet replaced). Reads from the shared runtime state. The count of
 * pending results is `ids.length`.
 */
export function unreplacedPendingIds(rt: ToolclipRuntimeState): string[] {
	return pendingSummary(rt).items.map((item) => item.id);
}

/**
 * Observe the current pending pile and decide whether a steering reminder
 * should fire on this LLM call.
 *
 * Each trigger is edge-triggered with its own latch: it fires exactly when
 * its condition first becomes true (strictly above the threshold) and latches
 * until the condition falls back to the threshold or below. Mutates
 * `state.countLatched` / `state.sizeLatched`. Returns which triggers fired —
 * the caller sends at most one reminder per observation.
 */
export function observePendingSteering(
	state: SteeringState,
	count: number,
	totalTokens: number,
	options: SteeringOptions,
): SteeringTriggers {
	if (!options.enabled) {
		return { count: false, size: false };
	}
	// Re-arm on excursion end first, so the latch follows the pile down in
	// the same observation that sees the drop (mirrors the re-arm semantics
	// of the band ladder this replaced).
	if (count <= options.countThreshold) {
		state.countLatched = false;
	}
	if (totalTokens <= options.sizeThresholdTokens) {
		state.sizeLatched = false;
	}
	const triggers = { count: false, size: false };
	if (count > options.countThreshold && !state.countLatched) {
		state.countLatched = true;
		triggers.count = true;
	}
	if (totalTokens > options.sizeThresholdTokens && !state.sizeLatched) {
		state.sizeLatched = true;
		triggers.size = true;
	}
	return triggers;
}

/**
 * Build the steering reminder text: a count and total-size summary, the
 * extract-then-replace method, the anti-hoarding rule ("do not save for just
 * in case"), and the explicit list of pending ids with their sizes so the
 * agent can act on them directly in a single batched `replace_tool_result`
 * call — and can see at a glance which single item is hogging the pile.
 * Kept short and imperative.
 *
 * @param count - How many marked results are still un-replaced.
 * @param totalTokens - Total estimated tokens across the pending pile.
 * @param items - The pending items (id + estimated tokens), in reported order.
 */
export function buildSteeringMessage(
	count: number,
	totalTokens: number,
	items: PendingItem[],
): string {
	const lines = [
		`Steering: you have ${count} tool-result-pending-replacements totalling ~${totalTokens} estimated tokens — ` +
			`consider distilling their results. ` +
			`Extract ALL information you may still need from each into its replacement and replace them now, ` +
			`in a single replace_tool_result call. Do not save a result for just in case: ` +
			`anything you might need later belongs inside its replacement, and an un-replaced original ` +
			`keeps costing full context on every call.`,
	];
	for (const item of items) {
		lines.push(`- ${item.id} (~${item.tokens} tokens)`);
	}
	return lines.join("\n");
}