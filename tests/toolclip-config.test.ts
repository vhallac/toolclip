import { describe, expect, it } from "vitest";
import { loadToolclipConfig } from "../lib/toolclip-config.ts";

describe("loadToolclipConfig", () => {
	it("returns the tool result threshold of 1000 by default", () => {
		expect(loadToolclipConfig({} as NodeJS.ProcessEnv)).toEqual({
			toolResultThresholdTokens: 1000,
			steeringReminder: true,
			steeringReminderTurn: 3,
		});
	});

	it("disables the steering reminder via TOOLCLIP_STEERING_REMINDER=false", () => {
		const config = loadToolclipConfig({
			TOOLCLIP_STEERING_REMINDER: "false",
		} as NodeJS.ProcessEnv);

		expect(config.steeringReminder).toBe(false);
		expect(config.steeringReminderTurn).toBe(3);
	});

	it("enables the steering reminder via TOOLCLIP_STEERING_REMINDER=1", () => {
		const config = loadToolclipConfig({
			TOOLCLIP_STEERING_REMINDER: "1",
		} as NodeJS.ProcessEnv);

		expect(config.steeringReminder).toBe(true);
	});

	it("overrides the turn threshold via TOOLCLIP_STEERING_REMINDER_TURN", () => {
		const config = loadToolclipConfig({
			TOOLCLIP_STEERING_REMINDER_TURN: "5",
		} as NodeJS.ProcessEnv);

		expect(config.steeringReminderTurn).toBe(5);
	});

	it("falls back to default turn threshold for non-positive or non-integer values", () => {
		for (const bad of ["0", "-1", "2.5", "abc", ""]) {
			const config = loadToolclipConfig({
				TOOLCLIP_STEERING_REMINDER_TURN: bad,
			} as NodeJS.ProcessEnv);
			expect(config.steeringReminderTurn).toBe(3);
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
			steeringReminderTurn: 3,
		});
	});
});
