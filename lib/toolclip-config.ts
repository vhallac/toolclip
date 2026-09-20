import type { ToolclipConfig } from "./types.ts";

/**
 * Default turn threshold for the steering reminder. The reminder fires at
 * most once per round, and only once the agent has made at least this many
 * tool-result-bearing turns while a pending-unreplaced marker exists — i.e.
 * it has had a real chance to act on the markers and has not.
 */
const DEFAULT_STEERING_REMINDER_TURN = 3;

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
 * Size-bound thresholds (marker threshold + max-replacement-ratio) have been
 * removed so we can observe replacement behavior without pre-filtering or
 * gating. Every non-empty text tool result gets a pending marker, and
 * `replace_tool_result` accepts a replacement of any size. The extension
 * records when a replacement grew larger than its original (the observation
 * target); no rejection happens.
 *
 * If/when we observe replacements that bloat rather than shrink context,
 * that is the signal to reintroduce a gate here.
 *
 * The one config knob that remains is the steering reminder: a single
 * trailing user message injected once per round when the agent has left
 * marked results un-replaced for several turns. It is cache-safe — it is
 * appended to the *end* of the context (a new user block), so the cached
 * prefix is never touched.
 */
export function loadToolclipConfig(env: NodeJS.ProcessEnv = process.env): ToolclipConfig {
	return {
		steeringReminder: parseBool(env.TOOLCLIP_STEERING_REMINDER, true),
		steeringReminderTurn: parsePositiveInt(
			env.TOOLCLIP_STEERING_REMINDER_TURN,
			DEFAULT_STEERING_REMINDER_TURN,
		),
	};
}
