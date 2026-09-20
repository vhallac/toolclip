import { describe, expect, it } from "vitest";
import { estimateTokenCount } from "tokenx";
import { estimateTokens } from "../lib/tokens.ts";

/**
 * Deterministic pseudo-base64: scatters a 64-char alphabet without any
 * whitespace, mirroring the golden run's 43,664-char embedding blob
 * (billed at ~29,700 tokens; tokenx alone estimated 6,260).
 */
function pseudoBase64(length: number): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let out = "";
	for (let i = 0; i < length; i++) {
		out += alphabet[(i * 7 + ((i / alphabet.length) | 0) * 13) % alphabet.length];
	}
	return out;
}

describe("estimateTokens", () => {
	it("delegates to tokenx and returns 0 for empty input", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("hello world")).toBe(estimateTokenCount("hello world"));
	});

	it("prices spaced text exactly as tokenx does (no space-free runs)", () => {
		const spaced = "the quick brown fox jumps over the lazy dog. ".repeat(200);
		expect(estimateTokens(spaced)).toBe(estimateTokenCount(spaced));
	});

	it("prices code-like text with short identifiers exactly as tokenx does", () => {
		// Longest space-free run here is "'./bar.ts';" (11 chars) — below
		// the 20-char run minimum, so no counterweight applies.
		const code = "import { foo } from './bar.ts';\n".repeat(200);
		expect(estimateTokens(code)).toBe(estimateTokenCount(code));
	});

	it("prices a space-free run of exactly 20 characters as tokenx does", () => {
		const text = `${"a".repeat(20)} end`;
		expect(estimateTokens(text)).toBe(estimateTokenCount(text));
	});

	it("re-prices the excess of long space-free runs at 2 chars/token", () => {
		// 39-char run: excess = ceil(19 / 2) = 10 extra tokens.
		const text = `${"a".repeat(39)} rest of the line`;
		expect(estimateTokens(text)).toBe(estimateTokenCount(text) + 10);
		// 21-char run: excess = ceil(1 / 2) = 1 extra token.
		const small = `${"a".repeat(21)} rest`;
		expect(estimateTokens(small)).toBe(estimateTokenCount(small) + 1);
	});

	it("counts each maximal run separately, bounded by whitespace", () => {
		// Two 40-char runs on separate lines: excess = ceil(20/2) each.
		const two = `${"a".repeat(40)}\n${"b".repeat(40)}`;
		expect(estimateTokens(two)).toBe(estimateTokenCount(two) + 20);
	});

	it("crosses the 10k quarantine threshold for a golden-run-shaped base64 blob", () => {
		// The 2026-09-20 regression: a 43,664-char base64 head result was
		// estimated at 6,260 tokens by tokenx alone, billed at ~29,700, and
		// never quarantined. The counterweight must push the estimate well
		// past the quarantine threshold.
		const blob = pseudoBase64(43664);
		const raw = estimateTokenCount(blob);
		const withCounterweight = estimateTokens(blob);
		expect(withCounterweight).toBeGreaterThan(20000);
		// The counterweight must at least double the tokenx price for dense
		// space-free text.
		expect(withCounterweight).toBeGreaterThan(raw * 2);
		// And it must stay sane: no more than ~1.4 chars/token (real billing
		// for base64 is ~1.47 — the estimate must not overshoot far past it).
		expect(withCounterweight).toBeLessThan(blob.length / 1.4);
	});

	it("keeps dense space-free text in a conservative chars-per-token band", () => {
		// 10k-char hex dump: real billing for hex is ~2-4 chars/token; the
		// estimate must sit at or below that band (conservative direction).
		const hex = pseudoBase64(10000).replace(/[g-z+/]/g, "f");
		const tokens = estimateTokens(hex);
		expect(tokens).toBeGreaterThan(hex.length / 2.5);
		expect(tokens).toBeLessThan(hex.length / 1.5);
	});

	it("grows monotonically with length", () => {
		const short = estimateTokens("const x = 1;");
		const long = estimateTokens(`${"const x = 1;\n".repeat(100)}`);
		expect(long).toBeGreaterThan(short);
	});

	it("stays in a sane chars-per-token band for code-like text", () => {
		// Real sessions showed tokenx within ~±10% of the model for
		// tool-result-sized content. Pin a loose band: 2–8 chars/token.
		const text = "import { foo } from './bar.ts';\n".repeat(200); // 6400 chars
		const tokens = estimateTokens(text);
		expect(tokens).toBeGreaterThan(text.length / 8);
		expect(tokens).toBeLessThan(text.length / 2);
	});
});