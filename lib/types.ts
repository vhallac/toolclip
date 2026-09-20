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
 * quarantine notice and the payload is held aside for exactly one turn
 * ("use it or lose it"), retrievable via `read_quarantined_result`.
 */
export interface ToolclipConfig {
	/**
	 * Minimum estimated token count for a tool result to receive a pending
	 * marker. Results with fewer tokens are skipped entirely. Defaults to
	 * `1000`. Gated by `TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS`.
	 */
	toolResultThresholdTokens: number;
	/**
	 * Whether to inject count-band steering reminders when the agent has
	 * left marked tool results un-replaced. Defaults to `true`. Gated by
	 * `TOOLCLIP_STEERING_REMINDER`.
	 */
	steeringReminder: boolean;
	/**
	 * Band size for the count-based steering reminder: it fires when the
	 * number of un-replaced pending results first reaches each multiple of
	 * this value (5–9, 10–14, ... for the default `5`), and re-arms when the
	 * count drops back below the announced band. Defaults to `5`. Gated by
	 * `TOOLCLIP_STEERING_REMINDER_MULTIPLE`.
	 */
	steeringReminderMultiple: number;
	/**
	 * Whether oversized tool results are quarantined (content swapped for a
	 * notice, payload held for one turn). Defaults to `true`. Gated by
	 * `TOOLCLIP_QUARANTINE`.
	 */
	quarantine: boolean;
	/**
	 * Minimum estimated token count for a tool result to be quarantined:
	 * content swapped for a notice, payload held for one turn. Must be well
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
 * (released) or when its one-turn window expires (evicted).
 *
 * `createdTurn` is the turn index (pi's `turn_start`/`turn_end` counter)
 * during which the result was quarantined. The LLM first sees the notice
 * in the NEXT turn (`createdTurn + 1`), which is the only turn in which a
 * read attempt is honored. At the `turn_end` of that turn, unread entries
 * are evicted.
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
 * `quarantines` tracks held payloads awaiting a (single-turn) read.
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
