import type { ToolclipConfig } from "./types.ts";

/**
 * Default minimum token count for a tool result to get a pending marker.
 * Results at or below this threshold are too small for distillation to pay
 * off — marking them only wastes a toolCallId and steering budget.
 */
const DEFAULT_TOOL_RESULT_THRESHOLD_TOKENS = 1000;

/**
 * Default pending-count threshold for the steering reminder: it fires when
 * the number of un-replaced pending results strictly exceeds this value,
 * and re-arms when the count falls back to it or below.
 */
const DEFAULT_STEERING_COUNT_THRESHOLD = 5;

/**
 * Default total-size threshold (estimated tokens) for the steering
 * reminder: it fires when the un-replaced pending pile strictly exceeds
 * this, and re-arms when the total falls back to it or below. Catches the
 * single-huge-item case the count trigger is blind to (count = 1).
 */
const DEFAULT_STEERING_SIZE_THRESHOLD_TOKENS = 5000;

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
 * The steering reminder is delivered via pi's native steering when either
 * trigger fires: the number of un-replaced pending results strictly exceeds
 * `steeringCountThreshold` (default 5), or their total estimated size
 * strictly exceeds `steeringSizeThresholdTokens` (default 5000). Each
 * trigger nags once per excursion (its latch re-arms when its condition
 * falls back to the threshold), and the two latches are independent — one
 * trigger's fire never suppresses the other's. The reminder lists the
 * pending ids with their sizes. It is sent with `deliverAs: "steer"`, so pi
 * persists it as a real user message at the next turn boundary — part of
 * the session's messages, visible in every subsequent LLM call.
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
		steeringCountThreshold: parsePositiveInt(
			env.TOOLCLIP_STEERING_COUNT_THRESHOLD,
			DEFAULT_STEERING_COUNT_THRESHOLD,
		),
		steeringSizeThresholdTokens: parsePositiveInt(
			env.TOOLCLIP_STEERING_SIZE_THRESHOLD_TOKENS,
			DEFAULT_STEERING_SIZE_THRESHOLD_TOKENS,
		),
		quarantine: parseBool(env.TOOLCLIP_QUARANTINE, true),
		quarantineThresholdTokens: parsePositiveInt(
			env.TOOLCLIP_QUARANTINE_THRESHOLD_TOKENS,
			DEFAULT_QUARANTINE_THRESHOLD_TOKENS,
		),
	};
}
