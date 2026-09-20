export interface ToolclipConfig {
	thresholdTokens: number;
	maxReplacementRatio: number;
}

/**
 * One tracked tool result. Created when an over-threshold tool result is
 * observed, mutated when the LLM calls `replace_tool_result` for it.
 *
 * `replacement` is the LLM-supplied tight replacement text. Until it is
 * set, the entry is "pending"; once set, the context-event handler will
 * swap the original out on subsequent LLM calls.
 */
export interface ToolclipRuntimeStateEntry {
	originalTokens: number;
	originalContent: string;
	replacement?: string;
}

/**
 * Runtime state for the extension. Map keyed by tool-call id. Pure —
 * callers pass the state object in.
 */
export interface ToolclipRuntimeState {
	entries: Map<string, ToolclipRuntimeStateEntry>;
}