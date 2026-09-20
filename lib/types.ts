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
	 * Whether to inject a single steering reminder per round when the agent
	 * has left marked tool results un-replaced for several turns. Defaults
	 * to `true`. Gated by `TOOLCLIP_STEERING_REMINDER`.
	 */
	steeringReminder: boolean;
	/**
	 * Minimum number of tool-result-bearing turns, while a pending-unreplaced
	 * marker exists, before the steering reminder becomes eligible. The
	 * reminder fires at most once per round. Defaults to `3`. Gated by
	 * `TOOLCLIP_STEERING_REMINDER_TURN`.
	 */
	steeringReminderTurn: number;
	/**
	 * Whether the token-estimator divisor is calibrated against the model's
	 * real token counts (`usage.input`) each turn. Calibration is ephemeral
	 * (per-session) and improves the accuracy of the pending-marker token
	 * counts. Defaults to `true`. Gated by `TOOLCLIP_CALIBRATE`.
	 */
	calibrate: boolean;
	/**
	 * Starting chars-per-token divisor when calibration is enabled (and the
	 * divisor when it is disabled). Defaults to `4`, matching the chars/4
	 * heuristic. Gated by `TOOLCLIP_CALIBRATOR_INITIAL_DIVISOR`.
	 */
	calibratorInitialDivisor: number;
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
 */
export interface ToolclipRuntimeState {
	entries: Map<string, ToolclipRuntimeStateEntry>;
	quarantines: Map<string, QuarantineEntry>;
	currentTurn: number;
}
