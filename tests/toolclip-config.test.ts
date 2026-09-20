import { describe, expect, it } from "vitest";
import { loadToolclipConfig } from "../lib/toolclip-config.ts";

describe("loadToolclipConfig", () => {
	it("returns the tool result threshold of 1000 by default", () => {
		expect(loadToolclipConfig({} as NodeJS.ProcessEnv)).toEqual({
			toolResultThresholdTokens: 1000,
			steeringReminder: true,
			steeringReminderMultiple: 5,
			quarantine: true,
			quarantineThresholdTokens: 10000,
		});
	});

	it("disables the steering reminder via TOOLCLIP_STEERING_REMINDER=false", () => {
		const config = loadToolclipConfig({
			TOOLCLIP_STEERING_REMINDER: "false",
		} as NodeJS.ProcessEnv);

		expect(config.steeringReminder).toBe(false);
		expect(config.steeringReminderMultiple).toBe(5);
	});

	it("enables the steering reminder via TOOLCLIP_STEERING_REMINDER=1", () => {
		const config = loadToolclipConfig({
			TOOLCLIP_STEERING_REMINDER: "1",
		} as NodeJS.ProcessEnv);

		expect(config.steeringReminder).toBe(true);
	});

	it("overrides the band size via TOOLCLIP_STEERING_REMINDER_MULTIPLE", () => {
		const config = loadToolclipConfig({
			TOOLCLIP_STEERING_REMINDER_MULTIPLE: "10",
		} as NodeJS.ProcessEnv);

		expect(config.steeringReminderMultiple).toBe(10);
	});

	it("falls back to default band size for non-positive or non-integer values", () => {
		for (const bad of ["0", "-1", "2.5", "abc", ""]) {
			const config = loadToolclipConfig({
				TOOLCLIP_STEERING_REMINDER_MULTIPLE: bad,
			} as NodeJS.ProcessEnv);
			expect(config.steeringReminderMultiple).toBe(5);
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
			steeringReminderMultiple: 5,
			quarantine: true,
			quarantineThresholdTokens: 10000,
		});
	});
});
