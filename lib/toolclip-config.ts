import type { ToolclipConfig } from "./types.ts";

/**
 * Load toolclip configuration.
 *
 * Size-bound thresholds (marker threshold + max-replacement-ratio) have been
 * removed so we can observe replacement behavior without pre-filtering or
 * gating. Every non-empty text tool result gets a pending marker, and
 * `replace_tool_result` accepts a replacement of any size. The extension
 * records when a replacement grew larger than its original (the observation
 * target); no rejection happens.
 *
 * If/when we observe replacements that bloat rather than shrink context,
 * that is the signal to reintroduce a gate here.
 */
export function loadToolclipConfig(_env: NodeJS.ProcessEnv = process.env): ToolclipConfig {
	return {};
}
