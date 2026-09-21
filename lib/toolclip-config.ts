import type { ToolclipConfig } from "./types.ts";
import { DEFAULT_EXPIRY_RHO, DEFAULT_EXPIRY_WRITE_RATIO } from "./expiry.ts";

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

/** Mode-dependent expiry defaults: with the replacement text kept once (pointer mode)
 * the per-turn saving formula sees one copy and a slightly larger overhead —
 * the pointer (~35 tokens) replaces the old two-block replaced marker (~29 tokens).
 * Copy mode keeps the original defaults. An explicit env value always wins. */
const POINTER_MODE_DEFAULTS = { copies: 1, overhead: 95 };
const COPY_MODE_DEFAULTS = { copies: 2, overhead: 60 };

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

/** Parse a finite float, rejecting values below `min` (used for price priors). */
function parseNumber(value: string | undefined, fallback: number, min: number): number {
	if (value === undefined) {
		return fallback;
	}
	const n = Number(value);
	if (!Number.isFinite(n) || n < min) {
		return fallback;
	}
	return n;
}

/** Parse a non-negative integer (rejects negatives and non-integers). Used for the
 * receipt tag length, where 0 is meaningful ("disable the tag"). */
function parseNonNegativeInt(value: string | undefined, fallback: number): number {
	if (value === undefined) {
		return fallback;
	}
	const n = Number(value);
	if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
		return fallback;
	}
	return n;
}

/**
 * Parse the replacement mode. "copy" opts into the pre-pointer swap
 * (summary text in both places — for A/B runs); every other value,
 * including unset, means the "pointer" default.
 */
function parseMode(value: string | undefined): "pointer" | "copy" {
	return value !== undefined && value.toLowerCase() === "copy" ? "copy" : "pointer";
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
 *
 * Expiry: a pending result older than the point where replacing it still
 * pays back is "expired" — replacing it would rewrite more cached suffix
 * than it saves over the expected remaining turns. Expired entries are
 * deleted from the tracker, dropped from the nag, and any replace call
 * naming them is silently ignored (`ok: true, ignored: "expired"` — never
 * an error). The pay-back test compares the tokens appended since the
 * entry was first counted (S_i) against `rho/(w - rho) * net_i * H`, with
 * net_i the per-turn saving (original minus COPIES×R minus OVERHEAD, R the
 * assumed replacement size) and H the clamped turn horizon; rho and w are
 * EMA-measured from per-turn usage costs, starting at the
 * `expiryRho`/`expiryWriteRatio` priors. Three or more consecutive turns
 * without cache activity freeze expiry. Expiry never modifies `pileTotal`
 * (the ladder's total) and is monotone — expired ids are never re-armed.
 * Gated by `TOOLCLIP_EXPIRY` (false: no expiry, ladder-only).
 *
 * Replacement mode (pointer vs copy): the replacement text is kept exactly
 * ONCE in context — in the model's own `replace_tool_result` call
 * arguments, which are never modified. On subsequent LLM calls a replaced
 * original is swapped for a pointer naming that call and its receipt:
 * `[tool-result-replaced: toolCallId=x; summary is the replacement text for
 * this id in your replace_tool_result call call_A, receipt rp7k2-1]`. The
 * receipt (prefix + random base36 tag + call counter, e.g. "rp7k2-3") is
 * stamped on the tool's echo — "Receipt rp7k2-1: stored 2 replacement(s)
 * (call call_A). Originals are swapped for a pointer to this call's
 * arguments in subsequent LLM calls:" — and on every replaced entry, so
 * the model resolves the pointer via the call whose result carries the
 * same receipt (the reliable key: some chat templates never show call
 * ids). A re-replacement re-points the entry at the newest call. If the
 * pointer's target call is no longer in the messages (compaction, a fork,
 * another extension), the swap falls back to the copy form — a pointer
 * must never dangle. Copy mode (`TOOLCLIP_REPLACEMENT_MODE=copy`) keeps
 * the pre-pointer behavior for A/B runs: the summary text is written in
 * both places (swapped result and call args), the echo keeps its old
 * header, and the receipt is minted only into details. The mode also
 * shifts the expiry defaults — pointer: COPIES 1, OVERHEAD 95 (the
 * pointer replaces the old two-block marker); copy: COPIES 2, OVERHEAD
 * 60 — with an explicit env value always winning.
 */
export function loadToolclipConfig(env: NodeJS.ProcessEnv = process.env): ToolclipConfig {
	const replacementMode = parseMode(env.TOOLCLIP_REPLACEMENT_MODE);
	const expiryDefaults =
		replacementMode === "pointer" ? POINTER_MODE_DEFAULTS : COPY_MODE_DEFAULTS;
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
		expiry: parseBool(env.TOOLCLIP_EXPIRY, true),
		expiryRho: parseNumber(env.TOOLCLIP_EXPIRY_RHO, DEFAULT_EXPIRY_RHO, 0),
		expiryWriteRatio: parseNumber(env.TOOLCLIP_EXPIRY_WRITE_RATIO, DEFAULT_EXPIRY_WRITE_RATIO, 0),
		expiryReplacementTokens: parsePositiveInt(env.TOOLCLIP_EXPIRY_REPLACEMENT_TOKENS, 170),
		expiryReplacementCopies: parsePositiveInt(
			env.TOOLCLIP_EXPIRY_REPLACEMENT_COPIES,
			expiryDefaults.copies,
		),
		expiryOverheadTokens: parsePositiveInt(
			env.TOOLCLIP_EXPIRY_OVERHEAD_TOKENS,
			expiryDefaults.overhead,
		),
		expiryHorizonMinTurns: parsePositiveInt(env.TOOLCLIP_EXPIRY_HORIZON_MIN_TURNS, 10),
		expiryHorizonMaxTurns: parsePositiveInt(env.TOOLCLIP_EXPIRY_HORIZON_MAX_TURNS, 100),
		expiryAnnounce: parseBool(env.TOOLCLIP_EXPIRY_ANNOUNCE, true),
		replacementMode,
		pointerIncludeCallId: parseBool(env.TOOLCLIP_POINTER_INCLUDE_CALL_ID, true),
		receiptPrefix:
			env.TOOLCLIP_RECEIPT_PREFIX !== undefined && env.TOOLCLIP_RECEIPT_PREFIX.length > 0
				? env.TOOLCLIP_RECEIPT_PREFIX
				: "rp",
		receiptTagLength: parseNonNegativeInt(env.TOOLCLIP_RECEIPT_TAG_LENGTH, 3),
	};
}
