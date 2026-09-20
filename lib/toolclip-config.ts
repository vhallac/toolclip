import type { ToolclipConfig } from "./types.ts";

/**
 * Default minimum token count for a tool result to get a pending marker.
 * Results at or below this threshold are too small for distillation to pay
 * off — marking them only wastes a toolCallId and steering budget.
 */
const DEFAULT_TOOL_RESULT_THRESHOLD_TOKENS = 1000;

/**
 * Default band size for the count-based steering reminder. The reminder
 * fires when the number of un-replaced pending results first reaches each
 * multiple of this value (5–9, 10–14, ...), and re-arms when the count
 * drops back below the announced band — so a re-grown pile is nagged again.
 */
const DEFAULT_STEERING_REMINDER_MULTIPLE = 5;

/**
 * Default minimum token count for a tool result to be quarantined. Well
 * above the pending-marker threshold: routine large results (1k–10k) just
 * get pending markers; only truly huge results are held out of context.
 */
const DEFAULT_QUARANTINE_THRESHOLD_TOKENS = 10000;

function parseBool(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) {
		return fallback;
	}
	return value === "1" || value.toLowerCase() === "true";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (value === undefined) {
		return fallback;
	}
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
		return fallback;
	}
	return n;
}

/**
 * Load toolclip configuration.
 *
 * The marker token threshold (`toolResultThresholdTokens`, default 1000)
 * gates which tool results get a pending-replacement marker: only results
 * strictly above the threshold are marked. Smaller results are skipped —
 * distillation does not pay off for them.
 *
 * The max-replacement-ratio gate is intentionally NOT reintroduced.
 * `replace_tool_result` accepts a replacement of any size and records when
 * a replacement grew larger than its original (the observation target); no
 * rejection happens.
 *
 * The steering reminder is a trailing user message injected when the number
 * of un-replaced pending results first reaches each multiple of
 * `steeringReminderMultiple` (default 5), listing the pending ids. It is
 * cache-safe — it is appended to the *end* of the context (a new user
 * block), so the cached prefix is never touched.
 *
 * Quarantine: results above `quarantineThresholdTokens` (default 10000) are
 * withheld from the LLM entirely — the content is swapped for a notice and
 * the payload is held for exactly one turn, retrievable via
 * `read_quarantined_result` ("use it or lose it"). Disable to fall back to
 * plain pending markers for all sizes.
 */
export function loadToolclipConfig(env: NodeJS.ProcessEnv = process.env): ToolclipConfig {
	return {
		toolResultThresholdTokens: parsePositiveInt(
			env.TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS,
			DEFAULT_TOOL_RESULT_THRESHOLD_TOKENS,
		),
		steeringReminder: parseBool(env.TOOLCLIP_STEERING_REMINDER, true),
		steeringReminderMultiple: parsePositiveInt(
			env.TOOLCLIP_STEERING_REMINDER_MULTIPLE,
			DEFAULT_STEERING_REMINDER_MULTIPLE,
		),
		quarantine: parseBool(env.TOOLCLIP_QUARANTINE, true),
		quarantineThresholdTokens: parsePositiveInt(
			env.TOOLCLIP_QUARANTINE_THRESHOLD_TOKENS,
			DEFAULT_QUARANTINE_THRESHOLD_TOKENS,
		),
	};
}
