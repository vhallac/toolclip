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
		});
	});
});
