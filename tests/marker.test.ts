import { describe, expect, it } from "vitest";
import {
	buildPendingMarker,
	buildReplacedMarker,
	parsePendingMarker,
} from "../lib/marker.js";

describe("buildPendingMarker", () => {
	it("formats the canonical pending marker", () => {
		expect(buildPendingMarker("abc-123", 512)).toBe(
			"[tool-result-pending-replacement: toolCallId=abc-123, tokens=512]",
		);
	});

	it("handles zero tokens", () => {
		expect(buildPendingMarker("id", 0)).toBe(
			"[tool-result-pending-replacement: toolCallId=id, tokens=0]",
		);
	});

	it("handles large token counts", () => {
		expect(buildPendingMarker("x", 999_999)).toContain("tokens=999999");
	});
});

describe("buildReplacedMarker", () => {
	it("formats the canonical replaced marker", () => {
		expect(buildReplacedMarker("abc-123")).toBe(
			"[tool-result-replaced: toolCallId=abc-123]",
		);
	});

	it("does not include a token count", () => {
		expect(buildReplacedMarker("id")).not.toContain("tokens=");
	});
});

describe("parsePendingMarker", () => {
	it("round-trips a freshly built marker", () => {
		const m = buildPendingMarker("abc", 42);
		expect(parsePendingMarker(m)).toEqual({ toolCallId: "abc", tokens: 42 });
	});

	it("finds the marker at the end of a longer text block", () => {
		const m = buildPendingMarker("id-1", 333);
		const text = `some long payload\n\n${m}`;
		expect(parsePendingMarker(text)).toEqual({ toolCallId: "id-1", tokens: 333 });
	});

	it("finds the marker in the middle of a text block", () => {
		const m = buildPendingMarker("id-2", 7);
		const text = `before ${m} after`;
		expect(parsePendingMarker(text)).toEqual({ toolCallId: "id-2", tokens: 7 });
	});

	it("returns the first marker when there are several", () => {
		const a = buildPendingMarker("first", 1);
		const b = buildPendingMarker("second", 2);
		expect(parsePendingMarker(`${a}\n${b}`)).toEqual({
			toolCallId: "first",
			tokens: 1,
		});
	});

	it("returns null when there is no marker", () => {
		expect(parsePendingMarker("just a regular tool result")).toBeNull();
		expect(parsePendingMarker("")).toBeNull();
	});

	it("returns null for malformed markers", () => {
		// missing closing bracket
		expect(
			parsePendingMarker("[tool-result-pending-replacement: toolCallId=x, tokens=10"),
		).toBeNull();
		// wrong key order
		expect(parsePendingMarker("[tool-result-pending-replacement: tokens=10, toolCallId=x]")).toBeNull();
		// non-numeric tokens
		expect(parsePendingMarker("[tool-result-pending-replacement: toolCallId=x, tokens=abc]")).toBeNull();
		// empty id
		expect(parsePendingMarker("[tool-result-pending-replacement: toolCallId=, tokens=10]")).toBeNull();
		// negative tokens
		expect(parsePendingMarker("[tool-result-pending-replacement: toolCallId=x, tokens=-1]")).toBeNull();
		// float tokens
		expect(parsePendingMarker("[tool-result-pending-replacement: toolCallId=x, tokens=1.5]")).toBeNull();
	});

	it("does not mistake a replaced marker for a pending marker", () => {
		const r = buildReplacedMarker("id");
		expect(parsePendingMarker(r)).toBeNull();
	});

	it("ignores a non-string input", () => {
		// @ts-expect-error — runtime check
		expect(parsePendingMarker(undefined)).toBeNull();
		// @ts-expect-error — runtime check
		expect(parsePendingMarker(null)).toBeNull();
	});
});