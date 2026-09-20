/**
 * Quarantine store operations.
 *
 * A quarantined tool result is one whose estimated token count exceeded the
 * quarantine threshold at `tool_result` time. Its content is NOT shown to
 * the LLM: the tool_result handler swaps in a notice and the full payload is
 * held here, keyed by the original tool call id.
 *
 * Lifetime ("use it or lose it"): the LLM first sees the notice when it
 * generates the turn AFTER the one in which the result was quarantined
 * (`createdTurn + 1`). A `read_quarantined_result` call issued during that
 * turn is honored (the payload is released and handed back). At the
 * `turn_end` of that turn, any still-held entry is evicted — later read
 * attempts for the id are denied.
 *
 * Why this window: pi delivers all of a turn's tool results at that turn's
 * `turn_end`; the LLM cannot react to a quarantine notice within the same
 * turn it was created. The first turn in which a read is even possible is
 * `createdTurn + 1` — giving the payload exactly one turn of opportunity
 * keeps the held data from silently accumulating across a session.
 *
 * Eviction rule: at `turn_end` with turnIndex R, evict entries with
 * `createdTurn <= R - 1`. An entry created during turn R survives its own
 * turn_end (it could not have been read yet), gets its opportunity in turn
 * R + 1, and is evicted at that turn's end if still unread.
 *
 * Operations are pure functions that take a `ToolclipRuntimeState` and
 * mutate its `quarantines` Map. No I/O, no pi deps — mirrors runtime-state.
 */

import type { QuarantineEntry, ToolclipRuntimeState } from "./types.ts";
import { buildQuarantinedMarker, buildQuarantineMissedMarker } from "./marker.ts";

/**
 * Record a quarantined payload. Overwrites an existing entry for the same id
 * (later writes win — same semantics as `recordPending`).
 *
 * @param state - The runtime state to mutate.
 * @param toolCallId - The tool call id whose result was withheld.
 * @param payload - The full (flattened) result content.
 * @param tokens - Estimated token count of the payload.
 * @param createdTurn - The turn index during which the result was observed.
 */
export function recordQuarantine(
	state: ToolclipRuntimeState,
	toolCallId: string,
	payload: string,
	tokens: number,
	createdTurn: number,
): void {
	state.quarantines.set(toolCallId, { payload, tokens, createdTurn });
}

/**
 * Release a held payload for reading. The entry is removed on success — a
 * second read for the same id is denied.
 *
 * @param state - The runtime state to mutate.
 * @param toolCallId - The id to release.
 * @returns The released entry, or `undefined` if nothing is held for the id.
 */
export function releaseQuarantine(
	state: ToolclipRuntimeState,
	toolCallId: string,
): QuarantineEntry | undefined {
	const entry = state.quarantines.get(toolCallId);
	if (entry) {
		state.quarantines.delete(toolCallId);
	}
	return entry;
}

/**
 * Evict held entries whose one-turn read window has closed: entries
 * quarantined in a strictly earlier turn than the one just ending. Returns
 * the evicted ids (useful for diagnostics and tests).
 *
 * @param state - The runtime state to mutate.
 * @param turnIndex - The turn index of the `turn_end` being processed.
 */
export function evictExpiredQuarantines(
	state: ToolclipRuntimeState,
	turnIndex: number,
): string[] {
	const evicted: string[] = [];
	for (const [id, entry] of state.quarantines) {
		if (entry.createdTurn <= turnIndex - 1) {
			state.quarantines.delete(id);
			evicted.push(id);
		}
	}
	return evicted;
}

/**
 * Build the notice swapped into a quarantined result's LLM-facing content.
 * Carries the marker (parseable identity) plus the guidance: narrow the
 * call when only part of the data is needed; read the held payload once,
 * in full, when all of it is needed — never reconstruct it piecemeal with
 * several narrowed calls (that costs more than one read).
 *
 * @param toolCallId - The tool call id whose result was withheld.
 * @param tokens - Estimated token count of the held payload.
 */
export function buildQuarantineNotice(toolCallId: string, tokens: number): string {
	return (
		buildQuarantinedMarker(toolCallId, tokens) +
		"\n" +
		"This result was withheld from your context (too large). Choose deliberately:\n" +
		"1. If you only need part of the data: re-issue the tool call with a narrower scope (specific file, tighter pattern, smaller range) so the result comes back small.\n" +
		`2. If you need the whole payload: call read_quarantined_result({ toolCallId: "${toolCallId}" }) once, in your very next response. Do NOT reconstruct the payload piecemeal with several narrowed calls — that costs more calls and more tokens than one full read.\n` +
		"This is your only chance — the held data is freed right after that response, and later read attempts for it are denied."
	);
}

/**
 * Build the denial text returned when a read targets an id that is no
 * longer held.
 */
export function buildQuarantineMissedNotice(toolCallId: string): string {
	return (
		buildQuarantineMissedMarker(toolCallId) +
		"\n" +
		"The quarantined payload was already freed (read earlier, or its one-turn window expired). " +
		"It is no longer retrievable. Re-run the original tool call with a narrower scope to regenerate the data you need."
	);
}

/**
 * Ids currently held. Insertion order — diagnostics and tests.
 */
export function quarantineIds(state: ToolclipRuntimeState): string[] {
	return [...state.quarantines.keys()];
}

/**
 * Wipe all held entries. Used defensively at round boundaries (a new agent
 * run never inherits a read window from a previous round).
 */
export function clearQuarantines(state: ToolclipRuntimeState): void {
	state.quarantines.clear();
}