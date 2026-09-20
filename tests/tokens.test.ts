import { describe, expect, it } from "vitest";
import {
	estimateMessagesTokens,
	estimateTokens,
	countMessagesChars,
	createCalibrator,
	setSnapshotChars,
	setOverheadChars,
	observeTokens,
	getDivisor,
	DEFAULT_DIVISOR,
	MAX_CALIBRATED_DIVISOR,
	MIN_CALIBRATED_DIVISOR,
} from "../lib/tokens.ts";

describe("estimateTokens", () => {
	it("uses the four-characters-per-token heuristic", () => {
		expect(estimateTokens("1234")).toBe(1);
		expect(estimateTokens("12345")).toBe(2);
	});

	it("returns 0 for an empty string", () => {
		expect(estimateTokens("")).toBe(0);
	});

	it("honors a custom divisor", () => {
		expect(estimateTokens("1234", 2)).toBe(2);
		expect(estimateTokens("123456", 3)).toBe(2);
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

	it("honors a custom divisor", () => {
		const messages = [{ role: "user", content: "1234" }];
		expect(estimateMessagesTokens(messages, 2)).toBe(2);
	});
});

describe("countMessagesChars", () => {
	it("sums raw text length across string and block content", () => {
		const messages = [
			{ role: "user", content: "1234" },
			{ role: "assistant", content: [{ type: "text", text: "12345678" }, "1234"] },
		];

		// 4 + 8 + 4 = 16 chars.
		expect(countMessagesChars(messages)).toBe(16);
	});

	it("counts any block carrying a text field (mirrors estimateMessagesTokens)", () => {
		// The estimator counts `block.text` for any content block that has it,
		// matching how estimateMessagesTokens treats the same blocks, so the
		// raw char count stays consistent with the token estimate.
		const messages = [
			{ role: "user", content: [{ type: "image", text: "ignored-meta" }, { type: "text", text: "abc" }] },
		];
		// "ignored-meta" (12) + "abc" (3) = 15.
		expect(countMessagesChars(messages)).toBe(15);
	});
});

describe("createCalibrator", () => {
	it("starts at the default divisor with no snapshot", () => {
		const cal = createCalibrator();
		expect(cal.divisor).toBe(DEFAULT_DIVISOR);
		expect(cal.latestChars).toBeNull();
		expect(cal.sampleCount).toBe(0);
		expect(getDivisor(cal)).toBe(DEFAULT_DIVISOR);
	});

	it("honors a custom initial divisor", () => {
		const cal = createCalibrator(3);
		expect(cal.divisor).toBe(3);
	});

	it("starts with zero overhead chars", () => {
		const cal = createCalibrator();
		expect(cal.overheadChars).toBe(0);
	});
});

describe("setOverheadChars", () => {
	it("records the constant prompt part (system prompt + tool defs)", () => {
		const cal = createCalibrator(4);
		setOverheadChars(cal, 6000);
		expect(cal.overheadChars).toBe(6000);
		// Numerator = 4000 message chars + 6000 overhead = 10000; against
		// 1000 tokens the observed divisor is 10 → clamped at MAX.
		expect(observeTokens(cal, 4000, 1000)).toBe(MAX_CALIBRATED_DIVISOR);
	});

	it("ignores non-finite or negative overhead", () => {
		const cal = createCalibrator(4);
		setOverheadChars(cal, Number.NaN);
		expect(cal.overheadChars).toBe(0);
		setOverheadChars(cal, -5);
		expect(cal.overheadChars).toBe(0);
		setOverheadChars(cal, 2000);
		expect(cal.overheadChars).toBe(2000);
	});
});

describe("observeTokens", () => {
	it("blends observed chars-per-token ratio toward the true divisor", () => {
		const cal = createCalibrator(4);
		// First sample: 4000 chars for 1000 actual tokens → true divisor 4.
		// EMA alpha = 1/(0+1) = 1 → divisor becomes exactly 4.
		expect(observeTokens(cal, 4000, 1000)).toBeCloseTo(4, 10);

		// Second sample: 4000 chars for 2000 actual tokens → observed 2.
		// alpha = 1/(1+1) = 0.5 → divisor = 4*0.5 + 2*0.5 = 3.
		expect(observeTokens(cal, 4000, 2000)).toBeCloseTo(3, 10);
		expect(cal.sampleCount).toBe(2);
	});

	it("converges toward the true divisor over repeated samples", () => {
		const cal = createCalibrator(4);
		// True chars-per-token is 2 across many turns.
		for (let i = 0; i < 60; i++) {
			observeTokens(cal, 2000, 1000);
		}
		// Converges close to 2 (EMA keeps a small offset from the alpha floor).
		expect(cal.divisor).toBeLessThan(2.15);
		expect(cal.divisor).toBeGreaterThan(1.9);
	});

	it("skips degenerate samples (zero / non-finite char or token counts)", () => {
		const cal = createCalibrator(4);
		expect(observeTokens(cal, 0, 1000)).toBe(4);
		expect(observeTokens(cal, 4000, 0)).toBe(4);
		expect(observeTokens(cal, Number.NaN, 1000)).toBe(4);
		expect(observeTokens(cal, 4000, Number.NaN)).toBe(4);
		expect(cal.sampleCount).toBe(0);
	});

	it("counts chars + overhead in the numerator", () => {
		const cal = createCalibrator(4);
		setOverheadChars(cal, 4000);
		// (4000 messages + 4000 overhead) / 2000 tokens → observed 4, matching
		// the current divisor → blend is a no-op at alpha = 1.
		expect(observeTokens(cal, 4000, 2000)).toBeCloseTo(4, 10);
	});
});

describe("divisor clamp", () => {
	it("clamps a scope-mismatched low sample at MIN (the golden-sample 0.4 failure)", () => {
		const cal = createCalibrator(4);
		// The golden-sample failure: 957 message chars paired with 2393
		// prompt tokens (system + tools included) → observed ~0.4, which the
		// old code latched for the whole session (10x overestimates, a
		// false-positive quarantine). The clamp now holds the divisor at 2.
		expect(observeTokens(cal, 957, 2393)).toBe(MIN_CALIBRATED_DIVISOR);
		expect(getDivisor(cal)).toBe(MIN_CALIBRATED_DIVISOR);
	});

	it("clamps a runaway high sample at MAX", () => {
		const cal = createCalibrator(4);
		// The other golden-sample failure mode: full-history chars paired
		// with non-cached-only tokens → observed ratios of 10–75.
		expect(observeTokens(cal, 40000, 1000)).toBe(MAX_CALIBRATED_DIVISOR);
		expect(getDivisor(cal)).toBe(MAX_CALIBRATED_DIVISOR);
	});

	it("recovers from a clamped sample as good samples arrive", () => {
		const cal = createCalibrator(4);
		observeTokens(cal, 957, 2393); // poisoned → clamped to 2
		// True divisor 4: first good sample alpha = 1/2 → 2*0.5 + 4*0.5 = 3.
		expect(observeTokens(cal, 4000, 1000)).toBeCloseTo(3, 10);
	});

	it("keeps in-range samples untouched", () => {
		const cal = createCalibrator(4);
		expect(observeTokens(cal, 4000, 1000)).toBeCloseTo(4, 10);
	});
});

describe("setSnapshotChars", () => {
	it("records the latest context snapshot for the next message_end", () => {
		const cal = createCalibrator();
		setSnapshotChars(cal, 4000);
		expect(cal.latestChars).toBe(4000);
	});
});