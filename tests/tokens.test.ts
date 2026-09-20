import { describe, expect, it } from "vitest";
import { estimateTokenCount } from "tokenx";
import { estimateTokens } from "../lib/tokens.ts";

describe("estimateTokens", () => {
	it("delegates to tokenx and returns 0 for empty input", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("hello world")).toBe(estimateTokenCount("hello world"));
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