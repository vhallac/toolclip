import type { ToolclipConfig } from "./types.ts";

/**
 * Default minimum token count for a tool result to get a pending marker.
 * Results at or below this threshold are too small for distillation to pay
 * off — marking them only wastes a toolCallId and steering budget.
 */
const DEFAULT_TOOL_RESULT_THRESHOLD_TOKENS = 1000;

/**
 * Default first rung of the steering ladder (estimated tokens): the nag
 * fires once the eligible pending mass strictly exceeds this, then at each
 * higher Fibonacci rung (1.6×, 2.6×, 4.2×, 6.8×, ... of this value).
 */
const DEFAULT_STEERING_FIRST_RUNG_TOKENS = 5000;

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
 * The steering reminder is delivered via pi's native steering when the
 * eligible pending mass (the total original estimated tokens of pending
 * entries whose ids are in the most recent context event's messages)
 * crosses a rung of the Fibonacci ladder whose first rung is
 * `steeringFirstRungTokens` — gated by `TOOLCLIP_STEERING_SIZE_THRESHOLD_TOKENS`
 * (default 5000; the env var's name predates the ladder and is kept, it now
 * means "first rung"). Rungs sit at 1×, 1.6×, 2.6×, 4.2×, 6.8×, ... of the
 * first rung (5000, 8000, 13000, 21000, 34000, ... by default). A single
 * ratchet (`level` — rungs already announced) nags once per rung crossing
 * (one nag even when several rungs are crossed at once), re-arms down when
 * the mass falls below an announced rung, and resets at each round
 * boundary. The reminder lists the eligible pending ids with their sizes.
 * It is sent with `deliverAs: "steer"`, so pi persists it as a real user
 * message at the next turn boundary — part of the session's messages,
 * visible in every subsequent LLM call.
 *
 * Quarantine: results above `quarantineThresholdTokens` (default 10000) are
 * withheld from the LLM entirely — the content is swapped for a notice and
 * the payload is held in memory until read, retrievable via
 * `read_quarantined_result` ("held until read; freed after reading").
 * Disable to fall back to plain pending markers for all sizes.
 */
export function loadToolclipConfig(env: NodeJS.ProcessEnv = process.env): ToolclipConfig {
	return {
		toolResultThresholdTokens: parsePositiveInt(
			env.TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS,
			DEFAULT_TOOL_RESULT_THRESHOLD_TOKENS,
		),
		steeringReminder: parseBool(env.TOOLCLIP_STEERING_REMINDER, true),
		steeringFirstRungTokens: parsePositiveInt(
			env.TOOLCLIP_STEERING_SIZE_THRESHOLD_TOKENS,
			DEFAULT_STEERING_FIRST_RUNG_TOKENS,
		),
		quarantine: parseBool(env.TOOLCLIP_QUARANTINE, true),
		quarantineThresholdTokens: parsePositiveInt(
			env.TOOLCLIP_QUARANTINE_THRESHOLD_TOKENS,
			DEFAULT_QUARANTINE_THRESHOLD_TOKENS,
		),
	};
}
