import { describe, expect, it } from "vitest";
import { estimateMessagesTokens, estimateTokens } from "../lib/tokens.ts";

describe("estimateTokens", () => {
	it("uses the four-characters-per-token heuristic", () => {
		expect(estimateTokens("1234")).toBe(1);
		expect(estimateTokens("12345")).toBe(2);
	});
});

describe("estimateMessagesTokens", () => {
	it("counts string and block content", () => {
		const messages = [
			{ role: "user", content: "1234" },
			{ role: "assistant", content: [{ type: "text", text: "12345678" }, "1234"] },
		];

		expect(estimateMessagesTokens(messages)).toBe(4);
	});
});