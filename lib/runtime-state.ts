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

/**
 * Create a fresh, empty runtime state.
 */
export function createRuntimeState(): ToolclipRuntimeState {
	return {
		entries: new Map(),
		quarantines: new Map(),
		currentTurn: 0,
		readsThisRound: new Map(),
	};
}

/**
 * Record an over-threshold tool result. Creates a new pending entry, or
 * overwrites an existing one (later writes win — useful when a tool is
 * retried and the second result is the one we should track).
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
	state.entries.set(toolCallId, {
		originalTokens,
		originalContent,
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
 * Ids that have a pending entry (recorded but not yet replaced). Order is
 * insertion order — useful for diagnostics and tests.
 */
export function pendingIds(state: ToolclipRuntimeState): string[] {
	const ids: string[] = [];
	for (const [id, entry] of state.entries) {
		if (!entry.replacement) {
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
 */
export function clear(state: ToolclipRuntimeState): void {
	state.entries.clear();
}
