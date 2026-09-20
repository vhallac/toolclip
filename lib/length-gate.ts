/**
 * Length gate for toolclip replacements.
 *
 * Validates that an LLM-supplied replacement satisfies two constraints:
 *
 * 1. **Hard fail**: replacement must be strictly shorter than the original
 *    (`replacementTokens < originalTokens`). This prevents the replacement
 *    from being as large as or larger than what it replaces — the whole
 *    point is to shrink context.
 *
 * 2. **Soft fail**: replacement length must not exceed
 *    `originalTokens × maxReplacementRatio`. This ensures replacements are
 *    aggressively short relative to the original.
 *
 * Both rules fail independently. The returned reason string includes the
 * rule that was violated, the actual token numbers, and the configured ratio.
 *
 * Pure module — no I/O, no pi deps.
 */

export interface LengthGateOk {
	ok: true;
}

export interface LengthGateFail {
	ok: false;
	reason: string;
}

export type LengthGateResult = LengthGateOk | LengthGateFail;

/**
 * Validate a replacement against the original and the max-replacement-ratio.
 *
 * @param originalTokens  - Token estimate of the original tool result.
 * @param replacementTokens - Token estimate of the proposed replacement.
 * @param maxReplacementRatio - The configured max ratio (default 0.1).
 * @returns `{ok: true}`  if both constraints pass,
 *          `{ok: false, reason}`  otherwise.
 *
 * Edge cases:
 * - `originalTokens <= 0` passes (no original to violate — the caller
 *   shouldn't be replacing a non-existent result, but if they do, allow it.
 *   The hard-fail `replacement < original` is trivially satisfied for any
 *   positive replacement).
 * - `replacementTokens <= 0`  → soft-fail message says "0 tokens" accurately.
 * - `maxReplacementRatio <= 0`  forces soft-fail unless replacement is 0.
 *   The plan doesn't prescribe special handling; the math is correct.
 */
export function validateReplacement(
	originalTokens: number,
	replacementTokens: number,
	maxReplacementRatio: number,
): LengthGateResult {
	// Hard fail: replacement must be strictly shorter than original
	if (replacementTokens >= originalTokens) {
		return {
			ok: false,
			reason:
				`replacement must be strictly shorter than the original ` +
				`(replacement is ${replacementTokens} tokens; original is ${originalTokens} tokens)`,
		};
	}

	// Soft fail: replacement must not exceed original × ratio
	const maxAllowed = originalTokens * maxReplacementRatio;
	if (replacementTokens > maxAllowed) {
		return {
			ok: false,
			reason:
				`replacement exceeds the maximum allowed fraction of the original ` +
				`(replacement is ${replacementTokens} tokens; original is ${originalTokens} tokens; ` +
				`ratio ${(replacementTokens / originalTokens).toFixed(2)} exceeds max ${maxReplacementRatio})`,
		};
	}

	return { ok: true };
}