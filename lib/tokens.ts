/**
 * Token estimation and calibration.
 *
 * The raw heuristic is `chars / divisor` with a default divisor of 4
 * (chars/4 — the same estimate sesclip uses). The divisor can be calibrated
 * against the model's real token counts: each turn we compare the character
 * count of the prompt against pi's reported usage, turning the observed
 * chars-per-token ratio into an EMA-adjusted divisor.
 *
 * Scope pairing matters: providers report `usage.input` as only the
 * non-cached portion of the prompt (cached tokens ride in `usage.cacheRead`
 * / `usage.cacheWrite`), and the prompt includes the system prompt and tool
 * definitions, which are absent from the `messages` array. The caller must
 * therefore pass the TOTAL prompt tokens (`input + cacheRead + cacheWrite`)
 * as `actualTokens`, and record the prompt's constant part (system prompt +
 * tool definition chars) via `setOverheadChars` so the numerator covers the
 * same scope as the denominator. The blended divisor is clamped to
 * [MIN_CALIBRATED_DIVISOR, MAX_CALIBRATED_DIVISOR] so a single bad sample
 * cannot push estimates out of a sane range.
 *
 * Calibration is per-session and ephemeral. It does not persist — persisting
 * the calibrated divisor is a documented future improvement.
 */

/** Baseline chars-per-token heuristic used as the starting divisor. */
export const DEFAULT_DIVISOR = 4;

/**
 * Hard lower bound for the calibrated divisor. Real prompts rarely run
 * below ~3 chars/token (code with dense punctuation can approach 3);
 * anything below 2 means the sample's scope was mismatched — clamp rather
 * than let one bad sample inflate every later estimate 10x.
 */
export const MIN_CALIBRATED_DIVISOR = 2;

/**
 * Hard upper bound for the calibrated divisor. Natural-language-heavy
 * contexts stay below ~5 chars/token; above 8 the sample is again
 * suspect. If calibration keeps pinning at this boundary, the sample
 * pairing itself is wrong (that is the signal to switch to delta
 * calibration).
 */
export const MAX_CALIBRATED_DIVISOR = 8;

/**
 * Estimate the token count of a single text string.
 *
 * @param text - The text to estimate.
 * @param divisor - Chars-per-token divisor. Defaults to `DEFAULT_DIVISOR`.
 * @returns The ceiling of `text.length / divisor`. Empty string yields 0.
 */
export function estimateTokens(text: string, divisor: number = DEFAULT_DIVISOR): number {
	if (text.length === 0) {
		return 0;
	}
	return Math.ceil(text.length / divisor);
}

/**
 * Estimate total tokens in an array of LLM messages.
 *
 * Handles both string content and content-block arrays. Non-text content
 * blocks (e.g. image metadata) are ignored, matching how the pending-marker
 * token count is computed.
 *
 * @param messages - The LLM messages to estimate.
 * @param divisor - Chars-per-token divisor. Defaults to `DEFAULT_DIVISOR`.
 */
export function estimateMessagesTokens(
	messages: readonly unknown[],
	divisor: number = DEFAULT_DIVISOR,
): number {
	let total = 0;
	for (const message of messages) {
		total += messageChars(message);
	}
	return Math.ceil(total / divisor);
}

/**
 * Sum the raw character count of all text content across a message array.
 *
 * This is the divisor-independent form of `estimateMessagesTokens`: it
 * returns total text characters rather than a token estimate. Calibration
 * uses this so the observed chars-per-token ratio (`chars / actualTokens`)
 * is independent of the current (possibly already-calibrated) divisor.
 */
export function countMessagesChars(messages: readonly unknown[]): number {
	let total = 0;
	for (const message of messages) {
		total += messageChars(message);
	}
	return total;
}

/**
 * Extract the total text character count of a single message's content.
 *
 * Shared helper for the message-level estimators. Accepts a string or a
 * content-block array; non-text blocks contribute nothing.
 */
function messageChars(message: unknown): number {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") {
		return content.length;
	}

	if (!Array.isArray(content)) {
		return 0;
	}

	let total = 0;
	for (const block of content) {
		if (typeof block === "string") {
			total += block.length;
			continue;
		}
		const text = (block as { text?: unknown }).text;
		if (typeof text === "string") {
			total += text.length;
		}
	}
	return total;
}

