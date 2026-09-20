import { describe, expect, it } from "vitest";
import { loadToolclipConfig } from "../lib/toolclip-config.ts";

describe("loadToolclipConfig", () => {
	it("returns defaults when env is empty", () => {
		expect(loadToolclipConfig({} as NodeJS.ProcessEnv)).toEqual({
			thresholdTokens: 250,
			maxReplacementRatio: 0.1,
		});
	});

	it("reads overrides from env", () => {
		const config = loadToolclipConfig({
			TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS: "500",
			TOOLCLIP_MAX_REPLACEMENT_RATIO: "0.25",
		} as NodeJS.ProcessEnv);

		expect(config).toEqual({
			thresholdTokens: 500,
			maxReplacementRatio: 0.25,
		});
	});

	it("truncates fractional thresholds", () => {
		const config = loadToolclipConfig({
			TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS: "500.9",
		} as NodeJS.ProcessEnv);

		expect(config.thresholdTokens).toBe(500);
	});

	it("falls back when threshold is non-positive", () => {
		const zero = loadToolclipConfig({ TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS: "0" } as NodeJS.ProcessEnv);
		const neg = loadToolclipConfig({ TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS: "-5" } as NodeJS.ProcessEnv);
		const garbage = loadToolclipConfig({ TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS: "abc" } as NodeJS.ProcessEnv);
		const empty = loadToolclipConfig({ TOOLCLIP_TOOL_RESULT_THRESHOLD_TOKENS: "  " } as NodeJS.ProcessEnv);

		expect(zero.thresholdTokens).toBe(250);
		expect(neg.thresholdTokens).toBe(250);
		expect(garbage.thresholdTokens).toBe(250);
		expect(empty.thresholdTokens).toBe(250);
	});

	it("clamps ratio to (0, 1]", () => {
		const zero = loadToolclipConfig({ TOOLCLIP_MAX_REPLACEMENT_RATIO: "0" } as NodeJS.ProcessEnv);
		const neg = loadToolclipConfig({ TOOLCLIP_MAX_REPLACEMENT_RATIO: "-0.5" } as NodeJS.ProcessEnv);
		const tooBig = loadToolclipConfig({ TOOLCLIP_MAX_REPLACEMENT_RATIO: "1.5" } as NodeJS.ProcessEnv);
		const garbage = loadToolclipConfig({ TOOLCLIP_MAX_REPLACEMENT_RATIO: "abc" } as NodeJS.ProcessEnv);
		const one = loadToolclipConfig({ TOOLCLIP_MAX_REPLACEMENT_RATIO: "1" } as NodeJS.ProcessEnv);

		expect(zero.maxReplacementRatio).toBe(0.1);
		expect(neg.maxReplacementRatio).toBe(0.1);
		expect(tooBig.maxReplacementRatio).toBe(0.1);
		expect(garbage.maxReplacementRatio).toBe(0.1);
		expect(one.maxReplacementRatio).toBe(1);
	});
});