/**
 * Runtime state for toolclip.
 *
 * Holds one entry per tool call whose result was over-threshold at the
 * time it was emitted. Entries move through two states:
 *
 *   pending     — original recorded, no replacement yet (LLM may still call
 *                 `replace_tool_result` for this id).
 *   replaced    — replacement recorded. The context-event handler will
 *                 swap the original out from this point on.
 *
 * Operations are pure functions that take a `ToolclipRuntimeState` and mutate
 * its internal Map. No I/O, no pi deps. Mirrors the testable shape used by
 * sesclip (factory + helper functions) rather than a class with methods.
 */

import type { ToolclipRuntimeState } from "./types.ts";
import { DEFAULT_EXPIRY_RHO, DEFAULT_EXPIRY_WRITE_RATIO } from "./expiry.ts";

/** Price priors seeding the expiry state (see lib/expiry.ts). */
export interface ExpiryPriors {
	rho: number;
	writeRatio: number;
}

/**
 * Create a fresh, empty runtime state.
 *
 * @param priors - optional price priors for the expiry accounting; defaults
 *   to the same values as the config defaults (rho 0.2, write ratio 1.0).
 *   The extension passes the loaded config's priors.
 */
export function createRuntimeState(priors?: ExpiryPriors): ToolclipRuntimeState {
	return {
		entries: new Map(),
		quarantines: new Map(),
		releasedQuarantines: new Set(),
		currentTurn: 0,
		lastContextToolCallIds: new Set(),
		readsThisRound: new Map(),
		pileTotal: 0,
		turnsSeen: 0,
		lastCtx: 0,
		rho: priors?.rho ?? DEFAULT_EXPIRY_RHO,
		w: priors?.writeRatio ?? DEFAULT_EXPIRY_WRITE_RATIO,
		noCacheStreak: 0,
		replMeanTokens: 0,
		replCount: 0,
		expiredIds: new Set(),
		expiredUnannounced: new Set(),
	};
}

/**
 * Record the tool-call ids present in the messages of the most recent
 * `context` event, replacing any previous set. State only — the context
 * handler stays a pure view transform and returns the same swapped
 * messages. Steering eligibility and expiry counting are defined against
 * this set (see `trackedSummary` and `countNewlyEligible` in lib/expiry.ts).
 *
 * @param state - The runtime state to mutate.
 * @param ids - The toolCallIds of the toolResult messages in the context
 *   event's messages, in message order.
 */
export function recordContextToolCallIds(
	state: ToolclipRuntimeState,
	ids: Iterable<string>,
): void {
	state.lastContextToolCallIds.clear();
	for (const id of ids) {
		state.lastContextToolCallIds.add(id);
	}
}

/**
 * Record an over-threshold tool result. Creates a new pending entry, or
 * overwrites an existing one (later writes win — useful when a tool is
 * retried and the second result is the one we should track).
 *
 * A fresh entry starts uncounted (`counted = false`, `ctxSeen = 0`): it
 * joins `pileTotal` only at the turn_end where it first becomes eligible
 * (see `countNewlyEligible` in lib/expiry.ts). When the overwrite replaces
 * an entry that was already counted, the stale entry's contribution is
 * subtracted from `pileTotal` first, so a re-marked result never
 * double-counts — the fresh content is re-counted at the next eligible
 * turn_end with a fresh `ctxSeen`.
 *
 * @param state - The runtime state to mutate.
 * @param toolCallId - The tool call id.
 * @param originalTokens - Estimated token count of the original result.
 * @param originalContent - The result content as observed.
 */
export function recordPending(
	state: ToolclipRuntimeState,
	toolCallId: string,
	originalTokens: number,
	originalContent: string,
): void {
	const previous = state.entries.get(toolCallId);
	if (previous?.counted) {
		// The old content contributed to pileTotal at its counting time; its
		// contribution is stale once the result is re-recorded.
		state.pileTotal -= previous.originalTokens;
	}
	state.entries.set(toolCallId, {
		originalTokens,
		originalContent,
		counted: false,
		ctxSeen: 0,
		// replacement intentionally omitted until recordReplacement is called
	});
}

