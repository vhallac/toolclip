/**
 * Token estimation.
 *
 * Estimates come from the `tokenx` library — a zero-dependency, 2kB
 * heuristic estimator calibrated against OpenAI's `o200k_base` tokenizer.
 * A static estimator is a deliberate choice over a runtime-calibrated
 * chars/N divisor: the counts only drive gating decisions (pending markers,
 * quarantine) and the size shown in marker text, so a consistent ~±10%
 * estimate beats a feedback loop that must pair "what we counted" with
 * "what the provider reports" — a pairing that cannot cover the real
 * prompt composition (tool-call arguments, per-message serialization
 * overhead, provider cache quantization) and therefore drifts with session
 * shape. Measured against reported prompt-token deltas on real sessions,
 * tokenx tracks the model within ~6% mean error for tool-result-sized
 * content, where chars/4 was off by ~10% and the calibrated divisor kept
 * sliding (to ~35 before the total-token fix, then to ~3.4 after it).
 *
 * Known limitation inherited from tokenx: high-entropy text (base64,
 * hashes) is underestimated by ~70%. Toolclip already accounts for image
 * blocks separately (description + fixed base64 overhead), and text results
 * dominated by base64 are rare — the threshold margins absorb the rest.
 */

import { estimateTokenCount } from "tokenx";

/**
 * Estimate the token count of a single text string.
 *
 * @param text - The text to estimate. Empty or undefined yields 0.
 */
export function estimateTokens(text: string): number {
	if (!text) {
		return 0;
	}
	return estimateTokenCount(text);
}