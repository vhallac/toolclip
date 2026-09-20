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
 * Runtime state for the extension. Map keyed by tool-call id. Pure —
 * callers pass the state object in.
 */
export interface ToolclipRuntimeState {
	entries: Map<string, ToolclipRuntimeStateEntry>;
}