/**
 * Stateful calibrator that learns a better divisor over the session.
 *
 * Each turn we observe the character count of the full context and the
 * model's actual input-token count for that context. The observed
 * chars-per-token ratio (`chars / actual`) is blended into the running
 * divisor with an exponential moving average whose weight decays as more
 * samples accumulate, so the divisor stabilizes after a few turns rather
 * than chasing per-turn noise.
 *
 * All functions are pure: the calibrator object is explicit state passed in.
 */
export interface Calibrator {
	/** Current learned chars-per-token divisor. */
	divisor: number;
	/** Character count of the most recent context snapshot. */
	latestChars: number | null;
	/** Number of calibration samples blended so far. */
	sampleCount: number;
	/**
	 * Character count of the constant prompt part that is NOT in the
	 * messages array: the system prompt plus the serialized tool
	 * definitions. Added to every numerator so it covers the same scope as
	 * the total-prompt-token denominator.
	 */
	overheadChars: number;
}

/**
 * Create a fresh calibrator starting from the given divisor.
 *
 * @param initialDivisor - Starting chars-per-token divisor. Defaults to
 *                         `DEFAULT_DIVISOR`.
 */
export function createCalibrator(initialDivisor: number = DEFAULT_DIVISOR): Calibrator {
	return { divisor: initialDivisor, latestChars: null, sampleCount: 0, overheadChars: 0 };
}

/**
 * Record the constant prompt part outside the messages array (system
 * prompt + serialized tool definitions, in characters). Non-finite or
 * negative values are ignored.
 */
export function setOverheadChars(cal: Calibrator, chars: number): void {
	if (!Number.isFinite(chars) || chars < 0) {
		return;
	}
	cal.overheadChars = chars;
}

/**
 * Record a context snapshot's character count. Stored so the next
 * `observeTokens` can compute this turn's chars-per-token ratio.
 */
export function setSnapshotChars(cal: Calibrator, chars: number): void {
	cal.latestChars = chars;
}

/**
 * Blend one observation of `(chars, actualTokens)` into the divisor via EMA.
 *
 * `chars` is the character count of the messages array for the prompt that
 * produced `actualTokens`; the calibrator adds `overheadChars` (system
 * prompt + tool definitions) so the numerator covers the same scope as the
 * denominator. `actualTokens` must be the TOTAL prompt tokens for that
 * call — for OpenAI-completions-style providers that is
 * `usage.input + usage.cacheRead + usage.cacheWrite`, since `usage.input`
 * alone excludes cached tokens.
 *
 * The observed divisor for this sample is `promptChars / actualTokens`.
 * Guards skip degenerate samples: a zero or non-finite `chars` or
 * `actualTokens` yields no change. The EMA weight starts at 1/2 and decays
 * toward a floor of 1/31 as `sampleCount` grows, so early turns adapt
 * quickly and later turns only nudge the divisor. The blended result is
 * clamped to [MIN_CALIBRATED_DIVISOR, MAX_CALIBRATED_DIVISOR].
 *
 * @returns The updated divisor (equal to the previous one if the sample was
 *          skipped).
 */
export function observeTokens(
	cal: Calibrator,
	chars: number,
	actualTokens: number,
): number {
	if (!Number.isFinite(chars) || !Number.isFinite(actualTokens)) {
		return cal.divisor;
	}
	const promptChars = chars + cal.overheadChars;
	if (promptChars <= 0 || actualTokens <= 0) {
		return cal.divisor;
	}

	const observedDivisor = promptChars / actualTokens;
	const alpha = 1 / Math.min(cal.sampleCount + 1, 30);
	const blended = cal.divisor * (1 - alpha) + observedDivisor * alpha;
	cal.divisor = Math.min(
		MAX_CALIBRATED_DIVISOR,
		Math.max(MIN_CALIBRATED_DIVISOR, blended),
	);
	cal.sampleCount = Math.min(cal.sampleCount + 1, 99);
	return cal.divisor;
}

/**
 * Read the current calibrated divisor. Falls back to the initial divisor if
 * no calibration has happened yet.
 */
export function getDivisor(cal: Calibrator): number {
	return cal.divisor;
}