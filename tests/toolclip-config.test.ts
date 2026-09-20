import { describe, expect, it } from "vitest";
import { loadToolclipConfig } from "../lib/toolclip-config.ts";

describe("loadToolclipConfig", () => {
	it("returns the steering reminder enabled by default with turn threshold 3", () => {
		expect(loadToolclipConfig({} as NodeJS.ProcessEnv)).toEqual({
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

	it("ignores legacy size-threshold env vars", () => {
		// Size thresholds were removed so replacement behavior can be observed
		// without pre-filtering or gating. Legacy env vars are ignored.
		const config = loadToolclipConfig({
			TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS: "500",
			TOOLCLIP_MAX_REPLACEMENT_RATIO: "0.25",
		} as NodeJS.ProcessEnv);

		expect(config).toEqual({
			steeringReminder: true,
			steeringReminderTurn: 3,
		});
	});
});
