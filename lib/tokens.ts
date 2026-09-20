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
 * Space-free counterweight: tokenx inherits o200k's human-text priors and
 * prices dense machine text far too low — a base64 blob bills at ~1.5
 * chars/token while tokenx prices it at ~7 chars/token. The 2026-09-20
 * golden run's 43.7k-char base64 `head` result was estimated at 6,260
 * tokens and billed at ~29,700 — a 4.7x underestimate that slipped under
 * the 10k quarantine threshold and rode the context, un-replaced, to the
 * end of the session. The counterweight is a space-density heuristic —
 * cheaper and more robust than entropy measurement: in normal prose and
 * code, whitespace recurs every few characters, while base64, hex dumps,
 * minified code, and long URLs run on for hundreds of characters without a
 * single space. Every maximal run of >= 20 non-whitespace characters is
 * re-priced: its first 20 characters keep the tokenx price, and every
 * character beyond that adds 0.5 tokens (2 chars/token) on top of tokenx's
 * own estimate. That lands the golden run's blob at ~28k estimated tokens
 * (billed: ~29.7k) — well over the quarantine threshold — while spaced
 * text is priced exactly as tokenx priced it. The 2 chars/token rate is
 * deliberately conservative for every dense-text class we expect (base64
 * ~1.5, hex ~2–4, minified code ~2.5–3): overestimating is the safe
 * direction, because the failure it causes (an unnecessary quarantine) is
 * cheap, and the failure it prevents (an un-quarantined blob) is the
 * expensive one.
 */

import { estimateTokenCount } from "tokenx";

/**
 * A run shorter than this is priced normally: identifiers and short
 * space-free tokens are ubiquitous in code and are not a density signal.
 */
const NO_SPACE_RUN_MIN = 20;

/**
 * Chars per token for the space-free excess of a long run. See the module
 * doc: 2 keeps every dense-text class at or above its real billed cost.
 */
const NO_SPACE_CHARS_PER_TOKEN = 2;

/** Matches maximal (greedy) runs of non-whitespace characters. */
const NO_SPACE_RUN_RE = /\S{20,}/g;

/**
 * Extra tokens owed by space-free runs: for each maximal run of at least
 * `NO_SPACE_RUN_MIN` non-whitespace characters, ceil((len - min) / rate).
 */
function noSpaceExtraTokens(text: string): number {
	let extra = 0;
	for (const match of text.matchAll(NO_SPACE_RUN_RE)) {
		extra += Math.ceil((match[0].length - NO_SPACE_RUN_MIN) / NO_SPACE_CHARS_PER_TOKEN);
	}
	return extra;
}

/**
 * Estimate the token count of a single text string.
 *
 * tokenx estimate plus the space-free counterweight (see module doc).
 *
 * @param text - The text to estimate. Empty or undefined yields 0.
 */
export function estimateTokens(text: string): number {
	if (!text) {
		return 0;
	}
	return estimateTokenCount(text) + noSpaceExtraTokens(text);
}