import { describe, expect, it } from "vitest";
import { validateReplacement, type LengthGateFail } from "../lib/length-gate.ts";

describe("validateReplacement", () => {
	// ─── Hard fail ────────────────────────────────────────────

	it("hard-fails when replacement equals original", () => {
		const r = validateReplacement(50, 50, 0.1);
		expect(r).toEqual({
			ok: false,
			reason:
				"replacement must be strictly shorter than the original " +
				"(replacement is 50 tokens; original is 50 tokens)",
		});
	});

	it("hard-fails when replacement exceeds original", () => {
		const r = validateReplacement(50, 100, 0.1);
		expect(r).toEqual({
			ok: false,
			reason:
				"replacement must be strictly shorter than the original " +
				"(replacement is 100 tokens; original is 50 tokens)",
		});
	});

	// ─── Soft fail ────────────────────────────────────────────

	it("soft-fails when 50→49 at ratio 0.1", () => {
		const r = validateReplacement(50, 49, 0.1);
		expect(r).toEqual({
			ok: false,
			reason:
				"replacement exceeds the maximum allowed fraction of the original " +
				"(replacement is 49 tokens; original is 50 tokens; " +
				"ratio 0.98 exceeds max 0.1)",
		});
	});

	it("soft-fails when 100→11 at ratio 0.1", () => {
		const r = validateReplacement(100, 11, 0.1);
		expect(r).toEqual({
			ok: false,
			reason:
				"replacement exceeds the maximum allowed fraction of the original " +
				"(replacement is 11 tokens; original is 100 tokens; " +
				"ratio 0.11 exceeds max 0.1)",
		});
	});

	// ─── Pass ────────────────────────────────────────────────

	it("passes when 100→5 at ratio 0.1", () => {
		expect(validateReplacement(100, 5, 0.1)).toEqual({ ok: true });
	});

	it("passes when 100→11 at ratio 0.2", () => {
		expect(validateReplacement(100, 11, 0.2)).toEqual({ ok: true });
	});

	it("passes when replacement is at the exact soft limit", () => {
		// 50 * 0.1 = 5; 5 ≤ 5 passes
		expect(validateReplacement(50, 5, 0.1)).toEqual({ ok: true });
	});

	// ─── Edge cases ──────────────────────────────────────────

	it("hard-fails when original is 0 and replacement is non-zero", () => {
		const r = validateReplacement(0, 10, 0.1);
		expect(r).toEqual({
			ok: false,
			reason:
				"replacement must be strictly shorter than the original " +
				"(replacement is 10 tokens; original is 0 tokens)",
		});
	});

	it("passes when original > 0 and replacement is 0", () => {
		expect(validateReplacement(100, 0, 0.1)).toEqual({ ok: true });
	});

	it("hard-fails when both are 0 (not strictly shorter)", () => {
		const r = validateReplacement(0, 0, 0.1);
		expect(r.ok).toBe(false);
		expect((r as LengthGateFail).reason).toContain("replacement must be strictly shorter");
	});

	it("fails soft when ratio is 0", () => {
		// 1 < 100 → hard pass; 1 > 100*0 → soft fail
		const r = validateReplacement(100, 1, 0);
		expect(r).toEqual({
			ok: false,
			reason:
				"replacement exceeds the maximum allowed fraction of the original " +
				"(replacement is 1 tokens; original is 100 tokens; " +
				"ratio 0.01 exceeds max 0)",
		});
	});

	it("passes with ratio 1.0 up to original - 1", () => {
		expect(validateReplacement(100, 99, 1.0)).toEqual({ ok: true });
	});
});