/**
 * Record a replacement for an already-pending entry. No-op if there is no
 * pending entry for the id — the runtime invariant is that a replacement
 * can only target a tool result the LLM has already seen, so a stray id
 * is silently ignored.
 *
 * No size gating is applied: the replacement is accepted regardless of its
 * length relative to the original. The entry records the replacement's
 * estimated token count and a `grew` flag (true when replacementTokens >=
 * originalTokens) so observers can detect replacements that bloat context
 * rather than shrink it — the signal for reintroducing a gate later.
 *
 * @param state - The runtime state to mutate.
 * @param toolCallId - The tool call id.
 * @param replacement - The LLM-supplied replacement text.
 * @param replacementTokens - Estimated token count of the replacement.
 * @returns `true` if the replacement was stored, `false` if there was no
 *          pending entry for that id.
 */
export function recordReplacement(
	state: ToolclipRuntimeState,
	toolCallId: string,
	replacement: string,
	replacementTokens: number,
): boolean {
	const entry = state.entries.get(toolCallId);
	if (!entry) {
		return false;
	}
	entry.replacement = replacement;
	entry.replacementTokens = replacementTokens;
	entry.grew = replacementTokens >= entry.originalTokens;
	return true;
}

/**
 * Get the stored replacement for an id, or `undefined` if there is no
 * replacement yet (or no entry at all). Used by the context-event handler
 * to decide whether to swap.
 */
export function getReplacement(
	state: ToolclipRuntimeState,
	toolCallId: string,
): string | undefined {
	return state.entries.get(toolCallId)?.replacement;
}

/**
 * Get the full entry for an id, or `undefined` if none was recorded.
 */
export function getEntry(
	state: ToolclipRuntimeState,
	toolCallId: string,
) {
	return state.entries.get(toolCallId);
}

/**
 * Stamp a stored replacement with the storing call's identity (pointer
 * mode): the replace call's own toolCallId — whose unmodified arguments
 * carry the replacement text — and the receipt minted for that call (see
 * lib/receipt.ts). A re-replacement by a later call overwrites both, so
 * the pointer names the newest call carrying the current replacement.
 * No-op when the entry vanished in the meantime (expiry cannot delete a
 * replaced entry, but defensive symmetry with recordReplacement).
 */
export function stampReplacementCall(
	state: ToolclipRuntimeState,
	toolCallId: string,
	replaceCallId: string,
	receiptId: string,
): void {
	const entry = state.entries.get(toolCallId);
	if (!entry) {
		return;
	}
	entry.replaceCallId = replaceCallId;
	entry.receiptId = receiptId;
}

/**
 * Ids that have a pending entry (recorded but not yet replaced). Order is
 * insertion order — useful for diagnostics and tests.
 *
 * The check is against `undefined`, not falsiness: the stored placeholder
 * for an empty ("the result was useless") replacement may itself be an
 * empty string, and such an entry is replaced, not pending.
 */
export function pendingIds(state: ToolclipRuntimeState): string[] {
	const ids: string[] = [];
	for (const [id, entry] of state.entries) {
		if (entry.replacement === undefined) {
			ids.push(id);
		}
	}
	return ids;
}

/**
 * Ids that have been replaced (entry exists with a replacement set).
 */
export function replacedIds(state: ToolclipRuntimeState): string[] {
	const ids: string[] = [];
	for (const [id, entry] of state.entries) {
		if (entry.replacement !== undefined) {
			ids.push(id);
		}
	}
	return ids;
}

/**
 * Wipe the state. Used by tests and by future restart logic if any.
 *
 * Full reset: entries, the last-context id set, and all expiry accounting
 * (pileTotal, turnsSeen, prices, streaks, replacement stats, expired ids).
 * Note this is a whole-state wipe — NOT the per-round reset, which only
 * resets the steering ratchet and the re-read counter (`turnsSeen` and the
 * expired ids deliberately survive round boundaries).
 */
export function clear(state: ToolclipRuntimeState): void {
	state.entries.clear();
	state.lastContextToolCallIds.clear();
	state.pileTotal = 0;
	state.turnsSeen = 0;
	state.lastCtx = 0;
	state.rho = DEFAULT_EXPIRY_RHO;
	state.w = DEFAULT_EXPIRY_WRITE_RATIO;
	state.noCacheStreak = 0;
	state.replMeanTokens = 0;
	state.replCount = 0;
	state.expiredIds.clear();
	state.expiredUnannounced.clear();
}
