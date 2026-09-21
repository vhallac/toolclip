import { describe, expect, it } from "vitest";
import { loadToolclipConfig } from "../lib/toolclip-config.ts";

describe("loadToolclipConfig", () => {
	it("returns the tool result threshold of 1000 by default", () => {
		expect(loadToolclipConfig({} as NodeJS.ProcessEnv)).toEqual({
			toolResultThresholdTokens: 1000,
			steeringReminder: true,
			steeringFirstRungTokens: 5000,
			quarantine: true,
			quarantineThresholdTokens: 10000,
			expiry: true,
			expiryRho: 0.2,
			expiryWriteRatio: 1.0,
			expiryReplacementTokens: 170,
			expiryReplacementCopies: 1,
			expiryOverheadTokens: 95,
			expiryHorizonMinTurns: 10,
			expiryHorizonMaxTurns: 100,
			expiryAnnounce: true,
			replacementMode: "pointer",
			pointerIncludeCallId: true,
			receiptPrefix: "rp",
			receiptTagLength: 3,
			emptyReplacementText: "tool result was not useful",
		});
	});

	it("disables the steering reminder via TOOLCLIP_STEERING_REMINDER=false", () => {
		const config = loadToolclipConfig({
			TOOLCLIP_STEERING_REMINDER: "false",
		} as NodeJS.ProcessEnv);

		expect(config.steeringReminder).toBe(false);
		expect(config.steeringFirstRungTokens).toBe(5000);
	});

	it("enables the steering reminder via TOOLCLIP_STEERING_REMINDER=1", () => {
		const config = loadToolclipConfig({
			TOOLCLIP_STEERING_REMINDER: "1",
		} as NodeJS.ProcessEnv);

		expect(config.steeringReminder).toBe(true);
	});

	it("ignores the removed count trigger env var (config field is gone)", () => {
		const config = loadToolclipConfig({
			TOOLCLIP_STEERING_COUNT_THRESHOLD: "10",
		} as NodeJS.ProcessEnv);
		expect("steeringCountThreshold" in config).toBe(false);
	});

	it("overrides the ladder's first rung via TOOLCLIP_STEERING_SIZE_THRESHOLD_TOKENS", () => {
		const config = loadToolclipConfig({
			TOOLCLIP_STEERING_SIZE_THRESHOLD_TOKENS: "8000",
		} as NodeJS.ProcessEnv);

		expect(config.steeringFirstRungTokens).toBe(8000);
	});

	it("falls back to the default first rung for non-positive or non-integer values", () => {
		for (const bad of ["0", "-1", "2.5", "abc", ""]) {
			const config = loadToolclipConfig({
				TOOLCLIP_STEERING_SIZE_THRESHOLD_TOKENS: bad,
			} as NodeJS.ProcessEnv);
			expect(config.steeringFirstRungTokens).toBe(5000);
		}
	});

	it("overrides the tool result threshold via TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS", () => {
		const config = loadToolclipConfig({
			TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS: "250",
		} as NodeJS.ProcessEnv);

		expect(config.toolResultThresholdTokens).toBe(250);
	});

	it("falls back to default tool result threshold for non-positive or non-integer values", () => {
		for (const bad of ["0", "-1", "2.5", "abc", ""]) {
			const config = loadToolclipConfig({
				TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS: bad,
			} as NodeJS.ProcessEnv);
			expect(config.toolResultThresholdTokens).toBe(1000);
		}
	});

	it("ignores the legacy max-replacement-ratio env var (gate stays removed)", () => {
		// The max-replacement-ratio gate was removed for observation and stays
		// removed; its env var is not surfaced in config.
		const config = loadToolclipConfig({
			TOOLCLIP_MAX_REPLACEMENT_RATIO: "0.25",
		} as NodeJS.ProcessEnv);

		expect(config).toEqual({
			toolResultThresholdTokens: 1000,
			steeringReminder: true,
			steeringFirstRungTokens: 5000,
			quarantine: true,
			quarantineThresholdTokens: 10000,
			expiry: true,
			expiryRho: 0.2,
			expiryWriteRatio: 1.0,
			expiryReplacementTokens: 170,
			expiryReplacementCopies: 1,
			expiryOverheadTokens: 95,
			expiryHorizonMinTurns: 10,
			expiryHorizonMaxTurns: 100,
			expiryAnnounce: true,
			replacementMode: "pointer",
			pointerIncludeCallId: true,
			receiptPrefix: "rp",
			receiptTagLength: 3,
			emptyReplacementText: "tool result was not useful",
		});
	});

	it("overrides the expiry priors and knobs via env", () => {
		const config = loadToolclipConfig({
			TOOLCLIP_EXPIRY_RHO: "0.1",
			TOOLCLIP_EXPIRY_WRITE_RATIO: "1.25",
			TOOLCLIP_EXPIRY_REPLACEMENT_TOKENS: "300",
			TOOLCLIP_EXPIRY_REPLACEMENT_COPIES: "1",
			TOOLCLIP_EXPIRY_OVERHEAD_TOKENS: "80",
			TOOLCLIP_EXPIRY_HORIZON_MIN_TURNS: "5",
			TOOLCLIP_EXPIRY_HORIZON_MAX_TURNS: "50",
		} as NodeJS.ProcessEnv);

		expect(config.expiryRho).toBe(0.1);
		expect(config.expiryWriteRatio).toBe(1.25);
		expect(config.expiryReplacementTokens).toBe(300);
		expect(config.expiryReplacementCopies).toBe(1);
		expect(config.expiryOverheadTokens).toBe(80);
		expect(config.expiryHorizonMinTurns).toBe(5);
		expect(config.expiryHorizonMaxTurns).toBe(50);
	});

	it("falls back to the expiry priors for negative or non-numeric values", () => {
		const config = loadToolclipConfig({
			TOOLCLIP_EXPIRY_RHO: "-0.5",
			TOOLCLIP_EXPIRY_WRITE_RATIO: "abc",
		} as NodeJS.ProcessEnv);
		expect(config.expiryRho).toBe(0.2);
		expect(config.expiryWriteRatio).toBe(1.0);
	});

	it("falls back to the expiry knobs for non-positive or non-integer values", () => {
		const config = loadToolclipConfig({
			TOOLCLIP_EXPIRY_REPLACEMENT_TOKENS: "0",
			TOOLCLIP_EXPIRY_REPLACEMENT_COPIES: "2.5",
			TOOLCLIP_EXPIRY_OVERHEAD_TOKENS: "-60",
			TOOLCLIP_EXPIRY_HORIZON_MIN_TURNS: "x",
			TOOLCLIP_EXPIRY_HORIZON_MAX_TURNS: "",
		} as NodeJS.ProcessEnv);
		expect(config.expiryReplacementTokens).toBe(170);
		// Pointer mode (the default) shifts the COPIES/OVERHEAD fallbacks.
		expect(config.expiryReplacementCopies).toBe(1);
		expect(config.expiryOverheadTokens).toBe(95);
		expect(config.expiryHorizonMinTurns).toBe(10);
		expect(config.expiryHorizonMaxTurns).toBe(100);
	});

	it("disables expiry via TOOLCLIP_EXPIRY=false (ladder-only)", () => {
		const config = loadToolclipConfig({ TOOLCLIP_EXPIRY: "false" } as NodeJS.ProcessEnv);
		expect(config.expiry).toBe(false);
		expect(config.expiryAnnounce).toBe(true); // independent switch
	});

	it("disables the expired-ids announce via TOOLCLIP_EXPIRY_ANNOUNCE=false", () => {
		const config = loadToolclipConfig({ TOOLCLIP_EXPIRY_ANNOUNCE: "false" } as NodeJS.ProcessEnv);
		expect(config.expiryAnnounce).toBe(false);
	});

	it("honors TOOLCLIP_EMPTY_REPLACEMENT_TEXT, defaulting to the useless-result placeholder", () => {
		expect(loadToolclipConfig({} as NodeJS.ProcessEnv).emptyReplacementText).toBe(
			"tool result was not useful",
		);
		const custom = loadToolclipConfig({
			TOOLCLIP_EMPTY_REPLACEMENT_TEXT: "checked, found nothing",
		} as NodeJS.ProcessEnv);
		expect(custom.emptyReplacementText).toBe("checked, found nothing");
		// An explicit empty string is honored (the stored placeholder may
		// itself be empty; the pending check is against undefined).
		const blank = loadToolclipConfig({
			TOOLCLIP_EMPTY_REPLACEMENT_TEXT: "",
		} as NodeJS.ProcessEnv);
		expect(blank.emptyReplacementText).toBe("");
	});
});
