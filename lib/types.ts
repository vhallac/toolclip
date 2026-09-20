/**
 * Toolclip configuration.
 *
 * Currently empty: size-bound thresholds (the marker token threshold and the
 * max-replacement-ratio) were removed so replacement behavior can be observed
 * without pre-filtering or gating. Kept as an interface (rather than deleted)
 * so config plumbing stays in place for when we reintroduce limits based on
 * observed behavior.
 */
export interface ToolclipConfig {
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
