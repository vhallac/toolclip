/**
 * Toolclip configuration.
 *
 * `toolResultThresholdTokens`: minimum estimated token count for a tool
 * result to get a pending-replacement marker. Results at or below this
 * threshold are left untouched — they are too small for distillation to pay
 * off, so marking them only wastes a toolCallId and steering budget. The
 * max-replacement-ratio gate is intentionally NOT reintroduced:
 * replacements of any size are accepted (the hard-fail "replacement must be
 * strictly shorter than original" check was removed for observation and
 * stays removed).
 *
 * `quarantineThresholdTokens`: results above this (much higher) threshold
 * are not shown to the LLM at all — their content is swapped for a
 * quarantine notice and the payload is held in memory until read
 * ("held until read; freed after reading"), retrievable via
 * `read_quarantined_result`.
 */
export interface ToolclipConfig {
	/**
	 * Minimum estimated token count for a tool result to receive a pending
	 * marker. Results with fewer tokens are skipped entirely. Defaults to
	 * `1000`. Gated by `TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS`.
	 */
	toolResultThresholdTokens: number;
	/**
	 * Whether to inject steering reminders when the agent has left marked
	 * tool results un-replaced. Defaults to `true`. Gated by
	 * `TOOLCLIP_STEERING_REMINDER`.
	 */
	steeringReminder: boolean;
	/**
	 * Pending-count threshold for the steering reminder: it fires when the
	 * number of un-replaced pending results strictly exceeds this value,
	 * and re-arms when the count falls back to it or below (one nag per
	 * excursion). Defaults to `5`. Gated by
	 * `TOOLCLIP_STEERING_COUNT_THRESHOLD`.
	 */
	steeringCountThreshold: number;
	/**
	 * Total-size threshold (estimated tokens) for the steering reminder: it
	 * fires when the un-replaced pending pile strictly exceeds this, and
	 * re-arms when the total falls back to it or below. Independent of the
	 * count trigger — it catches a single huge un-replaced result (count of
	 * 1), which the count trigger is structurally blind to. Defaults to
	 * `5000`. Gated by `TOOLCLIP_STEERING_SIZE_THRESHOLD_TOKENS`.
	 */
	steeringSizeThresholdTokens: number;
	/**
	 * Whether oversized tool results are quarantined (content swapped for a
	 * notice, payload held until read). Defaults to `true`. Gated by
	 * `TOOLCLIP_QUARANTINE`.
	 */
	quarantine: boolean;
	/**
	 * Minimum estimated token count for a tool result to be quarantined:
	 * content swapped for a notice, payload held until read. Must be well
	 * above `toolResultThresholdTokens`. Defaults to `10000`. Gated by
	 * `TOOLCLIP_QUARANTINE_THRESHOLD_TOKENS`.
	 */
	quarantineThresholdTokens: number;
}

/**
 * One tracked tool result. Created when a (non-empty) tool result is
 * observed, mutated when the LLM calls `replace_tool_result` for it.
 *
 * `replacement` is the LLM-supplied replacement text. Until it is
 * set, the entry is "pending"; once set, the context-event handler will
 * swap the original out on subsequent LLM calls.
 *
 * `grew` is set when a replacement is recorded whose estimated token count is
 * >= the original's — the observation target. No rejection happens; this is
 * purely diagnostic.
 */
export interface ToolclipRuntimeStateEntry {
	originalTokens: number;
	originalContent: string;
	replacement?: string;
	replacementTokens?: number;
	grew?: boolean;
}

/**
 * One held (quarantined) tool-result payload. Created when a result over
 * the quarantine threshold is observed; removed when the LLM reads it
 * (released). There is no eviction — payloads are held for the session's
 * lifetime ("held until read; freed after reading"): the session file
 * holds only the notice, so the in-memory payload is the only copy, and
 * evicting it was permanent data destruction (the 2026-09-20 golden run's
 * one-turn window destroyed exactly the one payload the model needed).
 *
 * `createdTurn` is the turn index (pi's `turn_start`/`turn_end` counter)
 * during which the result was quarantined. The LLM first sees the notice
 * in the NEXT turn (`createdTurn + 1`) because pi delivers a turn's tool
 * results at that turn's `turn_end` — but the notice starts no countdown:
 * a read attempt is honored at any later turn. Kept for diagnostics.
 */
export interface QuarantineEntry {
	payload: string;
	tokens: number;
	createdTurn: number;
}

/**
 * Runtime state for the extension. Pure — callers pass the state object in.
 *
 * `entries` tracks replaceable tool results (keyed by tool-call id).
 * `quarantines` tracks held payloads awaiting a read (session lifetime).
 * `currentTurn` mirrors pi's turn index, maintained via `turn_start`.
 * `readsThisRound` counts successful read results per path within the
 * current round (re-read observation; reset at each round boundary).
 */
export interface ToolclipRuntimeState {
	entries: Map<string, ToolclipRuntimeStateEntry>;
	quarantines: Map<string, QuarantineEntry>;
	currentTurn: number;
	readsThisRound: Map<string, number>;
}
