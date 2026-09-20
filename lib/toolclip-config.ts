import type { ToolclipConfig } from "./types.ts";

/**
 * Default minimum token count for a tool result to get a pending marker.
 * Results at or below this threshold are too small for distillation to pay
 * off — marking them only wastes a toolCallId and steering budget.
 */
const DEFAULT_TOOL_RESULT_THRESHOLD_TOKENS = 1000;

/**
 * Default turn threshold for the steering reminder. The reminder fires at
 * most once per round, and only once the agent has made at least this many
 * tool-result-bearing turns while a pending-unreplaced marker exists — i.e.
 * it has had a real chance to act on the markers and has not.
 */
const DEFAULT_STEERING_REMINDER_TURN = 3;

/**
 * Default for whether the token-estimator divisor is calibrated against the
 * model's real token counts each turn. Calibration is ephemeral (per
 * session) and improves the accuracy of the pending-marker token counts.
 */
const DEFAULT_CALIBRATE = true;

/**
 * Default starting chars-per-token divisor when calibration is enabled.
 * Chars/4 is the same heuristic sesclip uses.
 */
const DEFAULT_CALIBRATOR_INITIAL_DIVISOR = 4;

function parseBool(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) {
		return fallback;
	}
	return value === "1" || value.toLowerCase() === "true";
}

function parsePositiveNum(value: string | undefined, fallback: number): number {
	if (value === undefined) {
		return fallback;
	}
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) {
		return fallback;
	}
	return n;
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
 * The steering reminder is a single trailing user message injected once per
 * round when the agent has left marked results un-replaced for several
 * turns. It is cache-safe — it is appended to the *end* of the context (a
 * new user block), so the cached prefix is never touched.
 *
 * Divisor calibration is ephemeral and per-session: when enabled, the
 * chars-per-token divisor used by the token estimator starts at
 * `calibratorInitialDivisor` (default 4) and is blended toward the model's
 * real token counts each turn. Disable to pin the divisor at the heuristic.
 */
export function loadToolclipConfig(env: NodeJS.ProcessEnv = process.env): ToolclipConfig {
	return {
		toolResultThresholdTokens: parsePositiveInt(
			env.TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS,
			DEFAULT_TOOL_RESULT_THRESHOLD_TOKENS,
		),
		steeringReminder: parseBool(env.TOOLCLIP_STEERING_REMINDER, true),
		steeringReminderTurn: parsePositiveInt(
			env.TOOLCLIP_STEERING_REMINDER_TURN,
			DEFAULT_STEERING_REMINDER_TURN,
		),
		calibrate: parseBool(env.TOOLCLIP_CALIBRATE, DEFAULT_CALIBRATE),
		calibratorInitialDivisor: parsePositiveNum(
			env.TOOLCLIP_CALIBRATOR_INITIAL_DIVISOR,
			DEFAULT_CALIBRATOR_INITIAL_DIVISOR,
		),
	};
}
