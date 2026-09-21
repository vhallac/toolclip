/**
 * Quarantine store operations.
 *
 * A quarantined tool result is one whose estimated token count exceeded the
 * quarantine threshold at `tool_result` time. Its content is NOT shown to
 * the LLM: the tool_result handler swaps in a notice and the full payload is
 * held here, keyed by the original tool call id.
 *
 * Lifetime ("held until read; freed after reading"): payloads are held for
 * the session's lifetime — there is no eviction. The LLM first sees the
 * notice when it generates the turn AFTER the one in which the result was
 * quarantined (`createdTurn + 1`), because pi delivers a turn's tool results
 * at that turn's `turn_end` — but the notice starts no countdown: a
 * `read_quarantined_result` call is honored at any later turn. A successful
 * read releases (destroys) the payload; the id is remembered as released so
 * a later read attempt can be told "already read" instead of "never held".
 *
 * Why no eviction: the session file holds only the notice — the in-memory
 * payload is the only copy, so eviction was permanent data destruction. The
 * former one-turn read window ("use it or lose it") collided with the
 * steering nag in the 2026-09-20 golden run: the nag consumed the single
 * read-window turn, the eviction then destroyed a payload the model
 * genuinely needed, and the model re-fetched it in 11 piecemeal reads. Held
 * payloads cost a few hundred KB per run at most — host RAM is not the
 * scarce resource; irreversibly destroyed context is. The natural brake
 * survives: a read re-enters the pending path (huge by construction →
 * pending marker → must be distilled), so re-reading stale data later is
 * possible but deliberately costly.
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
 * second read for the same id is denied — and the id is remembered in
 * `state.releasedQuarantines` so the denial can say "already read" rather
 * than "never held".
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
		state.releasedQuarantines.add(toolCallId);
	}
	return entry;
}

/**
 * Why a read was denied. `already-read`: the id was quarantined and has
 * been released by an earlier read. `never-held`: no quarantine was ever
 * recorded for the id — most often the model mistook a pending-replacement
 * marker for a quarantine notice.
 */
export type QuarantineMissReason = "already-read" | "never-held";

/**
 * Build the notice swapped into a quarantined result's LLM-facing content.
 * Carries the marker (parseable identity) plus the guidance: narrow the
 * call when only part of the data is needed; read the held payload once,
 * in full, when all of it is needed — never reconstruct it piecemeal with
 * several narrowed calls (that costs more than one read). No urgency
 * language: the payload is held until read, so the model can act on the
 * steering nag first without losing the data (the collision that destroyed
 * a payload in the 2026-09-20 golden run).
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
		`2. If you need the whole payload: call read_quarantined_result({ toolCallId: "${toolCallId}" }) once. Do NOT reconstruct the payload piecemeal with several narrowed calls — that costs more calls and more tokens than one full read.\n` +
		"The payload is held until you read it; the read frees it, so a second read of the same id is denied."
	);
}

/**
 * Build the denial text returned when a read targets an id that is not
 * held. Distinguishes the two cases — an earlier read freed the payload,
 * vs. the id never having been quarantined (typically a pending-marked
 * result, whose full content is already in the model's context).
 *
 * @param toolCallId - The id that was requested.
 * @param reason - Why nothing is held for the id.
 */
export function buildQuarantineMissedNotice(
	toolCallId: string,
	reason: QuarantineMissReason,
): string {
	const marker = buildQuarantineMissedMarker(toolCallId);
	if (reason === "already-read") {
		return (
			marker +
			"\n" +
			"The quarantined payload for this id was already read — a read releases and frees it. " +
			"It is no longer retrievable. Re-run the original tool call with a narrower scope to regenerate the data you need."
		);
	}
	return (
		marker +
		"\n" +
		"No quarantined payload is held for this id — it was never quarantined, so there is nothing to read here. " +
		"If the result carries a [tool-result-pending-replacement: ...] marker, its full content is already in your context: " +
		"distill it with replace_tool_result instead of trying to read it. " +
		"Otherwise re-run the original tool call with a narrower scope."
	);
}

/**
 * Ids currently held. Insertion order — diagnostics and tests.
 */
export function quarantineIds(state: ToolclipRuntimeState): string[] {
	return [...state.quarantines.keys()];
}